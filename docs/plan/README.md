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
| 8 | Import & project configuration | 🚧 in progress (B2 session picker open) |
| 9 | Personal task management (to-do list) | ✅ shipped |
| — | Interim releases v0.11–v0.21 (worktrees & auto-merge, team orchestration, JIRA sync, My Tasks Kanban) | ✅ shipped, not tracked here |
| 10 | Delegate a task to an agent | ✅ shipped |
| 11 | Plan-driven subtasks (plan → approve → steps) | ✅ shipped |
| 12 | Chat with the agent from a card | ✅ shipped |

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
- [ ] **B2 — Session discovery/picker.** `claude:listSessions(cwd)` enumerates
      `~/.claude/projects/<encoded-cwd>/*.jsonl` (filename = resumable session id),
      returning `{ sessionId, startedAt, lastAt, preview }` newest-first; the adopt
      UI shows this as a pick-list with the manual-paste fallback. Pure helpers
      `encodeProjectDir` + `parseSessionPreview` are unit-tested; the reader fails
      soft (the `~/.claude/projects` layout is an **undocumented** CLI convention,
      verified against the current install — never hard-depend on it).
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
- [ ] B2: the adopt UI lists real on-disk sessions for a project's folder.
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

## Conventions for every phase

- **Contract first.** New data crossing the UI↔engine boundary gets its types in
  `src/shared/` before either side uses it (`docs/02`).
- **Pure logic is unit-tested.** Parsers, policies, schedulers, and gates are pure
  functions with `.test.ts` files, like `claudeSession.mapRawEvent` today.
- **Green before commit.** `pnpm typecheck` and `pnpm test` pass; commit message
  ends with `(Phase N)`.
- **No paid API.** Everything runs the subscription `claude` CLI; never introduce a
  path that uses `ANTHROPIC_API_KEY` (`docs/06`).
