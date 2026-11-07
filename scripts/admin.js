// Quản trị bằng dòng lệnh. Người dùng phải đăng nhập ít nhất một lần thì mới có tài khoản.
//   npm run admin -- show <email>
//   npm run admin -- set-key <email> <gemini_key>
//   npm run admin -- add-credits <email> <số_lượt> [lý_do]
//   npm run admin -- create-key <email>     (tạo key Gemini mới trong dự án Google Cloud cố định)
//   npm run admin -- delete-key <email>     (xoá key của user, kể cả bên Google nếu key do server tạo)
import { getUserByEmail, getBalance, setGeminiKey, addCredits } from '../src/db.js';
import { createGeminiKey, deleteGeminiKey, keysEnabled } from '../src/gkeys.js';

const [cmd, emailArg, arg, ...rest] = process.argv.slice(2);
const email = String(emailArg || '').toLowerCase();
const user = email ? getUserByEmail(email) : null;

function fail(msg) {
  console.error(msg);
  process.exit(1);
}
const mask = (k) => (k ? `${k.slice(0, 6)}…${k.slice(-4)}` : '(chưa có)');

if (!cmd || !email) fail('Cách dùng: show | set-key | add-credits | create-key | delete-key <email> ...');
if (!user) fail(`Chưa có tài khoản ${email}. Người này cần đăng nhập trong extension một lần trước.`);

if (cmd === 'show') {
  console.log({ email: user.email, name: user.name, credits: getBalance(user.id), gemini_key: mask(user.gemini_key), key_do_server_tao: !!user.gemini_key_name });
} else if (cmd === 'set-key') {
  if (!arg) fail('Thiếu Gemini key');
  if (user.gemini_key_name) fail('User này đang dùng key do server tạo. Chạy delete-key trước để xoá key đó bên Google.');
  setGeminiKey(user.id, arg);
  console.log(`Đã lưu Gemini key cho ${email}: ${mask(arg)}`);
} else if (cmd === 'add-credits') {
  const n = Number(arg);
  if (!Number.isInteger(n) || n === 0) fail('Số lượt phải là số nguyên khác 0');
  addCredits(user.id, n, rest.join(' ') || 'admin');
  console.log(`Số lượt hiện tại của ${email}: ${getBalance(user.id)}`);
} else if (cmd === 'create-key') {
  if (!keysEnabled()) fail('Chưa cấu hình GCP_PROJECT_ID và GCP_SA_JSON (hoặc GCP_SA_FILE).');
  if (user.gemini_key) fail('User này đã có key. Chạy delete-key trước nếu muốn tạo key mới.');
  const { name, keyString } = await createGeminiKey(user.id);
  setGeminiKey(user.id, keyString, name);
  console.log(`Đã tạo key cho ${email}: ${mask(keyString)} (${name})`);
} else if (cmd === 'delete-key') {
  if (!user.gemini_key) fail('User này chưa có key.');
  if (user.gemini_key_name) {
    if (!keysEnabled()) fail('Chưa cấu hình GCP_PROJECT_ID và GCP_SA_JSON (hoặc GCP_SA_FILE) để xoá key bên Google.');
    await deleteGeminiKey(user.gemini_key_name);
    console.log(`Đã xoá key bên Google: ${user.gemini_key_name}`);
  } else {
    console.log('Key này gán thủ công nên không xoá bên Google, chỉ gỡ khỏi tài khoản.');
  }
  setGeminiKey(user.id, null);
} else {
  fail(`Lệnh không hợp lệ: ${cmd}`);
}
