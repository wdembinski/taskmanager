# F24 — Planning

> **Status:** proposed · **Where:** client (desktop main + `packages/ui`), server, web · **Depends on:** F19 (cloud parts), F21 (teams and workflow state categories), F14 (archiving), F22 (soft: status-update reminders and history) · **Supersedes:** most of F11 (see *What happens to F11*) · **Unlocks:** F25 (cycle and project insights), F26 (auto-archive rules)
> Only the `- [ ]` checkboxes under **Tasks** become cards when this file is imported as a plan; everything else is context.
>
> **Layout rule for this file:** every task's description bullets sit after a **blank line**. The plan
> parser folds any indented line that directly follows a checkbox into that task's *title*
> (`apps/client/src/main/planParser.ts:173-177`); the blank line is what keeps descriptions out of it.

## Why

The tracker can say what a ticket is and where it stands (F21), but not **when** the team means to
do it or **why** it matters beyond the ticket itself. Milestones are dated instants with no span;
there are no time boxes at all for native tickets; and the only bigger-than-an-epic unit is the
milestone. A team lead cannot answer "what are we doing this fortnight", "is the billing project
on track", or "what does the next quarter look like" from the app.

F24 adds the planning layer, in increasing size:

- **Cycles**: automatic, repeating time boxes per team, with unfinished work rolling forward.
  They replace F11's manual sprints.
- **Milestones with date ranges** (carried over from F11).
- **Projects**: a body of work with a lead, members, dates, status and progress, spanning teams.
- **Initiatives**: a group of projects towards one goal.
- **Status updates with health** on projects and initiatives.
- **A roadmap**: today's per-team Gantt extended to initiatives, projects, milestones and cycles.

Completed cycles and projects are archived with F14's rules. Everything works on a local workspace;
the cloud adds sharing and a server-side cycle clock.

## What we have today

- **F11 is planned, not built.** `git log --oneline | grep -i "f11\."` returns nothing; the only
  F11 commits are the plan itself (`ea31215`, `38d9d0e`). There is no `packages/shared/src/sprints.ts`,
  no `dateRange.ts`, no `sprints` table, no `sprintId` on `Task` and no `Milestone.startAt`
  (`Milestone`, `packages/shared/src/model.ts:1320`, has `dueAt` only). So nothing has to be
  migrated away from; the question is only which F11 designs survive.
- **JIRA's sprint switch** is `jira.currentSprintOnly` (`packages/shared/src/settings.ts:63`,
  default at `:158`), a filter on the JIRA fetch. `currentSprintName` (`packages/ui/src/board/currentSprint.ts:27`)
  names the JIRA sprint in the status bar. Card chip: `task.externalSprint`.
- **Milestones** are per ticket project (per team after F21): `milestones` table
  (`apps/client/src/main/store.ts:1727`), channels `milestone:list|save|remove` (`'relay'`,
  `packages/shared/src/ipcRelay.ts:187-189`), UI `packages/ui/src/projects/MilestoneList.tsx`.
  `tasks.milestoneId` has no foreign key (`docs/12-the-ticket-model.md`, *The schema*).
- **The Gantt** is per ticket project: `packages/ui/src/projects/TimelinePane.tsx` (1,345 lines)
  over the pure `ganttLayout.ts`: `ganttRange` (`:130`, widened by milestone `dueAt`),
  `ganttScale` (`:159`), `ganttTicks` (`:176`, day ticks and month bands), `ganttRows` (`:262`,
  grouped by epic), `ganttEpicBands` (`:325`), `ganttMarkers` (`:342`, milestones as vertical
  lines drawn by `GanttHeader.tsx`), `todayX` (`:355`), and the drag helpers `snapToDay`,
  `clampSpan`, `rescheduleTo` (`:439-483`). `Projects.tsx` switches Backlog/Timeline for one
  project.
- **"Project" already means something.** `Project` (`model.ts:201`) is a repo/plan project, a
  ticket project (a team after F21), or the Personal board. The rail has a *Projects* tab
  (`apps/client/src/renderer/src/App.tsx:119`) that manages them. A planning project is a
  different thing and needs a different code name (open question 1).
- **Progress inputs exist:** `storyPoints` / `estimateDays` on tickets, F21's state categories,
  F21's sub-issues, epics via `epicTaskId`.
- **A clock pattern exists:** `apps/client/src/main/automationClock.ts` (F1.8), one capped
  `setTimeout`, re-evaluated on boot and `powerMonitor` resume, all dependencies injected.
- **Archiving** comes from F14 (milestones and epics, `archivedAt`, hidden everywhere but the
  sidebar's *Archived* entry and "include archived" search, restore in one click, optional
  auto-archive off by default).

### What happens to F11

| F11 task | Fate in F24 |
| --- | --- |
| F11.1 Sprint contract, F11.2 sprint rules | **Superseded** by F24.4 / F24.5 (cycles: per team, generated from a cadence, no manual start/complete) |
| F11.3 current-sprint card filter | **Carried over, renamed**: `currentCycleCards` in F24.8 keeps every rule (no-current fallback keeps all cards, steps follow parents, trackers pass through, "N hidden · 1 needs you") |
| F11.4 sprints table, F11.5 store and complete transaction | **Superseded** by F24.6 (cycles table plus a clock that closes and rolls over) |
| F11.6 settings fold | **Carried over, retargeted**: `jira.currentSprintOnly` folds into `board.currentCycleOnly` (F24.8) |
| F11.7 sprint IPC, F11.8 mirror | **Superseded** by F24.7 (local) and F24.18 (server-authoritative via F19) |
| F11.9 Backlog sprint sections, F11.10 drawer field | **Superseded** by F24.9 (cycle sections without Start/Complete buttons; a Cycle field) |
| F11.11 board toggle, F11.12 web | **Carried over** into F24.8 (shared `packages/ui`, so the web comes with it) |
| F11.13 verification | **Superseded** by F24.19 |
| F11.14 date-range rules + milestone `startAt` contract | **Carried over as written**: F24.1 |
| F11.15 milestone `startAt` column + validation | **Carried over as written**: F24.2 |
| F11.16 milestone start date in the list | **Carried over as written**: F24.3 |
| F11.17 milestone and sprint bands on the timeline | **Carried over, extended**: F24.14 (milestone bands and a cycle lane on the roadmap and the team Gantt) |
| F11.18 Current milestone toggle | **Carried over**: F24.16 |
| F11.19 current milestone first when planning | **Carried over** into F24.9's cycle planning |
| F11.20 date-range verification | **Folded** into F24.19 |

F11's file should be marked *superseded by F24* when this plan is accepted, so nobody imports
both.

## Design

### Cycles

- **Cadence is a team setting** (on the team, F21): `cyclesEnabled`, `cycleLengthWeeks` (1–4),
  `cycleStartDay` (1–7, ISO), `cooldownWeeks` (0–2), `upcomingCycles` (1–6, default 2),
  `rolloverUnfinished` (default on).
- **`Cycle`** in `packages/shared/src/model.ts`: `{ id, teamId, number, name: string | null,
  startAt, endAt, completedAt: number | null, archivedAt: number | null, createdAt }`. The display
  name is `name ?? 'Cycle ' + number`. State is **derived** from dates and `completedAt`:
  `upcoming | current | completed`. At most one current per team.
- **`Task.cycleId: string | null`**, native tickets only; in `TicketInput` / `TicketPatch`.
- **Dates act on their own, deliberately.** This reverses F11's "dates never act" rule, and it is
  the defining difference between a cycle and a sprint: a cycle starts and ends on its dates with
  nobody pressing anything. What a cycle end changes is **only cycle membership**, never a
  ticket's state or status (memory *card-state-is-the-humans*).
- **Pure rules** in a new `packages/shared/src/cycles.ts`:
  - `plannedCycles(cadence, existing, now)`: which upcoming cycles should exist (numbers continue
    from the highest ever issued, like a ticket key, so a deleted cycle's number is not
    re-used).
  - `currentCycle(cycles, now)`; `coversDay` from F24.1's `dateRange.ts` decides boundaries in
    whole local days in the team's time zone.
  - `rolloverPlan(cycle, tickets, next)`: tickets not in a `completed`/`canceled` category move to
    the next cycle (or to none when rollover is off); finished ones stay as the cycle's history.
  - `cycleProgress(cycle, tickets, scope)`: done / started / not started by count and by estimate,
    and scope added after the start.
  - `cadenceRefusal(cadence)`: refusals as values.
- **The cycle clock.** A `cycleClock.ts` in main, the same shape as `automationClock.ts`
  (one capped timer, boot and resume re-evaluate, dependencies injected). Each evaluation, per
  team: create missing upcoming cycles; for each cycle whose end has passed and has no
  `completedAt`, apply `rolloverPlan` and set `completedAt` **in one transaction**. Idempotent: a
  second evaluation finds nothing to do.
- **Scope tracking.** `cycle_scope (cycleId, taskId, addedAt, removedAt)` is written whenever
  `cycleId` changes, so progress can say "+3 added after start" without history from F22. (When
  F22 is present its ticket history records `cycleId` changes too; the two are not merged.)
- **Changing the cadence** affects only cycles that have not started; the current one keeps its
  dates. Turning cycles off keeps past cycles and removes upcoming ones that are empty; upcoming
  ones with tickets are kept until emptied or deleted by hand.
- **Who runs the clock.** On a local workspace, the desktop. On a cloud workspace, the **server**
  (F24.18), the only place that sees the team's tickets authoritatively. A desktop never closes
  a cycle in a cloud workspace; its replica receives the result.

### Milestones with date ranges

Carried from F11 unchanged: `Milestone.startAt`, `dateRange.ts` (`rangeRefusal`, `coversDay`,
`currentMilestones`), the guarded `PRAGMA table_info(milestones)` + `ALTER`, the Starts input in
`MilestoneList.tsx`, bands on the timeline, and the **Current milestone** board toggle combined
with **Current cycle** by AND. F24 adds one field: `Milestone.planningProjectId: string | null`,
so a milestone can belong to a project as well as to its team.

### Projects

- **`PlanningProject`** (code name; shown as *Project* in the UI): `{ id, workspaceId, name,
  summary, description (Markdown), icon, leadId, status: 'planned' | 'started' | 'paused' |
  'completed' | 'canceled', startAt, targetAt, updateCadence: 'off' | 'weekly' | 'biweekly',
  completedAt, archivedAt, createdAt }`, plus `planning_project_teams (projectId, teamId)` and
  `planning_project_members (projectId, personId)`.
- **`Task.planningProjectId: string | null`** on native tickets. Epics may carry it too, and a
  ticket under an epic inherits the epic's project for display when it has none of its own.
- **Progress** `projectProgress(tickets)`: completed estimate over total estimate, falling back to
  counts when nothing is estimated; canceled excluded; epics excluded (their children count);
  sub-issues count. Shown as a percentage and a thin monochrome bar.
- **Status** is set by a human. Completing a project with open tickets asks what to do with them
  (leave, move to another project, or remove from the project), mirroring F14's archive dialog.

### Initiatives

- **`Initiative`**: `{ id, workspaceId, name, description, ownerId, status: 'planned' | 'active'
  | 'completed', targetAt, archivedAt, createdAt }` and `initiative_projects (initiativeId,
  projectId, position)`. A project may sit in several initiatives.
- Health and progress **roll up** from the projects (pure `initiativeRollup`): progress is the
  estimate-weighted mean; health is the worst of the projects' latest health, unless the owner
  posted a more recent initiative-level update.

### Status updates with health

- **`StatusUpdate`**: `{ id, subjectKind: 'project' | 'initiative', subjectId, health:
  'on-track' | 'at-risk' | 'off-track', body (Markdown), authorId, createdAt }`. Append-only;
  the latest one is the subject's current health.
- **Reminders**: when a project's `updateCadence` says an update is due and none was posted, the
  lead gets a `status-update-due` notification (F22's kind). Without F22 the project page shows
  "Update due" only.
- **Colour**: on-track draws a monochrome glyph; at-risk an outline warning glyph; off-track the
  orange attention token. Health is a fact that moves, but only off-track asks for action (memory
  *board-colour-budget*).

### The roadmap

- **One pure layout module**, `packages/ui/src/projects/roadmapLayout.ts`, reusing
  `ganttScale`, `todayX`, `snapToDay`, `clampSpan` and `rescheduleTo` from `ganttLayout.ts`, and
  adding:
  - `roadmapRows(initiatives, projects, milestones, expanded)`: initiative headers, project rows
    (bar from `startAt` to `targetAt`, progress fill), milestones of each project as diamonds on
    its row; projects with no initiative under *No initiative*;
  - `roadmapRange` widening to every project, milestone and cycle date;
  - quarter and week ticks beside `ganttTicks`'s days and months, picked by zoom;
  - `ganttMilestoneBands` and `cycleLane` (F11.17's bands, now for cycles), used by both the
    roadmap and the existing team Gantt.
- **Expanding a project row** shows its tickets as today's Gantt rows (`ganttRows`), so the
  roadmap and the team timeline are one chart at two depths, not two charts.
- **Dragging** a project bar or its edges reschedules `startAt` / `targetAt` with the same
  pointer-capture rules `TimelinePane.tsx` documents (released on `pointerup` and
  `pointercancel`); tickets are never moved by moving their project.
- Bars and bands are monochrome; the today line and off-track health are the only colour.

### Archiving (F14)

- `archivedAt` on cycles, planning projects and initiatives with F14's semantics: hidden from the
  roadmap, board filters, pickers and the palette; listed under the sidebar's *Archived*; found by
  search with "include archived"; direct links work; restore in one click.
- Auto-archive uses F14's setting shape (off by default, N weeks): a completed cycle N weeks after
  its `completedAt`; a completed or canceled project N weeks after its status changed; an
  initiative when all its projects are archived.
- Archiving a project with open tickets asks: move them to another project, remove them from
  the project, or archive the project anyway (the tickets stay visible, only the project is
  hidden), as F14 does for milestones.

### Engine / desktop main process

- Store tables (guarded migrations): `cycles` (with `UNIQUE(teamId, number)`; "one current
  cycle" depends on today's date, so no index can express it, and it is guaranteed instead by
  `plannedCycles` never generating overlapping dates and by the clock's single transaction),
  `cycle_scope`, `planning_projects`, `planning_project_teams`, `planning_project_members`,
  `initiatives`, `initiative_projects`, `status_updates`; `cycleId` and `planningProjectId` in
  the guarded task column loop; `planningProjectId` and `startAt` on `milestones`; cadence
  columns on `projects` (the team).
- **Agents ignore plans.** A ticket outside the current cycle or in a paused project can still be
  delegated and run. Planning scopes views, never the engine (F11's open question 4, kept).
- `deleteTaskDeep` and a project/initiative delete clear pointers in their transaction, as
  `deleteMilestoneTx` does.

### Server & relay

- **Local workspace:** channels `cycle:list|save|remove`, `cycleSettings:save`,
  `planningProject:list|save|remove|setStatus`, `initiative:list|save|remove|setProjects`,
  `statusUpdate:list|post`, `roadmap:get` are `'relay'` in `ipcRelay.ts`; events
  `cycle:changed`, `planningProject:changed`, `initiative:changed`, `statusUpdate:changed` are
  `'replace-last'` in `ipcEventFanout.ts`.
- **Cloud workspace:** the same records are server tables (entities plus one TypeORM migration),
  synced to replicas by F19; field-level LWW for edits; status updates append-only. The server
  runs the cycle clock per team in the team's time zone; idempotent on `(cycleId,
  completedAt)` so two server instances cannot both roll a cycle over.

### UI — desktop

Copy the real components (memory *mock-the-real-components*); v9 glass shell from F13.

- **Sidebar**: under each team, *Cycles* (current, upcoming); at workspace level, *Projects*,
  *Initiatives*, *Roadmap*. Archived items under the one-line *Archived* entry.
- **Cycle page**: header with dates and progress (done / started / not started, +N added after
  start), the cycle's tickets in list or board layout, and *Upcoming* cycles to plan into.
- **Backlog** (`BacklogTable.tsx`): cycle sections (current, then upcoming) above the epic
  groups; row menu *Move to cycle ▸*; the current milestone's tickets listed first under a quiet
  "From M1" sub-header (F11.19). Pure layout in `cycleSections.ts`.
- **Ticket panel**: Cycle and Project fields beside Milestone; a completed cycle shows read-only.
- **Board**: *Current cycle* switch (replaces the JIRA-only *Current sprint* switch and keeps
  JIRA's behaviour for JIRA scopes), *Current milestone* switch, the "N hidden · 1 needs you"
  control, and the status bar naming the cycle.
- **Project page**: summary, lead, members, teams, dates, status, health and the latest update,
  progress, milestones, the tickets (grouped by team or epic), linked docs (F22), and the
  updates feed with *Post update*.
- **Initiative page**: projects with progress and health, rolled-up health, updates.
- **Roadmap**: the chart above, with zoom (weeks / months / quarters), filters by initiative,
  team, lead and status, and a cycle lane for a chosen team.

### UI — web

All in `packages/ui`, rendered unchanged by `apps/web` (memory *web-mirrors-the-desktop*). On a
cloud workspace the web reads the server directly and needs no desktop running.

### Failure modes & edge cases

- **The desktop was asleep across a cycle end** (local workspace): the clock evaluates on resume
  and closes every ended cycle in order, oldest first, so a ticket rolls 1 → 2 → 3 rather than
  skipping to the newest. One transaction per cycle.
- **A ticket is moved into a completed cycle by hand**: refused with a readable reason; completed
  cycles are history.
- **A ticket moves team** (F21): its `cycleId` points at another team's cycle; cleared in the move
  transaction, and the filter treats a foreign cycle as none (F11's rule).
- **Cadence edited mid-cycle**: the current cycle keeps its dates; upcoming empty cycles are
  regenerated; upcoming cycles with tickets keep their dates and the new cadence starts after
  the last of them.
- **No current cycle** (cooldown, or cycles off): the Current cycle filter keeps every card and
  says "No cycle running in API — showing all cards" (F11's no-empty-board rule).
- **Clock skew between devices** (cloud): only the server closes cycles; desktops display the
  server's dates.
- **Project spans teams, one team archived** (F14): the project keeps the team's tickets; the
  archived team is hidden from the project's team filter but its tickets still count.
- **Progress with nothing estimated**: counts are used and the bar says "by count", so a
  half-estimated project does not look further along than it is (mixing is refused: either all
  estimated tickets by estimate, else all by count).

## Out of scope (v1)

- Burn-up/burn-down charts, velocity and capacity planning (F25 insights).
- Cross-team cycles; a cycle belongs to one team.
- Dependencies between projects drawn on the roadmap (ticket `blocks` links stay on the Gantt).
- Writing native cycles to JIRA or importing JIRA sprints as cycles.
- Project templates; per-project custom fields.
- Scheduling tickets automatically to fit a project's dates.

## Open questions

1. **What is a planning project called in code, given `Project` is taken?** *Recommended
   default:* `PlanningProject` / `planning_projects` in code, *Project* in the UI. After F21 the
   ticket projects read as teams and repo projects as repositories, so the word is free in the
   UI; renaming the rail's *Projects* tab belongs to F13's shell.
2. **Do cycles start and end by themselves?** *Recommended default:* yes, by date, rolling only
   unfinished tickets' cycle membership. This is the deliberate reversal of F11's rule and the
   reason cycles replace sprints; a team that wants manual time boxes can turn cycles off and use
   milestones with ranges.
3. **Rollover on by default?** *Recommended default:* on. Off leaves unfinished tickets in a
   completed cycle, where nobody looks.
4. **Is a milestone owned by a team or a project?** *Recommended default:* by its team, as today,
   with an optional `planningProjectId`. The sidebar tree is team › milestones › epics ›
   tickets, and moving milestones out of teams would break it.
5. **Are status updates required?** *Recommended default:* no. Cadence defaults to weekly for new
   projects and only nudges the lead; nothing is blocked by a missing update.
6. **Does the roadmap show tickets?** *Recommended default:* only when a project row is
   expanded, reusing the team Gantt's rows; a roadmap full of ticket bars is a Gantt again.
7. **Who may change cadence?** *Recommended default:* team admins in a cloud workspace (F19
   roles); anyone on a local workspace.

## Tasks

### F24 · Phase 1 — Date ranges (carried from F11)

- [ ] F24.1 Add the shared date-range rules and the milestone start date contract

  - Carries F11.14 as written. New `packages/shared/src/dateRange.ts`: `rangeRefusal`,
    `coversDay`, `currentMilestones`. `startAt: number | null` and `planningProjectId: string |
    null` on `Milestone`, `MilestoneInput` and `MilestonePatch` (`model.ts:1320-1347`).
  - Acceptance: `dateRange.test.ts` covers an inverted range, open ends, a range that ends today,
    a closed milestone, a due-only milestone (never current) and two overlapping milestones
    (both current). `pnpm typecheck` green.

- [ ] F24.2 Add the milestone startAt column, its migration and range validation @needs: F24.1 Add the shared date-range rules and the milestone start date contract

  - Carries F11.15 as written, plus `planningProjectId`. A guarded `PRAGMA table_info(milestones)`
    + `ALTER` in `store.ts`; both columns through `insertMilestone`, `rowToMilestone`,
    `updateMilestone`; `milestone:save` refuses an inverted range with `rangeRefusal`.
  - Acceptance: electron-as-node recipe (memory *the-store-has-no-tests*): snapshot, open twice,
    drop the columns, reopen; milestone counts and every `dueAt` unchanged; a handler test that
    an inverted range returns a readable error.

- [ ] F24.3 Edit a milestone's start date in the milestone list @needs: F24.2 Add the milestone startAt column, its migration and range validation

  - Carries F11.16. A **Starts** input before the due date in `MilestoneList.tsx`, saved on blur;
    an inverted range shows the refusal inline and keeps the old value.
  - Acceptance: `pnpm build` green; the shared component renders on the web; a headless smoke
    check (memory *verify-electron-app*) sets and clears a start date.

### F24 · Phase 2 — Cycles

- [ ] F24.4 Add the cycle contract, team cadence and cycleId on tickets

  - `Cycle`, `CycleCadence` in `packages/shared/src/model.ts`; cadence fields on the team
    (`Project`); `cycleId` on `Task`, `TicketInput`, `TicketPatch`; `ticketFields.ts` carries it.
  - Acceptance: `pnpm typecheck` green; `ticketFields.test.ts` round-trip for `cycleId`.

- [ ] F24.5 Write the pure cycle rules in packages/shared @needs: F24.4 Add the cycle contract, team cadence and cycleId on tickets, F24.1 Add the shared date-range rules and the milestone start date contract

  - New `packages/shared/src/cycles.ts`: `plannedCycles`, `currentCycle`, `rolloverPlan`,
    `cycleProgress`, `cadenceRefusal`, `cycleDisplayName`.
  - Acceptance: tests for generation across a cooldown, a cadence change mid-cycle, numbers never
    re-used after a delete, a cycle ending today (still current), rollover moving every
    non-finished category and keeping finished ones, rollover off, and progress with and without
    estimates.

- [ ] F24.6 Add the cycles table, cycleId column and the cycle clock @needs: F24.5 Write the pure cycle rules in packages/shared

  - `cycles` and `cycle_scope` tables and `cycleId` in the guarded column loop in `store.ts`;
    store methods; `apps/client/src/main/cycleClock.ts` in `automationClock.ts`'s shape (capped
    timer, boot and resume, injected deps) creating upcoming cycles and closing ended ones with
    rollover in one transaction each; skipped for cloud workspaces.
  - Acceptance: electron-as-node migration proof; a `scripts/verify-cycles.mjs` scenario on a temp
    DB that fakes the clock across three cycle ends while "asleep" and asserts tickets roll
    1 → 2 → 3 in order, **no ticket's `status` or `stateId` changed** (memory
    *card-state-is-the-humans*), and a second evaluation is a no-op. Prove it fails by mutation
    (memory *headless-scenario-harness-traps*).

- [ ] F24.7 Add the cycle IPC channels, relay classification and cycle:changed @needs: F24.6 Add the cycles table, cycleId column and the cycle clock

  - `cycle:list|save|remove` and `cycleSettings:save` in `packages/shared/src/ipc.ts` and
    `apps/client/src/main/ipc.ts`; `'relay'` in `ipcRelay.ts`; `cycle:changed` as
    `'replace-last'` in `ipcEventFanout.ts`; `ticket:update` validates a `cycleId` of the
    ticket's own team and refuses a completed cycle.
  - Acceptance: `test/ipc-relay-coverage.test.ts` and the fanout test pass; handler tests for the
    foreign-team and completed-cycle refusals.

- [ ] F24.8 Filter the board by the current cycle and fold the sprint switch into it @needs: F24.7 Add the cycle IPC channels, relay classification and cycle:changed

  - Carries F11.3, F11.6 and F11.11 reshaped: `currentCycleCards` and `hiddenNeedsYou` in
    `packages/ui/src/board/currentSprint.ts`; `board.currentCycleOnly` in `settings.ts` with a
    one-time idempotent fold from `jira.currentSprintOnly` (written alongside for one release);
    the JIRA sync reads the new key; the switch in `MyTasks.tsx` and the web `BoardToolbar.tsx`;
    `currentSprintName` names the cycle on native scopes.
  - Acceptance: selector tests that a ticket in the current cycle is kept and others hidden, a
    team with no current cycle keeps everything, JIRA/GitHub/ad-hoc cards pass through, steps
    follow their parent, a foreign cycle counts as none; settings tests for the fold (old flag on,
    new key present, idempotent); the settings mirror test stays green (`board` is global).

- [ ] F24.9 Plan cycles in the Backlog and show cycle progress @needs: F24.7 Add the cycle IPC channels, relay classification and cycle:changed, F24.3 Edit a milestone's start date in the milestone list

  - Carries F11.9, F11.10 and F11.19 reshaped: pure `cycleSections.ts`; cycle sections in
    `BacklogTable.tsx` with *Move to cycle ▸*; the current milestone's tickets first under "From
    <milestone>"; a Cycle field in the panel and drawer; the cycle page with progress and scope
    added after start; team cadence settings in the team admin.
  - Acceptance: `cycleSections.test.ts` covers ordering, counts, points, the milestone-first
    suggestion (none, one, two overlapping) and empty states; `pnpm build` green; a headless
    smoke check renders a seeded team with a current and an upcoming cycle.

### F24 · Phase 3 — Projects, initiatives and updates

- [ ] F24.10 Add the planning project, initiative and status update contracts and rules

  - `PlanningProject`, `Initiative`, `StatusUpdate`, `Health` in `model.ts`; `planningProjectId`
    on `Task`, `TicketInput`, `TicketPatch`; new `packages/shared/src/planning.ts` with
    `projectProgress`, `initiativeRollup`, `latestHealth`, `updateDue`.
  - Acceptance: tests for progress by estimate versus by count (never mixed), canceled and epics
    excluded, sub-issues counted, an epic's project inherited for display, rollup health taking
    the worst unless a newer initiative update exists, and `updateDue` across cadences.

- [ ] F24.11 Add the planning tables and their IPC channels @needs: F24.10 Add the planning project, initiative and status update contracts and rules

  - `planning_projects`, `planning_project_teams`, `planning_project_members`, `initiatives`,
    `initiative_projects`, `status_updates`, and `planningProjectId` in the task column loop;
    store methods; channels `planningProject:*`, `initiative:*`, `statusUpdate:*` classified
    `'relay'` with `'replace-last'` events; deletes clear pointers in their transaction.
  - Acceptance: electron-as-node migration proof; `scripts/verify-planning.mjs` creating a
    project across two teams, an initiative, and updates, then deleting the project and asserting
    every ticket's `planningProjectId` is cleared; relay coverage and fanout tests green.

- [ ] F24.12 Build the project and initiative pages with progress and health @needs: F24.11 Add the planning tables and their IPC channels

  - Sidebar *Projects* and *Initiatives* entries; project page (summary, lead, members, teams,
    dates, status, health, progress, milestones, tickets, linked docs when F22 exists);
    initiative page with project rollup; Project field in the ticket panel; completing a project
    with open tickets asks what to do with them.
  - Acceptance: pure view-model tests (`projectPageView.ts`) for grouping and the completion
    dialog's choices; health glyph test that only off-track uses colour (memory
    *board-colour-budget*); `pnpm build` green, rendered on web.

- [ ] F24.13 Post status updates and remind leads when one is due @needs: F24.12 Build the project and initiative pages with progress and health

  - *Post update* on project and initiative pages (health picker plus Markdown body); the updates
    feed; a daily check that writes F22's `status-update-due` notification for the lead when
    `updateDue` says so, or an "Update due" badge when F22 is absent.
  - Acceptance: tests that a reminder fires once per due period and stops after an update is
    posted; a headless smoke check posting an off-track update shows the orange glyph on the
    roadmap row.

### F24 · Phase 4 — The roadmap

- [ ] F24.14 Lay out the roadmap rows, bars, milestone bands and cycle lane @needs: F24.10 Add the planning project, initiative and status update contracts and rules, F24.5 Write the pure cycle rules in packages/shared

  - New `packages/ui/src/projects/roadmapLayout.ts`: `roadmapRows`, `roadmapRange`, quarter and
    week ticks, `ganttMilestoneBands` and `cycleLane` (carrying F11.17), reusing `ganttScale`,
    `todayX`, `snapToDay`, `clampSpan`, `rescheduleTo`; the team Gantt's `ganttRange` widens to
    milestone start dates.
  - Acceptance: `roadmapLayout.test.ts` cases for a project with no dates (unscheduled tray), a
    ranged and a due-only milestone, a current versus a completed cycle, projects in two
    initiatives (drawn under each), zoom tick selection, and that the existing
    `ganttLayout.test.ts` stays green unchanged.

- [ ] F24.15 Draw the roadmap view and reschedule projects by drag @needs: F24.14 Lay out the roadmap rows, bars, milestone bands and cycle lane, F24.11 Add the planning tables and their IPC channels, F24.7 Add the cycle IPC channels, relay classification and cycle:changed

  - A `RoadmapPane.tsx` beside `TimelinePane.tsx` sharing `GanttHeader.tsx`; expanding a project
    renders its tickets through `ganttRows`; drag and edge-resize of project bars with pointer
    capture released on `pointerup` and `pointercancel`; filters by initiative, team, lead and
    status; milestone bands and the cycle lane also drawn on the team Gantt.
  - Acceptance: a pure drag-commit test (optimistic dates, rollback on refusal) in the shape of
    the Gantt's; `pnpm build` green; a headless smoke check renders a seeded roadmap with two
    initiatives and an expanded project.

- [ ] F24.16 Add the Current milestone toggle to both boards @needs: F24.2 Add the milestone startAt column, its migration and range validation, F24.8 Filter the board by the current cycle and fold the sprint switch into it

  - Carries F11.18. `board.currentMilestoneOnly`; `currentMilestoneCards` composed with the cycle
    filter by AND; the switch in `MyTasks.tsx` and the web `BoardToolbar.tsx`; the "no milestone
    covers today" line; the status bar naming the current milestone.
  - Acceptance: selector tests that the two filters combine with AND, a team with no current
    milestone keeps every card, an epic matches by its own `milestoneId`, and hidden cards needing
    you are counted once when both filters hide them.

### F24 · Phase 5 — Archive, cloud and verification

- [ ] F24.17 Archive completed cycles, projects and initiatives with F14's rules @needs: F24.6 Add the cycles table, cycleId column and the cycle clock, F24.11 Add the planning tables and their IPC channels

  - `archivedAt` on cycles, planning projects and initiatives through F14's archive contract and
    channels; manual archive and one-click restore; auto-archive after N weeks using F14's
    setting shape (off by default); the open-tickets dialog for projects; archived items hidden
    from the roadmap, filters, pickers and palette, listed under *Archived*.
  - Acceptance: F14's archive selector tests extended to the three new kinds; a
    `verify-planning.mjs` step that auto-archives a cycle completed N weeks ago and restores it,
    with direct links still resolving while archived.

- [ ] F24.18 Carry cycles and planning records through the cloud workspace with a server cycle clock @needs: F24.17 Archive completed cycles, projects and initiatives with F14's rules, F24.13 Post status updates and remind leads when one is due

  - TypeORM entities and one migration for every F24 table; F19 replica sync down and outbox up
    (field-level LWW, status updates append-only); a server cycle clock per team in its time zone
    using `@tm/shared`'s `cycles.ts`, idempotent on the cycle; desktops never close cycles in a
    cloud workspace; publish carries local cycles, projects, initiatives and updates across.
  - Acceptance: server tests that two clock instances roll a cycle over once, that a desktop's
    stale `cycleId` write to a completed cycle is rejected and parks in the outbox with that
    reason, and that publish preserves cycle numbers and project progress.

- [ ] F24.19 Verify planning end to end and document it @needs: F24.9 Plan cycles in the Backlog and show cycle progress, F24.15 Draw the roadmap view and reschedule projects by drag, F24.16 Add the Current milestone toggle to both boards, F24.18 Carry cycles and planning records through the cloud workspace with a server cycle clock

  - Extend `scripts/verify-cycles.mjs` and `scripts/verify-planning.mjs` across IPC: cadence,
    rollover while asleep, the Current cycle and Current milestone filters, a project's progress,
    an update reminder, archive and restore. With a stub `claude` on PATH (memory
    *stub-claude-on-path*), a ticket outside the current cycle still runs. Add *Cycles*,
    *Projects and initiatives* and *Roadmap* sections to `docs/12-the-ticket-model.md`, glossary
    entries in `docs/05-glossary.md`, and mark `F11-sprints.md` superseded.
  - Acceptance: the scripts fail when the rollover's status guard, the no-current-cycle fallback
    or the AND composition is mutated, and pass as written; `pnpm typecheck`, `pnpm test`,
    `pnpm build` green with `--force` (memory *a-cached-gate-is-not-a-gate*).
