# syntax=docker/dockerfile:1
# Bid Manager — one image: the API + jobs (server/dist) serving the built web app (web/dist).
#   docker build -t bid-manager .
# NOTE: written and reviewed, but not built in the environment it was authored in (no Docker daemon there) — see README.md.

# ---- 1. build: all dependencies, compile server and web ------------------------------------------------------
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/package.json
COPY web/package.json web/package.json
RUN npm ci
COPY server server
COPY web web
RUN npm run build

# ---- 2. production dependencies only (server workspace; argon2 ships prebuilt binaries) ------------------------
FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/package.json
COPY web/package.json web/package.json
RUN npm ci --omit=dev --workspace server --include-workspace-root && npm cache clean --force

# ---- 3. runtime: non-root, no build tools, no sources ----------------------------------------------------------
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production \
    PORT=3001 \
    FILE_STORAGE_DIR=/data/storage \
    WEB_DIST_DIR=/app/web/dist \
    BM_NO_DOTENV=1 \
    TZ=UTC
WORKDIR /app
COPY --from=deps /app/node_modules node_modules
COPY --from=deps /app/package.json package.json
COPY --from=build /app/server/package.json server/package.json
COPY --from=build /app/server/dist server/dist
COPY --from=build /app/server/migrations server/migrations
COPY --from=build /app/web/dist web/dist
COPY ops/docker/entrypoint.sh /usr/local/bin/bid-manager-entrypoint
RUN chmod 0755 /usr/local/bin/bid-manager-entrypoint \
 && mkdir -p /data/storage && chown -R node:node /data
USER node
VOLUME ["/data/storage"]
EXPOSE 3001
# The same endpoint a load balancer would use: 200 only when the database answers.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 3001) + '/api/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]
ENTRYPOINT ["bid-manager-entrypoint"]
CMD ["node", "server/dist/index.js"]
