import { randomUUID } from 'node:crypto';
import { db } from './db.js';
import { parseBalanceNotification, dedupeKey } from './parse-balance.js';

db.exec(`
CREATE TABLE IF NOT EXISTS notifications (
  id               INTEGER PRIMARY KEY,
  dedupe_key       TEXT NOT NULL UNIQUE,
  transaction_id   TEXT NOT NULL,          -- không dùng để gọi VietQR nữa, app tạo UUID mới mỗi lần gọi
  raw_text         TEXT NOT NULL,
  amount           INTEGER NOT NULL,
  content          TEXT,
  reference        TEXT,
  transaction_time INTEGER NOT NULL,
  claimed          INTEGER NOT NULL DEFAULT 0,   -- 1 = một app đã nhận xử lý (đang gọi hoặc đã gọi)
  claimed_at       INTEGER,
  processed        INTEGER NOT NULL DEFAULT 0,   -- 1 = transaction-sync đã thành công
  attempts         INTEGER NOT NULL DEFAULT 0,
  last_error       TEXT,
  processed_at     INTEGER,
  created_at       INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_notifications_processed ON notifications(processed, id);
`);

// Bản cũ chưa có cột claimed
if (!db.prepare('PRAGMA table_info(notifications)').all().some((c) => c.name === 'claimed')) {
  db.exec('ALTER TABLE notifications ADD COLUMN claimed INTEGER NOT NULL DEFAULT 0');
  db.exec('ALTER TABLE notifications ADD COLUMN claimed_at INTEGER');
}

const q = {
  byKey: db.prepare('SELECT * FROM notifications WHERE dedupe_key = ?'),
  byId: db.prepare('SELECT * FROM notifications WHERE id = ?'),
  insert: db.prepare(
    'INSERT INTO notifications (dedupe_key, transaction_id, raw_text, amount, content, reference, transaction_time) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ),
  // Nhận xử lý: chỉ một app thành công, và chỉ khi chưa xử lý và chưa có ai nhận
  claim: db.prepare(
    'UPDATE notifications SET claimed = 1, claimed_at = unixepoch() WHERE id = ? AND processed = 0 AND claimed = 0',
  ),
  markOk: db.prepare(
    'UPDATE notifications SET processed = 1, claimed = 1, processed_at = unixepoch(), last_error = NULL, attempts = attempts + 1 WHERE id = ?',
  ),
  // Gọi bị từ chối (VietQR trả lỗi, chắc chắn chưa cộng): mở lại để thử sau
  markRejected: db.prepare(
    'UPDATE notifications SET claimed = 0, attempts = attempts + 1, last_error = ? WHERE id = ? AND processed = 0',
  ),
  // Không rõ đã cộng hay chưa (mất mạng sau khi gửi): giữ claimed để không tự gọi lại, cần kiểm tra tay
  markUnknown: db.prepare(
    'UPDATE notifications SET claimed = 1, attempts = attempts + 1, last_error = ? WHERE id = ? AND processed = 0',
  ),
  release: db.prepare('UPDATE notifications SET claimed = 0 WHERE id = ? AND processed = 0'),
  pageFirst: db.prepare('SELECT * FROM notifications ORDER BY id DESC LIMIT ?'),
  pageBefore: db.prepare('SELECT * FROM notifications WHERE id < ? ORDER BY id DESC LIMIT ?'),
  pending: db.prepare('SELECT * FROM notifications WHERE processed = 0 AND claimed = 0 AND attempts < 10 ORDER BY id ASC LIMIT ?'),
};

const view = (r) => ({
  id: r.id,
  amount: r.amount,
  content: r.content,
  reference: r.reference,
  transaction_time: r.transaction_time,
  claimed: !!r.claimed,
  processed: !!r.processed,
  attempts: r.attempts,
  last_error: r.last_error,
  processed_at: r.processed_at,
  created_at: r.created_at,
});

// Lưu một thông báo. Trùng thì trả lại bản cũ.
export function storeNotification(raw) {
  const parsed = parseBalanceNotification(raw);
  if (!parsed) return { stored: false, reason: 'not_balance_notification' };

  const key = dedupeKey(raw);
  let row = q.byKey.get(key);
  let duplicate = true;
  if (!row) {
    duplicate = false;
    try {
      q.insert.run(key, randomUUID(), String(raw).slice(0, 4000), parsed.amount, parsed.content, parsed.reference, parsed.transactionTime);
    } catch (err) {
      if (!String(err.message).includes('UNIQUE')) throw err; // hai yêu cầu cùng lúc: bản kia đã ghi
    }
    row = q.byKey.get(key);
  }
  return { stored: true, duplicate, should_sync: !row.processed, notification: view(row) };
}

// Nhận xử lý trước khi gọi VietQR. claimed = false nghĩa là không được gọi.
export function claimNotification(id) {
  const row = q.byId.get(id);
  if (!row) return null;
  const changed = q.claim.run(id).changes > 0;
  return { claimed: changed, notification: view(q.byId.get(id)) };
}

// Ghi kết quả gọi API:
// ok = đã cộng lượt, đặt processed.
// rejected = VietQR từ chối, mở lại để thử sau.
// unknown = không rõ, giữ claimed để không tự gọi lại.
export function reportResult(id, result, error) {
  const row = q.byId.get(id);
  if (!row) return null;
  const msg = error ? String(error).slice(0, 500) : null;
  if (result === 'ok') q.markOk.run(id);
  else if (result === 'rejected') q.markRejected.run(msg, id);
  else q.markUnknown.run(msg, id);
  return view(q.byId.get(id));
}

// Admin xác nhận đã kiểm tra và muốn thử lại một thông báo bị kẹt (unknown)
export function releaseNotification(id) {
  const row = q.byId.get(id);
  if (!row) return null;
  q.release.run(id);
  return view(q.byId.get(id));
}

// Phân trang theo con trỏ: trang đầu, hoặc các thông báo có id nhỏ hơn before
export function listNotifications(limit = 10, before = null) {
  const rows = before ? q.pageBefore.all(before, limit) : q.pageFirst.all(limit);
  return {
    items: rows.map(view),
    next_cursor: rows.length === limit ? rows[rows.length - 1].id : null,
  };
}

// Các thông báo chưa xử lý và chưa bị kẹt (để app thử lại)
export const pendingNotifications = (limit = 20) => ({ items: q.pending.all(limit).map(view) });

export const getNotification = (id) => {
  const r = q.byId.get(id);
  return r ? view(r) : null;
};
