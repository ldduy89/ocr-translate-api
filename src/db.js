import Database from 'better-sqlite3';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from './config.js';

mkdirSync(dirname(config.dbPath), { recursive: true });

export const db = new Database(config.dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

// Bản thử trước có bảng gcp_config một dòng (CHECK id = 1): đổi tên để tạo lại bảng nhiều dòng, rồi chép dữ liệu
const oldGcp = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'gcp_config'").get();
if (oldGcp && oldGcp.sql.includes('CHECK (id = 1)')) db.exec('ALTER TABLE gcp_config RENAME TO gcp_config_v1');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id          INTEGER PRIMARY KEY,
  google_sub  TEXT NOT NULL UNIQUE,
  email       TEXT NOT NULL,
  name        TEXT,
  gemini_key  TEXT,
  role        TEXT NOT NULL DEFAULT 'user',   -- 'user' | 'admin'
  created_at  INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Mỗi lần cộng/trừ lượt là một dòng; số dư = tổng cột delta
CREATE TABLE IF NOT EXISTS credit_ledger (
  id          INTEGER PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id),
  delta       INTEGER NOT NULL,
  reason      TEXT NOT NULL,
  ref         TEXT,
  pool        TEXT NOT NULL DEFAULT 'paid',   -- 'free' = lượt miễn phí, 'paid' = lượt đã mua
  created_at  INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_ledger_user ON credit_ledger(user_id);

-- Mỗi dòng là một project Google Cloud kèm service account để tạo key
CREATE TABLE IF NOT EXISTS gcp_config (
  id            INTEGER PRIMARY KEY,
  gcpProjectId  TEXT NOT NULL UNIQUE,
  gcpSaJson     TEXT NOT NULL,
  enabled       INTEGER NOT NULL DEFAULT 1,
  created_at    INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Bản sao của mỗi key Gemini do server tạo, liên kết với project đã tạo ra nó
CREATE TABLE IF NOT EXISTS gcp_keys (
  id             INTEGER PRIMARY KEY,
  gcp_config_id  INTEGER NOT NULL REFERENCES gcp_config(id),
  user_id        INTEGER REFERENCES users(id) ON DELETE SET NULL,
  key_name       TEXT NOT NULL UNIQUE,
  key_string     TEXT NOT NULL,
  created_at     INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_gcp_keys_config ON gcp_keys(gcp_config_id);

-- Mọi giao dịch VietQR gửi về (kể cả giao dịch không khớp) để chống cộng trùng và đối soát thủ công
CREATE TABLE IF NOT EXISTS payments (
  transaction_id  TEXT PRIMARY KEY,
  user_id         INTEGER REFERENCES users(id),
  amount          INTEGER NOT NULL,
  credits         INTEGER NOT NULL DEFAULT 0,
  content         TEXT,
  bank_account    TEXT,
  reference       TEXT,
  status          TEXT NOT NULL,   -- credited | unmatched_amount | unknown_user | bad_content | ignored
  created_at      INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_payments_status ON payments(status);
`);

// Bản cũ chưa tách lượt miễn phí / đã mua: thêm cột pool. Lượt tặng và các lần dùng/hoàn tính vào
// lượt miễn phí, lượt do admin hoặc thanh toán cộng tính vào lượt đã mua.
if (!db.prepare('PRAGMA table_info(credit_ledger)').all().some((c) => c.name === 'pool')) {
  db.exec("ALTER TABLE credit_ledger ADD COLUMN pool TEXT NOT NULL DEFAULT 'paid'");
  db.exec("UPDATE credit_ledger SET pool = 'free' WHERE reason IN ('signup', 'translate', 'refund')");
}
// Cùng một ref chỉ được ghi một lần cho mỗi user và mỗi loại lượt (một lần trừ có thể chia ra hai dòng)
db.exec('DROP INDEX IF EXISTS idx_ledger_ref');
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_ledger_ref_pool ON credit_ledger(user_id, ref, pool) WHERE ref IS NOT NULL');

// Bản cũ chưa có cột lưu tên key bên Google (dùng để xoá key khi cần)
if (!db.prepare('PRAGMA table_info(users)').all().some((c) => c.name === 'gemini_key_name')) {
  db.exec('ALTER TABLE users ADD COLUMN gemini_key_name TEXT');
}

// ---------- Nhiều project Google Cloud ----------
const gcpQ = {
  all: db.prepare('SELECT id, gcpProjectId, gcpSaJson, enabled FROM gcp_config ORDER BY id'),
  byId: db.prepare('SELECT id, gcpProjectId, gcpSaJson, enabled FROM gcp_config WHERE id = ?'),
  add: db.prepare('INSERT INTO gcp_config (gcpProjectId, gcpSaJson) VALUES (?, ?)'),
  setEnabled: db.prepare('UPDATE gcp_config SET enabled = ? WHERE id = ?'),
  remove: db.prepare('DELETE FROM gcp_config WHERE id = ?'),
  // Project đang bật, ít key nhất lên trước (đếm các key server đã tạo trong project đó)
  candidates: db.prepare(`
    SELECT c.id, c.gcpProjectId, c.gcpSaJson, COUNT(k.id) AS keys
    FROM gcp_config c LEFT JOIN gcp_keys k ON k.gcp_config_id = c.id
    WHERE c.enabled = 1
    GROUP BY c.id
    ORDER BY keys ASC, c.id ASC`),
  keyCount: db.prepare('SELECT COUNT(*) AS n FROM gcp_keys WHERE gcp_config_id = ?'),
  insertKey: db.prepare('INSERT INTO gcp_keys (gcp_config_id, user_id, key_name, key_string) VALUES (?, ?, ?, ?)'),
  keyByUser: db.prepare(`
    SELECT k.key_name, k.gcp_config_id, c.gcpProjectId, c.gcpSaJson
    FROM gcp_keys k JOIN gcp_config c ON c.id = k.gcp_config_id
    WHERE k.user_id = ? ORDER BY k.id DESC LIMIT 1`),
  deleteKeyByName: db.prepare('DELETE FROM gcp_keys WHERE key_name = ?'),
};

export const listGcpConfigs = () =>
  gcpQ.all.all().map((c) => ({ ...c, enabled: !!c.enabled, keys: gcpQ.keyCount.get(c.id).n }));
export const getGcpConfigById = (id) => gcpQ.byId.get(id);
// Thêm project mới. Ném lỗi nếu project_id đã có (UNIQUE).
export const addGcpConfig = (projectId, saJson) => gcpQ.add.run(projectId, saJson).lastInsertRowid;
export const setGcpEnabled = (id, enabled) => gcpQ.setEnabled.run(enabled ? 1 : 0, id);
// Xoá project. Nếu còn key liên kết thì khoá ngoại chặn lại (dùng gcpKeyCount để báo trước).
export const removeGcpConfig = (id) => gcpQ.remove.run(id);
export const gcpKeyCount = (id) => gcpQ.keyCount.get(id).n;
// Danh sách project đang bật, ít key nhất trước
export const gcpCandidates = () => gcpQ.candidates.all();
// Key do server tạo của một user (kèm project và service account đã tạo ra nó), nếu có
export const gcpKeyOfUser = (userId) => gcpQ.keyByUser.get(userId) || null;
export const deleteGcpKeyRecord = (keyName) => gcpQ.deleteKeyByName.run(keyName);

// Lần đầu có bảng gcp_config nhiều dòng (user_version = 0): chép dữ liệu bảng cũ (nếu có) và cấu hình từ .env.
// Chạy đúng một lần, sau đó user_version = 1.
if (!db.prepare("SELECT 1 FROM pragma_table_info('users') WHERE name = 'role'").get()) {
  db.exec("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user'");
}
if (db.pragma('user_version', { simple: true }) < 1) {
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'gcp_config_v1'").get()) {
    db.exec('INSERT OR IGNORE INTO gcp_config (gcpProjectId, gcpSaJson) SELECT gcpProjectId, gcpSaJson FROM gcp_config_v1 WHERE gcpProjectId IS NOT NULL AND gcpSaJson IS NOT NULL');
    db.exec('DROP TABLE gcp_config_v1');
  }
  let saJson = config.gcpImportServiceAccountJson;
  if (!saJson && config.gcpImportServiceAccountFile) saJson = readFileSync(config.gcpImportServiceAccountFile, 'utf8');
  if (config.gcpImportProjectId && saJson) {
    db.prepare('INSERT OR IGNORE INTO gcp_config (gcpProjectId, gcpSaJson) VALUES (?, ?)').run(config.gcpImportProjectId, saJson.trim());
  }
  db.pragma('user_version = 1');
}

const q = {
  userBySub: db.prepare('SELECT * FROM users WHERE google_sub = ?'),
  userById: db.prepare('SELECT * FROM users WHERE id = ?'),
  userByEmail: db.prepare('SELECT * FROM users WHERE email = ?'),
  insertUser: db.prepare('INSERT INTO users (id, google_sub, email, name) VALUES (?, ?, ?, ?)'),
  maxUserId: db.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM users'),
  updateUser: db.prepare('UPDATE users SET email = ?, name = ? WHERE id = ?'),
  setKey: db.prepare('UPDATE users SET gemini_key = ?, gemini_key_name = ? WHERE id = ?'),
  claimKey: db.prepare('UPDATE users SET gemini_key = ?, gemini_key_name = ? WHERE id = ? AND gemini_key IS NULL'),
  balances: db.prepare('SELECT pool, COALESCE(SUM(delta), 0) AS n FROM credit_ledger WHERE user_id = ? GROUP BY pool'),
  insertLedger: db.prepare('INSERT INTO credit_ledger (user_id, delta, reason, ref, pool) VALUES (?, ?, ?, ?, ?)'),
  ledgerByRef: db.prepare('SELECT id FROM credit_ledger WHERE user_id = ? AND ref = ?'),
  chargeRows: db.prepare("SELECT pool, delta FROM credit_ledger WHERE user_id = ? AND ref = ? AND reason = 'translate'"),
};

export const getUserById = (id) => q.userById.get(id);
export const getUserByEmail = (email) => q.userByEmail.get(email);

// Số dư theo từng loại: { free, paid, total }
export function getBalances(userId) {
  const b = { free: 0, paid: 0 };
  for (const r of q.balances.all(userId)) if (r.pool in b) b[r.pool] = r.n;
  return { ...b, total: b.free + b.paid };
}
export const getBalance = (userId) => getBalances(userId).total;
const pack = (b) => ({ credits: b.total, credits_free: b.free, credits_paid: b.paid });
// name: tên key trên Google Cloud (chỉ có khi key do server tạo); gán tay thì để null
export const setGeminiKey = (userId, key, name = null) => q.setKey.run(key || null, key ? name : null, userId);
// Chỉ ghi nếu user chưa có key (tránh hai yêu cầu cùng lúc tạo hai key). Trả về true nếu ghi được.
// Gắn key cho user (chỉ khi user chưa có key) và lưu bản sao trong gcp_keys, cùng một giao dịch.
// Trả về true nếu gắn được.
const claimTx = db.transaction((userId, key, name, gcpConfigId) => {
  const changed = q.claimKey.run(key, name, userId).changes > 0;
  if (changed) gcpQ.insertKey.run(gcpConfigId, userId, name, key);
  return changed;
});
export const claimGeminiKey = (userId, key, name, gcpConfigId) => claimTx(userId, key, name, gcpConfigId);

// Đăng nhập: tạo user mới (tặng lượt miễn phí) hoặc cập nhật tên/email
const USER_ID_START = 120435;
const upsertTx = db.transaction(({ sub, email, name }) => {
  const existing = q.userBySub.get(sub);
  if (existing) {
    q.updateUser.run(email, name ?? existing.name, existing.id);
    return q.userById.get(existing.id);
  }
  // ID user bắt đầu từ USER_ID_START (120435); user cũ giữ nguyên ID, user mới lấy số lớn hơn ID lớn nhất hiện có
  const id = Math.max(q.maxUserId.get().m + 1, USER_ID_START);
  q.insertUser.run(id, sub, email, name ?? null);
  if (config.freeCredits > 0) q.insertLedger.run(id, config.freeCredits, 'signup', null, 'free');
  return q.userById.get(id);
});
export const upsertUser = (info) => upsertTx(info);

// Trừ lượt: kiểm tra số dư và ghi dòng trừ trong CÙNG một giao dịch (khoá ghi ngay từ đầu)
// nên hai yêu cầu cùng lúc không thể trừ vượt số dư. Dùng lượt miễn phí trước, thiếu mới trừ sang lượt
// đã mua. Có ref thì gọi lại cùng ref không bị trừ lần nữa.
const consumeTx = db.transaction((userId, count, ref) => {
  if (ref && q.ledgerByRef.get(userId, ref)) {
    return { ok: true, duplicate: true, ...pack(getBalances(userId)) };
  }
  const b = getBalances(userId);
  if (b.total < count) return { ok: false, ...pack(b) };
  const fromFree = Math.min(Math.max(b.free, 0), count);
  const fromPaid = count - fromFree;
  if (fromFree) q.insertLedger.run(userId, -fromFree, 'translate', ref ?? null, 'free');
  if (fromPaid) q.insertLedger.run(userId, -fromPaid, 'translate', ref ?? null, 'paid');
  return { ok: true, duplicate: false, ...pack(getBalances(userId)) };
});
export const consumeCredits = (userId, count, ref) => consumeTx.immediate(userId, count, ref);

// Hoàn lượt cho một lần trừ trước đó (ảnh dịch lỗi hoặc không có chữ). Mỗi ref chỉ hoàn một lần và không
// hoàn quá số đã trừ. Hoàn ngược thứ tự trừ: lượt đã mua trước, rồi tới lượt miễn phí.
const refundTx = db.transaction((userId, ref, count) => {
  const charges = q.chargeRows.all(userId, ref);
  if (!charges.length) return { ok: false, error: 'not_found', ...pack(getBalances(userId)) };
  if (q.ledgerByRef.get(userId, `refund:${ref}`)) {
    return { ok: true, duplicate: true, ...pack(getBalances(userId)) };
  }
  let left = count;
  for (const pool of ['paid', 'free']) {
    const c = charges.find((r) => r.pool === pool);
    if (!c || left <= 0) continue;
    const n = Math.min(left, -c.delta);
    q.insertLedger.run(userId, n, 'refund', `refund:${ref}`, pool);
    left -= n;
  }
  return { ok: true, duplicate: false, ...pack(getBalances(userId)) };
});
export const refundCredits = (userId, ref, count) => refundTx.immediate(userId, ref, count);

// Cộng lượt vào loại 'paid' (đã mua, mặc định) hoặc 'free' (miễn phí). Dùng cho admin và thanh toán.
// Trả về false nếu ref đã được ghi trước đó.
const addTx = db.transaction((userId, n, reason, ref, pool) => {
  if (ref && q.ledgerByRef.get(userId, ref)) return false;
  q.insertLedger.run(userId, n, reason, ref ?? null, pool);
  return true;
});
export function addCredits(userId, n, reason = 'admin', ref = null, pool = 'paid') {
  if (pool !== 'free' && pool !== 'paid') throw new Error("pool phải là 'free' hoặc 'paid'");
  return addTx.immediate(userId, n, reason, ref, pool);
}

// Cộng lượt, nhưng nếu ref đã được cộng trước đó thì bỏ qua (gọi lại an toàn)
export function addCreditsOnce(userId, n, reason = 'admin', ref = null, pool = 'paid') {
  if (ref && q.ledgerByRef.get(userId, ref)) return { duplicate: true };
  addCredits(userId, n, reason, ref, pool);
  return { duplicate: false };
}

// Ghi một giao dịch VietQR. Cùng transaction_id chỉ xử lý một lần (gọi lại/retry trả duplicate: true).
// Nếu có credits > 0 thì cộng lượt đã mua trong CÙNG giao dịch SQL, nên không thể cộng mà không ghi nhận hoặc ngược lại.
const paymentTx = db.transaction((p) => {
  if (db.prepare('SELECT 1 FROM payments WHERE transaction_id = ?').get(p.transactionId)) return { duplicate: true };
  db.prepare(
    'INSERT INTO payments (transaction_id, user_id, amount, credits, content, bank_account, reference, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(p.transactionId, p.userId ?? null, p.amount, p.credits || 0, p.content ?? null, p.bankAccount ?? null, p.reference ?? null, p.status);
  if (p.status === 'credited' && p.userId && p.credits > 0) {
    q.insertLedger.run(p.userId, p.credits, 'topup', `vqr:${p.transactionId}`, 'paid');
  }
  return { duplicate: false };
});
export const recordPayment = (p) => paymentTx.immediate(p);
export const listPayments = (status, limit = 50) =>
  status
    ? db.prepare('SELECT * FROM payments WHERE status = ? ORDER BY created_at DESC LIMIT ?').all(status, limit)
    : db.prepare('SELECT * FROM payments ORDER BY created_at DESC LIMIT ?').all(limit);

export const setUserRole = (userId, role) => {
  if (role !== 'user' && role !== 'admin') throw new Error("role phải là 'user' hoặc 'admin'");
  return db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, userId);
};

export function publicUser(u) {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    role: u.role || 'user',
    ...pack(getBalances(u.id)),
    gemini_key: u.gemini_key || null,
  };
}
