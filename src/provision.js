import { createGeminiKey, deleteGeminiKey, keysEnabled } from './gkeys.js';
import { getUserById, getBalance, claimGeminiKey, gcpKeyOfUser, deleteGcpKeyRecord, setGeminiKey } from './db.js';

const inflight = new Map(); // userId -> Promise: không tạo hai lần cùng lúc cho một user
const cooldown = new Map(); // userId -> thời điểm được thử lại sau khi lỗi

// Tạo key cho user nếu chưa có. Trả về Promise khi đang/vừa bắt đầu tạo, hoặc null nếu không cần/không thể.
// Không bao giờ ném lỗi: lỗi chỉ được ghi log và thử lại ở lần gọi sau (cách nhau 60 giây).
export function provisionKey(userId, log) {
  if (!keysEnabled()) return null;
  const user = getUserById(userId);
  if (!user || user.gemini_key) return null;
  if (getBalance(userId) <= 0) return null; // hết lượt thì không tạo key (key đã bị xoá lúc hết lượt)
  if (inflight.has(userId)) return inflight.get(userId);
  if ((cooldown.get(userId) || 0) > Date.now()) return null;

  const p = (async () => {
    try {
      const { name, keyString, cfg } = await createGeminiKey(userId);
      if (!claimGeminiKey(userId, keyString, name, cfg.id)) {
        await deleteGeminiKey(name, cfg).catch(() => {}); // user đã có key do yêu cầu khác: bỏ key thừa
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

// Hết lượt: xoá key của user trên Google (nếu do server tạo) rồi xoá trong DB.
// Nếu xoá trên Google lỗi thì giữ nguyên bản ghi để lần sau thử lại, không xoá DB trước.
// Key gán thủ công (không có bản ghi gcp_keys) không xoá được trên Google nên chỉ gỡ khỏi DB.
export async function revokeKey(userId, log) {
  const user = getUserById(userId);
  if (!user || !user.gemini_key) return true;
  const link = gcpKeyOfUser(userId);
  if (user.gemini_key_name && link) {
    try {
      await deleteGeminiKey(user.gemini_key_name, { id: link.gcp_config_id, gcpProjectId: link.gcpProjectId, gcpSaJson: link.gcpSaJson });
    } catch (err) {
      log.error({ err: err.message, userId }, 'xoá key Gemini trên Google thất bại, sẽ thử lại');
      return false;
    }
    deleteGcpKeyRecord(user.gemini_key_name);
  }
  setGeminiKey(userId, null);
  log.info({ userId }, 'đã xoá key Gemini vì hết lượt');
  return true;
}
