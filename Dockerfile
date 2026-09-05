# Kinematic API — production container image.
# Multi-stage build: compile TypeScript with full deps, then ship a slim
# runtime with production dependencies only. Mirrors the current Railway
# build (tsc -> dist, then `node dist/server.js`).

# ---- builder ----
FROM node:20-slim AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---- runtime ----
FROM node:20-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN chown node:node /app
USER node
# Production dependencies only. sharp / @ffmpeg-installer fetch their
# Linux binaries into node_modules during this install.
COPY --chown=node:node package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
# Compiled application
COPY --chown=node:node --from=builder /app/dist ./dist
# PORT is provided by the ECS task definition (defaults to 3000).
# Health check lives at GET /health.
EXPOSE 3000
CMD ["node", "dist/server.js"]
