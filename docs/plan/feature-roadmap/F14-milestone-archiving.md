# F14 — Milestone archiving

> **Status:** proposed · **Where:** client (store, main, IPC) · `packages/shared` · `packages/ui` (desktop and web) · server (mirror) · **Depends on:** F12 (the one panel opens archived tickets), F13 (the sidebar's Archived entry; soft — without it the entry lands in the Tickets screen) · **Unlocks:** T1 (F19) carries the same flags into cloud workspaces; T7 (F26) adds rule-based auto-archive
> Only the `- [ ]` checkboxes under **Tasks** become cards when this file is imported as a plan; everything else is context.
>
> **Layout rule for this file:** every task's description bullets sit after a **blank line**. The plan
> parser folds any indented line that directly follows a checkbox into that task's *title*
> (`apps/client/src/main/planParser.ts:173-177`); the blank line is what keeps descriptions out of it.

## Why

The built-in tracker keeps everything it has ever planned in view. The roadmap import alone
put 138 tickets and four milestones on one project (memory *roadmap-imported-as-tickets*), and
each finished milestone stays in the Backlog's epic groups, on the Timeline, in the milestone
picker and in every filter. A milestone can be marked **closed** today, which only drops it
from one picker; its tickets stay everywhere.

Archiving is the way to put finished work away without losing it. An archived milestone, epic
or ticket project disappears from the tree, board, Gantt, filters, pickers and the command
palette, and is visible only under the sidebar's **Archived** entry and in search with
"include archived". A direct link still opens the ticket, the ticket can still be edited, and
restoring is one click.

This ships early, on today's local tracker (Track 1), because the problem exists now. F19
(T1) carries the same flags into cloud workspaces.

## What we have today

- **Milestones** — `milestones` table (`apps/client/src/main/store.ts:1727-1737`: `id`,
  `projectId` cascading from `projects`, `name`, `description`, `dueAt`, `color`,
  `closed INTEGER NOT NULL DEFAULT 0`, `createdAt`), shape `Milestone` /
  `MilestoneInput` / `MilestonePatch` (`packages/shared/src/model.ts:1320-1347`). `closed`
  "stays on record but drops out of the pickers"; the only reader is
  `TicketDrawer.tsx:264` (`.filter((m) => !m.closed || m.id === milestoneId)`), and
  `MilestoneList.tsx:130` is the checkbox that sets it. Deleting a milestone nulls
  `tasks.milestoneId` by hand in the same transaction (`deleteMilestoneTx`, see
  `docs/12-the-ticket-model.md` "The schema"), because the column carries no foreign key.
- **Epics** are tickets: `Task.issueType === 'epic'` (`isEpic`, `packages/shared/src/tickets.ts:49`),
  referenced by `Task.epicTaskId` (no foreign key either).
- **Ticket projects** are `projects` rows where `ownsTickets` holds; `Projects.tsx` filters the
  picker on it (`packages/ui/src/projects/Projects.tsx:68`). `Project` has no archived or hidden
  field.
- **A different "archive" already exists, and must not be reused.** `tasks.archivedAt` /
  `archivedReason` (`store.ts:184-187`, `TaskArchiveReason` in `model.ts:669`) mean *taken off
  the board*: set by the JIRA / GitHub reconcilers and by variant discard, excluded from
  `board:tasks` in SQL (`selectBoardTasks`, `store.ts:2663`), listed in the Removed-cards dialog
  (`board/ArchivedCardsDialog.tsx`), and **destroyed** after `ARCHIVE_RETENTION_DAYS` by
  `pruneArchivedBefore` at boot (`apps/client/src/main/ipc.ts:524`). A tracker-archived ticket must
  stay editable, openable by link and never pruned — the opposite on all three counts.
- **Where tickets are drawn** — the Backlog (`projects/BacklogTable.tsx`, grouping in
  `backlogView.ts` with `filterTickets` searching title, key and labels), the Timeline
  (`TimelinePane.tsx`, `ganttLayout.ts`: `ganttWindow` spans every ticket's and milestone's dates
  at `:120-140`, `ganttMarkers` at `:342`), the Graph (`GraphPane.tsx`), the board for a ticket
  project scope (`MyTasks.tsx`, web `BoardScreen.tsx`), and the pickers in `TicketDrawer` /
  `TicketTypeFields` (epic), `NewTicketDialog` and `AddTaskDialog`. F12 replaces the drawer with
  `TicketFieldsSection` inside `TaskDetail`.
- **IPC and relay** — `milestone:list|save|remove` and `ticket:update` are `'relay'` in
  `packages/shared/src/ipcRelay.ts` (milestones at `:187-189`); ticket projects are edited
  through the general `project:list|add|update|remove` (`packages/shared/src/ipc.ts:447-473`).
  `docs/12-the-ticket-model.md` still names `ticketProject:*` channels and a
  `ticketProject:changed` event that no longer exist in `ipc.ts` — the doc is stale there.
  `milestone:changed` is `'replace-last'` in `ipcEventFanout.ts:126`; there is **no** project
  list event, only `project:tasksChanged`. Both maps are `satisfies`-checked, so a new channel
  fails to compile until classified. The web polls `milestone:changed`
  (`apps/web/src/board/polledEvents.ts`).
- **Cloud mirror** — the desktop's `cloud_outbox` triggers cover `tasks` and `projects` only
  (`store.ts:2468-2498`); `CloudEntity` is `'task' | 'project' | 'automation' | 'automationRun'`
  (`apps/client/src/main/cloudDelta.ts:21`). The server stores each as a whole JSON payload
  (`apps/server/src/entities/taskMirror.entity.ts`, `projectMirror.entity.ts`:
  `simple-json`), so a new field on `Task` or `Project` rides through with no server migration.
  **Milestones are not mirrored**; the web reads them only through the relay, so with no
  desktop reachable it has none.
- **No "done at" time on a task.** Status changes by a human are logged as `status-moved` rows
  with `{ from, to }` in `activity_log` (`apps/client/src/main/moveActivity.ts`, backfilled by
  `activityBackfill.ts`); `updatedAt` is touched by the outbox trigger on every write.
- **No store tests.** Nothing calls `createStore` under vitest (better-sqlite3 is built for
  Electron's ABI); migrations are verified by bundling `store.ts` and running it with
  `ELECTRON_RUN_AS_NODE=1`, faking the old schema with `ALTER TABLE … DROP COLUMN`
  (memory *the-store-has-no-tests*; worked example `scripts/verify-resume-migration.mjs`).

## Design

### Data model & contracts

Three new nullable columns, added through the store's existing column-migration list (the
`[name, type]` arrays beside `['archivedAt', 'INTEGER']` at `store.ts:2353`):

- `milestones.archivedAt INTEGER` — epoch ms, `NULL` = not archived.
- `projects.archivedAt INTEGER` — on ticket projects only; refused for an agent project.
- `tasks.trackerArchivedAt INTEGER` — on **epics** only (and on tickets archived with their
  milestone, below). Deliberately **not** `tasks.archivedAt`, which is the board-removal flag
  with its own reader set and a pruner. The name says which archive it is; the UI word is
  "Archived" for both, and the docs say which is which.

Shapes: `Milestone.archivedAt`, `Project.archivedAt`, `Task.trackerArchivedAt`, each
`number | null`. `MilestonePatch` does **not** gain the field: archiving is its own operation
(it may move tickets), never a side effect of an edit.

**Archiving a milestone with open tickets** asks one question with three answers, sent as one
operation so the move and the archive commit together:

```ts
type OpenTicketsChoice =
  | { kind: 'backlog' }                    // milestoneId := null
  | { kind: 'milestone'; milestoneId: string } // move to another, non-archived milestone
  | { kind: 'archive' };                   // archive them too: trackerArchivedAt := now
```

"Open" means any status that is not `done` or `cancelled`. Done tickets stay on the milestone
as its history and are hidden with it, needing no flag. Tickets archived "too" carry
`trackerArchivedAt` so restoring the milestone restores exactly those, and a later move off the
milestone does not resurrect them by accident.

### The one predicate

`packages/shared/src/trackerArchive.ts`, pure, used by every surface on both hosts and by the
main process:

```ts
interface ArchiveIndex { milestones: Map<string, Milestone>; epics: Map<string, Task>; projects: Map<string, Project>; }
type ArchivedBy = { by: 'project' | 'milestone' | 'epic' | 'self'; id: string } | null;

archivedBy(ticket, index): ArchivedBy        // first reason found: project, milestone, epic, self
isHidden(ticket, index, opts?: { includeArchived?: boolean }): boolean
visibleTickets(tickets, index, opts?): Task[]
pickableMilestones(milestones, currentId?) / pickableEpics(...) / pickableProjects(...)
                                              // archived excluded, except the value already set
```

A ticket is hidden when its project, its milestone, its epic or itself is archived. Nothing
else may decide this: no SQL `WHERE`, no per-screen filter. That keeps direct links working
(reads by id are unfiltered) and keeps the board, Backlog, Timeline, Graph, sidebar and palette
from disagreeing — the same reason F12 made one panel.

### Engine / desktop main process

- Store methods, each one transaction that pushes its change events by hand (as
  `deleteMilestoneTx` does): `archiveMilestone(id, choice, at)`, `restoreMilestone(id)`,
  `archiveEpic(id, at)`, `restoreEpic(id)`, `archiveTicketProject(id, at)`,
  `restoreTicketProject(id)`, and `listArchived(projectId?)`.
- **Refusals come back as data**, never thrown, and each names its reason: moving open tickets
  to an archived milestone or one in another project; archiving an agent project; archiving
  something already archived; restoring something not archived.
- **Restoring a milestone** clears `trackerArchivedAt` on the tickets that were archived with
  it (same `at`), not on tickets someone archived separately.
- **Auto-archive (optional, off by default).** A setting `ticketAutoArchiveWeeks: number | null`
  (null = off). A sweep at boot and hourly archives a milestone when every ticket on it is done
  or cancelled and the latest of their done times is older than N weeks. The done time is the
  newest `status-moved` row into `done`/`cancelled` in `activity_log`, falling back to the
  ticket's `updatedAt`. A milestone with no tickets is never auto-archived, and one with any
  open ticket never is. Each auto-archive writes an activity row (a new `ActivityKind`,
  `'milestone-archived'`, added to `ACTIVITY_KINDS` in `packages/shared/src/activity.ts` with its
  feed readers grepped) so it can be found on the feed and undone.
- `pruneArchivedBefore` must never see a tracker-archived row: it reads `archivedAt` only, and
  a guard test (in the verification script) proves a ticket with `trackerArchivedAt` set
  survives a prune.

### Server & relay

- New invoke channels, classified `'relay'` (they touch rows only, like every Phase 24 ticket
  channel): `archive:apply(target, choice?)`, `archive:restore(target)`, `archive:list(projectId?)`,
  with `target = { kind: 'milestone' | 'epic' | 'project'; id }`. Changes ride the existing
  `milestone:changed` and `project:tasksChanged` events. There is no project-list event, so a
  project archive or restore is followed by a `project:list` re-read in the caller, as a
  `project:update` already has to be; no new event.
- **Cloud mirror.** `Project.archivedAt` and `Task.trackerArchivedAt` reach the server inside
  the existing JSON payloads. Milestones become a mirrored entity: `CloudEntity` gains
  `'milestone'`, `milestones` gets the same three outbox triggers as `tasks` / `projects` (with
  the same one-trigger-per-write-kind rule, so the touch never double-logs), and the server gains
  `milestoneMirror.entity.ts` plus a migration. The web then hides archived work even when no
  desktop is reachable. F19 later makes milestones server-authoritative and reuses this table's
  shape.

### UI — desktop

- **Archive actions**: in `MilestoneList` (and the sidebar's milestone context menu once F13
  ships), on an epic's panel (F12) and on a ticket project in `ProjectAdmin`. Each is one click
  with an undo toast — except a milestone with open tickets, which opens the dialog below.
- **Open-tickets dialog** (`ArchiveMilestoneDialog`): "M2 · Review has 4 open tickets." Three
  choices — *Move them to the Backlog*, *Move them to another milestone* (a picker of
  non-archived milestones in the same project), *Archive them too* — with the count and the first
  few keys listed.
- **Hidden everywhere** via the predicate: board (ticket-project scope), Backlog groups, the
  Timeline's bars, markers and window (an archived milestone no longer stretches the date
  range), the Graph, the sidebar tree, the epic / milestone / project pickers, the board's scope
  dropdown, and the palette's sources (F9.4 / F9.5, whichever lands second wires it).
- **Search** — the Backlog's search box gains an "Include archived" toggle; archived rows show
  a quiet "Archived" tag. F25's full-text search inherits the same toggle.
- **The Archived entry** — the sidebar's one-line "Archived" with a count (F13). It lists
  archived projects, milestones and epics with their date and ticket count, each with
  **Restore**; expanding one shows its tickets as ordinary rows that open the panel. Without
  F13 it is an "Archived" view beside Backlog / Timeline / Graph in `Projects.tsx`.
- **Direct links and the panel** — opening an archived ticket shows a banner "Archived with
  M2 · Review — Restore", and every field stays editable. F12's *Show on board* names the
  archive as the filter that hides it (`hiddenBy` gains `'archived'`).
- Colour: none. Archived things are monochrome, a muted glyph and the word "Archived"
  (memory *board-colour-budget*).

### UI — web

- The same shared components (`Projects`, the sidebar, the dialog, the panel's banner) render
  in the web, calling the relayed channels; with no desktop reachable they are read-only with
  `readOnlyNotice`, while hiding still works from the mirrored milestones.

### Failure modes & edge cases

- **A ticket moved onto an archived milestone** by a picker that still held a stale list: the
  store refuses it as data ("M2 is archived"), rather than hiding a ticket someone just touched.
- **An open ticket added to an archived milestone by import or plan** (`planParser` milestones):
  allowed (it is the plan's record), and the ticket is hidden; the Archived view shows the
  milestone with "1 open ticket" so it is not lost silently.
- **Archiving an epic whose tickets sit in a non-archived milestone**: the tickets hide with the
  epic. The epic's archive is the stronger statement; the milestone shows "3 hidden by an
  archived epic" in the Archived view.
- **A chain or a running agent on an archived ticket**: archiving never stops or blocks a run
  (memory *card-state-is-the-humans*: an agent run never moves a card); the run's card stays
  visible in Attention and on the activity feed while it needs a human, through the attention
  index, which does not go through the predicate.
- **`@needs` and chains**: an archived prerequisite still counts as what it is (done or not);
  archiving never satisfies a dependency.
- **JIRA / GitHub / Linear tickets**: not archivable here; their lifecycle is the tracker's.
- **Deleting an archived milestone** behaves exactly as deleting any milestone.
- **Upgrade**: the three columns are `NULL` on every existing row, which reads as "not
  archived" — nothing disappears on upgrade.

## Out of scope (v1)

- Archiving cycles/sprints (they do not exist locally yet; F24 adds them with archiving).
- Archiving individual non-epic tickets on their own (only "archive them too" sets it).
- Rule-based archiving beyond the one auto-archive setting (F26).
- Bulk archive across projects.

## Open questions

1. **Auto-archive setting: global or per project?** *Recommended default:* one global
   `ticketAutoArchiveWeeks` in `GLOBAL_SETTINGS_KEYS` (the cloud web edits it), off by default;
   per-project override arrives with F19's workspace settings.
2. **Should a closed milestone be offered for archiving automatically?** *Recommended default:*
   no prompt; closing and archiving stay separate, and the Archive action sits next to the
   Closed checkbox.
3. **Mirror milestones now or wait for F19?** *Recommended default:* now (F14.11). Without it
   the web cannot hide archived milestones when no desktop is reachable, and F19 needs the
   server table anyway.
4. **What counts as "closes" for auto-archive?** *Recommended default:* `done` or `cancelled`,
   timed by the activity log; a ticket with no log row uses `updatedAt`, which can only make
   the archive later, never earlier.

## Tasks

### F14 · Phase 1 — Model and store

- [ ] F14.1 Add the archive columns to milestones, projects and tasks with a verified migration

  - `milestones.archivedAt`, `projects.archivedAt`, `tasks.trackerArchivedAt` through the
    store's column-migration list; `Milestone`, `Project` and `Task` gain the fields; row
    mappers read them as `number | null`. The `tasks` triggers keep firing once per write (no
    new trigger on `tasks`).
  - Acceptance: `scripts/verify-archive-migration.mjs` (pattern of
    `verify-resume-migration.mjs`, memory *the-store-has-no-tests*): create a store, `DROP
    COLUMN` the three columns, reopen, and check they come back `NULL` with every row intact;
    the script fails when the migration entry is removed (proven once). `pnpm typecheck`,
    `pnpm test`, `pnpm build` green.

- [x] F14.2 Write the shared archive predicate used by every surface

  - `packages/shared/src/trackerArchive.ts` is built on **structural input types, not**
    `Milestone` / `Project` / `Task` themselves (`packages/shared/src/model.ts:1320`, `:201`,
    `:692`): `ArchivableMilestone = Pick<Milestone, 'id'> & { archivedAt?: number | null }`,
    likewise `ArchivableProject`, and `ArchivableTicket = Pick<Task, 'id' | 'projectId' |
    'source' | 'milestoneId' | 'epicTaskId'> & { trackerArchivedAt?: number | null }`
    (`Task.source` is `model.ts:816`, `.epicTaskId` and `.milestoneId` are `:1204` and
    `:1206`). This ships before F14.1 adds the real `archivedAt` / `trackerArchivedAt`
    columns, and must not touch `model.ts` itself or it collides with that task's edit; once
    F14.1 lands, the real types satisfy these with no change here. `ArchiveIndex<TMilestone,
    TEpic, TProject>` (each defaulting to its `Archivable*` type) is `{ milestones:
    Map<string, TMilestone>; epics: Map<string, TEpic>; projects: Map<string, TProject> }`,
    generic so a caller holding real `Milestone`/`Task`/`Project` maps can pass them as-is.
  - `archivedBy(ticket, index): { by: 'project' | 'milestone' | 'epic' | 'self'; id: string }
    | null` returns `null` outright for a non-native ticket (`isNativeTicket`,
    `packages/shared/src/tickets.ts:44`, tests `source === 'ticket'`) — a JIRA/GitHub/Linear
    row's lifecycle is the tracker's, not ours. Otherwise it checks, in order, the ticket's
    project, its milestone, its epic, then itself, and returns the first that is archived. A
    lookup miss — `ticket.milestoneId` or `.epicTaskId` naming a row that was deleted, or one
    simply absent from `index` — counts as **not archived** at that step, the same way a
    missing milestone already degrades to the `No milestone` bucket elsewhere
    (`backlogView.ts`'s `groupTickets`): a dangling id must never hide a ticket silently.
  - `isHidden(ticket, index, opts?: { includeArchived?: boolean })` is
    `!opts?.includeArchived && archivedBy(ticket, index) !== null` — the single switch every
    "Include archived" toggle (Backlog search, the Archived view, a direct link) flips.
  - `visibleTickets<T extends ArchivableTicket>(tickets: readonly T[], index, opts?): T[]`
    filters with `isHidden`, keeping the input order and the element type, so the board
    (ticket-project scope), Backlog, Timeline and Graph each get back exactly the shape they
    passed in.
  - `pickableMilestones<T extends ArchivableMilestone>(list, currentId?): T[]`,
    `pickableEpics<T extends ArchivableTicket>(list, currentId?)` (reading
    `trackerArchivedAt`) and `pickableProjects<T extends ArchivableProject>(list, currentId?)`
    drop archived entries except the one already matching `currentId` — the same rule
    `offeredMilestones` already applies for `closed`
    (`packages/ui/src/projects/ticketRegistries.ts:36-41`) — and this trio leaves `closed`
    alone entirely; that stays `offeredMilestones`'s own, separate filter. Each keeps the
    input order and the element type.
  - `archiveIndexOf(milestones, epics, projects)` builds the three `Map`s in one call, so a
    caller in F14.4 onward does not hand-roll `new Map(x.map((v) => [v.id, v]))` three times
    over.
  - File header and JSDoc match `tickets.ts`'s: the header spells out that this is the
    *tracker's* archive, not `Task.archivedAt` (set by the JIRA/GitHub reconcilers and by
    variant discard, and destroyed by `pruneArchivedBefore` — the opposite lifecycle, see
    "What we have today" above), and that no SQL `WHERE` or per-screen filter may ever decide
    hiding on its own.
  - Acceptance: `trackerArchive.test.ts` — hidden by project, by milestone, by epic, by self;
    precedence when several apply; `includeArchived` shows all; a picker keeps the already-set
    archived value; a ticket whose milestone id points at a deleted milestone is not hidden;
    JIRA-sourced rows are never hidden by this. Gates green.

- [x] F14.3 Add archive and restore to the store in one transaction with the open-tickets choice @needs: F14.1 Add the archive columns to milestones, projects and tasks with a verified migration, F14.2 Write the shared archive predicate used by every surface

  - `archiveMilestone(id, choice, at)`, `restoreMilestone`, `archiveEpic`, `restoreEpic`,
    `archiveTicketProject`, `restoreTicketProject`, `listArchived(projectId?)` in `store.ts`;
    refusals returned as data with a reason; events pushed by hand after commit.
  - Acceptance: the verification script gains sections for each choice (Backlog, another
    milestone, archive too), restore restoring exactly the co-archived tickets, every refusal,
    and a `pruneArchivedBefore` run that leaves a tracker-archived ticket alone. Gates green.

- [x] F14.4 Expose the archive channels and classify them in the relay @needs: F14.3 Add archive and restore to the store in one transaction with the open-tickets choice

  - `archive:apply`, `archive:restore`, `archive:list` in `packages/shared/src/ipc.ts`, handled
    in `apps/client/src/main/ipc.ts`, classified `'relay'` in `ipcRelay.ts`; no new event
    (`milestone:changed` / `project:tasksChanged` carry the change; a project archive is
    re-read through `project:list`). `docs/12`'s stale `ticketProject:*` names are corrected in
    passing.
  - Acceptance: `test/ipc-relay-coverage.test.ts` green; `httpTransport` relays the three
    channels; a refusal reaches the renderer as data, not a rejected promise. Gates green.
  - **Decision taken in passing:** `archiveMilestone` now refuses `choice-required` when a
    milestone has open tickets and no `choice` was sent, rather than defaulting to one of the
    three (landed with F14.3; see `store.ts`'s `archiveMilestoneTx`).

### F14 · Phase 2 — Hide everywhere

- [ ] F14.5 Hide archived work on the board and in every picker @needs: F14.4 Expose the archive channels and classify them in the relay

  - The board (ticket-project scope) on both hosts runs its tickets through `visibleTickets`;
    the milestone / epic pickers in `TicketFieldsSection` (F12) or `TicketDrawer`,
    `TicketTypeFields`, `NewTicketDialog` and `AddTaskDialog`, and the board scope dropdown, use
    the `pickable*` helpers. A grep for every `milestones.map` / `.filter(isEpic` / `ownsTickets`
    call site lists the readers (typecheck cannot find them).
  - Acceptance: the grep list is recorded in the PR; each reader uses the shared helper; a test
    of the board's pure column builder that an archived-milestone ticket is absent and present
    with `includeArchived`. Gates green.

- [ ] F14.6 Hide archived work in the Backlog, Timeline and Graph @needs: F14.5 Hide archived work on the board and in every picker

  - `backlogView.ts` groups only visible tickets; `ganttLayout.ts`'s window, bars and markers
    skip archived milestones and hidden tickets; `GraphPane` drops hidden nodes and shows a
    link to a hidden ticket as a muted stub. The Backlog search gains "Include archived".
  - Acceptance: `backlogView.test.ts` and `ganttLayout.test.ts` cases — an archived milestone
    no longer widens `ganttWindow`, its marker is gone, the toggle brings both back. Gates
    green.

### F14 · Phase 3 — Archive, restore and the Archived view

- [ ] F14.7 Build the archive actions and the open-tickets dialog @needs: F14.4 Expose the archive channels and classify them in the relay

  - Archive in `MilestoneList`, on an epic's panel and in `ProjectAdmin`; undo toast for the
    one-click cases; `ArchiveMilestoneDialog` with the three choices over a pure
    `archiveDialogModel(milestone, tickets, milestones)` (open count, sample keys, eligible
    target milestones).
  - Acceptance: model tests — no open tickets skips the dialog; target list excludes the
    milestone itself, archived ones and other projects; "archive too" lists the keys it will
    hide. Gates green.

- [ ] F14.8 Add the Archived view with one-click restore @needs: F14.6 Hide archived work in the Backlog, Timeline and Graph, F14.7 Build the archive actions and the open-tickets dialog

  - The sidebar's "Archived" entry with a count (F13's `sidebarModel` gains the count from
    `archive:list`), or an "Archived" view in `Projects.tsx` when F13 has not shipped. Lists
    archived projects, milestones and epics with date and ticket count; Restore on each;
    expanding one lists its tickets, which open the panel.
  - Acceptance: a pure `archivedViewModel(listArchived, tickets)` with tests (grouping,
    counts, an open ticket on an archived milestone flagged); restore from the view brings the
    milestone back to the Timeline without reload (`milestone:changed`). Gates green.

- [ ] F14.9 Show archived tickets by direct link with a restore banner and keep them editable @needs: F14.8 Add the Archived view with one-click restore

  - The F12 panel shows "Archived with <milestone|epic|project> — Restore" from `archivedBy`;
    every field still saves; F12's `hiddenBy` names `'archived'` so *Show on board* explains
    itself.
  - Acceptance: `hiddenBy` tests gain the archived case; a ticket on an archived milestone
    edits through `ticket:update` and stays archived. Gates green.

### F14 · Phase 4 — Auto-archive, cloud and web

- [ ] F14.10 Add the optional auto-archive sweep @needs: F14.3 Add archive and restore to the store in one transaction with the open-tickets choice

  - `ticketAutoArchiveWeeks: number | null` in `AppSettings` (global, open question 1), a
    Settings field; pure `dueForAutoArchive(milestones, tickets, doneTimes, now, weeks)`; a
    sweep in main at boot and hourly, writing an activity row per archive.
  - Acceptance: tests — off by default does nothing; an open ticket blocks it; an empty
    milestone is never archived; the threshold is inclusive at exactly N weeks; a missing log
    row falls back to `updatedAt`. Gates green.

- [ ] F14.11 Mirror milestones and the archive flags to the cloud @needs: F14.1 Add the archive columns to milestones, projects and tasks with a verified migration

  - `CloudEntity` gains `'milestone'`; `milestones` gets the insert/update/delete outbox
    triggers built in the same loop as `tasks` / `projects`; `buildMirrorDelta` resolves
    milestones; `@tm/protocol/wire`'s `MirrorDelta` carries them; the server gains
    `milestoneMirror.entity.ts`, a migration and the apply path in `applyMirrorDelta.ts`; the
    web board store reads them. `Project.archivedAt` / `Task.trackerArchivedAt` need no server
    change (JSON payloads).
  - Acceptance: `cloudDelta.test.ts` and `mirror.service.test.ts` cover a milestone insert,
    archive and delete; the outbox gets exactly one row per milestone edit (checked in the
    verification script against a real database); server build and migration run green. The
    cloud API is paused (since 14 Oct 2026) — the live round trip waits for it to resume.

- [ ] F14.12 Bring archiving to the web @needs: F14.8 Add the Archived view with one-click restore, F14.11 Mirror milestones and the archive flags to the cloud

  - The web renders the shared Archived view, dialog and banner through the relay, and hides
    archived work from mirrored milestones when no desktop is reachable, with `readOnlyNotice`
    on the actions.
  - Acceptance: `httpTransport` tests that `archive:*` relay and are not refused;
    `test/shell-parity.test.ts` asserts the web renders the shared view; web build green.

- [ ] F14.13 Verify archiving end to end and document it @needs: F14.9 Show archived tickets by direct link with a restore banner and keep them editable, F14.10 Add the optional auto-archive sweep, F14.12 Bring archiving to the web

  - `scripts/verify-archive.mjs` on a temp DB (outside the repo, memory
    *headless-scenario-harness-traps*): archive a milestone with each choice through the IPC
    layer, read back the board / backlog inputs through the predicate, restore, run the sweep
    with a faked clock. `docs/12-the-ticket-model.md` gains an "Archiving" section (the two
    archives side by side, the predicate, the relay classification); `docs/05-glossary.md`
    defines both.
  - Acceptance: the script fails when the predicate or the restore is mutated and passes as
    written; `pnpm typecheck`, `pnpm test`, `pnpm build` green.
