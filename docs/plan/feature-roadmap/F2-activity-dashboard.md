# F2 — Activity dashboard

> **Status:** proposed · **Where:** client (desktop) + web (over the relay) — no server change · **Depends on:** nothing hard; soft on F1 (trigger-started runs carry an `origin`) · **Unlocks:** F3 (the mobile cockpit's home screen), F1's "recent outcomes" rail
> Only the `- [ ]` checkboxes under **Tasks** become cards when this file is imported as a plan; everything else is context.

## Why

You come back after a night of chains, auto-releases and (with F1) triggers, and there is no single
place that answers **"what happened while I was away?"**. Today the answer is scattered across
every card's own timeline, the Attention inbox and the Performance tab's 5-hour token window. Two
things make that worse than "inconvenient":

- **A merge is invisible** (memory `a-merge-is-invisible`): nothing on the task changes while it
  merges, and merge/release notes are written as plain `assistant` events nobody streams. A board
  glance cannot tell "merged overnight" from "never touched".
- **The CLI's own verdict lies** (memory `headless-turn-has-no-next-turn`): a run can report
  `success: true` having done nothing. A feed that trusted the CLI would show green for a dead run.

So F2 is a cross-board, chronological **activity log** recorded by the engine at the moments it
already knows the truth, plus a dashboard that reads it: outcome tiles, a "needs you" queue, a
feed with a "since you were away" divider, and daily cost/token trends.

## What we have today

- `task_events` (`apps/client/src/main/store.ts:1095`) — every CLI event of every run as a JSON blob
  (`started`, `result`, `exited`, … in `packages/shared/src/session.ts`). Complete but huge: scanning
  transcripts board-wide for a feed is the wrong query.
- `task_activity` (`store.ts:1104`) — human comments and status changes per card.
- `token_usage` (`store.ts:1120`, indexed on `createdAt` and `projectId, createdAt`) behind
  `usage:summary` (`packages/shared/src/ipc.ts:806`) and the Performance screen
  (`packages/ui/src/Performance.tsx`) — a rolling 5-hour window, not a daily history.
- Attention inbox — `packages/shared/src/attention.ts`, `attention:list` (relayed).
- Gate parks/resumes in `apps/client/src/main/scheduler.ts`: `parkForLimit` (:5690),
  `parkForSignIn` (:5719), `resumeParked` (:3970), `resumeAfterSignIn` (:4114); refusal vocabulary
  in `packages/shared/src/scheduler.ts`.
- Merges: `beginIntegration`/`endIntegration` (`scheduler.ts:1416`/`:1423`), notes via `noteRun`
  (`scheduler.ts:6296`) as `{ kind: 'assistant' }` — indistinguishable from agent prose.
- Per-card timeline state machine with a stale-answer guard: `packages/ui/src/taskTimeline.ts` —
  the pattern to copy for a testable feed without a DOM harness.
- Shells: desktop tabs `apps/client/src/renderer/src/App.tsx:108`, web screens
  `apps/web/src/App.tsx:107`; shared screens live in `@tm/ui` (memory `web-mirrors-the-desktop`).
- Relay: exhaustive `RELAY_POLICY` in `packages/shared/src/ipcRelay.ts`; event classes in
  `packages/shared/src/ipcEventFanout.ts`; SSE at `apps/server/src/events/`.

## Design

### Data model & contracts

A new **append-only `activity_log` table** in the desktop store, written at engine milestones —
not derived from `task_events` at read time (too big, and merges are not distinguishable there).

```
activity_log(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,            -- epoch ms, desktop clock
  projectId TEXT, taskId TEXT, runId TEXT,   -- nullable, NO foreign keys (like token_usage)
  kind TEXT NOT NULL,             -- ActivityKind
  outcome TEXT,                   -- ActivityOutcome, run-finished only
  origin TEXT,                    -- ActivityOrigin
  title TEXT NOT NULL,            -- card title SNAPSHOT, so a deleted card still reads
  costUsd REAL,                   -- null = unknown, never 0
  detail TEXT                     -- small JSON: reason, branch, version, from/to column, backfilled
)
indexes: (at, id), (projectId, at), (kind, at)
partial UNIQUE (runId, kind) WHERE kind IN ('run-started','run-finished')
```

No FKs on purpose, for the reason `token_usage` already states: this is a record of what
happened, and must survive a plan re-sync and a project delete.

`packages/shared/src/activity.ts` (pure):

- `ActivityKind` — `run-started`, `run-finished`, `parked`, `resumed`, `plan-presented`,
  `question-raised`, `merge-landed`, `merge-conflict`, `merge-failed`, `release-published`,
  `status-moved`, and `trigger-fired` (reserved for F1).
- `ActivityOutcome` — `done | failed | stopped | empty | needs-input` (`empty` = the engine's
  `describeEmptyOutcome` verdict; counted as failed in tiles).
- `ActivityOrigin` — `human | chain | auto-release | resume | trigger:<id>`.
- `ActivityQuery { sinceMs, untilMs?, projectIds?, kinds?, outcomes?, origins?, cursor?, limit }`
  and `ActivityPage { rows, nextCursor }` — **keyset** paging on `(at, id)` descending, so rows
  arriving at the top never shift a later page — no snapshot ids, no stale-page errors.
- `summarizeOutcomes(rows)` → tile counts per project; `encodeCursor`/`decodeCursor`.
- `bucketUsageDaily(samples, { days, tzOffsetMinutes, now })` in `packages/shared/src/usage.ts` —
  zero-filled daily `{ costUsd, inputTokens, outputTokens, cacheReadTokens }`. The **viewer** passes
  its offset, because a browser may sit in a different zone from the desktop.

### Engine / sync

- `apps/client/src/main/activityRecorder.ts` — a thin wrapper over `store.appendActivity` that also
  emits `activity:appended`. **It never throws into the engine**: activity is observability, and a
  lost row must never fail a run (try/catch + `logMain`).
- Call sites: run spawn (`run-started`), the settle path in the scheduler's `result`/exit handling
  (`run-finished`, outcome from the engine's classification), `parkForLimit`/`parkForSignIn`
  (`parked`), `resumeParked`/`resumeAfterSignIn` (`resumed`, one row per task), attention raise for
  `plan-approval`/`agent-question` (`plan-presented`/`question-raised`), the integrate result inside
  `endIntegration`'s callers (`merge-*`), auto-release publish (`release-published`), and the
  `task:move`/`task:setStatus` handlers in `ipc.ts` (`status-moved`, origin `human`).
- **Origin plumbing**: the internal run-start options gain an optional `origin`, default `human`;
  the chain runner passes `chain`, gate resumes pass `resume`, auto-release passes `auto-release`,
  and F1 will pass `trigger:<id>`. F2 is buildable before F1 — the field simply never holds a trigger.
- **Idempotence**: CLI event order is unreliable (memory `settled-run-resurrection-trap`), so
  `run-started`/`run-finished` insert with `INSERT OR IGNORE` against the partial unique index.
- **Backfill**: a one-shot on first boot after the migration, guarded by an `app_state` key —
  derive `run-started`/`run-finished` from the last 30 days of `task_events` (`json_extract` on
  `started`/`result`) and `status-moved` from `task_activity`, each with `detail.backfilled = true`.
  Merges cannot be backfilled (their notes are prose); the feed says "history before <date> is
  partial".
- **Retention**: prune rows older than 90 days at startup.
- **Running now / needs you** are **not** read from the log: running comes from the scheduler's
  live set, needs-you from the attention list — the log is history, not state.

### Server

None — the feed is desktop-sourced and reaches the web through the existing relay
(`ipc-invoke {channel, args}`) exactly like `usage:summary`; nothing new persists server-side.
`activity:appended` is classified `'drop'` in the event fan-out, and the web polls `activity:list`
on the board cadence — keeping the stream's "may drop at any time" assumption (see
`packages/protocol/src/cadence.ts`). Consequence: the web dashboard needs a reachable desktop,
the same as Performance today.

### UI — desktop

A new **Activity** tab, built once as `packages/ui/src/activity/ActivityScreen.tsx` (Fluent UI v9,
real Fluent icons; colour only for things that move — memory `board-colour-budget`):

- **Tiles row** — Running now · Needs you · Completed · Failed, with a 24h / 7d / 30d period.
  Clicking a tile filters the feed (no separate drill-down sheet in v1).
- **Feed** (main column) — grouped by day; row = kind icon, card title, project chip, origin chip
  (You / Chain / Resume / Trigger), relative time, cost; click opens the card's detail pane, or
  "This card no longer exists" for a deleted one. A **"New since you were away"** divider, and an
  "N new" pill instead of shifting rows while you are scrolled down.
- **Right rail** — the needs-you queue (attention items, "All caught up" when empty) and a daily
  trend chart (cost / input / output toggle) in the Performance chart's visual language.
- **Filters** — project, kind group (Runs · Merges · Gates · Moves), outcome, origin.
- Feed behaviour lives in a pure state machine, `packages/ui/src/activity/feedState.ts`
  (merge pages, dedupe by id, stage new rows while scrolled, away divider, stale-answer guard),
  because this repo has no DOM harness.
- "Last seen" for the divider and the tab's unread badge: an `app_state` key on the desktop.

### UI — web

The same `ActivityScreen`, mounted as a screen in `apps/web/src/App.tsx`, over the relayed
transport. Desktop unreachable → the existing `UnreachableBanner`, no stale cache. "Last seen" is
stored as the newest **desktop** row `(at, id)` the viewer saw (localStorage, wrapped in try/catch)
— never the browser's own clock, so clock skew cannot misplace the divider. Below ~720px the
layout collapses to one column (tiles → queue → feed); full mobile treatment is F3.

### Failure modes & edge cases

- Recorder fails → swallowed and logged; the run is unaffected.
- `result` arrives twice, or `system/init` after `result` → one `run-finished` per `runId`.
- A park followed 13ms later by its own failing result (memory
  `a-park-settled-over-by-its-own-result`) → both rows are true and both show; tiles count each
  run's final outcome only.
- A run the CLI calls a success that did nothing → outcome `empty`, counted as failed.
- Deleted card → title snapshot keeps the row readable.
- Unknown cost → "—", never `$0.00`.
- Very long history → keyset pages of 50; 90-day retention bounds the table.
- Web with no live desktop → banner, no partial render.

## Out of scope (v1)

CSV export, presentation mode, drill-down sheets, server-side persistence for desktop-offline
viewing, per-backend stats (one backend today), clustering of failure reasons, human comments in
the feed.

## Open questions

1. **Should Activity become the landing tab?** Default: no — a separate tab with an unread badge.
2. **Persist the log server-side so the web works with the desktop asleep?** Default: not in v1;
   revisit with F3, where it matters most.
3. **Retention?** Default 90 days, a constant, not a setting.
4. **Human comments and status notes in the feed?** Default: column moves yes, comments no (noise).
5. **Backfill window?** Default 30 days.

## Tasks

### F2 · Phase 1 — Contracts and pure logic

- [ ] F2.1 Define the activity vocabulary and query contract in the shared package

  - New `packages/shared/src/activity.ts`: `ActivityKind`, `ActivityOutcome`, `ActivityOrigin`,
    `ActivityRow`, `ActivityQuery`, `ActivityPage`, `encodeCursor`/`decodeCursor`,
    `summarizeOutcomes`.
  - Acceptance: `activity.test.ts` covers cursor round-trip, a malformed cursor rejected, and tile
    counts where `empty` counts as failed and only a run's final outcome counts; `pnpm typecheck`
    and `pnpm test` green.
- [ ] F2.2 Add zero-filled daily usage bucketing for the trend chart

  - `bucketUsageDaily` in `packages/shared/src/usage.ts`, taking the viewer's `tzOffsetMinutes`.
  - Acceptance: tests for empty days zero-filled, samples on either side of local midnight landing
    in the right day, and null cost kept distinct from zero.
- [ ] F2.3 Build the feed list state machine with staging and the away divider @needs: F2.1 Define the activity vocabulary and query contract in the shared package

  - New `packages/ui/src/activity/feedState.ts`, modelled on `packages/ui/src/taskTimeline.ts`.
  - Acceptance: tests for page merge + dedupe by id, new rows staged (count only) while scrolled
    and applied on "show", divider placed by desktop `(at, id)`, and an older load seq ignored.

### F2 · Phase 2 — Store and engine

- [ ] F2.4 Add the activity_log table with append and keyset queries to the store @needs: F2.1 Define the activity vocabulary and query contract in the shared package

  - `store.ts`: table + indexes + partial unique index; `appendActivity` (INSERT OR IGNORE),
    `listActivity(query)`, `countOutcomes(sinceMs)`, `pruneActivity(beforeMs)`.
  - Acceptance: the store has no tests (memory `the-store-has-no-tests`), so add
    `apps/client/scripts/verify-activity-store.mjs` per that recipe (esbuild bundle,
    `ELECTRON_RUN_AS_NODE=1`, scratch DB in `os.tmpdir()`): duplicate `run-finished` ignored, keyset
    pages stable under concurrent inserts, prune removes only old rows, and a pre-existing DB
    without the table upgrades cleanly. Exits 0; shown to fail when the unique index is removed.
- [ ] F2.5 Backfill thirty days of runs and column moves into the activity log @needs: F2.4 Add the activity_log table with append and keyset queries to the store

  - One-shot guarded by an `app_state` key; rows flagged `detail.backfilled`.
  - Acceptance: extend the verify script — seeded `task_events`/`task_activity` produce the
    expected rows; a second boot inserts nothing; events older than 30 days are skipped.
- [ ] F2.6 Record run starts and outcomes from the scheduler with their origin @needs: F2.4 Add the activity_log table with append and keyset queries to the store

  - New `apps/client/src/main/activityRecorder.ts`; hooks at spawn and settle in `scheduler.ts`;
    optional `origin` on run-start options (human / chain / resume / auto-release).
  - Acceptance: `scheduler.test.ts` cases — one `run-finished` even when `result` arrives twice; an
    empty run recorded as `empty`; a chain step recorded with origin `chain`; a recorder that
    throws does not fail the run.
- [ ] F2.7 Record gate parks and resumes plus attention and merge and release events @needs: F2.6 Record run starts and outcomes from the scheduler with their origin

  - Hooks in `parkForLimit`, `parkForSignIn`, `resumeParked`, `resumeAfterSignIn`, attention raise,
    the integrate result paths around `endIntegration`, and auto-release publish.
  - Acceptance: scheduler tests for a limit park → resume pair, a merge conflict row, and a landed
    merge row carrying the branch in `detail`.
- [ ] F2.8 Record human column moves from the move and set-status handlers @needs: F2.4 Add the activity_log table with append and keyset queries to the store

  - A pure `toMoveActivity(task, from, to)` helper called from `task:move`/`task:setStatus` in
    `ipc.ts` (which has no test file), recording only after the tracker transition succeeds.
  - Acceptance: unit tests on the helper; a rolled-back move records nothing.

### F2 · Phase 3 — IPC and relay

- [ ] F2.9 Expose activity list and overview and daily usage over IPC and the relay @needs: F2.4 Add the activity_log table with append and keyset queries to the store, F2.2 Add zero-filled daily usage bucketing for the trend chart

  - `packages/shared/src/ipc.ts`: `activity:list(query)`, `activity:overview(period)` (running from
    the live set, needs-you from attention, outcomes from the log), `usage:daily(opts)`; event
    `activity:appended`. Classify in `ipcRelay.ts` (`relay`) and `ipcEventFanout.ts` (`drop`).
  - Acceptance: `test/ipc-relay-coverage.test.ts` and the relay/fanout tests pass; `pnpm typecheck`
    proves the exhaustive records are complete.

### F2 · Phase 4 — Desktop UI

- [ ] F2.10 Build the outcome tiles with the period picker @needs: F2.9 Expose activity list and overview and daily usage over IPC and the relay

  - `packages/ui/src/activity/OutcomeTiles.tsx`; clicking a tile sets the feed filter.
  - Acceptance: tile→filter mapping is a pure function with tests; typecheck/build green.
- [ ] F2.11 Build the activity feed with filters and the since-you-were-away divider @needs: F2.3 Build the feed list state machine with staging and the away divider, F2.9 Expose activity list and overview and daily usage over IPC and the relay

  - `packages/ui/src/activity/ActivityFeed.tsx` driven by `feedState`; opening a row opens the card.
  - Acceptance: filter→query mapping tested; deleted-card row handled; build green.
- [ ] F2.12 Build the needs-you rail and the daily trend chart @needs: F2.9 Expose activity list and overview and daily usage over IPC and the relay

  - Reuse the attention list rendering; chart in the `TokenChart` visual language.
  - Acceptance: "All caught up" empty state; chart series comes from `usage:daily`; build green.
- [ ] F2.13 Add the Activity tab to the desktop shell with an unread badge @needs: F2.10 Build the outcome tiles with the period picker, F2.11 Build the activity feed with filters and the since-you-were-away divider, F2.12 Build the needs-you rail and the daily trend chart

  - `ActivityScreen.tsx` composing the three; new `TabId` in `apps/client/src/renderer/src/App.tsx`;
    last-seen in `app_state`.
  - Acceptance: `test/shell-parity.test.ts` green; badge count is a tested pure function. A human
    visual check is owed — never launch the app from an agent (memory `verify-electron-app`).

### F2 · Phase 5 — Web and verification

- [ ] F2.14 Mount the Activity screen in the web app over the relay @needs: F2.13 Add the Activity tab to the desktop shell with an unread badge

  - New screen in `apps/web/src/App.tsx`; unreachable banner when no desktop; web last-seen stored
    as a desktop `(at, id)` in guarded localStorage.
  - Acceptance: shell-parity green; `verify-remote-ipc.mjs` (or a sibling) invokes `activity:list`
    through the relay and gets rows.
- [ ] F2.15 Collapse the Activity screen to one column at narrow widths @needs: F2.14 Mount the Activity screen in the web app over the relay

  - Breakpoint layout in the shared screen; same order on both hosts.
  - Acceptance: build green; screenshot check owed to a human.
- [ ] F2.16 Verify the activity log end to end with a stub claude and document it @needs: F2.15 Collapse the Activity screen to one column at narrow widths

  - Drive a chain with the stub CLI (memory `stub-claude-on-path`) and assert the rows; add a
    "The activity log" section to `docs/03-how-orchestration-works.md`.
  - Acceptance: the scenario script exits 0 and fails when a recorder hook is removed;
    `pnpm typecheck`, `pnpm test`, `pnpm build` green.
