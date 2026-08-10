# Deploying the cloud service

The desktop app is released by [`RELEASE.md`](../RELEASE.md) — tagged, packaged and
published by hand. The cloud service is the opposite: nothing about it is manual after the
first stand-up. Push to `development`, and `@tm/server` and `@tm/web` deploy themselves.

This file is the app repo's half. The Azure resources live in the separate
`infrastructure` repo under `taskmanager/`, and its README carries the one-time steps —
seeding Key Vault, creating the database users, registering the vipper.iam clients, and
setting the GitHub secrets. **Read that first; none of what follows works until it is done.**

## What deploys, and when

[`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml) runs on every push to
`development` and works out what changed:

| Changed                                       | What happens                                                    |
| --------------------------------------------- | --------------------------------------------------------------- |
| `apps/server`, `packages/shared`, `packages/protocol`, the lockfile | image → GHCR → **migrations** → Container App repointed |
| `apps/web`, `packages/ui`, and the same shared packages            | Vite build → uploaded to Static Web Apps |
| `apps/client` only                            | **nothing** — the desktop app is never deployed from CI          |

Migrations run *before* the app is repointed, as an Azure Container Apps job executing the
same image with `node dist/database/migrate.js`. A failed migration fails the deploy and
leaves the old app serving the old — matching — schema.

## The pieces, and why each is shaped the way it is

**[`apps/server/Dockerfile`](../apps/server/Dockerfile)** builds from the repository root,
not from `apps/server`: `@tm/server` is one package in a pnpm workspace, and
`--frozen-lockfile` needs `pnpm-workspace.yaml`, the lockfile and every `package.json`
present. It installs only `@tm/server...` (the package and its workspace dependencies),
builds through turbo so `@tm/protocol` and `@tm/shared` are built first, then prunes to a
production bundle with `pnpm deploy --prod --legacy`.

**`dist/database/migrate.js`** exists because the `migration:run` script cannot run in the
cloud at all: it is `tsx` against `src/`, and neither survives into the image.
[`migrate.ts`](../apps/server/src/database/migrate.ts) uses only compiled output.

**`GET /health`** is unguarded and outside `/v1` on purpose. Every other route carries
`@UseGuards(IamAuthGuard)`, so a probe against one gets a 401 — which Container Apps reads
as unhealthy and restarts forever. It also does no database work, so a database blip does
not roll every replica.

**One replica, always.** Presence is an in-memory `Map`, so a second replica answers polls
from a table that never saw the other half of the conversation and the board silently sits
on the idle cadence tier. `max_replicas = 1` is not a cost setting.

## Configuration

Everything the server reads comes from real environment variables. Note that
`ConfigModule.forRoot()` is never called and `main.ts` does not load dotenv, so **the
running server does not read a `.env` file** — only `database/dataSource.ts` (the
migration CLI path) does. `apps/server/.env.example` documents the variables; it does not
feed the process.

| Variable                | Deployed value                                        |
| ----------------------- | ----------------------------------------------------- |
| `NODE_ENV`              | `production` — also what makes `CLOUD_DEV_NO_AUTH` refuse to start |
| `CLOUD_ALLOWED_ORIGINS` | the Static Web App origin, and nothing else           |
| `DB_HOST` / `DB_NAME` / `DB_USER` | the Azure SQL server, database and least-privilege user |
| `AZURE_KEY_VAULT_URI`   | the vault holding `db-password` and `cloud-iam-client-secret` |
| `CLOUD_IAM_*`           | the vipper.iam endpoint and this API's confidential client |

Two settings are derived rather than configured, so that a deployment cannot inherit a
development default by forgetting a variable:

- **`trustServerCertificate`** is `true` only for a local host. Against Azure SQL it is
  `false`, because trusting any presented certificate defeats TLS entirely.
- **CORS** allows any `localhost` origin outside production (Vite's port moves), and
  **nothing** in production when `CLOUD_ALLOWED_ORIGINS` is unset. A blocked browser call
  is a loud failure; a silently wide-open API is not.

## Verifying a deploy

```bash
curl -fsS https://tasks-api.vipper.network/health          # {"status":"ok"}
curl -o /dev/null -w '%{http_code}\n' https://tasks-api.vipper.network/v1/board   # 401
```

A 200 from `/health` and a 401 from `/v1/board` together say the right thing: the process
is up and the guard is on. Then open the web client and sign in.

## Running the image locally

The whole thing can be exercised against the local `docker-compose.yml` SQL Server, which
is how it was first proven:

```bash
pnpm db:up
docker build -f apps/server/Dockerfile -t taskmanager-server .
docker run --rm --add-host=host.docker.internal:host-gateway \
  -e DB_HOST=host.docker.internal -e DB_USER=sa -e DB_PASSWORD='Local_Dev_Password_123!' \
  -e DB_NAME=taskmanager -e NODE_ENV=production \
  taskmanager-server node dist/database/migrate.js
```

Note the database itself is not created by `docker compose` or by the migration runner —
`CREATE DATABASE taskmanager` is a one-time manual step on a fresh volume.
