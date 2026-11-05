# Slopovyna: one Node process, SQLite in /data, no npm dependencies.
FROM node:24-alpine
ENV NODE_ENV=production NODE_NO_WARNINGS=1 DATA_DIR=/data PORT=3000
WORKDIR /app
COPY package.json ./
COPY src ./src
COPY public ./public
COPY cli ./cli
RUN addgroup -g 10001 -S slop && adduser -u 10001 -S slop -G slop && mkdir -p /data && chown slop:slop /data
USER slop
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s CMD wget -qO- http://127.0.0.1:3000/healthz >/dev/null || exit 1
CMD ["node", "src/index.js"]
