# Development roadmap

This is the **build plan** for Claude Orchestrator itself — the phases we ship the
app in. It is different from a *project* `plan.md` (the file a user points the app
at so it can run *their* tasks). This one is our own task list.

> **How to read this.** Each phase has a **Goal** (one sentence), the **Deliverables**
> as checkboxes, and **Done when** — the acceptance criteria that let us call the
> phase finished and tag a commit `feat: … (Phase N)`. Phases are ordered by
> dependency: each builds on the process, IPC, and data types the previous one
> introduced.

The structure mirrors how the app parses a plan (see
[`docs/03-how-orchestration-works.md`](../03-how-orchestration-works.md#where-plans-come-from)):
`##` headings are phases, `- [ ]` items are tasks. So this file is itself a valid
plan the orchestrator could one day run on its own repo.

---

## Status at a glance

| Phase | Title | State |
|------:|-------|-------|
| 0 | Scaffold (3-process Electron, IPC contract, Claude status) | ✅ shipped (`8887127`) |
| 1 | Session runner + live Session view | ✅ shipped (`af5e802`) |
| 2 | Persistence & Projects | ✅ shipped |
| 3 | Task board & Scheduler | ✅ shipped |
| 4 | Attention inbox (permissions & questions) | ✅ shipped |
| 5 | Usage-limit gate (auto-respawn) | ✅ shipped |
| 6 | History, resume-across-restart & polish | ⬜ next |
| 7 | Packaging & release | ⬜ |

Phases 4 and 5 are already referenced by name in the docs
([`03-how-orchestration-works.md`](../03-how-orchestration-works.md) and the
`Phase 5 auto-respawn gate` note in [`src/shared/session.ts`](../../src/shared/session.ts));
the numbering here is chosen to keep those references correct.

---

## Phase 2 — Persistence & Projects

**Goal.** Give the app a memory: a local database of projects and their tasks,
where tasks come from parsing each project's `plan.md`.

Today everything is ephemeral — the Session view runs one prompt and forgets it.
Before we can schedule work we need durable state. This phase adds the data layer
and the first real screen (a projects list), but **does not run anything
automatically** yet.

### Deliverables

- [x] Wire the local store: **`better-sqlite3`** (decided), a real SQLite database
      under `app.getPath('userData')` — matches the "SQLite database" already in the
      `docs/02` diagram. Native-module build handled via a `postinstall`
      (`electron-builder install-app-deps`) that rebuilds it for Electron's ABI, and
      a pnpm `onlyBuiltDependencies` allowlist. Verified loading + SQL under Electron's
      Node (ABI 20.18); `pnpm package` bundling to be re-confirmed in Phase 7.
- [x] Define shared domain types in a new `src/shared/model.ts`: `Project`
      (`id`, `name`, `path`, `planPath`, `defaultModel`, `defaultPermissionMode`)
      and `Task` (`id`, `projectId`, `phase`, `title`, `status`, `sessionId`,
      `order`). Reuse `ClaudeModel`/`PermissionMode` from `session.ts`.
- [x] `TaskStatus` union: `pending | running | waiting-input | blocked-by-limit |
      done | failed | stopped` (matches the state machine in `docs/03`).
- [x] A **plan parser** in `src/main/planParser.ts` (pure, unit-tested): markdown →
      `{ phase, title, done }[]`. Headings become phases; `- [ ]` / `- [x]` items
      become tasks (checked = `done`); wrapped lines fold into their task. Same
      grammar the app documents in `docs/03`.
- [x] A `store` module in `src/main/store.ts`: `addProject`, `listProjects`,
      `removeProject`, `getTasks`, and `syncTasksFromPlan`. The pure reconcile logic
      (preserves live status/sessionId across re-parses) lives in
      `src/main/taskReconcile.ts` so it is unit-tested without the native DB.
- [x] New IPC channels in `src/shared/ipc.ts`: `project:pickDirectory`,
      `project:add`, `project:list`, `project:remove`, `project:syncPlan`. Folder
      picker via `dialog.showOpenDialog` behind `project:pickDirectory`.
- [x] Renderer: a **Projects** screen (top tabs) listing projects and, per project,
      its parsed tasks grouped by phase with a status chip, plus Sync/Remove. The
      existing Session view is now the "Scratch run" tab.

### Done when

- [x] Adding a project persists across an app restart. *(store writes to a real
      SQLite file under userData; verified DDL/DML + cascade under Electron)*
- [x] A project's `plan.md` is parsed into phase-grouped tasks shown in the UI.
- [x] `pnpm typecheck` and `pnpm test` pass (26 tests); the parser has unit tests
      covering headings, checked/unchecked items, wrapping, and nesting.

---

## Phase 3 — Task board & Scheduler

**Goal.** Turn the static task list into a running queue: a scheduler that picks
the next task and runs it through the existing `SessionManager`, one task = one
session, updating status live.

### Deliverables

- [x] `src/main/scheduler.ts`: given a project, select the next `pending` task by
      **phase order, then task order** (the pure, unit-tested `selectNextPending`),
      honoring a **concurrency limit** (default 1). Starts it via
      `SessionManager.start`, mapping the project `cwd`/model/permissionMode into the
      `StartSessionRequest`.
- [x] **Persist the session id** the instant the `started` event arrives (the rule
      called out in `docs/03`), so a task can be resumed later.
- [x] Drive task status from the event stream: `started`→`running`,
      `result.success`→`done` (and tick `- [x]` back into the plan file if the
      project opts in), failure/`exited`≠0→`failed`; advance to the next task.
- [x] IPC: `scheduler:start`, `scheduler:pause`, `scheduler:stop`, `task:run` (run
      one task ad-hoc), and `scheduler:activeRuns` (seed the board on load). Events:
      `task:changed` and `scheduler:changed` so the board updates live without polling.
- [x] Renderer: a **Board** view — tasks as rows moving through
      pending → running → done, with the live transcript from Phase 1 shown for the
      selected task. The transcript rendering is extracted into a shared
      `Transcript` component (`runId`-driven), reused by both the Board and the
      Scratch run.
- [x] Optional write-back: when a task completes, `tickPlanCheckbox` flips the
      matching `- [ ]` to `- [x]` in the source `plan.md`. Guarded behind a
      per-project `writeBackPlan` toggle; only the single completed checkbox is
      touched, so unrelated edits are never clobbered.

### Done when

- [x] Pressing **Run** on a project works through its pending tasks in order, one at
      a time, updating each task's status live. *(one-session-at-a-time enforced by
      the concurrency=1 slot logic; live updates via `task:changed`)*
- [x] Session ids are persisted and visible (shown on each task row); stopping the
      scheduler leaves no orphan `claude` processes (`scheduler.stop` / `dispose`
      route through the existing `SessionManager.stop`/`stopAll`).
- [x] `pnpm typecheck`/`pnpm test` pass (39 tests); scheduler selection and plan
      write-back logic are unit-tested. Migration of the Phase-2 DB to the new
      `writeBackPlan` column verified against the real user database on boot.

---

## Phase 4 — Attention inbox (permissions & questions)

**Goal.** Route the two things that pause a task — **permission requests** and
**clarifying questions** — to a dashboard inbox, and send the human's answer back
into the live session so it continues without a restart.

> Prereq / notable rework: `claudeSession.ts` currently closes stdin immediately
> (`child.stdin.end()`), so a session cannot be answered mid-flight. This phase
> switches to the CLI's **streaming input** mode (`--input-format stream-json`,
> keeping stdin open) so we can push messages into a running session.

### Deliverables

- [x] Keep the input stream open; add `SessionHandle.send(message)` and thread it
      through `SessionManager` (`session:answer` IPC by `runId`). `claudeSession`
      now spawns with `--input-format stream-json`, sends the prompt as a
      stream-json user turn, and leaves stdin open; the scheduler ends the process
      explicitly on `result` (it no longer self-exits). Pure `encodeUserMessage`
      is unit-tested.
- [x] **True pre-execution veto** for permissions (not a monitor): task runs spawn
      with `--permission-prompt-tool`, so the CLI calls our MCP approval tool and
      **blocks** before running each tool. The relay (`permissionServerSource.ts`,
      a self-contained `.cjs` the CLI spawns) forwards every tool use to the in-app
      **`PermissionBroker`** (localhost HTTP, per-run bearer token); the scheduler
      auto-approves safe ones per policy and parks risky ones as an `attention:new`
      item until a human answers — the tool stays held the whole time. Gated runs
      use `--permission-mode default` so the policy governs *every* tool (edits
      included). Fails **safe** (deny) if the broker is unreachable.
- [x] A **risk policy** (`src/main/permissionPolicy.ts`, pure + tested):
      auto-approve safe reads/edits; **route to a human** anything touching git
      push, deletions, or `.env`/secrets — exactly the policy described in
      `docs/03`. Task goes `waiting-input` while parked.
- [x] **Reliable clarifying questions** via an explicit contract, not a heuristic:
      the task prompt instructs Claude to prefix a line with `@@NEEDS_INPUT@@` when —
      and only when — it needs a human decision; the pure `detectAttention`
      (`src/main/attention.ts`, unit-tested) detects that sentinel deterministically.
      A `result` for a parked run is held (no settle) until the human answers.
- [x] Renderer: an **Attention** inbox listing pending items across all tasks;
      permission items get **Approve/Deny** (releasing/vetoing the held tool) and
      questions get a free-text reply, all via `attention:answer`; the task returns
      to `running`. A live count badge sits on the Attention tab.

### Done when

- [x] A session that asks a question surfaces in the inbox; answering it resumes the
      same session (same session id, no restart) and the task continues. *(Claude
      signals with `@@NEEDS_INPUT@@`; the answer is pushed into the still-open input
      stream; the parked `result` is not settled until the item is cleared.)*
- [x] A risky tool use is **held for approval** — genuinely blocked before it runs
      via the MCP permission tool — and a safe one is auto-approved per policy.
- [x] Policy unit tests cover the git-push / delete / secrets cases; the broker's
      auth/decision/fail-safe contract and the MCP relay round-trip are tested by
      spawning the real relay against a fake broker (no live Claude needed).
      `pnpm typecheck` + `pnpm test` (59 tests) + `pnpm build` green; app boots
      (10s smoke test; broker binds and materializes the relay under userData).

> **Packaging note (Phase 7).** The relay is spawned as `process.execPath` under
> `ELECTRON_RUN_AS_NODE=1`; re-confirm it resolves and runs from inside a packaged
> build (asar) when we do Phase 7, alongside the `better-sqlite3` bundling check.

---

## Phase 5 — Usage-limit gate (auto-respawn)

**Goal.** The headline feature: when Claude hits a usage limit, park everything and
**automatically resume** each session at reset time.

The plumbing already exists at the edges — `mapRawEvent` emits `rate-limit` with a
`resetsAt`, and the Session view renders it. This phase turns that signal into the
account-wide gate described in `docs/03`.

### Deliverables

- [x] A global **limit gate** in `src/main/limitGate.ts`: on a non-`allowed`
      `rate-limit` event, mark the task `blocked-by-limit`, hold **all** scheduling
      (it's account-wide), and record `resetsAt`. The gate is a small state machine
      with an injected clock/timer; the scheduler feeds it every run's rate-limit
      event and parks each in-flight session (ending the process, keeping the saved
      session id) via `engageLimit`. `pump`/`runTask` are held while it's active.
- [x] Schedule a timer for `resetsAt` **plus random jitter** (0–60s); on fire,
      **resume** each parked session by its saved session id
      (`claude --resume <id>`, new `resumeSessionId` path through
      `SessionManager`/`claudeSession`, re-attaching the permission gate) with a
      continue-nudge prompt, then release the gate. Merging a second limit waits
      for the **later** reset.
- [x] Distinguish the **5-hour rolling** limit (auto-resumes) from the **weekly
      cap** (waits out the weekly window) via the pure `classifyLimit`, and label
      them differently in the UI banner.
- [x] IPC event `limit:changed` (+ `limit:current` to seed on load) carrying the
      `LimitState` (reset/resume time, parked task ids); renderer shows a **global
      banner with a live 1s countdown** and how many tasks are parked.
- [x] Survive an app restart during a limit: the gate's state is persisted to a new
      `app_state` table and re-armed on startup (`restoreLimitGate`, after the
      broker is up) — resuming immediately if the reset already passed while the app
      was down. (Fuller startup reconciliation is Phase 6.)

### Done when

- [x] A simulated/real limit parks all work behind one banner with a live countdown.
      *(non-`allowed` `rate-limit` → account-wide gate + `LimitBanner` countdown to
      `resumeAt`.)*
- [x] When the reset time passes, parked sessions resume automatically by session id.
      *(gate timer → `resumeParked` spawns `--resume <sessionId>` for each still-parked
      task; user-stopped tasks are unparked and skipped.)*
- [x] Gate transition logic is unit-tested with a mock clock. *(`limitGate.test.ts`
      drives engage/resume/merge/restore/unpark/dispose against a fake timer;
      `pnpm typecheck` + `pnpm test` (72 tests) + `pnpm build` green; app boots
      (10s smoke) and the `app_state` persistence round-trips under the real DB ABI.)*

---

## Phase 6 — History, resume-across-restart & polish

**Goal.** Make the app durable and legible over long runs: persist transcripts,
resume in-flight work after a relaunch, and tidy the UX.

### Deliverables

- [ ] Persist per-task transcript/event history; reopening a task shows its past
      output, not a blank pane.
- [ ] On startup, reconcile: tasks left `running`/`waiting-input`/`blocked-by-limit`
      are re-attached or safely re-queued (using saved session ids).
- [ ] Settings screen: default model/permission mode, concurrency limit, jitter,
      plan write-back toggle.
- [ ] Empty states, error surfacing, and a footer showing Claude status + app info
      (fold in the Phase 0 banner).

### Done when

- Killing and relaunching the app mid-run does not lose task state or transcripts.
- Every task's history is viewable after the fact.

---

## Phase 7 — Packaging & release

**Goal.** Ship an installable build.

### Deliverables

- [ ] Verify `pnpm build` + `pnpm package` produce a working Windows installer
      (`electron-builder.yml` is already present) that launches and finds `claude`.
- [ ] App icon, product metadata, and a first-run check (installed + logged in,
      warn on `ANTHROPIC_API_KEY`) surfaced cleanly.
- [ ] Confirm the bundled dependency tree stays permissive
      ([`docs/06-licensing.md`](../06-licensing.md)); document the release steps.

### Done when

- A packaged build installs and runs a project end-to-end on a clean machine.

---

## Conventions for every phase

- **Contract first.** New data crossing the UI↔engine boundary gets its types in
  `src/shared/` before either side uses it (`docs/02`).
- **Pure logic is unit-tested.** Parsers, policies, schedulers, and gates are pure
  functions with `.test.ts` files, like `claudeSession.mapRawEvent` today.
- **Green before commit.** `pnpm typecheck` and `pnpm test` pass; commit message
  ends with `(Phase N)`.
- **No paid API.** Everything runs the subscription `claude` CLI; never introduce a
  path that uses `ANTHROPIC_API_KEY` (`docs/06`).
