# Сервер Тайника: Node.js без внешних зависимостей + встроенный SQLite.

# Распознавание речи для расшифровки голосовых на устройствах (~90 МБ: движок и модель Whisper).
# Скачивается при сборке, файлы сверяются по sha256. Слой кешируется — повторно не качается,
# пока не изменится scripts/fetch-stt.mjs. Без сети — образ соберётся, расшифровка будет недоступна.
# Отключить: docker compose build --build-arg STT=0
FROM node:22-alpine AS stt
ARG STT=1
WORKDIR /w
COPY scripts/fetch-stt.mjs ./
RUN mkdir -p /stt && if [ "$STT" = "1" ]; then node fetch-stt.mjs /stt || echo "[!] Распознавание речи не скачалось — расшифровка голосовых будет недоступна"; fi

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
COPY CHANGELOG.md ./
COPY --from=stt /stt ./stt

RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/healthz >/dev/null || exit 1

CMD ["node", "--disable-warning=ExperimentalWarning", "server/server.js"]
