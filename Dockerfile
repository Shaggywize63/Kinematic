# Kinematic API — production container image.
# Multi-stage build: compile TypeScript with full deps, then ship a slim
# runtime with production dependencies only. Mirrors the current Railway
# build (tsc -> dist, then `node dist/server.js`).

# ---- builder ----
# Node 22 (not 20): supabase-js constructs an internal RealtimeClient that throws
# "Node.js 20 detected without native WebSocket support" on Node < 22. The app uses
# only REST/Auth/Storage (no realtime subscriptions), so native WebSocket in Node 22
# is a full fix — no self-hosted Realtime service required.
FROM node:22-slim AS builder
WORKDIR /app
COPY package.json ./
RUN npm install
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---- runtime ----
FROM node:22-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN chown node:node /app
USER node
# Production dependencies only. sharp / @ffmpeg-installer fetch their
# Linux binaries into node_modules during this install. No package-lock.json
# is committed (it's gitignored), so use npm install to match the Railway build.
COPY --chown=node:node package.json ./
RUN npm install --omit=dev && npm cache clean --force
# Compiled application
COPY --chown=node:node --from=builder /app/dist ./dist
# PORT is provided by the ECS task definition (defaults to 3000).
# Health check lives at GET /health.
EXPOSE 3000
CMD ["node", "dist/server.js"]
