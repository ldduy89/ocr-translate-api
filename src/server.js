import { createHash, timingSafeEqual } from 'node:crypto';
import Fastify from 'fastify';
import { config } from './config.js';
import { signSession, verifySession, verifyGoogleAccessToken } from './auth.js';
import { blockedCountry } from './region.js';
import { provisionKey, revokeKey } from './provision.js';
import vietqrRoutes from './vietqr.js';
import { storeNotification, markProcessed, listNotifications, pendingNotifications, getNotification } from './notifications.js';
import { upsertUser, getUserById, getUserByEmail, getBalances, consumeCredits, refundCredits, addCreditsOnce, publicUser, listGcpConfigs, getGcpConfigById, addGcpConfig, setGcpEnabled, removeGcpConfig, gcpKeyCount } from './db.js';

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

// VietQR: 2 endpoint (/vqr/api/token_generate và /vqr/bank/api/transaction-sync) để nhận biến động số dư
if (config.vietqrUser && config.vietqrPass) {
  await app.register(vietqrRoutes);
} else {
  app.log.warn('Chưa đặt VIETQR_USER / VIETQR_PASS: endpoint VietQR đang tắt');
}

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
// Hết lượt mà còn key thì xoá key (Google và DB) rồi trả về không có key. Xoá Google lỗi thì DB giữ nguyên
// để lần gọi /me sau thử lại, nhưng phản hồi vẫn không đưa key cho client.
app.get('/me', { preHandler: requireUser }, async (req) => {
  const fresh = getUserById(req.user.id) || req.user;
  if (fresh.gemini_key && getBalances(fresh.id).total <= 0) {
    const revoked = await revokeKey(fresh.id, req.log).catch(() => false);
    const out = publicUser(getUserById(fresh.id) || fresh);
    if (!revoked) out.gemini_key = null;
    return out;
  }
  provisionKey(req.user.id, app.log); // chưa có key (lần tạo trước lỗi hoặc còn đang chạy) thì thử tạo, không đợi
  return publicUser(fresh);
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

// ---------- Quản lý project Google Cloud (service account) ----------
// Chỉ admin. Không bao giờ trả về private_key hay toàn bộ JSON.
function parseSaJson(input) {
  let raw = input;
  if (typeof raw === 'object' && raw !== null) raw = JSON.stringify(raw);
  if (typeof raw !== 'string') return null;
  raw = raw.trim();
  if (!raw.startsWith('{')) raw = Buffer.from(raw, 'base64').toString('utf8'); // cho phép dán base64
  let sa;
  try { sa = JSON.parse(raw); } catch { return null; }
  if (!sa || typeof sa.client_email !== 'string' || typeof sa.private_key !== 'string') return null;
  return { raw: JSON.stringify(sa), client_email: sa.client_email, project_id: sa.project_id || null };
}

function gcpView(c) {
  let client_email = null;
  const parsed = parseSaJson(c.gcpSaJson);
  if (parsed) client_email = parsed.client_email;
  return { id: c.id, project_id: c.gcpProjectId, enabled: c.enabled, keys: gcpKeyCount(c.id), service_account: client_email };
}

// Danh sách project
app.get('/admin/gcp', { preHandler: requireAdmin }, async () => ({
  projects: listGcpConfigs().map(gcpView),
}));

// Thêm project + service account
app.post(
  '/admin/gcp',
  {
    preHandler: requireAdmin,
    schema: {
      body: {
        type: 'object',
        required: ['project_id', 'service_account'],
        properties: {
          project_id: { type: 'string', minLength: 3, maxLength: 100, pattern: '^[a-z][a-z0-9-]{4,}[a-z0-9]$' },
          service_account: {}, // object JSON, chuỗi JSON hoặc base64 (lưu vào cột gcpSaJson)
        },
      },
    },
  },
  async (req, reply) => {
    const { project_id } = req.body;
    const parsed = parseSaJson(req.body.service_account); // lưu vào cột gcpSaJson (dạng chuỗi JSON chuẩn)
    if (!parsed && req.body.service_account === undefined) return reply.code(400).send({ error: 'missing_service_account' });
    if (!parsed) return reply.code(400).send({ error: 'invalid_service_account', message: 'JSON service account thiếu client_email hoặc private_key' });
    if (parsed.project_id && parsed.project_id !== project_id) {
      return reply.code(400).send({ error: 'project_mismatch', message: `service account thuộc project ${parsed.project_id}, không khớp ${project_id}` });
    }
    try {
      const id = addGcpConfig(project_id, parsed.raw);
      return reply.code(201).send(gcpView(getGcpConfigById(Number(id))));
    } catch (err) {
      if (String(err.message).includes('UNIQUE')) return reply.code(409).send({ error: 'project_exists' });
      throw err;
    }
  },
);

// Bật/tắt project (tắt = không tạo key mới ở project này)
app.patch(
  '/admin/gcp/:id',
  {
    preHandler: requireAdmin,
    schema: {
      params: { type: 'object', properties: { id: { type: 'integer', minimum: 1 } }, required: ['id'] },
      body: { type: 'object', required: ['enabled'], properties: { enabled: { type: 'boolean' } } },
    },
  },
  async (req, reply) => {
    const c = getGcpConfigById(req.params.id);
    if (!c) return reply.code(404).send({ error: 'not_found' });
    setGcpEnabled(c.id, req.body.enabled);
    return gcpView(getGcpConfigById(c.id));
  },
);

// Xoá project. Chỉ xoá khi project không còn key nào (tránh mất liên kết với key đang dùng).
app.delete(
  '/admin/gcp/:id',
  {
    preHandler: requireAdmin,
    schema: { params: { type: 'object', properties: { id: { type: 'integer', minimum: 1 } }, required: ['id'] } },
  },
  async (req, reply) => {
    const c = getGcpConfigById(req.params.id);
    if (!c) return reply.code(404).send({ error: 'not_found' });
    const n = gcpKeyCount(c.id);
    if (n > 0) return reply.code(409).send({ error: 'project_has_keys', keys: n, message: 'Tắt project (enabled=false) thay vì xoá' });
    removeGcpConfig(c.id);
    return { deleted: true, id: c.id };
  },
);

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
        // Cần ít nhất một trong: email, user_id, id. Có nhiều thì ưu tiên id (user_id/id), rồi mới đến email.
        anyOf: [{ required: ['email'] }, { required: ['user_id'] }, { required: ['id'] }],
        properties: {
          email: { type: 'string', minLength: 3, maxLength: 320 },
          user_id: { type: 'integer', minimum: 1 },
          id: { type: 'integer', minimum: 1 },
          count: { type: 'integer', minimum: 1, maximum: 100000 },
          pool: { type: 'string', enum: ['paid', 'free'] },
          reason: { type: 'string', maxLength: 200 },
          ref: { type: 'string', minLength: 1, maxLength: 100 },
        },
      },
    },
  },
  async (req, reply) => {
    const { email, user_id, id, count, pool = 'paid', reason = 'admin', ref } = req.body;
    const targetId = user_id ?? id;
    const user = targetId ? getUserById(targetId) : getUserByEmail(String(email).toLowerCase());
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
    // Không đủ lượt: trả 402. Việc xoá key khi hết lượt do /me đảm nhiệm (không xoá ở đây).
    if (!ok) {
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


// ---------- Thông báo biến động số dư (app trên điện thoại gửi lên) ----------
// Quyền: x-admin-token (ADMIN_TOKEN)

// Lưu thông báo. Trùng thì không lưu lại. should_sync = true nghĩa là app cần gọi transaction-sync.
app.post(
  '/admin/notifications',
  {
    preHandler: requireAdmin,
    schema: {
      body: {
        type: 'object',
        required: ['text'],
        properties: {
          title: { type: 'string', maxLength: 500 },
          text: { type: 'string', minLength: 1, maxLength: 4000 },
        },
      },
    },
  },
  async (req) => storeNotification(`${req.body.title ?? ''} ${req.body.text}`),
);

// Danh sách, 10 cái mỗi lần (lazy loading). Lần đầu bỏ qua before; các lần sau truyền next_cursor làm before.
app.get(
  '/admin/notifications',
  {
    preHandler: requireAdmin,
    schema: {
      querystring: {
        type: 'object',
        properties: {
          limit: { type: 'integer', minimum: 1, maximum: 50, default: 10 },
          before: { type: 'integer', minimum: 1 },
        },
      },
    },
  },
  async (req) => listNotifications(req.query.limit ?? 10, req.query.before ?? null),
);

// Các thông báo chưa xử lý (app dùng để thử lại)
app.get('/admin/notifications/pending', { preHandler: requireAdmin }, async () => pendingNotifications(20));

// Báo kết quả gọi API. ok = true sẽ đặt cờ đã xử lý, ok = false ghi lỗi để thử lại sau.
app.post(
  '/admin/notifications/:id/processed',
  {
    preHandler: requireAdmin,
    schema: {
      params: { type: 'object', required: ['id'], properties: { id: { type: 'integer', minimum: 1 } } },
      body: {
        type: 'object',
        required: ['ok'],
        properties: { ok: { type: 'boolean' }, error: { type: 'string', maxLength: 500 } },
      },
    },
  },
  async (req, reply) => {
    if (!getNotification(req.params.id)) return reply.code(404).send({ error: 'not_found' });
    return markProcessed(req.params.id, req.body.ok, req.body.error);
  },
);

app.listen({ port: config.port, host: '0.0.0.0' }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
