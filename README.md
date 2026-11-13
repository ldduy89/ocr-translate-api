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
| GET | `/me` | Header `Authorization: Bearer <token>`. Trả `{ email, name, credits, credits_free, credits_paid, gemini_key }` (`credits` = tổng hai loại) |
| POST | `/usage` | Body `{ "count": 1, "ref": "tuỳ chọn" }`. Trừ lượt (dùng lượt miễn phí trước, thiếu mới trừ lượt đã mua); hết lượt trả 402. Cùng `ref` gọi lại không bị trừ hai lần. Trả `{ credits, credits_free, credits_paid, duplicate }` |
| POST | `/usage/refund` | Body `{ "ref": "...", "count": 1 }`. Hoàn lượt cho lần trừ có `ref` đó (mỗi `ref` hoàn một lần, không quá số đã trừ; hoàn lượt đã mua trước rồi tới lượt miễn phí) |

## Nạp lượt qua VietQR (Transaction Sync)

Server có 2 endpoint để VietQR gọi vào khi có tiền về (khai báo URL này với VietQR):

| Method | Đường dẫn | Việc |
|---|---|---|
| POST | `/vqr/api/token_generate` | Basic Auth (`VIETQR_USER`:`VIETQR_PASS`), trả `access_token` Bearer sống `VIETQR_TOKEN_SECONDS` giây (mặc định 300) |
| POST | `/vqr/bank/api/transaction-sync` | Bearer token ở trên. Nhận giao dịch, cộng lượt |

Đặt trong `.env` (cả hai bắt buộc, thiếu thì endpoint VietQR tắt):

```
VIETQR_USER=ten-dang-nhap-tu-dat
VIETQR_PASS=mat-khau-dai-ngau-nhien
VIETQR_BANK_ACCOUNT=0123456789   # tuỳ chọn: chỉ nhận tiền vào đúng số tài khoản này
```

Quy tắc: lời nhắn chuyển khoản phải chứa `ho tro <user_id>` (không phân biệt hoa/thường, có dấu hay không), ví dụ
`ho tro 120435`. `user_id` là cột `id` của user (xem `show`/`/me`). Số tiền phải khớp chính xác:

| Số tiền | Lượt cộng (vào lượt đã mua) |
|---|---|
| 20.000đ | 50 |
| 100.000đ | 300 |
| 200.000đ | 700 |
| 500.000đ | 2.000 |

Mọi giao dịch được ghi vào bảng `payments` (khoá `transaction_id`), nên VietQR gửi lại cùng giao dịch cũng không cộng hai lần.
Giao dịch không tự cộng được (sai số tiền, sai lời nhắn, không có user) có trạng thái `unmatched_amount`, `bad_content`,
`unknown_user` và vẫn trả thành công cho VietQR; xem và xử lý tay:

```bash
npm run admin -- payments unmatched_amount
npm run admin -- add-credits <email> <số_lượt> paid "vqr tay"
```

Đổi bảng giá ở `PACKAGES` trong `src/vietqr.js`.

## Hai loại lượt dịch

Số lượt được tách thành **miễn phí** (`free`, tặng khi đăng ký, `FREE_CREDITS` trong `.env`) và **đã mua** (`paid`,
admin cộng hoặc thanh toán). Bảng `credit_ledger` có cột `pool` ghi loại lượt. Khi dịch, server trừ lượt miễn phí
trước, hết mới trừ lượt đã mua; khi hoàn thì trả ngược lại (đã mua trước). Bản database cũ tự thêm cột `pool`:
lượt tặng và các lần dùng/hoàn tính vào miễn phí, lượt admin cộng tính vào đã mua.

## Quản trị (người dùng phải đăng nhập một lần trước)

```bash
npm run admin -- show <email>
npm run admin -- set-key <email> <gemini_key>
npm run admin -- add-credits <email> 100            # cộng vào lượt đã mua (mặc định)
npm run admin -- add-credits <email> 20 free "tặng thêm"   # cộng vào lượt miễn phí
```

## Tạo Gemini key tự động

Khi user đăng nhập mà chưa có key, server tạo một key Gemini bằng service account của một project Google Cloud, giới hạn
chỉ dùng cho Generative Language API, rồi lưu vào tài khoản. Có thể cấu hình nhiều project: mỗi lần tạo key, server chọn
project đang bật có **ít key nhất**; nếu project đó lỗi (hết hạn mức, lỗi quyền...) thì thử project kế tiếp.
Đăng nhập lần đầu đợi tối đa 8 giây; nếu chưa xong hoặc lỗi thì `/me` tự thử lại (cách nhau 60 giây).
Nếu chưa có project nào đang bật thì tính năng tắt và bạn gán key thủ công bằng `set-key`.

Chuẩn bị cho mỗi project: bật API Keys API và Generative Language API; tạo service account, cấp vai trò
"API Keys Admin"; tạo khoá JSON. Thêm vào server:

```bash
npm run admin -- gcp-add <project_id> <file_khoá.json>
npm run admin -- gcp-list                 # xem id, project, trạng thái, số key đã tạo trong từng project
npm run admin -- gcp-disable <id>         # ngừng tạo key mới ở project này (key cũ vẫn dùng được)
npm run admin -- gcp-enable <id>
npm run admin -- gcp-remove <id>          # chỉ khi project không còn key nào
```

Dữ liệu nằm trong database:

- Bảng `gcp_config`: mỗi dòng là một project (`gcpProjectId`, `gcpSaJson`, `enabled`).
- Bảng `gcp_keys`: bản sao của mỗi key do server tạo, liên kết với dòng project đã tạo ra nó (`gcp_config_id`) và với user.
  Số dòng trong `gcp_keys` của một project chính là số key đang dùng để chọn project ít key nhất.

Lần chạy đầu tiên, nếu `.env` còn `GCP_PROJECT_ID` / `GCP_SA_JSON` (hoặc `GCP_SA_FILE`), server thêm project đó vào
`gcp_config` đúng một lần. Sau đó có thể xoá các biến này khỏi `.env`. Xoá file khoá JSON khỏi thư mục dự án sau khi
đã lưu, và không đưa file này lên GitHub.

```bash
npm run admin -- create-key <email>   # tạo thủ công cho một user (chọn project như tự động)
npm run admin -- delete-key <email>   # xoá key bên Google bằng đúng project đã tạo ra nó
```

Lưu ý: mọi key trong cùng một project dùng chung hạn mức và hoá đơn. Service account JSON được lưu dạng chữ thường trong
database (giống Gemini key), nên bảo vệ file `app.db` như bí mật.

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


npm run admin -- set-role admin@gmail.com admin



backup data on railway
node -e "require('better-sqlite3')('/data/app.db').backup('/data/backup.db').then(()=>console.log('backup ok'))"

download data on terminal
railway ssh -- cat /data/backup.db > backup.db

check data
railway ssh -- du -sh /data.

delete backup
railway ssh -- rm /data/backup.dbrailway ssh -- rm /data/backup.db

tạo bk, tải xuống, và xoá
railway ssh -- node -e "require('better-sqlite3')('/data/app.db').backup('/data/backup.db').then(()=>console.log('backup ok'))"
railway ssh -- cat /data/backup.db > backup.db
railway ssh -- rm /data/backup.db