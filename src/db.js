import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from './config.js';

mkdirSync(dirname(config.dbPath), { recursive: true });

export const db = new Database(config.dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id          INTEGER PRIMARY KEY,
  google_sub  TEXT NOT NULL UNIQUE,
  email       TEXT NOT NULL,
  name        TEXT,
  gemini_key  TEXT,
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

const q = {
  userBySub: db.prepare('SELECT * FROM users WHERE google_sub = ?'),
  userById: db.prepare('SELECT * FROM users WHERE id = ?'),
  userByEmail: db.prepare('SELECT * FROM users WHERE email = ?'),
  insertUser: db.prepare('INSERT INTO users (google_sub, email, name) VALUES (?, ?, ?)'),
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
export const claimGeminiKey = (userId, key, name) => q.claimKey.run(key, name, userId).changes > 0;

// Đăng nhập: tạo user mới (tặng lượt miễn phí) hoặc cập nhật tên/email
const upsertTx = db.transaction(({ sub, email, name }) => {
  const existing = q.userBySub.get(sub);
  if (existing) {
    q.updateUser.run(email, name ?? existing.name, existing.id);
    return q.userById.get(existing.id);
  }
  const { lastInsertRowid } = q.insertUser.run(sub, email, name ?? null);
  if (config.freeCredits > 0) q.insertLedger.run(lastInsertRowid, config.freeCredits, 'signup', null, 'free');
  return q.userById.get(lastInsertRowid);
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

export function publicUser(u) {
  return {
    email: u.email,
    name: u.name,
    ...pack(getBalances(u.id)),
    gemini_key: u.gemini_key || null,
  };
}
