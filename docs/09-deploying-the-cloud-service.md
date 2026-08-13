# Deploying the cloud service

Nothing about the cloud service is manual after the first stand-up. Push to `development`,
and `@tm/server` and `@tm/web` deploy themselves. The desktop app releases itself off the
same push, but through a different workflow that shares nothing with this one — see
[`11-ci-cd-pipeline.md`](11-ci-cd-pipeline.md), which covers all three workflows, the
secrets and the one-time repository settings.

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

**One replica, always — `min_replicas = max_replicas = 1`.** Four things in this process are
per-process state, and every one of them is wrong on a second replica:

- **presence** ([`presence.registry.ts`](../apps/server/src/presence/presence.registry.ts)) is
  an in-memory `Map`, so a second replica answers polls from a table that never saw the other
  half of the conversation and the board silently sits on the idle cadence tier;
- **the guard's auth caches** ([`iamAuth.guard.ts`](../apps/server/src/iam/iamAuth.guard.ts))
  live on the guard instance, deliberately — a cached authorization that survives a restart is
  a decision, not an optimisation;
- **the event bus** ([`eventBus.ts`](../apps/server/src/events/eventBus.ts)) holds every open
  `GET /v1/events` stream and the replay ring behind it. A desktop's `POST /v1/events` reaching
  replica A while the browser is streaming from replica B pushes events into a process nobody
  is listening to, and the tab shows a board that never moves.
- **the media-token registry**
  ([`mediaTokens.ts`](../apps/server/src/attachments/mediaTokens.ts)) holds the short-lived
  `?mt=` tickets `<img src>` reads attachment bytes with. Minted on replica A and presented to
  replica B, a perfectly valid ticket is a 401 and the picture never loads. In memory on
  purpose — a ticket that survives a restart is a decision — and a restart costs one round trip
  to mint another.

The first two have been true and undocumented since the service was first deployed. The third
is what makes **`min_replicas`** matter as well, which is new: Container Apps' default HTTP
scaler counts **concurrent requests**, and an SSE stream is one concurrent request for its
entire life. Open a handful of tabs and ACA does exactly what it was told — it scales out, and
you have a split brain. Pinning both ends is the only thing that stops it.

Sticky sessions do not rescue this. ACA's session affinity is a **cookie**, and the desktop
Client polls with Node's `fetch`, which carries no cookie jar — so the one caller whose
requests must land on the same replica as the browser's stream is precisely the one affinity
cannot pin.

`min_replicas = 1` also means no scale-to-zero and therefore a small always-on bill (the
`docs/plan/azure-realtime-cost-comparison.md` row 2 shape). That is the price of a push
channel, and it is bounded: still one replica, not two, and no Redis backplane — the thing
that made HA thirteen times more expensive in that same comparison.

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
| `CLOUD_BLOB_QUOTA_BYTES` | unset — 256 MB of attachment bytes per account, evicted coldest-first. Worth lowering if the SQL tier gets tight, since the bytes live in a `VARBINARY(MAX)` column there (`attachments/blobStore.ts`) |

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
curl -o /dev/null -w '%{http_code}\n' https://tasks-api.vipper.network/v1/board    # 401
curl -o /dev/null -w '%{http_code}\n' https://tasks-api.vipper.network/v1/events   # 401

# And the pin, which no probe can infer — both numbers must read 1.
az containerapp show -n taskmanager-api -g taskmanager \
  --query 'properties.template.scale.{min:minReplicas,max:maxReplicas}'
```

A 200 from `/health` and a 401 from `/v1/board` together say the right thing: the process
is up and the guard is on. `/v1/events` answers 401 for the same reason — it is guarded like
every other `/v1` route, and a GET is classified `read`. Then open the web client and sign in.

The scale query is worth running after any infrastructure change: it is set in the separate
`infrastructure` repo, so nothing in this one can enforce it, and a stream that works
perfectly on one replica is exactly what an unpinned `min_replicas` breaks later under load.

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
