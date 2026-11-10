# Node 22: đáp ứng engines >= 20.6 và có sẵn bản build cho better-sqlite3
FROM node:22-bookworm-slim

WORKDIR /app
ENV NODE_ENV=production

# Cài phụ thuộc trước để tận dụng cache của Docker
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Mã nguồn và script quản trị (không copy .env, secrets/, data/)
COPY src ./src
COPY scripts ./scripts

# Chạy bằng root: volume của Railway được mount với quyền root,
# user "node" không ghi được /data (gây lỗi SQLITE_CANTOPEN)
CMD ["node", "src/server.js"]
