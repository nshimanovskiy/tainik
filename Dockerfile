# Сервер Тайника: Node.js без внешних зависимостей + встроенный SQLite.
FROM node:22-alpine

ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0 \
    DATA_DIR=/data \
    TRUST_PROXY=1

WORKDIR /app
COPY package.json ./
COPY server ./server
COPY shared ./shared
COPY client ./client

RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/healthz >/dev/null || exit 1

CMD ["node", "--disable-warning=ExperimentalWarning", "server/server.js"]
