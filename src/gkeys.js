// Tạo / xoá API key Gemini trong các project Google Cloud lưu ở bảng gcp_config, bằng service account của từng project.
// Chỉ dùng node:crypto và fetch có sẵn, không thêm thư viện.
import { createSign } from 'node:crypto';
import { gcpCandidates } from './db.js';

const SCOPE = 'https://www.googleapis.com/auth/cloud-platform';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API = 'https://apikeys.googleapis.com/v2';

// Có project nào đang bật không
export function keysEnabled() {
  return gcpCandidates().length > 0;
}

// Đọc service account từ chuỗi JSON (hoặc base64 của JSON) trong gcp_config
function serviceAccount(cfg) {
  let raw = cfg.gcpSaJson.trim();
  if (!raw.startsWith('{')) raw = Buffer.from(raw, 'base64').toString('utf8');
  const sa = JSON.parse(raw);
  if (!sa.client_email || !sa.private_key) throw new Error(`Service account của project ${cfg.gcpProjectId} thiếu client_email hoặc private_key`);
  return sa;
}

const b64u = (v) => Buffer.from(v).toString('base64url');

// Cache access token theo từng project (id của gcp_config). Đổi service account thì token cũ không dùng nữa.
const tokenCache = new Map(); // id -> { source, token, exp }

// Access token của service account (JWT RS256 đổi lấy token OAuth)
async function accessToken(cfg) {
  const now = Math.floor(Date.now() / 1000);
  const cached = tokenCache.get(cfg.id);
  if (cached && cached.source === cfg.gcpSaJson && cached.exp - 60 > now) return cached.token;
  const { client_email, private_key } = serviceAccount(cfg);
  const head = b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64u(JSON.stringify({ iss: client_email, scope: SCOPE, aud: TOKEN_URL, iat: now, exp: now + 3600 }));
  const sig = createSign('RSA-SHA256').update(`${head}.${claim}`).sign(private_key).toString('base64url');
  const r = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${head}.${claim}.${sig}`,
    }),
    signal: AbortSignal.timeout(10000),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || !data.access_token) {
    throw new Error(`Không lấy được token service account của ${cfg.gcpProjectId} (${r.status}) ${data.error_description || data.error || ''}`);
  }
  tokenCache.set(cfg.id, { source: cfg.gcpSaJson, token: data.access_token, exp: now + (data.expires_in || 3600) });
  return data.access_token;
}

async function call(cfg, method, url, body) {
  const headers = { Authorization: `Bearer ${await accessToken(cfg)}` };
  if (body) headers['Content-Type'] = 'application/json';
  const r = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15000) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    throw new Error(`API Keys ${method} lỗi ${r.status} (${cfg.gcpProjectId}): ${(data.error && data.error.message) || JSON.stringify(data).slice(0, 200)}`);
  }
  return data;
}

// Tạo key trong một project cụ thể
async function createKeyIn(cfg, userId) {
  const keyId = `user-${userId}-${Date.now().toString(36)}`; // chữ thường, số, gạch ngang; không giống UUID
  let op = await call(cfg, 'POST', `${API}/projects/${cfg.gcpProjectId}/locations/global/keys?keyId=${keyId}`, {
    displayName: `user-${userId}`,
    restrictions: { apiTargets: [{ service: 'generativelanguage.googleapis.com' }] },
  });
  // Tạo key là thao tác chạy nền: đợi tới khi xong
  const started = Date.now();
  while (!op.done) {
    if (Date.now() - started > 30000) throw new Error('Tạo key quá lâu (hơn 30 giây)');
    await new Promise((r) => setTimeout(r, 1000));
    op = await call(cfg, 'GET', `${API}/${op.name}`);
  }
  if (op.error) throw new Error(`Tạo key thất bại (${cfg.gcpProjectId}): ${op.error.message}`);
  const name = op.response && op.response.name;
  if (!name) throw new Error('Phản hồi tạo key không có tên key');
  const { keyString } = await call(cfg, 'GET', `${API}/${name}/keyString`);
  if (!keyString) throw new Error('Không lấy được chuỗi key');
  return { name, keyString };
}

// Tạo key giới hạn chỉ dùng cho Generative Language API, trong project đang bật có ÍT key nhất.
// Nếu project đó lỗi (hết hạn mức, service account lỗi...) thì thử project kế tiếp.
// Trả về { name, keyString, cfg }; cfg là project đã tạo key (để ghi nhận hoặc xoá sau này).
export async function createGeminiKey(userId) {
  const candidates = gcpCandidates();
  if (!candidates.length) throw new Error('Chưa có project Google Cloud nào đang bật');
  let lastErr = null;
  for (const cfg of candidates) {
    try {
      const { name, keyString } = await createKeyIn(cfg, userId);
      return { name, keyString, cfg };
    } catch (err) {
      lastErr = err;
      console.warn('[gkeys] project lỗi, thử project khác:', err.message);
    }
  }
  throw lastErr;
}

// Xoá key bên Google, bằng đúng project đã tạo ra key đó
export async function deleteGeminiKey(name, cfg) {
  await call(cfg, 'DELETE', `${API}/${name}`);
}
