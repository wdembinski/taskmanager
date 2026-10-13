# F5 — Composer and hand-to-agent

> **Status:** proposed · **Where:** client + web (shared `packages/ui`), main-process tracker reads · **Depends on:** none to start; Phase 3 needs **F7** (prompt templates) and **F1** (triggers) · **Unlocks:** F4 (Linear plugs into the issue browser as a fourth provider), F3 (one-tap hand-off from a phone)
> Only the `- [ ]` checkboxes under **Tasks** become cards when this file is imported as a plan; everything else is context.

## Why

Two gaps between "I have work" and "an agent is doing it":

1. **Creating and starting are two dialogs.** `AddTaskDialog` makes the card; `AssignAgentDialog` delegates it and starts it. The common intent — "do this, now, in that repo" — costs two dialogs and a hunt for the new card in between.
2. **The board only shows what the sync query lets in.** An open issue outside the JQL / GitHub query, or one you have not pulled yet, cannot be handed to an agent without first making it appear on the board. The everyday flow should be one click: browse open issues, filter by label, hand this one to the agent.

## What we have today

- `packages/ui/src/AddTaskDialog.tsx` (1127 lines, shared by both hosts) already asks: board (Personal vs a ticket board), project filing (`projectTagId`), title/description, type, phase, epic, a JIRA ticket to create and link, **staged attachments** (`stageAttachments`, copied once the row exists — `attachment:pick` is host-only), "Runs after…" chain link, and step-under-a-card. Its rules are a pure function `addTaskPlan(form)`.
- `packages/ui/src/AssignAgentDialog.tsx` — agent project (pre-filled by `resolveAgentProject` from the epic), model, permission mode, notes; calls `task:assignAgent` (`packages/shared/src/ipc.ts:675`, input `AssignAgentInput` in `packages/shared/src/model.ts:1314` — `agentProjectId`, `mode?`, `model?`, `planningModel?`, `notes?`). Renders in both hosts.
- Model ladder (memory *model-split-phase23*): `task.agentModel ?? (planning ? project.planningModel : null) ?? project.defaultModel` — NULL means "follow the project"; a new picker must write NULL for "default", not the concrete default.
- Tracker reads in `apps/client/src/main`: `jira/jiraClient.ts` `search(jql)` / `searchAll` / `getIssue`; `github/githubClient.ts` `searchIssues(query)` / `getIssue`; `gitlab/gitlabClient.ts` has merge-request reads only (`listMyMergeRequests`, `listNotes`) — **no issue listing yet**. Labels: JIRA `fields.labels`, GitHub `labelsOf()` in `github/githubIssueSync.ts:185`.
- Syncs (`jiraSync.ts`, `githubIssueSync.ts`) bring in issues that match the board's query, and archive cards that **leave** it (`TaskArchiveReason 'left-query'`, memory *jql-drops-what-you-finish*).
- Relay: every channel is classified in `packages/shared/src/ipcRelay.ts`; `ticket:create`, `task:create`, `task:assignAgent` relay to the web.
- No prompt templates (F7) and no triggers (F1) exist.

## Design

### Data model & contracts

- `IssueSummary` (shared): `{ provider: 'jira' | 'github' | 'gitlab', key, title, url, state, labels: string[], type?, assignee?, updatedAt, onBoardTaskId: string | null }` — `onBoardTaskId` is resolved in main by matching `externalSource`+`externalKey` against the store, so the UI can show "On board → open" instead of importing twice.
- IPC (all `relay` in `RELAY_POLICY`): `issues:list(query: IssueQuery)` → `{ items: IssueSummary[], labels: string[], nextCursor? }`; `issues:import(provider, key)` → `Task` (idempotent: returns the existing card if already on the board).
- `AddTaskForm` gains `assign: { agentProjectId, model: ClaudeModel | null, mode: PermissionMode | null } | null` and `startNow: boolean`; `AddTaskPlan`'s `card` variant gains the same `assign`. Steps never carry it (a step runs in its parent's worktree).
- `AutomationAction.taskId` (F5.12) is the attach point: the composer's "Run on a schedule" section builds the trigger and `addTaskPlan` carries it, but the automation itself is only ever pointed at a card through this field — nothing else on `Automation`/`AutomationTrigger` names the card.
- Task: `pinnedImport?: boolean` (or a new `source: 'import'` — see Open questions) so a card imported from outside the sync query is **not** archived as `left-query`. Store migration (memory *the-store-has-no-tests* for how to cover it).

### Engine / main process

- `IssueProvider` interface in `apps/client/src/main/issues/` with three implementations wrapping the existing clients: JIRA (JQL `statusCategory != Done ORDER BY updated DESC`, optional `labels = …`), GitHub (`searchIssues('is:issue is:open repo:… label:…')`), GitLab (new `listIssues(projectId, {state:'opened', labels})` on `gitlabClient.ts`). F4 adds Linear as a fourth.
- `issues:import` builds a card exactly as the sync's mapping would (reuse the sync's row mapper, do not re-implement it), sets `pinnedImport`, and is idempotent by `externalKey`.
- "Add and start": the composer calls `task:create` (or `ticket:create`) then `task:assignAgent` — no new engine path. A limit/auth park is a success (memory *assign-into-a-standing-limit*): the card exists and is queued.
- The syncs skip `pinnedImport` cards when computing `left-query` archival.

### Server & sync

- No new server endpoints: the three new channels relay over the existing `ipc-invoke` mirror kind, so the web reaches the desktop's tracker credentials. Large `issues:list` answers must respect the result-size cap that fixed *one-answer-wedges-the-mirror* — page with `nextCursor`, 50 items per page.
- `pinnedImport` is a task field and must be added to the mirrored task shape in `packages/protocol` so the web renders it.

### UI — desktop

- **Composer** (`AddTaskDialog`): a collapsible **"Run it"** section — agent project (pre-filled via `resolveAgentProject`), model (Default = NULL), mode; the primary button becomes **Add and start** when a project is chosen, with **Add** as the secondary. ⌘/Ctrl+Enter submits. Hidden for steps.
- **Issues screen** (`packages/ui/src/issues/IssuesScreen.tsx`, new nav item): provider tabs (only connected providers), search box, **label facet filter** (multi-select, the selection always visible as chips outside the dropdown so a filter never hides it), list + detail pane; the detail shows the issue body read-only and a **hand-off panel**: prompt box pre-filled with the issue key + URL (never the body), agent project/model/mode pickers (route state, persisted), **Hand to agent** (= import → assign → start) and **Add to board** (import only). Already-on-board issues show "On board" with an Open button.

### UI — web

- Same `IssuesScreen` and composer from `packages/ui`; mounted in `apps/web/src/App.tsx`. Attachments in the web composer stay limited to what `filesEnabled` allows today (`attachment:pick` is host-only).
- Hand-off confirms with a toast as well as inline, because on a phone the inline confirmation is often under the keyboard.

### Failure modes & edge cases

- **Imported card archived by the next sync** because it is outside the JQL — prevented by `pinnedImport`; a test proves the sync skips it.
- **Double import** (two clicks, or web and desktop at once): `issues:import` is idempotent by `(externalSource, externalKey)`; the second call returns the first card.
- **Card created, start refused** (no repo, signed out, limit): the card is kept; refusals use `RUN_REFUSAL_MESSAGE`, parks read as success. Never roll back the card.
- **Provider not connected / token invalid**: tab shows the provider's own test-connection message (memory *jira-401-with-a-valid-token*), not an empty list.
- **Rate limits**: GitHub search is 30 req/min; list on demand only (no polling on this screen), cache the last page for the session.
- **Draft prompt per issue**: stored only once the user types (an untouched box stores nothing), keyed by provider+key, in renderer `localStorage`, wrapped in try/catch.
- **Model "Default"** must persist as NULL so later project-default changes still apply.

## Out of scope (v1)

- Creating issues in the trackers from the browser (the composer's existing JIRA-ticket option covers JIRA).
- Editing issue fields, commenting, or transitioning from the Issues screen.
- Bulk hand-off of many issues at once.
- Skill multi-select (F7 owns skills; this doc only consumes templates).
- Linear (F4).

## Open questions

1. **`pinnedImport` flag vs a new `source: 'import'`.** `source` already distinguishes `jira`/`github`; changing it could break every `source === 'jira'` check. *Recommended default:* a separate boolean `pinnedImport`, leaving `source` as the provider.
2. **Should Hand to agent pick a JIRA board or always land on Personal?** *Recommended default:* Personal board (where delegated cards live today), filed under the project resolved from the issue.
3. **GitLab issues** — worth building now, given only MRs are used today? *Recommended default:* yes, behind the same interface; it is one list call.
4. **Composer: one dialog or a full-screen composer?** *Recommended default:* keep the existing dialog and add the "Run it" section — the form already answers the other questions and a second composer would be a second set of answers.

## F5.12 — decisions taken (step 1 of 5)

Five build steps are approved for F5.12. Step 1 is not code — it is the decisions the
model and plan changes build on, settled here so step 2's engine wiring and step 3's plan
extension build on a record instead of each re-deriving it in a headless session with no
one to ask.

### An automation can be pointed at a card that already exists

`AutomationAction` gains `taskId?: string` (`packages/shared/src/automation.ts:56-70`).
When set, a firing works that card instead of creating one: a schedule automation with
`taskId` re-delegates and starts it the same way `task:assignAgent` does (`titleTemplate`/
`briefTemplate` go unused, same as the tracker branch already treats them as tracker-only —
see the doc comment at `automation.ts:51-55`); a tracker automation with `taskId` only fires
for events on that one card, rather than any ticket matching the trigger the way a
tracker automation with no `taskId` does today. If the card is gone, the firing is refused
with `unknown-task` — a reason the refusal ladder already has
(`packages/shared/src/scheduler.ts:65,142`), and one `automationRunner.ts`'s tracker branch
already raises when a tracker firing's `taskId` can't be found in the store (`fireOne`,
`:270-278`). That refusal counts as a strike the same as any other (`applyStrike`,
`:139-149`), and three strikes auto-disables the automation (`MAX_CONSECUTIVE_FAILURES`,
`:28`) — so a deleted attached card does not need its own cascade-delete of the automation
in v1; the existing strike ladder already retires it.

### The composer offers only "Run on a schedule"

A freshly composed card has no tracker history yet — `detectTrackerEvents` needs a
before/after diff of cards a sync already wrote (`automationTracker.ts`), and a card that
does not exist yet has neither. So the attach-a-trigger section in `AddTaskDialog` only
builds a `{ kind: 'schedule' }` trigger; it does not offer "when …" at all. Nothing about
the plan type is schedule-only, though: `addTaskPlan`'s new `trigger` field (step 3) takes
a full `AutomationTrigger`, and tracker scoping is implemented in the engine (previous
decision) — so a later "when …" UI can follow without touching the model again.

### A trigger needs an agent, so addTaskPlan refuses one without `assign`

`AutomationAction.agentProjectId` is required, not optional (`automation.ts:59`;
`validateAutomation` rejects a blank one at `:198-200`) — an automation with no agent
project cannot fire. So a trigger attached with no `assign` is refused by `addTaskPlan`
before the card is ever written, the same way `startNow` without `assign` already is
(`AddTaskDialog.tsx:331-333`): same `kind: 'incomplete'` shape, a message naming the fix.
Mode defaults to `assign.mode ?? 'acceptEdits'` — the editor's own default for a fresh
automation (`newAutomationDraft`, `automationEditorModel.ts:110`) — rather than leaving it
unset. `manual` is never offered as a choice for a trigger's mode: `validateAutomation`
would refuse it anyway (a headless run has no one to answer a permission prompt, memory
*a-headless-turn-has-no-next-turn*), so the plan refuses it directly rather than
constructing a trigger the engine would reject with a different message.

### The trigger section brings its own minimal agent-project dropdown

F5.2 (the Run it section with agent project/model/mode pickers) has not landed on this
branch, and Phase 3's tasks were scoped to need only F7/F1 — not F5.2 (see the Phase 3
header below). A trigger cannot fire without an agent project (previous decision), so
step 4's "Run on a schedule" section brings its own small agent-project dropdown that
writes straight into `form.assign` and only appears once the schedule toggle is on — not a
second, competing picker. When F5.2 lands, it grows this same field into the full Run it
section; the trigger section is not asking the same question twice, just asking it early.
`startNow` stays hard-wired `false` from the dialog until F5.3 builds the "Add and start"
write order, but `addTaskPlan` itself already honours `startNow` today
(`AddTaskDialog.tsx:331-334`), so nothing about the pure plan needs to wait for F5.3.

## F5.12 — verification (step 5 of 5)

All three gates re-run forced, so no step reused a cached result (memory
*a-cached-gate-is-not-a-gate*): `pnpm typecheck --force` (9/9 tasks, 0 cached,
covering `@tm/protocol`, `@tm/server`, `@tm/shared`, `@tm/ui`, `@tm/web` and
`claude-orchestrator`/`apps/client`); `pnpm build --force` (6/6 tasks, 0
cached); `pnpm test` (268 files / 4749 tests passed, 11 skipped). The five
files this ticket's steps 2-4 touched or added
(`automationRunner.test.ts`, `automationTrackerFirings.test.ts`,
`automation.test.ts`, `automationEditorModel.test.ts`,
`AddTaskDialog.test.ts`) run clean in isolation too: 85/85.

`pnpm test` has 5 pre-existing failures, none of them this ticket's: 4
subprocess timeouts in `apps/client/src/main/git.test.ts` and one
environment-gated assertion in `worktreeWsl.test.ts` (needs a live WSL
distro). Both files were last touched by 3577045, well before TM-86 — the
same flakiness commit 827a7f6 already called out.

Red before green: the `else if (automation.action.taskId)` branch in
`fireOne` (`automationRunner.ts`) was removed, falling the attached-card
path through to card creation. Two of the three attached-card tests failed
as expected — "works the existing card and creates none" (delegate never
called with the attached id) and "refuses unknown-task with a strike when
the attached card is missing" (started instead of refused), since a
taskId-less automation with no boardProjectId both tests leave unset falls
into the no-project refusal instead. The third ("is skipped, not a strike,
when the attached card is already being worked") still passed, because the
overlap check at `fireOne`'s step 2 catches that case before reaching the
branch under test — expected, not a gap. The branch was restored verbatim
(`git diff` empty against HEAD) and the suite returned to 9/9 green.

Not verifiable headlessly, and not attempted (memory *verify-electron-app*
— never launch the app from this machine): a human still needs to open the
composer, confirm the "Run on a schedule" section renders, save a card with
a trigger attached, and confirm the automation appears on the Automations
screen pointed at that card.

## F5.10 — decisions taken (step 2 of 3)

Step 2 mounted the gated Issues tab in `apps/web`, alongside step 1's desktop
mount. Three decisions settled here rather than re-derived by step 3:

- **The web gate reuses `activityGate` (`apps/web/src/activity/activityGate.ts`)
  as-is.** Issues has the same one source as Activity — a live desktop — and
  the same three facts decide `unreachable`/`checking`/`ready`, so
  `WebIssuesScreen.tsx` imports it rather than growing a second copy under a
  new name.
- **No palette source, because F9 had not landed.** The ticket's own note
  anticipated registering "Hand issue … to agent" in a command palette;
  F9.4/F9.5 should pick this up once that palette exists, rather than this
  ticket building a palette entry with nothing to plug it into.
- **The human reachability check is still owed in both hosts.** Neither step
  1 nor step 2 could open a browser or launch the app from this machine
  (memory *verify-electron-app*) — a human still needs to click the Issues
  tab on each host and confirm it renders.

## Tasks

### F5 · Phase 1 — Add and start

- [ ] F5.1 Extend the pure addTaskPlan with an optional agent assignment and a start-now flag

  - `packages/ui/src/AddTaskDialog.tsx`: `AddTaskForm.assign` + `startNow`; `AddTaskPlan` card variant carries `assign`; steps never do; model "Default" → `null`.
  - Acceptance: `addTaskPlan` tests — card with assign keeps it, step drops it, default model is null, startNow without a project is `incomplete` with a message. Gates `pnpm typecheck`, `pnpm test`, `pnpm build` green.
- [ ] F5.2 Add a Run it section with agent project model and mode pickers to AddTaskDialog @needs: F5.1 Extend the pure addTaskPlan with an optional agent assignment and a start-now flag

  - Reuse `resolveAgentProject` and the option lists from `AssignAgentDialog.tsx` (extract them to a shared `agentPickers.ts` rather than copying); collapsible; hidden for steps; both hosts.
  - Acceptance: extracted helpers unit-tested (pre-fill from epic, default model null); AssignAgentDialog still uses the same helpers (no behaviour change — its existing tests pass). Gates green.
- [x] F5.3 Make Add and start create the card then assign and start it with one error surface @needs: F5.2 Add a Run it section with agent project model and mode pickers to AddTaskDialog

  - New pure module `packages/ui/src/addTaskSteps.ts`, built around `AddTaskDialog.tsx`'s own
    `AddTaskPlan`/`AddTaskAssign` (type-only import — the dialog is 1340 lines and this module
    must not become a second place that reads `form` to decide anything). `addTaskSteps(plan:
    Exclude<AddTaskPlan, { kind: 'incomplete' }>, extras: { attachments: readonly string[];
    runsAfterId: string | null }): AddTaskStep[]` turns a settled plan into the ORDERED writes
    `save()` makes today, as data rather than a sequence of awaited calls: `AddTaskStep = {
    kind: 'create-step'; parentId; step } | { kind: 'create-card'; board; card } | { kind:
    'create-ticket'; board; ticket } | { kind: 'link-jira'; ticket } (card plan only) | { kind:
    'attach'; paths: string[] } (only when `extras.attachments.length`) | { kind: 'chain-after';
    fromTaskId } (card/ticket only, never a step) | { kind: 'assign'; assign: AddTaskAssign;
    start: boolean } (card/ticket only, and always last — only emitted when `plan.assign` is
    set)`. Order: create, JIRA link, attachments, chain, assign — attachments precede assign
    because a started agent's first prompt quotes the brief's `@name`s, and the files must
    already be on disk when that prompt is built, not racing it.
  - `AddTaskRun` names what the (possible) assign step did — `'none'` (no agent picked, the
    step was never built), `'assigned'` (Add without Start), `'started'`, `{ kind: 'parked';
    refusal: ParkedRefusal }` (the limit gate — `task:assignAgent` does not throw for this, it
    resolves with the task carrying `blocked-by-limit`), or `{ kind: 'not-started'; reason:
    string; refusal: RunRefusal | null }` (the assign call threw). `AddTaskResult = { created:
    'card' | 'ticket' | 'step'; problems: string[]; run: AddTaskRun }` is what the executor
    below settles to.
  - `refusalFromMessage(message)` is the reverse of `RUN_REFUSAL_MESSAGE` (`@tm/shared/
    scheduler`) — an exact-string lookup over its six entries, `null` for anything else.
    `runFromAssign(task, start)` reads the TASK `task:assignAgent` resolved with: `!start` →
    `'assigned'`; `task.status === 'blocked-by-limit'` → `{ kind: 'parked', refusal: 'limit'
    }`; otherwise `'started'`. `runFromAssignError(message)` reads the message a REJECTED
    `task:assignAgent` call threw: `refusalFromMessage(message) === 'signed-out'` → `{ kind:
    'parked', refusal: 'signed-out' }` (the other parked gate — a sign-out park writes no
    status, so the catch has nothing useful on the task to read, only the message); anything
    else → `{ kind: 'not-started', reason: message, refusal: refusalFromMessage(message) }` —
    `reason` is the thrown message verbatim, which for a known refusal IS
    `RUN_REFUSAL_MESSAGE[refusal]` (so `no-project`'s reason already names the fix: assign it to
    an agent project) and for an unexpected error (network, say) is whatever that error said,
    with `refusal: null`.
  - `outcomeMessage(result)` is the one banner the dialog shows after Add, replacing today's
    three separate `onNotice` calls (`chainAfter`/`ticketFor`/`attachTo`'s excuses) with a
    single sentence: `started`/`assigned`/`none` with an empty `problems` → `null` (nothing to
    say, close quietly, exactly as today). `parked` → `{ tone: 'success', text: 'Created and
    queued — ' + RUN_REFUSAL_MESSAGE[refusal] }` — a limit or sign-out park is the engine doing
    exactly what Start promises, not a failure. `not-started` → `{ tone: 'warning', text:
    'Created, not started: ' + reason }`. Every `problems` entry — the same sentences
    `ticketFor`/`attachTo`/`chainAfter` already write today ("The card was created, but its
    JIRA ticket was not — <why>", "…but its files were not attached — <why>", "…but it could
    not be chained — <why>") — is appended to that one text, space-joined, and its presence
    alone forces `tone: 'warning'` even over a `parked` run.
  - `executeAddTaskSteps(steps, invoke: TransportInvoke)` is the executor, pure over an
    injected `invoke` (`Transport['invoke']`, aliased `TransportInvoke`) so "the card is never
    rolled back" is a unit test instead of a click-through. The FIRST step is always one of
    the three `create-*` kinds; its call (`task:addSubtask` / `task:create` / `ticket:create`)
    is awaited OUTSIDE any try — a throw here propagates straight to the caller, because
    nothing exists yet and the dialog's existing inline error (stays open, nothing to roll
    back) is still exactly right. Its `Task.id` becomes `createdId`, threaded into every later
    step (none of them carry an id of their own — it does not exist until this call returns,
    which is exactly why the step objects above cannot carry one). Every step after that is
    awaited inside its OWN try: `link-jira` calls `jira:createTask` (`{ ...ticket,
    adoptTaskId: createdId }`), `attach` calls `attachment:add(createdId, paths)`,
    `chain-after` calls `chain:link(fromTaskId, createdId)` and treats a `{ status: 'refused'
    }` `LinkResult` the same as a throw, and `assign` calls `task:assignAgent(createdId, {
    ...assign, start })` and feeds its outcome to `runFromAssign`/`runFromAssignError` instead
    of `problems`. A caught throw from any non-assign step is pushed onto `problems` (worded
    as above) and the loop carries on to the next step; a caught throw from `assign` sets
    `run` via `runFromAssignError` instead. Nothing here ever calls `task:delete` — the row
    that already exists is the one thing every branch of this function keeps.
  - Acceptance: `addTaskSteps.test.ts` — step ordering for each `AddTaskPlan` kind (a step
    drops the JIRA/chain/assign steps; a card with no ticket/attachments/chain/assign emits
    exactly one step; attachments sit before chain and chain before assign); `refusalFromMessage`
    round-trips every `RUN_REFUSAL_MESSAGE` entry and answers `null` for an arbitrary string;
    `runFromAssign`/`runFromAssignError` cover all five named cases; `outcomeMessage` covers the
    acceptance table in this bullet (limit park reads `tone: 'success'`; `no-project`'s reason
    names the fix; a `problems`-only result is `tone: 'warning'` even with `run: 'started'`).
    `executeAddTaskSteps` driven with a fake `invoke` that throws on the second and third step
    in turn, asserting `problems` grows and no `task:delete`/removal call is ever made — the
    "never rolled back" rule, proven rather than assumed. Gates `pnpm typecheck`, `pnpm test`,
    `pnpm build` green.

### F5 · Phase 2 — Issue browser and hand-off

- [ ] F5.4 Add the issue listing and import contracts with relay classification

  - `packages/shared`: `IssueSummary`, `IssueQuery`, IPC `issues:list` / `issues:import`, both `relay` in `ipcRelay.ts`; `Task.pinnedImport` + protocol task shape.
  - Acceptance: `test/ipc-relay-coverage.test.ts` and `ipcRelay.test.ts` pass with the new channels; a size test keeps one `issues:list` page under the relay result cap. Gates green.
- [ ] F5.5 Implement issue providers for JIRA GitHub and GitLab in the main process @needs: F5.4 Add the issue listing and import contracts with relay classification

  - `apps/client/src/main/issues/{issueProvider,jiraIssues,githubIssues,gitlabIssues}.ts`; new `listIssues` on `gitlabClient.ts`; `onBoardTaskId` resolved against the store; label filter pushed into each provider's query; 50 per page with a cursor.
  - Acceptance: provider tests with recorded fixtures (query string built correctly per label set, labels normalized, on-board resolution, pagination cursor). Gates green.
- [ ] F5.6 Add idempotent issue import that pins the card against left-query archival @needs: F5.5 Implement issue providers for JIRA GitHub and GitLab in the main process

  - `issues:import` reuses the syncs' row mappers; sets `pinnedImport`; store migration for the column; `jiraSync.ts` / `githubIssueSync.ts` skip pinned cards when archiving `left-query`.
  - Acceptance: tests — importing twice returns one card; a pinned card outside the query survives a sync pass; an unpinned one is still archived. Migration covered with the drop-column recipe from *the-store-has-no-tests*. Gates green.
- [ ] F5.7 Add the pure issue browser state with label facets and per-issue drafts @needs: F5.4 Add the issue listing and import contracts with relay classification

  - `packages/ui/src/issues/issueBrowserState.ts`: provider tab, search, selected labels (selection never filtered away), list/selection, page append, stale-answer guard (seq frontier like `taskTimeline.ts`), draft prompt store (untouched → nothing stored).
  - Acceptance: reducer tests — out-of-order page answers ignored; switching provider resets selection; draft written only after an edit; pre-fill is key + URL, never the body. Gates green.
- [ ] F5.8 Build the Issues screen with list detail and hand-off panel in packages/ui @needs: F5.5 Implement issue providers for JIRA GitHub and GitLab in the main process, F5.7 Add the pure issue browser state with label facets and per-issue drafts

  - `IssuesScreen.tsx`: provider tabs (connected only), search, label chips + facet dropdown, list, read-only detail, hand-off panel (prompt box, pickers from F5.2's helpers), "On board → Open" for known issues, provider connection errors shown verbatim.
  - Acceptance: component is wiring only over F5.7's reducer; a pure `handOffAvailability(issue, projects)` tested (no agent projects → disabled with the desktop-only explanation, as AssignAgentDialog does). Gates green.
- [ ] F5.9 Add one-click hand to agent that imports assigns and starts in one action @needs: F5.6 Add idempotent issue import that pins the card against left-query archival, F5.8 Build the Issues screen with list detail and hand-off panel in packages/ui, F5.3 Make Add and start create the card then assign and start it with one error surface

  - Hand to agent = `issues:import` → `task:assignAgent` (notes = the prompt box) → toast + inline "View card"; Add to board = import only.
  - Acceptance: pure `handOffSteps` tested — already-on-board issue skips import; refusal keeps the imported card and reports the reason; park reports success. Verified end-to-end with the stub CLI from *stub-claude-on-path* (import → run starts). Gates green.
- [x] F5.10 Mount the Issues screen in the desktop nav and in apps/web @needs: F5.8 Build the Issues screen with list detail and hand-off panel in packages/ui

  - Nav item in `apps/client/src/renderer/src/App.tsx` and `apps/web/src/App.tsx`; if F9 has landed, register a palette source ("Hand issue … to agent").
  - Acceptance: web settings/nav section tests updated; the screen is reachable in both hosts (human check noted as owed — no DOM harness). Gates green.

### F5 · Phase 3 — Templates and triggers (after F7 and F1)

- [ ] F5.11 Add a prompt template insert menu to the composer and the hand-off panel

  - Requires F7's template store. Menu inserts at the caret; into an untouched pre-filled box it appends below the reference rather than above it.
  - Acceptance: pure `insertTemplate(text, caret, template, untouched)` tested for caret, untouched-append and empty cases. Gates green.
- [x] F5.12 Add an optional attach a trigger section to the composer

  - Requires F1's trigger model. "Run on a schedule / when …" attaches an F1 trigger to the new card instead of (or as well as) starting now.
  - Acceptance: `addTaskPlan` tests — trigger plus startNow both honoured; trigger on a step rejected; the created trigger references the new card id. Gates green.
