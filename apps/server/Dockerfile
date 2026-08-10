# Multi-stage image for @tm/server (a pnpm workspace package).
#
# Mirrors C:\Repositories\iam\apps\backend\Dockerfile, the sibling this stack's shape
# was taken from, with three differences that matter:
#   - pnpm is pinned to the version in the root package.json's `packageManager` (11.18.0),
#     not iam's 9.15.9;
#   - the workspace deps are built through TURBO rather than named one by one. @tm/server
#     depends on @tm/protocol and @tm/shared, each of which is consumed through its
#     package `exports` (i.e. its built dist/), and turbo.json already declares
#     `build.dependsOn: ["^build"]`. Naming them by hand is how that list silently goes
#     stale when a third package is added;
#   - `pnpm deploy` runs with `--legacy`, because pnpm 10+ otherwise refuses it in a
#     workspace that does not set `inject-workspace-packages`.
#
# BUILD FROM THE REPOSITORY ROOT — the whole workspace has to be present for
# --frozen-lockfile to resolve:
#   docker build -f apps/server/Dockerfile -t taskmanager-server .
#
# Stage 1 installs the server's dependency subtree, builds it, and prunes to a
# self-contained production bundle. Stage 2 is that bundle on a slim runtime.

# ---- Stage 1: builder ----
# node:22-alpine, NOT a pin below 22.13: pnpm 11.18 refuses to run on anything older
# ("This version of pnpm requires at least Node.js v22.13"), and a stale local
# node:22-alpine layer resolving to 22.11 is exactly how that surfaces.
FROM node:22-alpine AS builder

WORKDIR /workspace

RUN npm install -g pnpm@11.18.0

# The whole repo (minus .dockerignore's exclusions), so pnpm-workspace.yaml, the
# lockfile and every package.json are present — pnpm needs all of them to honour
# --frozen-lockfile.
COPY . .

# Install ONLY @tm/server's dependency subtree, dev dependencies included: the trailing
# "..." means "this package and the workspace packages it depends on", and @nestjs/cli
# and tsup are needed to build them.
RUN pnpm install --frozen-lockfile --filter @tm/server...

# Build @tm/protocol and @tm/shared (turbo's ^build) and then @tm/server itself.
RUN pnpm exec turbo run build --filter=@tm/server

# A pruned, production-only bundle at /app: real node_modules with the workspace
# packages injected as files, plus dist/ and package.json. No sources, no dev deps.
RUN pnpm --filter @tm/server deploy --prod --legacy /app

# ---- Stage 2: runtime ----
FROM node:22-alpine

# Non-root, as defence in depth against a container breakout.
RUN addgroup -g 1001 -S appgroup && \
    adduser -S appuser -u 1001 -G appgroup

WORKDIR /app
COPY --from=builder --chown=appuser:appgroup /app ./

USER appuser

# Informational only; the real port comes from PORT (main.ts defaults to 3100).
EXPOSE 3100

# The orchestrator's own probe. /health is unguarded and does no database work, so it
# reports on THIS process rather than on the database — see src/health/health.controller.ts.
#
# `r.resume()` and the explicit process.exit are load-bearing, not tidiness: an http.get
# whose response body is never read leaves the socket open, so node never drains its event
# loop and never exits, and the probe fails on the 5s timeout against a perfectly healthy
# server. That reads identically to a dead app — the container just never leaves "starting".
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD node -e "const p=process.env.PORT||3100;const q=require('http').get({host:'127.0.0.1',port:p,path:'/health'},r=>{r.resume();r.on('end',()=>process.exit(r.statusCode===200?0:1))});q.on('error',()=>process.exit(1));q.setTimeout(4000,()=>process.exit(1))"

# The migrate job overrides this with `node dist/database/migrate.js` — same image,
# different command (see the infrastructure repo's migrate-job.tf).
CMD ["node", "dist/main.js"]
