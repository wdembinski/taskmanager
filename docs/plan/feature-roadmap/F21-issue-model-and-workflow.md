# F21 — Issue model and workflow

> **Status:** proposed · **Where:** client (desktop main + `packages/ui`), server, web · **Depends on:** F19 (cloud parts only), F1 (shipped; recurring tickets), F14 (archived epics stay out of pickers) · **Unlocks:** F22 (collaboration), F24 (planning), F25 (views and insights), F26 (triage and git automation)
> Only the `- [ ]` checkboxes under **Tasks** become cards when this file is imported as a plan; everything else is context.
>
> **Layout rule for this file:** every task's description bullets sit after a **blank line**. The plan
> parser folds any indented line that directly follows a checkbox into that task's *title*
> (`apps/client/src/main/planParser.ts:173-177`); the blank line is what keeps descriptions out of it.

## Why

The app's own tracker already has most of a ticket: keys, types, epics, milestones, labels,
links, estimates, dates, assignee and reporter (Phase 24, `docs/12-the-ticket-model.md`). What it
does not have is a **workflow of its own**. Every native ticket lives on the same six fixed
statuses (To Do, In Progress, In Review, Blocked, Done, Cancelled) in the same five fixed
columns, so a team cannot say "Ready for QA" or "Waiting on design", and nothing can react when a
ticket reaches a state the team cares about. It has no sub-issues either: the only parent/child
relations are an epic's stories, which group, and an agent's steps, which execute. Neither is
"this ticket is broken into these smaller tickets".

F21 makes the tracker's issue model complete enough for a team:

- **Teams** inside a workspace, each with its own key prefix, board and workflow.
- **Custom workflow states** per team, drawn as the team board's columns, and mapped so the
  agent engine, the trackers and every "is this done?" rule keep working unchanged.
- **Priority, estimates and due dates** made first-class for native tickets.
- **Sub-issues**, kept apart from epics and from agent steps.
- **Duplicate and related** handling on top of the existing link vocabulary.
- **Templates**, and **recurring tickets** fired by F1's automation clock.

Everything except the cloud-specific parts works on a **local workspace** too, with no account.

## What we have today

- **Statuses are a closed set.** `TaskStatus` (`packages/shared/src/model.ts:40`) mixes the
  human's states with the run's (`running`, `waiting-input`, `blocked-by-limit`).
  `MANUAL_STATUSES` (`model.ts:59`) is what a human may set; `task:setStatus` validates against it
  (`packages/shared/src/ipc.ts:671`).
- **Columns are a closed set.** `BoardColumn` (`model.ts:91`) and `BOARD_COLUMNS` (`model.ts:99`)
  are five values. `columnForStatus` / `statusForColumn` (`packages/shared/src/board.ts:137`,
  `:159`) map between the two. Column hiding is `hiddenBoardColumns` / `withColumnHidden` in
  `packages/shared/src/settings.ts`, and `visibleColumns` in
  `packages/ui/src/board/boardColumns.ts:49`.
- **The run borrows `status`.** `restingStatus` (`board.ts:131`) is what every board surface
  reads; `preRunStatus` (`model.ts`, on `Task`) remembers what the run borrowed. The rule is
  enforced in one place: `guardCardStatus` (`apps/client/src/main/cardStatusGuard.ts:59`), with
  `humanStatusPatch` (`:95`) as the human's way in. `isBoardCard` (`board.ts:114`) covers native
  tickets (`source === 'ticket'`) as well as the Personal board (memory
  *card-state-is-the-humans*).
- **Trackers already map foreign workflows onto the five columns.**
  `resolveStatusColumn` (`packages/shared/src/statusResolve.ts`) resolves a JIRA status by
  explicit map, learned map, name heuristic, then category; `linearCategory` folds Linear's six
  state types onto JIRA's three categories; `nativeStatusesByColumn`
  (`packages/shared/src/columnStatuses.ts`) is the native equivalent, a pure re-bucket of
  `columnForStatus`.
- **Priority is a name.** `priorityBucket` / `priorityRank` / `priorityIndicatorShown` in
  `packages/shared/src/priority.ts`; `DEFAULT_PRIORITIES` (`:24`) is the scale offered to
  internal cards. Native tickets store it in `externalPriority` and set it through
  `task:setPriority` (`ipc.ts:692`), whose JIRA write-back is keyed on `externalSource`
  (`TicketInput.priority` docstring, `model.ts:1414`). `PriorityGlyph.tsx` draws it, governed by
  `board.priorityDisplay`.
- **Estimates and dates exist.** `storyPoints`, `estimateDays`, `startAt`, `dueAt` on `Task`
  (`model.ts:1228-1235`), in `TicketInput` and `TicketPatch` (`model.ts:1456`). Nothing draws an
  overdue or due-soon state, and there is no per-team scale (points or days, Fibonacci or linear).
- **Three parent fields, three meanings, none of them a sub-issue.**
  - `parentTaskId` (`model.ts:850`): a **step** of an approved agent plan. `groupSubtasks`
    (`boardColumns.ts:129`) folds steps into the parent card and the chain runner executes them
    in order.
  - `epicTaskId` (`model.ts:1204`): the **epic** a ticket hangs under. Its docstring says why it is
    not `parentTaskId`: reusing that would turn every story into an executable step.
  - `externalParentKey`: a JIRA parent, read-only.
  - `IssueType` (`model.ts:638`) already includes `'subtask'`, but nothing gives a subtask a parent.
- **The link vocabulary** is `TicketLinkType` (`model.ts:648`) and `TICKET_LINK_VOCABULARY`
  (`packages/shared/src/ticketLinks.ts:32`): `blocks`, `duplicates`, `relates`, `implements`,
  `causes`, `clones`. Links gate nothing except `startReadiness` (`ticketLinks.ts:143`), which reads
  `blocks` and a blocker's `columnForTask`. Marking a duplicate today only adds a link; it does not
  close the ticket.
- **Keys** are allocated per ticket project by `createTicketTx` from `projects.ticketSeq`
  (`docs/12-the-ticket-model.md`, *Key allocation*); `ticketKey.ts` owns prefix rules.
  `idx_tasks_ticket_key` keeps keys unique. Moving a ticket to another project has no key story.
- **A ticket project is already a team in all but name.** A plan-less `projects` row with a
  `ticketPrefix` owns a board and an allocator (`ownsTickets`, `model.ts:156`). There is no
  workspace above it and no per-project workflow.
- **Templates:** none for tickets. `promptTemplates.ts` (F7) is agent prompt text, not tickets.
- **Automations** (F1, shipped): `Automation`, `AutomationAction`, `TrackerTrigger` in
  `packages/shared/src/automation.ts`. Every action requires an `agentProjectId` and starts a run;
  there is no "create a ticket and stop". Tracker triggers watch `TRACKER_SOURCES = ['jira',
  'github']` (`automation.ts:21`) through `detectTrackerEvents`
  (`packages/shared/src/automationTracker.ts:52`), which diffs `externalStatus`. Native tickets
  cannot fire anything. Only the owning desktop fires (`ownerClientId`, F1 *Ownership*).
- **Cloud:** the task row is mirrored whole as JSON (`MirrorDelta`,
  `packages/protocol/src/wire.ts`; `apps/server/src/mirror/*`); milestones, labels and links are
  relayed, not mirrored. F19 replaces this with server-authoritative ticket tables for cloud
  workspaces.

## Design

### Teams

- **On a local workspace, a team IS today's ticket project.** The `projects` row with a
  `ticketPrefix` already has a key prefix, an allocator and a board, so the UI calls it a team
  and nothing is migrated. Plan projects and the Personal board are not teams.
- **On a cloud workspace**, F19's server tables gain `teams` (`id, workspaceId, name, keyPrefix,
  keySeq, estimateScale, cycle cadence fields reserved for F24, archivedAt`). Key allocation is
  F19's server allocator, keyed per team rather than per workspace. Publishing a local workspace
  turns each ticket project into a team with the same prefix and keeps every number.
- **Moving a ticket to another team re-keys it**, because a key names the team it belongs to.
  The old key is kept as an **alias** in `ticket_key_aliases (key, taskId)`, so a branch name,
  commit message or note that says `WEB-12` still resolves after the move to `API-40`. Aliases
  are never re-issued: the old team's allocator never goes backwards anyway. Search, deep links
  and `@needs`-style key lookups consult aliases after keys.
- A team has **members** in a cloud workspace (F19's roles apply); on a local workspace every
  team is yours.

### Workflow states

- **`WorkflowState`** in `packages/shared/src/model.ts`:
  `{ id, teamId, name, category: StateCategory, position, color: string, description, createdAt,
  archivedAt: number | null }`.
- **`StateCategory`** = `'backlog' | 'unstarted' | 'started' | 'review' | 'blocked' |
  'completed' | 'canceled'`. Seven, fixed, and every rule outside the workflow editor reads the
  category, never the name. It maps two ways, both total and both in one new
  `packages/shared/src/workflowStates.ts`:

  | Category | Board column (`BoardColumn`) | Base status (`ManualStatus`) |
  | --- | --- | --- |
  | `backlog` | `todo` (hidden from the board by default) | `pending` |
  | `unstarted` | `todo` | `pending` |
  | `started` | `in-progress` | `in-progress` |
  | `review` | `in-review` | `in-review` |
  | `blocked` | `blocked` | `blocked` |
  | `completed` | `done` | `done` |
  | `canceled` | `done` | `cancelled` |

- **`Task.stateId: string | null`**, native tickets only. Null everywhere else: the Personal
  board, plan projects and tracker mirrors keep their fixed statuses.
- **`status` stays the engine's field; `stateId` is the human's.** The invariant is
  `restingStatus(task) === baseStatus(state.category)`. Every engine rule that asks "is it done?"
  (`startReadiness`, chain `after-done` gates, F11/F24 rollovers, `columnForTask`) keeps reading
  `status` and stays correct with no change. A run still borrows `status` and never touches
  `stateId`, so the card stays in its state column while the agent works, exactly as today
  (memory *card-state-is-the-humans*).
- **One way in.** `humanStatusPatch` (`cardStatusGuard.ts:95`) gains a sibling,
  `humanStatePatch(task, state)`, that writes `stateId` and the base status, putting the status
  into `preRunStatus` when a run holds the field, as `humanStatusPatch` already does. The old
  channels keep working: `task:setStatus` / `task:move` on a ticket pick the team's **default
  state for that status** (the lowest-positioned state of the matching category) unless the
  ticket's current state already has that base status. `guardCardStatus` refuses any patch that
  writes `stateId` from a run path.
- **Default workflow.** A team created (or backfilled) gets six states named and ordered exactly
  as today's columns: To Do (`unstarted`), In Progress (`started`), In Review (`review`), Blocked
  (`blocked`), Done (`completed`), Cancelled (`canceled`). The board looks identical until the
  team edits its workflow. Backfill sets each ticket's `stateId` from its resting status.
- **Editing rules** (pure, refusals as values like `TicketLinkRefusal`):
  - every category except `backlog`, `review` and `blocked` keeps at least one state, so a
    ticket can always be started, finished and cancelled;
  - deleting a state that tickets sit in asks for a target state of the **same base status**
    (any category with the same `ManualStatus`), so no ticket changes column meaning;
  - renaming and reordering never touch tickets;
  - a state's category is fixed once tickets use it (delete-and-move instead).
- **The board.** On a single-team board scope, the board draws **one column per state** in
  `position` order, grouped by category (mockup `mockups/v9-7-board-light.svg`). Backlog-category
  states are hidden by default and shown from the board's display menu. On a scope that holds
  several teams, or the Personal board, the board folds back to today's five category columns,
  because two teams' "QA" columns are not the same column. `hiddenBoardColumns` keeps working at
  category level; per-state hiding is a team setting in the workflow editor. A state's `color` is
  drawn as the column header's small status glyph only, never as a card fill (memory
  *board-colour-budget*).
- **Trackers are untouched.** JIRA, GitHub and Linear cards never get a `stateId`;
  `resolveStatusColumn` and the learned maps still decide their column.

### Mapping states onto the agent engine

The engine never **writes** a state. It may **react** to one, and only through rules a human
configured:

- **F1 tracker triggers learn native tickets.** `TRACKER_SOURCES` gains `'ticket'` and
  `TRACKER_EVENT_KINDS` gains `'entered-state'` (`TrackerTrigger.stateId`). `detectTrackerEvents`
  diffs `stateId` for native tickets in the same before/after shape it already uses for
  `externalStatus`. The ticket store write that changes `stateId` hands its before/after to the
  same firing path the tracker syncs use (`automationTrackerFirings.ts`). So "when a ticket enters
  *Ready for agent*, hand it to the agent on repo X" is one automation, and the run it starts
  still leaves the card in *Ready for agent*.
- **Run readiness reads categories.** `startReadiness` and chain gates already read
  `columnForTask`, which is derived from status, which is derived from the state's category. No
  engine change.
- **Moving a ticket on PR/MR events** (merged → Done) is F26's opt-in rule, routed through
  `humanStatePatch` as a configured automation, not an engine side effect. F21 only provides the
  state vocabulary it targets.

### Priority, estimates, due dates

- **Priority** keeps `externalPriority` and `DEFAULT_PRIORITIES` (a name, bucketed by
  `priorityBucket`). F21 adds an explicit **No priority** choice in every native picker and a
  priority sort and filter on the backlog. No new scale and no per-team scale: one vocabulary
  across the app is the reason `priority.ts` exists.
- **Estimates:** a team setting `estimateScale: 'off' | 'points-fibonacci' | 'points-linear' |
  'tshirt' | 'days'`. Points and t-shirt sizes store in `storyPoints` (t-shirt XS–XL map to
  1/2/3/5/8 and display as letters); `days` uses `estimateDays`. `off` hides the field. The
  stored number never changes when the scale changes; only the picker and the label do.
- **Due dates:** `dueAt` gains a computed `dueState(task, now)` = `'none' | 'later' | 'soon' |
  'today' | 'overdue'` (whole local days, `soon` = within 2 days), shown on rows, cards and the
  panel. `today` and `overdue` use the orange attention token, the only colour a due date gets;
  `later` and `soon` are monochrome text. A ticket in a `completed`/`canceled` state is never
  overdue.

### Sub-issues

- **`Task.parentIssueId: string | null`**: a native ticket broken out of another native ticket.
  A fourth parent field, deliberately apart from the other three:

  | Field | Means | Executed? | Shown as |
  | --- | --- | --- | --- |
  | `parentTaskId` | step of an agent plan | yes, in order | inside the card |
  | `epicTaskId` | belongs to an epic | no | epic band / tree |
  | `externalParentKey` | JIRA's parent | no | chip |
  | `parentIssueId` (new) | sub-issue of a ticket | no, each is its own card | own card + parent's progress |

- Rules in `packages/shared/src/subIssues.ts`: the parent must be a native, non-epic ticket in
  the same workspace (it may be another team's); no cycles; **depth 2** (a sub-issue may not have
  sub-issues of its own in v1); an epic stays the grouping above both. A sub-issue inherits the
  parent's epic, milestone and team on creation only, then lives on its own.
- **Progress** `subIssueProgress(parent, children)` counts children by category (completed vs
  open, canceled excluded), shown on the parent row and card as `2/5`. The parent's state never
  changes on its own when the last child closes (memory *card-state-is-the-humans*); F26 may offer
  that as an opt-in rule.
- A sub-issue is a board card in its own right. `groupSubtasks` keeps folding **steps** only.
- An agent run on a parent does not run its sub-issues; each is delegated separately.

### Relations: duplicates and related

- The vocabulary in `ticketLinks.ts` keeps its six types; F21 extends what two of them **do**,
  and adds one resolution field:
  - **Mark as duplicate of…** writes a `duplicates` link (this → original) and moves the ticket to
    the team's first `canceled` state with `Task.resolution = 'duplicate'` (new, nullable:
    `'duplicate' | 'wont-do' | null`), all in one transaction. Undo removes both. In F22 the
    duplicate's subscribers are added to the original.
  - **Related** gets a one-click "Link as related" from the panel's search results and a
    symmetric display, as the vocabulary already defines.
  - Sub-issues are **not** links: they are a field, because a ticket has one parent and the tree
    needs ordering. `docs/12-the-ticket-model.md`'s *link vocabulary* section says so.
- Links in a cloud workspace are append-only rows (add / remove as tombstone), per the decision
  for links and comments; F21 only adds the `resolution` field, which is field-level LWW.

### Templates

- **`IssueTemplate`**: `{ id, teamId, name, title, description, issueType, priority,
  labels, estimate, stateId, subIssues: { title, description }[], createdAt, updatedAt }`, stored
  in `issue_templates` (cascade from the team). `title` and `description` may use the same
  placeholders F1 renders (`{{date}}`, `{{time}}`, `renderAutomationTemplate`), so one template
  serves both the New ticket dialog and a recurring automation.
- Applying a template creates the ticket and its sub-issues in one transaction. Fields the human
  typed win over the template's.
- Distinct from F7's prompt templates (agent instructions) and F8 workflows (agent chains).

### Recurring tickets via F1

- `AutomationAction` becomes a union on `kind`: today's action (implicit `kind: 'run'`, the
  default when the field is absent so stored rows read unchanged) and a new
  `{ kind: 'create-ticket'; teamId; templateId; handToAgent?: AssignAgentInput }`. A schedule
  trigger with `create-ticket` creates a ticket from the template at each occurrence and starts
  nothing, unless `handToAgent` is set.
- `validateAutomation` gains the rules for the new kind (team and template exist; `mode` checks
  only when handing to an agent). The receipt keeps F1's idempotency key
  (`schedule:<iso>`), so a re-armed clock cannot create the same week's ticket twice.
- **Who fires it.** On a local workspace, the owning desktop, as for every F1 automation. On a
  cloud workspace, the **server** fires ticket-only recurring automations (F21.18), because
  tickets are server-authoritative and the web must work with no desktop running; a
  `handToAgent` firing is then delivered to the owning desktop like any F20 agent assignment.
- Typecheck will not find every place that assumes an action has an `agentProjectId`; grep for
  `action.agentProjectId` and `.action.` across `apps/client/src/main/automation*` and
  `packages/ui/src/automations/` (memory *phase24-tickets-design*: typecheck does not find
  widening sites).

### Server & relay

- New channels, all `'relay'` in `packages/shared/src/ipcRelay.ts` (`ipc-relay-coverage.test.ts`
  fails until they are): `workflowState:list|save|remove|reorder`, `task:setState`,
  `issueTemplate:list|save|remove`, `ticket:createFromTemplate`, `ticket:markDuplicate`,
  `ticket:setParent`, `ticket:moveToTeam`. Events `workflowState:changed` and `issueTemplate:changed`,
  `'replace-last'` in `ipcEventFanout.ts`.
- On a cloud workspace these become F19 replica writes (local apply + outbox + server
  authority), not relayed invokes: states, templates and teams are server rows, field-level LWW
  on edits. The server's ticket write path enforces the same pure rules (it imports
  `@tm/shared`'s `workflowStates.ts` and `subIssues.ts`), so a stale desktop cannot write an
  invalid state or a sub-issue cycle.
- `stateId`, `parentIssueId` and `resolution` are fields on the ticket row and sync with it.

### UI — desktop

Copy the real components; do not redraw them (memory *mock-the-real-components*). v9 glass shell
from F13.

- **Board** (`KanbanColumn.tsx`, `MyTasks.tsx`): state columns on a team scope, category columns
  otherwise; a drop on a state column calls `task:setState`. The optimistic patch mirrors
  `humanStatePatch` (memory *card-state-is-the-humans*: `optimisticMove` must not paint over a
  running card's `status`).
- **Workflow editor**: a new `packages/ui/src/projects/WorkflowEditor.tsx` in the team's settings
  (next to `LabelRegistry.tsx` / `MilestoneList.tsx`): states grouped by category, drag to
  reorder, rename inline, add, delete-with-target dialog, per-state "show on board".
- **Panel and drawer** (`TicketDrawer.tsx`, F12's panel): State picker (states of the team, by
  category), priority with No priority, estimate per team scale, due date with `dueState`, Parent
  and Sub-issues section with progress and "Add sub-issue", Mark as duplicate.
- **New ticket dialog** (`NewTicketDialog.tsx`): Template picker; "Create more" keeps the
  template.
- **Backlog** (`BacklogTable.tsx`): sub-issues indent under their parent within the epic group;
  priority, estimate and due columns sortable.
- **Automation editor** (`packages/ui/src/automations/`): an action kind switch, *Run an agent*
  / *Create a ticket*, and a *When a ticket enters state* trigger for native tickets.

### UI — web

All of the above lives in `packages/ui` and renders unchanged in `apps/web` (memory
*web-mirrors-the-desktop*). On a cloud workspace the web reads the server directly (F19) and needs
no desktop for any F21 feature; on a local workspace published nowhere, the web has nothing to
show, as today.

### Failure modes & edge cases

- **A run is in flight when the human changes state.** `humanStatePatch` writes `stateId` now and
  the base status into `preRunStatus`; the run keeps `status`; when it settles, the guard hands
  back the new base status. Same round-trip test as v0.51.1's mid-run move.
- **A state is deleted on one device while another device moves a ticket into it.** Local: the
  delete transaction re-points tickets first, and `task:setState` refuses an archived or missing
  state with a readable error. Cloud: the server rejects the write; the replica re-applies the
  server's row and the outbox entry parks with that reason (a gate that refuses must PARK).
- **`stateId` and `status` disagree** (an older desktop wrote `status` only, or a hand-edited DB):
  readers trust `stateId` when it belongs to the ticket's team and its base status equals the
  resting status; otherwise the store repairs `stateId` to the default state for the status on
  next write, and the board reads the column from `status`. Never the other way round: `status`
  is what the engine acted on.
- **A ticket moves team while a run holds it.** Refused while running, like `task:assignAgent`
  is; the panel says "Stop the run to move it to another team".
- **Old key in a branch name after a team move:** alias lookup resolves it; the branch itself is
  never renamed.
- **Sub-issue whose parent is deleted:** `parentIssueId` is cleared in the delete transaction
  (no foreign key, as for `epicTaskId`; `docs/12`, *The schema*), and the children become plain
  tickets.
- **Recurring automation whose template was deleted:** the firing records `refused` with "Template
  no longer exists" and F1's three-strikes rule disables it with an attention item.
- **Estimate scale changed:** stored numbers stay; a t-shirt scale shows the nearest size for a
  number that has no letter (e.g. 13 → XL).

## Out of scope (v1)

- Per-team custom fields beyond the ones listed here (F27's fine-grained model may add them).
- Workflow transition rules (who may move from which state to which); any state may follow any.
- Automatic parent state from children, and automatic state changes on PR/MR events (F26).
- Sub-issues more than one level deep; sub-issues across workspaces.
- Per-team priority scales.
- Recurring tickets on a calendar rule richer than F1's `ScheduleShape` (monthly, "last
  Friday").
- Native workflow states for JIRA/GitHub/Linear mirrors; their columns stay resolver-driven.

## Open questions

1. **Is a team a new entity on a local workspace, or today's ticket project?** *Recommended
   default:* today's ticket project, relabelled. It already has prefix, allocator and board, and
   a second record would need a migration for no behaviour.
2. **Do states replace the five columns or map onto them?** *Recommended default:* both, by
   scope: a single-team board shows state columns, anything wider folds to the five categories.
   One state per column on a cross-team board would show two unrelated "QA" columns side by side.
3. **Should the engine ever write a state** (e.g. "In Progress" when an agent starts)?
   *Recommended default:* no. The user's rule is that a run never moves a card; reactions to
   states go through F1 triggers, and moves on PR events are F26's opt-in rules.
4. **Is "backlog" a state or a separate list?** *Recommended default:* a state category, hidden
   from the board by default, so the backlog and the board are one model and triage (F26) can
   target it.
5. **Who fires recurring tickets in a cloud workspace?** *Recommended default:* the server, for
   ticket-only automations; the owning desktop for anything that hands to an agent. Otherwise a
   weekly ticket silently fails to appear whenever its creator's laptop is shut.
6. **What does a team move do to the key?** *Recommended default:* re-key and keep the old key as
   an alias, because a key names its team; keeping the old key would make two teams share a
   prefix space.
7. **Does Mark as duplicate cancel the ticket?** *Recommended default:* yes, into the first
   `canceled` state with `resolution = 'duplicate'`, undoable as one step.

## Tasks

### F21 · Phase 1 — Contracts and pure rules

- [ ] F21.1 Add the workflow state, sub-issue, resolution and template contracts

  - In `packages/shared/src/model.ts`: `StateCategory`, `WorkflowState`, `WorkflowStateInput`,
    `IssueTemplate`, `IssueTemplateInput`, `TicketResolution`; `stateId`, `parentIssueId` and
    `resolution` on `Task`, `TicketInput` and `TicketPatch`; `estimateScale` on `Project` (team
    setting). `ticketFields.ts`'s `draftFromTicket` / `ticketPatchFrom` carry the new fields.
  - Acceptance: `pnpm typecheck` green across the workspace; a round-trip test in
    `ticketFields.test.ts`; a grep of `source === 'ticket'` sites recorded in the PR so the
    widening is visible (typecheck will not find them).

- [ ] F21.2 Write the pure workflow state rules in packages/shared @needs: F21.1 Add the workflow state, sub-issue, resolution and template contracts

  - New `packages/shared/src/workflowStates.ts`: `categoryColumn`, `categoryBaseStatus`,
    `defaultWorkflow(teamId)`, `defaultStateFor(states, status)`, `stateRefusal` (delete,
    category change, last-of-category), `orderStates`, `dueState(task, now)` and the
    estimate-scale display helpers.
  - Acceptance: `workflowStates.test.ts` covers both mapping tables totally (every category,
    every manual status), the delete refusals, the default-state pick when several states share
    a category, `dueState` across midnight and for completed tickets, and t-shirt display of an
    off-scale number.

- [ ] F21.3 Write the sub-issue and duplicate rules in packages/shared @needs: F21.1 Add the workflow state, sub-issue, resolution and template contracts

  - New `packages/shared/src/subIssues.ts`: `canSetParent` (native, non-epic, no cycle, depth 2,
    same workspace) returning a refusal value, `subIssueProgress`, and `duplicatePlan(ticket,
    original, states)` returning the link, state and resolution to write.
  - Acceptance: tests for self-parent, cycle, depth-3, epic parent, cross-team parent (allowed),
    progress with canceled children excluded, and that `duplicatePlan` picks the first
    `canceled` state by position.

### F21 · Phase 2 — Store and engine

- [ ] F21.4 Add the workflow_states table, the new ticket columns and their backfill @needs: F21.2 Write the pure workflow state rules in packages/shared

  - In `apps/client/src/main/store.ts`: `workflow_states` (cascade from `projects`),
    `idx_workflow_states_team`; `stateId`, `parentIssueId`, `resolution` in the guarded task
    column loop with indexes; `estimateScale` in the `projects` ALTER loop; `ticket_key_aliases`;
    a one-time backfill that seeds `defaultWorkflow` for every ticket project and sets each
    ticket's `stateId` from its resting status. `taskToRow` / `rowToTask` and the task `INSERT`
    carry the columns.
  - Acceptance: the store has no tests (memory *the-store-has-no-tests*), so use the
    electron-as-node recipe: snapshot a real DB with the backup API, open with `createStore`
    twice (second open is a no-op), drop the new columns and table, reopen to exercise the ALTER
    and backfill path. Every ticket has a `stateId` whose base status equals its resting status;
    row counts are equal before and after.

- [ ] F21.5 Route every human status write on a ticket through its workflow state @needs: F21.4 Add the workflow_states table, the new ticket columns and their backfill

  - `humanStatePatch` beside `humanStatusPatch` in `cardStatusGuard.ts`; `guardCardStatus`
    strips any `stateId` from run-path patches; `task:setStatus` and `task:move` on a ticket pick
    `defaultStateFor` unless the current state already has that base status; store methods
    `listWorkflowStates`, `saveWorkflowState`, `removeWorkflowState(id, targetId)` (one
    transaction re-pointing tickets), `reorderWorkflowStates`, `setTicketState`.
  - Acceptance: unit tests in `cardStatusGuard.test.ts` for a mid-run state change (the run keeps
    `status`, `preRunStatus` takes the new base status, the guard hands it back on settle) and
    for a run patch carrying `stateId` being stripped; a `scripts/verify-workflow.mjs` scenario on
    a temp DB that moves tickets through custom states and deletes a used state, asserting no
    ticket's resting status changed meaning. Prove it can fail by mutation (memory
    *headless-scenario-harness-traps*).

- [ ] F21.6 Add issue templates and sub-issue writes to the store @needs: F21.4 Add the workflow_states table, the new ticket columns and their backfill, F21.3 Write the sub-issue and duplicate rules in packages/shared

  - `issue_templates` table (cascade from the team); `listIssueTemplates`, `saveIssueTemplate`,
    `removeIssueTemplate`; `createTicketFromTemplate` (ticket plus sub-issues in one
    transaction, allocator bumped once per ticket); `setParentIssue` checked by `canSetParent`;
    `markDuplicate` applying `duplicatePlan` in one transaction; `deleteTaskDeep` clears
    `parentIssueId` on children.
  - Acceptance: `verify-workflow.mjs` extended: a template with three sub-issues issues four
    consecutive keys; a cycle is refused; deleting a parent leaves children with
    `parentIssueId = null`; mark-as-duplicate and its undo restore the exact previous state.

- [ ] F21.7 Add the workflow, template and sub-issue IPC channels and their relay classification @needs: F21.5 Route every human status write on a ticket through its workflow state, F21.6 Add issue templates and sub-issue writes to the store

  - Channels `workflowState:list|save|remove|reorder`, `task:setState`,
    `issueTemplate:list|save|remove`, `ticket:createFromTemplate`, `ticket:markDuplicate`,
    `ticket:setParent` in `packages/shared/src/ipc.ts` and `apps/client/src/main/ipc.ts`; all
    `'relay'` in `ipcRelay.ts`; `workflowState:changed` and `issueTemplate:changed` as
    `'replace-last'` in `ipcEventFanout.ts`; `project:tasksChanged` after writes.
  - Acceptance: `test/ipc-relay-coverage.test.ts` and the fanout test pass; handler tests that
    each refusal (last state of a category, cycle, archived state) comes back as a readable
    error.

### F21 · Phase 3 — Board and ticket UI

- [ ] F21.8 Draw one board column per workflow state on a single-team board @needs: F21.7 Add the workflow, template and sub-issue IPC channels and their relay classification

  - Pure `stateColumns(scope, states, hidden)` in `packages/ui/src/board/` deciding state columns
    versus category columns; `KanbanColumn.tsx` takes a state header; drops call `task:setState`;
    `optimisticMove` mirrors `humanStatePatch`; the display menu shows backlog states. Layout per
    `mockups/v9-7-board-light.svg`.
  - Acceptance: selector tests for a one-team scope (state columns in position order), a
    two-team scope and the Personal board (five category columns), hidden states, and a running
    card staying in its state column; `pnpm build` green; a headless smoke check (memory
    *verify-electron-app*, never launch the user's app) renders a seeded team with a custom
    "QA" state.

- [ ] F21.9 Edit a team's workflow in the team settings @needs: F21.7 Add the workflow, template and sub-issue IPC channels and their relay classification

  - `packages/ui/src/projects/WorkflowEditor.tsx`: states grouped by category, reorder, rename,
    add, per-state board visibility, delete with a same-base-status target picker; mounted in
    `ProjectAdmin.tsx` for ticket projects, labelled as the team's workflow.
  - Acceptance: a pure `workflowEditorState.ts` with tests for every refusal surfacing inline and
    for reorder producing contiguous positions; the shared component renders on the web build.

- [ ] F21.10 Show priority, estimates and due dates per the team's scale @needs: F21.7 Add the workflow, template and sub-issue IPC channels and their relay classification

  - No priority choice and priority sort/filter in `BacklogTable.tsx`; the team `estimateScale`
    setting in `ProjectAdmin.tsx`; estimate pickers per scale in the panel and drawer; `dueState`
    on rows, cards and the panel with orange only for today/overdue (memory
    *board-colour-budget*).
  - Acceptance: tests for the scale pickers' value mapping and for `backlogView.ts` sorting by
    priority and due date; a card snapshot test that `later`/`soon` draw no colour.

- [ ] F21.11 Add sub-issues to the ticket panel, the board and the backlog @needs: F21.7 Add the workflow, template and sub-issue IPC channels and their relay classification

  - Panel section Parent / Sub-issues with progress and Add sub-issue (inherits epic, milestone
    and team at creation); `2/5` progress on the parent's row and card; sub-issues indent under
    their parent in `backlogView.ts`; `groupSubtasks` untouched so steps still fold and
    sub-issues do not.
  - Acceptance: `backlogView.test.ts` cases for nesting inside an epic group and for a parent in
    another epic; `boardColumns.test.ts` proving a sub-issue is its own card while a step is
    not.

- [ ] F21.12 Add Mark as duplicate and document the extended link vocabulary @needs: F21.7 Add the workflow, template and sub-issue IPC channels and their relay classification

  - Panel action Mark as duplicate of… (ticket search) and its undo toast; Link as related from
    the same search; `resolution` shown in the panel header. Update `docs/12-the-ticket-model.md`
    *The link vocabulary* with the duplicate resolution, and why sub-issues are a field, not a
    link.
  - Acceptance: a UI-state test that undo issues the inverse writes; the doc table lists every
    type and the resolution; `pnpm build` green.

- [ ] F21.13 Create tickets from a template @needs: F21.7 Add the workflow, template and sub-issue IPC channels and their relay classification

  - A Templates section in the team settings (list, edit, delete); a template picker in
    `NewTicketDialog.tsx` that prefills fields and lists the sub-issues it will create; typed
    fields win over the template's.
  - Acceptance: a pure `templateApply.ts` with tests for field precedence and placeholder
    rendering via `renderAutomationTemplate`; headless smoke check creating a ticket with two
    sub-issues from a template.

### F21 · Phase 4 — Automations

- [ ] F21.14 Fire automations when a native ticket enters a workflow state @needs: F21.5 Route every human status write on a ticket through its workflow state

  - `'ticket'` in `TRACKER_SOURCES`, `'entered-state'` with `stateId` in `TrackerTrigger`;
    `detectTrackerEvents` diffs `stateId` for native tickets; `setTicketState` and `task:move`
    hand before/after to the firing path in `automationTrackerFirings.ts`; the automation editor
    offers *When a ticket enters state*.
  - Acceptance: `automationTracker.test.ts` cases for entering, re-entering and an unchanged
    state; an end-to-end run with a stub `claude` on PATH (memory *stub-claude-on-path*) that
    moves a ticket into "Ready for agent", sees one run start, and asserts the ticket's
    `stateId` is unchanged after the run settles.

- [ ] F21.15 Create recurring tickets from a schedule automation @needs: F21.6 Add issue templates and sub-issue writes to the store, F21.14 Fire automations when a native ticket enters a workflow state

  - `AutomationAction` becomes a union with `kind: 'create-ticket'` (absent kind reads as
    `'run'`); `validateAutomation` rules; `automationRunner.ts` creates the ticket from the
    template and optionally delegates; the editor's action-kind switch; grep every
    `action.agentProjectId` site and list them in the PR.
  - Acceptance: `automation.test.ts` reading an old stored action unchanged; runner tests that a
    firing creates exactly one ticket per occurrence key, that a catch-up creates one (not one
    per missed week), and that a deleted template refuses and counts as a strike.

### F21 · Phase 5 — Teams and the cloud workspace

- [ ] F21.16 Present ticket projects as teams and move tickets between teams @needs: F21.7 Add the workflow, template and sub-issue IPC channels and their relay classification

  - UI labels ticket projects as teams (sidebar, pickers, settings) without renaming any code or
    column; `ticket:moveToTeam` re-keys through the target allocator, writes the old key to
    `ticket_key_aliases`, maps the state to the target's `defaultStateFor` its base status, and is
    refused while a run holds the ticket; key lookups (search, deep links) consult aliases.
  - Acceptance: `verify-workflow.mjs` moves a ticket and resolves it by its old key; a second
    move keeps both aliases; the handler refuses mid-run with a readable reason.

- [ ] F21.17 Carry teams, workflow states, templates and the new ticket fields through the cloud workspace @needs: F21.16 Present ticket projects as teams and move tickets between teams, F21.15 Create recurring tickets from a schedule automation

  - Server entities and a TypeORM migration in `apps/server/src/migrations/` for `teams`,
    `workflow_states`, `issue_templates`, `ticket_key_aliases`; the server ticket write path
    validates with `@tm/shared`'s `workflowStates.ts` and `subIssues.ts`; F19's replica sync
    carries them down and the outbox carries edits up (field-level LWW); publish maps each local
    ticket project to a team with the same prefix and numbers; per-team key allocation.
  - Acceptance: server tests for a rejected invalid state write and a sub-issue cycle; a sync
    test that two desktops editing different fields of one ticket both win; a publish test that
    keys, states and aliases survive unchanged.

- [ ] F21.18 Fire recurring tickets on the server for cloud workspaces @needs: F21.17 Carry teams, workflow states, templates and the new ticket fields through the cloud workspace

  - A server-side schedule evaluator for `create-ticket` automations in cloud workspaces, reusing
    `automationSchedule.ts` and the receipt idempotency key; `handToAgent` firings delivered to
    the owning desktop as an F20 assignment; desktops skip firing these automations in a cloud
    workspace.
  - Acceptance: server tests that two server instances racing on one occurrence create one
    ticket (unique receipt), and that a desktop with a cloud workspace never fires a
    `create-ticket` automation itself.

- [ ] F21.19 Verify the issue model end to end and document it @needs: F21.8 Draw one board column per workflow state on a single-team board, F21.9 Edit a team's workflow in the team settings, F21.10 Show priority, estimates and due dates per the team's scale, F21.11 Add sub-issues to the ticket panel, the board and the backlog, F21.12 Add Mark as duplicate and document the extended link vocabulary, F21.13 Create tickets from a template, F21.18 Fire recurring tickets on the server for cloud workspaces

  - Extend `scripts/verify-workflow.mjs` across the IPC layer (custom states, a run that must not
    move the card, a template, a duplicate, a team move, a recurring firing); add *Workflow
    states*, *Sub-issues*, *Templates* sections to `docs/12-the-ticket-model.md` and glossary
    entries in `docs/05-glossary.md`.
  - Acceptance: the script fails when `humanStatePatch`, the run-path `stateId` strip or the
    alias lookup is mutated, and passes as written; `pnpm typecheck`, `pnpm test`, `pnpm build`
    green with `--force` (memory *a-cached-gate-is-not-a-gate*).
