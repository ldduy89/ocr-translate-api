import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { config } from './config.js';
import { getUserById, getBalance, recordPayment } from './db.js';
import { provisionKey } from './provision.js';

// ---------- Bảng quy đổi: số tiền (VNĐ) -> số lượt dịch ----------
export const PACKAGES = new Map([
  [20000, 50],
  [100000, 300],
  [200000, 700],
  [500000, 2000],
]);
export const creditsForAmount = (amount) => PACKAGES.get(amount) ?? 0;

// ---------- Đọc "ho tro <user_id>" trong lời nhắn ----------
// Ngân hàng thường viết HOA, bỏ dấu, có thể chèn thêm chữ (tên người chuyển, mã FT...), nên chỉ tìm cụm
// "ho tro" rồi lấy dãy số ngay sau nó. Chấp nhận "ho tro 120435", "HOTRO120435", "ho tro: 120435".
export function parseUserId(content) {
  const text = String(content ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/gi, 'd')
    .toLowerCase();
  const m = /(?:^|[^a-z0-9])ho\s*tro\s*[:.\-]?\s*(\d{1,12})(?!\d)/.exec(text);
  if (!m) return null;
  const id = Number(m[1]);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

// ---------- Token ngắn hạn cho VietQR (HMAC-SHA256, chỉ dùng node:crypto) ----------
// Khoá ký được tách riêng khỏi phiên đăng nhập của user nên token này không dùng được ở nơi khác.
const b64 = (v) => Buffer.from(v).toString('base64url');
const sig = (data) => createHmac('sha256', `${config.sessionSecret}:vietqr`).update(data).digest();

export function signVietqrToken(seconds = config.vietqrTokenSeconds) {
  const head = b64(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64(JSON.stringify({ aud: 'vietqr', exp: Math.floor(Date.now() / 1000) + seconds }));
  return `${head}.${body}.${sig(`${head}.${body}`).toString('base64url')}`;
}

export function verifyVietqrToken(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return false;
  const expected = sig(`${parts[0]}.${parts[1]}`);
  const given = Buffer.from(parts[2], 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return false;
  try {
    const data = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
    return data.aud === 'vietqr' && data.exp > Math.floor(Date.now() / 1000);
  } catch {
    return false;
  }
}

// So sánh chuỗi an toàn (băm rồi so để không lộ độ dài/nội dung qua thời gian phản hồi)
const safeEqual = (a, b) => {
  const ha = createHash('sha256').update(String(a)).digest();
  const hb = createHash('sha256').update(String(b)).digest();
  return timingSafeEqual(ha, hb);
};

const fail = (reply, code, errorReason, toastMessage) =>
  reply.code(code).send({ error: true, errorReason, toastMessage, object: null });

// ---------- Route: đăng ký trong một plugin riêng ----------
export default async function vietqrRoutes(app) {
  // VietQR có thể gọi token_generate với Content-Type: application/json nhưng không có body;
  // Fastify mặc định từ chối body rỗng, nên trong plugin này chấp nhận body rỗng.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    if (!body) return done(null, {});
    try {
      done(null, JSON.parse(body));
    } catch (err) {
      err.statusCode = 400;
      done(err);
    }
  });

  // 1) VietQR gọi vào đây (Basic Auth) để lấy access_token
  app.post('/vqr/api/token_generate', async (req, reply) => {
    if (!config.vietqrUser || !config.vietqrPass) return reply.code(503).send({ error: 'vietqr_not_configured' });
    const m = /^Basic (.+)$/i.exec(req.headers.authorization || '');
    const decoded = m ? Buffer.from(m[1], 'base64').toString('utf8') : '';
    const i = decoded.indexOf(':');
    const user = i >= 0 ? decoded.slice(0, i) : '';
    const pass = i >= 0 ? decoded.slice(i + 1) : '';
    // Luôn so cả hai để thời gian phản hồi không tiết lộ username đúng/sai
    const ok = safeEqual(user, config.vietqrUser) & safeEqual(pass, config.vietqrPass);
    if (!ok) return reply.code(401).send({ error: 'unauthorized' });
    return { access_token: signVietqrToken(), token_type: 'Bearer', expires_in: config.vietqrTokenSeconds };
  });

  // 2) VietQR báo biến động số dư
  app.post('/vqr/bank/api/transaction-sync', async (req, reply) => {
    const m = /^Bearer (.+)$/i.exec(req.headers.authorization || '');
    if (!m || !verifyVietqrToken(m[1])) return fail(reply, 401, 'INVALID_TOKEN', 'Unauthorized');

    const b = req.body && typeof req.body === 'object' ? req.body : {};
    const transactionId = String(b.transactionid ?? '').trim() || String(b.referencenumber ?? '').trim();
    const amount = Number(b.amount);
    if (!transactionId || !Number.isFinite(amount) || amount <= 0) {
      return fail(reply, 400, 'INVALID_PAYLOAD', 'Thiếu transactionid hoặc amount không hợp lệ');
    }

    const ack = (note) => ({
      error: false,
      errorReason: null,
      toastMessage: note || 'Success',
      object: { reftransactionid: transactionId },
    });

    const base = {
      transactionId,
      amount: Math.round(amount),
      content: String(b.content ?? '').slice(0, 300),
      bankAccount: String(b.bankaccount ?? '').slice(0, 50),
      reference: String(b.referencenumber ?? '').slice(0, 100),
    };

    try {
      // Chỉ xử lý tiền VÀO. Giao dịch ghi nợ (D) hoặc sai tài khoản nhận thì ghi nhận rồi bỏ qua
      // (trả thành công để VietQR không gửi lại một giao dịch mà ta không bao giờ xử lý).
      const wrongAccount = config.vietqrBankAccount && base.bankAccount && base.bankAccount !== config.vietqrBankAccount;
      if ((b.transType && b.transType !== 'C') || wrongAccount) {
        recordPayment({ ...base, status: 'ignored' });
        return ack();
      }

      const userId = parseUserId(base.content);
      const credits = creditsForAmount(base.amount);

      let status = 'credited';
      let user = null;
      if (!userId) status = 'bad_content';
      else if (!(user = getUserById(userId))) status = 'unknown_user';
      else if (!credits) status = 'unmatched_amount';

      const r = recordPayment({ ...base, userId: user?.id, credits: status === 'credited' ? credits : 0, status });
      if (r.duplicate) return ack('Duplicate');

      if (status === 'credited') {
        req.log.info({ transactionId, userId: user.id, amount: base.amount, credits }, 'đã cộng lượt dịch');
        // Giống /admin/credits: user chưa có key Gemini thì tạo ngay (không đợi)
        if (!user.gemini_key && getBalance(user.id) > 0) provisionKey(user.id, req.log);
      } else {
        // Cần xem tay: tiền đã vào nhưng không tự cộng được lượt (xem: npm run admin -- payments <status>)
        req.log.warn({ transactionId, status, amount: base.amount, content: base.content }, 'giao dịch VietQR không khớp');
      }
      return ack();
    } catch (err) {
      // Lỗi hệ thống (DB...): trả lỗi để VietQR retry. Cần thống nhất với VietQR mã lỗi nào được retry.
      req.log.error({ err: err.message, transactionId }, 'xử lý giao dịch VietQR lỗi');
      return fail(reply, 500, 'SERVER_ERROR', 'Internal error');
    }
  });
}
