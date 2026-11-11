// Quản trị bằng dòng lệnh. Người dùng phải đăng nhập ít nhất một lần thì mới có tài khoản.
//   npm run admin -- gcp-list
//   npm run admin -- gcp-add <project_id> <đường_dẫn_file_json>   (thêm project + service account)
//   npm run admin -- gcp-enable <id>  |  gcp-disable <id>        (bật/tắt project khi tạo key)
//   npm run admin -- gcp-remove <id>                              (xoá project, chỉ khi chưa có key)
//   npm run admin -- show <email>
//   npm run admin -- set-key <email> <gemini_key>
//   npm run admin -- add-credits <email> <số_lượt> [free|paid] [lý_do]   (mặc định paid = lượt đã mua)
//   npm run admin -- create-key <email>     (tạo key Gemini mới, chọn project đang có ít key nhất)
//   npm run admin -- delete-key <email>     (xoá key của user, kể cả bên Google nếu key do server tạo)
//   npm run admin -- payments [credited|unmatched_amount|unknown_user|bad_content|ignored]   (giao dịch VietQR gần đây)
import { readFileSync } from 'node:fs';
import {
  getUserByEmail, getBalances, setGeminiKey, addCredits, claimGeminiKey, gcpKeyOfUser, deleteGcpKeyRecord,
  listPayments, listGcpConfigs, getGcpConfigById, addGcpConfig, setGcpEnabled, removeGcpConfig, gcpKeyCount,
} from '../src/db.js';
import { createGeminiKey, deleteGeminiKey, keysEnabled } from '../src/gkeys.js';

const [cmd, emailArg, arg, ...rest] = process.argv.slice(2);

function fail(msg) {
  console.error(msg);
  process.exit(1);
}
const mask = (k) => (k ? `${k.slice(0, 6)}…${k.slice(-4)}` : '(chưa có)');
const GCP_CMDS = ['gcp-list', 'gcp-add', 'gcp-enable', 'gcp-disable', 'gcp-remove'];
const USER_CMDS = ['show', 'set-key', 'add-credits', 'create-key', 'delete-key'];

// Đọc email service account từ JSON (không in khoá bí mật)
function parseSa(raw) {
  try {
    const sa = JSON.parse(raw);
    if (!sa.client_email || !sa.private_key) return null;
    return sa;
  } catch {
    return null;
  }
}

// ---------- Quản lý project Google Cloud (không cần email) ----------
if (GCP_CMDS.includes(cmd)) {
  if (cmd === 'gcp-list') {
    const rows = listGcpConfigs();
    if (!rows.length) console.log('Chưa có project nào. Thêm bằng: gcp-add <project_id> <file.json>');
    for (const r of rows) {
      const sa = parseSa(r.gcpSaJson.trim().startsWith('{') ? r.gcpSaJson.trim() : Buffer.from(r.gcpSaJson.trim(), 'base64').toString('utf8'));
      console.log({ id: r.id, project_id: r.gcpProjectId, enabled: r.enabled, keys: r.keys, service_account: sa ? sa.client_email : '(JSON lỗi)' });
    }
  } else if (cmd === 'gcp-add') {
    if (!emailArg || !arg) fail('Cách dùng: gcp-add <project_id> <file.json>');
    let raw;
    try {
      raw = readFileSync(arg, 'utf8').trim();
    } catch (err) {
      fail(`Không đọc được file ${arg}: ${err.message}`);
    }
    const sa = parseSa(raw);
    if (!sa) fail('File không phải JSON service account hợp lệ (thiếu client_email hoặc private_key)');
    try {
      const id = addGcpConfig(emailArg.trim(), raw);
      console.log(`Đã thêm project ${emailArg.trim()} (id ${id}) với service account ${sa.client_email}`);
    } catch (err) {
      fail(err.message.includes('UNIQUE') ? `Project ${emailArg.trim()} đã có trong danh sách.` : err.message);
    }
    if (sa.project_id && sa.project_id !== emailArg.trim()) console.warn(`Cảnh báo: service account thuộc project ${sa.project_id}, khác ${emailArg.trim()}.`);
  } else if (cmd === 'gcp-enable' || cmd === 'gcp-disable') {
    const id = Number(emailArg);
    if (!Number.isInteger(id) || !getGcpConfigById(id)) fail('Thiếu hoặc sai id project (xem gcp-list)');
    setGcpEnabled(id, cmd === 'gcp-enable');
    console.log(`Project id ${id} ${cmd === 'gcp-enable' ? 'đã bật' : 'đã tắt'}.`);
  } else if (cmd === 'gcp-remove') {
    const id = Number(emailArg);
    const cfg = Number.isInteger(id) ? getGcpConfigById(id) : null;
    if (!cfg) fail('Thiếu hoặc sai id project (xem gcp-list)');
    const n = gcpKeyCount(id);
    if (n > 0) fail(`Project ${cfg.gcpProjectId} còn ${n} key đã tạo. Dùng gcp-disable để ngừng tạo key mới, hoặc xoá các key đó trước.`);
    removeGcpConfig(id);
    console.log(`Đã xoá project ${cfg.gcpProjectId}.`);
  }
  process.exit(0);
}

// ---------- Giao dịch VietQR (không cần email) ----------
if (cmd === 'payments') {
  const rows = listPayments(emailArg || null, 50);
  if (!rows.length) console.log('Chưa có giao dịch nào.');
  for (const r of rows) {
    console.log({ ...r, created_at: new Date(r.created_at * 1000).toISOString() });
  }
  process.exit(0);
}

// ---------- Lệnh theo user ----------
const email = String(emailArg || '').toLowerCase();
if (!USER_CMDS.includes(cmd) || !email) {
  fail(`Cách dùng: ${[...GCP_CMDS, ...USER_CMDS].join(' | ')} [email hoặc tham số] ...`);
}
const user = getUserByEmail(email);
if (!user) fail(`Chưa có tài khoản ${email}. Người này cần đăng nhập trong extension một lần trước.`);

if (cmd === 'show') {
  const b = getBalances(user.id);
  const link = gcpKeyOfUser(user.id);
  console.log({
    email: user.email,
    name: user.name,
    credits_free: b.free,
    credits_paid: b.paid,
    credits_total: b.total,
    gemini_key: mask(user.gemini_key),
    key_do_server_tao: !!user.gemini_key_name,
    project_tao_key: link ? link.gcpProjectId : null,
  });
} else if (cmd === 'set-key') {
  if (!arg) fail('Thiếu Gemini key');
  if (user.gemini_key_name) fail('User này đang dùng key do server tạo. Chạy delete-key trước để xoá key đó bên Google.');
  setGeminiKey(user.id, arg);
  console.log(`Đã lưu Gemini key cho ${email}: ${mask(arg)}`);
} else if (cmd === 'add-credits') {
  const n = Number(arg);
  if (!Number.isInteger(n) || n === 0) fail('Số lượt phải là số nguyên khác 0');
  const pool = rest[0] === 'free' || rest[0] === 'paid' ? rest.shift() : 'paid';
  addCredits(user.id, n, rest.join(' ') || 'admin', null, pool);
  const b = getBalances(user.id);
  console.log(`Đã cộng ${n} lượt ${pool === 'free' ? 'miễn phí' : 'đã mua'}. Hiện tại của ${email}: miễn phí ${b.free}, đã mua ${b.paid}, tổng ${b.total}`);
} else if (cmd === 'create-key') {
  if (!keysEnabled()) fail('Chưa có project Google Cloud nào đang bật (gcp-add, gcp-enable).');
  if (user.gemini_key) fail('User này đã có key. Chạy delete-key trước nếu muốn tạo key mới.');
  const { name, keyString, cfg } = await createGeminiKey(user.id);
  if (!claimGeminiKey(user.id, keyString, name, cfg.id)) {
    await deleteGeminiKey(name, cfg).catch(() => {});
    fail('User đã có key từ yêu cầu khác; key vừa tạo đã được xoá.');
  }
  console.log(`Đã tạo key cho ${email}: ${mask(keyString)} (${name}) trong project ${cfg.gcpProjectId}`);
} else if (cmd === 'delete-key') {
  if (!user.gemini_key) fail('User này chưa có key.');
  if (user.gemini_key_name) {
    const link = gcpKeyOfUser(user.id);
    if (!link) fail('Không tìm thấy project đã tạo key này trong danh sách, nên không xoá được bên Google. Xoá tay trên Google Cloud rồi chạy lại.');
    await deleteGeminiKey(user.gemini_key_name, { id: link.gcp_config_id, gcpProjectId: link.gcpProjectId, gcpSaJson: link.gcpSaJson });
    deleteGcpKeyRecord(user.gemini_key_name);
    console.log(`Đã xoá key bên Google: ${user.gemini_key_name} (project ${link.gcpProjectId})`);
  } else {
    console.log('Key này gán thủ công nên không xoá bên Google, chỉ gỡ khỏi tài khoản.');
  }
  setGeminiKey(user.id, null);
}
