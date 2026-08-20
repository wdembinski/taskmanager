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
| 6 | History, resume-across-restart & polish | ✅ shipped |
| 7 | Packaging & release | ✅ shipped |
| 8 | Import & project configuration | ✅ shipped |
| 9 | Personal task management (to-do list) | ✅ shipped |
| — | Interim releases v0.11–v0.21 (worktrees & auto-merge, team orchestration, JIRA sync, My Tasks Kanban) | ✅ shipped, not tracked here |
| 10 | Delegate a task to an agent | ✅ shipped |
| 11 | Plan-driven subtasks (plan → approve → steps) | ✅ shipped |
| 12 | Chat with the agent from a card | ✅ shipped |
| 13 | The workspace refresh (nav rail, status bar, one-pane detail) | ✅ shipped |
| 14 | Sprints on the board | ✅ shipped |
| 15 | The board grows up (IN REVIEW, status map, priority, notes, colours) | ✅ shipped |
| 16 | Seventeen fixes and two integrations (bugs, workspace, JIRA depth, auto-update, GitLab) | ✅ shipped (v0.30.0) |
| 17 | Ask me, and show me what you are doing | ✅ shipped (v0.33.0) — all 42 items |
| — | Interim releases v0.34–v0.50 (branch naming, re-planning, base branch, board polish, engine fixes) | ✅ shipped, not tracked here |
| 19 | Setting a chain of execution (links, gates, the release engine) | ✅ shipped (v0.51.0) |
| 20 | Auto-release (RELEASE.md, the per-card switch and the project's preference) | ✅ shipped (v0.52.0) |
| 21 | Starting the next card automatically (the re-ask, and what a merge is holding) | ✅ shipped (v0.55.1) |
| — | Interim releases v0.56–v0.57 (a Stop button everywhere, the Add-task dialog's options) | ✅ shipped, not tracked here |
| 22 | Attachments in the task and its steps | ✅ complete (v0.64.4) — tag and draft cut once it lands on `development` |
| 23 | One model for planning, another for the steps | ✅ complete on `feat/setting-ai-agent-models-for-planning` — tag and draft cut once it lands on `development` |
| 24 | Projects and their tickets (a tracker of our own) | 🚧 in progress on `feat/support-projects-and-their-tickets` — **the whole plan is written** (design, build steps, verification, critical files); build step 1 is next |
| 25 | Cloud service (a hosted counterpart, sharing domain logic and UI) | 🚧 in progress on `feat/cloud-service` — target layout written, `apps/client`+`packages/shared` restructured, verified (found and fixed a broken per-package test run), Azure cost estimated, risks and open assumptions recorded, no-realtime-service/adaptive-polling design written; every package now scaffolded and the service deployed, with `apps/web` rebuilt on the desktop's own shell, board and detail pane (`feat/the-task-manager-web-should-look-like`, v0.82.0) and its layout matched to the desktop's (`feat/match-web-layout-to-desktop-client`, v0.82.5 — shared global CSS, the toolbar's Add button, a drift guard) — a human glance at the two UIs side by side is still owed |
| 26 | Support all interactions in the web (relay the channel, not the command kind) | ✅ complete on `feat/support-all-interactions-in-the-web` — one `ipc-invoke` kind behind an exhaustive host-only policy, at-least-once delivery with a result-replay ledger, `PolledEventBus` in place of an event feed; gates green and forced, and the whole relay driven headlessly by [`verify-remote-ipc.mjs`](../../apps/client/scripts/verify-remote-ipc.mjs). A human pressing these controls against a real desktop is still owed, as is deploying the server with this schema |
| 27 | Mobile app for Android (an installable PWA, not a native build) | 🚧 in progress on `feat/mobile-app-for-android` — four framing decisions taken (new `apps/mobile`, PWA not Capacitor/TWA, its own subdomain, one-time human setup precedes reachability); the share/fork boundary decided (new `packages/cloud` absorbs `apps/web`'s sync layer, `@tm/ui` is reused as-is, the shell/navigation/move/detail-route fork, the chain overlay and drag handle drop); nothing built yet |

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

- [x] Persist per-task transcript/event history: a new `task_events` table (one row
      per normalized event) written by the scheduler as each run streams; reopening
      a task in the Board loads it via `task:history` and `<Transcript>` replays it,
      so past output shows instead of a blank pane. The table references the
      **project** (not the task), so a plan re-sync — which deletes/reinserts task
      rows — never cascades history away; removing a project still cascades it.
- [x] On startup, reconcile (`reconcileInterruptedTasks`): tasks left `running`/
      `waiting-input` are re-queued to `pending` (their process died with the app),
      **keeping their saved `sessionId`** so a re-run RESUMES the conversation
      (`startTask` now resumes whenever a task already has a session id).
      `blocked-by-limit` tasks are left for the Phase 5 limit gate to resume.
- [x] Settings screen: default model / permission mode / plan write-back for **new**
      projects, plus the two live scheduler knobs — **concurrency** and the usage-
      limit **resume jitter** — read fresh from the store on each task/limit so edits
      take effect without a restart. Persisted as one blob in `app_state`, merged
      over `DEFAULT_SETTINGS` so older DBs gain new fields cleanly.
- [x] Empty states, error surfacing (Projects add/sync/remove failures now show a
      dismissible error bar), and a **footer** showing Claude readiness (status dot +
      version/login) and app info — folding in the Phase 0 banner, which now only
      appears at the top when something is actually wrong.

### Done when

- [x] Killing and relaunching the app mid-run does not lose task state or transcripts.
      *(events persist to `task_events` as they stream; startup reconciliation heals
      stuck statuses; transcripts reload from the DB.)*
- [x] Every task's history is viewable after the fact. *(`task:history` +
      `<Transcript taskId=…>` replay.)*
- [x] `pnpm typecheck` + `pnpm test` (72) + `pnpm build` green; app boots (10s smoke,
      real-DB migration applied + reconciliation ran clean); the new schema's
      survive-resync / cascade-on-project-delete / settings-merge behaviors are
      verified under the real better-sqlite3 ABI.

---

## Phase 7 — Packaging & release

**Goal.** Ship an installable build.

### Deliverables

- [x] `pnpm build` + `pnpm package` produce a working Windows NSIS installer
      (`dist/Claude Orchestrator-<version>-setup.exe`). The two packaging landmines are
      handled and verified in the packaged layout: `better-sqlite3`'s native
      `.node` is `asarUnpack`ed (so the DB loads), and the permission relay's
      `process.execPath` + `ELECTRON_RUN_AS_NODE=1` spawn runs as Node from the
      installed exe. App shells out to the user's own `claude` on PATH.
- [x] App **icon** (`build/icon.ico`, a generated 256×256), product metadata
      (appId / productName / copyright / publisherName / versioned artifact name),
      and a **first-run check** — `claudeStatus` (installed + logged in, warns on
      `ANTHROPIC_API_KEY`) surfaced via the Phase 6 footer + top warning bar.
- [x] Dependency tree confirmed **permissive** — no GPL/AGPL/LGPL/MPL/EPL/CDDL in
      the shipped tree (only MIT / ISC / Apache-2.0 / BSD / WTFPL); release steps
      documented in [`docs/07-packaging-and-release.md`](../07-packaging-and-release.md).

### Done when

- [x] A packaged build installs and runs. *(Installer + `win-unpacked` produced;
      the packaged exe boots and holds a 12s smoke test with the native DB loading
      from `app.asar.unpacked`, and runs as Node for the relay. End-to-end on a
      truly clean machine is the one manual step left to a human — it needs a
      machine with `claude` installed and logged in.)*

---

## Phase 8 — Import & project configuration

**Goal.** Make it easy to bring an *existing* project into the tool: point at any
plan file, edit a project's settings after adding it, and adopt a Claude
conversation you already started in the terminal.

Most of the engine already supports this — `store.addProject` accepts a custom
`planPath`, and the scheduler already resumes a task by its `sessionId` via
`claude --resume`. This phase mainly **surfaces** those in the UI, plus one new
read (listing existing on-disk sessions).

### Deliverables

- [x] **A — Add/Edit project dialog.** Replace the one-click "Add project…" with a
      form (folder Browse, **plan file** Browse defaulting to `<folder>/plan.md`,
      display name, model, permission mode, write-back), reused for **editing** an
      existing project. New IPC `project:pickFile` (native `.md` file picker) and
      `project:update` (backed by a general `store.updateProject`, folding in
      today's `setWriteBack`). Model/mode changes apply to the next run.
- [x] **B1 — Manual session attach.** On a non-running task, "Attach session…" takes
      a pasted session-id (UUID) and, via `task:attachSession` (reusing
      `store.updateTask`), sets `task.sessionId` + status `pending`, so **Run**
      resumes that conversation instead of starting fresh. No dependency on CLI
      internals.
- [x] **B2 — Session discovery/picker.** `claude:listSessions(cwd, target?)` enumerates
      `~/.claude/projects/<encoded-cwd>/*.jsonl` (filename = resumable session id),
      returning `{ sessionId, startedAt, lastAt, preview }` newest-first; the adopt
      UI shows this as a pick-list with the manual-paste fallback. Pure helpers
      `encodeProjectDir` + `parseSessionPreview` are unit-tested; the reader fails
      soft (the `~/.claude/projects` layout is an **undocumented** CLI convention,
      verified against the current install — never hard-depend on it). `target`
      was added to the signature so a WSL project reads that distro's home rather
      than the window's. Only the head of each transcript is read: a prompt with a
      pasted image is one 200 KB+ line, and such a session lists with an empty
      preview rather than costing megabytes to describe.
- [x] **C — Ad-hoc tasks + live plan re-sync.** Tasks now carry `source: 'plan' |
      'adhoc'`. **C1:** `task:create` / `task:delete` + an "Add task…" dialog let you
      add work directly to any project (no plan file needed — plan-less projects are
      usable), tagged `adhoc`. `reconcileTasks` was reworked so ad-hoc tasks — and any
      **mid-flight** task — are never dropped by a plan sync. **C2:** a `PlanWatcher`
      (polling `fs.watchFile`) re-parses + reconciles a project's plan whenever the
      file changes and pushes the new list over `project:tasksChanged`, so when the
      **agent rewrites the plan while it works** (the task prompt now invites this),
      the new milestones/tasks appear on the Board live.

### Done when

- [x] You can add a project pointing at an arbitrary plan file and edit its
      model/mode/name/plan afterward.
- [x] You can attach an existing Claude session to a task and have "Run" continue
      that conversation.
- [x] B2: the adopt UI lists real on-disk sessions for a project's folder.
- [x] C: you can add an ad-hoc task to any project, and edits to a plan file (by a
      human or the agent mid-run) re-sync onto the Board without a manual "Sync",
      without ever dropping an ad-hoc or running task.
- [x] `pnpm typecheck` + `pnpm test` + `pnpm build` green; pure bits unit-tested.

---

## Phase 9 — Personal task management (to-do list)

**Goal.** Make the tool double as a personal to-do list on top of the AI orchestrator:
put your own tasks (Phase 8 ad-hoc), **set a task's status by hand**, and keep a
**running thread of progress notes** so you can pick a task back up and see what happened.

### Deliverables

- [x] **A — Human statuses + manual control.** `TaskStatus` gains `in-progress` / `blocked`
      / `cancelled` (labelled To Do / In Progress / Blocked / Done / Cancelled via
      `STATUS_LABEL`), distinct from the AI-owned `running`/`waiting-input`/`blocked-by-limit`.
      New `task:setStatus` (validates against `MANUAL_STATUSES`, refuses a task mid-run,
      reuses `store.updateTask`, logs the change, emits `task:changed`). `reconcileTasks`
      also keeps `in-progress`/`blocked` orphans so a plan re-sync can't discard active work.
- [x] **B — Activity timeline + comments.** New `task_activity` table (comments + status
      changes), referencing the *project* like `task_events` so plan re-syncs don't wipe it.
      `getTaskActivity` **merges** it with the AI transcript into one time-ordered feed
      (pure, unit-tested `mergeActivity`). IPC `task:activity` / `task:addComment` /
      `task:deleteComment`. `deleteTask` now also clears a task's activity + events.
- [x] **C — "My Tasks" screen.** New top-level tab (`MyTasks.tsx`): all tasks across
      projects, grouped, with a status filter, a per-row "Set status" menu, and per-project
      "Add task…" (reusing the Phase 8 dialog). A `TaskDetail.tsx` pane shows the status
      dropdown + the unified activity timeline (AI events via the exported `eventToLines`) +
      an add-comment composer. Board stays AI-focused.

### Done when

- [x] You can set a task's status by hand and it sticks across restarts + plan syncs.
- [x] You can add progress comments and re-read them, interleaved with status changes and
      the AI transcript, in one timeline.
- [x] `pnpm typecheck` + `pnpm test` + `pnpm build` green; pure bits (`mergeActivity`,
      reconcile) unit-tested.

---

## Phase 10 — Delegate a task to an agent

**Goal.** Let a single **My Tasks** card — a JIRA ticket or an in-app task — be
handed to Claude: pick the repo, pick the mode, and the agent works that one
ticket in an isolated worktree, answering to you in the task's detail sidebar.

This is also the seed of the **new projects concept**: an *agent project* is just
a directory plus the JIRA epics it owns, deliberately separate from the legacy
`plan.md`/queue Projects feature it is meant to replace. Ground rules taken with
the user: **per-task only** (no queue, no auto-start), **JIRA is never written
to**, isolated **git worktree + auto-merge**, and usage limits park/resume exactly
as they do for plan tasks.

### Deliverables

- [x] **1 — Agent projects.** `projects` gains `kind` (`'plan' | 'agent'`) and
      `jiraEpicKeys` (JSON array), with migrations in the `store.ts` open path, so
      an agent project **is** a `Project` — worktrees, integration, usage
      attribution and the limit gate keep working untouched. Agent rows force
      `planPath: ''`, `useWorktrees: true`, `writeBackPlan: false`; they are hidden
      from the legacy Projects tab and skipped by `PlanWatcher`.
      `agentProject:list|add|update|remove` IPC behind a new Settings → **Agents**
      pane (`AgentProjects.tsx`).
- [x] **2 — JIRA epic & description plumbing.** `JiraClient.listFields()` plus
      `src/main/jira/epicField.ts` discover the per-instance **Epic Link** custom
      field once and cache it in `app_state` (the cache carries the `baseUrl` it
      was found on and self-invalidates; a negative result is cached too), failing
      soft to `parent` and then to manual assignment. `issueToTask` maps
      `externalParentKey` / `externalDescription`; the pure
      `resolveAgentProject` (`src/shared/agentProjects.ts`) picks a repo:
      explicit assignment → epic-key match → `null` (ask in the dialog).
- [x] **3 — Assignment & run path.** New `Task` columns `agentProjectId`,
      `agentMode`, `agentModel`, `externalParentKey`, `externalDescription` (a
      JIRA re-sync deliberately never clears `agentProjectId`). New pure
      `src/main/agentTaskPrompt.ts` builds a single-ticket brief — key/URL/title,
      description, JIRA comments oldest→newest, your notes, the worktree commit
      rule, and the `@@NEEDS_INPUT@@` contract reused verbatim from
      `attention.ts`. `Scheduler.runProjectFor(task)` resolves the run's project
      from `agentProjectId`, wired into `runTask`, `resumeParked`, auto-retry and
      worktree cleanup, so limit-park → auto-resume works identically. `Run` gains
      `permissionMode`/`model` (preferred by `decidePermission`). IPC
      `task:assignAgent` / `task:stopAgent`.
- [x] **4 — Board & detail UI.** `AssignAgentDialog.tsx` (repo picker pre-filled by
      `resolveAgentProject`, model, all four permission modes, optional notes);
      `TaskCard` shows an agent glyph and reuses the unread-JIRA **orange frame**
      when the agent needs input (`needsAgentInput` in `src/shared/board.ts`);
      `TaskAgentPanel.tsx` in the detail sidebar assigns/reassigns/stops and
      answers the agent's pending question or permission inline; `TaskDetail`
      streams the live run's transcript into the timeline.
- [x] **5 — Docs.** This phase entry, the *Delegating one task to an agent*
      section in [`docs/03`](../03-how-orchestration-works.md#delegating-one-task-to-an-agent),
      and the new glossary terms.

### Done when

- [x] A card can be assigned to an agent project and runs there, while the card
      itself stays on the Personal board (`task.projectId` never changes, so the
      queue scheduler never picks it up).
- [x] The agent's question or permission request turns the card orange and can be
      answered from the task's detail sidebar without leaving My Tasks.
- [x] Usage limits park and auto-resume a delegated task exactly like a plan task.
- [x] `pnpm typecheck` (node + web) + `pnpm test` + `pnpm build` green; the pure
      bits (`resolveAgentProject`, `buildAgentTaskPrompt`, `needsAgentInput`,
      epic-field discovery) are unit-tested.
- [ ] **Live E2E still owed:** epic discovery against the real JIRA (needs a real
      PAT in the running app), and one full assign → answer → auto-merge run on a
      scratch repo.

---

## Phase 11 — Plan-driven subtasks

**Goal.** Let a delegated card be worked in **plan mode**: the agent researches and
proposes a plan, a human approves it, and each phase of that plan becomes a
**subtask** that runs in **its own Claude session**, one at a time. A step then pays
only for its own context instead of one session dragging the whole plan — and every
file it read — through every later step. Steps can also be written by hand.

Ground rules taken with the user: **one shared worktree per ticket** (integration
once, after the last step), steps run **full-auto** (`bypassPermissions`) once the
plan is approved, the **parent is never auto-completed**, subtasks are internal-only
(**never** written to JIRA), and rejecting a plan **re-plans in place** rather than
un-assigning the card.

### Deliverables

- [x] **1 — Real plan mode + plan capture.** `buildClaudeArgs` forced
      `--permission-mode default` whenever the permission gate was on (i.e. always),
      so **plan mode never reached the CLI** — the assign dialog's "Plan" option did
      nothing. Fixed, plus `evaluateToolUse('ExitPlanMode') → ask` so the call is held,
      a `tool-use`-event fallback capture path, `task.agentPlan`, and a detail pane
      that no longer prints `·thinking·`/tool chatter (one "Agent running" + a
      `Spinner`). Icon fix: `AgentsRegular`, white, single size.
- [x] **2 — Subtask model.** `tasks` gains `parentTaskId` and `description`, with
      migrations in the `store.ts` open path; `getSubtasks` / `addSubtask`;
      `task:subtasks` / `task:addSubtask` / `task:updateSubtask` IPC; the pure
      `groupSubtasks` board helper; and JIRA re-sync protection so a resync never
      orphans or clobbers steps.
- [x] **3 — Approval → chain.** A `plan-approval` attention kind carrying the plan
      markdown and the step titles. Approving creates the subtasks, **denies** the held
      `ExitPlanMode` with a hand-over message (so the planning session stops instead of
      implementing), sets the parent `in-progress` and starts step 1 once the planning
      run has exited. The pure `planToSubtasks.ts` splits the plan (shallowest heading
      level with ≥ 2 work sections → top-level list → the whole plan as one step; framing
      headings skipped; capped at `MAX_PLAN_STEPS`). `WorktreeManager.prepare(…,
      ownerTaskId)` + `Scheduler.worktreeOwner` give the chain **one** worktree;
      `settle` defers integration to the last step and `advanceSubtasks` starts the
      next; `finishParentChain` leaves a "ready for review" comment with the parent
      still `in-progress`. `buildAgentSubtaskPrompt` gives a step *N of M*, its brief,
      sibling titles, the card's notes, the shared-branch rule and the
      `@@NEEDS_INPUT@@` contract — and **no** JIRA comment thread. `stopTask` covers
      the whole chain.
- [x] **4 — UI.** Step rows flush under the card body (no gap, clipped by the radius)
      with a status dot and a `2/5` progress caption; the real plan-approval panel
      (plan in its own scroll box, numbered steps, Approve plan / Re-plan + note); a
      new `TaskSteps.tsx` = a **Steps** box on every card (add a step inline, toggle
      the approved plan) plus the step brief editor; a breadcrumb back to the parent
      and "Step N of M"; parent picker + Brief field in `AddTaskDialog`. A card whose
      chain is live can't be dragged, and a step needing input turns the parent orange.
- [x] **5 — Docs.** This phase entry, the *Plan first, then execute in steps* section
      in [`docs/03`](../03-how-orchestration-works.md#plan-first-then-execute-in-steps),
      the new glossary terms, and the version bump to **0.23.0**.

### Done when

- [x] A card delegated in plan mode actually plans (nothing edited) and stops at a
      **plan approval**; approving turns the plan into ordered steps.
- [x] Steps run strictly one at a time, each in its own session, all on the parent's
      `orch/<parentId>` branch in one shared worktree; only the last step integrates,
      and the parent stays *In Progress* with a review comment.
- [x] Steps can be written by hand (title + brief) and run without a planning round.
- [x] A failed step stops the chain without touching the base branch; **Stop** on the
      parent stops the chain; limits park and resume a step like any other task.
- [x] `pnpm typecheck` (node + web) + `pnpm test` + `pnpm build` green; the pure bits
      (`splitPlanIntoSteps`, `buildClaudeArgs`, `evaluateToolUse`, `groupSubtasks`,
      `buildAgentSubtaskPrompt`, `hasLiveSubtask`, `stepPosition`) and the scheduler
      chain behaviour are unit-tested.
- [ ] **Live E2E still owed:** one plan → approve → multi-step run on the demo
      profile, confirming the CLI really routes `ExitPlanMode` through the permission
      prompt tool under `--permission-mode plan`, and that the UI layout looks right
      (Phase 4 was verified by boot smoke only, never screenshotted).

---

## Phase 12 — Chat with the agent from a card

**Goal.** Let a human open a turn. Until now you could only talk to an agent when *it*
asked: a permission request or an `@@NEEDS_INPUT@@` question parked the run and you
answered it. There was no way to say "actually, skip the cache" mid-run, and no way to
ask a follow-up after one ended. The card's detail pane becomes the conversation.

Ground rules taken with the user: chat is **resume-only** (a card that never ran gets a
hint, not a new conversation — that is what *Assign* is for), it uses the **existing
composer** rather than a second box, and every message is **recorded on the timeline**
as its own activity kind. A chat that resumes is a **real run** — reserved slot, the
chain's worktree, settled and integrated like any other — not a side channel.

### Deliverables

- [x] **1 — Store + send into a live run.** A `chat` variant of `TaskActivityEntry`
      (`task_activity.kind` is free-form TEXT, so no migration) with
      `Store.addChatMessage`; `activityMerge`'s `KIND_ORDER` puts `chat` before `event`
      so a message sorts ahead of the transcript it caused. The pure
      `chatTarget(task, subtasks)` answers "who am I talking to" — a card executing a
      plan holds no session, so the message follows its live **step**.
      `Scheduler.chatWithAgent` records the message, then either resolves a parked
      question through `answerAttention` or writes into the open stdin stream; a run
      held on a permission request or a plan approval is **refused** (prose cannot
      answer approve/deny). `task:chat` IPC returns a typed `ChatSendResult` —
      refusals are normal answers, never exceptions.
- [x] **2 — Resume an idle card.** `Run.chatPrompt` carries the message onto a reserved
      run and `launch` picks the prompt **chat → `RESUME_NUDGE` → full brief**, so a
      resumed session is prompted with what you typed rather than the nudge; a queued
      "AI fix" note is deliberately not consumed by a chat run. `resumeForChat` refuses
      first: `never-ran`, `limit`, and the new `chain-busy` — a card mid-plan holds only
      its *planner's* session, and resuming it would both re-open a finished
      conversation and race the chain for the card's shared worktree (the pure
      `chainInFlight`).
- [x] **3 — The composer.** A **Chat with agent** action, offered only for a delegated
      card, primary while a run is live, with the reason it is off stated above the box
      (a `title` on a disabled button never renders). `taskChat.ts` mirrors the
      scheduler's rules for the button and maps every `ChatRefusal` to a sentence, built
      on `chatTarget`/`chainInFlight` so the two cannot drift.
      `usePendingAttention` lifts the agent panel's inbox subscription into a hook.
- [x] **4 — A parked chain says so.** `parkedStep` / `chainNeedsAttention`: a step that
      is `failed` or `waiting-input` frames its **card** and the step count reads
      `2/4 · stopped`. The agent panel resolves an item belonging to a step (labelled
      "Step 2 of 4 — title") and its buttons still target that step's run, so *Mark
      done* advances the chain and *retry* re-runs the step in the shared worktree.
      Restart safety: `reconcileInterruptedTasks` parks an interrupted **step** as
      `failed` rather than `pending` — nothing re-enters a chain on its own, so
      `pending` left a card at `2/4` forever with nothing to click; the pane offers
      *Run this step again*, which resumes its kept session.
- [x] **5 — The chat-first pane.** Two tabs. **Chat**: turns instead of rows
      (`chat/turns.ts`) — your messages, notes and ticket comments as bubbles on the
      right (one bubble shape; side, fill and a `JIRA` tag carry the meaning), someone
      else's comment left and grey, the agent left, **full width and unbubbled** under
      the `AgentsRegular` glyph, markdown-rendered with fenced code in its own panel
      (language label + copy). A run's tool work folds into one muted line that expands
      to name the sub-agents it spawned; failures are never folded away. The live
      "Agent running" rows sit above the composer, Enter sends / Shift+Enter is a
      newline, and note / ticket-comment move into an overflow. **Details**: status
      control, steps, description, status history. Telling *your* JIRA comments from
      other people's needed an identity — `GET /myself` cached in `app_state` per
      `baseUrl` (the `epicField` pattern); unknown identity means every comment renders
      as someone else's.
- [x] **6 — Docs.** This phase entry, the *Talking to the agent on a card* section in
      [`docs/03`](../03-how-orchestration-works.md#talking-to-the-agent-on-a-card), the
      new glossary terms, and the version bump to **0.24.0**.

### Done when

- [x] A message typed on a delegated card reaches the agent: into the open stream while
      it runs, or via `claude --resume` with your text as the prompt when it is idle.
- [x] Chatting with a card whose step is running talks to **that step**, and the
      composer says so.
- [x] Everything that cannot work says why before you press the button: never ran,
      usage limit, a pending approve/deny, a chain still in flight.
- [x] A failed step surfaces on its card — orange frame, `2/4 · stopped`, and its
      resolutions reachable from the card's own pane — and survives a restart.
- [x] `pnpm typecheck` (node + web) + `pnpm test` + `pnpm build` green; the pure bits
      (`chatTarget`, `chainInFlight`, `parkedStep`, `chainNeedsAttention`,
      `chatAvailability`, `foldTurns`, the markdown reader, `authorIsMe`) and the
      scheduler's chat/chain behaviour are unit-tested (**402 tests**).
- [ ] **Live E2E still owed:** on the demo profile, assign a card, chat into the live
      run, let it finish and chat again (a `--resume` run answering with its context
      intact), and force a step to fail to see the parent's frame and resolutions.
      Every phase here was verified by unit tests + a boot smoke test, never
      screenshotted.

### Deliberate deviations from the plan of record

- **No markdown dependency.** The plan allowed `react-markdown` + `remark-gfm` (MIT,
  clearing `docs/06`). A card-scoped chat needs prose, lists, inline code and fenced
  blocks — about a hundred lines in `chat/markdown.ts` — so the renderer still has
  **no runtime dependency**, no highlighter and no bundle hit. Tables fall back to
  their source text; swapping the module for `react-markdown` touches one component.
- **Three transcript events stopped printing a line**: `started`, `usage`, and a clean
  `exited`. They are bookkeeping; everything else the old timeline showed still shows.

---

## Phase 13 — The workspace refresh

**Goal.** Make the two screens you actually live in — the board and the card's
conversation — feel like a workspace rather than a form. Phase 12 shipped the chat but
put it behind a tab, gave the shell a horizontal tab strip that taxed every screen's
height, and left the detail pane as a stack of bordered boxes. This phase is a design
pass with two real capabilities folded in.

Ground rules taken with the user: the editor is the reference (a nav rail, a coloured
status bar, grey body text rather than white), **shade carries grouping** rather than
borders and rules, and nothing that changes settings may restart a running card.

### Deliverables

- [x] **1 — Two new channels.** `task:setDescription` rewrites the app's copy of the
      ticket body — the text the agent's prompt quotes, so it is real work, but
      deliberately one-way: no write-back, and the next `jiraSync` overwrites it.
      `task:setAgentOptions` changes model / permission mode **without** restarting the
      card (unlike `task:assignAgent`); a live run keeps what it captured at start, so
      the change decides what the next run uses. Both emit `task:changed` with a null
      `runId`, since neither belongs to a run.
- [x] **2 — The shell.** The horizontal `TabList` became a **vertical icon rail** (seven
      destinations, glyph-only, each label a tooltip and its accessible name; the
      Attention badge is the one label left). The footer became a **status bar**: full
      window width, one line, coloured rather than bordered — the editor's blue at rest,
      the app's orange with a *"N waiting on you"* count the moment anything is parked.
      The shell stopped padding its content region: every screen but My Tasks re-adds it
      locally, so the detail pane can run to the window's edge. Body text is the editor
      grey `#CCCCCC`, not Fluent dark's pure white — at this density white glares and
      every word reads as emphasis; headings still stand out by weight. Brand / danger /
      success surfaces are untouched, so their contrast ratios stay stock Fluent's.
- [x] **3 — One pane in two halves.** The Chat / Details tabs are gone. A fixed band
      carries the card's identity (type glyph — the board card's own, exported —, title,
      ticket key as a link, type · priority · phase), the agent controls, the new
      `TaskDetailsCell` and the steps; capped at 50% height with its own scroll so a long
      chain cannot crowd out the chat. The conversation below is the only thing that
      scrolls, and it is **unframed** — a box around a chat is a box around the pane.
      `TaskAgentPanel` and `TaskSteps` dropped their frames to become sections of the
      band; the parked-ask block kept its orange one, because that is an alert.
- [x] **4 — A composer you can set up in.** One surface holding the text area and all
      three actions — chat / note / ticket comment — which were in an overflow menu that
      made a two-click job of a one-click one. Under it, a muted strip naming who runs
      the card, with **model** and **permission mode** editable in place (deliverable 1),
      titled to say the change applies to the next run.
- [x] **5 — Editing the description.** `TaskDetailsCell`: status, dependencies, and a
      **foldable, editable** description — folded by default, because on a JIRA card it
      is twenty lines you have already read. The one-way caveat is stated where you type,
      not in the docs only.
- [x] **6 — Shade, not borders.** The detail pane is one surface a step **lighter** than
      the board, and the gap between them is gone: the change of shade is the seam.
      Board cards flipped the same way — a card is the object, the column is the space
      between objects, and the darker fill had that backwards.
- [x] **7 — A demo profile to design against.** `pnpm dev` opens the **real** database,
      so there was no way to fill every screen with content for a design pass without
      polluting it. `seed-demo.cjs` seeds a separate user-data profile instead.

### Done when

- [x] The board and the chat pane both gain the height the tab strip was taking, and no
      screen lost its margins.
- [x] Something waiting on a human is visible from the status bar on **every** screen,
      not only the Attention tab.
- [x] A card's description is editable from the card, and the JIRA caveat is stated at
      the point of the edit.
- [x] Model and permission mode are changeable from the composer, and doing so during a
      live run neither restarts nor perturbs it.
- [x] `pnpm typecheck` (node + web) + `pnpm test` green (**402 tests**), Prettier clean
      on every touched file.
- [ ] **Live E2E still owed** (carried over from Phase 12 and extended): on the demo
      profile, walk the rail, watch the status bar turn orange on a parked ask, edit a
      description and see the next run's prompt quote it, and switch model mid-run to
      confirm the live run is untouched and the next one obeys.

### Deliberate deviations from the plan of record

- **No new tests.** This phase is presentation plus two thin store-backed channels; the
  pure logic it touches (`chatTarget`, `foldTurns`, `stepPosition`, `chatAvailability`)
  was already covered, and neither new handler has behaviour beyond a trim and a write.
  What is owed here is the live E2E above, not unit tests.
- **Docs are part of the phase, as always** — this entry, the rewritten *One pane, two
  halves* and *Sending* sections in [`docs/03`](../03-how-orchestration-works.md#talking-to-the-agent-on-a-card),
  four new glossary terms, and the version bump to **0.25.0**.
- **The repo is not Prettier-clean.** 27 files predating this work still fail
  `prettier --check`; reformatting them would have buried a design pass in whitespace.
  Every file this phase touched passes.

---

## Phase 14 — Sprints on the board

**Goal.** Let the board answer "what am I meant to be doing *this* sprint?" — the JIRA
question the Personal board could not express, since its JQL was a fixed query with no
notion of what is currently in flight.

Decisions taken with the user: the board stays a **personal** view (the sprint filter
narrows the existing `assignee = currentUser()` query rather than replacing it with a
team view), and "current" is resolved through **JQL `openSprints()`** rather than the
Agile API — no board to configure, it works on Cloud and Server/DC alike, and it needs
no new endpoint on an instance that may not expose Agile at all.

### Deliverables

- [x] **1 — JQL composition** (`src/main/jira/jiraSprint.ts`, pure). `withCurrentSprint`
      inserts `AND sprint in openSprints()` *before* any `ORDER BY` — JIRA rejects it
      after — and parenthesises the existing filter, so a query ending in a top-level
      `OR` is narrowed rather than quietly widened. `splitOrderBy` scans for the keyword
      outside quotes, so `summary ~ "order by tuesday"` is not cut in half.
- [x] **2 — The sprint field.** The sprint an issue is in lives in a per-instance
      Greenhopper custom field, exactly like "Epic Link" — discovered once via
      `GET /field`, cached in `app_state` by base URL, and failing soft to "no sprint".
      `sprintNameFromIssue` reads both the modern object shape and the legacy
      `Sprint@1a2b[name=…,state=ACTIVE]` string older Server/DC still emits, preferring
      the running sprint over the closed ones an issue also carries.
- [x] **3 — The card.** New `Task.externalSprint` (additive `TEXT` column, NULL on every
      existing row) is filled by `jiraSync` with the same don't-wipe-what-we-knew
      fallback the epic and description use, and shown as a quiet chip beside the label
      chip, so the board says *which* sprint you are looking at when several run at once.
- [x] **4 — The switch.** `JiraSettings.currentSprintOnly` (default off) drives a
      **Current sprint** toggle in the board toolbar, shown only when JIRA is enabled.
      Unlike "Show Done" it changes the query the next fetch runs, so toggling it
      re-syncs immediately rather than appearing to do nothing; the Settings JQL hint
      says so while it is on.

**Notes.**

- The filter is composed at sync time and never written into the user's JQL, so turning
  it off restores their own query untouched.
- The sprint field is requested whether or not the filter is on: the name is worth
  showing either way, and `openSprints()` can span several concurrent sprints.
- Shipped as **0.26.0** — a minor bump, since this adds a capability rather than
  fixing one (0.25.1–0.25.3 were the Linux and JIRA Cloud patches before it).

---

## Phase 15 — The board grows up

**Goal.** Eight changes the board needed before it could carry a real week's work: it
could not express "waiting on a reviewer", it could not be told what your project calls
that status, priority was something to look at rather than something to set, cards sat in
whatever order JIRA first returned them in, and there was nowhere to write down where you
actually are on a card.

Decisions taken with the user: the status map is keyed by **status name, globally** (one
table covers "Review"/"In Review"/"Code Review" across every project); priority **writes
back to JIRA**, tracker first so a rejection leaves the card alone; a status update is
**free text** with a keyword vocabulary supplying the colour; "project" is the existing
**agent project**, which gains a colour and can now be set without starting a run; and
the attention/selection frames became **rings outside the box**, so clicking a card
never moves its own text.

### Deliverables

- [x] **1 — The IN REVIEW column.** `TaskStatus` and `BoardColumn` gain `in-review`;
      both mapping switches are exhaustive, so the compiler found every other surface.
      Five columns need no layout change — the board is a `gridAutoFlow: column` grid.
- [x] **2 — The JIRA status map** (`columnForJiraStatus`/`lookupStatusColumn` in
      `src/shared/board.ts`, pure). JIRA's three status *categories* cannot express IN
      REVIEW — every review-ish status shares `In Progress` with the one that means
      "being written" — so the column is reachable only through a per-status-name map,
      matched case-insensitively, with the category as the fallback. The setting
      (`statusCategoryOverrides`) already existed and had never had a UI; it now has one,
      edited as an ordered list (`statusMap.ts`) because renaming a record key under the
      cursor reorders the rows. The same map picks the *outgoing* transition, which also
      fixed a live bug: `toInProgress` took the first `indeterminate` transition, so a
      workflow listing "Code Review" first would take an IN PROGRESS drag to review.
- [x] **3 — Status notes.** A free-text line per card (`Task.statusNote`), posted from
      the composer, filed on the timeline as a `status-note` entry so the ones it
      replaced stay readable. Settings holds a keyword→colour vocabulary
      (`src/shared/statusKeywords.ts`, first match wins in the user's order); a note
      matching nothing keeps the card's ordinary colour, so the vocabulary is an accent
      rather than a requirement.
- [x] **4 — Editable priority.** `JiraClient` had no issue-update method at all; it gains
      `setPriority` (`PUT /issue/{key}`) and `listPriorities` (both the v2 array and the
      Cloud v3 `{values}` shape). `task:setPriority` writes JIRA **first**, so a rejected
      edit never leaves the card claiming a priority the ticket does not have. Fixed
      alongside: `jiraSync` set `externalPriority` with no fall-back, so a search that
      omitted the field silently wiped it.
- [x] **5 — Sorting that means something** (`sortCards`). Cards that want you first —
      the same `chainNeedsAttention` that draws the orange ring, so the loudest card is
      always the top one — then priority, then `order` as a stable tiebreak. Priority
      colour and priority rank now come from one bucketing function
      (`src/shared/priority.ts`), which also fixes `"Highest"` falling into the `high`
      bucket because it contains it.
- [x] **6 — No card frames.** The grey border is gone: the card's brighter fill against
      the column is edge enough, and the frame fought the state rings for the same
      pixels. Attention and selection became `box-shadow` rings — outside the box, so
      no reflow — including an explicit both-states class, since two Griffel classes
      would have the later one *replace* `boxShadow` and drop the orange from exactly
      the card that was shouting.
- [x] **7 — One shape, top to bottom.** The composer and the live-run rows moved into a
      full-bleed bottom band matching the details band at the top. The pane now reads as
      two fixed bands with the conversation scrolling between them.
- [x] **8 — Project colours.** `Project.color` (a fixed palette, `ColorSwatches`) paints
      a stripe along a card's top edge. Filing a card under a project needed a channel of
      its own: `task:assignAgent` sets the same field but also clears the session and
      launches a run, and saying "this is a Billing card" is filing, not delegating.

**Notes.**

- `blocked` stays internal-only throughout: it is never a valid map target, and moving
  to or from it still never touches the tracker (the ticket stays In Progress).
  **Superseded** — the phase that fixed "moving a task to IN PROGRESS blocks it in JIRA"
  ended this rule on both halves: a workflow's `Blocked` status resolves to the column
  (`isBlockedishStatus`), the column is mappable, and a drop into it transitions the
  ticket where the workflow can express it. The rule was the bug's hiding place: the
  resolver could not read a Blocked status, so a card dragged into IN PROGRESS took a
  `Block` transition and the sync then filed the result by category.
- A JIRA re-sync must not clear what the human wrote, so `statusNote`/`statusNoteAt`
  join the agent-delegation and subtask columns that `upsertJiraTask` deliberately omits.
- Shipped as **0.28.0** — a minor bump: this adds capability rather than fixing it.

---

## Phase 16 — Seventeen fixes and two integrations

**Goal.** A week of using the board in anger produced one list: three bugs (two that made
the IN REVIEW column unusable, one that confused filing a card with delegating it), nine
gaps in the workspace, three in the JIRA comment thread, auto-update, and a GitLab
integration that puts your merge requests on the card their ticket lives on.

Worked **one item per session**, in the order the user listed them, each its own commit
and each green (`pnpm typecheck`, `pnpm test`, `pnpm build`) before it lands. Decisions
taken with the user: full `electron-updater` against GitHub Releases; merge requests
discovered from `scope=created_by_me` and matched to a card by the JIRA key in the branch,
title or description; MR attention raised by comments **and** red pipelines **and**
changes-requested; a GitLab poller with its own interval (default 2 min); JIRA issue
creation driven by live project/issue-type pickers rather than a configured default; the
project/agent split keeps a card delegated only where a real run left evidence; and the
sprint chip stays on cards while the sprint filter is off.

### Deliverables

- [x] **1 — The card that stayed half-transparent.** Dropping a card in another column
      re-parents it (the optimistic patch moves it between `KanbanColumn`s), so the node
      the drag started on unmounts and its `dragend` never reaches React's root — the
      remounted card kept `opacity: 0.5` until the next drag. `draggingId` is now cleared
      on the drop itself and on the columns container, which never unmounts, so an
      ESC-cancelled drag and a refused move are covered too.
- [x] **2 — IN REVIEW survives a sync** (`src/shared/statusResolve.ts`, pure). The two
      halves of a move disagreed: the outgoing transition could be picked by the status
      NAME (any `indeterminate` transition called something-review), while the incoming
      sync read the same status by its CATEGORY — and JIRA files review statuses under
      `In Progress` with the one that means "being written". So the drag worked, the
      ticket really moved, and the next sync put the card back. Both paths now call one
      `resolveStatusColumn` with four tiers — `explicit` (the Settings map), `learned`,
      `heuristic` (a review-named indeterminate status), `category` — which also
      subsumes the hand-written guard against IN PROGRESS grabbing a review transition.
      A successful drag now *teaches* the map (`jira.learnedStatusColumns`), pushed to
      the UI on a new `settings:changed` event so a screen that saves the whole settings
      blob cannot write over what the engine learned.
- [x] **3 — Auto-update.** `electron-updater` + `publish: github`; space-free artifact
      names (`gh` rewrites spaces to dots, which breaks the `latest.yml` feed); a pure
      `updateMode()` so a `.deb` install degrades to "manual" instead of erroring every
      launch. `src/main/updater.ts` folds the updater's events into one `UpdateState`
      pushed on `update:changed`; a downloaded build offers a restart from the status bar
      and installs on quit either way, and every failure goes to the log rather than a
      dialog. Settings → General → Updates carries the state, the progress and *Check
      now* — or, on a `manual` install, a link to the releases page. `pnpm package` now
      publishes `onTagOrDraft`; `pnpm package:local` is the upload-nothing build.
- [x] **4 — An empty detail pane says so with a glyph**, not a sentence.
- [x] **5 — The detail pane can be hidden** (`showTaskDetail`, on by default).
- [x] **6 — The window remembers its size and whether it was maximized**, cooperating
      with the frameless title bar and the WSLg manual-maximize fallback.
- [x] **7 — A viewer for the status map**: every status the instance reports, the column
      it resolves to, and *which tier decided* — the surface that would have made item 2
      obvious.
- [x] **8 — Create a card as a JIRA issue**, reading the created issue back through
      `issueToTask` so it is identical to a synced one.
- [x] **9 — Your own comment must not shout.** `latestCommentAt` ignores authorship, so
      a comment you post in the JIRA web UI lights your own card orange.
- [x] **10 — @mentions and attachments when commenting** (a real ADF builder, user
      search, and a multipart upload path).
- [x] **11 — Mentions and attachments on incoming comments.** The ADF flattener collects
      only `text` leaves, so a mention's label is dropped entirely today.
- [x] **12 — GitLab.** A `merge_requests` table, a client/sync/poller mirroring the JIRA
      ones, MR rows on the card and a rich list in the pane, and MR attention folded into
      `chainNeedsAttention` so the ring and the card ordering cannot disagree.
- [x] **13 — Any colour for a project.** The fixed eight-swatch palette stays as the fast
      path; a custom chip beside it opens Fluent's own `ColorPicker` plus a hex field.
      `onChange` keeps its signature, so the status-keyword editor gets it for free.
- [x] **14 — Filing a card is not delegating it.** `task:setProject` and
      `task:assignAgent` write the same `agentProjectId` column, so merely tagging a card
      as "a Billing card" gives it the agent glyph and makes `resolveAgentProject` treat
      it as an explicit human assignment. Split into `projectTagId` (what the card is
      about) and `agentProjectId` (where a delegated run happens), with a **one-shot**
      guarded back-fill that keeps a card delegated only where there is evidence of a
      real run — a session id, an agent mode/model, or a saved plan.
- [x] **15 — The project stripe is clipped at the top of the board.** Two candidate
      causes (no breathing room under the sticky column header at rest; a card sliding
      *under* that header on scroll, where the 3px stripe is the first thing lost).
      Reproduce before choosing between padding and `scroll-margin-top`.
- [x] **16 — A heavier attention ring.** Already 2px, but it is a shadow painted outside
      the card against a dark column, so it reads thin. 3px, with the selected+unread
      stack widened to match so the brand ring still sits outside the orange one.
- [x] **17 — The sprint name belongs in the status bar.** With the sprint filter on every
      card carries the same chip; move the name to the blue footer and keep the chip only
      while the filter is off, which is when it distinguishes anything. Derived by a pure
      `currentSprintName(tasks)` that returns null when the cards disagree, so the bar
      can never claim a sprint the board is not showing.

**Worked in one run** rather than one item per session, at the user's request. The
order was the user's, with two swaps: item 9 was pulled ahead of item 8 (both JIRA, and
9 is a one-line bug), and items 10–11 ahead of item 8 so the ADF module existed before
the issue-creation path that reuses it for a description.

- [ ] **Live E2E still owed** for the whole phase — see the per-item checks in the plan
      file's Verification section. The biggest are item 3's updater feed (a local
      `http-server` against an installed build, then a draft GitHub release), item 12's
      GitLab round trip (open an MR with the ticket key in the branch, break the
      pipeline, comment as someone else, mark read), item 14's one-shot back-fill on a
      real database, and items 15–16, which are the only two decided by eye.

---

## Phase 17 — Ask me, and show me what you are doing

Eighteen problems and twenty-two requests, from one session of real use. They are not
independent bugs: most of them are the same two failures wearing different clothes.

**The app answered for the human.** `AskUserQuestion` is an ordinary tool call, the risk
policy waved it through (it neither deletes, pushes, nor reads secrets), and a headless
CLI with no terminal resolves its own question by taking its recommended option. So the
agent asked, nobody saw it, and the run continued as though it had been answered. Items
1, 2 and 14 are that.

**The app would not say what it was doing.** A spinner derived from `Task.status` cannot
show a run that has spawned but not yet been persisted as running; an orange ring derived
from status plus JIRA timestamps cannot show an inbox item raised without that status
flip. So work happened in silence and cards wanted attention in silence. Items 3, 5, 12
and 18 are that.

The rest is honest UI debt (the card, the settings pane, scrollbars, markdown) and two
real behaviour bugs: a card moving itself to Done, and merge requests never refreshing.

### Problems

- [x] **1 — Every question the agent asks reaches the Details Panel.** Raised as a new
      `agent-question` attention kind carrying the CLI's real questions, options and
      descriptions — not squeezed through the flat `options: string[]` of the prose
      sentinel, which would throw away exactly what makes the form readable.
- [x] **2 — A question is never auto-answered.** Held at the permission broker, above
      the `bypassPermissions` shortcut: "never ask me to approve tools" is not "answer my
      questions for me", and full-auto is precisely the mode where nobody is watching.
      "You decide" exists, but only as an explicit act — never as a timeout.
- [x] **8 — Steps get titles that say something.** The splitter split on `## Phase 1`
      and then used the heading verbatim, so a well-formed plan named none of its steps.
      Fixed at both ends: the planning prompt says headings become titles, and
      `toSubtaskTitle` falls back to the body when a heading is pure structure.
- [x] **9 — A finished chain hands back to the card.** Summary filed on the parent's
      timeline, and a *fresh* session briefed so the card can be talked to again — not
      the planner's session, which was deliberately stopped and whose context predates
      every line the steps wrote.
- [x] **10 — Agents run on a named branch.** `<prefix>/<type>/<key>/<slug>`, prefix
      configurable, type inferred from the ticket and title, validated at assign time.
      An empty prefix yields no leading slash; a card with no ticket omits that segment.
- [x] **11 — Assign, or assign and start.** Staged assignment persists and stops; the
      first message to a staged card starts it, so it is not a dead end.
- [x] **13 — A tool failure says what failed.** Reason carried on the event; failures the
      agent routinely fixes next turn are folded into the tool row rather than
      interrupting the thread.
- [x] **14 — `Usage limit: allowed (five_hour)` is gone.** Healthy statuses are dropped
      at the emit boundary; a real block is said in words.
- [x] **3 / 12 — The spinner and the running status.** `runPhase` is the one answer,
      shared by the card, the detail pane and the composer strip. It also fixed a smaller
      lie: a card WAITING FOR YOU rendered "Agent running" with a spinner over it.
- [x] **5 / 18 — The orange ring, for as long as it is owed.** Driven by the inbox, which
      is authoritative; `sortCards` reads the same set, so ordering and ring cannot
      disagree.
- [x] **4 — A card never moves itself to Done.** Already true on both settle paths, and
      pinned by a test — the parent stays `in-progress` after its final step merges.
- [x] **6 — Merge requests refresh, with pipeline and approval as separate icons.** The
      Sync button now covers every enabled service; it was called "Sync JIRA" while
      GitLab was refreshed only by its own poll, which is why rows sat stale.
- [x] **7 — Top padding on every column.** A selected card that also wants you stacks 5px
      of ring OUTSIDE its box, and that stack was being clipped by the column's bounds.
- [x] **15 — A merge request that wants attention gets a tint, not a border.**
- [x] **16 — Subtask rows take the card's background,** not the board's.
- [x] **17 — The card, properly.** Steps and merge requests are sections of the card.
- [x] **19 — Answering an agent from the Details Panel.** (Added mid-phase.) The panel
      dropped asks: it showed only the first and blanked the slot on resolve.
- [x] **20 — Integration is manual, and its ask can end.** (Added mid-phase.)
      `autoIntegrate` defaults off; a finished branch waits for a Merge button. The retry
      loop gains "Leave the branch (stop asking)".

### Requests

- [x] **1 — Configurable font size.** Two mechanisms from one number: `scaleTheme`
      multiplies Fluent's type ramp, `--app-font-scale` covers the px sizes in
      `makeStyles` that tokens cannot reach.
- [x] **2 / 18 — Markdown everywhere, and readable agent output.** The plan shown for
      approval was rendered as raw markdown SOURCE — the least readable thing in the app,
      and the one thing you must read before answering. Code moved to a blue-tinted
      surface: on the pane's dark grey the neutral fill was invisible, which is the
      "some words have a background, others do not" complaint (they all did).
- [x] **3 — Priority, project and state on one row.**
- [x] **4 / 5 — The JIRA badge carries the unread signal and the JIRA mark.**
- [x] **6 — A status string can be cleared.** The engine always accepted it; the UI
      rejected the empty post.
- [x] **7 — Nav rail icons: square tiles, twice the size.**
- [x] **8 — The orange footer is readable, and the live dot reads on both fills.** The
      old green sat at ~1.6:1 on the blue and ~3.2:1 on the orange — invisible on both.
- [x] **9 — Settings full width.**
- [x] **10 — The status-map "Why" badge stops overflowing.**
- [x] **11 — Projects and Board tabs removed.** The screens are gone; the ENGINE's notion
      of a project stays, because that is how runs are queued and worktrees are cut — the
      personal board is itself a project.
- [x] **13 — Thin, rounded, trackless scrollbars** that fade in on hover of the scrolling
      element (not of the scrollbar — an 8px target you must already be touching to make
      visible is not a target).
- [x] **14 — The question form is worth reading.** `AgentQuestionForm`.
- [x] **17 — Toasts for what needs attention,** switchable in Settings.
- [x] **19 — One Sync button** covering every enabled service.
- [x] **20–22 — Labels, project name and epic are switchable,** from a Display menu on the
      board as well as from Settings — the board is where you notice the noise.

- [x] **12 — Scratch Run holds several runs,** one card each, newest first, each with its
      own transcript, status and Stop. A collapsed card is HIDDEN rather than unmounted:
      `Transcript` replays persisted history only for a `taskId`, and a scratch run has
      none, so unmounting would throw away everything that run had said.
- [x] **15 — The content-heavy dialogs become Drawers.** The agent-project editor and the
      attach-session picker; the short forms stay dialogs, where a drawer would be a lot
      of chrome around four fields.
- [x] **16 — Skeletons while loading.** The board gets columns of cards, the inbox and
      agent list get rows. Screens whose layout depends on what arrives keep the spinner —
      guessing the shape wrong is worse than not guessing.
- [x] **22 (the NAME) — the epic's name, not its key.** Inline `parent.fields.summary`
      where JIRA sends it free; otherwise ONE `key in (...)` lookup for every distinct
      epic on the board. Fails soft to the key.

**Shape of the work.** Contract and engine first (shared types, the four pure modules,
then the engine and IPC), renderer groundwork second (`theme.ts`, `useAttentionIndex`,
`useActiveRuns`), components last. Everything ticked above is green and committed.

- [ ] **Live E2E owed for the whole phase**, and it is the only way to check the two
      that matter most: that a question really blocks its run, and that a spinner really
      turns while one is working.

---

## Phase 19 — Setting a chain of execution

**Goal.** Let the board say what **order** the work has to happen in. A board has only
ever said what there is to do: two cards that must land in sequence — one touching a file
the other rewrites, one that cannot start until the other's branch is in — look exactly
like two independent cards, and the ordering lives in the head of whoever set the work up.
A chain writes it down as an arrow between two cards, and then *runs* it: when the first
card's work lands, the second one starts by itself.

Decisions taken with the user: an arrow is drawn **between whole cards**, never between a
card's steps (their order already *is* a chain, and a second one could only disagree); the
ordering carries a **gate**, because "after" means two different things (after the branch
*merges*, or stacked on the branch as soon as it stops being *rewritten*); a chain
**never moves a card between columns** — where a card sits stays the human's, exactly as
for every other run; and the arrows live **on the board**, not in a list, because
"what runs after what" is a shape.

### Deliverables

- [x] **1 — The edges, and what they wait on** (`75c740b`). A `task_links` table — one row
      per arrow, `ON DELETE CASCADE` from both ends so deleting a card cannot leave an arrow
      pointing at nothing, indexed in both directions (the engine asks *who follows me*, the
      board asks *what am I waiting on*). `tasks.landedAt` is the fact `after-merge` waits on,
      **stored** rather than derived: an MR list a poll behind, or a card dragged back out of
      Done, must never pull a successor's start out from under it. All the graph logic is
      pure and shared (`src/shared/taskChain.ts`) so the board and the engine answer from the
      same functions — cycles refused as an edge is drawn, steps refused at either end, and
      an **AND-join** so a diamond waits for both arms rather than the first.
- [x] **2 — The arrows** (`96c7825`). One `<svg>` over the whole board, an absolutely
      positioned child of the single scrolling column strip, so the arrows share the cards'
      coordinate space and no seam has to be stitched between columns. An arrow leaves and
      enters the two edges that **face each other** — a board's chains mostly run *backwards*
      (the working card is in In Progress, the card waiting on it is still in To Do, to its
      left), so "right edge to left edge" dragged the commonest arrow straight across its own
      target. A same-column link loops out into the gutter. The ink budget: a 1px neutral
      hairline at rest, 2px accent for the whole route through a selected or hovered card,
      dashed while waiting, cyan and travelling while the predecessor runs, a double hairline
      for `stacked`. An endpoint the board is not showing becomes a counted stub into the
      board's edge, never a line to nowhere.
- [x] **3 — The gesture** (`258b1ae`). A handle on the card's right edge, dragged onto the
      card that runs after it, reusing the board's own drag-and-drop. The two gestures are
      told apart by the DataTransfer's **type** (`application/x-chain-link` vs `text/plain`)
      and never by where the pointer is — `dragover` may not read the payload, but it can
      always see the type list — and the column stands aside for a link, so drawing an arrow
      across a column no longer also moves the card. Every card is marked valid /
      already-linked / refused when the drag *starts*, asked of `@shared/taskChain`, so the
      refusal under the cursor is the one the handler would give. The handle is a real
      button: Enter arms a link the next card completes. An arrow can be selected, re-gated
      from a panel on its middle, and erased with Delete.
- [x] **4 — The release engine** (`172e989`). `src/main/chainRunner.ts`, owned by
      `Scheduler` the way `WorktreeManager` is, so `scheduler.ts` gains three calls rather
      than another feature's logic. `landedAt` is stamped by a local integrate **and** by a
      linked merge request GitLab reports as `merged` — on a project whose branches go
      through review, the second is the only way the app learns the work shipped. A
      `stacked` edge fires earlier, from where `settle` sees a card's run succeed, and the
      successor's worktree is cut from the predecessor's branch (`prepare` takes an optional
      start point; the returned `base` is unchanged, so integration still targets the
      project's base branch). Guards: a usage limit holds a release as it holds
      `advanceSubtasks`; a stopped or cancelled predecessor releases nothing; only a
      `pending`, assigned, never-run card is started, and everything else gets a timeline
      note naming what released it and why nothing started. **Release now** in the pane
      overrides the gate by hand. The card grows a monochrome `waiting on KEY` chip, and
      `ready` when the gates are met but nothing has started.
- [x] **5 — One chain at a time** (`ea15835`). A **Chain focus** toggle beside Display
      filters the board to `chainComponent(links, selected)` — the card, everything upstream,
      everything downstream, undirected, because "show me this and everything it is entangled
      with" includes the sibling branching off a shared predecessor. The board's real columns
      throughout: a chain is not a pipeline of its own. Local state, not a saved setting — a
      board reopening with three of your twenty cards, for a selection you no longer remember
      making, reads as lost work. Its two companions are the pane's **Chain** section
      (*Waiting on* / *Releases*, each row a real button naming the gate, with an unlink —
      the keyboard's route to what dragging does) and *Add task*'s **Runs after…** picker.
- [x] **6 — The documentation, and the release.** A *Chaining cards* section in
      [`docs/03`](../03-how-orchestration-works.md#chaining-cards) — the chain-versus-steps
      table, the two gates, the board's vocabulary and what the engine does when a
      predecessor finishes — and five new glossary entries (*chain*, *link*, *gate*,
      *stacked branch*, *landed*). Doc 03's older use of "chain" for a card's own steps is
      now spelled **step chain**, so the two senses can be told apart.

### Done when

- Drawing an arrow between two cards survives a restart, and deleting either card takes
  the arrow with it.
- A card whose predecessor has not landed shows `waiting on …`, and its arrow is dashed;
  when the predecessor's branch merges, the card starts on its own and its timeline says
  which card released it.
- A `stacked` successor's worktree contains the predecessor's commits, and still merges
  into the project's base branch.
- Neither a cycle nor a step can be linked, from any of the three routes (drag, keyboard,
  *Runs after…*), and the refusal is a sentence rather than a snap-back.
- No release ever changes a card's column.
- `pnpm typecheck`, `pnpm test` and `pnpm build` are green.

**Notes.**

- Shipped as **0.51.0** — a minor bump: new capability. (The plan said 0.50.0, which
  `development` had already released while this branch was open.)
- Deliberately **not** `Task.dependsOn`: that is a plan project's `@needs:` clause, matched
  by title within one parsed plan file and re-derived on every sync. These are edges between
  arbitrary cards, drawn by a human, that survive a re-sync.
- Two known gaps left standing on purpose: the dangling-end count chip is dropped in the
  leftmost column (a card there has ~4px to its left, and nothing fits — the count stays in
  the path's `<title>`), and the `stacked` double hairline collapses to one line on the
  near-vertical middle of a gutter loop, still reading as double where it meets its cards.

- [ ] **7 — Live E2E owed.** Steps 1–4 were checked by eye on the demo profile; step 5's UI
      has not been looked at yet. The two that only a live run can settle are the GitLab half
      of `landedAt` (a real MR merged, releasing a card that was never touched locally) and a
      `stacked` successor's worktree actually containing the predecessor's commits.

---

## Phase 20 — Auto-release

**Goal.** Finish the job. A merge is where the orchestrator has always stopped, and for a
repo that knows how to release itself that is one step short: the work is in the base
branch, and what a human then does is the same every time. So — when a card's branch
merges, optionally carry on and release it.

Decisions taken with the user: the app decides **when**, the repo decides **how** — the
recipe lives in the repo's own `RELEASE.md`, and there is deliberately no release
procedure in this codebase; the switch lives on the **card** (Details Panel), with the
**project** carrying the preference a card starts from; and a release **never moves a
card**, exactly like every other run.

### Deliverables

- [x] **1 — The contract, and the two switches.** `src/shared/release.ts` — `RELEASE_DOC`
      and `autoReleaseOn(task, project)`. `Project.autoRelease` is a boolean preference;
      `Task.autoRelease` is `boolean | null`, and the `null` is the point: a card that has
      never been switched **follows** its project, so turning the preference on later turns
      it on for every card nobody has ruled on. Both migrate in as off/null, so no upgraded
      install starts releasing anything by itself.
- [x] **2 — The engine.** `applyIntegrationResult`'s `merged` branch asks
      `startReleaseRun`, which checks the switch, checks `RELEASE.md` is actually on disk
      (`existsSync` through `appProjectFile`, so a WSL project's path is named the way this
      process can open it), and starts one more turn on the card's own session with
      `buildReleasePrompt`. It runs in the project directory, never a worktree — the branch
      has just been merged and deleted, and what is being released is the integration
      branch. `IntegrationResult.merged` gained `refMoveOnly`, so a project whose base is
      not checked out gets told to check it out first rather than releasing whatever the
      checkout happened to be on.
- [x] **3 — Settling it as a release, not as the work.** A `releaseSeed` run settles first
      and quietly: no integration (there is no branch left), no auto-retry, no failed-task
      park, no column change. A failure files what happened on the timeline and stops —
      re-running half a publish is how you get two tags for one version. Ordered **before**
      `finishParentChain` on purpose: starting the release reserves the card, and the chain
      hand-back already declines to seed a card that is in flight, so a released card gets
      one session rather than two talking over each other.
- [x] **4 — The UI.** A *Release after merge* switch in the card's Agent panel, offered on
      the same terms as the Merge button and hinting what will happen — including "this repo
      has no RELEASE.md yet", answered by a new `project:hasReleaseDoc` channel rather than
      guessed. *Release after merge by default* on both project forms. Choosing what the
      project already prefers stores `null`, which puts the card back to following it.
- [x] **5 — The file, and the docs.** A real [`RELEASE.md`](../../RELEASE.md) for this repo,
      written for an unattended agent: green gates, stop-and-ask for anything needing a
      credential or a decision, promote-last, and an explicit hand-back for the platform it
      cannot build. A *Releasing after the merge* section in
      [`docs/03`](../03-how-orchestration-works.md) and two glossary entries.

### Done when

- A merged card with the switch on starts exactly one release run, in the project
  directory, prompted with `RELEASE.md`.
- A project with the preference on and no `RELEASE.md` releases nothing and says so on the
  card's timeline.
- A card can opt out of a releasing project, and into a non-releasing one.
- A failed release leaves the card exactly where the human left it.
- `pnpm typecheck`, `pnpm test` and `pnpm build` are green.

**Notes.**

- Shipped as **0.52.0** — a minor bump: new capability.
- Scoped to the **local** integration path (`applyIntegrationResult`), which is every merge
  the app performs. A card that lands because GitLab reported its MR merged sets `landedAt`
  and releases its chain, but does not trigger a release run: nobody merged it here, and
  the tree it would release from may be a poll behind.

- [ ] **6 — Live E2E owed.** Nothing here has been through the UI: the switch's inherit
      behaviour, the "no RELEASE.md" hint, and above all a real release run following this
      repo's own `RELEASE.md` end to end.

---

## Phase 21 — Starting the next card automatically

**Goal.** Phase 19 built the release engine and wired it to the three moments the world
changes: a branch landed, a run finished writing, the app booted. That list turned out to
be short. A card can also become releasable because a usage limit lifted, because someone
erased the arrow that was holding it, or because a human dragged it back to To Do — and in
every one of those cases the chain sat there until the next restart, because `sweep` was a
boot-time thing rather than a question the engine could be asked at any moment. The other
half is the same silence read from the other end: a card that is waiting says *waiting on
KEY*, but the card it is waiting **on** says nothing at all about the queue it is holding
up, and the merge that would release it takes a human going and finding it.

**Decisions taken with the user** — all three flag rather than block, which is what this
phase's first commit is:

- **Unlinking the _last_ arrow into a card does not start it.** The re-ask looks only at
  cards that still have an incoming arrow, so erasing one of several arrows releases the
  card (the reported gap), while erasing the last one leaves it alone. A card with no
  arrows is not the chain's business, and a cleanup gesture that spawns an agent is a
  surprise — the wrong kind of automatic.
- **`task:assignAgent` gets no re-ask, on purpose.** Its default branch already calls
  `runTask`; the only branch that assigns without starting is `start: false`, which is the
  human deliberately staging the card to talk to it first. Re-asking the chain there would
  start exactly the run they just declined to start. A comment at the handler says so, so
  the omission reads as a decision rather than an oversight.
- **No tag and no release on this branch.** [`RELEASE.md`](../../RELEASE.md) rule 5
  forbids releasing from anything but the integration branch, and a tag pushed from a
  feature branch cannot be moved afterwards. Every commit here still bumps `version` in
  `package.json` per [`CONTRIBUTING.md`](../../CONTRIBUTING.md) §4 — the bump is the
  commit's business, the tag is the integration branch's.

### Deliverables

- [x] **1 — The decisions.** This entry, and the deliberate-omission comments at
      `task:assignAgent` and `chain:unlink`, written where the later steps will be editing.
- [x] **2 — The boot sweep becomes a general re-ask.** `ChainRunner.reconsider(trigger)`
      can be asked at any moment, with `sweep` as its boot-time caller rather than its only
      one, and each trigger naming its own cause on the timeline.
- [x] **3 — A lifting usage limit restarts card chains.** The gate already resumes parked
      sessions and steps; a card released while the gate was up has nothing parked to
      resume, so it needs the re-ask. `resumeParked` ends with it — after the parked set
      has re-reserved its slots and the queues have been pumped, which is what makes a
      second start impossible. It is the one place all three lifts (the timer, *Resume
      now*, and a restart finding no saved gate) pass through.
- [x] **4 — The arrows changing re-asks the chain.** Drawing an arrow, erasing one, or
      re-gating one can satisfy the last thing a card was waiting on, and none of the three
      changes anything about a CARD, so nothing else would ever say so. All three re-ask
      after `pushChainLinks`, so the board has the new arrow before a `task:changed` arrives
      for the card that arrow explains. Bounded by the first decision above, which needs no
      code: the re-ask walks the cards the remaining links point at.
- [x] **5 — A card returning to To Do re-asks.** `pending` is the one status a release may
      start from, so arriving at it is a moment worth re-asking at. Both routes to it re-ask
      — `task:move` (the drag, and the one that matters) and `task:setStatus` (the detail
      pane's dropdown, which is the same gesture by another control) — each guarded on the
      status it is actually writing. It is the human answering the "Ready to start … start
      it whenever you like" note a release already filed on a card it found in Blocked, and
      it is the last moment there is: the landing has happened and nothing will announce it
      again.
- [x] **6 — A pending merge says what it is holding.** From the predecessor's end: the
      cards whose start is waiting on this one's branch going in. `ChainRunner.heldByMerge`
      answers it — outgoing `after-merge` links whose successor has never run, while this
      card's `landedAt` is still null — and the sentence goes on the end of the note a human
      already reads to learn the branch was not merged. "Merge it when you get to it" and
      "three cards are parked until you do" are different decisions, and nothing else told
      them apart. Asked of the card that OWNS the branch, so a plan's steps answer through
      their parent; `stacked` successors are excluded, because the merge is not what they
      were ever waiting for.
- [x] **7 — "Waiting on X to merge", and the merge offered there.** The successor's chip
      names the card and gives you the button, instead of sending you to find it.
      `awaitingMerge(task, links, byId)` sits beside `blockedBy` and answers it by asking
      whether a `stacked` gate would already be satisfied where this `after-merge` one is
      not — one definition of "the work is written", reused rather than copied, escape hatch
      included. The chip stays monochrome with its link icon and gains one word (`waiting on
      VIP-3 to merge`), because a dependency is a standing fact and "not merged yet" is
      exactly that; the pane's *Waiting on another card* block grows a **Merge VIP-3** button
      beside its **Open**, calling the same `task:integrate` the card's own branch uses, whose
      refusals already arrive as one sentence.
- [x] **8 — Verification.** `pnpm format`, `pnpm typecheck`, `pnpm test` (**1402 passing**,
      2 skipped) and `pnpm build` green, plus a live pass on a throwaway profile. Driving a
      chain by hand needs a mouse, so what was mechanised instead is the **CLI**: a
      stand-in `claude` on `PATH` that speaks the two stream-json lines the app reads
      (`system/init`, `result`) and commits a file in whatever worktree it is handed.
      Everything above it is then the app's own — the real DB and its migrations, real
      worktree prep, real merges, the real engine — and a run costs nothing and takes three
      seconds, so a whole chain can be watched inside one boot.

      **The boot re-ask, and what a merge is holding** (deliverables 2 and 6). A landed
      card with a `stacked` and an `after-merge` arrow out of it: on boot both successors
      started, each with *"Started on startup: everything this card was chained to wait for
      had already finished while the app was closed"*, each in its own worktree on its own
      branch. With auto-merge off, both then settled with the new sentence on the end of
      the note a human already reads — *"1 card is chained to start when this merges —
      CHAIN 4 — wire the CLI to both — so nothing downstream moves until you press it."*

      **A landing under a usage limit** (deliverable 3), which is the phase's headline and
      the one that used to need a restart. A gate seeded to lift 75 seconds after boot, and
      a card set to merge itself: it landed at `08:56:21`, **while the gate was up**, and
      nothing started — the release is held by `limitActive()`, exactly as the unit test
      says. At `08:57:23` the gate's timer fired and its successor started, sixty-two
      seconds after the landing, carrying *"Started when the usage limit lifted: everything
      this card was chained to wait for had already finished while the limit was holding
      all work."* One card, one start, one note.

      **The chip** (deliverable 7) read on the board with both predecessors in review:
      *"waiting on CHAIN 2 — port the parser onto them **to merge** +1"*, with the arrows
      drawn to both.

      **Left to a human**, because each is a gesture and this app is deliberately not
      drivable by synthetic clicks: drawing an arrow and re-gating one (deliverable 4),
      dragging a card back to To Do (deliverable 5), and pressing the **Merge** button the
      successor's pane now offers (deliverable 7). All three are one `reconsiderChains`
      call at an IPC handler over logic the tests drive directly; what is unverified is the
      wiring, not the behaviour.

### Done when

- Every moment that can make a card releasable asks the engine, and the answer is the same
  one `sweep` gives on boot — one code path, not five.
- A chain stopped by a usage limit carries on when the limit lifts, without a restart.
- Erasing one of several arrows into a card releases it; erasing its last one does not.
- A card holding others up says so, and the card waiting says which merge it is waiting
  for and offers it.
- `pnpm typecheck`, `pnpm test` and `pnpm build` are green.

**Notes.**

- The phase ships as a **MINOR** bump (new behaviour a user notices), reached through the
  per-commit bumps each step makes; the tag is cut when this lands on `development`.
- **Two things the live pass turned up, neither of them this phase's to fix**, recorded
  because they are invisible in the code and were both a surprise on screen:
  - **The boot re-ask runs before the saved limit gate is restored.** `reconsiderChains('boot')`
    is called synchronously while the handlers are registered; `restoreLimitGate()` waits on
    the permission broker's promise. So a restart during a live limit has a window in which
    a chained card starts, which is how the fixture above got its card running before the
    gate came back up. It predates this phase — `releaseReadyChains()` sat on the same line
    — and it is self-correcting, since such a run hits the wall and the gate parks it. Moving
    it is a change to Phase 5's startup ordering, not to this one's.
  - **"waiting on X to merge" needs the predecessor to READ as written.** `linkSatisfied`'s
    `stacked` question is `in-review`/`done`, or `sessionId && agentBranch` — and
    `Task.agentBranch` holds the branch name a human TYPED when delegating, not the branch
    the run actually used. A run that settles leaves its card in the column the human left
    it in (usually To Do), so the chip says a plain *"waiting on X"* until the card is moved
    to IN REVIEW, which is what the settle note asks for anyway. Coherent, and narrower than
    this phase's own script assumed: the wording that names a merge only appears once
    somebody has reviewed. Making a run record the branch it wrote on would close the gap
    for every card, and is a change to what a run stores.

---

## Phase 22 — Attachments in the task and its steps

**Goal.** Let a card carry the files the work is *about*. A brief is prose today, so
anything that is not prose — the screenshot of the bug, the mockup the layout has to match,
the CSV that reproduces it, the log — is either described in words or pasted as a path to a
file only the person who wrote it can see. An agent handed that brief gets the description
of a screenshot. So: attach files to a task and to its steps, keep the bytes where the app
keeps everything else, and hand the agent the actual files.

### The shape of the design

Four decisions, each following something the codebase already does rather than inventing a
second way of doing it.

**A `task_attachments` child table, not a column on `tasks`.** It follows `task_links`
([`store.ts:625`](../../src/main/store.ts)) exactly: a real foreign key
`REFERENCES tasks(id) ON DELETE CASCADE` — the pragma is on at `store.ts:420`, so the
cascade actually fires — an index on `taskId`, and the house comment *"A NEW table, so
nothing to migrate"*. Deleting a card cannot leave an attachment row pointing at nothing,
which a JSON array on the row would do silently and forever. It also keeps `tasks` out of
the change entirely, and that matters here for a specific reason: `insertTask`'s explicit
column list (`store.ts:925`) is the trap that silently dropped `projectTagId` in v0.57.0 —
a column added later and only ever set by an `UPDATE`, so a card created already filed lost
its project between the form and the row. A new column would be a new chance to repeat it;
a new table is not.

Because a step is itself a task row (`parentTaskId`), attaching to a step needs no second
table and no second shape — the same row, hung off a different `taskId`.

**No `path` column.** The absolute path is `join(userData, 'attachments', taskId, name)` —
derivable from the two things the row already holds, so it cannot drift. A stored path is a
fact about *this* machine and *this* Windows user, and the profile is a directory a human
can copy: restore it under a different account and every stored path is a lie, while a
derived one is right by construction. `UNIQUE (taskId, name)` then does two jobs at once —
it is what makes `@name` unambiguous when an agent is told what it has, *and* what makes the
on-disk filename collision-free, so one constraint is both the addressing rule and the
storage rule instead of two rules that can disagree.

**The renderer never learns a filesystem path.** `TaskAttachment` carries no path at all.
The renderer opens a file by asking main — `attachment:open(id)` — and previews an image at
`vipper-attachment://a/<id>`. The protocol handler resolves that id *through the store*, so
what it serves is a row that exists or nothing; there is no string from the renderer that
reaches the filesystem, and path traversal is impossible by construction rather than by
validation. That preserves the rule already stated at
[`ipc.ts:680`](../../src/shared/ipc.ts) for JIRA attachments — the renderer never ships
bytes over IPC, main reads and uploads them — and extends it in the direction that was left
open: the paths JIRA's draft carries come from main's own picker (`jira:pickAttachments`,
`ipc.ts:696`), never typed by the renderer, and here not even that much is handed back. The
window is `contextIsolation: true` with `nodeIntegration: false` (`index.ts:99-101`), which is
the same posture; a custom scheme is how a locked-down renderer is *allowed* to see a local
file, and it has to be registered as privileged before the app is ready.

**One flat list and a push event, not a per-card fetch.** `chain:links` / `chain:changed`
([`ipc.ts:642`](../../src/shared/ipc.ts), [`:813`](../../src/shared/ipc.ts)) is the
precedent, and the reason it gives applies here verbatim: a JIRA sync rewrites whole task
rows on every poll, so anything hung off `Task` gets clobbered — the attachments have to
live somewhere a sync cannot reach, and be replaced whole rather than patched.
`MyTasks.tsx:229-236` already seeds five whole-board lists in one `Promise.all`; this is a
sixth, and costs one more entry in an array.

### Verified facts this rests on

Every claim above was re-read against this worktree before anything was built on it. What
follows is the audit, plus the platform facts the later steps need and cannot check for
themselves — the worktree has no `node_modules`, so the Electron typings quoted here were
read from the main checkout at `C:\Repositories\task-manager`, which is on the same lockfile.

**The citations hold, with three corrections.** `store.ts:420` is `db.pragma('foreign_keys =
ON')`; `store.ts:625` is `CREATE TABLE IF NOT EXISTS task_links` with both indexes at 633-634
and `UNIQUE (fromTaskId, toTaskId)` at 631; `store.ts:925` is `insertTask`, whose column list
runs 927-934 and does now carry `projectTagId` (933), so the v0.57.0 bug is fixed and the
citation is about how it happened, not a live defect. `ipc.ts:642` is `'chain:links'`,
`:813` is `'chain:changed'`, `:680` is the "renderer never ships bytes over IPC" sentence in
`jira:addComment`'s doc comment, and `:696` is `'jira:pickAttachments'`. Corrected: the
`adoptTaskId` **field** is at `ipc.ts:723` (its explanation runs 712-716), not 718; and
`contextIsolation`/`nodeIntegration` are set at `index.ts:99-101` — line 77 is the SECURITY
NOTE comment that describes them. Both are fixed above. `MyTasks.tsx` is right as a range,
though the five `invoke`s are 231-235 and the comment above them at 227 still says "all three
channels" — stale since two were added, and worth a word when step 8 edits that block.

**Electron is 33.4.11.** `package.json:40` declares `^33.2.0`; the lockfile resolves 33.4.11
(`pnpm-lock.yaml:1594`) and that is what is installed. This decides three things:

- **`File.path` is gone.** Electron 32 removed it, so a dropped file's path is reachable only
  through `webUtils.getPathForFile` (`electron.d.ts:17709`), which lives in the privileged
  world. This is the one and only reason `src/preload/index.ts` — 51 lines that expose nothing
  but `invoke` and `on` — stops being generic and has to be touched. Nothing else in this
  phase may add to it.
- **A trap the compiler will not catch.** `electron.d.ts:24099-24104` *still* declares
  `interface File { path: string }`, globally and undeprecated, three versions after the
  runtime property was removed. Written in a file that sees those typings, `file.path`
  type-checks clean and is `undefined` at run time. We are safe only by accident:
  `tsconfig.web.json:10` and `tsconfig.node.json:9` both pin `"types": ["node"]`, so Electron's
  ambient declarations are not in scope and `file.path` is a compile error in both projects.
  Do not add `"electron"` to either `types` array to "fix" a drag-and-drop type — that would
  swap a loud failure for a silent one.
- **`protocol.handle` is the right API** (`electron.d.ts:10302`). `registerFileProtocol` is
  explicitly `@deprecated` in the shipped typings (10391-10394). `registerSchemesAsPrivileged`
  (10443) must run at module scope before ready, and `src/main/index.ts` already has that
  slot proven: the occlusion switch at :30 and `setUsePlainTextEncryption` at :45 both sit
  above `app.whenReady()` at :133, each commented that it must. There is no `protocol.` call
  anywhere in `src/main` today, so step 5 is new ground rather than an edit.

**The CSP is one token.** `src/renderer/index.html:12` is a meta tag reading `default-src
'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src
'self' data:`. Serving previews needs `vipper-attachment:` added to `img-src` and nothing else.

**WSL reaches `userData` for free.** `WslExecHost.toNative` is `windowsToLinux`
(`exec/wslHost.ts:225-227`, against the interface at `exec/types.ts:92`), and
`windowsToLinux` (`shared/wslPath.ts:60-75`) maps `C:\x` to `/mnt/c/x`. `userData` is an
ordinary drive path, so automount reaches it — the same mechanism `claudeSession.ts:316` uses
for the MCP config (written under `userData/mcp`, `ipc.ts:312` and `:322`) and `:338` for the
contract file. Step 9 can hand a WSL agent an attachment path the same way, with no new
translation. The three existing `userData` joins to copy are `ipc.ts:165`, `:260` and `:312`.

**A real trap: `syncTasksFromPlan` deletes and re-inserts.** `store.ts:1819-1841` replaces a
plan project's whole task set in one transaction — `deleteTasks.run(projectId)` at 1832, then
`insertTask` for each kept row at 1833 **with the same ids**. Anything hanging off `tasks` by
foreign key is cascaded away by that DELETE and does not come back on its own. Chain links
survive only because they are explicitly read out first (1829-1831) and re-inserted after
(1834-1837), skipping any whose ends the plan dropped. `task_attachments` is the same shape
and needs the same treatment inside the same transaction, or every save of a plan file
silently deletes that project's attachment rows — leaving the bytes orphaned on disk, since
the cascade cannot reach them. Step 3 owns this; it is not optional and it is not obvious from
reading the table definition.

### The contract and the store

`src/shared/attachments.ts` holds `TaskAttachment` **and** its rules, the way `taskChain.ts`
holds `TaskLink` and `canLink` — three sides ask the same two questions (what is this file
called, and does this `@token` name it) and must not answer differently. Both answers are
pure and unit-tested: 36 cases in `attachments.test.ts`.

`attachmentName` sanitizes to `[A-Za-z0-9._-]`, the narrow intersection of what a Windows
filename and an `@token` can both be, and dedupes `-2`/`-3` **before** the extension and
**case-insensitively** — NTFS says `A.png` and `a.png` are one file even though a `Set` of
strings does not. Traversal is not a case it checks for: `..` sanitizes to `''` and lands on
`file`, and a directory is stripped before anything else runs.

`parseAttachmentRefs` resolves against the KNOWN list rather than against a syntax, which is
the decision the whole grammar rests on. A token naming no attachment is prose, so `@needs:`
and `bob@example.com` are excluded without either being special-cased, and the same call is
what lets the UI grey out an `@foo` whose file was removed. Trailing `.` is peeled while the
candidate matches nothing, so `@shot.png.` at the end of a sentence resolves and `@a.png.bak`
still prefers the longer name when both exist.

The channels are declared before either side uses them (Conventions, *contract first*):
`attachment:list` / `:pick` / `:add` / `:remove` / `:open`, plus `attachment:changed`
carrying the whole list. `add` takes **paths, never bytes** — an attachment can be a 30 MB
video, and the structured clone would copy it twice through memory to reach a process that
could simply read it.

Two things in `store.ts` worth naming. The `UNIQUE (taskId, name)` index is `COLLATE NOCASE`,
because it is standing in for the filesystem's own uniqueness; and it needs **no companion
index on `taskId`** — `taskId` is its leftmost column, so it already serves "the attachments
of this task", and a second one would be dead weight. And `syncTasksFromPlan` now carries
attachments across its delete-and-reinsert exactly as it carries chain links, ids and all, so
a preview URL an open pane is showing survives a plan save.

Verified headlessly against the real store on a scratch DB (`ELECTRON_RUN_AS_NODE=1
electron.exe`, since better-sqlite3 is built for Electron's ABI): the cascade takes a card's
attachments *and* its steps' with it, a repeated name is refused in either case, an unknown
task is refused by the foreign key, `deleteAttachment` hands the row back so the bytes can be
unlinked, and a plan re-sync keeps what it kept and drops what it dropped.

### Copying the bytes into app data

Two modules, split along the line that decides what can be tested. `attachmentPaths.ts` is
the arithmetic — `attachmentsRoot`/`attachmentDir`/`attachmentFile` and `mimeForExtension`,
taking the root as an argument the way `createStore(dbPath)` does, so a plain `vitest` run
can hold it to its rules without Electron, a store or a disk. `attachments.ts` is the `fs`:
`mkdir -p`, `copyFile`, `stat` for the size, the unlinks, and the sweep.

**Both path segments go through `attachmentName` on the way in**, even though every caller
today holds a name the store already sanitized. Not distrust of the callers: it makes "an
attachment cannot escape its task's directory" a property of the module rather than of
every call site, and `attachmentName` is idempotent on a name it produced (and on a UUID),
so no honest path changes while `..`, `C:\Windows\win.ini` and `/etc/passwd` all collapse to
one segment inside the directory above. That is what `attachmentPaths.test.ts` pins.

Per file, **the bytes are copied first and the row written second**. The reverse leaves a
chip pointing at nothing if the copy then fails; this way the worst case is bytes nobody
named, which is exactly what the sweep exists to remove. A file that cannot be attached is
*collected*, not thrown — a pick of five where the fourth is locked attaches four and says
so — and the handler pushes what landed before reporting what did not.

**Deletion is in three places, because one is not enough.** The rows cascade for free off
the foreign key; the bytes never do, since no cascade reaches outside the database.
`attachment:remove` unlinks the one file. `task:delete` removes the card's directory and
its steps' — *after* `store.deleteTask` returns, never inside the transaction, where a
failed unlink would roll the row deletion back and leave a card half-deleted; the step ids
are the ones already read to check for a running step. And the **boot sweep is the real
backstop**: deleting a PROJECT cascades its tasks (`store.ts:446`) without `task:delete`
ever running, and so does a crash between the copy and the insert. One pass over
`attachments/*` removes every directory no row names — which is "not a live task id", one
notch tighter, since a live task with no rows has nothing worth keeping either. The rows are
re-read per candidate rather than snapshotted, so a file attached while the sweep walks
cannot be caught by a stale list.

`attachment:open` is the codebase's first `shell.openPath` — it answers with the OS's
complaint or `''` when it opened, which is why the channel resolves to a string-or-null
instead of rejecting. Not `openExternal` (`index.ts:110`): that one is for URLs and would
hand a local path to the browser.

Beyond `pnpm typecheck` / `test` (1478) / `build`, the copy itself was driven headlessly
(esbuild bundle, `ELECTRON_RUN_AS_NODE=1 electron`) against a real store and a scratch
root — 24 checks, all green. The one that matters most: two files both called `shot.png`,
picked in one gesture, land as `shot.png` and `shot-2.png` with their own bytes intact.
Also confirmed there: a step keeps its own directory beside its parent's, a project delete
leaves bytes the sweep then collects, and a second sweep finds nothing to do.

### Serving the images to the window

A locked-down renderer (`contextIsolation: true`, `nodeIntegration: false`) cannot open a
file, and by design it is never told a path. A custom scheme is the sanctioned way it gets
to *see* one, so `<img src={attachmentUrl(id)}>` is the whole renderer-side story.

**The registration is in two halves, in two files, and that is not an accident.**
`protocol.registerSchemesAsPrivileged` must run at module scope before the app is ready —
Chromium fixes a scheme's properties as it starts — so it sits in `index.ts` beside the
occlusion switch and `setUsePlainTextEncryption`, which are there for the same reason.
`protocol.handle` is the opposite: it needs a ready app *and* the store, so it is called
from `ipc.ts` next to `createStore`. That placement also buys the guarantee it needs —
registering a scheme twice throws, and `registerIpcHandlers` runs exactly once
(`app.on('activate')` at `index.ts:175` only calls `createWindow`).

The privileges are `{ standard, secure, supportFetchAPI, stream }` and deliberately **not**
`bypassCSP`. `bypassCSP` would exempt the scheme from the page's policy wholesale —
`script-src` included — to buy something one token in `img-src` buys honestly. So
`renderer/index.html` now reads `img-src 'self' data: vipper-attachment:`, which states
exactly the true thing: an attachment may be a picture, never code.

**The id is in the path, behind a fixed dummy host.** `standard: true` means Chromium
canonicalises the authority (lower-casing, IDNA), which is not something a UUID can be
subjected to; `vipper-attachment://a/<id>` keeps the id where it is preserved verbatim.
`attachmentIdFromUrl` reads it back, and lives in `shared/attachments.ts` beside
`attachmentUrl` rather than inside the handler — the handler cannot be unit-tested (it
needs Electron, a store and a disk), and a URL grammar only an untestable function knows is
a grammar that drifts. The round trip is pinned both ways, including the host being ignored.

What the handler does with that id is the security property of the whole feature: it
resolves it **through the store** and builds the path from the row it got back. No string
the renderer chose reaches `readFile`, so traversal is impossible by construction rather
than by validation — a made-up id is simply a 404, which an `<img>` shows as a broken
image. Failures are statuses, never throws: a rejected handler paints Chromium's own error
page inside the element, which cannot be styled and says nothing. The response carries an
explicit `content-type` (Chromium has no filename to sniff from here) and an immutable
`cache-control` — the bytes behind an id never change, since removing and re-adding mints a
new one. An attachment over **25 MB** gets a 413 instead of bytes: the disk limit is 100 MB
and answers a different question, while the whole of this response is decoded into a bitmap
in the renderer, so a huge file loses its preview rather than the window losing its manners.

Inserting the registration moved everything below it in `index.ts` by 26 lines, so the
`index.ts:NN` citations in this entry and in `ipc.ts` were re-pointed to where they now are
(`99-101`, `110`, `175`) — the step-2 audit's whole argument is that a citation nobody
re-checks is a decision nobody made.

Gates: `pnpm typecheck` clean, `pnpm test` 1483 green, `pnpm build` clean. That the bytes
actually *arrive* cannot be shown without launching the app, so it is owed to step 11 along
with the rest of the visual verification. If the protocol ever misbehaves there, the
fallback needs no CSP change at all — `attachment:thumbnail(id)` returning a `data:` URL
over IPC, since `img-src` already allows `data:`, and main→renderer bytes do not violate
the renderer-never-ships-bytes rule, which is about the other direction.

### Attaching from the card details

`AttachmentStrip` is one component for what will be two callers, because a card's
description and a step's brief are the same thing — prose an agent is handed — hung off two
rows of the same table. It takes the task's id and its slice of the board's list, and owns
nothing else; every action it offers is a channel from step 4.

**It lives inside the Description fold, not in a section of its own.** A file here is not a
list to browse, it is the part of the brief that is not prose — and the description is where
one is cited as `@name`. The fold's `summary` (unused until now) counts the files, so a
section left shut still says the card is carrying something.

**Attaching writes the `@name` for you.** `insertAttachmentRef` at the caret of the
description textarea, which needed a `textarea={{ ref }}` on it exactly as
`chat/Composer.tsx:241` already does. The names are inserted in ONE fold rather than one
`setDraft` per file: each call reads the same `draft` from the same render, so a pick of five
files inserted five times would cite only the fifth. The offer is withdrawn when the
description is not being edited — citing at a caret needs a caret, and writing into a draft
that Cancel then discards is worse than not offering. A chip's name then does the other
useful thing instead and opens the file.

**Three drag gestures now share one `dragover`.** The board moves cards (`text/plain`) and
draws chain links (`CHAIN_LINK_MIME`) through the same native mechanism the strip's drop zone
uses, so the strip reads `types` for `'Files'` and returns without `preventDefault` for
anything else — the mirror of `isChainLinkDrag`, and the one rule here worth pinning without
a browser (`isFileDrag`, plus `formatSize`: 14 cases).

**The window itself has to refuse a file drop.** A drop nothing cancels is handled by
Chromium, and its default for a file is to *navigate* — the window leaves the app for a
`file://` view of a PNG, with no back button and no address bar in a frameless window
(`index.ts:68`) to come back with. A pair of listeners at the renderer's module scope cancels
`dragover` and `drop`, gated on `Files` so the board's own drags keep their refusal cursors.

**`src/preload/index.ts` stops being generic, once.** `File.path` was removed in Electron 32
and `webUtils` lives only in the privileged world, so `pathForFile(file)` is the single thing
the bridge must know about a feature — the documented recipe, and the reason the step-2 audit
pinned the Electron version. `index.d.ts` needed no change: it exports `typeof api`.

Everything else is the board's existing shape. `MyTasks` seeds a sixth whole-board list,
subscribes to `attachment:changed`, and hands the pane its slice from a `useMemo` index —
the same three lines `mergeRequests` and `chain:links` each have, for the reason they give.

Gates: `pnpm typecheck` clean, `pnpm test` **1492 green**, `pnpm build` clean, `pnpm format`
applied. What a rendered chip looks like, and whether a dropped file actually lands, cannot
be shown without launching the app — owed to step 11 with the rest.

### Attaching to a step brief

The second caller, and the one the strip was written for. `StepBrief` gets the same strip in
the same place — inside the Brief fold, under the words, `onInsertRefs` only while editing —
because a step's brief and a card's description differ in nothing but which row they hang
off. The fold's `summary` counts the files exactly as the card's now does, and `none`
survives for the step that has neither prose nor a file.

**A step's scope is `attachmentsInScope(own, parent)`.** The mockup is attached once, to the
card, and every step of the plan that has to match it writes `@mockup.png`; attaching it per
step would be a copy per step, and copies drift. The step's own list wins a name clash, so a
step that attaches its *own* `mockup.png` shadows the card's and the parent one is simply
unreachable from there — which is what the human asked for by giving it that name. This is
the function step 9's prompt builder resolves `@name` against, called here so what the chips
offer and what the agent is handed cannot disagree (union and shadowing: 2 cases in
`attachments.test.ts`, written with the rule in step 3).

**An inherited chip cannot be removed from the step it is shown on.** The `×` is rendered
only for a chip whose `taskId` is the strip's own — the strip already knows both, so this
costs no prop. A `×` on the card's mockup, pressed from step 4's pane, would take the file
off the card and every other step of the plan with it, from a pane that names neither; it
comes off where it went on. A card's own strip never meets the case, since every file there
is its own. Citing and opening are unaffected: those are exactly what a step is shown its
parent's files *for*.

**`live` is one guard with one sentence.** A running step's prompt is already built, so a
file attached now would be attached to nothing that can still read it — the same reason the
Edit button gives, so the string is now a `LIVE_HINT` const both use rather than two
sentences that drift. It reaches the strip as `disabledHint`, the one prop this step added:
a control that cannot be pressed has to say why, and `disabled` alone is a dead button.

`MyTasks` hands the pane a second slice from the index it already built
(`parentAttachments`, from `parentOfSelected`) — no new channel, no new fetch, and nothing at
all for a card, which has no parent to inherit from.

Gates: `pnpm typecheck` clean, `pnpm test` **1492 green** (no new cases — the rule this step
leans on was pinned when it was written), `pnpm build` clean, `pnpm format` applied.

### Staging files in the Add dialog

A screenshot is on the clipboard at the moment somebody thinks of the card, not ten minutes
later in a pane — so the dialog that already asks the three questions a card is made of asks
the fourth. It is the one answer that cannot be *written* when it is given: an attachment
hangs off a task id, and there is no task yet. So the paths are **staged** — held while the
form is filled in, copied once the row exists.

**Attachments stay out of `AddTaskPlan`.** That type describes the writes derivable from the
form; copying bytes is a post-create side effect, and folding it in would make a pure
function describe something that cannot happen yet. The staged paths live in their own state,
reset by the same `useEffect` that clears the form, and `stageAttachments` sits beside
`addTaskPlan` as the second pure export — the house pattern of a rule tested from a `.tsx`
without a renderer.

**The invariant that makes staging correct at all:** the renderer derives provisional names
with the same pure `attachmentName` main will use, and for a brand-new task the "already
taken" list is empty on **both** sides — so the `@name` typed into the description and the
name main assigns after `task:create` agree by construction, not by a lookup that could miss.
That is why the names are re-derived over the whole list on every change rather than appended
to: `attachmentName` is a function of the list before it, so a file un-staged from the middle
has to hand back the `-2` it was pushing onto the one after it, exactly as main's own run over
the remaining paths will. A ref already typed for a file since un-staged is left alone — a
token naming no attachment is prose, so it costs nothing, and rewriting the human's own
sentence would cost a great deal. (6 cases: picked twice stages once, two basenames get `-2`,
the provisional names equal `attachmentName` against an empty taken-list, un-staging gives the
suffix back.)

**`task:addSubtask` returns the step it made** — `Promise<Task>` in the contract
([`shared/ipc.ts:388-391`](../../src/shared/ipc.ts), *"Returns the created step"*), returned
by the handler at [`main/ipc.ts:728`](../../src/main/ipc.ts) — the `return task;` this step
was pointed at as `:688`, which is where it sat before steps 4 and 5 added the attachment
handlers and the protocol above it (678 → 710 → 718 across those commits). The dialog had
been discarding it. It is captured into a local of its own rather than into `created`,
because `created` is what decides whether a chain link is drawn and must stay null for a step
— `canLink` refuses a step at either end. So both shapes have an id to hang files off, and
only one of them has an arrow.

A failed copy follows the soft-failure convention `ticketFor` and `chainAfter` already set:
`onNotice`, never a lost card. By the time it runs the row is on the board, so a locked file
is a note to the human rather than a failure of the whole dialog — and main attaches what it
can before reporting the rest, so the refusal does not mean nothing landed.

The strip itself is the same skin as `AttachmentStrip` at a different moment (chips, an
Attach button, the same `isFileDrag`-gated drop zone) rather than that component, which is
built around a `taskId` and the channels that need one. No thumbnails here for the reason the
whole design rests on: a preview is served *by id*, and `img-src` allows no local file.

Gates: `pnpm typecheck` clean, `pnpm test` **1498 green**, `pnpm build` clean, `pnpm format`
applied. That a staged file actually lands on the new card needs the app running — owed to
step 11 with the rest.

### Handing the legend to the agent

The point of the phase, and it is four lines of prompt. `@shot.png` in a brief means nothing
to an agent on its own; the legend is the table that turns it into a file:

```
Files attached to this task — the description refers to them by the @name on the left:
- @mockup.png -> /mnt/c/Users/you/AppData/Roaming/…/attachments/<taskId>/mockup.png
Read them with your file tools. They live outside the repository; do not copy them into it.
```

It is spliced straight after the description in `buildAgentTaskPrompt` and after the brief in
`buildAgentSubtaskPrompt`, with the same `...(cond ? [...] : [])` idiom every other optional
block uses, so the blank-collapsing filter that ends both builders keeps it from leaving a
seam. Absent entirely when nothing is attached — an empty heading is worse than silence.

**That last line is load-bearing.** The bytes live under `userData`, outside the worktree;
without it an agent will cheerfully `cp` a 4 MB PNG into the repository and commit it, and
the branch the orchestrator merges is then carrying a binary nobody asked for.

**Every attachment is listed, not just the referenced ones.** Somebody who attached a file
and then mistyped the token still meant the agent to have it, and filtering would turn that
typo into a silently missing input — the one failure the human has no way to see.
`referencedAttachments` therefore serves the *renderer's* highlighting; the prompt does not
call it.

**The translation stays in the scheduler.** `agentTaskPrompt.ts` is pure and unit-tested and
must not learn about execution hosts, so it takes `PromptAttachment[]` — a name and a path
already native to the machine the run happens on — and only formats it. `promptAttachments`
in `scheduler.ts` is the one place that knows all three moving parts: the scope
(`attachmentsInScope(own, parent)` for a step, the same union its chips offer, so what the
human sees and what the agent is told cannot disagree), the path (`attachmentFile` over the
attachment's **own** `taskId`, which is what makes an inherited card file resolve to the
card's directory rather than the step's), and the host (`hostFor(project.target).toNative()`,
already imported there). `localHost().toNative` is the identity, so there is one code path
and a local run is unaffected. Because a `name` is `[A-Za-z0-9._-]` by construction, no
legend path contains a space and there is nothing to quote.

`userData` reaches the scheduler through `setAttachmentRoot`, beside the four notifiers the
IPC layer already wires: `app.getPath` is Electron's and the scheduler is unit-tested without
it. Unwired, the legend is simply absent — a list of names with no paths would promise files
the agent then cannot find, which is worse than not mentioning them.

`docs/05-glossary.md` gains an `@name` entry beside `@needs:`, saying plainly that the two
are different syntax in different files resolved against different things, and that a token
matching no attachment is prose — which is exactly why they never collide.

Gates: `pnpm typecheck` clean, `pnpm test` **1506 green** (8 new cases), `pnpm build` clean,
`pnpm format` applied. That a real WSL agent opens the file needs a live run — owed to step
11 with the rest.

### Sequencing

The order the seven building steps land in, and — the part that actually matters — what each
one may assume already exists. Written as a **partial** order, because two of them do not
depend on each other and pretending they did would have hidden the one interesting fact in
this phase's shape:

```
3 → 4 → { 5, 6 } → 7 → 8 → 9
```

(Steps 1 and 2 are this entry and its audit; they precede everything by construction and gate
nothing but each other. Step 10 is this section, 11 verifies, 12 releases.)

**What each step may assume.**

- **3 — the contract and the store.** Assumes nothing. It is first because *everything* else
  in the phase names `TaskAttachment`, and because the five channels have to be declared
  before either side of the boundary compiles against them (Conventions, *contract first*).
  It also carries the pure rules — `attachmentName`, `parseAttachmentRefs`,
  `attachmentsInScope` — which is what lets steps 6, 8 and 9 each answer "what is this file
  called" without three answers.
- **4 — the bytes.** Assumes 3's rows and `attachmentName`, nothing else. It cannot be first:
  the row is written after the copy, and there is no row to write yet.
- **5 — the protocol.** Assumes 3 (the handler resolves an id *through the store*) and 4
  (`attachmentFile` is how it turns a row into a path). It assumes no UI at all — the scheme
  serves bytes to whoever asks, and until step 6 nobody does.
- **6 — the card details.** Assumes 3 and 4. **Not 5.** This is the branch point and it is
  worth stating plainly: everything the strip *does* — pick, drop, chip, remove, open, cite
  at the caret — is channels from 3 and 4, and works with no scheme registered at all.
  Exactly one line of it depends on step 5, the inline `<img src={attachmentUrl(id)}>`, and
  its failure mode is already handled: `onError` drops the id into `gone` and the strip falls
  back to the chip it would have shown anyway. So 5 and 6 are genuinely concurrent, and if
  the protocol had turned out to be a fight the pane would still have shipped.
- **7 — the step brief.** Assumes 6, and only 6: it is the same `AttachmentStrip` against a
  step's row, plus `attachmentsInScope` from 3. Nothing new crosses the boundary, which is
  why this step added no channel and no test — the union-and-shadowing rule it leans on was
  pinned when it was written, in 3.
- **8 — the Add dialog.** Assumes 3 and 4. **Not 6 or 7**, despite looking like more of the
  same UI: it deliberately does not reuse `AttachmentStrip`, which is built around a `taskId`
  the dialog does not have yet, and it needs no preview for the same reason. Its correctness
  rests on one thing from 3 — that the renderer's provisional name and main's assigned name
  are the same pure function over the same empty taken-list.
- **9 — the legend.** Assumes 3 (`attachmentsInScope`) and 4 (`attachmentFile`). **Not 5, 6,
  7 or 8** — a prompt does not care which surface put the row there. It is last because it is
  the only step with nothing to show for itself until something upstream can attach a file,
  and because it is the point of the phase: the seven before it are plumbing, and running it
  earlier would have meant handing an agent a legend of an empty table.

**Two ordering constraints that are not about code.**

- The worktree has **no `node_modules`**, so step 3 — the first to touch `src/` — pays for a
  `pnpm install` before any gate can say anything. Steps 1 and 2 change only this file and so
  have no gate to run; every step from 3 on runs `typecheck` / `test` / `build` / `format`.
- Every step bumps the version inside its own commit ([`CONTRIBUTING.md`](../../CONTRIBUTING.md)
  §4), but **none of them tags**: [`RELEASE.md`](../../RELEASE.md) rule 5 forbids releasing
  from a feature branch, and a pushed tag cannot be moved. The MINOR the phase ships as is
  reached by those per-commit bumps and cut when the branch lands.

**What actually happened.** One commit per step, in a strict linearization of the order above
— the concurrency at `{5, 6}` was available and not spent, since a single session runs the
steps one at a time anyway:

| Step | Commit | Version |
|-----:|--------|---------|
| 1 | `c680fd7` the shape of the design | 0.57.1 |
| 2 | `28edeaa` verify the facts | 0.57.2 |
| 3 | `ebf35b5` the contract and the store | 0.58.0 |
| 4 | `ad54b88` copy the bytes into app data | 0.59.0 |
| 5 | `54a08c5` serve images over a protocol | 0.60.0 |
| 6 | `88f8a94` attach files from the card details | 0.61.0 |
| 7 | `38612be` attach files to a step brief | 0.62.0 |
| 8 | `e12f77e` stage files in the add dialog | 0.63.0 |
| 9 | `fe69e9f` hand the legend to agents | 0.64.0 |

Steps 3 and 4 are MINOR rather than PATCH despite shipping no visible behaviour: they are
`feat` commits under §4's rule that the *type* picks the bump, not the visibility.

**One thing the order got right by accident, recorded so it is not undone.** Step 2's audit
found the `syncTasksFromPlan` delete-and-reinsert, and step 3 fixed it in the same commit
that created the table. Had the audit been folded into step 3 rather than run as its own step
before it, the table would have shipped first and the fix would have been a later patch — and
in between, every save of a plan file would have deleted that project's attachment rows and
orphaned the bytes. Auditing the citations *before* building on them is the whole argument
for step 2 existing, and this is the case that paid for it.

### Verification

The four gates, on the whole worktree: `pnpm format` (a fixpoint — a second run changes
nothing), `pnpm typecheck`, `pnpm test` (**1506 passed, 2 skipped, 80 files**) and
`pnpm build`.

`pnpm format` also reflowed **47 files this phase never touched**. That is not drift this
phase introduced: the repository had fallen out of step with its own `printWidth: 100`, and
`format` globs all of `src/**` rather than the diff, so the very first gate any step ran was
always going to surface it. Confirmed as pure reflow before committing — every one of the 47
was byte-identical to Prettier's output for its own `HEAD` version — and committed
separately, so the phase's diff stays readable.

**What ran headlessly, and why it had to.** Everything pure is already in `vitest`
(`attachments.test.ts`, `attachmentPaths.test.ts`). What `vitest` cannot reach is anything
that needs a real `better-sqlite3`, because the addon only loads against Electron's ABI. So
`scripts/verify-attachments.mjs` bundles the modules with Vite (stubbing `electron`, whose
`protocol` and `app` are never called on this path) and runs them under
`ELECTRON_RUN_AS_NODE`, against scratch databases in the temp directory. **42 checks, all
passing**, over the six things the design claims and no test could hold it to:

- the table on a **fresh** database — its seven columns, `mimeType` the only nullable
  non-key one, the foreign key onto `tasks` as `ON DELETE CASCADE`, `COLLATE NOCASE`, and
  `UNIQUE (taskId, name)` as one index with `taskId` leftmost (which is the claim that "a
  separate index on `taskId` would be dead weight" rests on);
- the table on a **v0.57.0** database — written by v0.57.0's own `createStore`, extracted
  with `git archive`, because a schema built by today's code minus one table would prove
  nothing about the migration. The old project and card read back intact afterwards;
- `DELETE FROM tasks` taking the attachment rows with it, a repeated name refused
  case-insensitively, an unknown task refused by the foreign key, and — the path
  `task:delete` never sees — a deleted **project** cascading through its tasks to their
  attachments;
- a card delete removing the **files**, its steps' included, and the dedupe landing
  `shot.png` and `shot-2.png` with the extension intact and the bytes copied whole;
- the boot sweep removing both kinds of orphan (a directory whose rows cascaded away, and a
  copy that never got its row) while leaving a live one alone, and a profile that never
  attached anything sweeping to zero without creating the directory;
- `syncTasksFromPlan` carrying attachments across its delete-and-reinsert **ids and all**,
  so a `vipper-attachment://a/<id>` an open pane is showing stays valid — and a task the
  plan dropped losing its rows to a genuine cascade, its bytes left for the sweep.

Three traps, recorded so the next person does not re-find them: `readModuleAbi` takes the
addon's **bytes**, not its path; `tar` reads a leading `C:\` as a remote host, so the archive
and the extraction must both be relative; and the store mints a built-in **Personal** project
on every open, so "one project" is never the right thing to count.

Statically confirmed, since the runtime half cannot be: `vipper-attachment` is a valid CSP
`scheme-source` (`ALPHA *( ALPHA / DIGIT / "+" / "-" / "." )`), the widened `img-src` survives
into `out/renderer/index.html`, and `registerSchemesAsPrivileged` is in the built main bundle
at module scope. That the browser then *matches* it is not something a grep can say.

**Owed to a human — the app was never launched** ([`RELEASE.md`](../../RELEASE.md) rule 6:
there is no single-instance lock, and a second instance killed a live session on
2026-08-02). These are stated as owed, not as passing:

1. **The protocol actually serving bytes** — the privileged-scheme timing, whether Chromium
   matches `img-src vipper-attachment:` at request time, and whether the thumbnail renders.
   A CSP refusal is silent apart from a console error. Fall back to step 5's note if not.
2. **Drag-and-drop end to end** — that `webUtils.getPathForFile` returns a real path across
   the bridge, that the drop zone wins over the board's card and chain drags, and that a
   stray drop no longer navigates the frameless window away.
3. **Every visual** — chip layout, thumbnail size, the strip inside `FoldToggle`, and how it
   all sits in the narrow Add-task dialog.
4. **`shell.openPath`** for an extension with no registered handler, and on a UNC profile.
5. **The WSL leg** — that a real `/mnt/c/.../AppData/Roaming/...` legend path is readable
   from inside the distro during an actual run.

### Deliverables

- [x] **1 — The shape of the design.** This entry: the four decisions above, each named
      against the thing in the codebase it copies, written before anything is built so the
      later steps are implementing a decision rather than taking one.
- [x] **2 — Verified facts this rests on.** The file:line claims above, re-read and
      confirmed against the working tree — the design is only as good as the precedents it
      cites, and a stale line number is a decision nobody actually checked. Three were stale
      and are corrected; the `File.path` typing hole and the `syncTasksFromPlan` cascade are
      what the audit turned up that the design had not accounted for.
- [x] **3 — The contract and the store.** `TaskAttachment` in `src/shared/` before either
      side uses it (Conventions, *contract first*), the `task_attachments` table and its
      index, and the store methods over them. See above: the name/ref rules ship with it,
      because the store's `UNIQUE (taskId, name)` is only unambiguous if one policy decides
      what a name is; and `syncTasksFromPlan` restores attachments as it does links.
- [x] **4 — Copy the bytes into app data.** Main picks the files, copies them under
      `userData/attachments/<taskId>/`, and writes the row. A copy, not a reference: the
      file the human picked can be moved, renamed or deleted the minute after they picked
      it, and a brief that points at a file that is gone is worse than one that never had it.
      See above: the pure arithmetic is split from the `fs` so the traversal promise can be
      unit-tested, and deletion lands in three places because the bytes do not cascade.
- [x] **5 — Serve attachment images over a protocol.** The `vipper-attachment` scheme,
      registered privileged before the app is ready, resolving `a/<id>` through the store.
      See above: the registration splits across two files because its two halves want
      opposite moments, the CSP is widened by one token in `img-src` rather than waved away
      with `bypassCSP`, and the id round trip is a pure pair so the grammar is testable.
- [x] **6 — Attach from the card details.** The pane grows the list, the picker, the
      previews and the delete. See above: one strip for both callers, inside the Description
      fold because a file is part of the brief; attaching cites itself at the caret in one
      fold; the drop zone reads `'Files'` so it cannot answer a card drag or a chain link;
      and the window refuses a stray file drop that would otherwise navigate it away.
- [x] **7 — Attach to a step brief.** The same UI against a step's row, which the schema
      already allows for free. See above: a step's scope is its own files plus its card's,
      through the one `attachmentsInScope` step 9 will resolve `@name` with; an inherited
      chip cites and opens but does not offer a `×`, since it comes off where it went on;
      and `live` freezes the strip with the same sentence the Edit button uses.
- [x] **8 — Stage attachments in the Add dialog.** Files chosen before the card exists, so
      they land the moment it does — the same problem the dialog's ticket already solves by
      writing the card first (`ipc.ts:723`, `adoptTaskId`).
- [x] **9 — Hand the attachment legend to the agent.** The prompt says what is attached and
      where, so `@name` in a brief resolves to a file the agent can actually open. This is
      the point of the phase; everything above it is plumbing. See above: every attachment
      is listed rather than only the cited ones, "do not copy them into the repository" is a
      line the prompt cannot lose, and the WSL translation stays in the scheduler so the
      prompt builder itself remains pure.
- [x] **10 — Sequencing.** The order the above lands in, and what each step may assume. See
      above: `3 → 4 → {5, 6} → 7 → 8 → 9`, written as a partial order because the protocol and
      the pane are genuinely independent — every chip, pick, drop and citation works with no
      scheme registered, and only the inline thumbnail depends on step 5.
- [x] **11 — Verification.** All four gates green, and the store, the cascade, the bytes,
      the sweep and the plan re-sync driven headlessly under `ELECTRON_RUN_AS_NODE` against
      scratch databases — 42 checks in `scripts/verify-attachments.mjs`, including a real
      v0.57.0 database written by v0.57.0's own code. See above: the app was never launched,
      so the protocol serving bytes, drag-and-drop, every visual, `shell.openPath` and the
      WSL leg are **owed to a human** rather than claimed.
- [x] **12 — Release.** What a release can honestly do from a feature branch, done; what it
      cannot, named and handed on. Every gate was re-run at the branch tip: `pnpm typecheck`
      (node + web), `pnpm test` — **1506 passed**, 2 skipped, 81 files — `pnpm build`, and
      `pnpm exec node scripts/verify-attachments.mjs`, whose **42 checks** all pass,
      including the leg that opens a real v0.57.0 database. `pnpm check:abi` agrees as well:
      `better_sqlite3.node` and Electron are both on ABI 130. `check:feed` is a *post*-package
      gate and says so on a tree with no `dist/` — it runs inside `pnpm package`, from the
      integration branch, and is not a question this branch can answer.

      **The version is 0.64.4, not the 0.58.0 this phase was scoped against**, and that is
      the per-commit bump rule working rather than a mistake. The scoping assumed one bump
      for the whole phase; [`CONTRIBUTING.md`](../../CONTRIBUTING.md) §4 has *every* commit
      carry its own, so the steps climbed 0.58.0 (the store) → 0.59.0 (the bytes) → 0.60.0
      (the protocol) → 0.61.0 (the pane) → 0.62.0 (the step brief) → 0.63.0 (the dialog) →
      0.64.0 (the legend), then four patches for the two docs entries, the reflow and the
      verification script. The phase still ships as a MINOR; it just spends seven of them.
      Only the tip is ever tagged, so the numbers in between cost nothing.

      **One collision to know about before the merge:** step 1 bumped this branch to 0.57.1
      while `development` independently shipped a *different* commit as `v0.57.1` (eeddcd3,
      published, `Latest`). Both exist, only development's is tagged, and the tag cut after
      integration names the tip — so nothing overwrites anything. It is recorded because two
      commits claiming one version is precisely what reads as a corrupted history later.

      **No tag and no release were cut here** — this phase's Notes and
      [`RELEASE.md`](../../RELEASE.md) rule 5. Once the orchestrator lands this branch on
      `development`, the release is that file run start to finish, already green through its
      step 2: tag `v0.64.4` annotated, `git push --follow-tags`, a **draft** release, then
      `pnpm package` on Windows and the packaged-addon check *through* `app.asar`. **Do not
      promote the draft** — v0.56.0's and v0.57.0's are both still waiting on the same Linux
      build, and rule 4 makes promotion the one irreversible step.

      **Release notes, grouped as a user would notice them.** New: a card and each of its
      steps can carry files — picked or dropped onto the Description fold, previewed inline
      when they are images, opened with a click, and staged in the Add-task dialog before
      the card exists. The bytes are copied into the profile, so moving or deleting the
      original afterwards costs nothing. An agent is handed the list and the real paths, so
      `@name` in a brief resolves to a file it can open — translated for WSL when the run
      is over there. Internal: a `task_attachments` table with a cascading foreign key, a
      `vipper-attachment` protocol behind a one-token `img-src` widening rather than a
      disabled CSP, a boot sweep for bytes no row points at, and attachments that survive a
      JIRA plan re-sync. Still owed to a human: everything in the *Owed to a human* list
      above (the app was never launched), and the Linux artifacts.

### Done when

- A file attached to a card survives a restart, and deleting the card takes both the row and
  the bytes with it.
- A JIRA sync leaves a card's attachments exactly where they were.
- An image attached to a card is previewed in the pane, and no filesystem path ever crosses
  into the renderer.
- A step's brief can name an attachment, and the agent running that step opens the real file.
- `pnpm typecheck`, `pnpm test` and `pnpm build` are green.

**Notes.**

- The phase ships as a **MINOR** bump (new behaviour a user notices), reached through the
  per-commit bumps each step makes ([`CONTRIBUTING.md`](../../CONTRIBUTING.md) §4) — seven
  of them, landing on **v0.64.4**; deliverable 12 has the arithmetic.
- **No tag and no release on this branch.** [`RELEASE.md`](../../RELEASE.md) rule 5 forbids
  releasing from anything but the integration branch, and a tag pushed from a feature branch
  cannot be moved afterwards. Same standing rule as Phase 21: the tag is cut when this lands
  on `development`.
- Every step of this plan shares the one branch `feat/attachments-in-the-task-subtasks`, so
  each step's session reads this entry to find what the previous one left it.
- The worktree this plan runs in has **no `node_modules`** — the first step that touches
  `src/` pays for a `pnpm install` before any gate can be run. Steps 1 and 2 change only
  this file, so there is nothing for a gate to say about them.

---

## Phase 23 — One model for planning, another for the steps

**Goal.** Let a project say "plan with the expensive model, execute with the cheap one".
Planning is the one run whose whole output is judgement — it reads a repo it has never
seen and decides what the work *is* — while a step is handed a brief that already says
what to do. They are paid for identically today: `startTask` resolves one model,
`task.agentModel ?? project.defaultModel` ([`scheduler.ts:2066`](../../src/main/scheduler.ts)),
and every run of that card gets it. A human who wants the planner smarter has to change
the project before the plan and change it back before the steps, on every card.

### The two assumptions this plan rests on

The human was asked to settle both before anything was built. The prompt timed out with no
answer, so the work went ahead on the readings below. They are recorded here, in the plan
of record rather than in a commit message, because a later reader has to be able to tell a
decision from a guess — and because either one is cheap to reverse *now* and expensive to
reverse after the migration in deliverable 2 has run on a real database.

**1. One override per card, and it wins over both project models.** The ticket asks for a
per-step model as well as a per-project one. A step **is** a task row — `parentTaskId` is
the only thing that distinguishes it ([`model.ts`](../../src/shared/model.ts), Phase 11) —
so the `agentModel` column the card already has *is* the per-step override, reachable from
the step's own controls. What the card/step dropdown gains is the one choice it cannot
currently express: an explicit **Project default**, i.e. writing NULL. A concrete choice
governs whatever that card runs next, planning or not.

The rejected alternative is a second per-card field, `agentPlanningModel`, so a single card
could plan on one model and execute on another *against* its project's pair. It doubles
every model dropdown in the app — the assign dialog
([`AssignAgentDialog.tsx:141`](../../src/renderer/src/AssignAgentDialog.tsx)), the composer
strip ([`Composer.tsx:149`](../../src/renderer/src/chat/Composer.tsx)) and the step editor —
and doubles the column, the patch type and the resolution ladder, to serve a case that
arises when one card disagrees with its project about planning specifically. A human who
wants that today can set the card's one override before approving the plan and change it
after; the same two clicks the project-level pair removes for the common case.

**2. Only the overrides that were never deliberate get cleared on upgrade.** A one-time
migration sets `agentModel = NULL` on every task whose value equals its owning project's
`defaultModel`, and leaves every other value alone.

This is not tidying — without it the feature does nothing for any card that already exists.
The schema's own comment says NULL means "use the project default"
([`store.ts:833-835`](../../src/main/store.ts)), and every *pre-existing* row honoured that.
The assign dialog then broke it: it seeds its dropdown from
`card.agentModel ?? resolved?.defaultModel ?? 'sonnet'`
([`AssignAgentDialog.tsx:141`](../../src/renderer/src/AssignAgentDialog.tsx)) and always
submits a concrete value, which `task:assignAgent` writes verbatim
(`agentModel: input.model ?? null`, [`ipc.ts:647`](../../src/main/ipc.ts)). So every
delegated card carries an override, whether or not a human ever opened that dropdown — and
a card whose override equals the project default is **indistinguishable** from a card that
never chose. Left in place, those rows would out-rank `planningModel` on the ladder below
and the new setting would appear to be ignored on precisely the cards people use.

The cost of guessing wrong is bounded and one-sided: the only rows touched are ones whose
effective model does not change today, and the only way to notice is to set a planning
model and find that a card follows it. A card whose model genuinely diverges from its
project — the deliberate `opus` on a hard ticket — keeps it, because that is the one signal
of intent the data carries.

`agentMode` has exactly the same history and is deliberately **not** touched. Permission
mode is not what this ticket is about, and `plan` mode carries meaning the model does not
(see [`scheduler.ts:238`](../../src/main/scheduler.ts) — a card assigned `plan` needs a
mode ladder of its own for release runs). One column, one migration.

### The resolution ladder

One pure function, mirroring `releaseMode` ([`scheduler.ts:238-245`](../../src/main/scheduler.ts))
in shape and in why it is pure — a ladder that decides what a run costs should be testable
without a CLI:

```
task.agentModel                                  // explicit per-card / per-step choice
  ?? (planning ? project.planningModel : null)   // NULL = "same as execution"
  ?? project.defaultModel                        // the steps-execution model
```

`planning` is `run.expectsPlan && run.permissionMode === 'plan'` — the same pair the
codebase already uses to tell "come back with a plan" from "this card may merely not write"
([`scheduler.ts:2065-2073`](../../src/main/scheduler.ts), whose comment states the
distinction). A chat reply or a post-chain review that only *inherited* plan mode from its
card is not planning and keeps the execution model.

`Project.defaultModel` ([`model.ts:133`](../../src/shared/model.ts)) keeps its column, its
name in the code and its meaning as the model work runs on; only its **label** changes, to
*Steps execution model*. `planningModel` is a new nullable column where `NULL` means "same
as execution", so every existing project behaves exactly as it does today until a human
sets it, and no back-fill is needed for projects at all — only for the cards above.

### Traps the later steps must not walk into

Each of these was read in this worktree, not remembered.

- **The migration must run *after* the project-tag back-fill.** `wasDelegated` counts
  `agentModel` as evidence that a card was really delegated rather than merely filed
  ([`projectTagMigration.ts:35`](../../src/main/projectTagMigration.ts)), and its one-shot
  guard `migration.projectTagSplit` ([`store.ts:1089`](../../src/main/store.ts), block at
  [`:1329-1344`](../../src/main/store.ts)) means a database upgrading from before that
  split still has it pending. Null the models first and a filed-and-delegated card loses
  its delegation. Place the new block below that one, with its own `app_state` guard key.
- **Steps hold their own copy.** `addSubtask` writes `agentModel: parent.agentModel ?? null`
  ([`store.ts:1865`](../../src/main/store.ts)), so nulling a parent does not reach the steps
  already created under it. The migration is a single `UPDATE` over `tasks`, which covers
  both, but it must compare each row against the project that would actually *run* it —
  `agentProjectId`, resolved the way `runProjectFor` resolves it
  ([`scheduler.ts:1450`](../../src/main/scheduler.ts)) — not `task.projectId`.
- **Two surfaces write this field, and both need the new choice.** `task:assignAgent`
  ([`ipc.ts:647`](../../src/main/ipc.ts)) and `task:setAgentOptions`
  ([`ipc.ts:843`](../../src/main/ipc.ts)) both write `agentModel`; the pane also *renders*
  the fallback as the words "project default" already
  ([`TaskAgentPanel.tsx:623`](../../src/renderer/src/TaskAgentPanel.tsx)). If deliverable 5
  ships only one of the two dropdowns, the first assign or the first options edit re-writes
  what the migration cleared, and the bug returns one card at a time.
- **The ladder is evaluated once, at launch.** The run captures its model
  ([`scheduler.ts:2066`](../../src/main/scheduler.ts)) precisely so nothing re-derives it
  later; a mid-run change decides the *next* run, which is the documented behaviour of
  `task:setAgentOptions` and must stay true.
- **`??`, never `||`.** Both new values are nullable and the empty string is a real value
  in this schema's idiom (`baseBranch`); a `||` ladder would read a stored `''` as unset.

### Deliverables

- [x] **1 — The assumptions, written down.** This entry: the two readings above, the
      ladder, and the traps, so the five steps after it share one source of truth and a
      reviewer can see what was assumed rather than asked.
- [x] **2 — The planning model on projects and in settings.** The nullable `planningModel`
      column, added the way every later `projects` column was — one guarded
      `ALTER TABLE projects` beside `kind`, `target` and `instructions`
      ([`store.ts:694-716`](../../src/main/store.ts)), with no `NOT NULL DEFAULT`, since
      NULL is the value that means "same as execution" — plus the shared type,
      `ProjectPatch` ([`model.ts:282`](../../src/shared/model.ts)), `AddProjectInput`
      ([`model.ts:247`](../../src/shared/model.ts)) and the app-level seed beside
      `defaultModel` ([`settings.ts:225`](../../src/shared/settings.ts)).
- [x] **3 — Pick the model by what the run is.** The pure ladder, unit-tested, replacing
      the one-line resolution at [`scheduler.ts:2066`](../../src/main/scheduler.ts).
- [x] **4 — Both models in the settings screens.** `ProjectDialog`, `AgentProjects` and
      `Settings`, with `defaultModel` relabelled *Steps execution model* and the planning
      field offering "same as execution".
- [x] **5 — Let a card or step follow its project.** The explicit *Project default* choice
      in both dropdowns, plus the one-time migration from assumption 2.
- [x] **6 — Verify the split and refresh the docs.** A new *Two models* section in
      [`docs/03`](../03-how-orchestration-works.md#two-models-one-to-plan-with-one-to-execute),
      two glossary entries, and `scripts/verify-model-split.mjs` — a headless scenario in the
      shape of `verify-round.mjs`, but with a **stub `claude` on PATH** so the assertion is
      the CLI's own argv rather than a request object one link short of it. It walks one card
      through the whole split against a real SQLite store, the real `Scheduler` and the real
      `SessionManager`: 26 checks over 8 spawns, no app launched and no repository touched.
      See *How the split was verified* below.

### How the split was verified

`resolveRunModel` is pure and unit-tested, and `scheduler.test.ts` proves a run born in
`startTask` carries what the ladder chose. Neither answers the only question a human
actually has — *does the CLI get `--model opus`?* — because that answer is four things
joined end to end: the ladder, the run's captured model, `buildClaudeArgs`, and the spawn.
A fake `SessionManager` recording a `StartSessionRequest` stops one link short of the
argument being asserted.

So `scripts/verify-model-split.mjs` puts a stub `claude` on PATH (the technique from Phase
21) and asserts on its **argv**. Everything above it is the app's own code: a real
`better-sqlite3` store, the real `Scheduler`, the real `SessionManager`, `hostFor`'s local
host and its `shell: true` spawn. The stub records its arguments, then behaves like the
CLI — a `plan`-mode run calls `ExitPlanMode` with a plan, any other run reports a `result`,
but only once the driver drops a `proceed-N` file, so every assertion is made while its run
is still open and nothing races on a timer. One card is walked through the whole split:

| # | The run | Asserted |
|--:|---------|----------|
| 1 | the card's planning turn | `--model opus --permission-mode plan` |
| 2 | step 1, after **Approve plan** | `--model haiku --permission-mode bypassPermissions`, and all three steps created with `agentModel` NULL |
| 3 | step 2, overridden mid-chain | `--model sonnet` |
| 4 | step 3, untouched | `--model haiku` — one step changed, not the chain |
| 5 | a chat reply on a `plan`-mode card | `--permission-mode plan --resume …` but `--model haiku` |
| 6 | a **re-plan** on a `plan`-mode card | `--model opus` — same mode, different turn |
| 7 | a project with no planning model | `--model sonnet`, its execution model |
| 8 | a step whose parent is pinned to `sonnet` | `--model haiku` — steps do not inherit the parent's model |

26 checks, all green. Runs 5 and 6 are the pair that makes the rule visible: identical
cards, identical mode, and the model differs only because one of them was *asked* for a
plan.

Two things it deliberately does not reach. The post-chain **review** run only exists on the
worktree path (`settle` returns before `finishParentChain` when a run has no branch), so
its "plan mode inherited, execution model used" case is covered by the chat run above and
by `scheduler.test.ts`; and `project:alignPlan`'s `planningModel ?? defaultModel` lives
behind an `ipcMain.handle` only the renderer calls.

Proved able to fail, by three mutations, each reverted and confirmed byte-identical
afterwards:

- `resolveRunModel` reduced to the pre-phase `task.agentModel ?? project.defaultModel` →
  **3 red** (both planning runs).
- `addSubtask` restored to `agentModel: parent.agentModel ?? null` → **2 red** (the step
  inherits `sonnet`).
- `expectsPlan &&` dropped from `startTask`'s call → **1 red** (the chat reply is billed as
  planning).

### Done when

- A project can name a planning model, and a card planned in that project plans on it and
  runs its steps on the other one.
- A project that names no planning model behaves exactly as it does today.
- A card or step can be set back to *Project default*, and an existing card that never
  really chose already is.
- A chat reply and a post-chain review on a `plan`-mode card use the execution model.
- `pnpm typecheck`, `pnpm test` and `pnpm build` are green.

**Notes.**

- The phase ships as a **MINOR** bump, reached through the per-commit bumps each step makes
  ([`CONTRIBUTING.md`](../../CONTRIBUTING.md) §4). This first step is `docs` only, so it
  takes the **PATCH** its own change is worth (**v0.65.1**); the deliverable that adds the
  column takes the minor.
- **No tag and no release on this branch** — [`RELEASE.md`](../../RELEASE.md) rule 5, the
  same standing rule as Phases 21 and 22. The tag is cut when this lands on `development`.
- Every step of this plan shares the one branch `feat/setting-ai-agent-models-for-planning`,
  so each step's session reads this entry to find what the previous one left it.
- The worktree this plan runs in has **no `node_modules`**, so the first step that touches
  `src/` pays for a `pnpm install` before any gate can run. This step changes only this
  file; there is nothing for a gate to say about it.

---

## Phase 24 — Projects and their tickets

**Goal.** Let the app *be* a tracker, not only mirror one. Today a card either comes from a
plan file, is typed in by hand, or is mirrored from JIRA — and everything that makes a
tracker a tracker (a permanent key, epics, issue links, labels, milestones, estimates,
start/due dates, a timeline you can see them on) belongs to somebody else's instance. This
phase adds **native ticket projects**: a project with its own key prefix, its own tickets
(`TM-123`), and a Gantt to plan them on, sharing every mechanism the board, the chain and
the agent already have.

The whole design rests on one decision — a native ticket project is **a `projects` row**,
and a ticket is **a `tasks` row** — so nothing below is a second copy of the board.

This entry is the design, written before any code. The build phases, the verification plan and
the critical-files list were each added by a later step of this plan, every one of them its own
session on this same branch. With the last of them the entry is complete: **everything below is
written, and none of it is built yet.**

### A native ticket project is a `projects` row with `kind: 'ticket'`

`ProjectKind` ([`model.ts:119`](../../src/shared/model.ts)) widens to
`'plan' | 'agent' | 'ticket'`. Reusing the table is the whole point: `tasks.projectId`
already cascades from `projects` ([`store.ts:561`](../../src/main/store.ts)), and
`task_events`, `task_activity`, `task_links` and `task_attachments` all key off
`projectId`/`taskId`. A separate table would mean rebuilding every one of those
relationships — and the timeline, the attachments and the chain arrows with them.

Two new `projects` columns: `ticketPrefix TEXT COLLATE NOCASE` (`'TM'`) under a **partial
unique index** (`WHERE ticketPrefix IS NOT NULL`, so the projects that have no prefix — every
existing one — do not collide on NULL), and `ticketSeq INTEGER NOT NULL DEFAULT 0`.

`ticketSeq` is deliberately **not** a field on `Project`. It is an allocator, not a
property: exposing it would put a counter that is stale the moment anyone creates a ticket
into every optimistic renderer copy, and it would let `updateProject`'s `sets` builder
([`store.ts:1858`](../../src/main/store.ts)) write it from a patch. It is read and bumped
inside the store, by the one function that allocates a key, and by nothing else.

`COLLATE NOCASE` on the prefix for the reason `task_attachments.name` has it
([`store.ts:772`](../../src/main/store.ts)): the uniqueness a human means by "the prefix is
taken" is case-blind, and `TM` and `tm` are the same project's key to everyone but SQLite.

### Key allocation

`ticketKey` (`'TM-123'`, denormalised for display) **and** `ticketNumber` (the durable
ordinal) both live on `tasks`. Storing both means the card, the backlog row, the Gantt
gutter and the link picker read `task.ticketKey` with no project lookup — exactly how
`externalKey` works today ([`model.ts:487`](../../src/shared/model.ts)) — while a prefix
rename stays one `UPDATE` over the project's rows.

The bump and the insert are **one `db.transaction()`**, so a refused create never burns a
number. The next key comes from `ticketSeq`, **never** `MAX(ticketNumber)`: deleting
`TM-500` must not make the next ticket `TM-500` again, because a key is a permanent name
and re-issuing it makes every note, branch and link that ever mentioned it a lie. A partial
unique index on `tasks(ticketKey)` is the schema-level backstop under that promise.

New pure module `src/shared/ticketKey.ts`: `formatTicketKey`, `parseTicketKey`,
`normalizeTicketPrefix` — upper-cases, strips punctuation, refuses empty, and refuses a
pure number, so `12-3` can never be a key that `parseTicketKey` would have to guess at.

### Epics, links, and the two things they must not be confused with

**Epics** are a task row with `issueType: 'epic'`, and children carry `epicTaskId`. An epic
needs a status, an assignee, a description, comments, attachments, a Gantt bar and a place
in a column — all of which already hang off `tasks`, and none of which a lookup table
would have.

`epicTaskId` is a **new** column and deliberately not `parentTaskId`, because
`parentTaskId` already means "step of an approved plan":
`groupSubtasks` ([`boardColumns.ts:57`](../../src/renderer/src/board/boardColumns.ts))
renders such children *inside* the parent card, and `chainRunner` executes them in order
([`chainRunner.ts:385`](../../src/main/chainRunner.ts)). Reusing it would silently turn
every story under an epic into an executable step of it.

**Issue links** go in a new `ticket_links` table, named apart from `task_links` on purpose.
`task_links` is the chain of execution — an arrow that *gates when a run may start*
([`taskChain.ts`](../../src/shared/taskChain.ts), `linkSatisfied`/`blockedBy`).
`ticket_links` documents a relationship and gates nothing. Conflating them would mean
marking a ticket "duplicates" another and having the scheduler refuse to start it.

One row per link, **directed, with an inverse lookup** — not two rows. Two rows double
every write and make "delete this link" ambiguous. Both ends are indexed, exactly as
`task_links` indexes both ([`store.ts:750-751`](../../src/main/store.ts)), so the inward
query is as cheap as the outward one.

`src/shared/ticketLinks.ts` owns the vocabulary — `blocks`, `duplicates`, `relates`,
`implements`, `causes`, `clones` — each with `outward`/`inward` phrasings and a `symmetric`
flag; `linksFor(links, taskId)` phrases every link from that ticket's point of view, so no
two surfaces can word an inverse differently; and `canLinkTickets` returns refusals **as
data**, the `canLink` / `LINK_REFUSAL_MESSAGE` shape `taskChain.ts` already uses
([`taskChain.ts:91-108`](../../src/shared/taskChain.ts)).

### The rest of the schema

- **Labels** — a `ticket_labels` registry (per project; it is what gives a label its colour
  and the filter dropdown its list) **plus** `tasks.labels` as a JSON array of *names*.
  `board:tasks` is the hottest query in the app and a join table would add a second query
  and a per-render regroup to it; `parseStringArray` already exists
  ([`store.ts:1594`](../../src/main/store.ts)) and `dependsOn` sets the precedent. Names,
  not ids, so deleting a label degrades a chip to grey rather than dangling.
- **Milestones** — a `milestones` table (name, `dueAt`, colour, open/closed) plus
  `tasks.milestoneId`. A real table, because a milestone is drawn on the timeline whether
  or not any ticket points at it.
- **Estimation** — `storyPoints REAL`, `estimateDays REAL`. `REAL` because half-points
  exist and "half a day" is the commonest estimate there is. **Nullable, never
  0-defaulted**: "not estimated" is a real state that `0` cannot express, since 0 points is
  itself a legitimate estimate. Independent of each other — the app invents no conversion
  between them.
- **Dates** — `startAt` / `dueAt` as epoch ms, matching every other date in this schema
  (`statusNoteAt`, `landedAt`, `archivedAt`). Date strings would guarantee a timezone bug
  at the first comparison.
- **People** — a `people` table (app-wide, not per project: a person works across projects)
  with a partial unique index on `isMe`, plus `tasks.assigneeId` / `tasks.reporterId`.
  `initials` and colour are **stored, not derived** — two "Anna K"s need different initials
  and only a human can say which.
- **Priority is not a new column.** Native tickets reuse `externalPriority`: `priorityRank`,
  `PriorityGlyph` and `sortCards` all read it already
  ([`boardColumns.ts:191`](../../src/renderer/src/board/boardColumns.ts)), and
  `task:setPriority`'s write-back branch is keyed on
  `existing.externalSource === 'jira' && existing.externalKey`
  ([`ipc.ts:871`](../../src/main/ipc.ts)) — which a native ticket is not, so the same
  channel is local-only for it without a line of new code.
- **`issueType`** (`epic|story|task|bug|subtask`) is a third field beside `tasks.type` (the
  legacy ad-hoc `bug|feature`, [`model.ts:437`](../../src/shared/model.ts)) and
  `externalType` (JIRA's). One resolver, `typeIconKeyFor(task)` in `src/shared/tickets.ts`,
  picks the icon by precedence, so three surfaces cannot disagree about what a card is.

**No `ON DELETE SET NULL`.** `epicTaskId`, `milestoneId`, `assigneeId` and `reporterId` are
plain `TEXT` with no foreign key, exactly as `parentTaskId` already is. `foreign_keys = ON`
is set at open ([`store.ts:534`](../../src/main/store.ts)), so a declared cascade really
fires — and a cascade here would change task rows **with no IPC event**, while this renderer
only refreshes on `project:tasksChanged` / `task:changed` and nothing polls. So a milestone
delete nulls its tickets in an explicit `UPDATE` inside the same transaction, followed by an
explicit push. Real cascades stay only where the renderer re-reads the whole list anyway:
`ticket_links` → `tasks`, and `ticket_labels` / `milestones` → `projects`.

### Coexisting with the JIRA board

`Task['source']` ([`model.ts:413`](../../src/shared/model.ts)) gains `'ticket'`. `source`
already answers "who owns this row", and the JIRA reconciler filters on it in both
directions — `t.source === 'jira' && t.externalKey`
([`jiraSync.ts:359`](../../src/main/jira/jiraSync.ts) and
[`:591`](../../src/main/jira/jiraSync.ts)) — so a dedicated value is the *structural*
guarantee that `reconcileJiraTasks` can never adopt, rewrite or archive a native ticket.

`isBoardCard` ([`board.ts:80`](../../src/shared/board.ts)) currently reads
`isPersonalBoard(task.projectId) && !task.parentTaskId`, and gates whether dragging a card
means anything. It widens to also accept `task.source === 'ticket'`, staying a pure
function of `Task` alone.

Store reads: `getPersonalTasks` / `getPersonalTasksForSync` / `getArchivedTasks` stay
hard-wired to `PERSONAL_PROJECT_ID`, and new `getBoardTasks(projectId)` /
`getArchivedTasksFor(projectId)` sit under them as the general form. The JIRA sync keeps
calling `getPersonalTasksForSync()` and therefore structurally cannot see a ticket project.

`sortCards`, `groupSubtasks`, `focusCards` and `columnForTask` are **untouched** — which is
precisely why `epicTaskId` had to be a new column.

### The Gantt

Hand-rolled SVG, following `gitGraphView.ts` + `GitGraphPane.tsx` and `chainArrows.ts` +
`ChainOverlay.tsx`: **all arithmetic in a pure module, a thin `.tsx` that only emits
elements.** There is no chart or date library in this repo and never has been — the only
runtime dependencies are `better-sqlite3` and `electron-updater`
([`package.json`](../../package.json)) — and none is added.

`ganttLayout.ts` exports `ganttRange`, `ganttScale` (a **linear** ms→px scale — the month
band is drawn from tick positions, so DST and 31-day months can never desynchronise bars
from headers), `ganttTicks`, `ganttRows` (epics → their tickets; a *collapsed* epic
contributes one row whose bar is the union of its children's dates), `ganttBar`,
`ganttMarkers`, `ganttDependencyPath`, `todayX` and `rescheduleTo`.

Milestones are vertical markers with labels in the header, **not rows** — a milestone is an
instant, and a row per date wastes a lane.

Deliberately **not** `preserveAspectRatio="none"`. `TokenChart` may stretch because it is a
shape ([`TokenChart.tsx:78`](../../src/renderer/src/TokenChart.tsx)); a Gantt must stay
1px = 1px or its bars stop lining up with its own header.

### Traps the later steps must not walk into

Each of these was read in this worktree, not remembered.

- **`rowToProject` coerces every unknown kind to `plan`** — `kind: r.kind === 'agent' ?
  'agent' : 'plan'` ([`store.ts:1584`](../../src/main/store.ts)). A `'ticket'` row written
  before that ternary is widened reads back as a **plan project**, and every other
  kind-test in the app is written as "not agent" — `project:list` hides
  `!isPersonalBoard(id) && kind !== 'agent'` ([`ipc.ts:535`](../../src/main/ipc.ts)) and
  the plan watcher skips `isPersonalBoard(id) || kind === 'agent'`
  ([`planWatcher.ts:49`](../../src/main/planWatcher.ts)). So a ticket project would be
  listed by `project:list` as a plan project and have a plan file watched for it. The read,
  the two filters and the type widen **together, in one commit**.
  **Amended by the build-steps step:** of those two symptoms only the watcher is live.
  **No renderer calls `project:list`** — the legacy Projects tab was retired by the Phase 13
  workspace refresh, `TabId` is `'mytasks' | 'performance' | 'attention' | 'settings' |
  'scratch'` ([`App.tsx:194`](../../src/renderer/src/App.tsx)), and the only caller left of
  `project:add` / `project:update` / `project:syncPlan` is `ProjectDialog.tsx`, which
  nothing imports. The filter still widens — the channel is the contract's answer to "what
  is a plan project", and build step 4 gives it a renderer again — but a session that goes
  looking for a Projects tab to check the bug against will not find one.
- **`addProject` forces the plan-less fields off a single `isAgent` boolean**
  ([`store.ts:1780`](../../src/main/store.ts)), and its `planPath` fallback is
  `hostJoin(input.path, 'plan.md')`. A ticket project needs the same forcing (`planPath:
  ''`, `writeBackPlan: false`) or it is handed a plan file it does not have. It may also
  legitimately have **no path at all**: it is not a repo. `''` is already a real value
  here — the Personal board is seeded with `path: ''` and `planPath: ''`
  ([`store.ts:996`](../../src/main/store.ts)).
- **`project:add` parses and watches unless the project is an agent one**
  ([`ipc.ts:520-526`](../../src/main/ipc.ts)). Ticket projects take the same early return.
- **`board:tasks` takes no argument.** It is declared `() => Promise<Task[]>`
  ([`ipc.ts:667`](../../src/shared/ipc.ts)) and handled as `store.getPersonalTasks()`
  ([`ipc.ts:1595`](../../src/main/ipc.ts)); `board:archived` is its complement. Both are
  read by `MyTasks.tsx` and `App.tsx`, which refresh on `project:tasksChanged`. See
  decision **D1** below for what they become.
- **Widening `isBoardCard` is not a board-only change.** It also enlists native tickets in
  `guardCardStatus` and `preRunStatus` ([`cardStatusGuard.ts:58,94`](../../src/main/cardStatusGuard.ts)),
  which is exactly what we want — a ticket's column is the human's, and an agent run must
  borrow `status` rather than move the card — but it must be *chosen*, not discovered.
- **A ticket project is never a run target.** `resolveAgentProject` filters
  `kind === 'agent'` ([`agentProjects.ts:19`](../../src/shared/agentProjects.ts)), and
  `task:assignAgent` / `task:setProject` refuse a target that is not an agent project
  ([`ipc.ts:669,745,834`](../../src/main/ipc.ts)). A native ticket delegated to an agent
  still points `agentProjectId` at an *agent* project. Nothing to change here — and nothing
  to "fix", either.
- **New columns are added by the PRAGMA loops, and an index on one comes after its ALTER.**
  The task/project column loops live at [`store.ts:874-990`](../../src/main/store.ts), and
  `idx_tasks_parent` is created *after* them with the comment saying why
  ([`store.ts:988-990`](../../src/main/store.ts)): on an older database the column does not
  exist until the ALTER has run. Every partial unique index this design adds is in the same
  position.
- **`db.transaction()` is the existing idiom** ([`store.ts:1487`](../../src/main/store.ts)),
  and key allocation is the first place in this app where skipping it corrupts a *name*
  rather than a row.

### Decisions taken without the human

Recorded here, in the plan of record rather than in a commit message, so a later reader can
tell a decision from a guess.

- **D1 — `board:tasks` gains an optional `projectId`; no second channel.** It becomes
  `(projectId?: string) => Promise<Task[]>`, defaulting to `PERSONAL_PROJECT_ID` and
  backed by the new `getBoardTasks(projectId)`, with `board:archived` following it. One
  channel, one handler, one refresh path — a parallel `board:ticketTasks` would double the
  event wiring for a query that differs by a `WHERE`, and the two would drift the first
  time one of them learned something the other did not. Every existing call site compiles
  unchanged because the argument is optional.
- **D2 — a ticket project has no repo path.** `path` and `planPath` are `''`, as they are
  for the Personal board. If a ticket project ever needs a repo, it is because somebody
  wants to delegate its tickets — and that already works today, through the card's
  `agentProjectId` pointing at a real agent project.
- **D3 — the version this branch bumps from.** This worktree's `package.json` says
  `0.69.0`, but `HEAD` is an ancestor of `development`, which has since released
  **v0.70.0**. Bumping `0.69.1` would name a version that has been superseded and would
  read as a *downgrade* when this branch lands. So this step takes **v0.70.1** — the PATCH
  after the released line — and each later step bumps from there.

### Critical files

The nine steps below touch a good deal of the app, but they *live* in ten files. Each is named
here with the shape it already has, because in every one of them that shape decides what the step
touching it is allowed to do — and none of that is legible from a deliverable list. Every line
below was opened in this worktree, and where the reading contradicts an earlier section of this
entry it says so rather than leaving the two to disagree.

#### `src/main/store.ts` — the schema, the migrations, the allocator, all CRUD

2,656 lines, and the single largest thing this phase does. Step 1 is almost entirely this file;
steps 3 and 9 exist to prove what it did.

Its layout is fixed, and **a new column enters at seven stops or it is silently dropped**: the
`db.exec` block that creates today's ten tables ([`:537-772`](../../src/main/store.ts)); the
PRAGMA-guarded ALTER loops, one for `projects` ([`:785`](../../src/main/store.ts)) and one for
`tasks` ([`:872`](../../src/main/store.ts), whose list already carries 35 entries); then
`TaskRow` ([`:61`](../../src/main/store.ts)), `taskToRow`
([`:1621`](../../src/main/store.ts)), `rowToTask` ([`:1685`](../../src/main/store.ts)),
`insertTask`'s parallel column *and* value lists ([`:1102-1124`](../../src/main/store.ts)) and
`updateTask`'s allowlist ([`:1951-1982`](../../src/main/store.ts)). The comment sitting inside
that INSERT ([`:1119-1121`](../../src/main/store.ts)) is the scar from the last time one was
missed.

Three readings that change what step 1 has to write:

- **`getBoardTasks` is nearly free.** `selectBoardTasks` and `selectArchivedBoardTasks`
  ([`:1093-1099`](../../src/main/store.ts)) are already parameterised on `projectId`; only the
  three exported methods pin it — `getPersonalTasks` ([`:2007`](../../src/main/store.ts)),
  `getPersonalTasksForSync` ([`:2011`](../../src/main/store.ts)) and `getArchivedTasks`
  ([`:2015`](../../src/main/store.ts)) — one line of body each. **D1** is therefore an
  exposure, not a new query, and the "reduced to wrappers" in step 1 is literal.
- **The allocator's counter-example is already in the file.** `nextOrder`
  ([`:1154`](../../src/main/store.ts)) is `COALESCE(MAX("order"), -1) + 1` — exactly the shape
  `ticketSeq` must **not** take, for the reason the key-allocation section gives. Reading the
  two side by side is the clearest statement of why one is right for an ordering and fatal for
  a name.
- **`db.transaction()` has three precedents to copy** — [`:1487`](../../src/main/store.ts),
  [`:1523`](../../src/main/store.ts) and `deleteTaskDeep`
  ([`:1762`](../../src/main/store.ts)), which is the model for "delete this row and null its
  dependents in the same transaction".

And one line no gate will ever look at: the `TaskRow`-side doc comment saying `kind` is
`'plan' | 'agent'` ([`:156`](../../src/main/store.ts)).

#### `src/shared/model.ts`, `src/shared/board.ts` — the domain vocabulary

891 and 569 lines, both already carrying a `.test.ts`. Everything else in the phase is
downstream of the three edits here: `ProjectKind` ([`:119`](../../src/shared/model.ts)),
`Task['source']` ([`:413`](../../src/shared/model.ts)) and the `Task` interface itself
([`:379`](../../src/shared/model.ts), 46 fields before this phase adds twelve).

Both unions are **prose-documented above their declaration** — `ProjectKind`'s comment
enumerates the two kinds and what each one is for
([`:107-118`](../../src/shared/model.ts)) — which is the second doc block, after
`store.ts:156`, that widening silently falsifies. Widening a type is a one-word edit; keeping
its documentation true is the rest of the work.

`isBoardCard` is three lines ([`:80-82`](../../src/shared/board.ts)) under a ten-line comment
saying precisely why it excludes what it excludes ([`:70-79`](../../src/shared/board.ts)) — a
plan project's queue and a step of an approved plan. A native ticket is neither, which is what
makes the widen correct; the comment has to say so, because the trap list already notes that
widening this enlists tickets in `guardCardStatus` and `preRunStatus` as well.

#### `src/shared/ipc.ts` → `src/main/ipc.ts` — the contract, in that order

`IpcApi` holds **111 channels** ([`:201-836`](../../src/shared/ipc.ts)) and `IpcEvents`
**17** ([`:843-936`](../../src/shared/ipc.ts)); `src/main/ipc.ts` registers **exactly 111**
`handle(` calls. That one-to-one is the invariant step 2 has to leave standing: a channel
declared with no handler type-checks perfectly and rejects at run time, in the renderer, with
the channel name in the message. Contract first is not a style preference here — it is the only
ordering in which the compiler helps at all.

The three shapes to copy, all of them read rather than remembered:

- The `agentProject:*` four ([`:306-315`](../../src/shared/ipc.ts)) — list / add / update /
  remove, with the comment on `list` explaining why it is *separate* from `project:list`.
  `ticketProject:*` is the same argument a second time.
- `board:tasks` ([`:667`](../../src/shared/ipc.ts)) and `board:archived`
  ([`:676`](../../src/shared/ipc.ts)), the two that widen under **D1**.
- `LinkResult` on `chain:link` ([`:701`](../../src/shared/ipc.ts)) — refusals as data, which
  `ticketLink:add` repeats.

The handler idiom, read at `task:setProject` ([`ipc.ts:829-843`](../../src/main/ipc.ts)): fetch
the row, `throw new Error` with a sentence a human can read, write through `store.updateTask`,
`send` the event, return the row. `task:assignAgent` ([`:662-671`](../../src/main/ipc.ts)) is
the same shape with the guards step 2 needs most — unknown target, wrong `kind`, a run already
live. The three plan-project filters step 1 fixes are all in this file too:
`targetsInUse` ([`:460-466`](../../src/main/ipc.ts)), `project:add`'s early return
([`:520-527`](../../src/main/ipc.ts)) and `project:list`'s filter
([`:529-543`](../../src/main/ipc.ts)).

The preload needs no change, and the reason is one line: `invoke<K extends keyof IpcApi>`
([`preload/index.ts:29`](../../src/preload/index.ts)) is generic over the contract, so a new
channel is reachable the moment it is declared.

#### `src/renderer/src/MyTasks.tsx`, `src/renderer/src/board/TaskCard.tsx` — board scoping

1,278 and 1,388 lines; step 6 is the only step that edits them, and its acceptance is that a
database with no ticket project renders a byte-identical board.

`MyTasks` seeds itself with one `Promise.all` over seven channels
([`:298-315`](../../src/renderer/src/MyTasks.tsx)) and subscribes **seven** events in one effect
depending on `[patchTask, refreshArchived]` ([`:346-390`](../../src/renderer/src/MyTasks.tsx)).
That is the count behind step 6's ref rule, and it is worth stating as a number: putting
`scopeId` into `patchTask`'s empty dependency array
([`:337-340`](../../src/renderer/src/MyTasks.tsx)) would tear down and rebuild all seven on
every scope change. Of step 6's four `PERSONAL_PROJECT_ID` sites, two are the comparisons that
decide whether an incoming row belongs to this board — inside `patchTask`
([`:338`](../../src/renderer/src/MyTasks.tsx)), which the effect depends on, and inside the
`project:tasksChanged` handler ([`:349`](../../src/renderer/src/MyTasks.tsx)), which is in the
effect itself. Those two are the ones the scope has to reach without becoming a dependency of
either; the third is a prop on `AddTaskDialog`
([`:1248`](../../src/renderer/src/MyTasks.tsx)) and the fourth is the seed call. `moveTask`
([`:657-672`](../../src/renderer/src/MyTasks.tsx)) is the optimistic-then-roll-back shape step
8's drag copies: paint the guess, await the channel, paint what came back, and on a throw paint
the row you kept and surface the message.

On the card, three of step 6's five branches have an existing neighbour to sit beside: the epic
slot ([`:1184-1191`](../../src/renderer/src/board/TaskCard.tsx)), which already falls back from
name to key and is where the native epic line goes; the chip row
([`:1151-1162`](../../src/renderer/src/board/TaskCard.tsx)), where label chips join the JIRA
label and the sprint; and the footer's ticket badge
([`:1198`](../../src/renderer/src/board/TaskCard.tsx)), which is an `<a href>` — the native key
badge is deliberately not, because there is nowhere to go. `projectName` arrives as a prop
([`:744`](../../src/renderer/src/board/TaskCard.tsx)) and is rendered at
[`:1178-1180`](../../src/renderer/src/board/TaskCard.tsx); the epic name follows it.

`typeIcon` ([`:674-688`](../../src/renderer/src/board/TaskCard.tsx)) already resolves two
vocabularies — the internal `type` and JIRA's `externalType` — and it is exported for a reason
that is about to matter a third time: the detail pane imports it from the board card
([`TaskDetail.tsx:50`](../../src/renderer/src/TaskDetail.tsx), used at
[`:641`](../../src/renderer/src/TaskDetail.tsx)) rather than repeating the mapping. `issueType`
enters *here*, through `typeIconKeyFor`, or the card
([`:1072`](../../src/renderer/src/board/TaskCard.tsx)), the pane and the backlog table each
learn it separately and disagree.

#### `src/renderer/src/AgentProjects.tsx` — the live drawer/form idiom

586 lines, and the pane step 4 is modelled on: `useState<Project[] | null>(null)` plus a
`useCallback` refresh ([`:106-108`](../../src/renderer/src/AgentProjects.tsx)) handed to
`useInitialLoad` ([`:110`](../../src/renderer/src/AgentProjects.tsx)), a `PaneLoading
shape="rows"` early return carrying that hook's error and retry
([`:122-131`](../../src/renderer/src/AgentProjects.tsx)), then a list of `Card`s and one local
add/edit component ([`:224`](../../src/renderer/src/AgentProjects.tsx)) rendered as an
`OverlayDrawer position="end" size="medium"`
([`:378-382`](../../src/renderer/src/AgentProjects.tsx)). The form seeds itself in an effect
keyed on `open` — from the project when editing, from the app's defaults when adding
([`:262-294`](../../src/renderer/src/AgentProjects.tsx)) — and `save`
([`:321-365`](../../src/renderer/src/AgentProjects.tsx)) branches on `project ? update : add`,
holds a `saving` flag, surfaces the failure in the drawer rather than throwing, and calls
`onSaved()` then `onClose()`.

**One correction to step 4.** It says the shell copies "`useInitialLoad` + `Promise.all` …
subscriptions: the opening of `AgentProjects.tsx` verbatim". There are **no subscriptions to
copy**: this file contains zero `window.api.on` calls. It stays current by re-reading after its
own writes — `refresh()` from `remove`
([`:116`](../../src/renderer/src/AgentProjects.tsx)) and from the drawer's `onSaved`
([`:209`](../../src/renderer/src/AgentProjects.tsx)) — which is sufficient for a pane nothing
else writes to. A `ticketProject:changed` subscription is therefore **new code**, and the pane
to copy one *from* is `MyTasks.tsx` above. Also confirmed while reading: the design's "do not
reuse `BaseBranchField`" is a real exclusion — this file imports it
([`:55`](../../src/renderer/src/AgentProjects.tsx)), so copying the form wholesale would hand a
repo-less project a base-branch field (**D2**).

#### `src/renderer/src/gitGraphView.ts`, `board/chainArrows.ts` — the Gantt's pattern

196 and 416 lines, both pure, both with a `.test.ts`, and between them the whole of what steps 7
and 8 are asked to imitate. `gitGraphView`'s header states the split and names `chainArrows` as
the same split for the same reason ([`:1-11`](../../src/renderer/src/gitGraphView.ts)) — so this
is an established pattern in the repo, not a rule invented for the Gantt.

The two are the two rungs of it. `gitGraphView` is constants then arithmetic: `ROW_HEIGHT`,
`LANE_WIDTH`, `LANE_ORIGIN`, `DOT_RADIUS`
([`:23-32`](../../src/renderer/src/gitGraphView.ts)), then `laneX`
([`:35`](../../src/renderer/src/gitGraphView.ts)) / `rowY`
([`:40`](../../src/renderer/src/gitGraphView.ts)) / `gutterWidth`
([`:50`](../../src/renderer/src/gitGraphView.ts)) mapping an index to a pixel, then `edgePath`
([`:73`](../../src/renderer/src/gitGraphView.ts)) returning an SVG path *string*. `chainArrows`
goes one rung further: `buildChainDrawing` ([`:347`](../../src/renderer/src/board/chainArrows.ts))
returns an entire `ChainDrawing` ([`:99`](../../src/renderer/src/board/chainArrows.ts)) and the
component only maps it to elements. `ganttLayout.ts`'s exported list belongs at the second rung.

Three details the `.tsx` half must match:

- **Both `<svg>`s take a width and a height in pixels and carry no `viewBox`** —
  [`GitGraphPane.tsx:338-344`](../../src/renderer/src/GitGraphPane.tsx) and
  [`ChainOverlay.tsx:276-283`](../../src/renderer/src/board/ChainOverlay.tsx). The design's
  "deliberately not `preserveAspectRatio`" is therefore the house habit rather than a new rule;
  the only `viewBox` on the board is on an arrowhead `<marker>`
  ([`ChainOverlay.tsx:184`](../../src/renderer/src/board/ChainOverlay.tsx)).
- **Computed dimensions go in `style={{}}`**
  ([`GitGraphPane.tsx:336`](../../src/renderer/src/GitGraphPane.tsx) and
  [`:375`](../../src/renderer/src/GitGraphPane.tsx)) while everything static stays in
  `makeStyles` ([`:58`](../../src/renderer/src/GitGraphPane.tsx)).
- **One constant, shared by the drawing and the rows.** `ROW_HEIGHT` is exported and the row
  list sets its height from it, which is what keeps a dot on its own row
  ([`gitGraphView.ts:15-23`](../../src/renderer/src/gitGraphView.ts)). A Gantt bar and its
  header tick are the same relationship.

#### `scripts/verify-attachments.mjs` — the template for `verify-tickets.mjs`

531 lines, and steps 3 and 9 should follow it in order rather than reinvent it, because most of
its length is traps already paid for:

- **ABI preflight first, alone** ([`:126-142`](../../scripts/verify-attachments.mjs)), via
  `./native-abi.mjs` — every scenario fails identically and unhelpfully when this is wrong.
- **The work directory is inside the repo** — `join(repo, '.verify-attachments')`
  ([`:47`](../../scripts/verify-attachments.mjs)), wiped on entry
  ([`:122`](../../scripts/verify-attachments.mjs)) and in a `finally`
  ([`:206`](../../scripts/verify-attachments.mjs)), with `--keep`
  ([`:205`](../../scripts/verify-attachments.mjs)) as the only way to inspect a failure
  afterwards. The file's own header still says "system temp dir"
  ([`:13-14`](../../scripts/verify-attachments.mjs)); the Verification section already flags
  that as stale, and `verify-tickets.mjs` should not copy the sentence along with the code.
- **`bundle()`** ([`:80-102`](../../scripts/verify-attachments.mjs)) — a Vite `ssr` build with
  `@shared` aliased and `electron` aliased to a stub that **throws** rather than returning
  plausible values ([`:59-77`](../../scripts/verify-attachments.mjs)), keeping
  `better-sqlite3` external ([`:95-98`](../../scripts/verify-attachments.mjs)) so the addon
  stays a real run-time `import`.
- **`runUnderElectron()`** ([`:105-117`](../../scripts/verify-attachments.mjs)) — spawn with
  `ELECTRON_RUN_AS_NODE=1`, trying `electron.exe` then the POSIX name
  ([`:52-53`](../../scripts/verify-attachments.mjs)).
- **The migration leg is `git archive`, never a checkout**
  ([`:144-161`](../../scripts/verify-attachments.mjs)) — for exactly this plan's reason, stated
  in that file about its own: the worktree is shared and must not move off its branch. Its two
  companions: the tar invocation must be *relative* because tar reads a leading `C:\` as a
  remote host ([`:153-157`](../../scripts/verify-attachments.mjs)), and the old tree's own
  `createStore` writes the old database — a schema hand-cut from today's code minus a table
  would prove nothing ([`:22-25`](../../scripts/verify-attachments.mjs)).
- **The scenarios are a `String.raw` template with `__PLACEHOLDER__` substitution**
  ([`:214`](../../scripts/verify-attachments.mjs), substituted at
  [`:192-196`](../../scripts/verify-attachments.mjs)), so no backtick and no `${}` may appear
  anywhere inside them, and `check` / `section` / a `failures` counter ending in
  `process.exit(1)` are what turn assertions into an exit code.

Step 3's `OLD_TAG` is **`v0.69.0`** per its own scenario list, not this file's `v0.57.0`.

#### What is deliberately not on this list

Naming the critical files invites editing what sits next to them, so the exclusions are as
load-bearing as the inclusions. `sortCards`, `groupSubtasks`, `focusCards` and `columnForTask`
are untouched — that is why `epicTaskId` is a new column.
[`jiraSync.ts`](../../src/main/jira/jiraSync.ts) is untouched — the isolation is structural,
through `source`, and a filter added there would be a second, weaker guarantee.
[`chainDrag.ts`](../../src/renderer/src/board/chainDrag.ts) and
[`useCardAnchors.ts`](../../src/renderer/src/board/useCardAnchors.ts) are untouched — the Gantt
has its own gesture in its own coordinate space. `ProjectDialog.tsx` is untouched because
nothing imports it. And `src/preload/index.ts` is untouched because it is already generic.

### Build steps

Each phase below is **one session**, leaves `pnpm typecheck` + `pnpm test` green, and
carries its own version bump in its own commit per
[`CONTRIBUTING.md`](../../CONTRIBUTING.md) §4. They are ordered by dependency: none can be
reordered without a later one reaching for a type, a channel or a component the earlier one
has not created yet.

**The version ladder.** D3 took **v0.70.1** for the design step; this section and the two
remaining planning steps each take the PATCH their own docs change is worth. The first
build step is a `feat`, so it lands on **0.71.0** whichever patch precedes it — which is
why every number below sits one minor line above the draft this section was written from
(that draft opened at `0.70.0`, a version the released line has already used). If a step
picks up unplanned work it bumps for what it actually did and the rest shift with it: the
ladder is a consequence of §4, not a schedule to be honoured against it.

- [x] **1** — Add ticket schema and store methods · `feat` → 0.71.0
- [x] **2** — Expose ticket IPC and handlers · `feat` → 0.87.0
- [x] **3** — Verify ticket schema against SQLite · `test` → 0.87.1
- [ ] **4** — Add Projects screen with backlog table · `feat` → 0.73.0
- [ ] **5** — Build ticket drawer, labels and milestones · `feat` → 0.74.0
- [ ] **6** — Scope the Kanban board to a project · `feat` → 0.75.0
- [ ] **7** — Draw the Gantt timeline read-only · `feat` → 0.76.0
- [ ] **8** — Drag Gantt bars to reschedule · `feat` → 0.77.0
- [x] **9** — Verify ticket flows and document the model · `test` → 0.77.1

#### 1 — Add ticket schema and store methods · `feat` → 0.71.0

- `src/shared/model.ts`: widen `ProjectKind` ([`:119`](../../src/shared/model.ts)) and
  `Task['source']` ([`:413`](../../src/shared/model.ts)); add the twelve `Task` fields —
  `ticketKey`, `ticketNumber`, `issueType`, `epicTaskId`, `milestoneId`, `assigneeId`,
  `reporterId`, `labels`, `storyPoints`, `estimateDays`, `startAt`, `dueAt`; add
  `ticketPrefix` to `Project` / `AddProjectInput` / `ProjectPatch` (and **not** `ticketSeq`,
  which is an allocator — see the key-allocation section above); add `Person`, `Milestone`,
  `TicketLabel`, `TicketLink`, `IssueType`, `TicketInput`, `TicketPatch`.
- New `src/shared/tickets.ts` and `src/shared/ticketKey.ts`, both with a `.test.ts`.
- `src/shared/board.ts`: widen `isBoardCard` ([`:80`](../../src/shared/board.ts)); extend
  `board.test.ts`.
- `src/main/store.ts`: the four new tables — `ticket_links`, `ticket_labels`, `milestones`,
  `people` — and their indexes in the `db.exec` block beside the existing ten
  ([`store.ts:537-772`](../../src/main/store.ts)); the two `projects` ALTERs
  (`ticketPrefix`, `ticketSeq`) and twelve `tasks` ALTERs in the PRAGMA-guarded section
  ([`store.ts:874-990`](../../src/main/store.ts)), with every partial unique index created
  *after* its ALTER, the way `idx_tasks_parent` already is; the `createTicketTx` allocator;
  `getBoardTasks` / `getArchivedTasksFor`, with the Personal three
  (`getPersonalTasks`, `getPersonalTasksForSync` ([`store.ts:2011`](../../src/main/store.ts)),
  `getArchivedTasks`) reduced to wrappers over them; CRUD for people, labels, milestones and
  ticket links, each nulling its dependents in the same transaction.
- Fix the four places that currently mean "plan project" by *elimination* and would
  therefore adopt a ticket project:
  - [`store.ts:1584`](../../src/main/store.ts) — `kind: r.kind === 'agent' ? 'agent' :
    'plan'`, so a ticket project silently reads back as `plan`. Make it an explicit
    whitelist, not a widened ternary: the next kind added must fail loudly rather than
    become a plan project too.
  - [`store.ts:1780`](../../src/main/store.ts) — `addProject`'s `isAgent` branch. A ticket
    project needs the same forcing, or `planPath` becomes
    `hostJoin(input.path, 'plan.md')` joined onto an empty path.
  - [`planWatcher.ts:49`](../../src/main/planWatcher.ts) — or a plan file is polled for a
    project that has none. This is the one symptom of the four that bites today.
  - [`ipc.ts:463`](../../src/main/ipc.ts) (`targetsInUse` counts every non-Personal project's
    exec target — a pathless ticket project would vote on WSL readiness it knows nothing
    about), [`:523`](../../src/main/ipc.ts) (`project:add`'s parse-and-watch early return)
    and [`:535`](../../src/main/ipc.ts) (`project:list`'s filter).

**Each new task column must be touched in all seven places in `store.ts`**: the
`CREATE TABLE` block, the ALTER list, `TaskRow`, `taskToRow`, `rowToTask`, `insertTask`'s
column *and* value lists, and `updateTask`'s allowlist. Miss `insertTask` and a field set at
creation is silently dropped — the file already carries the comment left by that happening
to `projectTagId` ([`store.ts:1119-1121`](../../src/main/store.ts)). `labels` needs
`parseStringArray` on read ([`store.ts:1594`](../../src/main/store.ts)); `isMe` must be
encoded 0/1 by hand, since better-sqlite3 refuses to bind a boolean.

#### 2 — Expose ticket IPC and handlers · `feat` → 0.87.0 (planned as 0.72.0; see outcome below)

Contract first ([`docs/04`](../04-contributing-guide.md) Recipe A) — `src/shared/ipc.ts`
before either side:

- `ticketProject:list|add|update|remove`, modelled on the `agentProject:*` four
  ([`ipc.ts:306-315`](../../src/shared/ipc.ts)); `board:scopes`.
- `board:tasks` / `board:archived` ([`ipc.ts:667,676`](../../src/shared/ipc.ts)) widen to
  take an **optional** `projectId` — optional, or
  [`App.tsx:286`](../../src/renderer/src/App.tsx)'s argument-free call and the four in
  `MyTasks.tsx` ([`:293,300,306,323`](../../src/renderer/src/MyTasks.tsx)) all break. This
  is decision **D1** above.
- `ticket:create` (allocates the key) / `ticket:update`. No `ticket:backlog` channel: the
  Projects screen calls `board:tasks(projectId)`, so there is one truth about what is on a
  board.
- `person:list|add|update|remove|setMe`; `label:list|save|remove`;
  `milestone:list|save|remove` — one `save` each rather than add+update, matching
  `settings:save` ([`ipc.ts:596`](../../src/shared/ipc.ts)).
- `ticketLink:list|add|remove`, with `TicketLinkResult` returning refusals as data like
  `LinkResult` ([`ipc.ts:55,701`](../../src/shared/ipc.ts)).
- Events: `ticketProject:changed`, `ticketLink:changed`, `person:changed`, `label:changed`,
  `milestone:changed`. Existing `project:tasksChanged` is reused for ticket rows — it
  already carries `projectId`, so live board updates come free.
- `src/main/ipc.ts`: handlers and guards — unknown or non-ticket project, blank title,
  malformed or taken prefix, epic-of-epic, epic in another project, link to an unknown task,
  `setMe` clearing the previous Me. Preload needs no change (`invoke`/`on` are generic).
- New `src/shared/ticketLinks.ts` + `.test.ts`.

**Outcome, and two corrections.** Landed as `packages/shared/src/ipc.ts` →
`apps/client/src/main/ipc.ts` — the monorepo split renamed both paths this section cites, but
changed nothing about the shapes. Store side needed **no changes at all**: step 1's
`getBoardTasks`/`getArchivedTasksFor`, `updateTask`'s ticket-field allowlist and the full
people/milestone/label/ticket-link CRUD were already there, so this step was the IPC layer
only, exactly as its title says. The version bump is **0.87.0**, not 0.72.0 — the ladder above
was drafted against a `0.70`-era baseline and the app had already reached `0.86.0` by the time
this step ran; CONTRIBUTING.md §4 pins the number to `apps/client/package.json`, not to a plan
written earlier. New guards live in one `assertTicketRefs` helper shared by `ticket:create` and
`ticket:update`, rather than duplicated per handler. The exhaustiveness gates
(`ipcRelay.test.ts`'s host-only list needed no entry — every new channel relays) forced two
files this section did not name: `packages/shared/src/ipcEventFanout.test.ts` (the `CLASSIFIED`
table is asserted equal to `EVENT_FANOUT`'s keys) and `apps/web/src/board/polledEvents.ts`'s
`WHOLE_LIST_EVENTS`, both updated for the same five events.

#### 3 — Verify ticket schema against SQLite · `test` → 0.87.1

`scripts/verify-tickets.mjs`, modelled line-for-line on
[`scripts/verify-attachments.mjs`](../../scripts/verify-attachments.mjs) — Vite-bundle the
scenario with `electron` aliased to a throwing stub, run it under `ELECTRON_RUN_AS_NODE`,
scratch dir inside the repo and wiped on entry *and* exit. This comes before any UI because
it is the only thing that can prove steps 1–2 at all: **no Vitest test in this repo can open
SQLite** — the addon is built for Electron's ABI, not the Node that runs Vitest.

It must prove:

- the fresh schema, including that the three partial unique indexes really are partial;
- **key allocation is atomic** — 500 creates yield `TM-1..TM-500` with no gaps; delete
  `TM-500` and the next is `TM-501`, not a reused key; a refused create does not advance the
  counter; a raw-SQL duplicate `ticketKey` is refused;
- independent per-project counters, and a duplicate prefix refused by `COLLATE NOCASE`;
- a prefix rename rewriting every key and no `ticketNumber`;
- **cascade vs non-cascade** — deleting an epic, milestone or person leaves the tickets alive
  and nulled; deleting the project takes everything;
- `isMe` uniqueness across two `setMe` calls;
- **migration from `v0.69.0`** via `git archive`, asserting every old row survives and that
  `PRAGMA foreign_key_list(tasks)` on the migrated DB is *identical* to the fresh one;
- **JIRA isolation** — `getPersonalTasksForSync()` returns none of a ticket project's rows.

**Outcome, and three corrections.** The version bump is **0.87.1**, not the drafted
`0.72.1` — the same ladder drift step 2 already recorded, one patch further down. The
migration leg downgrades to **`v0.72.0`**, not the drafted `v0.69.0`: both tags predate
ticket columns (`git ls-tree <tag> -- src/main/store.ts` shows neither ever mentions
`ticketKey`), so either proves the same thing, and `v0.72.0` is the more recent one. Both
also predate the pnpm-workspace split (`apps/client` did not exist yet — the tree was
`src/main`, `src/shared` at the repo root), which `verify-attachments.mjs` does not account
for: its `git archive` runs with `cwd` at this package, and a pathspec resolved from a
directory that is not part of the old tag's tree is a `fatal: current working directory is
untracked`, not a silently-wrong answer. `verify-tickets.mjs` runs that one command from the
repo's top level instead — everything else about the two scripts (the scratch layout, the
Vite bundling, the Electron-as-Node run) is unchanged. Third: **both forges**, not JIRA
alone — GitHub sync landed on this board after this section was drafted, so the isolation
proof is two independent facts (a JIRA-sourced row and a GitHub-sourced row can each wear a
ticket's key text as their own `externalKey` without either merging into the native ticket),
not one.

The harness also found a real gap while proving the cascade bullet: `deleteTaskDeep`
(`store.ts`) nulled `milestoneId`/`assigneeId`/`reporterId` on delete, exactly as the
`tasks` table's own comment promises for all four cross-reference columns, but never
`epicTaskId` — a ticket whose epic was deleted kept a dangling pointer at the ROW, even
though nothing writable could produce one afterwards (`assertTicketRefs` in `ipc.ts` only
checks a field that is explicitly being set). Fixed in this step with one more prepared
statement, `clearEpicOnTasks`, run in the same loop as the existing three; proven by
mutation — the check goes red with the statement commented out and green with it restored.

#### 4 — Add Projects screen with backlog table · `feat` → 0.73.0

- `App.tsx`: `TabId` ([`:194`](../../src/renderer/src/App.tsx)) gains `'projects'` and `NAV`
  ([`:197`](../../src/renderer/src/App.tsx)) an entry — a *new* destination, not a revival:
  there is no Projects tab on the rail today (see the amended trap above). It is
  document-shaped, so it takes `styles.bodyPadded`, which the existing ternary
  ([`:374`](../../src/renderer/src/App.tsx)) gives every tab but My Tasks — no change to the
  `tab === 'mytasks'` special case.
- New `src/renderer/src/projects/`: `Projects.tsx` (shell — `useInitialLoad` +
  `Promise.all(['ticketProject:list', 'person:list'])`, `PaneLoading shape="rows"`,
  subscriptions: the opening of
  [`AgentProjects.tsx`](../../src/renderer/src/AgentProjects.tsx) verbatim),
  `BacklogTable.tsx`, `backlogView.ts` + `.test.ts` (`filterTickets` / `groupTickets` /
  `sortBacklog` — the app's first search and grouping, all of it pure so it is testable
  without React), `ProjectAdmin.tsx` with the add/edit `OverlayDrawer`.
- Reuse `ColorSwatches` (already the app's one palette), `useInitialLoad`, `PaneLoading`, and
  `theme.ts`'s `MONO` / `fontPx` ([`theme.ts:26,85`](../../src/renderer/src/theme.ts)). Do
  **not** import `ProjectDialog.tsx` — nothing has imported it since Phase 17 and it is the
  retired tab's dialog; `AgentProjects.tsx` is the live idiom. Do not reuse
  `BaseBranchField` — a ticket project has no repo (**D2**).

#### 5 — Build ticket drawer, labels and milestones · `feat` → 0.74.0

`projects/TicketDrawer.tsx` with `ticketFields.ts` + `.test.ts` (points/days parsing, label
splitting, date round-trip); `TicketLinksEditor.tsx` rendering through `linksFor()`;
`LabelRegistry.tsx`; `MilestoneList.tsx`; `PeopleSettings.tsx` + `PersonAvatar.tsx`, wired as
a new `'people'` section in `Settings.tsx` alongside the existing five
([`Settings.tsx:145`](../../src/renderer/src/Settings.tsx)) — app-wide, where a roster
belongs. After this every field of a ticket has a place to be edited.

Every text field goes through `useDraft` ([`drafts.ts:101`](../../src/renderer/src/drafts.ts)),
keyed on the ticket id — the rule `TaskDetail` already follows, so switching rows never eats
half-typed text.

#### 6 — Scope the Kanban board to a project · `feat` → 0.75.0

- `MyTasks.tsx`: a scope `Dropdown` fed by `board:scopes`, persisted as
  `AppSettings.boardScopeId` so the board comes back where you left it; the four
  `PERSONAL_PROJECT_ID` sites at [`:338`](../../src/renderer/src/MyTasks.tsx),
  [`:349`](../../src/renderer/src/MyTasks.tsx),
  [`:1248`](../../src/renderer/src/MyTasks.tsx) and the `board:tasks` seed.
- The subscription filter must read a **ref**, not a dependency. That effect is set up once
  with `[patchTask, refreshArchived]`; putting `scopeId` in `patchTask`'s deps would tear
  down and rebuild seven subscriptions on every scope change, possibly mid-drag.
- `TaskCard.tsx`: five additive branches, each drawing nothing when its field is null — key
  badge (monospace, no JIRA mark and no `href`, since there is nowhere to go), epic line
  (reusing the existing `display.showEpicName` slot,
  [`settings.ts:207`](../../src/shared/settings.ts) /
  [`TaskCard.tsx:1184`](../../src/renderer/src/board/TaskCard.tsx), with the name passed down
  as a prop the way `projectName` already is), label chips, assignee avatar, points chip.
  `BoardDisplaySettings` gains `showAssignee` / `showPoints` in the existing Display menu.

**Acceptance: with no ticket project in the database, the board is byte-identical to today.**

#### 7 — Draw the Gantt timeline read-only · `feat` → 0.76.0

`projects/ganttLayout.ts` + `ganttLayout.test.ts` — the bulk of the work: range padding and
the minimum-span floor, `msOf(xOf(t)) === t`, tick counts across a DST boundary and a 31-day
month, a collapsed epic's rolled-up bar, an undated ticket returning `null`, marker label
stacking, `todayX` outside the range. Plus `TimelinePane.tsx` and `GanttHeader.tsx`: scale
switch, epic rollup rows, an unscheduled tray, milestone markers, today line, `blocks`
dependency arrows, click a bar → `TicketDrawer`.

Computed dimensions go in `style={{}}`, never `makeStyles` — there is no Griffel build-time
plugin in this repo and `theme.ts` depends on that. The Gantt does not reuse `useCardAnchors`
([`board/useCardAnchors.ts`](../../src/renderer/src/board/useCardAnchors.ts)), which measures
in the board's coordinate space; `chainArrows.ts` is the style reference for routing, not a
dependency.

#### 8 — Drag Gantt bars to reschedule · `feat` → 0.77.0

`rescheduleTo` plus native pointer handlers (move and both resize edges), a keyboard nudge
for accessibility, and an optimistic `ticket:update` with rollback in the shape `moveTask`
already uses ([`MyTasks.tsx:657`](../../src/renderer/src/MyTasks.tsx)). Extends
`ganttLayout.test.ts` with snapping and the refusal to invert start/due. Split from step 7 so
the first Gantt lands green; this is the Gantt's own gesture in its own coordinate space and
must not touch `chainDrag.ts`.

#### 9 — Verify ticket flows and document the model · `test` → 0.77.1

Extend `scripts/verify-tickets.mjs` with the scenarios only expressible once the UI paths
exist: a project carrying epics, milestones, labels, links and dated tickets round-tripping
through the real store; a prefix rename across 500 tickets in one transaction; an epic
deleted out from under a Gantt-visible child; a person removed while assigned across two
projects. Add a `docs/` page describing the ticket model — schema, key allocation, the link
vocabulary and its inverses, and the JIRA-isolation guarantee — and a
[`docs/04-contributing-guide.md`](../04-contributing-guide.md) recipe for adding a ticket
field.

### Verification

Written before any of the nine steps runs, so each of them knows what it owes rather than
deciding afterwards. Every claim below about the gates was read in this worktree.

**The gates, per step, in order: `pnpm format` → `pnpm typecheck` → `pnpm test`.** That is
[`CONTRIBUTING.md`](../../CONTRIBUTING.md)'s own pre-commit checklist, not a convention
invented here. Four things about them are load-bearing for this phase:

- **`format` does not glob this file.** It is `prettier --write "src/**/*.{ts,tsx}"
  "*.{json,md}"` ([`package.json`](../../package.json)) — root-level markdown only. So
  `docs/**` and `scripts/*.mjs` are outside it: `verify-tickets.mjs` will never be
  reformatted by the gate and has to be written at `printWidth: 100`
  ([`.prettierrc.json`](../../.prettierrc.json)) by hand. It is also why the three planning
  steps had no `format` to run.
- **`typecheck` is two passes chained with `&&`** — `typecheck:node` (`tsconfig.node.json`)
  then `typecheck:web` (`tsconfig.web.json`) — and `src/shared` is in **both** `include`
  lists. Step 1's `model.ts` change is therefore checked twice, under two different `lib`
  sets (`ES2022` vs `ES2022 + DOM`). The `&&` also means one node-side error hides *every*
  renderer error, so steps 4–8 should run `pnpm typecheck:web` directly while iterating and
  the full `pnpm typecheck` before committing.
- **`pnpm test` is `vitest run` with no `include` override**, so the default glob also picks
  up `scripts/native-abi.test.mjs` and `scripts/update-feed.test.mjs`. The corollary matters:
  `scripts/verify-tickets.mjs` must **never** be named `*.test.mjs`. Vitest would then run it
  under plain Node, where the addon cannot load — see the ABI note below.
- **`pnpm build` is a fourth gate, owed by steps 4–8** even though the checklist names three.
  `typecheck:web` type-checks the renderer but never runs Vite, so an alias that fails to
  resolve, or a `makeStyles` call given a computed value (there is no Griffel build-time
  plugin here — the Gantt's note in step 7), compiles cleanly and breaks at build or paint
  time. Phase 22 ran it as a fourth gate for the same reason.

**The worktree has no `node_modules`.** No gate can say anything until build step 1 pays for
`pnpm install`, whose `postinstall` (`electron-builder install-app-deps`) is also what makes
the Electron-ABI addon the verification script needs.

#### The gate that will not fire

The draft this section was written from said that widening `ProjectKind` and `Task['source']`
would turn every exhaustive `switch` into a compile error — that this is the feature, and that
`typecheck` would enumerate the call sites so nobody had to grep for them. **It will not.**
Read in this worktree:

- `src/` holds 33 `switch` statements outside its tests and **not one** of them switches on
  `ProjectKind` or on `Task['source']`. Every kind-test and source-test in the app is an `if`
  or a `filter` with `===`/`!==`:
  [`ipc.ts:523,535,603,610,669,745,834`](../../src/main/ipc.ts),
  [`planWatcher.ts:49`](../../src/main/planWatcher.ts),
  [`agentProjects.ts:19`](../../src/shared/agentProjects.ts),
  [`jiraSync.ts:359,380,413,544,591`](../../src/main/jira/jiraSync.ts),
  [`taskReconcile.ts:54,91`](../../src/main/taskReconcile.ts).
- There is no `never`-exhaustiveness idiom anywhere in `src/` — `: never` appears three
  times, all of them prose in comments.
- Widening a union whose members are only ever *compared* produces no errors at all:
  `x === 'plan'` stays legal for every member of a wider union. The two places that narrow
  keep compiling while meaning the wrong thing — `rowToProject`'s ternary
  ([`store.ts:1584`](../../src/main/store.ts)) yields a value still assignable to the wider
  type, and `rowToTask`'s `as Task['source']` ([`store.ts:1694`](../../src/main/store.ts)) is
  a cast, which is the point of a cast.

So the compiler is silent in exactly the places this design most needs a reader, and the
**Traps** list above is not optional background — it is the substitute for the gate. Build
step 1 finds its four fixes by grepping `kind ===`, `kind !==`, `source ===` and `source !==`
over `src/`, and by widening the doc comment at
[`store.ts:156`](../../src/main/store.ts) (`'plan' | 'agent'`), which no gate can see at all.

#### What only `scripts/verify-tickets.mjs` can prove

**No Vitest test in this repo can open SQLite.** `better-sqlite3`'s addon is rebuilt for
Electron's ABI by `postinstall`, not for the Node that runs Vitest. Every claim this design
makes about the schema, key allocation, the cascades and the JIRA isolation is therefore
proved by `pnpm exec node scripts/verify-tickets.mjs` — steps 3 and 9, whose contents are
listed above — and by nothing else. Two consequences the steps must not let slide:

- The script is checked by **neither gate**. Neither tsconfig includes `scripts/`, and
  `format` does not glob it. It proves something only when it is actually *run*, so any step
  that changes the store runs it rather than trusting that it was green two steps ago.
- Its work directory goes **inside the repo**, under `/.verify-*/`, which
  [`.gitignore`](../../.gitignore) already covers and explains: the bundles keep
  `better-sqlite3` external and so need `node_modules` on the resolution path. Note that
  `verify-attachments.mjs`'s own header still says "system temp dir" — stale prose in the
  file step 3 is modelled on. Follow the `.gitignore` entry and the code, as
  `verify-model-split.mjs` does.

#### What nothing on this branch can reach: the rendering

**The app is never launched** — not `pnpm dev`, not the packaged exe, not even with a
throwaway `--user-data-dir`. [`RELEASE.md`](../../RELEASE.md) rule 6: `src/main/index.ts`
takes no single-instance lock, and a boot smoke test killed the user's live session on
2026-08-02. This phase's entire visual surface therefore ships unlooked-at, and these are
owed to a human rather than claimed as passing:

1. **The Gantt** (steps 7–8) — bars lining up with their own header, the month band across a
   DST boundary and a 31-day month, marker label stacking, `blocks` arrows, and whether a
   drag actually lands where the pointer is.
2. **The Projects screen and backlog table** (step 4) — grouping, search, and the add/edit
   drawer.
3. **The new card lines** (step 6) — key badge, epic line, label chips, assignee avatar,
   points chip, and step 6's own acceptance that a database with no ticket project renders a
   byte-identical board. A screenshot settles that; no test in this repo can.
4. **The ticket drawer, label registry, milestone list and people settings** (step 5).

Each step states this in its own `Tested:` trailer rather than implying otherwise. A
`Tested:` line is a claim about what was actually run
([`CONTRIBUTING.md`](../../CONTRIBUTING.md) §2), so "typecheck + test green, not looked at"
is the honest form — the same way Phases 10–13's live E2Es are recorded as owed above.

#### No new runtime dependency

`dependencies` is `better-sqlite3` and `electron-updater`, and nothing else
([`package.json`](../../package.json)) — which is why the Gantt is hand-rolled SVG. If a
later step concludes it genuinely needs one, it would be the first added since
`better-sqlite3`, and it clears [`docs/06`](../06-licensing.md) *before* it is installed:
MIT / Apache-2.0 / BSD / ISC only, never GPL / AGPL / LGPL / MPL / EPL / CDDL, confirmed with
the `pnpm licenses list` check that file prescribes.

### Done when (the design's own gates)

- The schema, the module boundaries and the vocabulary above are written down before any
  of them exists in code, and every claim about today's code carries the file and line it
  was read from.
- Nothing in this entry requires a new runtime dependency.
- Every gate each build step owes is named before the first of them runs, and so is every
  claim no gate on this branch can reach — stated as owed rather than implied by a green
  suite.
- Every file the nine steps live in is named with the shape it already has, including what
  that shape forbids, and the files they must **not** edit are named too. Where reading one
  of them contradicts an earlier section, the entry is corrected in place rather than left
  holding two answers.

**Notes.**

- This step is **docs only** — no `src/` change, so `pnpm typecheck` and `pnpm test` have
  nothing to say about it, and the worktree is deliberately not `pnpm install`ed for it.
  The first step that touches `src/` pays for the install.
- The phase ships as a **MINOR** bump overall, reached through the per-commit bumps each
  step makes ([`CONTRIBUTING.md`](../../CONTRIBUTING.md) §4). This step takes the **PATCH**
  its own change is worth (**v0.70.1**, see D3); the deliverable that adds the columns takes
  the minor.
- **No tag and no release on this branch** — [`RELEASE.md`](../../RELEASE.md) rule 5, the
  same standing rule as Phases 21, 22 and 23. The tag is cut when this lands on
  `development`.
- Every step of this plan shares the one branch `feat/support-projects-and-their-tickets`,
  so each step's session reads this entry to find what the previous one left it.

---

## Phase 25 — Cloud service

**Goal.** Give the app a hosted counterpart: a NestJS/SQL Server backend and a
browser client, so a task can be opened from a phone or a teammate's browser as
the same task the desktop app already models — not a second product that happens
to look similar. The phase starts from a **monorepo restructuring**: today the
app is one `pnpm` package (root `package.json`, flat `src/main` / `src/preload` /
`src/renderer` / `src/shared`); before a server or a web client can exist, the
pieces that will be shared across three runtimes — desktop, server, browser —
need package boundaries a workspace can reason about.

This entry is written incrementally, one step of this plan per session on this
branch, the same shape Phase 24 used above: the design goes down first, each
later step adds its own section below it. **This step is the target layout
only** — where every existing file ends up and what each new package is for.
Turning that layout into a real `pnpm-workspace.yaml` and moved files is the next
step; what proves the move (typecheck/test/build across every workspace, plus a
packaged `apps/client` install) is the step after that; an Azure cost estimate
and the plan's risks and open assumptions each get their own section too.

The stack for `apps/server` and `apps/web` is not a new choice for this
codebase's owner: it matches `vipper.iam` (`C:\Repositories\vipper.iam`), a
sibling repo reviewed for this phase — NestJS + TypeORM + `mssql` on the
backend, Vite + React + Fluent UI on the frontend, `@scope/*` workspace packages
built with `tsup` (dual ESM/CJS `exports`), a `turbo.json` pipeline, and one root
`tsconfig.base.json` that every package's own `tsconfig.json` extends
(`vipper.iam/tsconfig.base.json:3`: "Each package extends this…" — the same line
already written, almost verbatim, at this repo's own
[`tsconfig.base.json:3`](../../tsconfig.base.json)). Reusing that shape means
`apps/server` and `apps/web` are unsurprising to anyone who has touched
`vipper.iam`, not a second set of conventions to hold in your head. `vipper.iam`
scopes its packages `@iam/*`; this repo's equivalent scope is `@tm/*`.

### Two constraints the move must not break

Both are called out in this repo's own
[`electron-builder.yml:5-10`](../../electron-builder.yml):

- **`appId: network.vipper.claude-orchestrator`**
  ([`electron-builder.yml:11`](../../electron-builder.yml)) is how NSIS
  recognises an already-installed app. Renaming it would install the
  restructured build **alongside** the old one and move the updater's cache
  directory with it — every user who upgrades would get two apps instead of one.
- **`package.json`'s `"name": "claude-orchestrator"`**
  ([`package.json:2`](../../package.json), today the root package; after the
  move, `apps/client/package.json`) is what Electron derives
  `app.getPath('userData')` from — the folder holding every project, task and
  setting on the machine. Renaming it orphans that folder: the app looks in a
  new place and finds nothing there.

Neither may change, in this step or any later one, without a deliberate
migration nobody has asked for. `apps/client/package.json` also stays the app's
**version of record**: it is what `app.getVersion()` reads at runtime, and what
electron-builder's `artifactName: ${name}-${version}-setup.${ext}` names the
installer from. The root `package.json` stops being versioned meaningfully — it
becomes a workspace manifest, the way `vipper.iam`'s own root `package.json` is
(`private: true`, `"version": "0.0.0"`, only `turbo run …` scripts). `@tm/server`
and `@tm/web` are bumped to match `apps/client`'s version **in the same commit**
the restructuring lands in, so every package in the workspace names the same
release even though only `apps/client` ships an installer today.

### Target layout

```
apps/
  client/                the Electron app — package.json name "claude-orchestrator", MUST NOT change
    build/                 app icons, NSIS/AppImage resources          (was /build)
    scripts/                check-native-abi.mjs, ensure-native-abi.mjs,
                            check-update-feed.mjs                       (was /scripts)
    src/
      main/                 the orchestration engine                    (was src/main)
      preload/               the IPC bridge                             (was src/preload)
      renderer/               desktop-only UI: shell, screens, dialogs,
                              hooks — everything not moved to @tm/ui     (was src/renderer, minus
                                                                          board/, chat/, TaskDetail.tsx)
    electron.vite.config.ts                                             (was /electron.vite.config.ts)
    electron-builder.yml                                                (was /electron-builder.yml)
    package.json            name: claude-orchestrator (unchanged), the version of record
    tsconfig.node.json, tsconfig.web.json, tsconfig.json                (was at repo root)
  server/                @tm/server — NestJS + TypeORM + SQL Server     (new)
    src/
    nest-cli.json, package.json, tsconfig.json
  web/                   @tm/web — Vite + React + Fluent UI,
                          "VIPPER Task Manager Cloud"                   (new)
    src/
    index.html, vite.config.ts, package.json, tsconfig.json
packages/
  shared/                @tm/shared — domain types (Project, Task, …),
                          pure logic (parsers, policies, schedulers),
                          the IpcApi contract                           (was src/shared)
  ui/                    @tm/ui — board, TaskCard, TaskDetail, chat —
                          consumed by client + web                      (was src/renderer/src/board,
                                                                          src/renderer/src/chat,
                                                                          src/renderer/src/TaskDetail.tsx)
  protocol/              @tm/protocol — cloud wire contract: socket
                          events, DTOs, command envelope                (new — nothing to move)
turbo.json                                                              (new — mirrors vipper.iam)
pnpm-workspace.yaml       packages: apps/*, packages/*
tsconfig.base.json        unchanged in spirit; every package's tsconfig extends it
docs/
RELEASE.md
package.json              becomes the workspace root manifest — private, turbo scripts only,
                           no longer the version of record
```

`pnpm-lock.yaml`, `.prettierrc.json`, `.gitattributes`, `.gitignore` and
`vitest.config.ts` stay at the root, as they already govern the whole tree today.
`seed-chain.cjs` / `seed-demo.cjs` seed `apps/client`'s local SQLite database, not
anything server-side — the next step decides whether they move under
`apps/client/scripts/` or stay at the root; either is mechanical.

### `@tm/shared` can leave the renderer's world — checked, not assumed

`src/shared/**` has zero imports of `'electron'` and no third-party runtime
dependency beyond internal cross-references (confirmed by reading every
`import` in the directory). It is plain TypeScript today only because
`tsconfig.node.json`/`tsconfig.web.json` both `include` it directly and
`electron.vite.config.ts` path-aliases it as `@shared`
([`electron.vite.config.ts:29,35,44`](../../electron.vite.config.ts)) — nothing
in its own code assumes Electron or the DOM. That is what makes turning it into
a real package NestJS can also depend on a move, not a rewrite: `@tm/shared`
built with `tsup` (mirroring `packages/shared-types` in `vipper.iam`) gives
`apps/server`, `apps/client` and `apps/web` the same `Project`/`Task`/`IpcApi`
types and the same pure parsers/policies from one source, instead of the server
duplicating a second copy of logic the desktop app already tests.

### `@tm/ui` is scoped by what the layout above names, not "everything in renderer/"

Only `board/`, `chat/` and `TaskDetail.tsx` are named for the move. That is a
narrower cut than "all renderer components" on purpose: `App.tsx`, `Settings.tsx`,
`MyTasks.tsx`, `TitleBar.tsx`, the dialogs (`AddTaskDialog.tsx`,
`AssignAgentDialog.tsx`, `ProjectDialog.tsx`, …) and most of the hooks are
desktop-shell specific today — they call native pickers, read `app_state`
through IPC, or otherwise assume the Electron main process is on the other end
of the preload bridge — and `apps/web` does not exist yet to prove which of them
also make sense in a browser. `board/` and `chat/` carry same-directory helpers
today (`boardColumns.ts`, `chainArrows.ts`, `chainDrag.ts`, `currentSprint.ts`,
`useCardAnchors.ts` under `board/`; `turns.ts`, `markdown.ts`, `mentions.ts`
under `chat/`) that are package-internal and move with their components
unchanged. Two files the next step has to place by judgment rather than by this
list: `TaskDetailsCell.tsx`, which `TaskDetail.tsx` renders but which is not
itself named above, and `theme.ts`/`color.ts`, which both `@tm/ui` and the rest
of `apps/client/src/renderer` will need — either duplicated by import, or
promoted into `@tm/shared` if they are as framework-agnostic as `src/shared`
already is.

### `@tm/protocol` is scaffolding, not a move

Nothing in the codebase today talks to a server — there is no socket layer, no
DTOs, no command envelope, because there is no server. `packages/protocol` is an
empty package this step reserves a place for; a later phase (after the server
and web app exist enough to need one) defines and fills it. Naming it now means
`apps/server` and `apps/web` are never tempted to invent their own ad-hoc wire
format while waiting for the "real" one.

### What this step deliberately leaves open, and to whom

- **The exact pnpm workspace mechanics** (`pnpm-workspace.yaml` globs,
  `workspace:*` protocol for internal deps, whether `apps/client`'s
  `onlyBuiltDependencies`/`allowBuilds` entries for `better-sqlite3` / `electron`
  / `esbuild` move to the root or stay package-scoped) — the next step, which
  actually runs `pnpm install` against the new tree.
- **`@tm/server`'s test runner.** `vipper.iam/apps/backend` uses `jest`
  (the NestJS-generated default); every other package in both repos uses
  `vitest`. Carrying that split into `@tm/server` (Nest convention) while
  `apps/client`, `apps/web`, `@tm/shared` and `@tm/ui` stay on `vitest` (today's
  convention here) is the working assumption; the next step confirms it against
  what `@nestjs/cli`'s own scaffold generates.
- **`packageManager` version.** This repo pins `pnpm@11.11.0`
  ([`package.json:57`](../../package.json)); `vipper.iam` pins `pnpm@9.15.9`.
  The restructuring keeps this repo's own pin — a monorepo does not need to
  match a *different* repo's pnpm version, only be internally consistent.
- **SQL Server hosting** (local dev container vs. an Azure instance) and the
  actual `@tm/protocol` contract are out of scope for the target layout; the
  former is closer to the verification step, the latter to a phase after this
  one.

### Done when (this step's own gate)

- Every path and package named above is grounded in a file or line this session
  actually read (`electron-builder.yml`, `package.json`, the `tsconfig*.json`
  files, `electron.vite.config.ts`, the `src/` tree, and `vipper.iam`'s own
  `apps/`, `packages/`, `package.json`, `turbo.json`, `tsconfig.base.json`) —
  not guessed from the parent task's description alone.
- The two identity constraints (`appId`, `apps/client/package.json`'s `name`)
  are stated with the file and line they come from, and the layout has no path
  that would touch either.
- Every directory in the tree above says what today's files (if any) become it,
  so the next step can execute the move without re-deriving this design.

**Notes.**

- This step is **docs only** — no `src/` change, so `pnpm typecheck` and
  `pnpm test` have nothing to say about it, and the worktree is deliberately not
  `pnpm install`ed for it, the same as Phase 24's first step.
- Per [`CONTRIBUTING.md` §4](../../CONTRIBUTING.md), a `docs`-only commit still
  bumps **PATCH** in the same commit; no annotated tag and no release on this
  branch (`RELEASE.md` rule 5) — the tag is cut once this lands on `development`.
- Every step of this plan shares the one branch `feat/cloud-service`, so each
  step's session reads this entry to find what the previous one left it.

### Verification — what this step found

The restructuring commit (`29c5477`) moved `apps/client` and `packages/shared`
into place, but the target layout above also names `apps/server`, `apps/web`,
`packages/ui` and `packages/protocol` — three of them marked `(new)`, meaning
nothing to move, only to scaffold. None of the four exist on this branch: no
`apps/server`, no `apps/web`, no `packages/ui`, no `packages/protocol`, no
`docker-compose.yml`. Scaffolding a NestJS backend and a Vite/React frontend
is not verification, and doing it here would mean starting later phases from
inside this step, so the checks below cover what actually exists —
`apps/client` and `packages/shared` — and the Server / Web / End-to-end
sections of this step's brief are recorded as **not yet runnable**, not as
passed or skipped, so the gap is visible to whichever step scaffolds them.

Root gates, from the repo root:

- `pnpm format` — clean, nothing rewritten.
- `pnpm typecheck` — green (`turbo run typecheck`, both `apps/client` and
  `packages/shared`).
- `pnpm test` — 99 test files passed, 1 pre-existing failure
  (`apps/client/src/main/exec/wslHost.test.ts`, asserts this machine's real
  WSL login-shell PATH contains `/.local/bin`; environmental, unrelated to
  the restructuring — the same single failure `29c5477`'s own testing
  reported), 1 skipped file. 1904 tests passed, 3 skipped.
- `pnpm licenses list | grep -iE 'GPL|AGPL|LGPL|MPL|EPL|CDDL'` — the only
  hits are substring false positives (`expand-template`, `simple-get`, …
  matching `MPL` inside `teMPLate`/`siMPLe`, all themselves MIT/WTFPL). No
  copyleft dependency in the tree. No new dependency was added this step, so
  this is an audit, not a gate that had anything to block.

> **Corrected later — see [the gate report](phase25-gate-report.md).** Two claims in this
> list did not survive being re-run. **`pnpm build` was never run here**, so "root gates"
> means two of RELEASE.md §1's three; it was still exiting 0 while `@tm/server` emitted
> nothing at all. And `pnpm test` passing says less than it appears to: it passed **because**
> `pnpm typecheck` ran first and built the packages it imports — run alone on a clean clone,
> 15 files fail. The `wslHost.test.ts` failure recorded here as "environmental, unrelated" is
> real but was normalised rather than fixed; it is now opt-in behind `ORCH_WSL_TEST=1`.

Client, per this step's own brief:

- `pnpm --filter claude-orchestrator test` **failed on first run**: 40 of 77
  test files errored resolving `@shared/model` and other runtime (not
  type-only) imports from `@shared/*`. The root `vitest.config.ts` that makes
  the aggregated `pnpm test` work mirrors `@shared`/`@renderer` as path
  aliases, but only applies when vitest's cwd is the repo root; `pnpm
  --filter` runs `apps/client`'s own `test` script with cwd set to
  `apps/client`, where that root config is never loaded. This is a real gap
  the restructuring left behind — before `29c5477`, `apps/client` **was** the
  root package, so the two invocations were the same command. Fixed by adding
  `apps/client/vitest.config.ts`, mirroring the same two aliases resolved
  from `apps/client` instead of the repo root (see the file for why); the
  root config's comment is updated to say both exist and when each applies.
  Re-run: 75 of 77 files passed, the same one pre-existing `wslHost.test.ts`
  failure, 1 skipped — and the aggregated root `pnpm test` still reports the
  same 99/101 files passed, confirming the new config didn't change what the
  root run collects.
- `pnpm --filter claude-orchestrator check:abi` — passed (`ABI check OK:
  better_sqlite3.node and Electron both at ABI 130`).
- `pnpm --filter claude-orchestrator package:local` — `electron-vite build`,
  `install-app-deps` and `ensure:abi` all pass; `dist/win-unpacked/VIPPER Task
  Manager.exe` is produced. The final NSIS link fails with `!include: could
  not find … StdUtils.nsh`, and that path is 279 characters — the same
  Windows `MAX_PATH` (260) failure `29c5477`'s own testing hit and attributed
  to this session's worktree path plus pnpm's `.pnpm` store naming, not a
  code problem; confirmed again here on the same worktree.
- `pnpm --filter claude-orchestrator check:feed` — reports "no packaged
  bundle under `apps/client/dist`", because the NSIS step above never
  produced one to check. Downstream of the same environmental failure, not
  evidence of anything wrong with `check:feed` itself.

Server / Web / End-to-end — not yet runnable, per the gap noted above:
`pnpm --filter @tm/server test`, `docker compose up -d`, `pnpm --filter
@tm/server db:migrate`, `curl localhost:3000/api/v1/health`, `pnpm --filter
@tm/web test` and `pnpm test:e2e` all name packages or files that do not
exist on this branch yet.

No path in this step uses `ANTHROPIC_API_KEY` (`docs/06`) — nothing added a
new dependency or API path at all, this step only added one config file. The
packaged app was never launched (`RELEASE.md` rule 6); `check:feed`'s
"no bundle" result and the NSIS failure above were read from command output,
not from running the built exe.

**Notes.**

- Not docs-only: `apps/client/vitest.config.ts` is new, and
  `vitest.config.ts`'s header comment changed to describe it — a `fix`
  (`apps/client`'s own `test` script was broken), so `apps/client/package.json`
  and `packages/shared/package.json` both bump PATCH in this commit,
  matching the sibling-version convention `29c5477` set.
- Per `RELEASE.md` rule 5, this branch is not released from; the tag lands
  once this reaches `development`.

### Azure cost estimate

**Basis.** List prices, pay-as-you-go, no reservations, USD, ex-VAT, primary
region West Europe (Poland Central checked as the alternative named in this
plan's brief). Infrastructure-as-code for either region is out of scope here —
`vipper.iam`'s Terraform lives in the separate `C:\Repositories\infrastructure`
repo, and this service's would too. Every figure below was checked against the
**Azure Retail Prices API** (`prices.azure.com/api/retail/prices`, the same
data the interactive calculator reads, queried directly by service name and
`armRegionName` on 2026-08-09) rather than typed from memory — the pricing
*pages* render their tables client-side and return literal `"$-"` placeholders
to anything that isn't a browser, so the API was the only way to get real
numbers without the interactive calculator. List prices move; re-check before
budgeting against these.

#### The two levers that decide the bill

**1. WebSockets removed scale-to-zero — but only partly.** `vipper.iam`'s
backend can idle at zero replicas because it is a request/response admin
console. A socket a Client holds open is a long-running request, so any
replica with a connected Client is billed at Container Apps' *active* rate,
not the *idle* rate — and with `min-replicas: 0`, a replica with no Client
connected isn't idle, it's gone, so idle billing never applies at all. The
saving grace: Clients only connect while the desktop app is actually running.
With `min-replicas: 0`, the bill tracks roughly the hours someone is working —
call it ~200 h/month, not 730. That's a 3.6× difference in connected-hours,
and it costs nothing to get; it just means accepting a 5–20 s cold start on
the first reconnect of the day, which a background agent with backoff absorbs
invisibly.

**2. Azure SQL serverless is the wrong shape here, and it isn't close.**
Serverless General Purpose bills a flat **$0.5218/vCore-hour**, and only
auto-pauses when the database is genuinely idle. A 30 s heartbeat from a
connected Client means it never pauses, so the 0.5-vCore floor alone runs
0.5 × $0.5218 × 730 h ≈ **$190/month** — more than everything else in
Scenario A combined. A provisioned **S0 (10 DTU, 250 GB)** at
$0.4839/day × 30.44 ≈ **$15/month** carries a mirror of a few machines
comfortably. Batch the telemetry writes (flush every few minutes rather than
per heartbeat) and the database *could* idle overnight under serverless, but
S0's flat rate wins outright at this scale regardless of batching.

#### Scenario A — personal / small fleet (1–5 Clients), single replica

| Resource | Configuration | Est. USD/mo |
|---|---|---|
| Container Apps (Consumption) | 0.5 vCPU / 1 GiB, `min-replicas: 0`, ~200 active h/mo | **$8** |
| Azure SQL Database | S0, 10 DTU, 250 GB | **$15** |
| Static Web Apps | Free tier (100 GB egress, free TLS, 2 custom domains) | **$0** |
| Key Vault | Standard, secrets read at startup ($0.03/10K operations) | **<$1** |
| Log Analytics | ACA console + system logs, likely under the free grant at this volume | **$0–3** |
| Container registry | GHCR, as `vipper.iam` already uses | **$0** |
| Egress | first 100 GB/mo free; deltas and heartbeats are KB-scale | **$0** |
| **Total** | | **≈ $24–28/mo** |

Container Apps' West Europe active rate is $0.000034/vCPU-second and
$0.000004/GiB-second (Standard vCPU/Memory Active Usage meters), against a
free monthly grant of 180,000 vCPU-seconds and 360,000 GiB-seconds per
subscription: 0.5 vCPU × 200 h and 1 GiB × 200 h clears the grant and leaves
≈ $7.56 billable — the $8 above.

Same shape but pinned always-on (`min-replicas: 1`, so Container Apps bills
the *active* rate for the full 730 h/mo rather than only the ~200 h a Client
is actually connected) costs ≈ **$48/mo** for Container Apps alone instead of
$8 → **≈ $64–70/mo** total. (Whether the idle hours would actually qualify
for Container Apps' cheaper idle rate — same $0.000004/vCPU-s as memory,
an 8.5× discount off the $0.000034 active rate — depends on whether a
periodic health probe or backplane check keeps network traffic above the
idle-eligibility threshold; the $48 figure is the conservative case where it
doesn't, matching what the calculator shows for a flat "730 hours" input.)

#### Scenario B — small team (~25 Clients), HA

| Resource | Configuration | Est. USD/mo |
|---|---|---|
| Container Apps | 2 × 1 vCPU / 2 GiB, always-on | **$213** |
| Azure Cache for Redis | Basic C0, 250 MB — the socket.io backplane | **$16** |
| Azure SQL Database | S2, 50 DTU | **$74** |
| Static Web Apps | Standard (SLA, 5 custom domains) | **$9** |
| Key Vault + Log Analytics | | **~$11** |
| **Total** | | **≈ $323/mo** |

The jump is mostly the second replica, and it drags Redis in with it:
socket.io across two replicas needs a backplane for cross-replica broadcasts
plus session affinity, or a web session subscribed to a Client lands on the
wrong replica and sees nothing. **Stay on one replica until HA is actually
needed** — it keeps the architecture simpler and the bill roughly 5× lower.
The cost of that choice is a few seconds of dropped sockets during a deploy,
which the client's reconnect already handles.

#### A cheaper alternative worth knowing about

Container Apps' headline advantage is scale-to-zero, and persistent sockets
blunt it. **App Service Linux B1** (1 core / 1.75 GB, $0.018/hour × 730 h ≈
**$13/mo**, WebSockets and Always On both supported) plus SQL S0 plus SWA
Free lands at **≈ $28–30/mo** flat, with no cold starts and a simpler
deployment. The reason to stay on Container Apps anyway is consistency:
`vipper.iam`'s CI already builds to GHCR and deploys with
`az containerapp update`, including the migrations-job-before-app-update
ordering, and copying a working pipeline is worth more than a few dollars a
month.

#### West Europe vs. Poland Central

The two regions are not priced the same, and the difference doesn't run one
way:

- **Container Apps is materially cheaper in Poland Central** — active vCPU
  usage is $0.000024/vCPU-s there against $0.000034/vCPU-s in West Europe
  (29% less), memory and requests are cheaper too ($0.000003 vs $0.000004
  GiB-s, $0.40 vs $0.56 per million requests). That's the ~$2/mo difference
  in Scenario A and the ~$60/mo difference in Scenario B's always-on Container
  Apps line.
- **Azure SQL Database is priced identically in both** — S0 and S2 DTU rates
  are the same $0.4839/day and $2.42/day in West Europe and Poland Central.
  App Service B1 is a rounding error apart ($0.018/hr vs $0.01802/hr).
- **Static Web Apps isn't offered in Poland Central at all** — the Retail
  Prices API returns zero SKUs for that service in that region. Whatever
  region hosts the compute, the web client has to sit somewhere that has SWA
  (West Europe does).

Because SWA already anchors part of the stack to West Europe, and the
Container Apps saving is ~$2/mo in Scenario A — noise — splitting the
deployment across two regions only starts to pay for itself at Scenario B's
scale, and even there it trades a single-region deploy for cross-region
latency between the web client and the API. Recommendation: everything in
West Europe for v1; revisit Poland Central for just the compute/DB tier if
Scenario B's traffic actually materializes.

#### What is *not* in these numbers

`vipper.iam` itself (already running, no incremental cost); the `claude` CLI
(runs on each Client's own subscription — no server-side inference and, per
`docs/06-licensing.md`, never an `ANTHROPIC_API_KEY`); attachment blob storage
(v1 keeps bytes on the Client's disk deliberately, per Phase 22); and any
non-production environment, which would roughly double whichever scenario is
picked unless staging shares the SQL server.

**Notes.**

- This step is **docs only** — no `src/` change, so `pnpm typecheck` and
  `pnpm test` have nothing to say about it, the same as this phase's first
  step.
- Per `CONTRIBUTING.md` §4, a `docs`-only commit still bumps **PATCH** in the
  same commit; no annotated tag and no release on this branch (`RELEASE.md`
  rule 5) — the tag is cut once this lands on `development`.
- The Container Apps consumption rates, the free monthly grants, and the
  active/idle billing rules above are cited from Microsoft Learn's own
  [Container Apps billing article](https://learn.microsoft.com/en-us/azure/container-apps/billing)
  and the Retail Prices API, not the marketing pricing page (which, fetched
  outside a browser, shows only `"$-"` placeholders).

### Risks and open assumptions

This plan carries four things forward as stated assumptions rather than
verified facts. Writing them down here means a later phase can *check* each
one instead of discovering it mid-build.

- **`@vipper/iam-connector` resolvability.** The package
  (`C:\Repositories\vipper.iam\packages\iam-connector\package.json`) publishes
  to a private registry — `"publishConfig": { "registry":
  "https://npm.vipper.network/" }` — and this repo has no `.npmrc` today, so
  nothing here is currently configured to reach it. The plan assumes it will
  resolve once that registry is configured; it is not yet proven. The phase
  **"Guard the cloud API with vipper.iam"** verifies resolvability first, and
  if the package can't be installed, falls back to a small local `IamClient`
  hitting the same two endpoints the connector documents in its own README:
  `POST ${apiBase}/authorize` (a bearer-token allow/deny decision, keyed by
  `resourceType`/`identifier`/`action`) and the RFC 7662 introspection at
  `${apiBase}/oauth/introspect`. That fallback is small because the connector
  itself is, by its own description, "No NestJS, no React, no server
  dependencies — just native `fetch`" — there is no framework glue to
  reimplement, only two HTTP calls. Because the fallback speaks the identical
  wire contract, nothing downstream of `apps/server`'s auth guard needs to
  know which of the two paths is live; **this does not block anything else in
  the plan.**
- **The two client refactors.** `EngineApi` and `ApiClient` — the desktop
  app's two existing HTTP/IPC call surfaces that grow a cloud-aware path —
  touch **2534 lines** and **179 call sites** respectively. Both refactors are
  mechanical (threading a new transport through call sites that already
  compile against a stable interface) and **behaviour-preserving** — no call
  site's observable result is meant to change. Each is scoped to its own
  phase specifically so that if one goes wrong, the failure is isolated to
  that phase's commits rather than tangled into a broader change, and so the
  test suite that gates each phase is still testing one coherent thing
  instead of two refactors' worth of incidental churn at once.
- **GitHub Projects v2 is GraphQL-only.** GitHub sunset the classic REST
  Projects endpoints; any "which column is this issue in" read has to go
  through the GraphQL API specifically; there is no REST fallback for that
  one piece the way there is for issues, labels, and comments. The issue sync
  is designed around that: it works over plain REST without a project
  attached at all, and only *enriches* the column when a project is attached
  and the token has `read:project`. A project that is missing, unattached, or
  reachable but unpermitted is a **degradation** — issues keep syncing,
  columns are just absent — never a hard failure of the sync.
- **Scope.** This single ticket bundles three products: GitHub integration,
  this cloud service, and a shared UI extraction (`@tm/ui`, named in the
  target layout above). That is wide scope for one ticket, so the phases are
  deliberately ordered — the same discipline this phase's own four steps
  already followed, each landing as its own gated commit — so that **stopping
  after any phase still leaves a working, releasable desktop app.** No phase
  in this plan is allowed to leave `apps/client` mid-refactor or
  non-buildable at its own "Done when" gate.

**Notes.**

- This step is **docs only** — no `src/` change, so `pnpm typecheck` and
  `pnpm test` have nothing to say about it, the same as this phase's earlier
  steps.
- Per `CONTRIBUTING.md` §4, a `docs`-only commit still bumps **PATCH** in the
  same commit; no annotated tag and no release on this branch (`RELEASE.md`
  rule 5) — the tag is cut once this lands on `development`.
- This closes out Phase 25's own plan-writing steps (target layout →
  restructuring → verification → cost estimate → risks); scaffolding
  `apps/server`, `apps/web`, `packages/ui` and `packages/protocol` themselves
  is later work this plan hands off to, not part of this entry.

### No realtime service — adaptive polling

The [Azure cost estimate](#azure-cost-estimate) above still prices row 1 of
the [realtime cost comparison](azure-realtime-cost-comparison.md) — socket.io
over Container Apps. This section changes that before any of `apps/server`,
`packages/protocol`, or `apps/web` gets scaffolded: v1 ships **no dedicated
realtime channel at all** — row 6 of that comparison, plain polling, with an
adaptive cadence layered on top of it (its own new row 7, "Adaptive
polling"). Row 4, Web PubSub, was the comparison's earlier recommendation;
it's now recorded there as considered and not taken. The reasoning:

- **No dedicated realtime channel.** No socket.io, no Web PubSub, no Azure
  SignalR, no Redis backplane. `apps/server` exposes plain REST poll
  endpoints; the only lever left for "how fresh is this data" is how often a
  Client asks for it.
- **Cadence is server-decided, not client-decided.** A Client reports its own
  focus state on every poll (a heartbeat, not a separate round trip); the
  server reads that back through presence and hands back the interval the
  Client should use for its *next* poll. Policy lives in one place — the
  server — so it can change without shipping a new Client build. Step 5 of
  this plan ("Serve presence-driven cadence from the server") is where this
  lands; steps 7 and 11 are the desktop and web sides that report focus and
  obey the interval they're given.
- **Presence lives in server memory, not SQL.** A map from `clientId` to
  `{ focused, lastSeen }`, read and written on every poll, never touches the
  database — no query, no write amplification, no migration, and it's cheap
  enough to do on every single request.

#### The cadence model

Two tiers in v1:

| Tier | Interval | When |
|---|---|---|
| **Focused** | ~2.5 s | The Client reports itself as the foreground window (desktop) or visible tab (web) |
| **Idle** | ~25 s | The Client is open but not foreground — backgrounded desktop app, blurred/hidden web tab |

A Client that stops polling altogether (closed, machine asleep) isn't a third
tier — it just stops sending heartbeats, and its presence entry ages out (see
the TTL below). Two tiers is enough to represent what both Clients can
actually observe about their own focus state (the desktop app's window focus
event, the web client's tab-visibility signal) without a third state the two
runtimes would have to keep in sync.

#### The presence-in-memory / one-replica constraint

Keeping presence as an in-process map instead of a shared store (Redis, SQL)
is the same trade already made for [Scenario B](#scenario-b--small-team-25-clients-ha)
in the cost estimate: **stay on one replica until HA is actually needed.** A
second `apps/server` replica would hold its own, disjoint presence map — a
Client polling replica A would get cadence advice that ignores what replica B
knows about the same resource. Nothing in this plan needs presence to survive
a replica restart or be visible cross-replica, so it isn't built that way. If
Scenario B's HA shape is ever adopted, presence has to move to a shared store
first — new work this plan doesn't schedule.

#### Two latencies this design cannot avoid

Polling without push means both directions of "the world changed" have a
floor, and no amount of implementation care removes either:

- **Speeding up.** If a Client is on the idle tier when something it cares
  about changes, it doesn't find out until its next poll fires — up to one
  idle interval, **~25 s**, after the change happened. There is no push to
  shorten this.
- **Slowing down.** If a Client stops being focused (backgrounded, tab
  closed), the server doesn't know until that Client's presence entry
  expires — the **~90 s** TTL — unless the departing Client says so itself.
  A web tab's `pagehide`/`visibilitychange` handler firing a
  `navigator.sendBeacon` release notice on the way out makes this direction
  immediate instead of TTL-bound; that release is a later step's work
  (11, "Send focus heartbeats from the web client"), not this one's.

A third, "warm" cadence tier between focused and idle (say, ~10 s) could
roughly halve the first number without touching the second — the obvious
next lever if ~25 s of staleness turns out to matter in practice. v1 ships
with two tiers; that's a scope cut made on purpose, not an oversight.

### Verification — the adaptive cadence end to end

Same shape as this phase's earlier verification step: what was actually run,
what it actually found, gaps recorded rather than hidden.

**Root gates**, from the repo root:

- `pnpm format` — rewrote 30 files that predated this step and had never been
  run through Prettier since Phase 25 started scaffolding `apps/server`,
  `apps/web` and `packages/protocol` (the same drift Phase 25's "workspace
  refresh"-era note already flagged for `packages/ui`, now spread wider).
  Included in this commit — `pnpm format` is one of this step's own gates, and
  every change it made is whitespace/import-wrapping only (spot-checked
  `apps/web/src/board/BoardScreen.tsx`); no behaviour changed, confirmed by
  the unchanged pass counts below.
- `pnpm typecheck` — green (`turbo run typecheck`, all 9 workspace packages:
  `@tm/protocol`, `@tm/shared`, `@tm/ui`, `@tm/server`, `@tm/web`,
  `claude-orchestrator`).
- `pnpm test` — 122 test files passed, 1 pre-existing failure
  (`apps/client/src/main/exec/wslHost.test.ts`, the same real-WSL-PATH
  assertion the last two verification steps recorded — environmental,
  unrelated to this step), 1 skipped file; 2064 tests passed, 3 skipped. The
  presence/cadence suites (`presence.registry.test.ts`,
  `presence.service.test.ts`, `presence.controller.test.ts`,
  `cadence.test.ts`) are in this count and print real `[CadenceTransition]`
  log lines during the run — the same logger line this step's own live
  measurements below read.

> **Corrected later — see [the gate report](phase25-gate-report.md).** `pnpm build` is
> missing from this list too, and running it is what found that `nest build` exits 0 without
> writing `apps/server/dist` at all — so "all 9 packages green" under `pnpm typecheck` was
> true and still left the server unbuildable and unstartable. It also excluded every
> `apps/server/**/*.test.ts` from that typecheck. `pnpm test`'s greenness here likewise
> depended on `pnpm typecheck` having run first. The `wslHost.test.ts` failure is recorded
> here for the third time as "pre-existing … environmental"; it **passes** on a later run of
> the same machine with nothing changed but the environment, which is why it is now gated
> rather than dismissed again.

**Client gate**, separately (the root config doesn't load under `--filter` —
see the prior verification step's own note on why):

- `pnpm --filter claude-orchestrator test` — 66 test files passed, the same
  one pre-existing `wslHost.test.ts` failure, 1 skipped; 1229 tests passed, 3
  skipped.
- `pnpm --filter claude-orchestrator check:abi` — passed (`ABI check OK:
  better_sqlite3.node and Electron both at ABI 130`).
- `pnpm --filter claude-orchestrator package:local` — `electron-vite build`,
  `install-app-deps` and `ensure:abi` pass; `dist/win-unpacked/VIPPER Task
  Manager.exe` is produced. The NSIS link step fails with `!include: could
  not find … StdUtils.nsh`, whose path is exactly **279 characters** — the
  same `MAX_PATH` (260) failure the last two verification steps hit on this
  worktree's path plus pnpm's `.pnpm` store naming; environmental, confirmed
  again here, not a code problem.

**Docker Desktop would not come healthy in this session** — the one real gap
this step has to report. `docker compose up` (wrapping `pnpm db:up`) failed
with `request returned 500 Internal Server Error` from the
`dockerDesktopLinuxEngine` named pipe; `docker info`/`docker version` hung for
20–30 s and then returned the same 500; `docker desktop status` reported
`stopped` throughout. Two remediation attempts — `docker desktop restart`,
and a clean `docker desktop stop` followed by `start` — each given several
minutes, left `docker desktop status` still `stopped` (a fresh `SessionID`
each time, so the restarts did cycle the backend, they just didn't come up
healthy). `wsl -l -v` showed only the machine's own `Ubuntu` distro, no
`docker-desktop`/`docker-desktop-data` distro registered, consistent with an
unhealthy WSL2 backend. This is this session's local Docker Desktop
installation, not anything in this repo's `docker-compose.yml` or
`apps/server` — but it meant `@tm/server`'s real process (its `AppModule`
opens a TypeORM/mssql connection at boot, so it cannot start at all without a
reachable database) could not be run for real here.

**What was run for real instead.** The adaptive-cadence policy has exactly one
piece of state that needs a live process to observe — the server's in-memory
presence map and its tier-transition timing — and, by this phase's own design
("Presence lives in server memory, not SQL"), none of it touches the
database. So rather than skip the live run, this step wired up the real,
unmodified `src/presence/presence.registry.ts` and
`src/presence/presence.service.ts` behind a small temporary Express harness
(`apps/server/verify-harness-server.ts`, deleted before this commit) exposing
the same three routes (`POST /v1/sync`, `GET /v1/board`, `POST
/v1/presence`) with the same `@tm/protocol/wire` request/response shapes —
skipping only the TypeORM-backed mirror (task/project sync) and
`IamAuthGuard` (which needs a live `DataSource` to construct at all, even
under `CLOUD_DEV_NO_AUTH=1`), neither of which the cadence policy touches.
Simulated sessions (`apps/server/verify-harness-client.ts`, also deleted)
drove it using the REAL `nextPollDelayMs`/`CADENCE_MS` from
`@tm/protocol/cadence` — the identical formula `CloudPoller`
(`apps/client`) and `BoardPoller` (`apps/web`) both import — over real HTTP,
real `setTimeout`s and real `Date.now()`, on a scripted focus timeline
standing in for actual window-focus/tab-visibility events. `apps/web`
(`vite`, port 5175) and the packaged desktop client
(`dist/win-unpacked/VIPPER Task Manager.exe`, from `package:local` above,
launched with a scratch `--user-data-dir` so the real `orchestrator.db` was
never touched) were both booted separately as build-level smoke checks —
`apps/web` answered `HTTP 200` on `/` in under a second, the packaged client
opened its full process tree and stayed responsive for the smoke window —
but neither was wired to a live cloud session (no server to hand them a real
board, and the desktop build has no way to reach `vipper.iam` for a real
sign-in from this environment either), so the scenario table below is the
harness's measurements, not a screen either app actually rendered.

**What the table means for the two GUI apps specifically.** Scenarios framed
as "focus the desktop window" / "open the web tab" were driven by flipping
the harness client's scripted `focused` flag on the same schedule a real
window-focus or `visibilitychange` event would — `FocusTracker.ts`
(desktop) and `browserFocusSignal.ts` (web) each reduce their real signal to
exactly that one boolean before it ever reaches `CloudPoller`/`BoardPoller`,
so this substitution changes *what generates* the input, not what the poller
does with it. The one scenario that needed the actual `FocusTracker.ts`
class, not a stand-in boolean, was locking the workstation — see its own row
below.

| Scenario | Expected | Measured |
|---|---|---|
| Focus the desktop window | Gap drops to ~2.5 s on the next tick | **Confirmed, immediate.** `onFocusChange`'s "bring the next poll forward" rule fired: the scheduled 24 s-out idle poll was cancelled and replaced with a 0 ms one the instant focus flipped; the server logged `from=idle to=active reason=client-focused` at that same beat, and every poll afterward held a steady 2.50–2.52 s spacing (`CADENCE_MS.active`, no jitter — active-tier polls are deliberately unjittered). |
| Blur it, no web session | Gap returns to ~25 s ± 10 % **after the TTL** | **Confirmed for the ~25 s gap — but not TTL-gated.** `onFocusChange` fires on blur too, so the client's own very next beat reported `focused=false`; the server flipped `from=active to=idle reason=no-focus` ~1.6 s after the blur signal, well inside the 90 s TTL, and the client's own next-poll delay became ~25 s (jittered) from there. **This differs from the table's phrasing**: the TTL only matters for a session that stops reporting at all (see the next row) — one that keeps polling and honestly reports `focused=false` doesn't need to age out, because it says so on its own next beat. |
| Open + focus the web tab, desktop blurred | Desktop's gap drops to ~2.5 s within ≤25 s | **Confirmed.** Desktop polled `focused=false` throughout (idle, ~22.6 s next-poll delay already in flight when the web session appeared at t≈2.4 s server-side). Its very next scheduled poll, at **t≈22.7 s**, picked up the server's `active` directive (`reason=web-focused`) from `nextPollDelayMs`'s `min(serverIntervalMs, localTierMs)` rule — the desktop's own local focus can only ever pull the interval down, never hold it up — and every poll after that held steady 2.5 s, still reporting its own `focused=false`. |
| Close the web tab | Back to ~25 s immediately (beacon), and within ~90 s with the beacon suppressed | **Both confirmed, both measured precisely.** With the beacon: the `POST /v1/presence` release call's own response already carried `tier=idle` — immediate, no wait. Without it (simulating a crash/force-close — no beacon, polling just stops): a probe every 12–15 s showed `tier=active` still holding through **+88 s**, then `tier=idle` at **+92 s** — the flip landed inside the `[+88 s, +92 s]` window bracketing `PRESENCE_TTL_MS`'s exact 90 000 ms. |
| Both focused | One `active` directive, not two competing clocks | **Confirmed.** Desktop and web polled concurrently for 15 s, both focused; the server logged exactly **one** transition for the whole run (`from=none to=active reason=web-focused`) and never logged a second one — the `reason` didn't flap between `client-focused`/`web-focused` as the two requests interleaved, because `resolveCadence` picks the first focused, non-expired session deterministically rather than re-deciding a "winner" every request. Both sessions converged on identical `tier=active`/`intervalMs=2500` directives throughout. |
| Change a status in the web, desktop focused | Visible on the desktop board in ≤3 s | **Inferred, not directly measured.** The harness carries no real task/project data (it deliberately skips the TypeORM-backed mirror — see above), so there is no delta to actually round-trip. What ≤3 s visibility rests on is the desktop's poll gap while focused, which the "Focus the desktop window" and "Both focused" rows above measured at a steady 2.50–2.52 s — under the 3 s budget with room to spare, but this row itself is arithmetic on those two measurements, not its own live observation. |
| Kill the server | Backoff to the 5 min cap, no spin; recovers on restart | **Confirmed for the progression and the recovery; the literal cap wasn't waited out.** After the harness server was killed mid-poll, four consecutive failures produced delays of **5 000 → 10 000 → 20 000 → 40 000 ms** — exact doublings of the 2 500 ms base (`base × 2^failures`), never spinning faster. That trajectory reaches `BACKOFF_CAP_MS` (300 000 ms) at the 7th failure by the same formula; waiting the ~9 more minutes to observe the literal cap firsthand wasn't worth the wall-clock given the formula is both exercised live here and separately asserted in `packages/protocol/src/cadence.test.ts`. Restarting the server mid-backoff: the client's next scheduled attempt (the 40 s one, landing ~40 s after restart) **succeeded immediately**, `consecutiveFailures` reset to 0, and polling resumed its steady 2.5 s cadence with no extra retry or delay. |
| Lock the workstation with the window focused | Treated as unfocused | **Confirmed — via the real class, not a physical lock.** Locking this session's actual workstation was judged too risky to attempt deliberately (this is a headless, unattended run; an unrecoverable lock screen would have ended the session with no way to unlock it). Instead, `apps/client/src/main/focusTracker.ts` — the real, unmodified source — was exercised directly against a fake `BrowserWindow`/`powerMonitor` (a temporary vitest file, deleted before this commit) that keeps the window's own `isFocused()` returning `true` throughout. Emitting `powerMonitor`'s `lock-screen` flipped `FocusTracker.isFocused()` to `false` even though the window itself never blurred, and `unlock-screen` correctly re-read the window's real focus state on resume (`effective()`'s `focused && !suspended` — the two inputs are independent, exactly as the class's own header describes). |

**Request count vs. the free grant.** At the active tier, one session polls
every 2.5 s = 1 440 requests/hour. A single focused desktop session running
continuously for a full 730-hour month would produce ≈1,051,200 requests —
about 53% of Azure Container Apps' 2,000,000-request/month free grant, alone.
A more realistic profile — 8 focused hours/day, 22 working days/month (176 h)
— produces ≈253,440 requests/month, about 13% of the grant. Both desktop and
web focused on the same account at once (the "Both focused" row) doubles the
per-hour figure to 2 880 — still under 0.3% of the grant for a single focused
hour, and nowhere near it even summed across a full working month for a
handful of concurrent accounts. The idle tier (25 s) is 20× cheaper per
session again. None of this counts the actual mirror payload size (this
harness never carries real task/project deltas) — the grant is metered on
request count, not bytes, so payload size doesn't change this comparison.

**Notes.**

- Not docs-only: `pnpm format` (one of this step's own gates) rewrote 30
  pre-existing files across `apps/client`, `apps/server`, `apps/web`,
  `packages/protocol` and `packages/ui` — whitespace/import-wrapping only, no
  behaviour change (confirmed by the unchanged test counts above) — so
  `apps/client`, `apps/server`, `apps/web`, `packages/protocol` and
  `packages/ui`'s `package.json`s each bump PATCH in this commit, the same
  convention the prior verification step set when its own gate produced a
  real file change.
- The three temporary harness/test files this step wrote
  (`apps/server/verify-harness-server.ts`,
  `apps/server/verify-harness-client.ts`,
  `apps/client/src/main/focusTracker.verify.test.ts`) are deleted, not
  committed — they existed only to drive this session's live measurements
  against real, unmodified production code while Docker Desktop was down;
  keeping them around as permanent fixtures would misrepresent them as
  supported tooling.
- Per `RELEASE.md` rule 5, this branch is not released from; the tag lands
  once this reaches `development`.
- This closes out the plan of build steps this session was handed (1–12);
  `apps/server`, `apps/web`, `packages/ui` and `packages/protocol` are now
  scaffolded, wired to a presence-driven adaptive cadence, and this step
  measured that cadence against real production code end to end, with the
  one gap above (Docker Desktop's local health in this session) recorded
  rather than glossed over.

### Verification — running the gates instead of reading them

Same shape as this phase's earlier verification steps: what was actually run, what it
actually found, gaps recorded rather than hidden. The difference is what it was pointed at.
The two sections above verified *the step's own change*. This one verifies **the gates
themselves** — the ticket "Cloud service — tests and analyze issues", whose whole subject is
whether a green `pnpm typecheck` / `pnpm test` on this branch means what the previous two
sections took it to mean.

Full command-by-command detail, with exit codes and verbatim output, is in
[`phase25-gate-report.md`](phase25-gate-report.md). The summary:

**Step 1 read the branch and predicted seven failures.** Four were confirmed, two refuted, one
confirmed weaker than stated. Those verdicts held up when run — the value of having done it is
that no time went into the two refuted ones.

**Running them found two things reading them could not.**

- **`nest build` exits 0 and writes nothing.** `apps/server/tsconfig.json` extends
  `tsconfig.base.json`, which sets `noEmit: true` because the whole workspace typechecks with
  `tsc --noEmit`. The server overrides eleven compiler options — including `outDir` and
  `emitDecoratorMetadata` — but not that one. So `apps/server/dist` has never existed, and
  the package's own `"main": "dist/main.js"` and `"start": "node dist/main.js"` have never
  been able to work. **This is only visible if you run `pnpm build`, which no verification
  section in this phase had ever done.** Step 1's static read of the same files got as far as
  correctly refuting "the build fails for want of a tsconfig", without reaching the fact that
  resolving `tsconfig.json` is precisely what makes the build a no-op.
- **A package with no `test` script makes `pnpm --filter <pkg> test` exit 0 in silence.** No
  output, no warning. `packages/shared`, `packages/protocol` and `packages/ui` had no such
  script, so a sweep across the workspace would have reported six green packages while running
  tests in three.

**And it found the order-coupling is five times wider than predicted.** Root `pnpm test` was a
bare `vitest run` with no build step; it passed only because RELEASE.md §1 happens to list
`pnpm typecheck` first and turbo's `typecheck` carries `dependsOn: ["^build"]`. Step 1
predicted three files would fail without that. A clean clone of the merged commit, installed
and tested with no `typecheck` first, failed **15 files across six specifiers** — mostly
`@tm/shared/*` reached through `packages/ui`'s own sources, so most of the broken suites never
mention `@tm/*` in their own text at all.

**What was fixed.** `apps/server` got a `tsconfig.build.json` (which is also the filename
`@nestjs/cli` probes for first, so `nest-cli.json` needed no change), freeing `tsconfig.json`
to stop excluding the ten server test files from typechecking — they turn out to be
type-clean, which is a result worth recording rather than a fix. The three `migration:*`
scripts now name `dataSource.ts`, the file that exists, and get as far as failing to reach a
database. The root `test` script builds the library packages itself and `turbo.json` gained a
`test` task; all six packages now have a `test` script and an explicit `vitest.config.ts`, and
their six file counts sum to 124 — exactly what the aggregated root run reports, so nothing
falls between the two paths. `apps/web` got the `vitest.config.ts` its two siblings already
had.

**`wslHost.test.ts` is now opt-in behind `ORCH_WSL_TEST=1`**, matching
`wslSession.e2e.test.ts`'s `ORCH_E2E`. Not because it fails — it passed in this session, which
is exactly the problem. The two sections above recorded it failing across three earlier
sessions and each time called it "pre-existing … environmental"; nothing changed between then
and now but the machine's WSL state. Its assertion is right (the prelude appends
`~/.local/bin` only `[ -d ]`, so a distro without that directory fails it for no defect), so
the assertion is untouched and still runs on demand. Only its *gating* changed. The file's two
pure blocks stay in the gate, and it drops from 4841 ms to 5 ms.

**The gates on the fixed tree**, all from a clean clone as well as the developed worktree:

- `pnpm typecheck` — 0, 9/9, now covering the server's ten test files.
- `pnpm test` — 0, 123 files passed, 1 skipped. 2057 passed, 11 skipped of 2068: the nine that
  moved from passed to skipped are `wslHost.test.ts`'s real-distro cases, behind the new flag.
  No test was deleted or weakened.
- `pnpm build` — 0, 6/6, and `apps/server/dist/main.js` exists for the first time. Turbo no
  longer warns that `@tm/server` produced no output.
- `pnpm install && pnpm test` on a clean clone, **with no `typecheck` first** — 0, 124 files.
  This was the run that failed 15 files before.
- All six packages under `pnpm --filter <pkg> test` — 0.
- `pnpm --filter claude-orchestrator check:abi` — 0, ABI 130 both sides.

**Two things this ticket could not close on this machine**, recorded rather than acted on:

- **`@tm/server` has still never been booted against a real SQL Server.** Its `AppModule`
  opens a TypeORM/mssql connection at boot, so nothing starts without a reachable database,
  and the section above records Docker Desktop failing to come healthy here across two restart
  attempts. `migration:run` now fails with `ESOCKET … localhost:1433` — for want of a
  database rather than for want of a file, which is as far as this machine goes. Making
  `dist/main.js` exist is a precondition for that boot, not a substitute for it.
- **`package:local` still dies at the NSIS `MAX_PATH` link step** — `!include: could not find
  … StdUtils.nsh` at a 279-character path against Windows' 260 limit, a function of this
  worktree's path plus pnpm's `.pnpm` store naming, unchanged by anything here.

#### Critical files — the gate wiring, and the invariants it now rests on

Full per-file detail is in [the gate report's §9](phase25-gate-report.md#9-critical-files).
This ticket changed **no product code** — every file it touched is gate wiring, build wiring
or the record — so a green `pnpm test` cannot confirm most of it. The five constraints that
are not visible in the diff, and that the next person editing these files will be standing on:

- **`turbo.json` — `dependsOn: ["^build"]` now sits on `typecheck` *and* `test`.** Finding 3
  was not a missing dependency; it was the test gate borrowing `typecheck`'s by running after
  it. Declaring it twice is what makes the two independent. (`turbo run test` is still
  cacheable, so it can replay a stored green — use `--force` when treating it as verification.
  The root gate does not route through it, so no release check can be fooled.)
- **Root `vitest.config.ts` deliberately does not alias `@tm/*`, and this is the file most
  likely to be "fixed" wrongly.** The next `Failed to load url @tm/shared/…` will look exactly
  like a missing alias; adding one makes it go away *and* makes the clean-clone check unable to
  fail again. The build prefix in the root `test` script is the fix. The header comment now
  says so at the point of use.
- **`apps/server`: the test exclusion belongs to the emitting config only, and `noEmit: false`
  belongs nowhere else.** Move the exclusion into `tsconfig.json` and finding 4 returns
  silently; move `noEmit: false` up and the typecheck config starts writing files.
  `nest-cli.json` stays free of `tsConfigPath` — the filename probe *is* the wiring.
- **`apps/web/vitest.config.ts` `mergeConfig`s `vite.config.ts` rather than being empty like
  its siblings.** Making an implicit thing explicit means keeping what it implied — an empty
  config would have been "consistent" and would have dropped the React plugin the discovery
  fallback was supplying.
- **A test goes behind a flag when its result depends on state this repo does not control** —
  a real distro's `~/.local/bin`, a logged-in CLI, a reachable database. "Integration test" is
  not the criterion: `jiraSync.integration.test.ts` is fully mocked, gated by nothing, and
  correctly in the gate. This corrects the ticket's own brief, which named it as a precedent
  for gating; `ORCH_E2E` is the only precedent, and `ORCH_WSL_TEST` was named to match it.

**Notes.**

- Not docs-only, and not one commit: the merge, the gate report, and the three fixes each
  landed separately, each bumping the packages it touched per `CONTRIBUTING.md` §4.
- The merge from `feat/cloud-service-implementation` was **not** the fast-forward the ticket
  predicted — step 1's own commit had already moved `HEAD` off `origin/development`. It was
  still conflict-free, on provably disjoint file sets.
- Per `RELEASE.md` rule 5 there is no release step here; this is a feature branch, and the tag
  is cut once it reaches `development`.

### The web client that looks exactly like the desktop

**Goal.** `apps/web` drew a *lookalike* of the app: the same cards in a container of its own,
a superset of the desktop's card set, and a right-hand pane that was the card's title in
prose. Six steps on `feat/the-task-manager-web-should-look-like` make it the same UI — the
same shell, the same board, the same detail pane — degraded only by what a browser genuinely
cannot reach. The rule the whole ticket runs on: **shared where the component has no host in
it, forked where sharing would mean a dozen optional props the web passes none of.**

The per-step reasoning is in the six commit bodies (`42ceb11`, `b1d5cef`, `317e494`,
`59bc9c9`, `9b32a67`, `01f833b`) and is not repeated here. What this section records is the
shape of the whole, the ordering constraint between the two halves, and the conventions that
applied to every step — the things no single commit is the right place for.

#### The six steps, and what each one is for

1. **Cap the sync batch by bytes.** `OUTBOX_LIMIT` counted *entities*, and an entity has no
   fixed size. `SYNC_BYTES_LIMIT` (1 MB,
   [`cloudDelta.ts:107`](../../apps/client/src/main/cloudDelta.ts)) is the cap that means
   something; the server takes 8 MB
   ([`bodyLimit.ts`](../../apps/server/src/config/bodyLimit.ts), `CLOUD_BODY_LIMIT`).
2. **Back-fill the cloud outbox once.** `cloud_outbox` is trigger-filled, and a trigger only
   hears about a *write* — so everything already on the board when the mirror was switched on
   had never been queued and never would be. One guarded `INSERT … SELECT`
   ([`cloudOutboxBackfill.ts`](../../apps/client/src/main/cloudOutboxBackfill.ts)) queues it.
3. **Show only the desktop's card set.** The mirror carries every project's rows and the
   archived ones too; `boardSelectors.ts` is the desktop's SQL said once in JS, read at render
   rather than filtered at ingest — ingest cannot drop rows the Removed-cards dialog and
   `reconcilePendingStatusChanges` still need.
4. **Extract the app shell into `@tm/ui`.** `NavRail`, `StatusBar`, `AppShell` and
   `appDarkTheme` move; both hosts render through them. Extracted, not copied — the only way
   "the same shell" survives the next tweak.
5. **Rebuild the board as My Tasks.** `boardLayout.ts`, `doneSwitchLabel.ts`,
   `BoardDisplayMenu` and `ArchivedCardsDialog` move to `@tm/ui/board`; the *toolbar* stays
   forked, and `webPrefs.ts` backs the Display toggles with `localStorage` instead of
   `settings:save`.
6. **Render the shared detail pane, read-only.** The desktop's `TaskDetail`, degraded by what
   is *not* passed to it, over a transport whose channels are now tiered: **stubbed** when a
   read's result is only displayed, **refused** when it is fed back into board state.

#### Notes for every step

Four things applied to all six sessions. They are recorded because each one is a trap that
costs a session when it is missed, not because they were newly decided here.

- **A fresh worktree has no `node_modules`, and `@tm/ui` must be *built*, not just present.**
  Every session starts with `pnpm install`. `@tm/ui` publishes `./*` → `./dist/*`
  ([`packages/ui/package.json`](../../packages/ui/package.json)), so a *new* shared file has
  no `.d.ts` for `apps/web` to typecheck against until `tsup` has run. `turbo.json` puts
  `dependsOn: ["^build"]` on `typecheck` **and** `test`, so `pnpm typecheck` handles this on
  its own — a bare `tsc` inside `apps/web`, or an editor's language server, does not, and the
  error it gives ("cannot find module `@tm/ui/shell/AppShell`") reads like a missing path
  alias. It is a missing build. The same shape as the `vitest.config.ts` trap above.
- **`RELEASE.md` §1's gates, in order, every time:** `pnpm typecheck` → `pnpm test` →
  `pnpm build`, plus `pnpm format:check` (a `--check` failure is a red gate like any other,
  and the only one of the four that a commit can trip without touching any logic). Pass
  `--force` when the run is meant as *verification* rather than as a build — turbo will
  otherwise replay a cached exit code in milliseconds and a cached gate is not a gate. New
  pure-logic modules were checked **red-first** by mutating the code under them; step 5 found
  its first `webPrefs` fixtures coerced to the same answer as the defaults, so the suite
  passed against a mutant and proved nothing.
- **`CONTRIBUTING.md` §4's version rule:** a step touching `apps/client` carries the
  `apps/client/package.json` bump inside its own commit. This ticket did not manage it — all
  six steps changed the product and none of them bumped, so the branch reached its last step
  still naming `0.81.0`, the version `development` already ships. It is fixed the way
  `RELEASE.md` §2 allows and no other way: the bump rides on the *last* commit of the branch
  rather than being back-dated into six commits that are already written and must not be
  rebased. The cost of missing it is not theoretical — it is the fourth branch in a row to
  reach a release with no version of its own.
- **Never launch the app.** Every check in this ticket is headless; the ordering constraint
  below and the read-only pane are both reasoned about from the code and the tests, not from
  a window. What is owed as a consequence is listed under **Notes**.

#### The one ordering constraint between the halves

Steps 1 and 2 are a client/server pair, and they deploy in an order:

> **The server's 8 MB body limit must be live before a client carrying the back-fill reaches
> a user.**

The back-fill's whole point is a first sync far larger than any steady-state one. Against a
server still on express's 100 kB default that batch comes back `413`, which the poller counts
as a plain network error and retries with the identical body — forever. The mirror never
catches up and nothing in the UI says why.

The wrong order is *survivable* rather than fatal only because of what step 1 put on the
client: the batch is capped at 1 MB of resolved entities before it is sent, and a `413` halves
the next request's row count (any 2xx resets it). So an old server degrades the back-fill into
a slow crawl instead of a wedge. That is a safety net, not a plan — deploy the server first.

**Notes.**

- Six `feat` commits, so the branch's bump is **MINOR**: `0.81.0` → `0.82.0`, carried by this
  final commit per the third bullet above. Per `RELEASE.md` rule 5 the tag is cut once the
  branch reaches `development`; there is no release step on the branch itself.
- Gates at the branch head, all four green and all uncached:
  `pnpm typecheck --force` (9/9), `pnpm test` (135 files, 2237 passed, 11 skipped),
  `pnpm build --force` (6/6), `pnpm format:check`.
- **A human still has to look at it.** Nothing in this ticket can be verified by a test: it is
  a claim about whether two UIs look the same, and this repo has no DOM harness (no jsdom, no
  `@testing-library`) — adding one is a workspace-wide call that was deliberately left outside
  the ticket. Owed: the web client opened against a real deployment beside the desktop app,
  and the read-only pane's refusals actually pressed.
- Also owed: the back-fill run against a real board that predates the outbox triggers. It is
  guarded twice — `NOT EXISTS` against the outbox *and* an `app_state` key, because either
  guard alone fails (the first re-mirrors on every launch once `pruneCloudOutbox` has swept,
  the second loses to a crash landing between the inserts and the guard) — and neither guard
  has been exercised by anything but a recorder.

#### The parity rule, and where the line sits now

A second pass — `feat/match-web-layout-to-desktop-client`, three commits (`6a6ffa6`,
`3009211`, `4ffb20f`) plus this one — closed the gaps the first pass left. The useful part
is not the three fixes, which are in their own commit bodies; it is that the rule behind
them is now written down in the user's own terms:

> **The web looks the same as the desktop — styling, colours, theme, layout, components. It
> differs only in _data and features_.**

That one sentence decides every future case, and it cuts both ways. A control the web cannot
act on is **dropped**: the Current-sprint switch re-runs a JQL only the desktop can run, the
Chain toggle has no mirrored links to draw, the commit graph is a `git log` on a machine this
app cannot reach, and Sync belongs to the desktop's poller
([`BoardToolbar.tsx`](../../apps/web/src/board/BoardToolbar.tsx) records which and why). But
**nothing the web _does_ draw gets a look of its own.** Where the two boards differed in
appearance rather than in capability, the web was wrong by definition — its Add-task trigger
was a default-size icon button reading "New card" against the desktop's small primary "Add
task…", so it set the toolbar's height and the two toolbars sat at visibly different heights
side by side, the same action reading as a different control at a glance. The dialog _behind_
it still asks for less than the desktop's, and that stays: it asks what `CommandEnvelope`'s
`create-task` kind can carry, which is a feature difference, not a styling one.

**The web-only features already named** — a client-name badge on each card, a picker for
which desktop Client's board is showing, or both — are the same rule read forwards rather
than an exception to it. The web genuinely has data the desktop does not: the mirror carries
more than one machine's rows, and
[`targetClient.ts`](../../apps/web/src/board/targetClient.ts) already has to choose one
Client to address a command to. Surfacing that is legitimate work. When it is done it is
built from the shared components and tokens, in the desktop's visual language — a Fluent
control the desktop would recognise, sized and coloured like its neighbours — not a web-only
style admitted through the door a web-only feature opens. It is **separate work and not part
of this ticket**; nothing above should be read as scheduling it.

**Where the line between shared and forked now sits.** The share-vs-fork rule at the top of
this section is unchanged — share a component with no host in it, fork it where sharing would
mean a dozen optional props the web passes none of. What moved is one category that had been
on the wrong side of it. The desktop renderer's `index.css` owned the rules that make this
app _look like this app_ — the dark `color-scheme`, the `#1f1f1f` page background, a shell
that never scrolls, the thin fade-in scrollbars — while `apps/web` had a smaller stylesheet
of its own that agreed with none of them. Two files, one product, and nothing stopping either
from drifting. They are now `useGlobalStyles` in
[`@tm/ui/theme`](../../packages/ui/src/theme.ts), the `makeStaticStyles` both entry points
already called for the spinner's cyan, and `apps/web/src/index.css` is deleted rather than
emptied. No build change was needed: Griffel compiles each key as a literal selector, so
`*::-webkit-scrollbar` survives intact — checked before the move, because the fallback was
teaching `tsup` to emit CSS.

One rule stayed behind, and it draws the line exactly: `.app-drag` / `.app-no-drag` in
[`index.css`](../../apps/client/src/renderer/src/index.css). `-webkit-app-region` is how
Chromium is told which parts of a frameless Electron window drag it — the app runs with no OS
title bar, so our own bar is the handle — and in a browser tab the property does nothing. It
is not styling the web declines to share; it is the one rule in the file with a **host** in
it, sorted by the same test the components are.

**What now guards this, and what still cannot.**
[`test/shell-parity.test.ts`](../../test/shell-parity.test.ts) asserts the structural
property that makes the claim true: both `App.tsx` files import `AppShell`/`NavRail`/
`StatusBar` from the shared shell, both board screens use `useBoardLayoutStyles` and declare
no root/board/columns/right rule of their own, neither host re-declares the global rules that
moved, and both `main.tsx` files mount `appDarkTheme` through `scaleTheme` **and call**
`useGlobalStyles()` — `makeStaticStyles` emits on first use, so an unused import emits nothing
and raises no error either. It lives at the repo root beside `repo-invariants.test.ts`, the
only place with both apps in scope.

It proves the two hosts render through the **same modules**. It cannot see a rendered pixel:
a divergence made _inside_ `@tm/ui` sails past all of it. What it catches is the realistic
regression — someone adds a local `makeStyles` shell to one side, or re-declares the
scrollbar CSS in one host's stylesheet, and the two drift one plausible commit at a time with
nothing red anywhere.

**So the debt carried forward from v0.82.0 is unchanged and still owed: a human has to open
the two UIs side by side.** No test in this repo can check the ticket's actual claim — it is
a claim about whether two UIs _look_ the same, this workspace has no DOM harness (no jsdom,
no `@testing-library`), and adding one is a workspace-wide call both passes deliberately left
outside their scope. Nor is it settled by opening a window here: per **Never launch the app**
above, nothing in this ticket verifies anything by running the product. Owed with it, also
unchanged: the read-only pane's refusals actually pressed, and the back-fill run against a
real board that predates the outbox triggers.

#### The conventions every step ran on

The same four as **Notes for every step** above — a built `@tm/ui`, `RELEASE.md` §1's gates,
`CONTRIBUTING.md` §4's version rule, and never launching the app — held for all of this pass's
sessions too. The list is not repeated for its own sake: each bullet says only what this pass
learned about that convention that the first one had not, and the two it learned nothing new
about say so in a line and stop.

- **A stale `@tm/ui` breaks a new _symbol_, not just a new file.** The first pass's version of
  this was a new shared module with no `.d.ts` behind it, and an error
  ("cannot find module `@tm/ui/shell/AppShell`") that reads like a missing path alias. The
  narrower case is worse, because it does not look like a build problem at all: adding
  `useGlobalStyles` to [`theme.ts`](../../packages/ui/src/theme.ts) — a module `apps/web`
  **already** imports — leaves the export map resolving and `dist/theme.d.ts` present but a
  build behind, so what comes back is _has no exported member `useGlobalStyles`_, which reads
  as a typo or a bad merge. Same cause, same fix: `pnpm typecheck` runs `^build` first
  (`turbo.json`), a bare `tsc` inside `apps/web` and an editor's language server do not.
- **`--force` goes on `typecheck` and `build`, and on nothing else.** The root `test` script is
  `turbo run build --filter=./packages/* && vitest run`: turbo is there only to rebuild the
  workspace packages, so the flag reaches **vitest**, which exits on
  _Unknown option `--force`_ before a single test runs. Nothing is lost by leaving it off —
  that rebuild is unconditional and `vitest run` has no result cache, so `pnpm test` is already
  the uncached gate `--force` has to make of the other two. `pnpm format:check` is not a turbo
  task at all.
- **If a gate refuses to run, `pnpm install` before reaching for flags.** Sessions on this
  branch got the gates green by passing `--env-mode=loose` with
  `npm_config_verify_deps_before_run=false`, and read the cause as the version bump sitting
  modified in the tree. That diagnosis is wrong and the flags are not a convention. Checked at
  this commit, with `apps/client/package.json` bumped and uncommitted and neither flag nor
  setting anywhere in the environment or `.npmrc`: `pnpm typecheck --force` is green, 9/9, 0
  cached. What the flags suppress is pnpm's pre-run check that `node_modules` matches the
  lockfile — an _install-state_ fact about a worktree, which a fresh one has by not being
  installed yet and which editing a manifest does not create. `pnpm install` fixes that state;
  the flags only agree to ignore it.
- **The version rule held**, one PATCH per commit — see the ladder in **Notes** below. It is
  the only one of the four this pass did not have to learn anything new about.
- **Never launch the app** (`RELEASE.md` rule 6) held for every session, which is precisely why
  the debt above stays a debt: the one check that would settle the ticket's claim is the one
  check nobody working here is allowed to run.

**Notes.**

- The version ladder on this pass is `0.82.0` → `0.82.6`, one PATCH per commit
  (`fix`, `fix`, `test`, `docs`, `docs`, `test`), each carried **in** the commit that earned it.
  That is `CONTRIBUTING.md` §4 working as written, rather than the §2 fallback the first pass
  needed — the branch is not the fifth in a row to reach its end with no version of its own.

#### What was actually verified, and what a green gate does not mean

The last step of the pass ran the gates and then went looking for the three things a gate
cannot see. All four are green at the branch head and none of them was cached:
`pnpm typecheck --force` (9/9, 0 cached), `pnpm build --force` (6/6, 0 cached),
`pnpm format:check`, and `pnpm test` (136 files, 2244 passed, 11 skipped — seven more tests
than the pass started with, which are the parity guard's).

**The global rules survive the build — checked against the CSS, not against the source.**
Moving them into `useGlobalStyles` was reasoned about from Griffel's implementation
("`makeStaticStyles` compiles each key as a literal selector"), and an implementation detail
believed is not an implementation detail checked. So the built `packages/ui/dist/theme.cjs` is
now loaded with `makeStaticStyles` stubbed to capture the object it is handed, and that object
is put through Griffel's own `resolveStaticStyleRules` — the same function the hook calls at
runtime. Twelve selectors in, twelve rules out, nothing dropped, and every declaration that
matters present in the emitted text: `color-scheme:dark`, `background-color:#1f1f1f`,
`overflow:hidden`, `scrollbar-width:thin`, `scrollbar-color:transparent transparent`,
`background-clip:padding-box`. `*::-webkit-scrollbar-thumb` and its three `:hover` states come
out written exactly as they went in. The same strings are then present in both hosts' shipped
bundles — `apps/web/dist/assets/index-*.js` and `apps/client/out/renderer/assets/index-*.js` —
so nothing is lost at the app's own bundling step either.

That check is [`packages/ui/scripts/verify-global-css.mjs`](../../packages/ui/scripts/verify-global-css.mjs)
rather than a paragraph here, because a verification nobody can re-run is a claim. It is a
hand-run script and deliberately **not** on `pnpm test`: it reads `dist`, and the guard that is
on the gates (`test/shell-parity.test.ts`) reads sources and answers a different question. It
was proved able to fail, both of its arms: deleting `*::-webkit-scrollbar-thumb` from
[`theme.ts`](../../packages/ui/src/theme.ts) and rebuilding produces
`missing selectors: *::-webkit-scrollbar-thumb`, and a selector that emits no rule produces
`dropped by Griffel: …`. The second had to be simulated inside the checker — today's Griffel
drops nothing, which is the whole reason the arm is there rather than something that can be
staged.

**The two toolbars, control by control.** `BoardToolbar.tsx` against
[`MyTasks.tsx:855-968`](../../apps/client/src/renderer/src/MyTasks.tsx), in render order.
Every control the web draws is the same Fluent component with the same `size`, the same
`appearance`, the same icon and the same words — and the words are the same because both sides
call the same helper (`doneSwitchLabel`/`doneSwitchTitle`, `archivedCountLabel`/
`archivedCountTitle`), never a string of their own. Both toolbars are `layout.toolbar` with the
same `layout.grow` spacer in the same position. The four absences are the four the header names
— Current sprint, Chain, the commit graph, Sync — and each is an action a browser cannot
perform.

Two props differ and neither is a look:

- The desktop passes `disabled={!settings}` to `BoardDisplayMenu` and the web passes nothing.
  That prop reaches the **menu items**, never the trigger, which is `size="small"`
  `appearance="subtle"` with the same eye glyph on both sides regardless. It guards the window
  in which the desktop's settings have not come back over IPC yet, and toggling an item then
  would save the default over what is on disk. The web has no such window: `loadBoardPrefs`
  reads `localStorage` in the `useState` initialiser, so the prefs exist before the first paint.
- The web's Add-task trigger carries `disabled`/`title` and the desktop's does not — "no desktop
  app has ever synced this account", which is a fact about what this host can do. Same
  `size="small"`, same `appearance="primary"`, same `Add task…`, still no icon.

**Every assertion in the parity guard was broken and watched to fail.** Seventeen mutations,
one per assertion per host, each applied as a single exact string replacement, run against the
suite alone, and restored in a `finally` that re-reads the file to confirm the restore landed.
All seventeen killed; the suite was green before the first and green after the last, and
`git status` was clean. They covered each shell piece imported by name (`AppShell`, `NavRail`,
`StatusBar`), the board frame's import and each of the frame rules re-declared locally, the two
global rules re-declared in a host stylesheet, and every clause of the theme assertion
separately — the import, `scaleTheme(appDarkTheme, …)` replaced by the raw palette, and the
import kept while the **call** is removed, which is the one that matters and the one an unused
import would hide.

One of the seventeen had to be made in the test rather than in a host: the
`hostFiles.length > 10` guard is about the test's own reach, so it was exercised by pointing
`HOST_TREES` at a four-file directory. It failed with `found no host sources to scan`, which is
the point of it — a tree that moves must read as a broken test and not as a clean board.

**None of that is the check the ticket needs.** `apps/web` builds from this worktree and its
bundle demonstrably carries the shared rules, and that is the end of what a headless session
can say. The debt is unchanged and still owed to a human, in one sitting, with both open: the
board, the rail, the status bar, a card selected in the detail pane, and a column scrolled far
enough to show a scrollbar — which is the one thing this pass changed that only a screen can
confirm. With it, still owed from before: the read-only pane's refusals actually pressed, and
the back-fill run against a real board that predates the outbox triggers.

---

## Fix — moving a card to IN PROGRESS blocked it in JIRA

**Goal.** One reported bug, fixed across the whole path it travelled: dragging a card into
IN PROGRESS transitioned the linked issue to **Blocked**, and the sync that followed then
filed the card wherever that status's category pointed. Both halves were the same blind
spot — the resolver had no way to read a status as blocked, so BLOCKED was a column the
board could draw, a human could drag into, and nothing coming from JIRA could ever reach.
A `Block` transition therefore looked to the picker like any other indeterminate step
towards IN PROGRESS. BLOCKED is now a column like the other four: `isBlockedishStatus`
reads it, Settings maps onto it, a drop into it transitions the ticket wherever the
workflow can say so, and `preBlockStatus` records *who* owns the block so the sync knows
which blocks are its to keep. Steps 1–6 above; step 7 retired the "blocked is
internal-only" rule everywhere it was still written down (see Phase 15's note).

### What is deliberately not in this fix

Three things a reader of the diff will reach for. Each was considered and left out, and
the reason is load-bearing in every case — two of them would make the fix *worse*, not
merely larger.

- **A migration that deletes poisoned `learnedStatusColumns` entries.** Every install that
  hit the bug is carrying one: a drag that "succeeded" wrote `{"Blocked": "in-progress"}`
  on the authority of a transition it should never have taken. The learned tier now refuses
  to speak for a blocked-ish name at all (`resolveStatusColumn`), and `shouldLearnStatus`
  stops new ones being written, so the entry is inert where it lies.

  Deleting it buys nothing anyone can see. Settings' status table resolves through the very
  same function, so a poisoned entry is not displayed as a learned mapping there either —
  the row reads "Name says blocked", which is the truth. The only thing a migration would
  tidy is the settings JSON. Against that, it would have to **guess**: `isBlockedishStatus`
  needs the status's category, and the stored map is name→column with no category in it. At
  migration time there may be no JIRA connection to ask, and guessing wrong deletes a
  mapping the user's workflow legitimately meant — a `Blocked`-named status a scheme really
  does file under Done, say. A read-time refusal cannot make that mistake, because it always
  has the category in hand.

  Contrast [`blockOwnerMigration.ts`](../../apps/client/src/main/blockOwnerMigration.ts),
  which *was* written and is not the same kind of thing. There, a stored value changed
  meaning: `preBlockStatus: null` used to mean "we never recorded a column" and now means
  "the tracker owns this block". Old rows would be read as a claim they never made, and the
  next sync would silently unblock them. A migration was the only way to say what those
  rows meant — the fact was not recoverable at read time. Here it is.

- **A "which transition would this drag use?" preview in Settings.** The obvious next column
  for the status table, and it cannot be built there honestly. Transitions in JIRA are per
  issue and per workflow: `client.getTransitions(issueKey)` answers for *one ticket in its
  current status*, so the same board column can resolve to a different transition for two
  cards on the same screen. There is no board-wide answer, and a table that showed one would
  be inventing a certainty the API does not offer — the same class of lie this table was
  built to end. Rendering it truthfully means one network round trip per row, on a screen
  that currently opens instantly and offline.

  What people actually get surprised by is narrower and already covered: an exact transition
  name typed into Settings that lands somewhere other than the column they dragged to. That
  is answered at the moment it happens, by the issue it happened to, with the status it
  really reached — the `board:notice` warning in `transitionIssue`. A preview would have to
  be right about every ticket; the notice only has to be right about the one that moved.

- **A test harness for `registerIpcHandlers`.** Standing up a `BrowserWindow`, a store and a
  fake `ipcMain` to exercise handlers would test the wiring, and the bug was never in the
  wiring. The response was structural instead: every *decision* this fix touched was moved
  out of [`ipc.ts`](../../apps/client/src/main/ipc.ts) into a pure module with its own tests
  — `resolveStatusColumn`/`isBlockedishStatus` (`@tm/shared`), `resolveMove`,
  `pickTransition` and `shouldLearnStatus` (`jira/jiraMove.ts`), `needsBlockOwner`
  (`blockOwnerMigration.ts`). `shouldLearnStatus` was literally lifted out of the handler
  that held it inline, where it could not be tested at all. What is left in `ipc.ts` is a
  `getTransitions`, a `doTransition`, a `send` and a patch — and
  [`verify-jira-move.mjs`](../../apps/client/scripts/verify-jira-move.mjs) already drives
  that end of it over a real socket against a stub JIRA, which is the part a mocked
  `ipcMain` would have faked.

**Notes.**

- No release step: this is a feature branch, and per `RELEASE.md` rule 5 the tag is cut once
  it reaches `development`. The version ladder ran 0.78.13 → 0.78.17 across the fixing steps.

---

## Phase 26 — Support all interactions in the web

Phase 25 gave the browser a board that looked exactly like the desktop's and could do almost
nothing: drag a card between columns, add a card, and read. This phase is the rest of it.

### The decision: relay a channel, not a command kind

The v1 wire had three `CommandKind`s — `set-status`, `add-comment`, `create-task` — each
mapped by hand in [`cloudCommands.ts`](../../apps/client/src/main/cloudCommands.ts) to the
`Store` mutation the desktop's own IPC handler would have made. That was the right shape for
three. `IpcApi` has about 115 channels, and the obvious next step — one kind per channel —
would have been a second, hand-maintained copy of a contract that already exists, drifting
from it one forgotten field at a time. Every one of those channels also already has a
handler on the desktop that does the right thing, *including* the atomicity it chose, the
JIRA write-back it performs and the events it pushes. A cloud-flavoured `task:move` would
have been a second answer to a question with an answer.

So the relay carries the CHANNEL. One new kind, `ipc-invoke`, with a payload of
`{channel, args}`; the applying client looks the channel up in a registry that `ipc.ts`'s own
`handle()` fills, and runs the real handler.

The three v1 kinds stay. A queued row can outlive an upgrade, and `set-status` in particular
earns its place: its effect is observed through the mirror, so it needs no result to travel
back at all and the browser can resolve it the moment the command is queued.

### The host-only list, and a reason each

`ipc-invoke` is a remote-code-execution primitive pointed at your own desktop, so what may
travel is decided by an **exhaustive** `Record<keyof IpcApi, RelayPolicy>` in
[`packages/shared/src/ipcRelay.ts`](../../packages/shared/src/ipcRelay.ts). Exhaustiveness is
the point: adding a channel to `IpcApi` fails `pnpm typecheck` until somebody classifies it.
A `Set` of strings would have let a new channel default to relayable, and the first person to
find out would be whoever's file dialog opened on a machine they were not sitting at.

Twenty channels are host-only, in four groups:

- **Native modals** — `project:pickDirectory`, `project:pickFile`, `attachment:pick`,
  `jira:pickAttachments`. Each `await`s `dialog.showOpenDialog`. Relayed, one wedges cloud
  sync (the drain is serial) until somebody dismisses a dialog they did not ask for, and the
  paths it returns are paths on a machine the browser cannot use.
- **Window / OS** — `window:*`, `update:install` (quits the app), `attachment:open`
  (`shell.openPath`, on someone else's screen), `auth:signIn` (opens a terminal there) and
  `iam:signIn` (the web runs its own PKCE flow; relaying it would sign the *desktop* in).
- **Credential writes** — `jira:setCredentials|clearCredentials`,
  `gitlab:setCredentials|clearCredentials`, `iam:signOut`. A secret typed into a browser
  would cross as plaintext inside a command payload and land in the server's `commands`
  table, which is an audit trail.
- **Live sessions** — `session:start|stop|answer`. A run id is a handle into the desktop's
  `SessionManager` and means nothing in a browser, which has no way to have obtained a valid
  one. The card-level equivalents (`task:run`, `task:stopAgent`, `task:resumeAgent`,
  `task:chat`, `attention:answer`) DO relay: they take a task id, which is mirrored, and they
  are what the UI actually presses.

Both sides read that one file: apps/web refuses locally so the click fails immediately, and
the engine refuses again if a command arrives anyway. One refusal sentence, written once.

**`task:resumeAgent` is the twentieth channel's near miss, and the rule decided it.** It
landed on `development` while this branch was in flight, and `development`'s own web
transport — the refuse-everything tier this branch replaced — had refused it with the comment
*"a browser has no engine to resume into"*. That reasoning belonged to a transport with no
relay under it. Here the channel takes a **task id**, not a run id, and is the exact
card-level twin of `task:run` and `task:stopAgent`, both already relayed: the browser is not
resuming anything itself, it is asking the desktop to. So it relays, `HOST_ONLY_REASONS` is
untouched, and the host-only count stays at twenty across the same four groups.

That classification is not a matter of taste in this file. `RELAY_POLICY`'s value type is
computed from `HOST_ONLY_REASONS` —
`{[K in keyof IpcApi]: K extends HostOnlyChannel ? 'host-only' : 'relay'}` — so the two lists
cannot disagree: writing `'host-only'` here without a reason above is a **type** error, and so
is the reverse.

### Mirror or RPC: the rule, and the two entities it selected

An RPC works while a desktop client is polling. The mirror works whether or not one is
awake, because the server holds the rows. That is the whole difference, and it is what
decides which of the two anything uses:

> **Mirror it when it must be readable with the desktop asleep. Otherwise relay it.**

By that rule the board's cards and projects stay mirrored (they always were), and everything
else the detail pane needs — attachments, chain links, merge requests, the agent projects,
settings — is relayed, because a pane you opened while nothing was running has nothing to
show you anyway.

Two entities were selected for mirroring and **have not been built** — see *What this leaves
owed* below. `task_activity` (the timeline is most of the detail pane) and `attention_items`
(an inbox you can only read while the desktop is awake is not an inbox) are the two whose
value survives the desktop being off. Both are readable today over the relay.

### Why there is no event feed, and no SSE

The desktop pushes a dozen `IpcEvents` channels. There is no such wire here, deliberately:
Phase 25's "No realtime service" section costs out one polled round trip per tick, and at the
active tier's 2.5s a second connection is a second bill — plus an SSE endpoint is a stateful
thing to run and to scale, against a workload of one human clicking.

Almost every one of those events is "here is the whole new list", and every one of those has
a READ that returns exactly the same thing. So
[`PolledEventBus`](../../apps/web/src/board/polledEvents.ts) reconstructs them: call the
read, diff, fan out. Three rules make that honest — only the reads someone is subscribed to
are called, an unchanged payload emits nothing, and the FIRST read is a baseline rather than
a change (the component that just subscribed has already loaded it).

Three do not survive, and the module says so by name rather than being quietly short:
`window:maximizedChanged` (host-only anyway), `board:notice` (a transient toast is not state,
so a poll cannot find it again) and `usage:sample` (a 1 Hz sample against a 2.5s poll — the
Performance gauge redraws from `usage:series` instead, which is stated in the UI).

> **Superseded.** The "Mirror all interactions/features to web" round builds the wire this
> section ruled out — `POST /v1/events` and a server-sent `GET /v1/events`
> ([`apps/server/src/events/`](../../apps/server/src/events/)) — because the third bullet is
> the one that did not hold: `board:notice` and a running agent's transcript have no read
> behind them, so polling can never reconstruct them at any cadence. The two costs stand and
> are paid deliberately: the stream is stateful (hence the pinned single replica in
> [`docs/09`](../09-deploying-the-cloud-service.md)), and it is a second connection — which is
> why a desktop only forwards while `SyncResponse.eventListeners` says somebody is watching.
> `PolledEventBus` stays as the fallback for a browser talking to a desktop too old to
> forward — and for one whose stream is down. `apps/web/src/board/eventBus.ts` is the
> composite that chooses between the two, and the rule it enforces is that they are **never
> both running**: the same events travel on both, so a live stream beside a live poll timer
> means every whole-list event arrives twice and `task:changed` double-fires. The fallback is
> paused rather than unsubscribed, because its baselines are the only reason falling back is
> worth anything — the first poll after a resume diffs against the board as it was when the
> stream took over, so a change the stream failed to deliver is announced instead of being
> absorbed into a fresh baseline.
>
> The browser reads the stream with `fetch` + `ReadableStream`, not `EventSource`: the latter
> cannot set an `Authorization` header, so the bearer would sit in an access log for the life
> of every connection, and it reconnects itself with the stale URL after the token expires —
> a 401 loop the page cannot intercept. The `text/event-stream` framing is kept regardless,
> because every proxy in the path already knows not to buffer it.

### At-least-once, at last

Delivery was **at-most-once while every docstring claimed at-least-once**.
`MirrorService.sync` set `deliveredAt` inside the transaction that read the queue, the filter
was `deliveredAt IS NULL`, and `SyncRequest.ackedCommandIds` was accepted and never read. A
command whose HTTP response was lost was never sent again. Survivable for `set-status`, whose
optimistic overlay expires on its own; fatal for an RPC a browser is awaiting, where "the
reply was lost" and "the desktop has not answered yet" look identical forever.

`deliveredAt` is a LEASE now and `ackedAt` retires the row
([`commandQueue.ts`](../../apps/server/src/mirror/commandQueue.ts), pure and tested like
`rowVersion.ts`). The lease is five minutes: one idle cadence interval, plus the slowest
relayable handler (`jira:sync`/`gitlab:sync` are minutes-scale), plus the fact that the drain
is serial so a slow one holds the queue behind it. `enqueueCommand` became idempotent too —
the primary key is caller-supplied, so a retried POST used to be a 500 for a command the
server had accepted perfectly well.

### The result-replay ledger, and the transaction that was never there

Redelivery being real changes what the applied-command ledger has to hold. It stored a
boolean and short-circuited a repeat to `{ok: true}`; a redelivered `task:run` on a card that
is running *because of that very command* would then re-enter `scheduler.startTaskNow` and
answer the browser "already running" for a command that had succeeded. So
`cloud_applied_commands` stores the ANSWER, and a repeat arrival replays it.

Going async also exposed a trap that would have shipped in silence.
`store.runInTransaction(fn)` is `db.transaction(fn)()`, and better-sqlite3 requires `fn` to
be **synchronous**. Hand it an `async` one and it returns a Promise, the transaction commits
at the first `await`, and every write after that runs untransacted — no error, nothing red.
`applyCloudCommands` wrapped its whole batch in exactly that call.

The fix is not an async transaction; there is no such thing here. It is that the batch
transaction was the wrong unit anyway: a relayed invoke runs a handler that already chose its
own atomicity, wrapping several of those in one SQLite transaction was never going to make
them atomic together, and rolling command #2 back because command #4 failed is not something
any caller asked for — they are separate clicks by a human. Each command stands alone now,
and the only transaction left is the tiny synchronous one that records its outcome.

And the trap itself is a **type** now rather than a docstring, which is the same bet
`RELAY_POLICY` declined to make: a warning is read once by whoever writes the call and never
again by whoever makes it async two years later. `runInTransaction`'s rest parameter is
`SyncOnly<T>` — empty for a synchronous `fn`, and a one-element tuple nobody can supply for
one that returns a promise, so the call does not compile and the tuple's label says why.

Two shapes were tried and rejected first, and the reason is worth recording because both
_look_ like they work. A second, refusing OVERLOAD is never selected at all: overload
resolution checks arity before parameter types, so a one-argument call skips a two-parameter
overload and lands on the permissive one. And a conditional in the RETURN position resolves
to `never` silently rather than erroring, which is the same shape of invisible failure the
gate exists to end. The ban has to ride on the signature that actually matches, after `T`
has been inferred from `fn`. This is a failure that leaves nothing red at runtime, so it is
caught at build time or not at all.

Two smaller corrections came with it. The batch is no longer re-sorted by `issuedAt`, which
is a *browser's* wall clock: the server already delivers `createdAt ASC` from a clock it owns,
so there is one authority and it is monotonic. And the per-outcome event fan-out in `ipc.ts`
was removed for relayed invokes — the real handlers already push `task:changed`,
`project:tasksChanged`, the chain and the attachments themselves, so left in, every relayed
click would have pushed twice.

### The drain, and why the poller stays a poller

`CloudPollerDeps.onCommands` is `(commands) => void`, called fire-and-forget while `tick()`'s
`finally` re-arms the timer. Making it `async` would let the next tick's batch interleave
with this one over the same cards. Awaiting it inside `send()` instead would couple poll
liveness to handler latency: one `jira:sync` taking two minutes would stop the mirror for two
minutes, and a channel that never resolved would stop it forever.

So [`main/commandQueue.ts`](../../apps/client/src/main/commandQueue.ts) owns the
serialization — enqueue and return, drain one at a time in delivered order, emit each result
— and the poller stays a poller.

### The browser end

[`httpTransport.ts`](../../apps/web/src/board/httpTransport.ts) posts the command, keeps a
pending-promise map keyed by command id, and polls `GET /v1/results` **only while something
is pending**, widening from 300 ms to 2.5 s as it waits. Request volume is bounded by clicks
rather than by wall time: an idle tab makes no results requests at all. A timeout says WHICH
silence it was — `BoardResponse.clients` already knows whether any desktop is polling, and
"start the app" and "wait, it is still working" are different problems.

The **stub tier is gone**. It answered fabricated empty values for eight reads, and every one
of them was false the moment a desktop was actually polling. Before un-stubbing
`task:activity`, `TaskDetail`'s `loadActivity` got the `.catch` it never had: it was the one
mount read with no error handling, so a rejection was an unhandled rejection *and* left the
previous card's timeline under the new card's title.

Results are served by their own route rather than folded into `BoardResponse`, and the reason
is scope: a board is account-wide, a result belongs to the one tab awaiting it. `GET
/v1/results` is scoped to `accountId` **and** `issuedBy`. The same request also made a third
polled route out of `IamAuthGuard`, which was making two uncached IAM round trips per request
— hence [`authCache.ts`](../../apps/server/src/iam/authCache.ts), a ten-second TTL that never
caches a failure and stays bounded.

### Which desktop, by name

`BoardResponse.clients` answered "how many", and the status bar said so — _2 clients_ — about
a set the human could neither see nor choose from, while every edit made in the browser goes
to exactly **one** of them (`resolveTargetClientId`, most-recently-seen-wins). So a
`ClientInfo` rides `SyncRequest` — `os.hostname()`, `process.platform`, `app.getVersion()`,
`PROTOCOL_VERSION` — lands on four nullable `clients` columns via the lazy upsert that already
happens on every sync, and comes back on `ClientPresence.info`.

Identity is allowed on a table that [deliberately refuses to store
presence](../../apps/server/src/entities/client.entity.ts) because of what it costs: a
hostname changes when a machine is renamed and a version when the app updates — roughly never
— so writing them on a row that is being written anyway is free, where `lastSeen` would have
been a write on every poll at the 2.5 s tier. `GET /v1/board` joins the two by primary key
over the handful of ids presence just returned, and skips the query entirely when nobody is
polling.

**A picker, only when there is a choice.** One Client renders as a label; a second turns it
into a menu, and the pick is persisted beside `lastKnownDesktopClientId` in its own key — that
one is a record of what was observed and is overwritten on every poll, so a preference stored
there is not a preference. A preference for a Client that is **not** live is skipped and not
cleared: the machine is off, not disowned, and it takes the target back the moment it polls
again, while edits meanwhile go somewhere that can apply them.

**And the skew warning.** Both ends have exchanged `PROTOCOL_VERSION` since it existed, and
until now the only thing that ever compared them was `RelayRegistry.invoke` refusing an
unknown channel with _"probably older than the browser tab talking to it — update it"_ — a
correct sentence that arrives after a click, on one control, with no way to tell whether the
next control will work either. `versionSkew` says it when the board loads instead. It is not a
blocker: most channels work across a gap (that is the whole reason the bump rule is "only when
an older peer would be WRONG to ignore it"), and it stays silent for a desktop that never said
which version it speaks — an unknown version is not a mismatch, and warning about one would
fire on every desktop alive the day this shipped.

**What deliberately did not travel: configuration.** `settings:get`, `jira:getConfigStatus`,
`gitlab:getConfigStatus`, `agentProject:list` and `exec:listDistros` are all `'relay'`, so the
browser already reads every one of them live off the target Client. Mirroring any of it onto
`ClientInfo` would be a second, staler copy of an answer the wire can already ask for. Identity
is the exception because it is the one thing you cannot ask a Client for: you have to know
which Client to ask first.

### Two blockers that had to clear first

- **No tombstones.** `GET /v1/board` hardcoded `deletedTaskIds: []` while
  `cloudBoardStore.applyBoardResponse` handled them correctly and simply never received any.
  A card deleted on the desktop sat on an open web tab until reload. There is a `tombstones`
  table now, written by `applyMirrorDelta` and cleared when an id comes back (`task:restore`
  reuses it).
- **`rowsSince` was unbounded.** The push side has been carefully bounded since
  `SYNC_BYTES_LIMIT`; the read side had no `take` and no byte cap, so a first poll against a
  mature board asked for everything in one response. It pages now, with a `hasMore` the
  browser polls straight through rather than one page per cadence interval.

  Paging it then created a subtler bug than the one it fixed, and
  [`boardCursor.ts`](../../apps/server/src/mirror/boardCursor.ts) is where that rule lives
  now. `GET /v1/board` reads THREE streams — task mirrors, project mirrors and tombstones —
  pages each one separately, and returned the MAXIMUM rowversion across all three as the
  cursor. A rowversion is database-global, so those streams interleave: an account whose
  backfill wrote 600 tasks (rowversions 1..600) and then 3 projects (601..603) pages the
  tasks at 500, reads the projects whole, and answers `max(500, 603) = 603`. The next poll
  asks for everything past 603, and tasks 501..600 are never sent again — a hundred cards
  simply missing from the web board, with `hasMore` having faithfully reported that there was
  more, until somebody happens to edit each one and bump its rowversion.

  A cursor is a promise that everything at or below it has been delivered, so a stream the
  cap cut short imposes a ceiling at its own last row and the lowest ceiling wins. Re-sending
  the rows above it on the next poll costs a duplicate upsert, which `applyBoardResponse`
  absorbs; passing it loses rows outright, which nothing ever notices. Progress is still
  guaranteed — a truncated stream's rows are all strictly past `since`, and it always keeps
  at least one, so a ceiling is always higher than the `since` it clamps.

### What the board gained

None of it needed extraction. `TaskDetail` already rendered the agent panel, the merge
requests, the attachments, the chain and the attention ring; `BoardScreen` just never passed
the props, so the same component drew a stub in one host and the whole thing in the other.
[`useBoardExtras`](../../apps/web/src/board/useBoardExtras.ts) relays the eight reads and the
pane draws what it always could. The cards gained stop-from-card, step folding and earlier
planning rounds; the board gained `ChainOverlay` and `ChainLinkPopover` (draw, re-gate and
delete arrows); the toolbar gained Current sprint, Chain focus and Sync; Removed cards can
restore.

**Resume, in both places the desktop offers it.** The detail pane's came free:
`TaskAgentPanel` calls `transport.invoke('task:resumeAgent', taskId)` itself, so relaying the
channel is the whole of it — nothing to wire. The board **card's** needed a prop, because
`KanbanColumn`'s `onResumeTask?` is optional and apps/web was not passing it. `useBoardExtras`
gained `resumeTask` written as the mirror of the `stopTask` immediately above it: invoke, then
re-read `scheduler:activeRuns` into `setLiveRuns`. That second call is not belt-and-braces —
no event carries *"this run started"* to a browser, so re-reading the live set is what puts
the spinner on the card now rather than whenever the next poll happens to come round.

Nothing was needed to decide *when* to offer it. `canResumeWork`
([`packages/shared/src/board.ts`](../../packages/shared/src/board.ts)) reads `task.stoppedAt`,
`task.status` and the card's own steps, and `TaskMirror.data` stores the whole `Task` as JSON
— so `stoppedAt` already crossed the mirror, with no schema change and no migration.

The board's own preferences moved off this app's `localStorage` onto `settings:get`/
`settings:save`, so the switches ARE the desktop's rather than a second set of the same three
that silently disagreed. That made `settings:save` the one relayed channel whose arguments are
rewritten on the way through: both Settings screens load the whole blob at mount and save it
whole, and a browser widens that staleness window a great deal, so a relayed save MERGES over
the engine's current copy instead of overwriting it.

### Shared, and forked

`Attention.tsx` and `Performance.tsx` had no host in them at all — only `window.api` calls —
so they moved into `@tm/ui` whole, with `useTransport()` in their place, dragging their
host-free helpers along (`PaneLoading`, `useInitialLoad`, `TokenChart`, `BurnRateGauge`,
`UsageQuotaBars`, `usageFormat`, and `formatCountdown` out of `LimitBanner`). The desktop
imports them back: extracted, never copied.

`Settings.tsx` went the other way, and the ratio is the argument: 1478 lines in ONE component,
nine of twenty-one channels host-bound. Sharing it whole would have meant roughly eight
optional capability props the web passes `false` for — exactly the shape this repo's own rule
says to fork instead. So the split is by SECTION: the pieces with a rule in them are shared as
real components (`ColorSwatches` and its palette, `StatusMapViewer`, `PlanningModelField`,
`BaseBranchField`) and `apps/web/src/settings/` owns the shell, with a *Desktop only* tab that
names each withheld section and why.

### Bytes in the cloud

Every row a card carries reaches the browser over the relay, including its attachments —
`attachment:list` and `attachment:changed` hand over whole `TaskAttachment` rows. The BYTES do
not: `attachment:add` takes paths precisely so a 30 MB screen recording never crosses a
structured clone, and a browser has neither the path nor the disk. So the chips rendered and
nothing behind them opened.

The cloud now holds a copy. `attachment_blobs` is one row per attachment (keyed by the
attachment's own id — an attachment's bytes never change, since re-attaching mints a new id),
`attachment_uploads` is the other direction: a file a browser picked, parked until the desktop
can collect it and turn it into a real attachment. `TaskAttachment.cloudBlobAt` is the epoch ms
of the last successful push, absent when there is nothing up there; it travels for free on the
rows that already travel.

**A cache, not a record.** The desktop's disk is still the only copy that matters, and that is
what makes eviction legitimate rather than data loss. It is also not optional garnish: the
default storage tier is a `VARBINARY(MAX)` column in the 2 GB SQL database that already holds
the mirror, so an unbounded cache is an outage on a long enough timeline. Each account gets a
quota, and pressure evicts blobs **coldest-first on `lastReadAt`** — last READ, so the mockup
somebody opens daily outlives the one nobody has looked at since it went up. An evicted blob
costs one re-push. [`quota.ts`](../../apps/server/src/attachments/quota.ts) is that arithmetic,
pure and tested; [`blobStore.ts`](../../apps/server/src/attachments/blobStore.ts) is the port
the SQL tier sits behind, and an Azure Blob adapter is one `useClass` away — which is where
this ends up, and why the bytes are a column on a metadata row rather than the row itself.

**The bodies are raw, and that is load-bearing.** `main.ts` registers only the JSON body
parser, so an `application/octet-stream` request arrives with its body unread — no multer, no
temp files, no third dependency. The cap is a byte counter that destroys the socket, not a
`Content-Length` check, because a header is what the sender *says*. Both ends of that carry a
comment: a global body parser added later would consume the stream and store an empty file,
silently, with nothing erroring.

**One route is guarded differently, and only one.** `GET /v1/attachments/:id` is read by an
`<img src>`, which sets no headers at all, so a bearer token cannot reach it. `MediaTokenGuard`
takes a `?mt=` ticket instead — one account, `media:read`, ten minutes, in memory, minted by a
POST that *is* bearer-guarded — and it authorises that route and nothing else. The bytes come
back `nosniff`, `Cache-Control: private, immutable` (honest, because a re-attached file is a
new id), `Content-Disposition: attachment` for everything that is not `image/*`, and SVG —
an image by MIME type, a document by capability — under `Content-Security-Policy: sandbox`.

The registry is per-process, like presence, the auth caches and the event bus: one more reason
[the service runs on a single replica](../09-deploying-the-cloud-service.md).

### Attaching and previewing from a browser

Those routes are plumbing until something calls them. Both ends now do, and each direction is
a different problem.

**Up, from a browser.** `Transport.attachFiles` is a method the desktop deliberately does not
implement, and `AttachmentStrip` branches on its presence: where it is missing (Electron) every
line is the one that was there before — the picker returns paths, a drop resolves through
`pathForFile`, `attachment:add` copies them — and where it is present the Attach button opens a
hidden `<input type="file">` and a drop hands over the raw `File`s. The web transport uploads
each to `POST /v1/uploads` and then relays the new `attachment:addUploaded`, naming only the
ticket ids. Two hops for one gesture, and they differ in kind: the bytes are megabytes and go
over their own raw route, while the command is JSON in the `commands` table, which is an audit
trail and not somewhere to park a picture in base64.

The desktop's handler streams each ticket into a **temp directory of its own** and then calls
the same `addAttachments` a local pick does — same naming policy, same dedupe, same size check,
same collected-failures contract, no second implementation of "become an attachment". One
directory per file because `basename` is how the name survives to the row, so two files called
`shot.png` in one gesture must not share a directory. And the `fileName` is a string from
another machine: `uploadTempName` makes it openable, `attachmentName` makes it *safe*, and that
second one is the boundary between an authenticated browser and a write into `userData` —
asserted directly in [`uploadedAttachments.test.ts`](../../apps/client/src/main/uploadedAttachments.test.ts),
which feeds it `../../../../evil.exe` and checks both what lands and what `attachmentName`
then reduces it to.

**Down, to a browser.** [`cloudAttachmentUploader.ts`](../../apps/client/src/main/cloudAttachmentUploader.ts)
pushes qualifying blobs — an image, under the cap, not already up — one a second, with the
boot pass doubling as the backfill for everything attached before this existed. `cloudBlobAt`
is stamped from the server's own `storedAt` and travels to the browser on the
`attachment:changed` it already listens to. A failure leaves the row unstamped, which is the
truth and is what makes the next scan retry it; a `413` is the one refusal that will still be
true tomorrow, so that id is not asked again. A desktop with cloud sync off makes no requests
at all.

`HttpTransport.attachmentUrl` therefore takes the whole row rather than an id: `''` unless
`cloudBlobAt` is set, because whether a host can serve an attachment is a question about that
attachment. The strip reads `''` as "no preview here" and shows the chip alone — a plausible
URL for bytes nobody pushed would look identical on screen and be a claim that was not true.
The `?mt=` ticket is held by [`mediaToken.ts`](../../apps/web/src/board/mediaToken.ts) and
refreshed ahead of expiry, because `attachmentUrl` is read *during a render* and cannot await
anything; the one render before the first mint lands is the same honest `''`.

Deleting an attachment does not delete its cloud copy. That is the cache argument taken
seriously rather than an omission: the blob is unreachable the moment the row is gone, and it
leaves on the next eviction pass like any other cold blob.

**Still owed: the add-task dialog.** `AddTaskDialog` stages absolute PATHS — there is no task
id to hang an attachment off until the card exists, so it holds paths and copies them on with
`attachment:add` afterwards — and a browser has none, so files cannot be attached *while
creating* a card there. The strip on the card itself works, which is the whole flow one click
later. Fixing it means teaching that dialog's staging model to hold a `File` as well as a path
and to pick the matching channel at create time, which is a change to a control the shared
add-task work had just settled; it is deliberately not folded in here.

### Verifying the mirrored web, headlessly

Nothing in this repo has ever seen a rendered pixel, so the gates are the suites plus the
scenario harnesses — and that is stated up front rather than discovered at the end, because
it bounds what everything below is evidence *for*.

**The gates, forced.** RELEASE.md §1's three, plus the `format:check` CI runs ahead of them.
`--force` on the two turbo-routed ones, because a cached gate is not a gate: this repo has
already once accepted a 47 ms `FULL TURBO` replay as a verification, so `0 cached` is the part
of each line that matters.

| # | Command | Exit | Result |
|---|---------|------|--------|
| 0 | `pnpm format:check` | **0** | All matched files use Prettier code style |
| 1 | `pnpm typecheck --force` | **0** | 9 successful, 9 total — **0 cached**, 34.358s |
| 2 | `pnpm test` | **0** | 177 files passed, 1 skipped (178); 2925 passed, 11 skipped (2936), 60.44s |
| 3 | `pnpm build --force` | **0** | 6 successful, 6 total — **0 cached**, 36.671s |

Not `pnpm test --force`: the root script is `turbo run build --filter=./packages/* && vitest
run`, so the flag falls through to `vitest`, which has no `--force` and exits on it. It needs
none — `vitest run` is not cached.

The 11 skips are the two standing opt-ins and nothing new (9 in `wslHost.test.ts` behind
`ORCH_WSL_TEST=1`, 2 in `wslSession.e2e.test.ts` behind `ORCH_E2E=1`).

**The first run of gate 2 was RED, and the reason is worth keeping.** Two tests in
`worktreeManager.test.ts` — untouched by this round — timed out at vitest's 5s default. Both
pass in isolation in under 2s; each spawns a dozen real `git` processes against a real temp
repo, so their duration is a function of how loaded the machine is, and this round grew the
workspace run by ~470 tests. Several neighbours were already sitting at 4–5.5s. So the failure
was real and the cause was not in the code under test: the two real-git suites
(`worktreeManager.test.ts`, `worktreeWsl.test.ts` — the latter crosses the WSL boundary at
~3.7s per test *idle*) now carry `vi.setConfig({ testTimeout: 30_000 })`. Per file, so a
genuinely hung unit test still fails in five seconds.

**The eight-term sum still holds, and is still eight.** Phase 25's invariant — the standalone
runs sum to the aggregate — re-derived from `pnpm exec vitest list --filesOnly` rather than
from the workspace layout, which is the trap: two paths belong to no package.

| Command | Files | Tests |
|---------|-------|-------|
| `pnpm --filter claude-orchestrator test` | 82 passed, 1 skipped (83) | 1541 passed, 11 skipped (1552) |
| `pnpm --filter @tm/server test` | 27 | 199 |
| `pnpm --filter @tm/web test` | 13 | 158 |
| `pnpm --filter @tm/shared test` | 27 | 645 |
| `pnpm --filter @tm/protocol test` | 1 | 12 |
| `pnpm --filter @tm/ui test` | 22 | 313 |
| `pnpm exec vitest run test/` | 4 | 32 |
| `pnpm exec vitest run scripts/next-version.test.mjs` | 1 | 25 |
| | **178 = the aggregate** | **2936 = the aggregate** |

#### The circuit, not the pieces

Every new module has its own suite — `ipcEventFanout`, the server's `eventBus` and
`sseStream`, the browser's `sseEvents` (fed a fake `ReadableStream`, since
`apps/web/vitest.config.ts` has no jsdom), the composite bus's never-both rule,
`cloudEventForwarder`'s batching and listener gate, the upload byte cap and the hostile
filename. What none of them covers is the wire, so
[`verify-remote-sse.mjs`](../../apps/client/scripts/verify-remote-sse.mjs) joins
`verify-remote-ipc.mjs` as the second harness: **36 checks**, all passing, driving one engine
event from a real `CloudEventForwarder`, through a real `POST /v1/events` into the server's
real `EventBus`, out of a real `SseStream` as real `text/event-stream` bytes, into the
browser's real `SseEventStream` and `CloudEventBus`.

It runs under **plain Node, not Electron-as-Node** — there is no `Store` and no
`better-sqlite3` anywhere on this wire, so the ABI preflight `verify-remote-ipc.mjs` opens
with would be checking something this script never touches. Its fake server is **one route,
two methods against one `EventBus`**, because that is what the service is; a harness that gave
each direction its own bus would pass with the two halves wired to nothing.

Three things it proved that no unit suite was in a position to:

- **A gap frame is the common case, not the outage case.** Coalescing two updates to one card
  is a hole by design, so the batch carries `gap: 1`, the server writes a `gap` frame with
  reason `sender`, and the browser answers with exactly one catch-up read — *without* starting
  the poll timer. The harness found this by dying on it: `CloudEventBus.catchUp` calls
  `polled.poll()` from inside the browser's read loop, and a stand-in without that method
  threw there, which took the whole SSE connection down until the reconnect. Worth knowing in
  its own right: **an exception thrown under `onEnvelope`/`onGap` costs a connection**, and the
  reconnect is what saves it.
- **The retry floor is a floor.** `SSE_RETRY_MIN_MS` clamps the server's own `retry:` up to a
  second, so a reconnect cannot be hurried by making the fake server impatient — a test that
  waited on the server's number would fail for a reason that has nothing to do with resume.
- **The listener grace is what makes a forced close survivable.** Events published while
  nobody is connected still get forwarded, because the account is inside `LISTENER_GRACE_MS`,
  and the ring replays them exactly once on the new connection.

The harness also carries a preflight against [the backtick
trap](../../apps/client/scripts/verify-remote-sse.mjs): the scenario is a template literal, so
a backtick written in prose *ends* it, and what reaches disk is a truncated file that Node
reports as a syntax error pointing at the next word. It cost two rounds here. The check reads
the script's own SOURCE, because by the time the interpolated string exists the damage is done.

#### The two root suites, extended

- `test/ipc-relay-coverage.test.ts` gained the event direction: every channel `ipc.ts`
  actually pushes is classified in `EVENT_FANOUT`, every entry corresponds to something
  pushed (with `session:gap` named as the one deliberate exception rather than filtered away),
  and no name appears in both `RELAY_POLICY` and `EVENT_FANOUT`. 5 tests → 9.
- `test/shell-parity.test.ts` gained the controls that moved into `@tm/ui` this round —
  `AddTaskDialog` and `GitGraphPane` — asserted both as imports and as the absence of a
  host-local copy. 7 tests → 10.

#### Proving each new gate can fail

Phase 26's trap applies and was worked around rather than walked into: a classification record
whose value type is *computed* dies at typecheck when you mutate one entry, which proves the
consistency gate and says nothing about the suite. So each mutation was made **in both places
that would have to agree**, the tree re-typechecked, and only then was it asked which gate went
red.

| Mutation | `pnpm typecheck` | What went red |
|---|---|---|
| A — `session:paused` added to **both** `IpcEvents` and `EVENT_FANOUT`, pushed by nothing | **green** (9/9, 0 cached) | `ipc-relay-coverage` › *pushes every event it claims to classify* and `ipcEventFanout.test.ts` › *covers exactly the event channels* |
| B — `window:maximizedChanged` reclassified `drop` → `replace-last` | **green** | `verify-remote-sse.mjs` › *window:maximizedChanged is not forwarded at all*, plus 4 in `ipcEventFanout.test.ts` |
| C — a local `apps/web/src/board/AddTaskDialog.tsx` re-added | **green** (4/4, 0 cached) | `shell-parity` › *leaves no local copy of either behind in a host tree*, and nothing else |

Mutation A is the one that earns the new exhaustiveness test its place: `send<K extends keyof
IpcEvents>` means the type system already refuses a *push* of an unclassified channel, so the
direction that is genuinely uncovered is the ORPHAN one — a classification for an event nobody
emits, which typechecks perfectly and reads in review as coverage. Mutation C is the same
argument for the parity file: a forked component compiles, renders, and is invisible to every
other gate in the repo.

Each was restored with `git checkout --` and the tree re-verified clean before the next.

#### One defect the gates could not see, fixed

`apps/web/src/board/sseEvents.ts` contained a **raw NUL byte** — the SSE grammar's "ignore an
`id` containing U+0000", written as the character rather than the escape. It compiles, it
behaves correctly, and prettier is happy with it; what it does is make **git call the file
binary**, so this round's own diff for it read `Bin 0 -> 13958 bytes` with no line-level review
and no blame. Now spelled `'\u0000'`, the way `@tm/shared/ipcEventFanout`'s `KEY_SEPARATOR`
spells the same character.

Five files predating this round carry the same raw-NUL idiom (`attention.ts`,
`gitlab/pipelineStages.ts`, `planValidate.ts`, `usageRollup.ts`, `iam/iamAuth.guard.ts`).
They are left alone and recorded here rather than swept up: it is a house idiom, changing it is
not this round's business, and a repo invariant forbidding it would demand five unrelated edits
to go green.

#### What a human still has to do

**Open a browser beside a running desktop and watch a transcript stream.** Everything above is
the circuit driven through fakes at its two edges — a fake `fetch`, a fake socket, a fake
poller. No assertion here has seen a real agent's output arrive in a real tab, and none of them
can: that needs the deployed server, a signed-in desktop actually running a session, and eyes.
The same debt the previous two rounds recorded, unchanged and not reduced by any of this.

### How it is verified

Every piece has a unit suite. What none of them covers is the circuit, so
[`verify-remote-ipc.mjs`](../../apps/client/scripts/verify-remote-ipc.mjs) drives a real
`Store` on a scratch SQLite file, a real `RelayRegistry`, `applyCloudCommand` and
`CommandQueue`, and a real `HttpTransport` over a fake `fetch` into a fake server that
imports the SERVER's own lease predicate rather than restating it. It proves a relayed invoke
round-trips, a host-only channel is refused by name before the network, a lost result is
redelivered and **replayed rather than re-executed**, ordering holds across interleaved
batches, a rejecting command does not roll back its predecessor, and `PolledEventBus`
reproduces `task:changed` from a `board:tasks` diff.

It was proven able to fail: reverting the ledger to a boolean, marking `attachment:pick`
relayable, and making the drain fire-and-forget each turn it red.

### Verification — the gates, forced, and a control that can still fail

Re-run from this worktree against `49eb017` — the branch tip **after the rebase onto
`development` (`767bda5`)**, so these numbers describe the tree that will actually be merged,
not the pre-rebase one. `--force` on the two turbo-routed gates, because Phase 25 §8.1 caught
this repo accepting a 47 ms `FULL TURBO` replay as a verification: a cached gate is not a
gate, and `0 cached` below is the part of each line that matters.

**Not on `pnpm test`, though**, and the reason is worth writing down once: the root script is
`turbo run build --filter=./packages/* && vitest run`, so the flag falls through to `vitest`,
which has no `--force` and exits on it. It needs none — `vitest run` is not cached and
executes every time.

| # | Command | Exit | Result |
|---|---------|------|--------|
| 0 | `pnpm format:check` | **0** | All matched files use Prettier code style |
| 1 | `pnpm typecheck --force` | **0** | 9 successful, 9 total — **0 cached**, 29.32s |
| 2 | `pnpm test` | **0** | 148 files passed, 1 skipped (149); 2449 passed, 11 skipped (2460), 66.07s |
| 3 | `pnpm build --force` | **0** | 6 successful, 6 total — **0 cached**, 31.152s, no turbo warning |

`format:check` is numbered 0 rather than listed as an aside because CI runs it **ahead** of
the other three: a red one blocks the merge that would otherwise cut the release, so it is the
first gate in practice whatever order a human runs it in. `check:abi` reports
`better_sqlite3.node` and Electron both at ABI 130.

The 11 skips are the two standing opt-ins and nothing new: 9 in `wslHost.test.ts` behind
`ORCH_WSL_TEST=1`, 2 in `wslSession.e2e.test.ts` behind `ORCH_E2E=1`.

**The two harnesses.** `apps/client/scripts/verify-remote-ipc.mjs` passes all 16 checks against
a real `Store` on a scratch SQLite file, and `packages/ui/scripts/verify-global-css.mjs`
reports 12 selectors in, 12 rules out, nothing dropped by Griffel and no declaration missing.
(They live in two different packages' `scripts/` directories, which is easy to get wrong from
the repo root.)

**A green harness proves nothing on its own**, so the control was re-run rather than taken on
trust from the section above — and re-aimed at the newest assertion, `task:resumeAgent`, since
that is the one this round added. It took **two** mutations to learn what actually guards it.

*Mutation 1 — flip `RELAY_POLICY`'s `'task:resumeAgent'` to `'host-only'` and nothing else.*
This never reaches a test. `@tm/shared`'s dts build dies first with
`src/ipcRelay.ts(173,3): error TS2322: Type '"host-only"' is not assignable to type '"relay"'`,
because the mapped value type computes each channel's policy from `HOST_ONLY_REASONS`, and
that channel has no reason. A stricter red than intended, and a real one — but it proves the
*consistency* gate, not the classification the tests are there to hold.

*Mutation 2 — the mistake's realistic shape:* classify it host-only in **both** lists
(`'task:resumeAgent': 'live-session'` added to `HOST_ONLY_REASONS`). That typechecks, so the
tests become the only thing standing in the way — and three of them fall:

| Suite | Case | Under mutation 2 |
|---|---|---|
| `packages/shared/src/ipcRelay.test.ts` | `task:resumeAgent relays` | **FAIL** — expected false to be true |
| `packages/shared/src/ipcRelay.test.ts` | the host-only list `is exactly that list` | **FAIL** — 20 channels ≠ 19 |
| `apps/web/src/board/httpTransport.test.ts` | `relays task:resumeAgent, because the resume happens on the desktop` | **FAIL** — rejected `"task:resumeAgent" only works in t…` instead of resolving |
| `test/ipc-relay-coverage.test.ts` | (whole file) | green throughout |

Restored by `git checkout --`: 81/81 green, tree clean. Green before, red under the mutation,
green after.

Two things that red run taught, both worth keeping:

- **`verify-remote-ipc.mjs` stayed green under both mutations.** It drives the circuit with
  its own fixture channels, so it has no opinion whatsoever about how `task:resumeAgent` is
  classified. It remains the only thing that exercises the whole relay end to end, and it is
  simply not the guard for this — the unit suites are. A harness passing is not evidence about
  a channel it never invokes.
- **`test/ipc-relay-coverage.test.ts` stayed green too**, exactly as it did for
  `attachment:pick` above. It checks that the policy record *covers* the channels, not how any
  one of them is classified. The exhaustiveness gate and the classification gate are genuinely
  two different checks, and only `ipcRelay.test.ts`'s `MUST_RELAY` list has an opinion here —
  which is why the new channel was added to that list and not merely to the record.

**Phase 25's "the six standalone runs sum to the aggregate" invariant needs an EIGHTH term
now** — the seventh added above was not enough, and re-checking it here is what found that.
Six packages plus the root `test/` directory sum to 148 files / 2435 tests against the
aggregate's 149 / 2460: still one file and 25 tests short.

| Command | Files | Tests |
|---------|-------|-------|
| `pnpm --filter claude-orchestrator test` | 69 passed, 1 skipped (70) | 1322 passed, 11 skipped (1333) |
| `pnpm --filter @tm/server test` | 18 | 101 |
| `pnpm --filter @tm/web test` | 10 | 114 |
| `pnpm --filter @tm/shared test` | 26 | 583 |
| `pnpm --filter @tm/protocol test` | 1 | 12 |
| `pnpm --filter @tm/ui test` | 19 | 268 |
| `pnpm exec vitest run test/` | 4 | 24 |
| `pnpm exec vitest run scripts/next-version.test.mjs` | **1** | **25** |
| | **149 = the aggregate** | **2460 = the aggregate** |

Two paths belong to no package, and each is reached by the root `vitest run` alone:

- the root `test/` directory — `repo-invariants`, `shell-parity`, `workflow-invariants` and
  this phase's `ipc-relay-coverage` (it was three files when the seventh term was added; it is
  four now); and
- **`scripts/next-version.test.mjs`**, which is not under `test/` at all and is the term that
  was missing. It is 25 tests covering `next-version.mjs` — the script that decides what
  version the pipeline cuts, including the RELEASE.md §2 fallback the paragraph below turns
  on. Worth knowing it is covered by exactly one command.

The general shape is the trap, not either particular file: `vitest list --filesOnly` at the
root is the only authority on what the aggregate actually collects, and anyone re-checking
this sum should derive the terms from it rather than assuming the workspace layout accounts
for every suite.

**The version.** This branch carries no bump: it was cut when `apps/client/package.json` said
`0.82.6`, and `development` has kept releasing underneath it — `0.83.1` when this paragraph
was first written, **`0.84.2`** now (tag `v0.84.2`, tip `767bda5`, which is what the branch was
rebased onto). That drift is itself the argument. Bumping here would be futile rather than
merely late: the version line is the one conflict the integration's Rung 1.5 resolves by
**taking base's side**, so any number written on this branch is dropped on the way in, and a
standalone `chore(release)` commit is the shape that rebases away with no conflict at all and
vanishes silently.

The reasoning is unchanged and only its inputs moved. After the merge the manifest reads
`0.84.2`, which is not ahead of every tag, so `scripts/next-version.mjs` takes RELEASE.md §2's
fallback and cuts **`0.84.3`** with `needsCommit=true`. Correct and collision-free — but still
a PATCH over a range that is mostly `feat:`, and still the one thing a human may want to
overrule, by bumping on `development` before the pipeline runs. Anyone reading this after
another release should re-derive the number rather than trust it: the rule is stable, the
operand is whatever `development` last shipped.

### What this leaves owed

- **A human still has to press these controls against a real desktop.** No test in this
  repo can do that: there is no DOM harness in the workspace (no jsdom, no
  `@testing-library`), so nothing here has seen a rendered pixel. `test/shell-parity.test.ts`
  says the same thing about the same board and is worth re-reading before trusting either.
  **Resume is the newest and least-observed of them**: what is proven is that the channel
  relays, that `useBoardExtras.resumeTask` invokes it and re-reads `scheduler:activeRuns`, and
  that `BoardScreen` passes `onResumeTask` — *not* that the button appears on the right card
  at the right moment, since whether `canResumeWork` says yes depends on `stoppedAt`, status
  and steps arriving intact through the mirror. Pressing Resume in a browser tab against a
  live desktop, and watching the spinner appear on that card, stays a human act.
- **`task_activity` and `attention_items` are not mirrored yet.** Both are readable over the
  relay, so nothing is missing while a desktop is polling; what is owed is reading them while
  one is not. Each costs a SQLite trigger set, an outbox discriminator, a mirror entity and
  migration, an `applyMirrorDelta` branch, `cloudDelta` byte accounting, a
  `cloudOutboxBackfill` pass and a `cloudBoardStore` ingest — and `task_activity` carries the
  full AI transcript, so the per-entity byte budget matters there more than anywhere.
- **Attachment BYTES do not cross.** `Transport.attachmentUrl` is in place, so the shared
  strip asks the host where to fetch a preview from instead of hardcoding Electron's custom
  scheme — and the web's honest answer today is `''`, which drops the thumbnail and keeps
  the chip. Making it a real URL needs an upload route, a desktop-side handler that writes
  the blob under `userData/attachments/<taskId>/` and then calls the existing path-based
  `attachment:add` (which takes paths, never bytes, by explicit design — an attachment can
  be a 30 MB video), and a download that streams it back. Adding a file FROM a browser needs
  the same three. Until then, attachments are a desktop act that the web can see the chips
  of.
- **The server has not been deployed with this schema.** `CommandResults1786800000000` adds
  `commands.ackedAt`, `command_results` and `tombstones`, and has only been read, not run.

> **Two of these are answered by the round below.** Attachment bytes DO cross now — the
> upload route, the blob store and the browser's preview are steps 9 and 10, and
> `Transport.attachmentUrl` returns a real URL rather than `''`. And the un-run schema is two
> migrations larger than that bullet says: `ClientInfo1786900000000` and
> `AttachmentBlobs1787000000000` join it, all three still only read. The other three bullets
> stand unchanged.

### The critical files, walked one by one on the finished tip (`0f8b456`)

The plan's twelfth step names twenty-two files, in six areas, as the ones this round lives or
dies on. This section is that walk. Nothing in it is carried forward from an earlier step:
every file was re-opened on `0f8b456`, and every gate re-run there rather than trusted from
the run step 11 measured on the same commit.

All twenty-two exist. **Seventeen changed on this branch; five did not** — and the five are
where the walk earned its keep, because "named critical and never touched" is either a design
working as intended or something quietly forgotten, and only reading them tells you which.

#### The seventeen that changed

| Area | File | What it had to end up as | On `0f8b456` |
| --- | --- | --- | --- |
| Relay policy | `packages/shared/src/ipcRelay.ts` | the new upload channel classified, exhaustively | ✅ `+4`: `attachment:addUploaded` → `'relay'` (:263), with the comment that a browser is its only possible caller; host-only count still **20** across the same four groups |
| Wire | `packages/protocol/src/wire.ts` | the event and blob contracts | ✅ `+280`: `EventEnvelope` (:191), `EventBatchRequest/Response` (:212/:231), `EVENT_STREAM_FRAMES` (:247), `HelloFrame`/`GapFrame`/`ByeFrame` (:273–:301), `UploadTicket`/`BlobStored`/`MediaTokenGrant` (:480–:496); `CommandKind` still the four of Phase 26 (:400) |
| Desktop | `apps/client/src/main/ipc.ts` | the `send` choke point, the `attachment:*` handlers, the engine wiring | ✅ `+122`: `send` at **:301** still the only `webContents.send` in the file, now with `cloudEvents.publish` beside it; `attachment:addUploaded` at :2345 among six handlers; `cloudEvents.configure` (:3575) and `cloudAttachments.configure` beside `cloudPoller` (:3605), both constructed **inert** at :284/:290 |
| Desktop | `apps/client/src/main/cloudPoller.ts` | carry the client's name, learn who is listening | ✅ `+35`: `getClientInfo` dep, `info` on every `SyncRequest` (:223), and `onEventListeners?.(body.eventListeners)` guarded on `!== undefined` (:272) so a server predating the channel does not read as "nobody watching" |
| Desktop | `apps/client/src/main/store.ts` | remember what the cloud already holds | ✅ `+72`: `cloudBlobAt` column, a PRAGMA-guarded `ALTER TABLE` for existing databases, `markAttachmentUploaded(id, at)` taking `null` to un-stamp |
| Server | `apps/server/src/app.module.ts` | the two new modules and three new entities | ✅ `+8`: `EventsModule`, `AttachmentsModule`, `AttachmentBlob`, `AttachmentUpload`, `Client` — all inside the `forRootAsync` factory, not the decorator literal |
| Server | `apps/server/src/mirror/mirror.service.ts` | name the desktops, count the listeners | ✅ `+52`: `clientInfoColumns` on the registration write (:100), `eventListeners: this.events.listeners(accountId, now)` on the response (:159) |
| Server | `apps/server/src/main.ts` | let octet-stream bodies through | ✅ `+10`: the "AND NOTHING ELSE" comment on `useBodyParser('json')`, spelling out that a global `express.raw()` would silently store every upload as zero bytes |
| Server | `apps/server/src/migrations/` | the two new tables | ✅ `ClientInfo1786900000000`, `AttachmentBlobs1787000000000` — picked up by `dataSource.ts`'s glob (:47), which is why nothing needed registering by hand |
| Web | `apps/web/src/board/httpTransport.ts` | push, and blobs | ✅ `+220`: `CloudEventBus` (:146/:164) fed by `SseEventStream` (:170), `hostOnlyMessage` refusal before the network (:194), `MEDIA_TOKEN_QUERY` on the preview URL (:230) |
| Web | `apps/web/src/board/polledEvents.ts` | stay the fallback, honestly | ✅ `+54`: still names what it cannot reproduce rather than hiding it — `'scheduler:changed': 'no project queues are shown in the browser'` (:123) |
| Web | `apps/web/src/board/BoardScreen.tsx` | the graph, and the real dialog | ✅ `+112`: `GitGraphPane` from `@tm/ui`, the shared `AddTaskDialog` with every field |
| Web | `apps/web/src/board/targetClient.ts` | pick a desktop by name | ✅ `+96` |
| Web | `apps/web/src/App.tsx` | the picker and the skew banner | ✅ `+38` |
| Shared UI | `packages/ui/src/transport.tsx` | one interface both hosts satisfy | ✅ `+25`: `attachmentUrl` and `attachFiles`, optional so the desktop can decline them |
| Shared UI | `packages/ui/src/TaskDetail.tsx` | notice a hole in the transcript | ✅ `+15`: the `session:gap` subscription that re-reads the record, with the note that nothing on the desktop ever emits it |
| Shared UI | `packages/ui/src/AttachmentStrip.tsx` | upload from a browser | ✅ `+86`: `transport.attachFiles` guarded on presence (:239), so the desktop's strip is unchanged |

#### The five that did not change, and which kind each is

- **`apps/client/src/main/ipcRegistry.ts` — needed nothing, and that is the design paying
  out.** This round added exactly one relayable channel, and the registry never heard about
  it: `ipc.ts`'s `handle()` records every channel it registers, so `attachment:addUploaded`
  became relayable by being written. A registry that had to be edited alongside would be the
  hand-maintained second list this file exists to not be.
- **`apps/server/src/presence/presence.registry.ts` — needed nothing, and it is checkable
  rather than assumed.** The worry worth having is that a browser on a live SSE stream stops
  polling, ages out of presence, and drops the whole account to the idle tier — slowing the
  desktop's mirror sync while somebody is actively watching. It does not happen:
  `useCloudBoard.ts` builds `BoardPoller` (:127) and `PresenceHeartbeat` (:144) as two
  independent effects, neither of which knows whether the stream is up.
- **`packages/protocol/src/cadence.ts` — every number right, the opening premise expired.**
  It said "v1 ships no realtime push channel, so the only lever for staleness is how often a
  Client polls". There is a push channel now. The policy survives the premise because the
  stream carries engine EVENTS and the mirror's ROWS still travel only on the poll — so the
  header now says that, and says why wiring the tiers to the stream's health would be a real
  change rather than a tidy-up.
- **`apps/server/src/iam/iamAuth.guard.ts` — correct for routes it had never heard of.** Its
  docstring named `MirrorController` and `PresenceController`; `EventsController` and four of
  `AttachmentsController`'s five routes now use it too. Nothing was wrong, and the reason is
  worth keeping: `actionFor` keys on the **method**, not on a route list, so `GET /v1/events`
  authorized as a read and `POST /v1/events` as a write without anybody coming back here. The
  comment now names the new routes and, more usefully, names the one route the guard never
  sees — `GET /v1/attachments/:id`, which an `<img src>` cannot put a header on and which
  therefore runs under `MediaTokenGuard` instead.
- **`apps/web/src/board/useBoardExtras.ts` — a claim that this round falsified.** It said "no
  event carries *this run started* or *this run stopped* to a browser", and justified
  re-reading `scheduler:activeRuns` with it. `EVENT_FANOUT` forwards `scheduler:changed`
  (`replace-by-key` on `projectId`), so a browser on a live stream is now told. The re-read is
  still right and still stays — a stream that is allowed to drop cannot be the thing a button's
  own feedback waits on — but it is right for a different reason than the one written down,
  and the header now gives that reason instead.

Four of the five needed nothing at all. **Three carried a sentence that had stopped being
true**, which is the failure mode a file nobody edits is uniquely prone to: no diff, no
review, no gate. All three were fixed here, comment-only — see *What this step changed* below.

#### The gates, forced, on `0f8b456`

| Gate | Exit | Result |
| --- | --- | --- |
| `pnpm format:check` | **0** | All matched files use Prettier code style |
| `pnpm typecheck --force` | **0** | 9 successful, 9 total — **0 cached**, 27.08s |
| `pnpm build --force` | **0** | 6 successful, 6 total — **0 cached**, 33.117s |
| `pnpm test` | **0** | 177 files passed, 1 skipped (178); **2925 passed, 11 skipped (2936)**, 60.90s |
| `node apps/client/scripts/verify-remote-ipc.mjs` | **0** | **16 checks**, ABI 130/130 |
| `node apps/client/scripts/verify-remote-sse.mjs` | **0** | **36 checks** |

Identical to §*Verifying the mirrored web, headlessly* in every figure that is a count, which
is the answer wanted: step 11 and this step measured the same commit, so a number that had
moved would have meant something drifted underneath rather than that anything improved.

One honest caveat about gate 4. `pnpm test` is `turbo run build --filter=./packages/* &&
vitest run`, and that prefix reported `3 cached, 3 total >>> FULL TURBO` in 66 ms. A cached
gate is not a gate — but the gate above it forced all six builds from cold, so what the cache
replayed here is a superset that had already been earned, not a claim resting on itself.

Neither harness has a `verify:*` script name; both run by path. That is the rule rather than
the omission — nine of the ten `apps/client/scripts/verify-*.mjs` are run that way, and
`verify:github` is the exception.

#### What this step changed

Three comments, and one character. `cadence.ts`, `iamAuth.guard.ts` and `useBoardExtras.ts`
each carried a statement the round had falsified, quoted above with what replaced it.
Comment-only was the deliberate bar: a walk that finds a false sentence in a security guard's
header and leaves it there has not finished, and a walk that starts changing behaviour on the
last step but one has exceeded itself.

**The character is the interesting one, because editing the guard is what exposed it.** The
moment the header above was touched, `git diff` answered `Bin 4440 -> 5118 bytes` — a change
to the file that decides whether a request may write, with no line review and no blame.
`iamAuth.guard.ts:75` holds its authorization cache key as `` `${action}<NUL>${token}` `` with
the separator written as the RAW character, which is one of the five pre-existing files
§*One defect the gates could not see* listed and deliberately left alone. That decision was
right for a step touching none of them and does not survive a step touching this one: leaving
it means this commit's own edit is unreviewable. So it now reads `\u0000`, the same spelling
`@tm/shared/ipcEventFanout`'s `KEY_SEPARATOR` uses, with a comment saying why the separator
must be a character neither half can contain.

Byte-identical in behaviour — `` `${action}\u0000${token}` `` evaluates to exactly what the
raw character did, asserted directly, and `@tm/server`'s 199 tests across 27 files pass
unchanged. **This commit's diff for the file is still binary anyway** — it reads
`Bin 4440 -> 5835 bytes`, the extra bytes being the comment — because git calls a diff binary
when EITHER side is, and the `HEAD` side still holds the NUL. It is text from the next commit
onward, the same one-time cost `sseEvents.ts` paid in step 11. Which means the honest summary
is that the fix cost this one review and buys every later one. The remaining four
files (`attention.ts`, `gitlab/pipelineStages.ts`, `planValidate.ts`, `usageRollup.ts`) still
carry the idiom and are still left alone, on step 11's reasoning, which still holds for them:
nothing here is editing them.

The gates were therefore run **twice**: the table above on `0f8b456` before any edit, and the
whole set again afterwards. Second run — format ✅, typecheck 9/9 **0 cached** 27.332s, build
6/6 **0 cached** 32.033s, `2925 passed | 11 skipped (2936)` across `177 passed | 1 skipped
(178)`, harnesses 16 and 36, all exit 0. Every count identical. That is a measurement rather
than an assumption, which is the only reason it is worth stating: a comment cannot move a test
count, so the pair proves the edits were what they claimed to be.

#### The merge this branch is heading into

`development` is **seven commits ahead** of the merge base `ef44513` — the usage-limit round
(`feat(limit): …` through `docs(limit): …`), whose manifest reads `0.85.0`. So the
integrator's rebase is not a no-op, and as in every previous round it cannot be done from
here: the rebase belongs to the integrator, and a step may not reshape the branch. What a step
can do is hand over what it found instead of the surprise.

A read-only `git merge-tree ef44513 HEAD development` produces **zero conflict markers**. Two
files are changed on both sides and git resolves both without one:

| File | Branch | `development` | Why they miss each other |
| --- | --- | --- | --- |
| `apps/client/src/main/store.ts` | `cloudBlobAt` column + PRAGMA-guarded `ALTER TABLE task_attachments` | a `parkedRuns` key/value state row | Different tables, and neither is a numbered ladder there is a slot to collide over |
| `apps/client/src/main/ipc.ts` | `cloudEvents`/`cloudAttachments` wiring, the `attachment:*` handlers | `scheduler.setUsageProbe(…)`, `scheduler.restoreParkedRuns()` | Different regions of a 3657-line file; the limit round adds no channel and no `send` |

**The check that mattered most, and it comes back clean.** `development` touches no `IpcApi`
and no `IpcEvents` member — `packages/shared/src/ipc.ts` is not in its diff at all. Had it
added one, the merge would still have shown zero conflicts and `pnpm typecheck` would have
gone **red** on this branch's two exhaustive records, `RELAY_POLICY` and `EVENT_FANOUT`. That
is precisely the failure those records exist to cause, and precisely the one a merge preview
cannot show you. Whoever rebases must re-run the gates afterwards regardless; this is the
reason to expect them to matter rather than to skim them.

**One semantic overlap, which works out.** `development` rewrote
`packages/ui/src/board/TaskCard.tsx` to badge a limited card through
`cardBadgeStatus(task, run)`, and apps/web renders that same shared card — two files that have
never been compiled together, because neither branch has both. It resolves in the web's
favour: `run` is computed *inside* `TaskCard` by
`runPhase(task, subtasks, liveRunTaskIds, mergingTaskIds)` (`TaskCard.tsx:1089`), and the web
supplies all four — subtasks via `groupSubtasks` (`BoardScreen.tsx:201`), `liveRunTaskIds`
from the relayed `scheduler:activeRuns`, the merging set from `useBoardExtras`, and every
status off mirrored rows. So the limit badge should reach the browser for free. That is a
conclusion drawn by reading, not a gate that ran, and it is the first thing to check by eye
after the rebase.

**The version, and why this round has no tell.** This branch carries **no bump**:
`apps/client/package.json` reads `0.84.5`, which is exactly the merge base's value, while
`development` reads `0.85.0`. Base equals branch, so the three-way merge takes `development`'s
`0.85.0` with no conflict and nothing lost — the *opposite* of the trap earlier rounds kept
hitting, because there is no bump here for a rebase to swallow. That is now the normal case:
CI cuts releases from `development`, so a feature branch has no business writing a version
line at all. `node scripts/next-version.mjs` run in this worktree answers `version=0.84.6 /
needsCommit=true`, which is the branch's own view against a tag list that tops out at
`v0.84.5` here; it is not what governs, and it should not be acted on from this side.

### What is deliberately out of scope

The plan's thirteenth and last step ships no feature. It writes down what this round chose
*not* to mirror, and — where the choice was resting on nothing but nobody having got round to
breaking it — makes the choice checkable.

#### Creating or editing an agent project stays on the desktop

An agent project **is** a folder on the machine the engine runs on. Everything else about one
— its name, its colour, its default model and planning model, its base branch, its execution
target, the JIRA epics it owns — hangs off a path that only that machine can name. So making
one starts at `project:pickDirectory`, a native `dialog.showOpenDialog`, and the pane that
calls it (`apps/client/src/renderer/src/AgentProjects.tsx`) is desktop-only in two independent
ways: it opens that picker, and it reaches the engine through `window.api` directly rather
than through the shared `Transport`. There is no useful half of it a browser could draw. A
path field with no picker behind it is an invitation to type an absolute path on a computer
you cannot see, and the first thing it produces is a project pointing at a directory that does
not exist.

**What a browser can still do with agent projects is most of what anyone does with them.**
Read them (`agentProject:list`, relayed, and `useBoardExtras` fetches them on every board
load); file a card under one, from the add-task dialog's Project field or the detail pane's
dropdown (`task:setProject`); assign a card to one and override that card's model and
permission mode (`task:assignAgent`, through the shared `AssignAgentDialog` that
`TaskAgentPanel` opens). The line is between *using* them and *configuring* them, and it falls
where the folder picker does.

> **Narrowed later, and only on the reading half.** "Read them (`agentProject:list`, relayed)"
> was the whole read path, and a relayed read needs a desktop awake to run it. Opened against
> one that is not polling, the browser got an empty list — no project names, no project
> colours, no Project dropdown, no picker in *Assign agent* — and read as an account with no
> projects. The list is resolved from the mirror now when the relay does not answer;
> *configuring* one is still desktop-only and the guard below still asserts exactly that. See
> [Fix — agent projects when the desktop is asleep](#fix--agent-projects-when-the-desktop-is-asleep).
>
> **And viewing one is now a pane of its own.** *Seeing what a project is configured to do* —
> its path, its models, its permission mode, its base branch, its execution target, its two
> automation switches and its epics — is in scope and shipped, read-only, as the web Settings'
> **Projects** tab (`apps/web/src/settings/ProjectsSection.tsx`). It is presentational: a list
> in, markup out, with no transport call and no `window.api` in it, which is the whole of what
> makes it read-only, since the write channels would relay perfectly well. **Creating, editing
> and removing stay desktop-only**, for the folder-picker reason below and no other. The guard
> block asserts both halves now, and is retitled *agent projects: the web reads them and does
> not configure them* for it.

**Where the boundary actually holds, in four places, only two of which were load-bearing
before this step:**

| Layer | What it does | Was it holding? |
| --- | --- | --- |
| `RELAY_POLICY` | `project:pickDirectory` / `:pickFile` are `host-only`, so `httpTransport` refuses them before the network and names the reason from `hostOnlyMessage` | yes — asserted by `httpTransport.test.ts`'s host-only cases |
| The engine | `ipcRegistry.ts` refuses a host-only channel that arrives over the wire anyway | yes — the browser's refusal is a courtesy, this one is the guarantee |
| The web's UI | nothing under `apps/web/src` calls an `agentProject` write | **it was true, and nothing said so** — now `shell-parity.test.ts` |
| The Settings card | "Set these from the desktop app" names *Agent projects* and why | **it was there, and nothing kept it there** — now asserted too |

**The one thing that is deliberately NOT a wall.** `agentProject:add`, `:update` and
`:remove` are classified `'relay'`, not `'host-only'`, and this step leaves them that way on
purpose. Executed on the desktop they are ordinary store writes — none of the four
`HostOnlyReason` groups applies, and inventing a fifth ("needs a path only that machine can
name") would reclassify `project:add` and half of `project:*` along with them, on the last
step of a round, for a hole nothing is falling through. The honest description is therefore:
*the channels would work; there is simply no browser code that calls them, by decision.* Which
is exactly the sort of fact that stays true until somebody adds a form in good faith — hence
the guard, whose failure message says the decision is a plan change rather than a patch.

**What reversing it would cost**, so the price is on the table rather than discovered: a
directory *browser* served by the desktop (list a path's children over the relay, since the
browser cannot enumerate a remote disk and `showOpenDialog` cannot be relayed without wedging
the serial command drain behind a modal on somebody else's screen), a validation round trip so
a typed path fails in the dialog instead of at first run, `AgentProjects.tsx` ported off
`window.api` onto `Transport`, and `useGitPreflight` reachable from a browser. None of that is
hard; all of it is a phase, not a step.

#### Merging and releasing were never this branch's to do

No step in this round merged anything or cut a release, and this one does not either. Both
belong to the orchestrator, from the project's own checkout: a step runs in a shared worktree
on `feat/mirror-all-interactions-features-to-web`, and a step that rebased or merged would be
reshaping the branch its eleven siblings are standing on. Step 12 did the part a step *can*
do — read `git merge-tree` and hand over what it found (zero conflict markers, two files
changed on both sides that miss each other, and the `IpcApi`/`IpcEvents` check that would have
gone red on a merge no preview shows as a conflict). Since v0.83.x, CI cuts the release from
`development` after the merge lands, which is also why this branch carries no version bump and
must not grow one.

#### Three sentences that were false, and one that was true in only one host

Step 12's walk found that the files nobody edits are where stale prose survives. This step
found the same failure in the files that *state* the decision it is recording — and one of
them was the decision's own header.

- **`apps/web/src/settings/SettingsScreen.tsx` said `AgentProjects` was shared from
  `@tm/ui`.** It never has been: it is not in `packages/ui/src`, and by the reasoning above it
  cannot be. The header now names it as the one section deliberately *not* shared, and says
  which two things make it desktop-bound.
- **The same file's "Agent projects" card said "every other field on an existing agent project
  is editable from a card's detail pane".** Nothing of the sort is: the detail pane edits the
  **card** — which project it is filed under, its model, its mode — and no field of a
  *project* is reachable from a browser at all. `agentProject:update` has exactly one caller
  in the repo and it is the desktop pane. The card now says what is true, and, more usefully,
  says what you *can* do from there.
- **`packages/ui/src/AssignAgentDialog.tsx` sent everyone to "Settings → Agents".** True on
  the desktop. In a browser it is a dead end: the web's Settings has no Agents section, by
  this very decision — it has a *Desktop only* tab that explains the absence. This dialog
  renders in **both** hosts (`TaskDetail` → `TaskAgentPanel`), so its empty state now names
  the desktop app explicitly. It is the smallest change here and the one a user was most
  likely to hit, because the empty state is what a new installation shows.

#### How this step is verified

The guard is three assertions in `test/shell-parity.test.ts`, in a block that was called *the
one configuration the web deliberately does not mirror* and is now called *agent projects: the
web reads them and does not configure them* (it grew two more assertions when the read-only
Projects tab shipped — see the fix section below) — the inverse of everything else in that
file, which is why it belongs there: parity has exactly one deliberate hole, and a hole
nothing asserts is indistinguishable from an omission. It scans non-test sources under
`apps/web/src` for an `invoke('agentProject:add'|…)` or a picker call (a *call*, matched as
`invoke\(\s*'…'`, because both files legitimately discuss those channel names in prose), it
refuses an `AgentProjects` pane under `apps/web/src` or `packages/ui/src` while asserting the
desktop's own is still where it says it is — so an empty result means "nowhere else" rather
than "walked the wrong tree" — and it holds the Settings card in place.

Written red-first, as that file's header requires. Each was run against a mutant and confirmed
to fail with the message it is supposed to produce: a web source calling `agentProject:add`, a
web source calling `project:pickDirectory`, an `AgentProjects.tsx` planted in `packages/ui`,
and the card's title edited out. All four mutants were removed before the gates below.

| Gate | Exit | Result |
| --- | --- | --- |
| `pnpm format:check` | **0** | All matched files use Prettier code style |
| `pnpm typecheck --force` | **0** | 9 successful, 9 total — **0 cached**, 26.80s |
| `pnpm build --force` | **0** | 6 successful, 6 total — **0 cached**, 31.11s |
| `pnpm test` | **0** | 177 files passed, 1 skipped (178); **2928 passed, 11 skipped (2939)**, 61.54s |
| `node apps/client/scripts/verify-remote-ipc.mjs` | **0** | 16 checks |
| `node apps/client/scripts/verify-remote-sse.mjs` | **0** | 36 checks |

**2928, against step 12's 2925 — exactly the three assertions added here, and nothing else
moved.** That is the number worth reading: the other four edits are comments and user-facing
strings, which cannot move a test count, so a fourth new pass or a single disappearance would
have meant this step did something it did not intend to.

One note on `format:check`, since this step is mostly prose. Its glob is `apps/**/*.{ts,tsx}`,
`packages/**/*.{ts,tsx}` and `*.{json,md}` — root-level markdown only. So neither `test/*.ts`
nor `docs/plan/README.md` is covered by it: `test/shell-parity.test.ts` was prettier-clean
before this step and the new block was written into it unformatted, which nothing would have
caught, and it was formatted with `npx prettier --write` on that file alone. `docs/plan/
README.md` has never satisfied Prettier and is deliberately left that way — reformatting a
5,500-line document to satisfy a check that does not read it would bury this step's own diff.

---

## Fix — the cloud web does not connect to the desktop app

**The report.** A browser signed in to the cloud shows the board and says *No desktop app has
ever synced this account* (or *Desktop app offline — edits are queued*), while the desktop app
is running on the other machine and its own **Settings → Cloud → Test connection** answers
*"Connected. The server recognises this account."*

**Why both of those can be true at once.** They are answers to different questions, and the
probe was answering the easier one. A desktop becomes *reachable from a browser* by
**writing**: `POST /v1/sync` is the only request that registers its presence, and
`BoardResponse.clients` — built from that in-memory presence map — is the only reason a
browser has a `targetClientId` to address a command to. The probe stopped at `GET /v1/board`
answering 200, which proves this machine can **read** and nothing else. Three separate faults
live in the gap, and every one of them printed that same "Connected":

1. **Cloud sync switched off.** `CloudSettings.enabled` is the poller's master switch and it
   is off out of the box. With it off nothing is ever mirrored and no presence is ever
   registered — while the address, the sign-in and the account's access are all perfect.
2. **An account granted `read` but not `write`.** `IamAuthGuard.actionFor` authorizes per HTTP
   method: a GET is a read, everything else a write. A grant with only `read` lets both
   clients fetch a board and 403s every single `POST /v1/sync`, silently, forever — the poller
   counts the tick, backs off and retries.
3. **A server that took the sync and does not list the machine.** Presence is an in-memory map
   per server process (deliberately — Phase 25's cost model refuses a write per poll), so a
   second replica answers the browser's board read from a map that never saw this desktop.

So the ladder in [`cloudTestConnection.ts`](../../apps/client/src/main/cloudTestConnection.ts)
now ends where the ticket does — *can a browser signed in to this account see THIS machine and
send it a command* — and each new rung names the person whose problem it is. Address →
sign-in → **the master switch** → **this machine's own `POST /v1/sync`** → **its id coming back
in `BoardResponse.clients`**.

Two details of that ladder are load-bearing rather than tidy:

- **The switch is checked after the sign-in and before the sync.** After, because "reachable
  and signed in" is worth confirming in the same breath as "and still switched off". Before,
  because the sync **registers presence**: probing with the switch off would put this machine
  in every browser's client list for the next ninety seconds and invite commands that nothing
  is ever going to poll for.
- **The probe's sync is a real one, so it takes real commands with it.** `POST /v1/sync`
  *leases* what it delivers, so a probe that dropped a batch would delay a browser's click by
  a full five-minute lease. It hands whatever it collected to the same serial drain the poller
  uses. It sends empty deltas, no acks and no results, and discards the cursor, so the outbox,
  the ledger and the stored cursor are untouched.

### The other half: a healthy desktop that is invisible anyway

`BACKOFF_CAP_MS` was five minutes, and it is the number that decides **how long a client stays
missing from the board after an outage has ended**. Past `PRESENCE_TTL_MS` a Client has dropped
out of `BoardResponse.clients`; the browser then draws its stale banner, has no target it can
prove is live, and stays that way for the rest of the backoff while the desktop it is
complaining about sits there perfectly well, waiting out a timer set by a blip that is over.

That window is not hypothetical. **Every deployment restarts the API**, which both fails
whatever tick was in flight and erases the presence map — so a routine deploy cost every
desktop up to five minutes of invisibility. And the two ends recover asymmetrically: a
browser's poll is pulled forward the moment its tab is focused (`BoardPoller.onFocusChange`)
and the human *is* in the browser, so the tab comes straight back and the desktop nobody is
touching does not.

The cap is `PRESENCE_TTL_MS` now, and it is applied **after** the jitter rather than before —
jittering a capped value pushed it back over the cap by up to `jitterRatio`, which was harmless
while the cap was an arbitrary five minutes and is not now that it means "and therefore still
visible to a browser". What the cap was protecting against is unchanged in kind: one request
every ninety seconds per client, against a product whose cost model is written around a 2.5s
active tier.

### And the sentence the browser shows

`StaleBanner`'s advice was *"Sign in and open the desktop app at least once before editing from
here"* — the one instruction that does not work, because the app being open is not what makes
it visible. It now points at where the answer actually lives: **Settings → Cloud → Test
connection** on the desktop, which after this fix walks the whole chain and names the rung.

### What is deliberately not in this fix

- **No change to the presence map's home.** Moving presence into SQL would make it survive a
  restart and a second replica, and it would put a write on every poll at the active tier's
  2.5s — the exact write amplification Phase 25 costed out and refused. The probe *reports*
  the multi-replica symptom instead, which is a deployment fact (`docs/09` already pins the
  single replica the SSE stream needs) rather than something the client can fix.
- **No automatic "turn cloud sync on for me".** The switch is off by default on purpose: this
  app mirrors a private board to a server the user chose. A probe that flipped it would be
  making that decision for them; naming it is the whole of what was missing.
- **No new test harness for `registerIpcHandlers`.** Same answer as the JIRA fix above: the
  decision moved into a pure module that already has one, and what is left in `ipc.ts` is the
  four values it passes.

### What it actually was: a session that had ended, and an app that could not tell

v0.86.2 shipped the ladder above and the browser still showed nothing. The evidence that
settled it was gathered rather than guessed, and it is worth recording because it eliminated
every layer in one pass:

- **The desktop's own SQLite** (a read-only snapshot): cloud enabled, correct URL, refresh
  token on file, `cloud.cursor` advanced, and — the telling one — **`cloud_outbox` empty while
  the app was actively writing rows**. The outbox is trigger-filled and pruned only after a
  *successful* sync, so it had drained seconds earlier. The desktop was syncing perfectly.
- **The server's SQL database**: one real account, `422` task mirrors (421 on `personal`),
  6 project mirrors, `data` intact as `nvarchar(max)`, and the newest row was *this ticket's
  own card*, mirrored seconds before. The client row read `WDEMBINS-DESKTOP · win32 · v0.86.2`.
- **The relay**: 1,125 commands, **0 unacked**, delivered in ~1s, 445 results `ok=True`, from
  three browser sessions — all under that same account. So the browser had been authenticating
  as the right account and driving the desktop successfully.
- **The API log**: no errors at all. **The last command from any browser: 08:35 that morning.**

Nothing was wrong with the desktop, the server, the data, the account or the relay — and the
web's own board filter would have passed 421 of those rows. The status bar said **"first sync
pending"**, which was the whole answer: no board read had *ever* come back in that tab.

`CloudAuth.isSignedIn()` is *"a refresh token string is in `localStorage`"*, and `useCloudAuth`
read it **once, at mount, and never again**. vipper.iam rotates refresh tokens on every use and
a replayed one revokes the family — something two tabs can do to each other without anybody
doing anything wrong, and three sessions were on this account. After that, `getAccessToken()`
returned `null` forever behind a `console.warn`, every poll threw *"Not signed in to
vipper.iam"*, and the app went on rendering as fully signed in over an empty board.

Three changes, and the first is the one that matters:

1. **A refused grant ends the session.** `@tm/shared/iamPkce` now throws a typed
   `IamTokenError` carrying the OAuth2 `error` code, and `isDeadGrant` is the single shared
   rule: `invalid_grant` or `invalid_client` means the stored token can never work again;
   **everything else — a network throw, a 5xx, a 429, an HTML body from a proxy — stays
   transient**, because signing somebody out when their wifi blipped would be a worse bug than
   this one. On a dead grant the web discards the token and fires `onSessionEnded`, and
   `useCloudAuth` puts the sign-in screen back up carrying the reason.
2. **A failing board read says so.** `UnreachableBanner` outranks `StaleBanner`, and the
   status bar says *"not syncing"* instead of *"first sync pending"* forever. This half is
   cause-agnostic and would have answered the question on day one whatever the reason: the old
   pairing printed *"No desktop app has ever synced this account"* — blaming a machine that was
   working — when the truth was that this tab had not heard from the server at all.
3. **The desktop's twin.** `getCloudAccessToken` clears a dead token too, so Settings' "Signed
   in." and `cloud:testConnection`'s sign-in rung stop making the same false claim.

**Notes.**

- No release step: per `RELEASE.md` rule 5 the tag is cut once this reaches `development`, and
  since v0.83.x CI cuts it — so this branch carries no version bump and must not grow one.
- Owed, and only a human with both ends running can retire it: pressing **Test connection**
  against the live service and confirming the verdict names the machine, plus the browser's
  banner read on a real account.

| Gate | Exit | Result |
| --- | --- | --- |
| `pnpm format:check` | **0** | All matched files use Prettier code style |
| `pnpm typecheck --force` | **0** | 9 successful, 9 total — **0 cached**, 34.07s |
| `pnpm build` | **0** | 6 successful, 6 total |
| `pnpm test` | **0** | 177 files passed, 1 skipped (178); **2973 passed, 11 skipped (2984)**, 62.21s |

**2973, against 2958 before this fix — exactly the fifteen assertions added here.** Eight are
the first round's (the probe's new rungs, `cloudTestConnection.test.ts` 8 → 14; the cap's,
`cadence.test.ts` 12 → 14) and seven the session round's (`iamPkce.test.ts` 9 → 13,
`cloudAuth.test.ts` 11 → 14). Nothing else moved: the remaining edits are comments, user-facing
strings and documentation, none of which can change a test count, so a sixteenth pass or a
single disappearance would have meant this touched something it did not mean to.

**Four classifications, each proven red-first by mutation**, and in every case exactly the
test written for it failed with the message it is supposed to produce:

| Mutant | Test that caught it |
| --- | --- |
| `listed` forced true | *reports a sync the server took but did not turn into a connected client* |
| the master-switch rung disabled | *names the master switch, and writes nothing while it is off* |
| `isDeadGrant` widened to every `IamTokenError` | *calls everything else transient* |
| `endSession` stops clearing the token | *ends the session when vipper.iam refuses the grant* |

The third is the one worth the trouble: it is the "sign you out when the wifi blips" bug, and
it is a mutation that looks *more* thorough than the real rule. The mutants were removed before
the gates above.

---

## Fix — three cards the web never saw

**The report.** Three cards — *Add button to Create PR/MR*, *Add user details page*, *Budget
schema plan and implementation* — were on the desktop board and absent from the web one.

**What it actually was.** Not a filter, not a selector, not the paging on `GET /v1/board`.
The desktop's push had been failing for a day. `POST /v1/sync` was building a
**10,427,787-byte** body every tick and the server was refusing it `413 Payload Too Large`;
nothing was marked sent, so the next tick rebuilt the identical body. Forever.

The body was not the board. `SyncRequest.results` — the answers to relayed `ipc-invoke`s —
was read straight out of `cloud_applied_commands` and put on the wire **uncapped and
unbatched**. A browser tab had asked for a card's activity timeline about thirty times in one
burst; each answer was a few hundred kilobytes of timeline JSON, and all 36 of them went into
every request. `SYNC_BYTES_LIMIT` did not help: it bounds the **entities**, and the entities
in those requests were one 15 kB task. The 413 handler did not help either — it halves
`batchLimit`, which is an entity count, so the client dutifully shrank the 15 kB half of a
10 MB request until it was sending one entity, and stayed wedged.

Everything downstream stopped with it. The outbox stopped draining, so the three cards, all
created *after* the wedge, were never mirrored at all — the server has no row for them, which
is exactly what a web board with no card looks like. They were noticed because they were new;
every other card on that board was simply frozen at its last pre-wedge state.

**The evidence, in the order it settled the question** (the sweep in
[[a-session-that-had-ended]]'s terms, all read-only, ~20 minutes):

1. A snapshot of `%APPDATA%\claude-orchestrator\orchestrator.db` (+`-wal`, `-shm`) read under
   `ELECTRON_RUN_AS_NODE=1` — all three cards present, `projectId = 'personal'`,
   `archivedAt IS NULL`, so both `selectBoardTasks` and the web's `selectBoardTasks` selector
   should draw them.
2. `cloud_outbox`: 139 rows over 22 tasks, oldest `seq` 1535 — the `insert` for *Add user
   details page*. A trigger-filled log that pruning empties on every success does not hold
   eleven hours of writes unless nothing has succeeded.
3. `cloud_applied_commands WHERE resultSentAt IS NULL`: **36 rows, 10,382,246 bytes**, all
   applied inside one 300 ms burst. That is the body, to within the framing.
4. `logs/main.log`: `cloud sync batch over the byte cap: 1 entity, 10427787 bytes` followed by
   `413`, on repeat. The log line had been printing the diagnosis all along — "1 entity" and
   "10 MB" in the same sentence is the whole bug — and it was never read.

**The fix.** [`cloudResults.ts`](../../apps/client/src/main/cloudResults.ts), a pure module
that is to `SyncRequest.results` what `cloudDelta.ts` is to the entities: pack oldest-first
within a byte budget, always at least one, and let the rest wait for the next tick.

Its second rule is the one that matters, and it is deliberately *not* `cloudDelta`'s. An
oversized task row is sent anyway, because a task row is durable state and dropping it would
lose the card. An oversized **result** is replaced by a truthful `ok: false` error, because it
is one browser interaction's return value: a body no hop will accept means the promise waiting
on it never resolves either way, and carrying it forever costs every answer and every card
queued behind it. Replacing it settles the promise, retires the row, and lets the queue move.

Three smaller things ride along, each closing a way the same shape could recur:

- **A 413 now halves both budgets.** The body is entities *plus* answers; shrinking one while
  the other stays whole converges on a request that is still too large.
- **The budget and the hard cap are separate parameters.** A shrunken budget only ever
  *defers* an answer; only the fixed cap can *replace* one. A transient 413 must not start
  discarding results that were perfectly sendable a minute ago.
- **A wedge says so.** When a 413 arrives on a request that is already one entity and one
  result, there is nothing left to halve — the client logs that in those words, instead of
  leaving a bare 413 to be read as a hop being difficult.

Nothing needs unwedging by hand: the next tick after this ships sends the backlog in ~1 MB
slices, and the outbox drains behind it.

**What is deliberately not in this fix.**

- **A larger `CLOUD_BODY_LIMIT`.** The server's 8 MB backstop is not the fault — an unbounded
  client will exceed any number picked here, and raising it only moves the wedge. The bound
  belongs at the one place that can split work across ticks, which is the client.
- **Rate-limiting the burst that made 36 identical timeline requests.** Real, and a different
  bug: even one legitimate answer must not be able to wedge the mirror, which is what this
  change guarantees. Left for whoever looks at why the tab asked thirty times.

**Verification.** `cloudResults.test.ts` covers the packing, the always-one rule, the
replacement, and the defer-don't-destroy split; two `cloudPoller.test.ts` cases reproduce the
real wedge (36 × 300 kB) and assert the request that comes out is bounded and that only what
went out is marked sent. Both poller cases were run against a mutant — `boundCloudResults`
called with an unbounded budget — and fail there, which is the old behaviour exactly.

| Gate | Exit | Result |
| --- | --- | --- |
| `pnpm format:check` | **0** | All matched files use Prettier code style |
| `pnpm typecheck --force` | **0** | 9 successful, 9 total — **0 cached**, 31.67s |
| `pnpm test` | **0** | 178 files passed, 1 skipped (179); **2979 passed, 11 skipped (2990)**, 67.68s |
| `pnpm build --force` | **0** | 6 successful, 6 total — **0 cached**, 39.42s |

Run on the **rebased** commit, not the one first written: `development` had moved on to
v0.86.2 underneath this branch, so the pre-rebase run measured a tree nobody will merge. Of
those 2979, eleven are this branch's — the nine `cloudResults` cases and the two added to
`cloudPoller.test.ts`. Nothing else in the diff is a test, so that is the whole delta.

No version bump, per `RELEASE.md` rule 5 and the two PRs before this one: CI cuts the tag when
this reaches `development`. A bump written here is a guaranteed conflict on the version line
against whatever the pipeline released in the meantime — this branch carried one to 0.86.3 and
it collided with `development`'s 0.86.2 on the first rebase.

**What no test here covers, and cannot.** That the live install actually unwedges. Nothing
was launched (`RELEASE.md` rule 6) and the desktop's copy of this code is the packaged one, so
the sequence a person will see — update, next tick sends ~1 MB of the backlog, the outbox
drains, the three cards appear on the web board — is owed as live verification. What *is*
established is that the queue those cards are stuck behind can no longer build a request the
server refuses.

---

## Fix — agent projects when the desktop is asleep

**Goal.** The web board draws agent projects in five places — a card's project name and its
project colour (`BoardScreen.tsx:155`/`:157`), the Project dropdown in the detail pane
(`TaskDetailsCell.tsx`), the picker in *Assign agent* (`AssignAgentDialog.tsx`), and the
add-task dialog's Project field — and every one of them reads the single relayed
`agentProject:list` that `useBoardExtras` fires on board load. A relayed read needs a desktop
awake to run it. Against one that is closed, asleep, or simply not polling, that call does not
even fail fast: it waits out `RPC_TIMEOUT_MS` — three minutes (`httpTransport.ts:100`) — and
then rejects, and `useBoardExtras`'s deliberately silent `load` swallows the rejection and
leaves the list `[]`. All five controls then render their empty state, which reads as *an
account with no projects* rather than as *a desktop that is not answering*.

The rows have been in the browser the whole time. `GET /v1/board`'s `deltas.projects` land in
`cloudBoardStore`'s `state.projects`, mirrored whole from the desktop's `projects` table by
`buildMirrorDelta` with no filtering of any kind, and `BoardScreen` already holds them
(`BoardScreen.tsx:141`) for its own empty-state check. This round resolves the agent projects
from those rows when the relay has nothing to say.

### Decisions taken

Four, taken before any code, because each is something a reviewer would otherwise have to
infer from a diff — and two of them are choices whose *opposite* is the more obvious reading.

**Relay wins when it answered; the mirror is the fallback.** Not a per-id merge, and not a
union. Each source is internally consistent and a hybrid list would match neither: a live
desktop's `agentProject:list` is authoritative *including its deletions*, so a project removed
a moment ago is absent from that answer and still present in the mirror until the next sync
lands — a union resurrects it, and resurrects it in a dropdown a human is about to file a card
under. With no answer, the mirrored rows are what the account knows, which is the whole of
what this browser can honestly say.

Which way round they apply matters as much as which one wins, and it is the reason the fix is
not "fall back on the rejection". The relay's silence costs three minutes; a fallback applied
only after the timeout would leave the board projectless for exactly as long as the bug does
today. The mirrored rows are what the list holds *first*, and the relay's answer replaces them
if and when it arrives.

**Only `kind === 'agent'`**, matching the desktop handler (`ipc.ts:772`) exactly — that
handler is `store.listProjects().filter((project) => project.kind === 'agent')` and this is
the same predicate over the same rows, which is the point. The mirror carries every `projects`
row the desktop has: the Personal board (`kind: 'plan'`, from the column's own default at
`store.ts:916`), legacy plan projects, and `kind: 'ticket'` projects. None of those is what
either host means by an agent project — the Personal board is the card list this board *is*, a
plan project comes with a queue the Projects tab owns, and a ticket project has no directory
at all — and neither host lists them. Filtering by anything other than the kind (by "has a
`path`", say) would be exactly the test-by-elimination that `isPlanProject`'s comment in
`packages/shared/src/model.ts` already argues against: correct only until the next kind exists.

**Read-only means read-only.** No web code calls `agentProject:add|update|remove` or
`project:pickDirectory|pickFile`; those stay guarded by `test/shell-parity.test.ts`'s block
*the one configuration the web deliberately does not mirror*, and this round adds nothing to
that surface. The decision is *narrowed* — viewing the list is in scope now, and was already
in scope whenever a desktop happened to be awake — rather than reversed, so the guard block
and Phase 26's "What is deliberately out of scope" are both **edited** to say which half moved
and which did not. Deleting either would turn a deliberate hole back into an omission, which
is the failure that block exists to prevent. The Settings card's own wording ("What you can do
from here is use them") needs no change: using them is precisely what this fixes.

**No version bump on this branch.** Since v0.83.x, CI cuts the release from `development`
after the merge lands ([`docs/11-ci-cd-pipeline.md`](../11-ci-cd-pipeline.md)), so a feature
branch has no business writing a version line at all — Phase 26 said the same thing about
itself above. A bump written here is not merely redundant: when the branch and `development`
end up agreeing on the number, the three-way merge drops it with **no conflict and nothing
red**, and a branch that "released itself" on paper released nothing. `scripts/next-version.mjs`
run from this worktree answers against a tag list that is not the one that governs, and should
not be acted on from this side.

### Resolving the list, and showing it

**One selector, beside the board's other two.** `selectAgentProjects(mirrored, relayed,
relayAnswered)` in `apps/web/src/board/boardSelectors.ts` is the whole of the first decision as
code: `relayAnswered` picks the source, `kind === 'agent'` filters *both* branches so the shape
is the same either way, and the result is ordered by `name` (then `id`, to break a tie the same
way every time) so the list does not visibly reshuffle when the relay's answer arrives and
replaces the mirror's. It is pure, which matters here more than usual: this workspace has no
jsdom and no `@testing-library`, so a pure function plus `boardSelectors.test.ts` is the only
place any of this can actually be *proved* rather than eyeballed.

The flag it turns on is `BoardExtras.agentProjectsLoaded`, set **only** on the successful branch
of `useBoardExtras`'s `load()`. The hook's fail-soft `catch` is deliberately silent and leaves
it `false`, which is exactly the distinction the whole fix rests on: *loaded and empty* means
this account has no agent projects, *nobody was home* means the mirror is the better answer.
Reading emptiness instead of the flag would resurrect every deleted repo the moment a desktop
went quiet.

`BoardScreen` computes the list once and hands the same array to all five sites that used to
read `extras.agentProjects` — `agentNameOf`, `projectColorOf`, `TaskDetail`'s `agentProjects`,
`GitGraphPane`'s `projects` and `AddTaskDialog`'s `projects` — so a card's stripe, the pane's
Project dropdown, the commit graph and the add dialog can never disagree about which repos
exist. Nothing downstream changed: the stripe is still `TaskCard`'s `projectNotch`, and the
writes those lists sit behind (`task:setProject`, `task:assignAgent`) still relay and still
refuse honestly.

**The Projects tab** (`apps/web/src/settings/ProjectsSection.tsx`) is the read-only half of the
desktop's pane. It shows what the desktop's list card shows *plus* what only its edit drawer
shows — base branch, execution target, the auto-merge tri-state, auto-release — because there
is no drawer here and no plan for one, so a fact that lives only in the drawer would be a fact
this host cannot see at all. The words are the desktop's own (`PERMISSION_MODE_LABELS`,
`modelCaption`, `execTargetLabel`) rather than a second vocabulary for the same settings.
`SettingsScreen` keeps its own single `agentProject:list` read — one call, on a screen that
unmounts when you leave it, rather than a second copy of `useBoardExtras`'s eight — and
resolves it against the mirrored rows `App` passes down with the same `selectAgentProjects`.
Its empty state distinguishes *no projects yet* from *nothing has synced yet*.

### How the projects surface is verified

No DOM harness exists in this workspace, so the proof is the pure selector, the structural
guards, and the gates — the same shape `test/shell-parity.test.ts`'s own header argues for.

- **The selector**, in `apps/web/src/board/boardSelectors.test.ts`: the mirror-only fallback,
  the relay winning once it answered, an answered-but-empty relay yielding `[]` *and not the
  mirror*, non-agent kinds dropped on both branches, the ordering stable across the swap, the
  name tie broken by id, and the relayed array not sorted in place (it is React state held in
  `useBoardExtras`, and sorting it there would be a mutation nothing would report).
- **The guards**, in the block retitled *agent projects: the web reads them and does not
  configure them*. `AGENT_PROJECT_WRITE` and `NATIVE_PICKER` still match no non-test source
  under `apps/web/src` — those two are the whole of "read only", since the write channels relay
  and neither `RELAY_POLICY` nor `pnpm typecheck` would stop a browser calling them. Two new
  assertions say the read-only view exists and is rendered from `SettingsScreen`, and that it
  contains no `transport.invoke(` and no `window.api` — the cheapest structural statement of
  "presentational, therefore read-only". The `title: 'Agent projects'` assertion survives; the
  entry's wording changed, not its existence.
- **Red before green.** The new selector tests were run against an inverted `relayAnswered`
  branch and went red before it was restored, so they are testing the predicate rather than
  agreeing with it.

---

## Fix — Sync error

**Goal.** A cloud sync that currently fails opaquely — a 401 dropped on the floor, a
`refreshTokens` error string nobody can tell `invalid_grant` from a 503, a board that pages
silently and can render an incomplete list as if it were the whole one — becomes a sync that
recovers what it can and tells the truth about the rest, without a DOM harness to lean on for
any of it.

### Verified facts this rests on

Every claim the plan was built on was re-read against this worktree before anything downstream
gets to assume it. All four hold exactly as stated; nothing here needed correcting.

- **Paging already round-trips.** `BoardResponse.hasMore` (`packages/protocol/src/wire.ts:368`)
  is populated in `MirrorService.rowsSince`'s caller — `hasMore: tasks.hasMore ||
  projects.hasMore || deletions.hasMore` at `mirror.service.ts:242`, itself built from the
  per-page `{ rows, hasMore }` `rowsSince` returns at `mirror.service.ts:355-377` — and read on
  the other end at `BoardPoller.ts:143` (`this.catchingUp = body.hasMore === true`), which is
  what makes the next poll immediate instead of waiting out a cadence. **No server or protocol
  change belongs in this fix.** Whatever step exposes progress to the UI reads `catchingUp`,
  it does not invent a new signal.
- **The guard's two failure codes are set at the framework level, not by convention.**
  `iamAuth.guard.ts:60` throws `UnauthorizedException` (401) for a missing bearer token,
  `:70` for one IAM introspects as inactive, and `:93` throws `ForbiddenException` (403) when
  IAM's `authorize` call comes back disallowed. Nest resolves guards via `canActivate` before
  the route handler ever runs (`mirror.controller.ts:37`'s `@UseGuards(IamAuthGuard)` covers
  `@Post('sync')` at `:41`), so a 401'd `POST /v1/sync` never reached `MirrorController`'s
  body-handling at all — the request can be replayed verbatim once a fresh token exists. A 403
  means IAM said no to this subject for this action; retrying the same request changes nothing,
  and any retry logic must not treat the two alike.
- **`refreshTokens` fails through one shared, unstructured throw.** Both `exchangeCodeForTokens`
  and `refreshTokens` (`packages/shared/src/iamPkce.ts:107-116`) funnel through the same
  `postToken` (defined at `:119`); its error path is `:129-136`, and the actual `throw` —
  `` `vipper.iam token request failed (${res.status} ${detail})` `` with `detail` as `res.text()`
  read raw, no JSON parse — is at `:136`, seven lines past the function's own opening (the plan
  cites `:119` for the function, not the throw; worth the seven-line correction since a later
  step edits this exact line). There is today no way to tell `invalid_grant` (refresh token is
  dead, re-authenticate) from a `503` (transient, retry) except by parsing that string.
  `iamPkce.test.ts:120` asserts `.rejects.toThrow(/token request failed \(400/)` against
  `exchangeCodeForTokens` — **that substring must survive** whatever structure gets added around
  it; the fix is additive (a typed error / status code alongside the message), not a rewrite of
  the message itself.
- **There is no DOM harness in this workspace, and that is a standing, deliberate decision.**
  `test/shell-parity.test.ts:5-8`: "no jsdom, no `@testing-library`... adding one is a
  workspace-wide decision that the v0.82.0 branch deliberately left outside its scope." Any gate
  logic this fix adds — what counts as "syncing," when the board curtains, when a retry is
  attempted — has to be a plain exported function with its own `.test.ts`, not something proven
  by rendering. The one available precedent for testing a main-process module without a
  renderer is `iamSignIn.ts`'s own rule, stated in its header (`apps/client/src/main/
  iamSignIn.ts:8`): "Electron-free by design (no `import('electron')`)... testable with a real
  loopback server and `fetch`." Anything this fix adds to the token-refresh path on the desktop
  side should hold to the same rule, for the same reason — it is what lets it run under vitest
  at all.

### The critical files, walked one by one on the finished tip (`13ca41c`)

Step 9's table names twelve files across three areas — the shared token-error grammar, the
desktop's single-flight minter and its call sites, and the web's own copies of the same two
ideas (single-flight token, sync-progress gate). All twelve were re-opened on `13ca41c`, and
all three gates re-run there rather than trusted from whatever step last measured them on the
same commit.

All twelve exist, and all twelve changed on this branch — unlike the wider Phase 26 round this
convention comes from, this fix has no file the plan named as critical but left untouched, so
there is no "unchanged, and which kind" list here.

| File | What it had to end up as | On `13ca41c` |
| --- | --- | --- |
| `packages/shared/src/iamPkce.ts` | `IamTokenError`, `isTerminalGrantError`, error-body parsing, message text unchanged | ✅ `IamTokenError` at :125, `isTerminalGrantError` at :152 duck-typed on `oauthError` rather than `instanceof` (`@tm/shared` reaches `apps/client` as a source alias but `apps/web`/`apps/server` as built `dist` — two module instances); `postToken`'s throw at :190 still reads `` vipper.iam token request failed (${status} ${detail}) `` — `iamPkce.test.ts`'s pinned substring survives |
| `apps/client/src/main/cloudToken.ts` | new — `CloudTokenProvider`, the single-flight | ✅ 163 lines; `get()` at :97 collapses concurrent callers onto one `inflight` promise; `mint()` at :137 sets `rejected` only on `isTerminalGrantError`, leaving every other failure (network blip, 503) retryable on the next tick |
| `apps/client/src/main/ipc.ts` | status (plan cites :1568), signOut (:1595), the replaced block (:1610-1637), sender wiring (:3588/3601/3620) | ✅ present at :1571, :1602, :1607-1614, and :3584/3601/3618 — each a handful of lines off the plan's own citation because the file grew elsewhere on the branch since the plan was written, not because anything is missing: `iam:getConfigStatus` reads `cloudToken.state()`/`.explain()`/`.lastMintedAt()`, `iam:signOut` calls `cloudToken.forget()`, and `cloudEvents`/`cloudAttachments`/`cloudPoller` each wire `onAuthRejected: () => cloudToken.invalidate()` |
| `apps/client/src/main/cloudPoller.ts` | `onAuthRejected`, `describeMissingToken`, `post()` extraction, retry-once | ✅ `describeMissingToken` read at :204 when `getAccessToken()` answers null; `post()` extracted at :292; a 401 at :256 calls `onAuthRejected` then re-mints and retries the SAME request once with the fresh token — never in a loop |
| `apps/client/src/main/index.ts` | `app.requestSingleInstanceLock()` | ✅ :36, quitting every later copy outright and focusing the survivor on `second-instance`; the comment at :33 names the gap this closes — two copies racing the desktop's own refresh-token rotation would each spend the same grant |
| `apps/client/src/renderer/src/Settings.tsx` | cloud section: state-driven hint + warning bar | ✅ `iamHint(iamStatus)` on the account `Field` at :1352, a `MessageBar intent="warning"` at :1353 gated on `authState === 'rejected'`, and the sign-in button's label/appearance flipping on the same state |
| `apps/web/src/auth/cloudAuth.ts` | the same single-flight + terminal handling | ✅ `getAccessToken()` at :158 mirrors `CloudTokenProvider.get()`'s `inflight` guard; `mint()` at :189 calls every `onGrantRevoked` listener and drops the stored refresh token on `isTerminalGrantError` — what lets `useCloudAuth` stop curtaining a board that will never sync again |
| `apps/web/src/board/syncGate.ts` | new — `boardIsReady`, `syncCurtainText`, `syncStatusLabel`, `describeAge` | ✅ 70 lines, all four exported; `boardIsReady` at :31 reads only the latched `initialSyncComplete`, never `draining` — the rule its own header states: ready is permanent once reached |
| `apps/web/src/board/BoardPoller.ts` | `onPollingChange` | ✅ optional dep at :35, called `true` at the top of `tick()` (:113) and `false` in its `finally` (:123) — a fact about a request in flight, not about what `onResponse`/`onError` last said |
| `apps/web/src/board/useCloudBoard.ts` | `SyncProgress` + the `hasMore` latch | ✅ `syncProgress` state at :77; the latch is the one-liner at :144 — `initialSyncComplete: p.initialSyncComplete \|\| response.hasMore !== true` — true forever once either side has been true once |
| `apps/web/src/App.tsx` | board branch, status-bar clause | ✅ `boardIsReady(board.syncProgress)` gates the board render at :225, `<SyncCurtain>` (from `@tm/ui/SyncCurtain`, imported :28) takes over otherwise; the status bar's `syncStatusLabel(...)` clause at :210 |
| `packages/ui/src/SyncCurtain.tsx` | new — the blue curtain | ✅ 57 lines; its own header explains why it is not `PaneLoading` — a network round trip worth seconds, not a millisecond-scale local read worth a skeleton |

**The gates, forced, on `13ca41c`.** `pnpm typecheck --force`: 9/9, 0 cached. `pnpm build
--force`: 6/6, 0 cached. `pnpm test`: 180 test files passed (1 skipped), 3020 tests passed (11
skipped). Nothing here was trusted from an earlier step's numbers on this same commit — the
point of forcing is that a cached green from before this walk would not have proven anything
about the tip it walked.

No file named in the table needed a code change. The walk found the intended behaviour already
in place from steps 2-8; the only drift found was the plan's own `ipc.ts` line citations, which
moved because the file grew elsewhere on the branch after the plan was written, not because any
wiring is missing.

---

## Phase 27 — Mobile app for Android

Twelve steps, approved before this phase started. Step 1 is not code — it is the four
framing decisions the approved plan left for the first session to record, because the
interactive prompt that would normally have taken them lives in a session nobody was
watching. A headless step cannot guess and cannot ask twice; it writes the decision down
instead, with the reasoning, so steps 2–12 build on a record rather than on an assumption
buried in whichever session happened to make the call first.

### Decision 1: a new `apps/mobile`, not a responsive `apps/web`

`apps/web` already mirrors the desktop's shell, board and detail pane (Phases 25–26) at
desktop proportions, with a shared `localStorage` namespace and service-worker scope. Making
it respond to a phone viewport would mean every future desktop-shaped change — a new
toolbar control, a wider dialog — carries a phone-shaped exception with it forever. A
separate app pays a one-time cost (its own shell, routing, PWA manifest) in exchange for
never having to ask "does this also make sense at 390px" for the rest of the project's life.
Phase 26 already had to draw a share-vs-fork line once, between the desktop and `apps/web`;
this decision draws the same kind of line one layer down. What mobile actually shares with
web/desktop is a question for step 2, not something to settle by folding it into `apps/web`
and finding out by accident which parts break at phone width.

### Decision 2: an installable PWA, not a Capacitor/TWA native build

There is no Android SDK, no JDK, and no keystore anywhere in this repo or on this machine,
and code signing is already a deferred backlog item, unscheduled. A Capacitor or
Trusted-Web-Activity build needs a Gradle project, and a Gradle project that nothing here can
compile, sign, or run would land unproven, the same way an Electron build cannot be verified
by actually launching it on this machine (that would kill the developer's own running copy —
verification there has to work headlessly, past the native-module ABI split). A PWA installs
as a WebAPK with its own icon and launches full-screen without any Android toolchain at all,
and it is the only form of "Android app" this branch can actually build *and verify*
headlessly. Play Store distribution — Bubblewrap/TWA, `assetlinks.json`, a keystore secret —
is noted under *Out of scope* as a follow-up ticket, not designed here.

### Decision 3: its own Azure Static Web App, on its own subdomain

Serving the mobile app from the existing SWA under a `/m/` path was the alternative
considered. It still needs a new IAM redirect URI regardless of which hosting shape is
chosen, so that cost is not avoided by sharing — and sharing adds `base: '/m/'` routing,
SWA route rules to keep it separate from the web app's own routes, and the same shared
`localStorage` namespace and service-worker scope problem Decision 1 opted out of, this time
between two *deployed* apps rather than two source trees. A dedicated subdomain (own SWA,
own DNS record) costs one more one-time Azure resource and buys a clean scope boundary for
the lifetime of the app.

### Decision 4: one-time human setup is required before it is reachable, and blocks no coding step

Creating the SWA, the DNS record, the `AZURE_STATIC_WEB_APPS_API_TOKEN_MOBILE` secret, and
registering a `taskmanager-mobile` IAM client (or adding a redirect URI to the existing one)
at `auth.vipper.network` are all actions on shared infrastructure — exactly the kind of
action this project's own working agreement holds for a human to take deliberately, not
something a session should do on its own authority. None of steps 2–9 need it to exist: they
build the app itself. Step 10 (deploy from CI) writes the job, added to the existing secrets
model in [`docs/11-ci-cd-pipeline.md`](../11-ci-cd-pipeline.md#secrets), and should condition
the deploy step on `AZURE_STATIC_WEB_APPS_API_TOKEN_MOBILE` being set so the job stays inert
rather than failing loudly while the secret does not exist yet — so the job can be written
and merged before the human setup happens, in either order. Step 11 (critical files) is where
the runbook for that one-time setup gets written down.

### What this leaves for step 2

Nothing here touches code. `apps/mobile` does not exist yet; no dependency was added; no
config was written. Step 2 — what is shared and what is forked — is the first step that
reads `packages/shared`, `packages/protocol` and `packages/ui` against these four decisions
and decides, file by file, which of them a phone screen can use unchanged.

### Step 2: what is shared and what is forked

The repo already has a rule for this, applied once already at the desktop/`apps/web` line in
Phase 26: share when a file has no host in it, fork when sharing it would mean threading a
dozen optional props through to keep two hosts happy. Applying that same rule one layer down,
between `apps/web` and the new `apps/mobile`, sorts every file in `apps/web/src` and
`packages/ui` into one of three piles.

**Shared, moved into a new `packages/cloud` (`@tm/cloud`).** Everything under `apps/web/src`
that talks to the cloud rather than to a screen has no host in it today only by accident — it
happens to sit in `apps/web` because `apps/web` was the only browser client that existed. Two
browser clients cannot each own a copy of the same sync layer; the moment `apps/mobile` also
polls the board and refreshes a token, one of the two copies drifts. This moves: `auth/`,
`presence.ts`, and out of `board/` — `useCloudBoard`, `cloudBoardStore`, `BoardPoller`,
`httpTransport`, `eventBus`, `sseEvents`, `polledEvents`, `mediaToken`, `clientId`,
`targetClient`, `boardSelectors`, `browserFocusSignal`, and `useBoardExtras` — plus the three
components that render cloud connection state rather than task data, `ClientPicker`,
`SkewBanner`, `StaleBanner`, and `settings/SettingsScreen.tsx`. Step 3 does the actual
extraction; this step only decides the boundary.

**Already shared, staying in `@tm/ui` unchanged.** `TaskCard`, `TaskDetail` and its whole
tree, `chat/*`, `Attention`, `Performance`, `AddTaskDialog`, `GitGraphPane`, and
`ArchivedCardsDialog` render the same way regardless of host — they take data and callbacks,
not a layout. The theme (`packages/ui/src/theme.ts`) is shared for the same reason. None of
these move; mobile imports them from `@tm/ui` exactly as `apps/web` and the desktop already
do.

**Forked — mobile writes its own.** The shell (a header and a bottom tab bar, not the
desktop's 84px rail — a phone has no room for a rail and no mouse to hover it), the board's
navigation (one column at a time with a swipe or tab to move between them, not the grid
`KanbanColumn` lays out for a wide viewport), the move interaction (a tap-to-move flow — see
step 6 — has nothing in common with the desktop's drag handlers), and the detail *route*
(a full screen push, not the 40% side pane `TaskDetail` sits in on desktop — `TaskDetail`
itself is shared per above, only what wraps it differs). `env.ts` and `vite-env.d.ts` also
stay forked, per-app, on purpose — Decision 1 in step 1 already ruled out a shared runtime
config between hosts that build and deploy independently.

**Dropped, per the same rule read in reverse: a control this host cannot act on is dropped
rather than disabled.** The chain overlay (`ChainOverlay.tsx`, `chainArrows.ts`) draws arrows
between cards across columns; on a phone showing one column at a time there is nothing for an
arrow to span, so chain state instead surfaces through the already-shared `TaskChain` inside
the detail view. The chain-link drag handle needs no forking work at all: `TaskCard.tsx:1247`
already renders it conditionally on `onLinkStart` being passed, so mobile gets the drop for
free simply by never passing that prop.

### Step 11: the critical files, walked one by one on `9c8eabd`

The plan named ten files or file groups, across six areas, as the ones this round lives or
dies on. Every one was re-opened here — none carried forward from the step that last touched
it — and every gate was run fresh rather than trusted from a step that measured the same
commit.

| File | What it had to be | On `9c8eabd` |
| --- | --- | --- |
| `test/shell-parity.test.ts` | catch a browser/desktop/mobile drift as text, since there is no DOM harness | ⚠️ mostly right, one real hole — see below |
| `apps/web/src/env.ts` | stay per-app; never move into `@tm/cloud`, since `import.meta.env` is a Vite build-time replacement esbuild cannot emit | ✅ unchanged; `apps/mobile/src/env.ts` mirrors it with its own `taskmanager-mobile` client id |
| `packages/cloud/src/board/httpTransport.ts`, `useBoardExtras.ts` | the one runtime (not type-only) edge where `@tm/cloud` imports `@tm/ui` — `useTransport` and `buildAttentionIndex` as values | ✅ confirmed; this is exactly what `packages/cloud/tsup.config.ts`'s `external` exists to protect |
| `packages/ui/tsup.config.ts` | the template `packages/cloud`'s own tsup config copies | ✅ unchanged; `packages/cloud/tsup.config.ts` copies its `entry`/`format`/`dts` shape and externalizes `@tm/ui` on top, with the two-copies-of-`TransportContext` reasoning written down |
| `packages/ui/src/theme.ts` (`useGlobalStyles`, `:313`) | `'html, body, #root'` sized to `100dvh`, not `100%` | ✅ unchanged, `:316` |
| `packages/ui/src/board/TaskCard.tsx` | reused as-is; drag props optional | ✅ unchanged; `draggable?`/`onDragStart?`/`onDragEnd?` (`:990`, `:994`–`:995`) default to `false`/absent at `:1030` |
| `packages/ui/src/board/boardColumns.ts` | column metadata, sorting and counts the mobile chip row and menu read | ✅ unchanged; `ColumnChips.tsx` and `BoardCardRow.tsx` both import `COLUMN_META` from it, `BoardScreen.tsx` (mobile) drives its column view from `visibleColumns`/`sortCards`/`hiddenDoneSummary` |
| `packages/ui/src/TaskDetail.tsx`, `Performance.tsx` | full-screen reuse; `Performance`'s grid stacks under `599px` | ⚠️ reuse is exact (`TaskScreen.tsx` wraps `TaskDetail` with nothing forked inside it; mobile's Performance destination renders `<Performance />` unmodified) — one stale comment fixed, see below |
| `.github/workflows/deploy.yml` (filters, `changes` job) | `packages/cloud/**` in both the `web` and `mobile` filters; a `mobile` job that stays inert without its token | ✅ unchanged; `:104` and `:112` both list it, the `mobile` job's own step (not a job `if`) checks `AZURE_STATIC_WEB_APPS_API_TOKEN_MOBILE` |
| `apps/web/staticwebapp.config.json`, `apps/mobile/staticwebapp.config.json` | the template, and the `webmanifest` exclusion a naive copy would drop | ✅ unchanged; `apps/web`'s has no manifest to exclude and correctly has none, `apps/mobile`'s exclude list already carries `webmanifest,json` |

#### Two real breakages, both the same shape

`test/shell-parity.test.ts` and `TaskDetail.tsx` are named critical for the same reason two
of `apps/client/scripts/verify-*.mjs` turned out to be broken, and the pattern is worth
naming once: **step 3 moved `httpTransport.ts`, `polledEvents.ts`, `eventBus.ts`,
`sseEvents.ts`, `useBoardExtras.ts` and `SettingsScreen.tsx` out of `apps/web/src` and into
`packages/cloud/src`, and every file that named their OLD location by path — rather than by
import specifier — went stale silently, because none of them are on the module graph
`pnpm typecheck` or `pnpm build` walks.** A prose comment and a script that reads a source
file as text both sit outside that graph the same way.

- **`apps/client/scripts/verify-remote-ipc.mjs` and `verify-remote-sse.mjs` no longer ran at
  all.** Both bundle `HttpTransport`/`PolledEventBus` (the IPC harness) or
  `SseEventStream`/`CloudEventBus` (the SSE harness) by resolving a literal path into
  `apps/web/src/board/*`, which step 3 emptied out from under them. `verify-remote-ipc.mjs`
  failed immediately — `Rollup failed to resolve import ".../apps/web/src/board/httpTransport"`
  — the moment it was run for this walk; `verify-remote-sse.mjs` would have failed the same
  way. Neither is wired into `ci.yml` or `RELEASE.md`'s gates (both are ad hoc, by-hand
  verification, same as `verify-attachments.mjs` and the rest), which is exactly why nothing
  red ever surfaced: eight steps of this branch ran green while both harnesses were dead.
  Fixed by pointing both at `packages/cloud/src` instead, and dropping the `@web` Vite alias
  neither script's bundle actually used any more (confirmed by grepping every file the two
  entry points import for it — nothing does). Re-run clean: **16 remote-IPC checks, 36
  push-channel checks**, both exit 0.
- **`test/shell-parity.test.ts`'s global-CSS guard silently lost `packages/cloud/src`.**
  `HOST_TREES` names every tree the `scrollbar`/`color-scheme` redeclaration check walks, and
  before step 3 `apps/web/src` covered `apps/web/src/settings/SettingsScreen.tsx` inside it.
  After the move that file sits in `packages/cloud/src/settings/`, which `HOST_TREES` never
  named — so a global rule declared there from step 3 onward would have compiled, rendered,
  and gone unflagged by every assertion in the file. Nothing had actually declared one (the
  guard passes clean before and after), which is what makes this a coverage hole rather than
  a caught bug — the failure mode is the one the file's own header names for
  `iamAuth.guard.ts` in an earlier round: a hole nothing asserts is indistinguishable from an
  omission until something is written into it. `packages/cloud/src` now joins `HOST_TREES`,
  with the same "covered from day one" reasoning the header already gives for
  `apps/mobile/src`. `packages/ui/src` deliberately still does not join it — that split
  predates this phase and is not this round's call to revisit.
- **`packages/ui/src/TaskDetail.tsx`'s `readOnlyNotice` docstring** named
  `apps/web/src/board/httpTransport.ts` and, more substantively, still described the OLD
  three-tier transport ("relays only a status change and a new card") that `httpTransport.ts`
  itself says stopped being true before this phase — the stub tier is gone, and what is
  refused now is only the host-only tier (file pickers, credentials, window buttons), which
  is what `RELAY_NOTICE`'s actual on-screen text already says. Only the path is this phase's
  doing; the substance predates it and is fixed here anyway since it sits inside a file this
  step is chartered to walk — left half-corrected would have been worse than left alone.

Two more stale path references to the same step-3 move were found by the same sweep —
`packages/shared/src/ipcEventFanout.ts:19` and `ipcRelay.ts:58,63` both still name
`apps/web/src/board/…` and `apps/web/src/settings/…` in prose. Neither file is on this
step's named list, so they are recorded here rather than edited — a critical-files walk that
starts fixing files nobody asked it to walk has exceeded itself the same way one that changes
behaviour has. Whoever picks up `packages/shared` next should know they are there.

#### The gates, forced, on `9c8eabd`

| Gate | Exit | Result |
| --- | --- | --- |
| `pnpm format:check` | 1 → **0** | two files failed before `--write` (below); clean after |
| `pnpm typecheck --force` | **0** | 12 successful, 12 total — 0 cached, ~33s |
| `pnpm build --force` | **0** | 8 successful, 8 total — 0 cached, ~40s |
| `pnpm test` | **0** | 180 files passed, 1 skipped (181); 3005 passed, 11 skipped (3016) |
| `node apps/client/scripts/verify-remote-ipc.mjs` | 1 → **0** | broken before the fix above; **16 checks** after |
| `node apps/client/scripts/verify-remote-sse.mjs` | (would have been 1) → **0** | same fix; **36 checks** |

`pnpm format:check` failed on `apps/mobile/src/board/BoardCardRow.tsx` and
`GitGraphSheet.tsx` — both an unwrapped `import { … } from '@fluentui/react-components'` and
one unwrapped JSX attribute list over Prettier's line width, from step 6 and step 7. Neither
is covered by `pnpm format:check`'s own glob for `test/*.ts` or `apps/client/scripts/*.mjs`,
so those two were checked with `pnpm exec prettier --check` directly instead and came back
clean. Fixed with `--write`; the diff is whitespace only. Every gate above was run a second
time after all of this step's edits, with identical counts to what is written here — a
measurement, not an assumption.

#### The merge this branch is heading into

`development` sits at `0079851`, exactly the merge-base of this branch — it has not moved
since `feat/mobile-app-for-android` forked from it, so this is a plain fast-forward with
**zero commits to reconcile and zero conflicts possible**, not merely zero found. A
`git merge-tree` against it produces no output for the same reason. `apps/client/package.json`
reads `0.86.0` on both sides, so there is no version bump for a merge to swallow either — the
normal case now that CI cuts releases from `development` rather than from a bump carried on
this branch.

### Step 12: verification, re-run one commit later on `9db1f5b`

Step 11 landed its own fixes and measured the gates on the commit it produced; this step
re-ran every one of them fresh on the tip that commit became (`9db1f5b`), plus the two
checks step 11's numbers didn't carry forward, to confirm nothing regressed between
"the step that fixed it" and "the step chartered to verify it."

| Gate | Exit | Result |
| --- | --- | --- |
| `pnpm format:check` | **0** | clean — no drift since step 11's `--write` |
| `pnpm exec turbo run typecheck --force` | **0** | 12 successful, 12 total — 0 cached, ~34s |
| `pnpm exec turbo run build --force` | **0** | 8 successful, 8 total — 0 cached, ~44s |
| `pnpm test` | **0** | 180 files passed, 1 skipped (181); 3005 passed, 11 skipped (3016) — identical to step 11's count |
| `node scripts/verify-mobile-build.mjs` | **0** | all 21 checks pass — manifest, both icons, `sw.js`, and its registration in `index.html` |
| `node apps/client/scripts/verify-remote-ipc.mjs` | **0** | 16 checks, still green after step 11's re-point |
| `node apps/client/scripts/verify-remote-sse.mjs` | **0** | 36 checks, still green after step 11's re-point |

`pnpm exec vitest list --filesOnly` gives the per-package test sum the root glob actually
collects, rather than trusting the workspace layout: 181 files split
`apps/client` 83, `packages/shared` 27, `apps/server` 27, `packages/ui` 23, `packages/cloud`
13, `test` 4, `apps/mobile` 2, `scripts` 1, `packages/protocol` 1 — summing to the 181 the
run itself reports. The two mobile-only files are exactly what the "no component tests"
constraint predicts: `apps/mobile/src/nav/navStack.test.ts` and
`apps/mobile/src/sw/shouldHandle.test.ts`, both pure modules. `packages/cloud`'s 13 are the
board selectors, transports and stores step 3 moved out of `apps/web/src` — confirming
step 11's `HOST_TREES` fix didn't just silence the shell-parity guard but that the moved
modules are still exercised at all.

No new test was written for this step: the constraints section ruled out anything a red-first
assertion could check beyond what steps 1-11 already added, and the plan's own gate list
(`pnpm format:check && pnpm typecheck && pnpm test && pnpm build`, plus
`verify-mobile-build.mjs` for the parts a `noEmit` typecheck can't see) is exactly what ran
above. Every number matches step 11's independently-measured ones on the prior commit, which
is the outcome a verification step re-running someone else's fix should produce — agreement,
not new findings.

#### Owed to a human

Nothing here can hold an Android phone. Specifically unverified by any command in this
branch:

- Installing the PWA from Chrome's "Add to Home screen" / install prompt on a real device.
- Pressing the hardware/gesture Back button and confirming the nav-stack (step 8) pops the
  right screen instead of exiting the app.
- Tapping a card to move it (step 6) and watching the change land on the desktop board, and
  the reverse — moving it on desktop and watching the phone update.
- Opening a task full-screen (step 7) and confirming the layout, not just the route, reads
  right on a phone-sized screen — `verify-mobile-build.mjs` and `shell-parity.test.ts` both
  check structure and source text, neither renders a pixel.
- That the CI deploy (step 10) actually reaches an installable URL — `deploy.yml`'s `mobile`
  job existing and staying inert without its token is confirmed statically; a live deploy
  needs `AZURE_STATIC_WEB_APPS_API_TOKEN_MOBILE` to be set and a run to complete.


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
