# F20 — Agents in a team workspace

> **Status:** proposed · **Where:** server (`apps/server`), client (desktop main), `packages/shared`, `packages/protocol`, `packages/ui`, web · **Depends on:** F19 (workspaces & sync foundation) · **Unlocks:** F22 (agent comments in threads and notifications), F26 (AI triage runs under an agent identity), F17 across a team (delivery on a shared board)
> Only the `- [ ]` checkboxes under **Tasks** become cards when this file is imported as a plan; everything else is context.
>
> **Layout rule for this file:** every task's description bullets sit after a **blank line**. The plan
> parser folds any indented line that directly follows a checkbox into that task's *title*
> (`apps/client/src/main/planParser.ts:173-177`); the blank line is what keeps descriptions out of it.

## Why

In a cloud workspace (F19) every member's desktop holds a full replica of the team's tickets.
Without coordination, two problems follow.

- **Two desktops can run the same ticket.** Each desktop's scheduler pumps its own replica,
  so if two desktops serve the same project, both start the same ticket. That costs two
  sessions and two branches, and then two PRs.
- **The team cannot see agent work.** A teammate cannot tell that an agent is working on a
  ticket, on whose machine, or how far it has got.

F20 makes an agent a first-class **assignee** in a cloud workspace. A ticket assigned to an
agent is **claimed** by exactly one desktop under a lease with a heartbeat. A stale lease can
be taken over. Run status, steps and review state are visible to every member through the
mirror. What the agent writes on the ticket appears under the agent's own identity, attributed
to the desktop that ran it.

Agent runs stay on the desktop that runs them (decision taken with the user). Only the claim,
the status and the attribution travel.

## What we have today

Verified on `docs/roadmap-f13-f27` (tip `95d3bcf`).

- **A claim queue exists, half-built.** `packages/shared/src/agent.ts` defines:
  - `AgentProfile` (`:19`);
  - `Assignment` (`:55`), with `queued → claimed → running → done|failed` (`:53`).

  Its own docstring (`:45-51`) says a dead desktop's claim is never re-queued.

  Server side:
  - entities `apps/server/src/entities/agentProfile.entity.ts` and `assignment.entity.ts`,
    which hold `claimedByClientId`, `claimedAt`, `startedAt`, `completedAt` and `runId`;
  - routes in `apps/server/src/agents/agents.controller.ts:36-89`: `GET`/`POST v1/agent-profiles`,
    `POST v1/assignments`, `POST v1/assignments/:id/claim` and `POST v1/assignments/:id/complete`.

  Known problems:
  - `AgentsService.claim` (`agents.service.ts:216-239`) reads, then writes, the status inside
    one transaction, but with no row lock and no conditional
    `UPDATE … WHERE status = 'queued'`, so two claims can race.
  - `report()` checks that the reporter is the claimant (`:247-273`).
  - The desktop worker, `apps/client/src/main/assignmentPoller.ts:136-185`, fetches queued
    rows, keeps those for projects it serves, claims, calls `runTask`, and reports
    `running`. It **never reports `done`/`failed`**, and a refused start stays `claimed` for
    ever.
  - There is no lease and no heartbeat.

  UI: `apps/web/src/agents/Fleet.tsx` and `apps/client/src/renderer/src/AgentProfiles.tsx`.
- **Desktop identity.** `apps/server/src/entities/client.entity.ts` has:
  - `id` (nvarchar 64, `:25`);
  - `accountId` (`:29`);
  - `name` (`os.hostname()`, `:33`);
  - `platform`, `appVersion`, `protocolVersion` (`:37-45`);
  - `createdAt`.

  There is no `lastSeen` column, on purpose. The id is a random UUID made once by
  `loadCloudClientId()` (`apps/client/src/main/store.ts:5990-5996`). The row is upserted
  lazily on every `POST /v1/sync` (`apps/server/src/mirror/mirror.service.ts:140-144`,
  `mirror/clientInfo.ts`).
- **Presence.** `apps/server/src/presence/presence.registry.ts:162-203` keeps an in-memory
  `Map<accountId, Map<sessionId, {kind, focused, at}>>`. It is not persisted, and it only
  works on a single replica.
  - Beats come from `/v1/sync` (`mirror.service.ts:202`), `GET /v1/board` with
    `X-TM-Client-Id` (`:757`), and `POST /v1/presence` (`presence.controller.ts:53-66`).
  - `PRESENCE_TTL_MS = 90_000`. Polling runs at 2.5 s when active and 25 s when idle
    (`packages/protocol/src/cadence.ts:27-30`).
  - `PresenceService.clients()` lists live desktops (`presence.service.ts:277-283`).
  - There is an SSE push channel (`apps/server/src/events/events.controller.ts:80-116`); there
    is no websocket.
- **The mirror.** `TaskMirror` (`apps/server/src/entities/taskMirror.entity.ts:16-46`) stores
  the whole `Task` as JSON keyed by id, with a `rowversion` cursor and `Tombstone` deletes.
  So `status`, `sessionId`, `workedAt`, `agentProjectId`, `assigneeId` and plan steps (rows
  with `parentTaskId`) already reach the server. Two gaps:
  - `task_events` (the transcript) and `task_activity` (comments) are **not** mirrored. The
    web sees them only live (SSE) or by relaying an IPC call to a desktop.
  - Upserts are last-writer-wins, and nothing records which desktop wrote a row.
- **Relay targeting.** `CommandRequest.targetClientId` (`packages/protocol/src/wire.ts:537`)
  points a command at one desktop. A desktop only receives its own commands
  (`mirror.service.ts:168-189`). Commands are leased for `COMMAND_LEASE_MS` = 5 min
  (`mirror/commandQueue.ts:47`). The web picks the target with `resolveTargetClientId`
  (`apps/web/src/board/targetClient.ts:37-50`).
- **Assignees.** `Task.assigneeId`/`reporterId` (`packages/shared/src/model.ts:1237-1239`)
  point at a local-only `Person` (`model.ts:1277`, the `people` table at `store.ts:1710`,
  with `isMe`). There is no server identity. Agent delegation is
  `Task.agentProjectId`/`agentMode`/`agentModel` (`model.ts:1112-1128`).
- **Where a run starts.** All starts funnel into the private `startTask` (`scheduler.ts:3489`):
  - `runTask` (`scheduler.ts:1807`) → `startTaskNow` (`:1837`);
  - `pump` → `startTask`.

  Local guards: `inFlight` (`:1165`, an `already-running` refusal at `:1861`) and the
  `settled` flag on `Run`. Nothing stops a *second desktop*.
- **Comments.** Native comments live in local `task_activity` (`store.ts:1530`) with **no
  author column**. `TaskActivityEntry`'s `comment` variant (`model.ts:1632`) has no author.
  The engine already writes comments anonymously through `store.addComment`:
  - in the scheduler at `scheduler.ts:1533`, `:2255`, `:7064-7109` and `:7370`;
  - in `noteCard` (`:7846`);
  - in `chainRunner.ts` at `:261`, `:311`, `:431` and `:453`.

  There is no server comment table. F19/F22 add the server-authoritative one.
- **No workspace, member or team** entities exist on the server today. One `Account` is one
  user (`apps/server/src/iam/ensureAccount.ts:16`). F19 adds workspaces, members and roles.

## Design

### Data model & contracts

- **Agents are workspace members of kind `agent`.**
  - F19's `members` gains `kind: 'human' | 'agent'`.
  - An agent member is created from an `AgentProfile`: `name`, `model`, `permissionMode`,
    `defaultProjectId`, plus an avatar glyph.
  - It has no login and no email. It cannot be invited, and only admins create it.
  - `AgentProfile` moves from account scope to workspace scope (a migration keyed on the
    publishing account's workspace).
- **Assigning a ticket to an agent** sets `assigneeId` to the agent member id, which is
  synced like any other field. The server then enqueues an `Assignment` (one open row per
  ticket; a unique filtered index on `ticketId WHERE status IN ('queued','claimed','running')`).
  Un-assigning, or re-assigning to a human, cancels the open row. A running row gets a
  stop command to its claimant.
- **Leases.** `Assignment` gains:
  - `leaseExpiresAt`;
  - `heartbeatAt`;
  - `attempt` (incremented by every takeover);
  - `takenOverFrom`;
  - status `stale` (a lease that expired, waiting for takeover);
  - status `cancelled`.

  Constants in `packages/protocol/src/cadence.ts`:
  - `RUN_LEASE_MS = 120_000`;
  - `RUN_HEARTBEAT_MS = 30_000`;
  - `RUN_TAKEOVER_GRACE_MS = 600_000` (ten minutes after expiry before another desktop may
    take a run over).

  Heartbeats ride the existing `/v1/sync` (the `SyncRequest` gains `heartbeats: { assignmentId, runId, phase }[]`).
  There is no extra request.
- **Claim is a conditional update.** One statement:
  `UPDATE assignments SET status='claimed', claimedByClientId=@c, leaseExpiresAt=@t,
  attempt=attempt+1 WHERE id=@id AND (status='queued' OR (status='stale' AND leaseExpiresAt < @now - grace))`.
  The affected row count decides: `1` means the claim is won; `0` means
  `{ refused: 'claimed-elsewhere', by: clientName }`. The read-then-write in
  `AgentsService.claim` goes.
- **Run visibility.** `TaskMirror` already carries the card, so F20 adds one small mirrored
  record per ticket, `RunSummary`:
  - `runnerClientId`, `runnerName`;
  - `phase` (`queued|running|waiting-on-human|parked|reviewing|done|failed`);
  - `stepIndex`/`stepCount`, `currentStep`;
  - `lastEventAt`, `costUsd`;
  - `mrUrl`, `deliveryPhase` (F17).

  It lives on the `Assignment` row (server) and is rebuilt from heartbeats. Transcripts stay
  on the runner and are relayed on demand to that **specific** desktop (`targetClientId =
  runnerClientId`), not "the most recent desktop".
- **Agent identity on comments.** The server comment model from F19/F22 carries:
  - `authorMemberId`;
  - `authorKind: 'human' | 'agent' | 'system'`;
  - `viaClientId`.

  The desktop's engine notes split in two. Timeline *notes* (`noteRun`/`noteCard`) stay local
  run history. Agent *comments* (the hand-back summary, "PR opened", a delivery verdict) go
  out as comments authored by the agent member, `viaClientId` = this desktop. The local
  `task_activity` gains `authorId`/`authorKind` columns (migration).
- **Per-desktop attribution.** Every outbox row the desktop sends already carries `clientId`
  at the batch level. `TaskMirror` gains `lastWrittenByClientId`. Activity (status moves,
  comments, runs) records `viaClientId`, so history can say "moved by Agent Atlas on WOJTEK-PC".

### Engine / desktop main process

- **One claim gate** in `startTask` (`scheduler.ts:3489`). For a ticket in a **cloud
  workspace**, the desktop must hold the claim before a session starts.
  - The pump skips cloud tickets that no live claim of this desktop's covers. The
    `assignmentPoller` is the only way such a ticket enters the queue.
  - Local workspaces are untouched: no claim, exactly as today.
  - Manual "Run" on a cloud ticket claims first, synchronously. A refusal returns as data —
    `ChatSendResult`-style `{ refused: 'claimed-elsewhere', by }` — and parks as an attention
    item if the run came from a chain (memory *a-refusal-that-named-the-wrong-wall*).
- **`assignmentPoller` finishes its job.**
  - It reports `done`/`failed`/`cancelled` on settle.
  - It releases the claim on a refused start (`queued` again, with the refusal recorded).
  - It heartbeats every run it holds.
  - On boot, it re-reads its own claims and either resumes (the run is parked in a gate) or
    releases them.
  - A run parked by the usage limit keeps its lease alive through heartbeats with
    `phase: 'parked'`. A parked run is held, not abandoned.
- **Lost lease.** If a heartbeat answer says the lease was taken over (the desktop was asleep
  past the grace period), the desktop stops the run. It keeps the branch and worktree, notes
  "taken over by <desktop> at <time>", and never pushes again for that assignment. The new
  claimant starts from the ticket's base. The old branch is listed on the ticket so a human
  can salvage it.
- **Steps across desktops.** A plan's steps belong to the card's claim. One desktop runs the
  whole chain. A takeover restarts from the first unfinished step on the new desktop. The
  `done` steps' work exists only if it was pushed, so the takeover note says which.
- **Agent comments** go through a single `postAgentComment(taskId, body, agentMemberId)`
  that writes the local row and enqueues it. The existing anonymous `store.addComment`
  callers in the scheduler and `chainRunner` are classified one by one: run history stays a
  note; team-facing output becomes an agent comment. Grep, because typecheck does not find
  them.

### Server & relay

- `AgentsService`:
  - `claim` becomes the conditional update;
  - new `heartbeat` handling inside `MirrorService.sync`;
  - a sweep on read (the same lazy pattern as presence) turns expired leases to `stale`.
  - All of it is per workspace, and members only see their own workspace's rows.
- Takeover policy (workspace setting): `automatic` (any eligible desktop may claim a stale
  lease after the grace period) or `manual` (an admin presses **Take over**). The default is
  `automatic`.
- Eligibility: a desktop may claim only for projects it serves. The existing
  `assignmentPoller` filter becomes a server-side `clients.servedProjectIds` column sent at
  sync, so the server can tell the team "no online desktop can run this".
- Relay: transcript and diff reads for a ticket target its `runnerClientId`. If that desktop
  is offline, the web shows "runs on WOJTEK-PC, which is offline", not a generic unreachable
  banner.
- `ipcRelay.ts`: new channels `assignment:takeOver` and `assignment:cancel` are `relay`. No
  new credential channels.

### UI — desktop

- **Assignee picker** lists humans, then agents, with the agent glyph. Choosing an agent
  shows which desktops can run it ("2 desktops online serve this project").
- **Ticket row**: the cyan run pill (colour for movement only) with the runner's machine
  name on hover, plus step `2/5`.
- **Ticket detail**: a "Run" block shows:
  - runner, phase, steps, cost, lease freshness ("heartbeat 12 s ago");
  - **Take over** (admins, or anyone after the grace period);
  - **Cancel**.
- **Comments** show the agent's avatar and name, with "via WOJTEK-PC" in faint text.
- **Settings › This machine**:
  - which projects this desktop serves for the workspace;
  - "accept agent work for this workspace" on/off, so a laptop can opt out.

### UI — web

- Same components through `@tm/ui` (memory *web-mirrors-the-desktop*).
- The web reads `RunSummary` from the mirror and so works with **no** desktop reachable.
- Transcript and diff views relay to the runner and say so plainly when it is offline.
- Fleet (`apps/web/src/agents/Fleet.tsx`) becomes the workspace's Agents page: members of
  kind agent, their queue, and the desktops serving them.

### Failure modes & edge cases

- **Clock skew between desktops:** lease times are server clock only. Desktops send
  durations, never timestamps.
- **Server multi-replica:** the presence registry is single-replica (in memory). Leases are
  in SQL and work across replicas. Presence-derived "online" stays approximate, and the
  lease is the authority.
- **Network partition with a run in progress:** the runner keeps working offline. If it comes
  back before `leaseExpiresAt + grace`, it renews and nothing changes. If not, it finds the
  lease taken over and stops (above). The grace period is long enough to cover a laptop lid
  closed over lunch.
- **Same ticket assigned to two agents in quick succession:** the unique open-row index
  keeps one; the second assignment cancels the first.
- **Ticket moved by a human while the agent runs:** the human owns the card's state (memory
  *card-state-is-the-humans*). The run continues, and `preRunStatus` behaves as today.
- **Payload caps:** heartbeats are tiny, and `RunSummary` is capped at 2 kB per ticket, well
  under `SYNC_BYTES_LIMIT`. Transcripts never ride the mirror (memory
  *one-answer-wedges-the-mirror*).
- **Cloud paused:** the cloud is paused since 14 Oct 2026 (memory *cloud-service-paused*).
  All server tasks wait for the resume F19 already requires. Local workspaces keep working
  unchanged.
- **Migrations:** the desktop's `task_activity` columns are verified with the drop-column +
  electron-as-node recipe (memory *the-store-has-no-tests*). Server migrations go through
  the existing TypeORM migration path with an e2e test.

## Out of scope (v1)

- Moving a running session between desktops (live migration). A takeover restarts.
- Cloud-hosted runners. Runs stay on members' desktops.
- Scheduling across desktops by load or cost. The first eligible desktop to claim wins.
- Per-agent usage budgets and billing.

## Open questions

- **Default takeover policy?** Recommended default: **automatic after a 10-minute grace
  period**, with the takeover written on the ticket. Manual-only would leave a team's plan
  stuck behind one sleeping laptop.
- **Should a human be able to "run it here" on a ticket another desktop holds?** Recommended
  default: **only through Take over**, which ends the other claim first. Never two runs.
- **Who may create agent members?** Recommended default: **admins**. Members can assign to
  agents but not create or reconfigure them.
- **Mirror the transcript to the server?** Recommended default: **no** in v1. `RunSummary`
  plus relay-on-demand keeps the mirror small and the code on the runner.

## Tasks

### F20 · Phase 1 — Contracts

- [ ] F20.1 Extend the agent and assignment contracts for leases and agent members

  - In `packages/shared/src/agent.ts` and `packages/protocol`: `MemberKind`, agent member fields, `Assignment` lease fields (`leaseExpiresAt`, `heartbeatAt`, `attempt`, `takenOverFrom`), statuses `stale`/`cancelled`, `RunSummary`, heartbeat entries on `SyncRequest`, `RUN_LEASE_MS`/`RUN_HEARTBEAT_MS`/`RUN_TAKEOVER_GRACE_MS` in `cadence.ts`; replace the "never re-queued" docstring.
  - Acceptance: `pnpm typecheck` green; protocol wire tests round-trip the new fields; a test asserts `RUN_HEARTBEAT_MS * 3 < RUN_LEASE_MS`.
- [ ] F20.2 Write the pure lease state machine @needs: F20.1 Extend the agent and assignment contracts for leases and agent members

  - `leaseStep(assignment, event, now)` in `packages/shared` for claim, heartbeat, expiry, takeover, release, cancel, complete; one source for the server sweep and the desktop's lost-lease check.
  - Acceptance: table-driven tests including a heartbeat after takeover (refused), claim during grace (refused), and cancel of a running row.

### F20 · Phase 2 — Server

- [ ] F20.3 Add agent members and move agent profiles to workspace scope @needs: F20.1 Extend the agent and assignment contracts for leases and agent members

  - `members.kind`, agent member creation (admin only) from an `AgentProfile`, migration of existing account-scoped profiles into the account's workspace.
  - Acceptance: server unit and e2e tests for create/list/delete and role checks; migration test on a seeded database.
- [ ] F20.4 Make assignment claim a conditional update with leases @needs: F20.2 Write the pure lease state machine, F20.3 Add agent members and move agent profiles to workspace scope

  - Rewrite `AgentsService.claim` as one conditional `UPDATE`; the unique open-row index per ticket; lazy expiry sweep to `stale`; `claimed-elsewhere` refusal naming the holder; enqueue/cancel on `assigneeId` changes to/from an agent member.
  - Acceptance: a concurrency test firing two claims at once (exactly one wins); tests for stale takeover after grace and refusal inside it; re-assign cancels.
- [ ] F20.5 Carry heartbeats and run summaries through sync @needs: F20.4 Make assignment claim a conditional update with leases

  - `MirrorService.sync` applies `heartbeats`, renews leases, stores `RunSummary` (2 kB cap) on the assignment, answers lost leases; `clients.servedProjectIds` sent at sync.
  - Acceptance: tests for renew, lost-lease answer, oversized summary rejected with an error rather than stored; `mirror.service` tests stay green.
- [ ] F20.6 Record per-desktop attribution on mirrored rows and comments @needs: F20.5 Carry heartbeats and run summaries through sync

  - `TaskMirror.lastWrittenByClientId`; comment rows carry `authorMemberId`, `authorKind`, `viaClientId`; history entries name the desktop.
  - Acceptance: e2e test that a desktop's status move and an agent comment come back with the right member and client.

### F20 · Phase 3 — Desktop

- [ ] F20.7 Gate every cloud ticket start on a held claim @needs: F20.4 Make assignment claim a conditional update with leases

  - One check in `startTask` (`scheduler.ts:3489`); the pump skips unclaimed cloud tickets; manual Run claims first; refusals come back as data and park when a chain started the run. Local workspaces unchanged.
  - Acceptance: scheduler tests with a fake claim client for won, refused, and local-workspace (no claim); a stub `claude` on PATH (memory *stub-claude-on-path*) shows two simulated desktops never both starting the ticket.
- [ ] F20.8 Finish the assignment poller's lifecycle with heartbeats @needs: F20.7 Gate every cloud ticket start on a held claim, F20.5 Carry heartbeats and run summaries through sync

  - Report done/failed/cancelled on settle, release on refused start, heartbeat held runs (including limit-parked ones), re-read own claims on boot, stop a run whose lease was taken over and note it with the kept branch.
  - Acceptance: tests for each transition; a reboot test; a lost-lease test that the run stops and never pushes again.
- [ ] F20.9 Post agent comments under the agent identity @needs: F20.6 Record per-desktop attribution on mirrored rows and comments

  - `postAgentComment`; `task_activity` gains `authorId`/`authorKind`; classify every anonymous `store.addComment` caller in `scheduler.ts` and `chainRunner.ts` as note or agent comment (grep — typecheck does not find them).
  - Acceptance: migration verified with the drop-column + electron-as-node recipe (memory *the-store-has-no-tests*); tests that a hand-back summary is an agent comment and a retry note stays local.
- [ ] F20.10 Relay transcript and diff reads to the ticket's runner @needs: F20.5 Carry heartbeats and run summaries through sync

  - Web reads for a ticket target `runnerClientId` instead of the preferred desktop; an offline runner answers "runs on <name>, offline"; `assignment:takeOver`/`assignment:cancel` classified `relay` in `ipcRelay.ts`.
  - Acceptance: `test/ipc-relay-coverage.test.ts` passes; `httpTransport` tests for runner targeting and the offline state.

### F20 · Phase 4 — UI

- [ ] F20.11 Add agents to the assignee picker with runnable-desktop hints @needs: F20.3 Add agent members and move agent profiles to workspace scope

  - Humans then agents, agent glyph, "N desktops online serve this project" / "no online desktop can run this".
  - Acceptance: pure picker-state tests; `pnpm build` green; tokens only.
- [ ] F20.12 Show the run block, take over and cancel on the ticket @needs: F20.8 Finish the assignment poller's lifecycle with heartbeats, F20.10 Relay transcript and diff reads to the ticket's runner

  - Run pill with machine name on rows; detail block with runner, phase, steps, cost, heartbeat age, Take over, Cancel; agent comments with "via <machine>"; same components in the web through `@tm/ui`; colour only for the running pill and parks (memory *board-colour-budget*).
  - Acceptance: pure state tests for heartbeat-age wording and button eligibility; headless smoke render (never launch the user's app — memory *verify-electron-app*); web build green.
- [ ] F20.13 Add this machine's served projects and opt-out to settings @needs: F20.8 Finish the assignment poller's lifecycle with heartbeats

  - Per-workspace "accept agent work" switch and served-project list, sent as `servedProjectIds`; the Fleet page becomes the workspace Agents page.
  - Acceptance: tests that an opted-out desktop never claims; web Agents page renders from the mirror with no desktop reachable.

### F20 · Phase 5 — End to end

- [ ] F20.14 Write the two-desktop claim and takeover scenario and docs @needs: F20.12 Show the run block, take over and cancel on the ticket, F20.13 Add this machine's served projects and opt-out to settings, F20.9 Post agent comments under the agent identity

  - `scripts/verify-team-agents.mjs`: a local server, two desktop processes with distinct client ids and stub `claude`; assign one ticket to an agent; assert exactly one run; kill the runner, advance past grace, assert takeover by the other, the old run's note, and the agent-authored comment with the right `viaClientId`. Document in `docs/`.
  - Acceptance: prove the script fails by mutation (drop the conditional `WHERE`; memory *headless-scenario-harness-traps*); `pnpm typecheck`, `pnpm test`, `pnpm build` green with `--force` (memory *a-cached-gate-is-not-a-gate*).
