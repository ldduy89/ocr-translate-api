const env = process.env;

// Tạm thời không phục vụ EEA (EU, Na Uy, Iceland, Liechtenstein), Thụy Sĩ và Anh:
// ở các nơi này chỉ được dùng Gemini gói trả phí.
const DEFAULT_BLOCKED = [
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE', 'IT', 'LV', 'LT',
  'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE', // EU
  'IS', 'LI', 'NO', // EEA còn lại
  'CH', 'GB', // Thụy Sĩ, Anh
].join(',');

const blocked = env.BLOCKED_COUNTRIES ?? DEFAULT_BLOCKED; // đặt BLOCKED_COUNTRIES= (rỗng) để tắt chặn

export const config = {
  port: Number(env.PORT || 3000),
  dbPath: env.DB_PATH || './data/app.db',
  googleClientId: env.GOOGLE_CLIENT_ID || '',
  sessionSecret: env.SESSION_SECRET || '',
  sessionDays: Number(env.SESSION_DAYS || 30),
  freeCredits: Number(env.FREE_CREDITS ?? 20),
  blockedCountries: new Set(blocked.split(',').map((c) => c.trim().toUpperCase()).filter(Boolean)),
  // Cấu hình Google Cloud (GCP_PROJECT_ID, GCP_SA_JSON) giờ lưu trong database, quản lý bằng lệnh admin gcp-*.
  // Hai biến dưới đây chỉ dùng MỘT LẦN để chuyển cấu hình cũ từ .env vào database (xem db.js).
  gcpImportProjectId: env.GCP_PROJECT_ID || '',
  gcpImportServiceAccountJson: env.GCP_SA_JSON || '',
  gcpImportServiceAccountFile: env.GCP_SA_FILE || '',
  // Header chứa mã quốc gia của người gọi (Cloudflare tự thêm CF-IPCountry khi domain đi qua Cloudflare)
  countryHeader: (env.COUNTRY_HEADER || 'cf-ipcountry').toLowerCase(),
};
