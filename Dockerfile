# ---- builder: install full deps and compile TypeScript ----
FROM node:22-slim AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# ---- runner: production dependencies only, non-root ----
# node:22-slim (Debian): no extra OS packages needed.
# The server never spawns child processes, so node running as PID 1 receives
# SIGTERM directly and its graceful-shutdown handler (kernel state save) runs;
# add `docker run --init` (or init: true in compose) only if that changes.
FROM node:22-slim AS runner
ENV NODE_ENV=production \
    ZEUS_HOST=0.0.0.0 \
    ZEUS_PORT=8787 \
    ZEUS_STATE_FILE=/data/kernel-state.json
RUN mkdir /data && chown node:node /data
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=builder --chown=node:node /app/dist ./dist
COPY --chown=node:node scripts/gen-rsk-key.mjs ./scripts/gen-rsk-key.mjs
RUN chmod 644 scripts/gen-rsk-key.mjs
USER node
VOLUME ["/data"]
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.ZEUS_PORT||8787)+'/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "dist/http/serve.js"]
