# Azure realtime hosting — solution comparison

Supporting note for Phase 25's [Azure cost estimate](README.md#azure-cost-estimate).
That section still prices the Container Apps + socket.io shape (row 1) that
the estimate was first written against; this note lays every realtime option
raised while sizing it next to each other, so the choice is visible in one
place. The plan has since moved on from that shape — row 7, adaptive
polling, is what [Phase 25's own design](README.md#no-realtime-service--adaptive-polling)
commits to for v1; rows 1–6 are kept here as the alternatives that were
weighed, not the current target.

**Basis.** List prices, pay-as-you-go, no reservations, USD, ex-VAT, West
Europe, checked against the Azure Retail Prices API (`prices.azure.com`) on
2026-08-09 — see the source rates below the table. "Scenario A" and
"Scenario B" are the same two usage levels the cost estimate uses: 1–5
desktop Clients on one replica, and a ~25-Client team wanting HA. List
prices move; re-check before budgeting against these.

## Comparison

| #   | Solution                                          | Realtime transport                                                                           | Compute                                                                                                     | Database              | Scenario A (1–5)                                                              | Scenario B (~25, HA)                                                                                                             | Main tradeoff                                                                                                                                                                                    |
| --- | ------------------------------------------------- | -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | --------------------- | ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | **Current plan default**                          | socket.io over Container Apps, `min-replicas: 0`                                             | Container Apps, billed _active_ rate only while a socket is open                                            | SQL S0 (10 DTU)       | **≈ $25/mo**                                                                  | _(doesn't reach HA without #2's shape)_                                                                                          | Simplest to build (one gateway, no second service); cheapest at Scenario A; cold start on first reconnect                                                                                        |
| 2   | Same, pinned/HA                                   | socket.io, `min-replicas: 1`, 2 replicas for HA                                              | Container Apps, billed active rate for the full 730 h since a replica must always hold the socket           | SQL S2 (50 DTU)       | ≈ $65/mo (1 replica, no HA)                                                   | **≈ $323/mo**                                                                                                                    | HA needs a 2nd replica _and_ Redis (socket.io backplane, cross-replica broadcast) — that's what drives the 13× jump over Scenario A                                                              |
| 3   | App Service instead of ACA                        | socket.io over App Service, Always On                                                        | App Service **B1** (flat $13/mo, no cold start)                                                             | SQL S0                | **≈ $29/mo**                                                                  | not evaluated — same replica-affinity problem as #1/#2 once scaled past one instance                                             | Simpler ops (no scale-to-zero to reason about), but abandons the GHCR/`az containerapp update` pipeline shared with `vipper.iam`                                                                 |
| 4   | Web PubSub (considered, not taken)                | Azure Web PubSub — managed pub/sub, connections/fan-out live outside your compute            | Container Apps, `min-replicas: 0`, true scale-to-zero (compute is request/response again, no pinned socket) | SQL **Basic** (5 DTU) | **≈ $13/mo** (likely **$0** compute if usage stays inside the ACA free grant) | **≈ $70–85/mo** (1 paid unit, $49 flat, dominates the bill; message volume stays well under the free per-unit quota — see below) | Drops socket.io for a REST write path + managed broadcast; HA is free (Web PubSub does the fan-out, no Redis needed). Not taken: still a dedicated realtime service to run and pay a flat per-unit rate for, when row 7's adaptive polling gets close enough to live for $0 extra |
| 5   | **Azure SignalR**                                 | Azure SignalR Service — same pricing shape as #4, hub/group semantics instead of raw pub/sub | Same as #4                                                                                                  | Same as #4            | **≈ $13/mo**                                                                  | **≈ $70–85/mo**                                                                                                                  | Identical cost to #4 (verified: same $1.61/unit-day, same 20-conn/20K-msg free tier, same $1.00/1M message rate); pick this over #4 if socket.io-style rooms/groups matter more than raw control |
| 6   | No realtime service                               | Plain polling (client asks every 15–30 s), no push at all                                    | Container Apps or Functions Consumption, `min-replicas: 0`                                                  | SQL Basic             | **≈ $8/mo**                                                                   | **≈ $15–40/mo**                                                                                                                  | Cheapest and simplest of all — no protocol to design, no backplane, ever. Costs liveness: up to ~30 s staleness instead of a live push                                                           |
| 7   | **Adaptive polling (chosen)**                      | Plain polling, but cadence is server-decided from presence — ~2.5 s while a Client is focused, ~25 s while idle (design: [Phase 25 — no realtime service](README.md#no-realtime-service--adaptive-polling)) | Same as #6                                                                                                   | SQL Basic             | **≈ $8/mo**, same as #6                                                       | Same shape as #6 — the honest cost isn't the bill, it's request *volume*: see below                                             | Row 6's floor price with row 6's ~30 s staleness narrowed to ~25 s for whoever's actually looking, at the cost of every focused Client hammering the API every 2.5 s instead of every 15–30 s    |
| —   | `vipper.iam` (reference, not a Client-socket app) | none — request/response admin console                                                        | Container Apps 0.25 vCPU/0.5 GiB, `min-replicas: 1`                                                         | SQL Basic             | **$9–10/mo actual** (their measured bill)                                     | n/a                                                                                                                              | Proof the Container Apps + SQL Basic pattern really does run this cheap in production today                                                                                                      |

## Where the numbers come from

- **Container Apps, West Europe:** active $0.000034/vCPU-s, $0.000004/GiB-s;
  idle (both) $0.000004; free grant 180,000 vCPU-s / 360,000 GiB-s / 2M
  requests per subscription per month. Source: Retail Prices API,
  `serviceName eq 'Azure Container Apps' and armRegionName eq 'westeurope'`.
- **SQL Database, West Europe:** Basic (5 DTU) $0.161/day ≈ $4.90/mo; S0
  (10 DTU) $0.4839/day ≈ $14.73/mo; S2 (50 DTU) $2.42/day ≈ $73.66/mo.
  Source: Retail Prices API, `productName eq 'SQL Database Single Basic'`
  (and `'…Standard'` for S0/S2).
- **Web PubSub and Azure SignalR, West Europe:** Standard unit $1.61/day
  (≈ $49/mo), 1,000 connections/unit; Free tier is one restricted unit — 20
  connections, 20,000 messages/day; message overage $1.00/1M messages
  beyond 1M/unit/day free. Both services returned identical numbers from
  the Retail Prices API — they are priced the same. Billing counts only
  _outbound_ traffic in 2 KB increments; client→server traffic (heartbeats,
  pushed deltas) is inbound and free regardless of volume.
- **App Service B1, West Europe:** $0.018/hour ≈ $13.14/mo.
- **Redis Basic C0, West Europe:** $0.022/hour ≈ $16.06/mo.
- **Static Web Apps:** Free tier $0; Standard $9/mo (West Europe pricing;
  not offered in Poland Central at all as of this check).
- **`vipper.iam`'s real figures** are read from that repo's own
  `docs/06-deployment.md` (lines ~50-63, ~335-361), not re-derived — they're
  the one row here backed by an actual bill rather than a rate calculation.
- **Web PubSub message-volume sanity check** (Scenario B, pessimistic case:
  a full board snapshot broadcast to all 25 connections on every 30 s
  heartbeat, all day) comes to ≈ 360,000 messages/day — about 36% of the
  1M/unit/day free quota that ships with the one paid unit Scenario B
  already needs for its connection count. Message volume isn't expected to
  be the cost driver at either scenario; the flat per-unit charge is.
- **Row 7's request-volume note.** A Client on the focused tier polls every
  ~2.5 s — ~1,440 requests/hour for one Client that stays focused the whole
  time. Five Clients doing that across normal working hours (≈176 h/month at
  8 h/day) land at ≈1.27M requests/month — near Container Apps' 2M/month
  free-request grant on its own, before any idle-tier polling or Scenario B's
  larger fleet is added on top. That's the first thing to re-check if the
  fleet grows: it's a per-Client cost that rows 1–6's fixed infrastructure
  prices don't carry, and there's no message-volume-style cap to sanity-check
  it against the way Web PubSub has one — the request count *is* the bill's
  variable term.

## Reading this table

Rows 1–3 are variations on what's already in the plan's cost estimate: they
keep the app's own compute holding every socket open, which is what forces
Scenario B into a second replica and a Redis backplane. Rows 4–7 move the
realtime transport (or remove it) so Container Apps can go back to true
scale-to-zero at any usage level — that's the lever that matters more than
any single price. Rows 4 and 5 cost the same; the choice between them is
"raw pub/sub" vs. "hubs and groups," not budget — and neither is taken up by
the plan. Row 6 is the floor: no realtime infrastructure at all, traded for
up-to-30-second staleness instead of a live push. **Row 7 is what the plan
actually ships**: row 6's price and shape, with the staleness narrowed for
whoever's currently looking by making the poll interval a function of
presence instead of a flat constant — see [Phase 25's own
design](README.md#no-realtime-service--adaptive-polling) for the cadence
model, the presence constraint, and the two latencies it can't avoid.
