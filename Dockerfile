# 任意支持 Docker 的平台通用（Fly.io / Koyeb / Zeabur / Railway / 云主机）
FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY index.html netlify.toml ./
COPY css ./css
COPY js ./js
COPY server ./server
COPY assets ./assets

EXPOSE 3000
CMD ["node", "server/index.js"]
