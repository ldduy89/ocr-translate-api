import { createHash } from 'node:crypto';

// Đọc thông báo "Thông báo biến động số dư" của MB Bank.
// Chỉ nhận tiền VÀO (GD: +). Trả null nếu không phải thông báo tiền vào hợp lệ.
export function parseBalanceNotification(raw) {
  const text = String(raw ?? '').normalize('NFC').replace(/\s+/g, ' ').trim();
  // BIDV SmartBanking có dạng riêng ("Thông báo BIDV ... Số tiền GD: +..."), MB Bank dạng "GD: +...|SD:|TU:|ND:"
  if (/Thông báo BIDV|Số tiền GD:/i.test(text)) return parseBidv(text);
  return parseMb(text);
}

// BIDV SmartBanking (gói com.vnpay.bidv). Ví dụ (đã gom khoảng trắng):
// Thông báo BIDV Thời gian giao dịch: 10:28 13/11/2026 Tài khoản thanh toán: 8900838985 Số tiền GD: +2,000 VND
// Số dư cuối: 2,000 VND Nội dung giao dịch: TKThe :0981902981, tai MSCBVNVX. LE DUC DUY chuyen tien-0200... Mã giao dịch: 8681X94c-8DZtHlu7Z
function parseBidv(text) {
  const gd = /Số tiền GD:\s*([+-])\s*([\d.,]+)/i.exec(text);
  if (!gd || gd[1] !== '+') return null;
  const amount = Number(gd[2].replace(/[.,]/g, ''));
  if (!Number.isSafeInteger(amount) || amount <= 0) return null;

  const t = /Thời gian giao dịch:\s*(\d{2}):(\d{2})\s+(\d{2})\/(\d{2})\/(\d{4})/i.exec(text);
  if (!t) return null;
  const [hh, mi, dd, mm, yyyy] = t.slice(1).map(Number);
  const transactionTime = Date.UTC(yyyy, mm - 1, dd, hh - 7, mi); // giờ BIDV = GMT+7

  const ref = /Mã giao dịch:\s*(\S+)/i.exec(text);
  const reference = ref ? ref[1] : '';
  if (!reference) return null;

  const nd = /Nội dung giao dịch:\s*(.*?)\s*(?:Mã giao dịch:|$)/i.exec(text);
  const ndValue = nd ? nd[1].trim() : '';
  const c = /ho\s*tro\s*[:.\-]?\s*\d+/i.exec(ndValue);
  const content = c ? c[0] : ndValue;

  return { amount, content, reference, transactionTime };
}

function parseMb(text) {

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
