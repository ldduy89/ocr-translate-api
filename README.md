# AI Image Translate – server (bước 1)

Node.js + Fastify + SQLite (better-sqlite3). Chỉ 2 thư viện. Không có endpoint dịch:
extension tự gọi Gemini bằng key lấy từ `/me`.

## Chạy thử

```bash
npm install
cp .env.example .env        # rồi điền GOOGLE_CLIENT_ID và SESSION_SECRET
npm run dev
curl http://localhost:3000/health
```

Cần Node.js 20.6 trở lên.

## Endpoint

| Method | Đường dẫn | Mô tả |
|---|---|---|
| GET | `/health` | Kiểm tra server sống |
| POST | `/auth/google` | Body `{ "access_token": "..." }` (token từ `chrome.identity.getAuthToken`). Trả `{ token, user }` |
| GET | `/me` | Header `Authorization: Bearer <token>`. Trả `{ email, name, credits, gemini_key }` |
| POST | `/usage` | Body `{ "count": 1, "ref": "tuỳ chọn" }`. Trừ lượt; hết lượt trả 402. Cùng `ref` gọi lại không bị trừ hai lần |
| POST | `/usage/refund` | Body `{ "ref": "...", "count": 1 }`. Hoàn lượt cho lần trừ có `ref` đó (mỗi `ref` hoàn một lần, không quá số đã trừ) |

## Quản trị (người dùng phải đăng nhập một lần trước)

```bash
npm run admin -- show <email>
npm run admin -- set-key <email> <gemini_key>
npm run admin -- add-credits <email> 100 "tặng thêm"
```

## Tạo Gemini key tự động

Khi user đăng nhập mà chưa có key, server tạo một key trong dự án Google Cloud cố định (`GCP_PROJECT_ID`) bằng
service account, giới hạn chỉ dùng cho Generative Language API, rồi lưu vào tài khoản. Đăng nhập lần đầu đợi tối đa
8 giây; nếu chưa xong hoặc lỗi thì `/me` tự thử lại (cách nhau 60 giây). Nếu không cấu hình `GCP_*` thì tính năng
tắt và bạn gán key thủ công bằng `set-key`.

Chuẩn bị một lần: bật API Keys API và Generative Language API trong dự án; tạo service account, cấp vai trò
"API Keys Admin"; tạo khoá JSON; điền `GCP_PROJECT_ID` và `GCP_SA_JSON` (hoặc `GCP_SA_FILE`) vào `.env`.
Không đưa file khoá lên GitHub.

```bash
npm run admin -- create-key <email>   # tạo thủ công cho một user
npm run admin -- delete-key <email>   # xoá key (bên Google nếu key do server tạo)
```

Lưu ý: mọi key trong cùng dự án dùng chung hạn mức và hoá đơn; một dự án cũng có giới hạn số key.

## Chặn khu vực

EEA, Thụy Sĩ và Anh tạm thời không được phục vụ (ở đó chỉ được dùng Gemini gói trả phí). Server đọc mã quốc gia
từ header `cf-ipcountry` (Cloudflare tự thêm khi domain đi qua Cloudflare) và trả 403 `region_blocked` cho các nước
trong `BLOCKED_COUNTRIES`. Nếu server không đứng sau Cloudflare thì không có header này và việc chặn không có tác dụng.
Cách này dựa trên IP nên người dùng dùng VPN vẫn qua được.

## Lưu ý

- Dữ liệu nằm ở `data/app.db`. Khi triển khai lên dịch vụ như Railway, gắn ổ đĩa bền cho thư mục `data`
  (hoặc đặt `DB_PATH` trỏ vào ổ đó), nếu không dữ liệu mất khi triển khai lại.
- Gemini key lưu dạng chữ thường trong database và trả về cho chính user đó qua `/me`.
- Số lượt do extension báo qua `/usage` nên người dùng kỹ thuật có thể bỏ qua bước này (xem ghi chú ở bước tiếp theo).
