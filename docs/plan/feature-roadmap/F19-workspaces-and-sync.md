# F19 — Workspaces and sync

> **Status:** proposed · **Where:** server (`apps/server`), client (desktop main + store), web (`apps/web`), packages (`protocol`, `shared`, `ui`) · **Depends on:** the cloud service resumed (Phase 0 of this file); F14 (soft: archive fields travel as ordinary fields once it exists) · **Unlocks:** F20 (agents in a team workspace), F21, F22, F23 (Android), F24, F25, F26, F27 (enterprise)
> Only the `- [ ]` checkboxes under **Tasks** become cards when this file is imported as a plan; everything else is context.
>
> **Layout rule for this file:** every task's description bullets sit after a **blank line**. The plan
> parser folds any indented line that directly follows a checkbox into that task's *title*
> (`apps/client/src/main/planParser.ts:173-177`); the blank line is what keeps descriptions out of it.

## Why

The built-in tracker is single-user today. Every ticket lives in one desktop's SQLite file, and
the cloud only ever holds a **mirror** of it: the desktop is the authority, the server keeps a
disposable copy for the web to read, and a second person has nowhere to stand. Two people cannot
share a backlog, a phone cannot file a ticket while the desktop is asleep without the server
inventing a duplicate, and the key a ticket wears (`TM-123`) is only unique on one machine.

F19 is the foundation the whole team track (F20–F27) stands on. It adds a second kind of
workspace next to today's:

- a **local workspace**, which is exactly today's model: desktop-authoritative, no account, no
  cloud required, and it keeps working byte for byte as it does now;
- a **cloud workspace**, where the server is the authority for tickets. Every desktop holds a
  full local replica with an offline outbox, so the UI still reads local SQLite (instant, works
  offline), and the server assigns ticket keys, merges concurrent edits field by field, and
  serves the web directly, with no desktop running.

Agent runs do not move. Sessions, worktrees and steps stay on the desktop that runs them; a
cloud ticket only shows who is running it. Claiming and locking runs across desktops is F20.

## What we have today

**The server is single-account and a mirror, not an authority.**

- Every row is keyed by `accountId` (`apps/server/src/entities/*.entity.ts`). An account is an
  IAM subject: `IamAuthGuard` introspects the bearer and uses `introspection.subject` as the
  account id (`apps/server/src/iam/iamAuth.guard.ts`), then asks vipper.iam to authorize
  `{ resourceType: 'taskmanager', identifier: accountId, action: 'read' | 'write' }`, where the
  action is decided by HTTP method alone (`actionFor`). `ensureAccount` upserts the row with
  `name: accountId` (`iam/ensureAccount.ts`; the guard passes the id twice), so **the server does
  not know anybody's name or email**. The sign-in scope is `openid offline_access`
  (`packages/shared/src/iamPkce.ts`, `DEFAULT_SCOPE`).
- PATs resolve locally and never reach IAM (`iam/patService.ts`, the "route once, commit" rule
  in `iamAuth.guard.ts`).
- Mirror tables: `task_mirrors`, `project_mirrors`, `milestone_mirrors`
  (`entities/taskMirror.entity.ts`, `projectMirror.entity.ts`, `milestoneMirror.entity.ts`) hold
  the whole `Task`/`Project`/`Milestone` as one `simple-json` `data` column plus a SQL Server
  `ROWVERSION`. **The primary key is `id` alone**, not `(accountId, id)`.
  `tombstones` (`entities/tombstone.entity.ts`) records deletions so a browser can see them.
  `settings_mirrors` holds one global-settings blob per account, gated by
  `pickGlobalSettings` (memory *settings-mirror-global-vs-local*).
- `applyMirrorDelta` (`mirror/applyMirrorDelta.ts`) is upsert-the-whole-row plus tombstones:
  whole-row last-writer-wins, with the desktop as the only writer that matters.
- `MirrorService.sync` (`mirror/mirror.service.ts:110-212`) is one transaction per tick: upsert
  the `clients` row, apply the delta, store results, ack and lease commands
  (`mirror/commandQueue.ts`: at-least-once with a lease, `ackedAt` retires a row).
- The board read pages four streams and computes its cursor with `boardCursor`
  (`mirror/boardCursor.ts`): the lowest ceiling of any truncated stream wins, or rows are lost.
  `rowsSince` (`mirror.service.ts:876-890`) filters `rowVersion > :since` with **no
  `MIN_ACTIVE_ROWVERSION()` ceiling**. On Azure SQL, where `READ_COMMITTED_SNAPSHOT` is on by
  default, a reader can see rowversion 105 committed while 104 is still in an open transaction;
  the cursor then passes 104 and that row is never sent. This is a latent gap in today's board
  read and fatal for an authoritative change stream. Phase 0 fixes it.
- Direct writes already exist for the web (Phase 27): `createTask`, `updateTask`, `deleteTask`,
  `createProject`, `updateProject`, `deleteProject`, `putSettings` write the mirror and then
  `replayToDesktops` queues an `ipc-invoke` per known Client (`mirror.service.ts:214-300`).
  The code records the gap itself: `task:create` and `project:add` mint their **own** ids on the
  desktop, so a desktop that was offline gets a second, differently-id'd card; title, phase and
  type edits are not replayed at all. `ticket:create` is not in the web's direct tier at all.
  It relays (`packages/shared/src/ipcRelay.ts:251`), so **a native ticket cannot be filed from
  the web unless a desktop is polling**.
- Wire contract: `packages/protocol/src/wire.ts`. `PROTOCOL_VERSION = 3` (`wire.ts:89`) with the
  rule "bump when the wire gains a field an older peer would be WRONG to ignore". The version
  is sent on `SyncRequest`, persisted on `clients.protocolVersion`, returned on
  `BoardResponse.protocolVersion`, and the web shows `SkewBanner.tsx`.
- Migrations: TypeORM, hand-written SQL Server DDL in `apps/server/src/migrations/*`
  (latest `1794000000000-WorkflowMirrors.ts`). **There is no database integration test**:
  `mirror.service.test.ts` runs against fakes. `docker-compose.yml` has a SQL Server for local
  runs, which must be created by hand first (memory *first-boot-of-tm-server*).

**The desktop is a full store with a trigger-filled outbox and a whole-row pull.**

- `cloud_outbox` (`apps/client/src/main/store.ts:1804-1811`) is filled by
  `AFTER INSERT/UPDATE/DELETE` triggers on `tasks` and `projects` (`store.ts:2440-2495`), plus
  automations and runs. No store method has to remember to enqueue. The triggers also touch
  `updatedAt`, folded into one body because separate triggers double-log (comment at
  `store.ts:2448-2460`).
- `cloudDelta.ts` collapses the outbox to the last row per entity, caps it (`OUTBOX_LIMIT = 200`,
  `SYNC_BYTES_LIMIT`), and builds whole entities. `cloudPoller.ts` pushes on `POST /v1/sync`,
  halves the batch on 413, and bounds relayed results (`cloudResults.ts`, after memory
  *one-answer-wedges-the-mirror*: anything a tick puts in the body must be bounded, or the tick
  can wedge).
- A downstream already exists: `cloudBoardPuller.ts` polls `GET /v1/board` and
  `cloudBoardApply.ts` applies it with **one guard**: skip any entity with an un-pruned outbox
  row (`store.hasPendingCloudPush`). That is whole-row "local wins while pending". It cannot
  merge two people's edits to different fields of one ticket.
- `upsertCloudTask` keeps `projects.ticketSeq` ahead of any pulled `ticketNumber`
  (`store.ts:4324-4331`) because the allocator never travels on the wire.
- Tickets (`docs/12-the-ticket-model.md`): a ticket project is a `projects` row with a
  `ticketPrefix` and a `ticketSeq` allocator that is **not** a field on `Project`; a ticket is a
  `tasks` row with `source: 'ticket'`, `ticketKey`, `ticketNumber`, and twelve tracker columns.
  Keys come from `createTicketTx`'s `bumpTicketSeq` (`store.ts:4140-4160`), never from `MAX()`.
  Partial unique indexes `idx_projects_ticket_prefix` and `idx_tasks_ticket_key` are the
  backstop. A prefix rename re-keys every ticket in one transaction.
- Tracker side tables: `people` (app-wide, with one `isMe`), `milestones`, `ticket_labels`,
  `ticket_links`, `ticket_graph_positions` (`store.ts:1710-1795`). Comments and status history
  are `task_activity` rows (`kind: 'comment' | 'status'`, `store.ts:1530-1539`). **None of these
  is in `cloud_outbox`**: only tasks, projects, automations and runs mirror today.
- `Task` (`packages/shared/src/model.ts:692`) mixes tracker fields with run fields
  (`sessionId`, `workedAt`, `preRunStatus`, `stepSpec`, `gateAttempts`, …). A run **borrows**
  `status`, and `restingStatus(task)` is what every board surface reads (memory
  *card-state-is-the-humans*).
- Store migrations have **no automated tests**: nothing calls `createStore` under Vitest because
  `better-sqlite3` is built for Electron's ABI. The drop-column + `ELECTRON_RUN_AS_NODE` recipe
  in `scripts/verify-resume-migration.mjs` is how one is proved (memory *the-store-has-no-tests*).

**Relay and web.**

- `packages/shared/src/ipcRelay.ts` classifies every `IpcApi` channel `'relay' | 'host-only'`,
  exhaustively, so a new channel fails typecheck until classified.
- `apps/web/src/board/httpTransport.ts` has three tiers: **direct** (`task:create`,
  `task:setStatus`, `task:move`, `task:setDescription`, `project:*`, `settings:*`, automation and
  skill reads), **relayed** (`ipc-invoke`, answer polled from `GET /v1/results`), **host-only**.

**The cloud is paused.** Since 14 Oct 2026 the container app `taskmanager-api` is stopped and
`deploy.yml` is disabled; SQL Basic still bills (memory *cloud-service-paused*). Four silent
failures sit between a healthy deployment and a working sign-in (memory *cloud-sign-in-chain*),
and the server's console logs are not captured without a Log Analytics destination (memory
*cloud-service-is-live*, which also records `TypeOrmModule.forRootAsync` as still owed).

## Design

### Principles

1. **A local workspace is untouched.** No new required field, no new prompt, no account. The
   existing desktop→cloud mirror (`cloud_outbox` → `task_mirrors`) keeps serving the web cockpit
   for local workspaces exactly as today. Cloud workspaces use **new** tables on both sides,
   so nothing that works today changes meaning.
2. **The server is the authority for cloud tickets; the desktop is the authority for runs.**
   Every field has exactly one owner. Tracker fields are server-owned. Run fields are owned by
   the runner desktop. Nothing writes a field it does not own.
3. **Ops, not rows.** The desktop sends field-level operations (`set title`, `add comment`), not
   whole rows. That gives field-level merging, and it makes skew safe: an older desktop never
   overwrites a field it does not know, because it never sends that field.
4. **Everything a request carries is bounded.** Ops batches, change pages and import chunks all
   have a byte cap and a count cap (memory *one-answer-wedges-the-mirror*).
5. **A refusal parks with a reason.** A rejected op is never retried forever and never dropped
   silently. It lands in a visible "Not synced" list with the server's reason.

### Data model & contracts

**Server — new tables (one migration per phase, SQL Server DDL as in `migrations/*`):**

| Table | Key | Purpose |
|---|---|---|
| `workspaces` | `id` | `name`, `createdBy` (accountId), `createdAt`, `archivedAt`, `deletedAt` |
| `workspace_members` | `(workspaceId, accountId)` | `role` (`admin` / `member` / `guest`), `invitedBy`, `joinedAt`, `removedAt` |
| `workspace_member_projects` | `(workspaceId, accountId, projectId)` | the projects a **guest** may see (members and admins see all) |
| `workspace_invites` | `id` | `workspaceId`, `email`, `role`, `tokenHash` (salted hash, same pattern as `patService.ts`), `expiresAt`, `acceptedBy`, `revokedAt` |
| `ws_projects` | `id` | ticket projects: `workspaceId`, `ticketPrefix` (unique per workspace), `ticketSeq` (allocator, server-only), `data` JSON, `fieldVersions` JSON, `rowVersion` |
| `ws_tickets` | `id` | `workspaceId`, `projectId`, `ticketNumber` (null until assigned), `ticketKey`, `data` JSON (tracker fields only), `fieldVersions` JSON, `rowVersion` |
| `ws_milestones`, `ws_labels` | `id` | as the desktop tables, plus `workspaceId`, `fieldVersions`, `rowVersion` |
| `ws_ticket_links` | `id` | `(fromTicketId, toTicketId, type)` unique; add and remove are ops |
| `ws_comments` | `id` (client-minted UUID) | append-only: `ticketId`, `authorAccountId`, `body`, `createdAt`, `editedAt`, `deletedAt`, `rowVersion` |
| `ws_ticket_history` | `id` | append-only field changes: `ticketId`, `field`, `from`, `to`, `actor`, `at`. Every LWW overwrite is recorded here, so nothing is lost silently |
| `ws_ticket_runs` | `ticketId` | run overlay owned by the runner desktop: `runnerClientId`, `runnerAccountId`, `runState`, `updatedAt`, `rowVersion` |
| `ws_tombstones` | `(workspaceId, entity, entityId)` | deletions and visibility removals, paged like the rest |
| `ws_applied_ops` | `opId` | idempotency ledger: `workspaceId`, `clientId`, `result` JSON, `appliedAt` |

Why new tables instead of reusing `task_mirrors`: that table's key is `id` alone, its `data` is a
whole `Task` including run fields, and its semantics are "a disposable copy of one desktop".
Reusing it would make every reader guess which of two meanings a row has.

**Field ownership.** A pure table in `packages/shared/src/workspaceFields.ts` lists every
`Task`/`Project` field as `tracker` (server-owned, synced, LWW), `run` (runner-owned, pushed
into `ws_ticket_runs`) or `local` (never leaves the desktop: `sessionId`, `stepSpec`,
`gateAttempts`, worktree state, `ticket_graph_positions`). It is exhaustive over `keyof Task`
with a test, the same way `ipcRelay.ts` and `pickGlobalSettings` are. **A new field defaults to
`local` and fails the suite until classified**, so a machine-specific field cannot start syncing
by accident.

- `status` syncs as the **resting** status (`restingStatus(task)`). The run's borrowed status
  (`running`, `waiting-input`, `blocked-by-limit`) is a `run` field in the overlay. A downstream
  status change on a ticket that is running locally is written to `preRunStatus`, the same thing
  `humanStatusPatch` does for a human move today.

**Ops (new `packages/protocol/src/workspace.ts`, re-exported from `wire.ts`):**

```ts
type WorkspaceOp =
  | { kind: 'ticket.create'; opId; ticketId; projectId; fields: TrackerFields }
  | { kind: 'ticket.set'; opId; ticketId; field: TrackerField; value: unknown; baseVersion: string | null }
  | { kind: 'ticket.delete'; opId; ticketId }
  | { kind: 'comment.add' | 'comment.edit' | 'comment.delete'; opId; commentId; ticketId; body? }
  | { kind: 'link.add' | 'link.remove'; opId; linkId; from; to; type }
  | { kind: 'milestone.set' | 'label.set' | 'project.set'; opId; id; field; value }
  | { kind: 'run.report'; opId; ticketId; runState: RunOverlay | null };

type OpResult =
  | { opId; ok: true; assigned?: { ticketNumber: number; ticketKey: string } }
  | { opId; ok: false; reason: 'forbidden' | 'gone' | 'invalid' | 'conflict-key' | 'too-large'; message: string };
```

- `POST /v1/workspaces/:id/ops` — `{ clientId, protocolVersion, ops: WorkspaceOp[] }` → `{ results: OpResult[] }`.
  Capped at 200 ops and 1 MB per request. One transaction per request; every op is looked up in
  `ws_applied_ops` first, so a retried batch returns the stored results and applies nothing
  twice.
- `GET /v1/workspaces/:id/changes?since=<cursor>` → `{ cursor, hasMore, tickets, projects,
  milestones, labels, links, comments, runs, tombstones, members }`, paged per stream with
  `BOARD_PAGE_LIMIT`/`BOARD_BYTES_LIMIT` and the `boardCursor` rule, clamped below
  `MIN_ACTIVE_ROWVERSION()`.
- `GET/POST /v1/workspaces`, `PATCH /v1/workspaces/:id`, `GET/POST/PATCH/DELETE
  /v1/workspaces/:id/members`, `POST /v1/workspaces/:id/invites`, `POST /v1/invites/:token/accept`.
- Web direct writes for tickets reuse the same op handler: `POST /v1/workspaces/:id/ops` with a
  one-op batch. The web does not have a second write path.

**Conflict rules.**

- **Tracker fields: field-level last-writer-wins by server arrival order.** The server stamps
  every accepted field write with the row's new `rowVersion` and stores it in
  `fieldVersions[field]`. Client clocks are never compared, for the same reason the mirror uses
  `ROWVERSION` and not `updatedAt` (`taskMirror.entity.ts`): skew and same-millisecond writes.
  `baseVersion` is carried so the history row can say "overwrote a change you had not seen",
  but it does not reject the write.
- **Comments and history: append-only.** Ids are client-minted UUIDs, so an offline comment is
  just an insert that arrives late. Edit and delete only change that comment's own row, and
  only the author or an admin may make them.
- **Links: an add/remove set.** One row per `(from, to, type)`. The last op to arrive wins.
- **Ticket delete beats a field edit.** An edit to a deleted ticket returns `gone`. The desktop
  parks it in "Not synced" with the old value, so the human can see what was lost.
- **Run overlay: the runner owns it.** Only the desktop whose `clientId` holds the overlay may
  replace it, or clear it after a lease of 10 minutes without a report. Claiming the run is F20.

**Key allocation.**

- The server allocates inside the `ticket.create` op's transaction:
  `UPDATE ws_projects WITH (UPDLOCK, ROWLOCK) SET ticketSeq = ticketSeq + 1 OUTPUT inserted.ticketSeq WHERE id = @projectId`.
  The same "never `MAX()`" rule as `docs/12`: a deleted `TM-500` is never re-issued.
- A filtered unique index `(workspaceId, ticketKey) WHERE ticketKey IS NOT NULL` is the backstop,
  like `idx_tasks_ticket_key`. A prefix is unique per workspace (filtered unique index on
  `(workspaceId, ticketPrefix)`). A rename re-keys every ticket in one transaction, as
  `rekeyProjectTickets` does locally.
- **Temporary keys.** A ticket created offline gets its UUID immediately and `ticketKey = null`,
  `ticketNumber = null` locally. The UI shows `<PREFIX>-?` (for example `TM-?`). When the op
  result comes back with `assigned`, the desktop writes the real key in the same transaction
  that prunes the op. A temporary key is never written anywhere durable. Branch names come
  from `buildBranchName` (title + `externalKey`, `packages/ui/src/AssignAgentDialog.tsx:237`) or
  the legacy `taskBranch(taskId)`, never from `ticketKey`. The one place a key is written out
  is the PR/MR body's `Ticket ID:` line (`apps/client/src/main/forge/createPr.ts:645`), which
  silently omits it while the key is null. So opening a PR/MR on a `TM-?` ticket **parks** with
  "Waiting for this ticket's key. It is assigned when the ticket syncs." and resumes on
  assignment.
- The desktop's `projects.ticketSeq` is **not used** for cloud-workspace projects. Allocation is
  server-only. `createTicketTx` branches on `project.workspaceId`.

**Roles (v1).** One pure `workspaceCan(role, action, ctx)` in `packages/shared/src/workspaceRoles.ts`
is used by the server guard, the desktop and the web to hide controls:

| Action | admin | member | guest |
|---|---|---|---|
| Read tickets | all projects | all projects | only projects in `workspace_member_projects` |
| Comment | yes | yes | on visible projects |
| Create / edit / delete tickets, milestones, labels, links | yes | yes | no |
| Create and rename projects, manage prefixes | yes | yes | no |
| Invite, change roles, remove members, workspace settings, delete workspace | yes | no | no |
| Publish a local workspace into it | yes | no | no |

The last admin cannot leave or be demoted. Fine-grained permissions are F27.

**Protocol versioning and skew.**

- `PROTOCOL_VERSION` becomes **4**. The workspace routes are server routes a browser calls
  directly, and a v3 server would answer them 404, which reads as "you have no workspaces". That
  is the case the file's own rule calls wrong to leave silent.
- The server refuses `/v1/workspaces/:id/ops` and `/changes` from a desktop whose
  `protocolVersion < 4`, or that sends none, with `426` and `{ minProtocol: 4 }`. The desktop
  shows "Update the app to sync this workspace" and keeps its replica read-only. It never
  sends an op the server cannot interpret.
- Each workspace stores `minProtocol`. A later wave that adds a tracker field older desktops
  would be **wrong** to ignore raises it for that workspace only. An optional field does not:
  thanks to principle 3, an older desktop simply never sends it, and drops it on the way down.
- The v3 routes (`/v1/sync`, `/v1/board`, `/v1/tasks`, …) keep working unchanged for local
  workspaces. Ship order: **server first, then web, then desktop** (memory
  *web-mirrors-the-desktop*), and nothing in the client turns on until the server answers v4.

**Migration of existing data.**

- **Nothing is migrated automatically.** An existing account's `task_mirrors`/`project_mirrors`
  rows remain the mirror of that user's local workspace. A cloud workspace only comes into
  existence when someone creates one, or **publishes** a local workspace into it.
- `accounts` gains `email` and `displayName` (nullable). They are filled from IAM userinfo once
  the sign-in scope includes `profile email` (see F19.5). A refresh token minted with the old
  scope keeps working; the person is asked to sign in again only when they open a cloud
  workspace's member list without a name on file.
- The desktop's `people` table gains `accountId` (nullable). In a cloud workspace the people
  list is the member list, materialised from `members` in the change stream. Local `people`
  rows keep working in local workspaces.

### Engine / desktop main process

**Store (one migration block, proved by a `scripts/verify-workspaces-migration.mjs` on the
drop-column + `ELECTRON_RUN_AS_NODE` recipe):**

- New `workspaces` table: `id`, `name`, `role`, `cursor`, `minProtocol`, `syncState`,
  `lastSyncedAt`. A local workspace has no row; it is the implicit `workspaceId = NULL`.
- `projects.workspaceId TEXT NULL`. A project belongs to one workspace. Tasks, milestones,
  labels and links inherit their workspace through `projectId`. That keeps today's board
  machinery, cascades and partial indexes working unchanged.
- `task_activity` gains `remoteId`, `authorAccountId`, `editedAt`, `deletedAt` for comments.
- `ws_outbox` (`seq`, `workspaceId`, `opId`, `kind`, `entityId`, `field`, `payload`, `at`,
  `parkedReason`) and `ws_apply_guard` (a one-row flag table).

**Capture without touching the store methods.** Following the `cloud_outbox` precedent, a
generator in `store.ts` writes one `AFTER UPDATE` trigger per synced table whose body inserts one
`ws_outbox` row **per changed tracker column**: `INSERT … SELECT … WHERE OLD.title IS NOT NEW.title`,
and so on, generated from `workspaceFields.ts`. It sits in the same single trigger body, for the
same double-firing reason. Every trigger is guarded by
`WHEN (SELECT workspaceId FROM projects WHERE id = NEW.projectId) IS NOT NULL AND NOT EXISTS (SELECT 1 FROM ws_apply_guard)`.

- The legacy `cloud_outbox` triggers gain the inverse `WHEN … IS NULL`. Cloud-workspace rows
  never travel the old mirror, so they cannot reach `task_mirrors` under a second authority.
- Applying a downstream page sets `ws_apply_guard` inside the apply transaction, so applying
  the server's own values never re-enqueues them as local ops. This is the guard
  `upsertCloudTask`'s writes lack today: the legacy pull echoes back up.
- Values are read at push time and collapsed to the last write per `(entity, field)`, exactly as
  `shapeCloudDelta` collapses rows. A field edited five times offline is one op.

**`WorkspaceSyncer`** (`apps/client/src/main/workspaceSync.ts`) runs one loop per joined cloud
workspace, on the same self-scheduling `setTimeout` shape and cadence as `cloudBoardPuller.ts`
and `cloudPoller.ts`, and beside them, not inside them:

1. **Push**: read up to 200 ops / 1 MB from `ws_outbox`, `POST …/ops`. For each result: `ok`
   prunes the op and applies `assigned` keys; `ok: false` marks it `parkedReason` and stops
   retrying it. A 413 halves the batch; a network failure backs off and retries the same batch
   (the ops are idempotent by `opId`).
2. **Pull**: `GET …/changes?since=cursor`, loop while `hasMore`. Apply in one transaction under
   the apply guard. For a field that still has an un-pruned op in `ws_outbox`, skip that
   **field**, not the whole row. This is the field-level version of
   `cloudBoardApply`'s `hasPendingCloudPush` guard, and it is what lets two people edit
   different fields of one ticket at once.
3. Tombstones delete locally. A ticket removed from a guest's visibility arrives as a tombstone
   with `reason: 'hidden'`.

**What stays desktop-owned (never server-authoritative in F19):** agent projects (a `path` on
this machine, `useWorktrees`, `target`, the exec host), sessions and `task_events` transcripts,
steps (`parentTaskId` children, which are run artefacts), attention items, token usage,
`merge_requests`, forge and tracker credentials, machine-local settings, and every
JIRA/GitHub/Linear-sourced card (those stay in local workspaces in v1). A cloud ticket may
reference a local agent project through `projectTagId`. That reference is a **local** field,
because another desktop has no such project. F20 turns it into a team-visible assignment.

### Server & relay

- New Nest module `apps/server/src/workspaces/` (`workspaces.controller.ts`, `workspaces.service.ts`,
  `ops.service.ts`, `changes.service.ts`, `members.service.ts`, `invites.service.ts`), all
  behind `IamAuthGuard` plus a new `WorkspaceGuard`. That guard loads the caller's membership
  (cached per request), 404s for a non-member (it never confirms a workspace exists), and passes
  the role into `workspaceCan`.
- IAM is still asked only the coarse question, "may this subject use `taskmanager` at all"
  (today's call, unchanged). Membership and roles live in this server's tables. vipper.iam has
  no organisations or tenants yet; that is backlog item **E** in its own plan
  (`C:\Repositories\iam\docs\plan.md`). F27 revisits this split.
- **PATs and workspaces:** a PAT resolves to an account exactly as today and then goes through
  the same `WorkspaceGuard`. No new token type.
- Events: an accepted op batch emits `workspace.changed` on the existing `EventBus`, so a web tab
  or desktop holding `GET /v1/events` polls `/changes` immediately instead of waiting a cadence
  tick. It is a nudge only; the change stream stays the source of truth.
- `ipcRelay.ts`: every new channel is classified. `workspace:list`, `workspace:members`,
  `workspace:invite` relay. `workspace:publish` and `workspace:exportToLocal` are **host-only**
  with a new reason, `'local-data'`: they move a whole local database and must be started at
  that machine.

### UI — desktop

Per the v9 mockups (`mockups/v9-1-issues-list-light.svg`, `v9-3-issues-list-dark.svg`):

- **Workspace switcher** at the top of the sidebar. Cloud workspaces are listed with their
  role; "This machine" lists the local workspace(s) below the team tree.
- A **sync pill** in the status bar: `Synced`, `Syncing…`, `Offline · 3 changes waiting`,
  `Update required`. It is quiet when synced; colour only while it moves or needs attention
  (memory *board-colour-budget*).
- Ticket rows and the detail header show `TM-?` in the faint mono key style until a key is
  assigned, with a tooltip "Key assigned when this ticket syncs".
- A **"Not synced"** list (from the sync pill) shows parked ops, each with the server's reason,
  the value that did not land, and **Retry** / **Discard**.
- Settings → Workspace: name, members (role dropdown, remove), pending invites (copy link,
  revoke), and **Publish this workspace to the cloud…** / **Make a local copy…**.
- A cloud ticket that another desktop is running shows the runner's name and a cyan run pill,
  read-only (F20 adds Stop and claiming).

### UI — web

- The web gets the same switcher. A cloud workspace's board reads `GET /v1/workspaces/:id/changes`
  into `cloudBoardStore`, with no desktop needed. Editing a ticket, comments, links, milestones
  and labels go to the ops route (the direct tier). Starting an agent run still relays to a
  desktop (F20).
- A local workspace in the web is today's mirror cockpit, unchanged.
- Members and invites pages in web Settings. They are reachable without any relayed read (memory
  *pat-page-bootstrap-deadlock*).
- `/invite/<token>` accept page. A signed-out visitor signs in first and returns to the page.

### Publish a local workspace to the cloud

1. **Preflight** (desktop, read-only): pick the ticket projects to publish. Agent projects,
   Personal and plan-driven projects are listed as "stays on this machine". Check the
   prefixes against the target workspace (`GET …/prefixes`). A collision **refuses before
   anything uploads** and names the prefix and the fix (rename locally first).
2. **Import session**: `POST /v1/workspaces/:id/imports` → `importId`. The desktop uploads chunks
   (projects, milestones, labels, tickets **with their existing ids, numbers and keys**, links,
   comments and status history as `ws_ticket_history`, attachments through the existing
   `POST /v1/uploads` blob path). Each chunk is ≤ 1 MB and idempotent by `(importId, chunkNo)`.
3. **Commit**: `POST …/imports/:importId/commit` sets each project's server `ticketSeq` to the
   local `ticketSeq` (not `MAX(ticketNumber)`, so deleted keys stay retired), then makes the rows
   visible in one transaction. Until commit nothing is visible, and an abandoned import expires
   after 24 h.
4. **Flip** (desktop, one transaction): set `projects.workspaceId` on the published projects,
   record the server cursor, and clear their `cloud_outbox` rows. From here they sync as cloud
   tickets. The local copy is not deleted; it **becomes** the replica.

People: each local `people` row that is assigned to something is mapped in the preflight to a
member or an invite, or left as "unassigned on publish". It is never silently dropped.

### Export a cloud workspace to local

**Make a local copy** detaches the replica: in one transaction, `workspaceId = NULL` on its
projects, the outbox for that workspace is discarded (after a confirm that lists any unsynced
ops), member-people are converted to local `people` rows, and the workspace row is removed. The
user can stay a member and rejoin to get a fresh replica. A copy that kept the same ids **and**
stayed joined is impossible, because `tasks.id` and `idx_tasks_ticket_key` are unique per
database. Detaching is therefore the only honest export into the same desktop. A full
file-based export is F27.

### Failure modes & edge cases

- **Two desktops edit the same field offline.** The later arrival wins. The earlier value is in
  `ws_ticket_history` with "overwritten by <name>", visible in the ticket's activity (F22 shows
  it fully).
- **An op for a ticket deleted elsewhere** gets `gone` and is parked with the value it carried.
  Nothing is resurrected.
- **A guest loses access to a project** mid-session. The next `/changes` page carries `hidden`
  tombstones and the replica deletes those rows. Data already on that disk cannot be wiped
  remotely; F27 says so in the admin UI.
- **A member is removed.** Their next request 404s on that workspace. The desktop marks the
  replica `removed`, stops syncing and offers "Make a local copy" or "Delete".
- **A desktop is offline for weeks.** The cursor is still valid (rowversion is monotonic), and
  tombstones are kept for 90 days. A cursor older than the oldest kept tombstone gets
  `410 Gone` and the desktop re-downloads the workspace (keeping its outbox).
- **A huge first download.** It pages with `hasMore`, and the UI shows "Downloading workspace
  (1,240 / 3,800 tickets)". The board is usable as rows arrive.
- **A key arrives for a ticket the user already referenced as `TM-?`** in a comment. The text is
  left alone; the activity notes the assigned key.
- **A prefix rename while a desktop is offline.** The rename re-keys on the server. The next pull
  re-keys locally inside the apply transaction. The partial unique index cannot collide, because
  the server rows are already unique.
- **A trigger misses a column.** The generator is driven by `workspaceFields.ts`, and a test
  asserts that every `tracker` field has a column trigger.
- **The rowversion read gap** (see What we have today) is closed by the `MIN_ACTIVE_ROWVERSION()`
  clamp for both the board and the change stream.
- **The server is the only copy of a cloud workspace** once a second person writes to it. SQL
  Basic's 7-day point-in-time restore becomes the backup story. Phase 0 records the restore
  drill and the retention decision.

## Out of scope (v1)

- Agent runs across desktops: claiming, locking, team-visible steps, agent identities (F20).
- Teams inside a workspace, custom workflow states, sub-issues (F21).
- Mentions, notifications, subscribers and the full history UI (F22). F19 only **records**
  history.
- Cycles and projects-with-progress (F24); saved views and search (F25).
- SSO/SAML, SCIM, audit log, fine-grained permissions, file export (F27).
- A replica on the phone (F23 reads the server directly).
- Moving JIRA, GitHub or Linear-sourced cards into a cloud workspace.
- Real-time co-editing of a description (whole-field LWW only).
- Automatic migration of today's mirror rows into a cloud workspace.

## Open questions

- **Field LWW by server arrival order, or by client hybrid-logical clocks?** Recommended
  default: **arrival order**. It cannot be fooled by a skewed clock, matches the existing
  rowversion reasoning, and the history row keeps the overwritten value. Revisit only if
  overwrites by long-offline desktops are reported.
- **May an agent run start on a ticket whose key is still `TM-?`?** Recommended default: **yes**.
  Branch names do not use `ticketKey`, so nothing durable records the temporary key. Only
  opening the PR/MR waits, parked with a reason, because its `Ticket ID:` line needs the real
  key.
- **Inviting someone with no vipper.iam user.** vipper.iam has no self-registration (user
  creation is an admin action in `iam/apps/backend/src/users`). Recommended default: the invite
  is by email; the accept page requires an IAM sign-in, and tells someone without one to ask the
  IAM administrator. Self-registration is a vipper.iam task, recorded as a dependency, not
  built here.
- **Membership and roles in this server, or in vipper.iam?** Recommended default: **this
  server** for v1. IAM has no tenants. F27 maps IAM groups onto workspace roles.
- **One SQLite database with `workspaceId`, or one file per workspace on the desktop?**
  Recommended default: **one database**. Every query, cascade and index keeps working, and
  "Make a local copy" is one `UPDATE`.
- **Guest scope.** Recommended default: guests see only the projects they are added to, and may
  read and comment. Anything finer is F27.
- **SQL tier.** SQL Basic is 5 DTU. Recommended default: measure the change stream under a
  seeded 5-person, 5,000-ticket load in Phase 6. Budget for S0 (about €13/month) before inviting
  a real team.
- **Tombstone retention.** Recommended default: **90 days**, with `410 Gone` → full re-download
  past it.

## Tasks

### F19 · Phase 0 — Resume and harden the cloud

- [ ] F19.1 Resume the cloud service and re-verify the sign-in chain

  - Start `taskmanager-api` (`az rest … /start` per memory *cloud-service-paused*), `gh workflow enable deploy.yml`, redeploy. Land the owed `TypeOrmModule.forRootAsync({ useFactory })` fix in `apps/server/src/app.module.ts` (memory *cloud-service-is-live*). Turn on a minimal log destination so a crash loop is readable. Record the SQL point-in-time restore drill and the backup retention decision in `docs/10-cloud-deployment-runbook.md`.
  - Acceptance: `/health` 200 and unauthenticated `/v1/board` 401 against the live host. The desktop's **Test connection** (`cloudTestConnection.ts`) is green on all three rungs. A restore to a scratch database is performed once and recorded. Gates green.
- [ ] F19.2 Add a SQL Server integration test harness for the server @needs: F19.1 Resume the cloud service and re-verify the sign-in chain

  - `apps/server/test/db/*.db.test.ts` run by `pnpm --filter @tm/server test:db` against the `docker-compose.yml` SQL Server, with the create-database step scripted (memory *first-boot-of-tm-server*). Runs every migration up from empty. A `db` job in `.github/workflows/ci.yml` uses a SQL Server service container. `pnpm test` stays database-free.
  - Acceptance: the harness runs all existing migrations up and down on an empty database. A deliberately broken migration fails the CI job (proved once by mutation, memory *a-cached-gate-is-not-a-gate*).
- [ ] F19.3 Clamp change-stream reads below MIN_ACTIVE_ROWVERSION @needs: F19.2 Add a SQL Server integration test harness for the server

  - `rowsSince` (`mirror/mirror.service.ts`) and the results read add `AND rowVersion < MIN_ACTIVE_ROWVERSION()`, so a cursor never passes a row whose transaction is still open. A pure helper in `mirror/rowVersion.ts` builds the clause, and `boardCursor` documents the new ceiling.
  - Acceptance: a `test:db` test holds a transaction open on one insert, commits a later one, reads the board, and proves the first row is delivered on the next read (and is lost without the clamp: red before green).

### F19 · Phase 1 — Workspaces, members, invites

- [ ] F19.4 Add workspace and membership tables with the WorkspaceGuard @needs: F19.2 Add a SQL Server integration test harness for the server

  - Migration for `workspaces`, `workspace_members`, `workspace_member_projects`, `workspace_invites`. Entities, `apps/server/src/workspaces/workspace.guard.ts` (404 for non-members), `GET/POST/PATCH /v1/workspaces`. Pure `workspaceCan(role, action, ctx)` in `packages/shared/src/workspaceRoles.ts`.
  - Acceptance: unit tests cover every cell of the role table and the last-admin rule. A `test:db` test shows a non-member gets 404 (not 403) and a member of workspace A cannot read workspace B.
- [ ] F19.5 Capture member names and emails from vipper.iam @needs: F19.4 Add workspace and membership tables with the WorkspaceGuard

  - Add `profile email` to the desktop and web sign-in scope (`iamPkce.ts`). Add `accounts.email`/`displayName` (migration). Read userinfo on `ensureAccount` with a short cache. Show a "sign in again to share your name" prompt where a member row has no name.
  - Acceptance: tests for the scope string and the userinfo mapping (missing claims leave the columns null; the name never falls back to the raw subject in the UI). An old refresh token still authenticates.
- [ ] F19.6 Build members, invites and roles end to end @needs: F19.5 Capture member names and emails from vipper.iam

  - Server: `members.service.ts`, `invites.service.ts` (hashed single-use tokens, 7-day expiry, revoke). `POST /v1/invites/:token/accept`. Web: Settings → Members and `/invite/<token>`, neither gated on a relayed read. Desktop: the same members panel via the shared `@tm/ui` component.
  - Acceptance: tests for invite accept (expired, revoked, reused, wrong account), role change, removal, and the last-admin guard. The invite page renders signed out (memory *pat-page-bootstrap-deadlock*).

### F19 · Phase 2 — Server-authoritative tickets

- [ ] F19.7 Add the server ticket tables and the field ownership map @needs: F19.4 Add workspace and membership tables with the WorkspaceGuard

  - Migration for `ws_projects`, `ws_tickets`, `ws_milestones`, `ws_labels`, `ws_ticket_links`, `ws_comments`, `ws_ticket_history`, `ws_ticket_runs`, `ws_tombstones`, `ws_applied_ops`, with filtered unique indexes on `(workspaceId, ticketPrefix)` and `(workspaceId, ticketKey)`. `packages/shared/src/workspaceFields.ts` classifies every `Task`/`Project` field `tracker | run | local`, exhaustively.
  - Acceptance: a test fails when a `Task` field is unclassified (proved by adding a dummy field). `test:db` proves both filtered indexes allow many NULLs and refuse a duplicate.
- [ ] F19.8 Allocate ticket keys on the server @needs: F19.7 Add the server ticket tables and the field ownership map

  - `ticket.create` bumps `ws_projects.ticketSeq` under `UPDLOCK` in the op transaction. Prefix rename re-keys in one transaction. A refused create burns no number.
  - Acceptance: `test:db` ports `verify-tickets.mjs` §4 and §12 semantics. Twenty parallel creates get twenty distinct consecutive numbers. A deleted top key is never re-issued. A colliding rename rolls back every ticket and the prefix.
- [ ] F19.9 Accept field-level ops with idempotency and last-writer-wins @needs: F19.8 Allocate ticket keys on the server

  - `packages/protocol/src/workspace.ts` (`WorkspaceOp`, `OpResult`). Bump `PROTOCOL_VERSION` to 4 with its rationale in `wire.ts`. `POST /v1/workspaces/:id/ops`: 200-op / 1 MB caps, the `ws_applied_ops` ledger, per-field versions, history rows on overwrite, append-only comments, the link add/remove set, the `run.report` overlay owned by its runner, and `426 { minProtocol }` for older clients.
  - Acceptance: pure tests of the merge function (two fields from two writers both land; same field, later arrival wins, history keeps the loser; an edit after a delete is `gone`; a replayed batch returns stored results and changes nothing). `test:db` for the full route, including a guest refused with `forbidden`.
- [ ] F19.10 Serve the workspace change stream @needs: F19.9 Accept field-level ops with idempotency and last-writer-wins, F19.3 Clamp change-stream reads below MIN_ACTIVE_ROWVERSION

  - `GET /v1/workspaces/:id/changes?since=` pages every stream with `boardCursor` and the clamp, filters by guest visibility, emits `hidden` tombstones, answers `410` past tombstone retention, and nudges `workspace.changed` on the event bus.
  - Acceptance: `boardCursor`-style tests with three interleaved streams and a truncated one; `test:db` proves a guest never receives a row from a project not granted, and gets a `hidden` tombstone when a grant is removed.

### F19 · Phase 3 — The desktop replica

- [ ] F19.11 Add workspaces to the desktop store @needs: F19.7 Add the server ticket tables and the field ownership map

  - `workspaces` table, `projects.workspaceId`, `people.accountId`, comment columns on `task_activity`, `ws_outbox`, `ws_apply_guard`. `createTicketTx` skips the local allocator for a cloud project and leaves the key null. Legacy `cloud_outbox` triggers gain `WHEN … workspaceId IS NULL`.
  - Acceptance: `scripts/verify-workspaces-migration.mjs` (drop-column + `ELECTRON_RUN_AS_NODE`, memory *the-store-has-no-tests*) upgrades a pre-F19 database, proves a local-workspace edit still enqueues `cloud_outbox` and a cloud-workspace edit does not, and is shown to fail when the `WHEN` clause is removed.
- [ ] F19.12 Capture field-level ops with generated triggers @needs: F19.11 Add workspaces to the desktop store

  - Generate per-column `ws_outbox` inserts from `workspaceFields.ts` inside one trigger body per table (the double-fire rule at `store.ts:2448-2460`), guarded by `ws_apply_guard`. Comment, link, milestone and label tables get their own insert and delete triggers. A pure `shapeWorkspaceOps` collapses to the last write per `(entity, field)`.
  - Acceptance: unit tests for `shapeWorkspaceOps`. The verify script proves one edit of three fields makes three ops, an apply under the guard makes none, and every `tracker` field has a trigger.
- [ ] F19.13 Push the outbox and apply op results @needs: F19.12 Capture field-level ops with generated triggers, F19.9 Accept field-level ops with idempotency and last-writer-wins

  - `apps/client/src/main/workspaceSync.ts` push half: bounded batches, 413 halving, backoff, `assigned` keys written in the same transaction that prunes, and `ok: false` parked with its reason (never retried in a loop).
  - Acceptance: tests with a recorded fetch: a retried batch after a lost response does not duplicate; a 413 shrinks and recovers; a parked op stops the retry but not the ops behind it (no wedge, memory *one-answer-wedges-the-mirror*).
- [ ] F19.14 Pull the change stream into the replica @needs: F19.13 Push the outbox and apply op results, F19.10 Serve the workspace change stream

  - The pull half: page while `hasMore`, apply under the guard in one transaction, skip only the fields with pending ops, write a downstream status on a running ticket to `preRunStatus`, re-key on a prefix rename, delete on tombstones, and re-download on `410`.
  - Acceptance: tests of the pure apply planner (a field pending locally is kept while its sibling field is applied; a running ticket keeps its borrowed status). The verify script proves an applied page creates no `ws_outbox` rows.
- [ ] F19.15 Show temporary keys, sync state and parked ops @needs: F19.14 Pull the change stream into the replica

  - `TM-?` rendering in `@tm/ui` key components, the status-bar sync pill, the "Not synced" list with Retry and Discard, "Update required" for `426`, and the runner name on a ticket another desktop runs. Opening a PR/MR on a `TM-?` ticket parks with the waiting-for-key reason and resumes when the key arrives. New channels classified in `ipcRelay.ts`.
  - Acceptance: selector tests for the key label and pill state; a test that the PR/MR park is set on a null key and cleared on assignment; `pnpm typecheck` proves every new channel is classified. Colour appears only for moving or attention states (memory *board-colour-budget*).

### F19 · Phase 4 — Publish and export

- [ ] F19.16 Publish a local workspace to the cloud @needs: F19.14 Pull the change stream into the replica, F19.6 Build members, invites and roles end to end

  - Desktop preflight (prefix collisions refused up front, a people → member/invite map, the "stays on this machine" list), server import sessions (chunked, idempotent, committed atomically, expiring), `ticketSeq` carried from the local allocator, attachments through `POST /v1/uploads`, and the flip transaction. `workspace:publish` is host-only (`'local-data'`).
  - Acceptance: the verify script publishes a seeded 500-ticket workspace with links, milestones, comments and a deleted top key, then proves keys, links and history are identical on the server, the next new ticket does not reuse the deleted key, and a re-run after a killed upload completes without duplicates.
- [ ] F19.17 Make a local copy of a cloud workspace @needs: F19.14 Pull the change stream into the replica

  - Detach in one transaction (workspaceId → NULL, members → local `people`, the outbox discarded after a confirm that lists unsynced ops). A removed member is offered the same action.
  - Acceptance: the verify script detaches a replica and proves the board, keys and links are unchanged, local edits enqueue `cloud_outbox` again, and nothing reaches the workspace routes.

### F19 · Phase 5 — Web and workspace UI

- [ ] F19.18 Edit cloud-workspace tickets from the web without a desktop @needs: F19.10 Serve the workspace change stream

  - `httpTransport.ts` routes ticket, comment, link, milestone and label writes for a cloud workspace to the ops route (direct tier) and reads `/changes` into `cloudBoardStore`. A run action still relays. A local workspace behaves exactly as today.
  - Acceptance: transport tests prove a cloud ticket create and edit never queue an `ipc-invoke`, and a local-workspace `task:create` still takes today's path. Manual check with no desktop polling: create, edit, comment and link from the web; recorded.
- [ ] F19.19 Add the workspace switcher and create and join flows @needs: F19.18 Edit cloud-workspace tickets from the web without a desktop, F19.15 Show temporary keys, sync state and parked ops

  - The sidebar switcher (cloud workspaces, then "This machine"), create a workspace, accept an invite on the desktop (it downloads the replica with progress), and leave a workspace. Shared `@tm/ui` components on both hosts (memory *web-mirrors-the-desktop*).
  - Acceptance: selector tests for the switcher list and its states; `test/shell-parity.test.ts` still green.

### F19 · Phase 6 — Prove it end to end

- [ ] F19.20 Verify two-desktop sync end to end with a scenario harness @needs: F19.16 Publish a local workspace to the cloud, F19.17 Make a local copy of a cloud workspace, F19.19 Add the workspace switcher and create and join flows

  - `apps/client/scripts/verify-workspace-sync.mjs`: two store instances under `ELECTRON_RUN_AS_NODE` (no window, memory *verify-electron-app*) against the docker server. It covers an offline create → `TM-?` → reconnect → key; concurrent edits to different fields and to the same field; offline comments from both; delete versus edit; a prefix rename while offline; a guest grant removed; a v3 client refused; publish, then detach. A 5-person, 5,000-ticket load records DTU use for the SQL tier decision.
  - Acceptance: every scenario passes, and the harness is shown to fail when the per-field pending guard is removed. All three gates green with `--force`. Results recorded in this file.
