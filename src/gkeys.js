// Tạo / xoá API key Gemini trong một dự án Google Cloud cố định, bằng service account.
// Chỉ dùng node:crypto và fetch có sẵn, không thêm thư viện.
import { createSign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { config } from './config.js';

const SCOPE = 'https://www.googleapis.com/auth/cloud-platform';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API = 'https://apikeys.googleapis.com/v2';

export function keysEnabled() {
  return !!(config.gcpProjectId && (config.gcpServiceAccountJson || config.gcpServiceAccountFile));
}

let sa = null;
function serviceAccount() {
  if (sa) return sa;
  let raw = config.gcpServiceAccountJson || readFileSync(config.gcpServiceAccountFile, 'utf8');
  raw = raw.trim();
  if (!raw.startsWith('{')) raw = Buffer.from(raw, 'base64').toString('utf8'); // cho phép dán dạng base64
  sa = JSON.parse(raw);
  if (!sa.client_email || !sa.private_key) throw new Error('File service account thiếu client_email hoặc private_key');
  return sa;
}

const b64u = (v) => Buffer.from(v).toString('base64url');
let tokenCache = { token: '', exp: 0 };

// Access token của service account (JWT RS256 đổi lấy token OAuth), có cache
async function accessToken() {
  const now = Math.floor(Date.now() / 1000);
  if (tokenCache.token && tokenCache.exp - 60 > now) return tokenCache.token;
  const { client_email, private_key } = serviceAccount();
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
    throw new Error(`Không lấy được token service account (${r.status}) ${data.error_description || data.error || ''}`);
  }
  tokenCache = { token: data.access_token, exp: now + (data.expires_in || 3600) };
  return tokenCache.token;
}

async function call(method, url, body) {
  const headers = { Authorization: `Bearer ${await accessToken()}` };
  if (body) headers['Content-Type'] = 'application/json';
  const r = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15000) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    throw new Error(`API Keys ${method} lỗi ${r.status}: ${(data.error && data.error.message) || JSON.stringify(data).slice(0, 200)}`);
  }
  return data;
}

// Tạo key giới hạn chỉ dùng cho Generative Language API. Trả về { name, keyString }.
export async function createGeminiKey(userId) {
  const keyId = `user-${userId}-${Date.now().toString(36)}`; // chữ thường, số, gạch ngang; không giống UUID
  let op = await call('POST', `${API}/projects/${config.gcpProjectId}/locations/global/keys?keyId=${keyId}`, {
    displayName: `user-${userId}`,
    restrictions: { apiTargets: [{ service: 'generativelanguage.googleapis.com' }] },
  });
  // Tạo key là thao tác chạy nền: đợi tới khi xong
  const started = Date.now();
  while (!op.done) {
    if (Date.now() - started > 30000) throw new Error('Tạo key quá lâu (hơn 30 giây)');
    await new Promise((r) => setTimeout(r, 1000));
    op = await call('GET', `${API}/${op.name}`);
  }
  if (op.error) throw new Error(`Tạo key thất bại: ${op.error.message}`);
  const name = op.response && op.response.name;
  if (!name) throw new Error('Phản hồi tạo key không có tên key');
  const { keyString } = await call('GET', `${API}/${name}/keyString`);
  if (!keyString) throw new Error('Không lấy được chuỗi key');
  return { name, keyString };
}

export async function deleteGeminiKey(name) {
  await call('DELETE', `${API}/${name}`);
}
