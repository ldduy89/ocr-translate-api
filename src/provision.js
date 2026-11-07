import { createGeminiKey, deleteGeminiKey, keysEnabled } from './gkeys.js';
import { getUserById, claimGeminiKey } from './db.js';

const inflight = new Map(); // userId -> Promise: không tạo hai lần cùng lúc cho một user
const cooldown = new Map(); // userId -> thời điểm được thử lại sau khi lỗi

// Tạo key cho user nếu chưa có. Trả về Promise khi đang/vừa bắt đầu tạo, hoặc null nếu không cần/không thể.
// Không bao giờ ném lỗi: lỗi chỉ được ghi log và thử lại ở lần gọi sau (cách nhau 60 giây).
export function provisionKey(userId, log) {
  if (!keysEnabled()) return null;
  const user = getUserById(userId);
  if (!user || user.gemini_key) return null;
  if (inflight.has(userId)) return inflight.get(userId);
  if ((cooldown.get(userId) || 0) > Date.now()) return null;

  const p = (async () => {
    try {
      const { name, keyString } = await createGeminiKey(userId);
      if (!claimGeminiKey(userId, keyString, name)) {
        await deleteGeminiKey(name).catch(() => {}); // user đã có key do yêu cầu khác: bỏ key thừa
      }
    } catch (err) {
      cooldown.set(userId, Date.now() + 60_000);
      log.error({ err: err.message, userId }, 'tạo key Gemini thất bại');
    } finally {
      inflight.delete(userId);
    }
  })();
  inflight.set(userId, p);
  return p;
}
