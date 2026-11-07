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
  created_at  INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_ledger_user ON credit_ledger(user_id);
-- Cùng một ref (mã yêu cầu, mã sự kiện thanh toán...) chỉ được ghi một lần cho mỗi user
CREATE UNIQUE INDEX IF NOT EXISTS idx_ledger_ref ON credit_ledger(user_id, ref) WHERE ref IS NOT NULL;
`);

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
  balance: db.prepare('SELECT COALESCE(SUM(delta), 0) AS n FROM credit_ledger WHERE user_id = ?'),
  insertLedger: db.prepare('INSERT INTO credit_ledger (user_id, delta, reason, ref) VALUES (?, ?, ?, ?)'),
  ledgerByRef: db.prepare('SELECT id FROM credit_ledger WHERE user_id = ? AND ref = ?'),
  chargeByRef: db.prepare("SELECT delta FROM credit_ledger WHERE user_id = ? AND ref = ? AND reason = 'translate'"),
};

export const getUserById = (id) => q.userById.get(id);
export const getUserByEmail = (email) => q.userByEmail.get(email);
export const getBalance = (userId) => q.balance.get(userId).n;
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
  if (config.freeCredits > 0) q.insertLedger.run(lastInsertRowid, config.freeCredits, 'signup', null);
  return q.userById.get(lastInsertRowid);
});
export const upsertUser = (info) => upsertTx(info);

// Trừ lượt: kiểm tra số dư và ghi dòng trừ trong CÙNG một giao dịch (khoá ghi ngay từ đầu)
// nên hai yêu cầu cùng lúc không thể trừ vượt số dư. Có ref thì gọi lại cùng ref không bị trừ lần nữa.
const consumeTx = db.transaction((userId, count, ref) => {
  if (ref && q.ledgerByRef.get(userId, ref)) {
    return { ok: true, duplicate: true, credits: getBalance(userId) };
  }
  const bal = getBalance(userId);
  if (bal < count) return { ok: false, credits: bal };
  q.insertLedger.run(userId, -count, 'translate', ref ?? null);
  return { ok: true, duplicate: false, credits: bal - count };
});
export const consumeCredits = (userId, count, ref) => consumeTx.immediate(userId, count, ref);

// Hoàn lượt cho một lần trừ trước đó (ảnh dịch lỗi hoặc không có chữ). Mỗi ref chỉ hoàn một lần,
// và không hoàn quá số lượt đã trừ.
const refundTx = db.transaction((userId, ref, count) => {
  const charge = q.chargeByRef.get(userId, ref);
  if (!charge) return { ok: false, error: 'not_found', credits: getBalance(userId) };
  if (q.ledgerByRef.get(userId, `refund:${ref}`)) {
    return { ok: true, duplicate: true, credits: getBalance(userId) };
  }
  const n = Math.min(count, -charge.delta);
  q.insertLedger.run(userId, n, 'refund', `refund:${ref}`);
  return { ok: true, duplicate: false, credits: getBalance(userId) };
});
export const refundCredits = (userId, ref, count) => refundTx.immediate(userId, ref, count);

// Cộng lượt (dùng cho admin, sau này cho thanh toán). Trả về false nếu ref đã được ghi trước đó.
const addTx = db.transaction((userId, n, reason, ref) => {
  if (ref && q.ledgerByRef.get(userId, ref)) return false;
  q.insertLedger.run(userId, n, reason, ref ?? null);
  return true;
});
export const addCredits = (userId, n, reason = 'admin', ref = null) => addTx.immediate(userId, n, reason, ref);

export function publicUser(u) {
  return {
    email: u.email,
    name: u.name,
    credits: getBalance(u.id),
    gemini_key: u.gemini_key || null,
  };
}
