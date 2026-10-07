# F1 — Automation triggers + calendar

> **Status:** proposed · **Where:** client + server + web · **Depends on:** — · **Unlocks:** F2
> Only the `- [ ]` checkboxes under **Tasks** become cards when this file is imported as a plan; everything else is context.
>
> **Layout rule for this file:** every task's description bullets sit after a **blank line**. The plan
> parser folds any indented line that directly follows a checkbox into that task's *title*
> (`apps/client/src/main/planParser.ts:173-177`); the blank line is what keeps descriptions out of it.

## Why

Today every agent run starts because a human pressed something. The engine can already park work
behind a usage limit or a sign-in and resume it unattended, chains advance on their own, and the
release engine can merge and ship — but nothing *begins* without you. F1 adds the missing first
domino: a run that starts because a clock said so ("every weekday at 04:00, triage the new tickets")
or because a tracker did ("whenever a ticket labelled `agent` lands in *To Do*, work it"). It is the
feature that turns "autonomous once started" into "autonomous while you are away", and every later
visibility feature (F2's feed) is mostly a window onto what F1 did unattended.

## What we have today

- **The one place a run starts:** `Scheduler.startTaskNow(taskId)` (`apps/client/src/main/scheduler.ts:1562`)
  returns a `RunOutcome` — a `runId`, or a `RunRefusal`. It resolves a card's waiting step first
  (`nextRunnableStep`, `:1610`) and asks the gates **last**; a limit or a dead sign-in **parks** the
  start (`parkForLimit` / `parkForSignIn`) so it resumes by itself. `isParkedRefusal` /
  `RUN_REFUSAL_MESSAGE` live in `packages/shared/src/scheduler.ts:63-154`. An automation must launch
  through this — never around it — or it loses the park/resume guarantees
  (memory: *limit-gate-is-the-only-memory*, *a-park-settled-over-by-its-own-result*).
- **`scheduler.ts` is a queue runner, not a clock.** `start(projectId)` (`:1429`) pumps a project's
  `pending` cards; nothing in the app fires on time.
- **Creating + delegating a card:** `task:create` (`packages/shared/src/ipc.ts:498`, store
  `createTask` at `apps/client/src/main/store.ts:462`), then `task:assignAgent` (`ipc.ts:675`) with
  `AssignAgentInput` (`packages/shared/src/model.ts:1314`: `agentProjectId`, `mode`, `model`,
  `planningModel`, `notes`, **`start`**). Per-card `autoIntegrate` / `autoCreatePr` / `autoRelease`
  via `task:setAgentOptions` (`ipc.ts:605`).
- **Tracker sync already diffs the board.** `SyncPoller` (`apps/client/src/main/syncPoller.ts`) sweeps
  every integration on one interval. JIRA: `reconcileJiraTasks(personalForSync, issues, …)`
  (`apps/client/src/main/ipc.ts:3329`) → `{ upserts, removals, refused, warning }`
  (`jira/jiraSync.ts:178`). GitHub issues: `reconcileGitHubIssues` (`ipc.ts:3523`,
  `github/githubIssueSync.ts:134`). `Task` carries `source` (`'plan'|'adhoc'|'jira'|'github'|'ticket'`),
  `externalKey`, `externalStatus`, `labels` (`model.ts:615-1116`). So "a ticket appeared / entered a
  status / got a label" is a **before/after diff of the cards the sync is already writing** — no second
  poller, no extra API traffic.
- **GitLab sync is merge requests only** (`gitlab/gitlabSync.ts`); there is no `gitlab` card source.
- **The app quits when its window closes** on Windows/Linux (`apps/client/src/main/index.ts:262`).
  Today "offline" automation would therefore require the window to stay open.
- **Wake/sleep is observable:** `powerMonitor` `suspend`/`resume` is already wired in
  `apps/client/src/main/focusTracker.ts:32-35`.
- **Store migrations have no automated tests** (memory: *the-store-has-no-tests*); the worked
  verification recipe is `scripts/verify-resume-migration.mjs` (esbuild bundle of `store.ts`, run
  under `ELECTRON_RUN_AS_NODE=1`, scratch DB in `os.tmpdir()`).
- **Cloud:** the server mirrors tasks/projects via `SyncRequest.deltas: MirrorDelta`
  (`packages/protocol/src/wire.ts:26`, `PROTOCOL_VERSION = 2` at `:47`); web mutations travel as an
  `ipc-invoke` relay governed by the exhaustive `RELAY_POLICY` in `packages/shared/src/ipcRelay.ts`
  (`task:run`, `task:create`, `settings:save` are `'relay'`), guarded by
  `test/ipc-relay-coverage.test.ts`. Global vs local settings are whitelisted by
  `GLOBAL_SETTINGS_KEYS` (`packages/shared/src/settings.ts:747`).
- **Shell:** desktop nav tabs `NAV` in `apps/client/src/renderer/src/App.tsx:111`; web `NAV` in
  `apps/web/src/App.tsx:94`; shared shell in `packages/ui/src/shell/`; parity enforced by
  `test/shell-parity.test.ts` (memory: *web-mirrors-the-desktop*).

## Design

### The offline question, answered first

**The desktop is the only executor.** The server mirrors and relays; it has no repository and cannot
run `claude`. So automations are **evaluated on the desktop that owns them**, and "fires while you are
offline" honestly means *while you are away from the app*, not *while the app is closed*:

1. **App running (window closed or not):** fires on time. F1 adds an opt-in *keep running in the
   background* mode (tray) so closing the window no longer kills the clock.
2. **Machine asleep / app closed:** nothing can fire. On wake or next boot the **age rule** decides:
   within the grace window → `scheduled`; late by ≤ 24 h → the **latest** missed occurrence fires once
   as `catch-up` and the log records how many were skipped; older → nothing fires, the log says so.
3. **Tracker triggers while closed:** the first sync after boot diffs the stored cards against the
   tracker, so a transition that happened while the app was closed is still observed — once, as a
   single before→after change (intermediate hops are not replayed). It fires then, subject to the
   same receipts.

The server **never** evaluates schedules in v1: a server-side clock could only enqueue a command for a
desktop that, by definition, is not there to run it — it would add a second source of truth for
`nextRunAt` and buy nothing. The web says this plainly (*"Runs fire on <desktop>; last seen …"*).

**Ownership:** each automation records `ownerClientId` (the desktop that created it). Only the owner
evaluates and fires it; another desktop on the same account shows it read-only. This is what prevents
two desktops double-firing, and it is why web edits relay to the owner.

### Data model & contracts

`packages/shared/src/automation.ts` (new):

```ts
type ScheduleShape =
  | { type: 'daily' | 'weekdays'; hour: number; minute: number }
  | { type: 'weekly'; day: 1|2|3|4|5|6|7; hour: number; minute: number }
  | { type: 'hours'; every: 1|2|3|4|6|8|12 };

type TrackerEventKind = 'appeared' | 'entered-status' | 'labeled';
interface TrackerTrigger {
  source: 'jira' | 'github';
  event: TrackerEventKind;
  status?: string;                    // entered-status: matches externalStatus, case-insensitive
  label?: string;                     // labeled: the label that was added
  anyLabels?: string[]; allLabels?: string[]; excludeLabels?: string[];
}

interface AutomationAction {
  /** schedule: create a card on this board. tracker: ignored — the ticket's own card is worked. */
  boardProjectId?: string;
  agentProjectId: string;
  titleTemplate: string;              // schedule only; e.g. "Nightly triage — {{date}}"
  briefTemplate: string;              // prepended to the card brief / notes
  mode: PermissionMode;               // see failure modes: 'manual' is refused for unattended runs
  model?: ClaudeModel; planningModel?: ClaudeModel;
  autoCreatePr?: boolean | null; autoIntegrate?: boolean | null;
}

interface Automation {
  id: string; revision: number; name: string; enabled: boolean;
  ownerClientId: string | null;       // null = this desktop, before it ever synced
  timeZone: string;                   // IANA, captured at creation; shown in the editor
  trigger: { kind: 'schedule'; schedule: ScheduleShape } | { kind: 'tracker'; tracker: TrackerTrigger };
  action: AutomationAction;
  enabledAt: number | null;           // the baseline: tracker events before this are ignored
  nextRunAt: number | null;           // schedule only; null = recompute
  consecutiveFailures: number;
  createdAt: number; updatedAt: number;
}

type FiringKind = 'scheduled' | 'catch-up' | 'manual' | 'tracker';
type AutomationRunStatus =
  | 'reserved' | 'started' | 'parked' | 'refused' | 'skipped' | 'duplicate' | 'error';
interface AutomationRun {
  id: string; automationId: string; revision: number;
  occurrenceKey: string;              // 'schedule:<iso>' | 'tracker:<taskId>:<event>:<value>' | 'manual:<uuid>'
  kind: FiringKind; status: AutomationRunStatus;
  taskId: string | null; runId: string | null;
  refusal: RunRefusal | null; skippedCount: number; note: string | null;
  at: number;
}
```

- `validateAutomation(a): string[]` — every rule the editor and the IPC handler both enforce.
- New `Task.originAutomationId?: string | null` so a card can say what started it.
- IPC (`packages/shared/src/ipc.ts`): `automation:list`, `automation:save`, `automation:delete`,
  `automation:setEnabled`, `automation:runNow`, `automation:runs(automationId | null, limit)`; event
  `automations:changed`. `RELAY_POLICY`: reads and writes `'relay'` (the web reads the mirror directly,
  see below).

### Engine

Three pure modules in `packages/shared` and three thin wiring modules in `apps/client/src/main`:

- **`automationSchedule.ts` (pure)** — `nextOccurrence(shape, afterMs, tz)`,
  `occurrencesBetween(shape, fromMs, toMs, tz)`, `scheduleLabel(shape)`, `cronOf(shape)` (display
  only). Wall-time ↔ UTC through `Intl.DateTimeFormat` with the automation's `timeZone`. DST rule:
  a wall time that does not exist (spring-forward gap) fires at the first instant after the gap; a
  wall time that occurs twice (fall-back) fires once, at the first.
- **`automationFire.ts` (pure)** — `decideFire({ due, now, shape, tz, graceMs = 10 min,
  catchUpMs = 24 h })` → `{ kind: 'scheduled'|'catch-up'|'skip', occurrenceAt, skippedCount,
  nextRunAt }`; `nextRunAt` always computed from `max(occurrenceAt, now)`.
- **`automationTracker.ts` (pure)** — `detectTrackerEvents(before: Task[], after: Task[])` →
  `appeared` (key not in `before`), `entered-status` (`externalStatus` changed), `labeled` (label in
  `after` not in `before`); `matchesTrackerTrigger(event, trigger, enabledAt)`;
  `trackerReceiptKey(event)`.
- **`automationTemplate.ts` (pure)** — `{{date}}`, `{{time}}`, `{{automation.name}}`,
  `{{ticket.key}}`, `{{ticket.title}}`, `{{ticket.url}}`; unknown variables stay visible verbatim.
- **`automationRunner.ts`** — `fire(automation, firing)`:
  1. `reserveAutomationRun` (`INSERT … ON CONFLICT DO NOTHING` on `(automationId, occurrenceKey)`) —
     a duplicate logs `duplicate` and stops;
  2. **no overlap:** if this automation's last `started` card is still in flight, log `skipped`
     ("previous run still working");
  3. schedule: `createTask` on `boardProjectId` with rendered title/brief and
     `originAutomationId`; tracker: the ticket's own card;
  4. delegate with the same code path as `task:assignAgent` (no `start`), apply card options, add a
     timeline note *"Started by automation ‹name› (catch-up for 04:00, 2 skipped)"*;
  5. `scheduler.startTaskNow(taskId)` and map the outcome: `runId` → `started`;
     `isParkedRefusal` → `parked` (**not** a failure — the gate owns it now); any other refusal →
     `refused`, `consecutiveFailures++`, and at 3 the automation is disabled and an Attention item is
     raised. A `started` resets the counter.
  Card state stays the human's (memory: *card-state-is-the-humans*): the runner never writes
  `status`; the run borrows it like any other run.
- **`automationClock.ts`** — one `setTimeout` to the earliest `nextRunAt` of enabled schedule
  automations, **capped at 60 s** (guards the 32-bit `setTimeout` overflow `syncPoller.ts` documents,
  and clock jumps); on fire → `decideFire` → runner. Re-evaluates on `powerMonitor` `resume`, on
  `automations:changed`, and once at boot **after** `restoreLimitGate`/`restoreAuthGate` so a
  catch-up launched at boot parks correctly. Saving a changed schedule clears `nextRunAt`. Registered
  in the shutdown list next to `syncPoller` (`index.ts:237`).
- **Tracker hook** — after each `reconcileJiraTasks` / `reconcileGitHubIssues`, the glue calls
  `detectTrackerEvents(personalForSync, upserts)` and fires matching enabled automations. Errors in
  the runner are caught and logged; they never fail the sync, and a sync failure fires nothing.
- **Background mode** — local setting `runInBackground` (default off): `window-all-closed` hides to a
  tray (Open / Pause automations / Quit) instead of quitting. Enabling the first automation offers to
  turn it on. Where a tray is unavailable (some Linux/WSLg sessions) the window minimizes instead.

### Server & sync

- **Mirror, not authority.** `MirrorDelta` gains `automations: Automation[]`,
  `automationRuns: AutomationRun[]`, `deletedAutomationIds: string[]`; `PROTOCOL_VERSION` → 3 (the
  existing skew banner covers mixed versions). Runs are **capped** on the wire (only runs since the
  last acked cursor, ≤ 200 per request) — memory *one-answer-wedges-the-mirror*: an uncapped array
  wedged sync for a day.
- **Server** (`apps/server`): entities `automationMirror` (`accountId`, `clientId`, `id`, `data`
  JSON, `updatedAt`) and `automationRunMirror` (keeps the newest 100 per automation, 30 days);
  migration `1792000000000-AutomationMirrors`; `MirrorService.sync()` applies them;
  `GET /v1/automations` and `GET /v1/automations/:id/runs` for the web.
- **Web edits relay** to the automation's `ownerClientId` through the existing `ipc-invoke` relay; the
  desktop refuses (clear message) an edit for an automation it does not own.

### UI — desktop

New **Automations** tab in `NAV` (`App.tsx:111`, icon `FlashRegular`). Components live in
`packages/ui/src/automations/` and are host-free so the web renders the same ones.

- **List** — name, trigger label (`weekdays at 04:00 · Europe/Warsaw` / `Jira · entered "To Do" ·
  label agent`), next run, last outcome chip, enable switch, *Run now*, edit, delete.
- **Week calendar** — 7 columns × hours; schedule occurrences from `occurrencesBetween`, past cells
  show the recorded outcome, tracker automations listed in a side strip (they have no clock).
  Layout is a pure function so it is unit-tested without a DOM.
- **Next runs rail** — the next 10 firings across all automations.
- **Run log drawer** per automation — status, kind, card link, refusal sentence
  (`RUN_REFUSAL_MESSAGE`), skipped count.
- **Editor dialog** — name; trigger (schedule shape picker with time-zone line / tracker source,
  event, status, labels); action (board, agent project, `ModelField`, `PlanningModelField`, mode,
  PR-vs-merge); title/brief templates with live rendered preview; "next 5 runs" preview from the same
  math the clock uses; validation from `validateAutomation`.
- **Template palette** — starter automations (see F1.16).
- **Board** — a card with `originAutomationId` shows a small monochrome flash glyph + tooltip.
  Colour budget (memory *board-colour-budget*): colour only for things that move — running /
  failed / parked chips; static facts monochrome; real Fluent icons.

### UI — web

Same Automations tab in `apps/web/src/App.tsx:94` from the shared components, fed by
`GET /v1/automations`; edits/run-now/enable relay to the owner desktop. A banner names the owning
desktop and its last-seen time, and when it is not live says *"Changes are queued; nothing fires
until ‹desktop› is running."* Shell parity per `test/shell-parity.test.ts`.

### Failure modes & edge cases

| Situation | Behaviour |
|---|---|
| Usage limit or signed out at fire time | `startTaskNow` parks it; run logged `parked`; resumes with the gate; not a strike |
| Card has no agent project / board deleted | `refused` + strike; 3 strikes → auto-disable + Attention item |
| Previous run of the same automation still working | `skipped` — no overlap, no strike |
| Timer re-armed / app restarted mid-fire | receipt `UNIQUE(automationId, occurrenceKey)` → `duplicate` |
| Crash between reserve and start | a `reserved` receipt older than 5 min is shown as `error` with *Retry* (fires the same key) |
| Laptop slept 3 days, daily schedule | one `catch-up`, `skippedCount = 2` |
| DST gap / overlap | fire after the gap / fire once on the first occurrence |
| `mode: 'manual'` on an unattended run | rejected by `validateAutomation` — a headless run cannot answer a permission prompt (memory *a-headless-turn-has-no-next-turn*); editor explains |
| Tracker sync truncated / failed | no events from that sweep (only the confirmed `upserts` are diffed) |
| Ticket re-enters the status later | does **not** refire (receipt per card per event value); open question below |
| Two desktops on one account | only `ownerClientId` evaluates; others read-only |
| Automation edited while a firing is in flight | firing keeps its `revision`; the next uses the new one |

## Out of scope (v1)

- Cron expressions as input (derived display only); minute-level intervals below 1 h.
- Server-side evaluation or execution; failover of an automation to another desktop.
- GitLab triggers (no GitLab card source yet), PR/MR review-requested events, Linear (F4).
- Selecting a workflow/skill per automation (F7/F8), variants, model dispatch per automation.
- Keeping the OS awake (`powerSaveBlocker`) — the age rule covers sleep honestly instead.
- An analytics/stat strip beyond last outcome + counts (F2 owns trends).

## Open questions

1. **Tracker action: work the ticket's own card, or create a new card?** → *Default: work the
   ticket's own card* (it is already on the board; a second card would split its history).
2. **Refire when a ticket re-enters the status?** → *Default: no — once per card per automation;*
   a *"fire every time"* switch can follow.
3. **Unattended runs: open a PR or merge?** → *Default: `autoCreatePr = true` for automation cards*,
   so a human reviews in the morning; the editor can switch to the project's preference.
4. **Catch-up window and grace** → *Default: grace 10 min, catch-up 24 h*, global settings
   (`automationCatchUpHours`) classified **global**.
5. **Background mode default** → *Default: off*, offered on first enable; classified **local**.
6. **Match items already in the status when an automation is enabled?** → *Default: no* (baseline
   at `enabledAt`); a one-off *"also run on the N cards already there"* button is a follow-up.

## Tasks

### F1 · Phase 1 — Contracts and pure evaluation

- [ ] F1.1 Define the automation model and IPC contract in @tm/shared

  - New `packages/shared/src/automation.ts`: `ScheduleShape`, `TrackerTrigger`, `AutomationAction`,
    `Automation`, `AutomationRun`, `FiringKind`, `AutomationRunStatus`, `validateAutomation`.
  - Add `Task.originAutomationId?: string | null` to `packages/shared/src/model.ts`.
  - Add the `automation:*` channels and `automations:changed` event to `packages/shared/src/ipc.ts`;
    classify each in `RELAY_POLICY` (`packages/shared/src/ipcRelay.ts`).
  - Acceptance: `automation.test.ts` covers every `validateAutomation` rule (missing schedule, bad
    hour, `mode: 'manual'` rejected, tracker without status for `entered-status`, unknown time zone);
    `test/ipc-relay-coverage.test.ts` passes; `pnpm typecheck` green (handlers may be stubs that throw
    *not implemented* until F1.11).

- [ ] F1.2 Implement schedule occurrence math with time zones @needs: F1.1 Define the automation model and IPC contract in @tm/shared

  - New `packages/shared/src/automationSchedule.ts`: `nextOccurrence`, `occurrencesBetween`,
    `scheduleLabel`, `cronOf` (display only), via `Intl.DateTimeFormat`.
  - Acceptance: tests for each shape; `weekly` on Sunday; `hours/6` across midnight; Europe/Warsaw
    spring-forward (02:30 does not exist → fires after the gap) and fall-back (fires once);
    `occurrencesBetween` over a week returns exactly the expected count.

- [ ] F1.3 Implement the catch-up age rule for missed occurrences @needs: F1.2 Implement schedule occurrence math with time zones

  - New `packages/shared/src/automationFire.ts`: `decideFire` with `graceMs` and `catchUpMs`.
  - Acceptance: tests — on time → `scheduled`; 3 h late → `catch-up`, `skippedCount 0`; daily that
    slept 3 days → one `catch-up`, `skippedCount 2`; hourly that slept 30 h → `skip` with the count;
    `nextRunAt` is always strictly after `now` (no burst).

- [ ] F1.4 Detect tracker events from a sync's before/after cards @needs: F1.1 Define the automation model and IPC contract in @tm/shared

  - New `packages/shared/src/automationTracker.ts`: `detectTrackerEvents`, `matchesTrackerTrigger`,
    `trackerReceiptKey`.
  - Acceptance: tests — new key → `appeared`; `externalStatus` change → `entered-status` (case-
    insensitive match); added label → `labeled`; unchanged card → nothing; `plan`/`adhoc` sources
    ignored; events for cards created before `enabledAt` ignored; label filters any/all/exclude.

- [ ] F1.5 Render card titles and briefs from automation templates @needs: F1.1 Define the automation model and IPC contract in @tm/shared

  - New `packages/shared/src/automationTemplate.ts`.
  - Acceptance: tests for every variable, a date in the automation's time zone, missing ticket fields
    on a schedule firing, and an unknown `{{var}}` left verbatim.

### F1 · Phase 2 — Persistence

- [ ] F1.6 Persist automations and their run receipts in the desktop store @needs: F1.1 Define the automation model and IPC contract in @tm/shared

  - `apps/client/src/main/store.ts`: `CREATE TABLE IF NOT EXISTS automations` (id PK, data JSON,
    enabled, nextRunAt, updatedAt) and `automation_runs` (id PK, automationId, occurrenceKey, status,
    kind, taskId, runId, refusal, skippedCount, note, at, `UNIQUE(automationId, occurrenceKey)`);
    `ALTER TABLE tasks ADD COLUMN originAutomationId TEXT`.
  - Store API: `getAutomations`, `saveAutomation`, `deleteAutomation`, `reserveAutomationRun`
    (returns `false` on a duplicate), `updateAutomationRun`, `getAutomationRuns(automationId|null,
    limit)`, `pruneAutomationRuns` (keep 200 per automation / 30 days).
  - Acceptance: the store has no test harness (memory *the-store-has-no-tests*), so add
    `scripts/verify-automations-store.mjs` on the `verify-resume-migration.mjs` pattern: fresh DB
    creates the tables; a DB with `originAutomationId` dropped re-opens and migrates; a duplicate
    reservation returns `false`; prune keeps the newest. Run it and paste its output in the card.

### F1 · Phase 3 — Engine

- [ ] F1.7 Launch a card for a firing through the scheduler's gates @needs: F1.3 Implement the catch-up age rule for missed occurrences, F1.5 Render card titles and briefs from automation templates, F1.6 Persist automations and their run receipts in the desktop store

  - New `apps/client/src/main/automationRunner.ts` (dependencies injected: store, a delegate fn
    shared with `task:assignAgent`, `scheduler.startTaskNow`, attention sink).
  - Reserve → overlap check → create/reuse card → delegate → timeline note → `startTaskNow` →
    map outcome (`started` / `parked` / `refused` + strike / 3 strikes → disable + Attention item).
  - Acceptance: `automationRunner.test.ts` with fakes — duplicate key launches nothing; parked refusal
    is not a strike; three dropped refusals disable it; a `started` resets the counter; overlap is
    `skipped`; the runner never writes `Task.status`.

- [ ] F1.8 Arm the schedule clock with boot catch-up and wake-from-sleep @needs: F1.7 Launch a card for a firing through the scheduler's gates

  - New `apps/client/src/main/automationClock.ts`; wire in `ipc.ts` next to `syncPoller` and into the
    shutdown list (`index.ts:237`); boot evaluation after `restoreLimitGate`/`restoreAuthGate`;
    `powerMonitor` `resume` re-evaluates.
  - Acceptance: `automationClock.test.ts` with fake timers — arms to the earliest `nextRunAt`, never
    waits more than 60 s; a past-due occurrence at boot is decided by `decideFire`; editing a schedule
    re-arms; disposal clears the timer.

- [ ] F1.9 Fire tracker automations from the sync sweep @needs: F1.4 Detect tracker events from a sync's before/after cards, F1.7 Launch a card for a firing through the scheduler's gates

  - Extract a pure glue `trackerFirings(automations, before, upserts)` and call it after
    `reconcileJiraTasks` (`ipc.ts:~3329`) and `reconcileGitHubIssues` (`ipc.ts:~3523`) once the
    upserts are applied; fire through the runner.
  - Acceptance: tests — a JIRA ticket moving to *To Do* with label `agent` yields one firing for the
    matching automation and none for a disabled one; a runner throw does not fail the sync; a failed
    or truncated sweep yields nothing.

- [ ] F1.10 Keep the app running in the background when the window closes

  - Local setting `runInBackground` (add to the local side of the `GLOBAL_SETTINGS_KEYS` guard in
    `packages/shared/src/settings.ts`); tray with Open / Pause automations / Quit; minimize fallback
    where no tray exists; `window-all-closed` (`index.ts:262`) consults a pure `shouldQuitOnClose`.
  - Acceptance: unit test for `shouldQuitOnClose(platform, settings, trayAvailable)`; settings guard
    test passes. Do **not** launch the app to check it (memory *verify-electron-app*).

- [ ] F1.11 Register the automation IPC handlers and relay policy @needs: F1.7 Launch a card for a firing through the scheduler's gates, F1.8 Arm the schedule clock with boot catch-up and wake-from-sleep

  - Handlers in `apps/client/src/main/ipc.ts`: save (bump `revision`, clear `nextRunAt` when the
    schedule changed, set `enabledAt` on enable, stamp `ownerClientId`), delete, setEnabled, runNow
    (`manual` firing), list, runs; refuse edits for an automation another desktop owns; emit
    `automations:changed`.
  - Acceptance: handler tests on the extracted pure parts; `test/ipc-relay-coverage.test.ts` green;
    `pnpm typecheck && pnpm test && pnpm build` green.

### F1 · Phase 4 — Cloud mirror

- [ ] F1.12 Mirror automations and their run log to the cloud @needs: F1.11 Register the automation IPC handlers and relay policy

  - `packages/protocol/src/wire.ts`: `MirrorDelta.automations`, `automationRuns` (≤ 200 per request),
    `deletedAutomationIds`; `PROTOCOL_VERSION` → 3.
  - Desktop: include changed automations and new runs in the outbound delta (`cloudDelta.ts`).
  - Server: entities `automationMirror`, `automationRunMirror`; migration
    `1792000000000-AutomationMirrors`; apply in `MirrorService.sync()`; retention 100 runs / 30 days;
    `GET /v1/automations`, `GET /v1/automations/:id/runs`.
  - Acceptance: server unit tests for apply, delete and retention; wire test that an oversize run list
    is split across requests; protocol skew test covers v2 ↔ v3.

- [ ] F1.13 Relay web automation edits to the owning desktop @needs: F1.12 Mirror automations and their run log to the cloud

  - `apps/web/src/board/httpTransport.ts`: `automation:list` / `automation:runs` in the direct tier
    (mirror GETs); save/delete/setEnabled/runNow relayed with the automation's `ownerClientId` as
    target.
  - Acceptance: `httpTransport.test.ts` asserts the tiering and the target; desktop-side test that a
    relayed edit for a non-owned automation is refused with a readable reason.

### F1 · Phase 5 — UI

- [ ] F1.14 Build the automation editor in @tm/ui @needs: F1.2 Implement schedule occurrence math with time zones, F1.4 Detect tracker events from a sync's before/after cards, F1.11 Register the automation IPC handlers and relay policy

  - `packages/ui/src/automations/AutomationEditor.tsx` + a pure `automationEditorModel.ts` (draft ↔
    `Automation`, validation messages, next-5 preview, rendered template preview). Reuse `ModelField`,
    `PlanningModelField`.
  - Acceptance: `automationEditorModel.test.ts` — round-trip draft ↔ model, preview equals
    `occurrencesBetween`, `manual` mode blocked with the explanation. (No DOM harness exists; test the
    model.)

- [ ] F1.15 Add the Automations view (list / week calendar / run log) @needs: F1.14 Build the automation editor in @tm/ui

  - `packages/ui/src/automations/AutomationsView.tsx`, `WeekCalendar.tsx`, `NextRunsRail.tsx`,
    `RunLogDrawer.tsx`, pure `weekCalendarLayout.ts`; new `automations` tab in
    `apps/client/src/renderer/src/App.tsx` `NAV`.
  - Acceptance: `weekCalendarLayout.test.ts` (occurrences land in the right day/hour cells across a
    DST week; past cells carry outcomes); colour only on moving states per *board-colour-budget*.

- [ ] F1.16 Add starter automation templates @needs: F1.14 Build the automation editor in @tm/ui

  - `packages/ui/src/automations/templates.ts`: e.g. *Nightly — triage new tickets*, *Weekday
    mornings — fix failing tests on main*, *Weekly — dependency updates*, *Work any ticket labelled
    `agent` in To Do*; palette in the editor's empty state.
  - Acceptance: test that every template passes `validateAutomation` once a project is filled in.

- [ ] F1.17 Show Automations in the web client @needs: F1.13 Relay web automation edits to the owning desktop, F1.15 Add the Automations view (list / week calendar / run log)

  - Add the tab to `apps/web/src/App.tsx` `NAV` with the shared components; owner-desktop banner with
    last-seen and the *"nothing fires until ‹desktop› is running"* sentence.
  - Acceptance: `test/shell-parity.test.ts` green; a test on the banner's pure state function (live /
    stale / never-synced).

- [ ] F1.18 Mark automation-started cards on the board @needs: F1.7 Launch a card for a firing through the scheduler's gates

  - `packages/ui/src/board/TaskCard.tsx`: monochrome flash glyph + tooltip *"Started by ‹name› ·
    catch-up for 04:00"* when `originAutomationId` is set; the card's timeline already carries the
    runner's note.
  - Acceptance: test on the pure tooltip/label function; no new colour on the card.
