import { randomUUID } from 'node:crypto';
import { db } from './db.js';
import { parseBalanceNotification, dedupeKey } from './parse-balance.js';

db.exec(`
CREATE TABLE IF NOT EXISTS notifications (
  id               INTEGER PRIMARY KEY,
  dedupe_key       TEXT NOT NULL UNIQUE,
  transaction_id   TEXT NOT NULL UNIQUE,   -- giữ nguyên khi gửi lại, VietQR endpoint cũng chống trùng theo đây
  raw_text         TEXT NOT NULL,
  amount           INTEGER NOT NULL,
  content          TEXT,
  reference        TEXT,
  transaction_time INTEGER NOT NULL,
  processed        INTEGER NOT NULL DEFAULT 0,   -- 1 = đã gọi transaction-sync thành công
  attempts         INTEGER NOT NULL DEFAULT 0,
  last_error       TEXT,
  processed_at     INTEGER,
  created_at       INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_notifications_processed ON notifications(processed, id);
`);

const q = {
  byKey: db.prepare('SELECT * FROM notifications WHERE dedupe_key = ?'),
  byId: db.prepare('SELECT * FROM notifications WHERE id = ?'),
  insert: db.prepare(
    'INSERT INTO notifications (dedupe_key, transaction_id, raw_text, amount, content, reference, transaction_time) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ),
  markOk: db.prepare(
    'UPDATE notifications SET processed = 1, processed_at = unixepoch(), last_error = NULL, attempts = attempts + 1 WHERE id = ?',
  ),
  markFail: db.prepare('UPDATE notifications SET attempts = attempts + 1, last_error = ? WHERE id = ? AND processed = 0'),
  pageFirst: db.prepare('SELECT * FROM notifications ORDER BY id DESC LIMIT ?'),
  pageBefore: db.prepare('SELECT * FROM notifications WHERE id < ? ORDER BY id DESC LIMIT ?'),
  pending: db.prepare('SELECT * FROM notifications WHERE processed = 0 ORDER BY id ASC LIMIT ?'),
};

const view = (r) => ({
  id: r.id,
  transaction_id: r.transaction_id,
  amount: r.amount,
  content: r.content,
  reference: r.reference,
  transaction_time: r.transaction_time,
  processed: !!r.processed,
  attempts: r.attempts,
  last_error: r.last_error,
  processed_at: r.processed_at,
  created_at: r.created_at,
  raw_text: r.raw_text,
});

// Lưu một thông báo. Trùng thì trả lại bản cũ kèm should_sync = còn cần gọi API không.
export function storeNotification(raw) {
  const parsed = parseBalanceNotification(raw);
  if (!parsed) return { stored: false, reason: 'not_balance_notification' };

  const key = dedupeKey(raw);
  const existing = q.byKey.get(key);
  if (existing) {
    return { stored: true, duplicate: true, should_sync: !existing.processed, notification: view(existing) };
  }
  try {
    q.insert.run(key, randomUUID(), String(raw).slice(0, 4000), parsed.amount, parsed.content, parsed.reference, parsed.transactionTime);
  } catch (err) {
    // Hai yêu cầu cùng lúc cho cùng một thông báo: bản kia đã ghi trước
    if (!String(err.message).includes('UNIQUE')) throw err;
  }
  const row = q.byKey.get(key);
  return { stored: true, duplicate: false, should_sync: !row.processed, notification: view(row) };
}

// Ghi kết quả gọi API. ok = true thì đặt cờ đã xử lý.
export function markProcessed(id, ok, error) {
  const row = q.byId.get(id);
  if (!row) return null;
  if (ok) q.markOk.run(id);
  else q.markFail.run(String(error ?? 'unknown').slice(0, 500), id);
  return view(q.byId.get(id));
}

// Phân trang theo con trỏ: trang đầu (before = null) hoặc các thông báo có id nhỏ hơn before
export function listNotifications(limit = 10, before = null) {
  const rows = before ? q.pageBefore.all(before, limit) : q.pageFirst.all(limit);
  return {
    items: rows.map(view),
    next_cursor: rows.length === limit ? rows[rows.length - 1].id : null,
  };
}

// Các thông báo chưa được xử lý (để thử lại)
export const pendingNotifications = (limit = 20) => ({ items: q.pending.all(limit).map(view) });

export const getNotification = (id) => {
  const r = q.byId.get(id);
  return r ? view(r) : null;
};
