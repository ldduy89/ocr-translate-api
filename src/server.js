import { createHash, timingSafeEqual } from 'node:crypto';
import Fastify from 'fastify';
import { config } from './config.js';
import { signSession, verifySession, verifyGoogleAccessToken } from './auth.js';
import { blockedCountry } from './region.js';
import { provisionKey, revokeKey } from './provision.js';
import { upsertUser, getUserById, getUserByEmail, getBalances, consumeCredits, refundCredits, addCreditsOnce, publicUser } from './db.js';

if (!config.googleClientId) {
  console.error('Thiếu GOOGLE_CLIENT_ID');
  process.exit(1);
}
if (config.sessionSecret.length < 32) {
  console.error('SESSION_SECRET phải có ít nhất 32 ký tự');
  process.exit(1);
}

const app = Fastify({ logger: true, bodyLimit: 16 * 1024 });

// Chặn các khu vực chưa phục vụ (xem BLOCKED_COUNTRIES). /health luôn mở để theo dõi server.
app.addHook('onRequest', async (req, reply) => {
  if (req.url === '/health') return;
  const country = blockedCountry(req.headers, config);
  if (country) return reply.code(403).send({ error: 'region_blocked', country });
});

// Chặn truy cập nếu thiếu hoặc sai phiên đăng nhập
async function requireUser(req, reply) {
  const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
  const data = m && verifySession(m[1], config.sessionSecret);
  const user = data && getUserById(data.sub);
  if (!user) return reply.code(401).send({ error: 'unauthorized' });
  req.user = user;
}

app.get('/health', async () => ({ ok: true }));

// Extension gửi access token Google, nhận phiên đăng nhập của server
app.post(
  '/auth/google',
  {
    schema: {
      body: {
        type: 'object',
        required: ['access_token'],
        properties: { access_token: { type: 'string', minLength: 10, maxLength: 4096 } },
      },
    },
  },
  async (req, reply) => {
    const info = await verifyGoogleAccessToken(req.body.access_token, config.googleClientId);
    if (!info) return reply.code(401).send({ error: 'invalid_google_token' });
    let user = upsertUser(info);
    // User chưa có key: tạo ngay (đợi tối đa 8 giây để lần đăng nhập đầu thường đã có key)
    const creating = provisionKey(user.id, app.log);
    if (creating) {
      await Promise.race([creating, new Promise((r) => setTimeout(r, 8000))]);
      user = getUserById(user.id);
    }
    return {
      token: signSession(user.id, config.sessionSecret, config.sessionDays),
      user: publicUser(user),
    };
  },
);

// Thông tin tài khoản: số lượt còn lại và Gemini key của user
app.get('/me', { preHandler: requireUser }, async (req) => {
  provisionKey(req.user.id, app.log); // chưa có key (lần tạo trước lỗi hoặc còn đang chạy) thì thử tạo, không đợi
  return publicUser(req.user);
});

// So sánh token quản trị an toàn (băm rồi so để không lộ thông tin qua thời gian phản hồi)
function adminTokenOk(token) {
  if (!config.adminToken || typeof token !== 'string') return false;
  const a = createHash('sha256').update(token).digest();
  const b = createHash('sha256').update(config.adminToken).digest();
  return timingSafeEqual(a, b);
}

// Quyền quản trị:
// - Có header Authorization (Bearer): phải là phiên của user có role 'admin'.
// - Không có Authorization: dùng header x-admin-token so với ADMIN_TOKEN.
async function requireAdmin(req, reply) {
  if (req.headers.authorization) {
    await requireUser(req, reply);
    if (reply.sent) return;
    if (req.user.role !== 'admin') return reply.code(403).send({ error: 'forbidden' });
    return;
  }
  if (!adminTokenOk(req.headers['x-admin-token'])) return reply.code(401).send({ error: 'unauthorized' });
}

// Thêm lượt dịch cho user (dùng khi khách đã thanh toán). Nếu user chưa có key Gemini thì tạo key ngay.
// Gọi lại với cùng ref sẽ không cộng thêm lượt.
app.post(
  '/admin/credits',
  {
    preHandler: requireAdmin,
    schema: {
      body: {
        type: 'object',
        required: ['count'],
        oneOf: [{ required: ['email'] }, { required: ['user_id'] }],
        properties: {
          email: { type: 'string', minLength: 3, maxLength: 320 },
          user_id: { type: 'integer', minimum: 1 },
          count: { type: 'integer', minimum: 1, maximum: 100000 },
          pool: { type: 'string', enum: ['paid', 'free'] },
          reason: { type: 'string', maxLength: 200 },
          ref: { type: 'string', minLength: 1, maxLength: 100 },
        },
      },
    },
  },
  async (req, reply) => {
    const { email, user_id, count, pool = 'paid', reason = 'admin', ref } = req.body;
    const user = user_id ? getUserById(user_id) : getUserByEmail(String(email).toLowerCase());
    if (!user) return reply.code(404).send({ error: 'user_not_found' });

    const { duplicate } = addCreditsOnce(user.id, count, reason, ref ?? null, pool);
    const b = getBalances(user.id);
    const balance = { credits: b.total, credits_free: b.free, credits_paid: b.paid };
    if (duplicate) return { duplicate: true, ...balance, key: 'unchanged' };

    // Chưa có key thì tạo ngay, không đợi; kết quả trả về trạng thái để theo dõi
    let key = 'exists';
    if (!getUserById(user.id).gemini_key) key = provisionKey(user.id, req.log) ? 'creating' : 'skipped';
    return { duplicate: false, ...balance, key };
  },
);

// Trừ lượt dịch trước khi extension gọi Gemini. ref (tuỳ chọn) để gọi lại không bị trừ hai lần.
app.post(
  '/usage',
  {
    preHandler: requireUser,
    schema: {
      body: {
        type: 'object',
        required: ['count'],
        properties: {
          count: { type: 'integer', minimum: 1, maximum: 50 },
          ref: { type: 'string', minLength: 1, maxLength: 100 },
        },
      },
    },
  },
  async (req, reply) => {
    const r = consumeCredits(req.user.id, req.body.count, req.body.ref);
    const { ok, duplicate, ...balance } = r; // balance: credits, credits_free, credits_paid
    // Không đủ lượt: trả 402. Nếu đã hết hẳn thì xoá key Gemini (DB và Google).
    // Không xoá khi vừa trừ xong lượt cuối: lô đó vẫn cần key để dịch.
    if (!ok) {
      if (balance.credits === 0) revokeKey(req.user.id, req.log).catch(() => {});
      return reply.code(402).send({ error: 'insufficient_credits', ...balance });
    }
    return { ...balance, duplicate };
  },
);

// Hoàn lượt cho một lần trừ trước đó (dịch lỗi hoặc ảnh không có chữ). Mỗi ref chỉ hoàn một lần.
app.post(
  '/usage/refund',
  {
    preHandler: requireUser,
    schema: {
      body: {
        type: 'object',
        required: ['ref', 'count'],
        properties: {
          ref: { type: 'string', minLength: 1, maxLength: 100 },
          count: { type: 'integer', minimum: 1, maximum: 50 },
        },
      },
    },
  },
  async (req, reply) => {
    const r = refundCredits(req.user.id, req.body.ref, req.body.count);
    const { ok, error, duplicate, ...balance } = r;
    if (!ok) return reply.code(404).send({ error, ...balance });
    return { ...balance, duplicate };
  },
);

app.listen({ port: config.port, host: '0.0.0.0' }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
