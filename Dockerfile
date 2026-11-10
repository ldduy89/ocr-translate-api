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

# Thư mục dữ liệu SQLite: Railway sẽ mount volume vào /data
RUN mkdir -p /data && chown -R node:node /data /app

USER node

# Railway cấp PORT qua biến môi trường; server đã đọc từ config.js
CMD ["node", "src/server.js"]
