import { createHmac, timingSafeEqual } from 'node:crypto';

// ---------- Phiên đăng nhập: JWT HS256 tối giản, chỉ dùng node:crypto ----------
const b64 = (v) => Buffer.from(v).toString('base64url');
const hmac = (data, secret) => createHmac('sha256', secret).update(data).digest();

export function signSession(userId, secret, days) {
  const head = b64(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64(JSON.stringify({ sub: userId, exp: Math.floor(Date.now() / 1000) + days * 86400 }));
  return `${head}.${body}.${hmac(`${head}.${body}`, secret).toString('base64url')}`;
}

export function verifySession(token, secret) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  const [head, body, sig] = parts;
  const expected = hmac(`${head}.${body}`, secret);
  const given = Buffer.from(sig, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const data = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (!data.exp || data.exp < Math.floor(Date.now() / 1000)) return null;
    return data;
  } catch {
    return null;
  }
}

// ---------- Google: kiểm tra access token do chrome.identity.getAuthToken cấp ----------
// Trả về { sub, email, name } nếu token hợp lệ và được cấp cho đúng client ID của bạn.
export async function verifyGoogleAccessToken(accessToken, clientId) {
  try {
    const r = await fetch(
      'https://oauth2.googleapis.com/tokeninfo?access_token=' + encodeURIComponent(accessToken),
      { signal: AbortSignal.timeout(8000) },
    );
    if (!r.ok) return null;
    const info = await r.json();
    const audience = info.aud || info.azp;
    if (audience !== clientId && info.azp !== clientId) return null;
    if (!info.sub || !info.email || String(info.email_verified) !== 'true') return null;

    // Tên hiển thị (không bắt buộc, lỗi thì bỏ qua)
    let name = null;
    try {
      const u = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
        headers: { Authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(8000),
      });
      if (u.ok) name = (await u.json()).name || null;
    } catch { /* bỏ qua */ }

    return { sub: String(info.sub), email: String(info.email).toLowerCase(), name };
  } catch {
    return null;
  }
}
