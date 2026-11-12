import { createHash } from 'node:crypto';

// Đọc thông báo "Thông báo biến động số dư" của MB Bank.
// Chỉ nhận tiền VÀO (GD: +). Trả null nếu không phải thông báo tiền vào hợp lệ.
export function parseBalanceNotification(raw) {
  const text = String(raw ?? '').replace(/\s+/g, ' ').trim();

  const gd = /GD:\s*([+-])\s*([\d.,]+)/i.exec(text);
  if (!gd || gd[1] !== '+') return null;
  const amount = Number(gd[2].replace(/[.,]/g, ''));
  if (!Number.isSafeInteger(amount) || amount <= 0) return null;

  const t = /(\d{2})\/(\d{2})\/(\d{2})\s+(\d{2}):(\d{2})/.exec(text);
  if (!t) return null;
  const [dd, mm, yy, hh, mi] = t.slice(1).map(Number);
  const transactionTime = Date.UTC(2000 + yy, mm - 1, dd, hh - 7, mi); // giờ MB Bank = GMT+7

  const tu = /TU:\s*(.*?)\s*\|?\s*ND:/i.exec(text);
  const tuValue = tu ? tu[1].trim() : '';
  const ref = /-\s*(\d+)\s*$/.exec(tuValue);
  const reference = ref ? ref[1] : tuValue;
  if (!reference) return null;

  const nd = /ND:\s*(.*)$/i.exec(text);
  const ndValue = nd ? nd[1].trim() : '';
  const c = /ho tro\s*\d+/i.exec(ndValue);
  const content = c ? c[0] : ndValue;

  return { amount, content, reference, transactionTime };
}

// Khoá chống trùng: băm toàn bộ nội dung đã gom khoảng trắng
export const dedupeKey = (raw) =>
  createHash('sha256').update(String(raw ?? '').replace(/\s+/g, ' ').trim()).digest('hex');
