# ═════════════════════════════════════════════════════════════════════════════
# DEVLUME API — production image
# ═════════════════════════════════════════════════════════════════════════════
# Multi-stage, so the shipped image contains compiled JavaScript and production
# dependencies only: no TypeScript, no toolchain, no tests, no source maps of
# the build tooling. Smaller image, smaller attack surface, faster cold start.

# ── Stage 1: dependencies ───────────────────────────────────────────────────
# Separated from the build so a source-only change reuses the cached npm layer.
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# `npm ci` not `npm install`: it installs exactly the lockfile and fails if
# the two disagree, which is what makes a build reproducible.
RUN npm ci

# ── Stage 2: build ──────────────────────────────────────────────────────────
FROM node:22-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# tsconfig excludes *.test.ts from emit, so dist/ carries no test code.
RUN npm run build

# ── Stage 3: production dependencies only ───────────────────────────────────
FROM node:22-alpine AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ── Stage 4: runtime ────────────────────────────────────────────────────────
FROM node:22-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
# Node sizes its heap from the cgroup limit rather than the host's RAM, which
# is what stops an OOM kill in a memory-capped container.
ENV NODE_OPTIONS="--max-old-space-size=512"

# `dumb-init` reaps zombies and forwards signals, so SIGTERM actually reaches
# Node and the server can close connections instead of being killed.
RUN apk add --no-cache dumb-init

# A dedicated unprivileged user. The node image ships one, but creating it
# explicitly makes the uid stable across base-image updates.
RUN addgroup -g 1001 -S nodejs && adduser -S devlume -u 1001 -G nodejs

COPY --from=prod-deps --chown=devlume:nodejs /app/node_modules ./node_modules
COPY --from=build --chown=devlume:nodejs /app/dist ./dist
COPY --chown=devlume:nodejs package.json ./
# Migrations run from the image at deploy time, so they have to be in it.
COPY --chown=devlume:nodejs drizzle ./drizzle

USER devlume
EXPOSE 5000

# Hits the real health endpoint, which checks the database connection — a
# process that is up but cannot reach Postgres is not healthy.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 5000) + '/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/index.js"]
