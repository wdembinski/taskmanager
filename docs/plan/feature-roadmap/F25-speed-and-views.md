# F25 — Speed and views

> **Status:** proposed · **Where:** `packages/ui` (desktop and web) · `packages/shared` · client (store, IPC) · server (cloud workspaces) · **Depends on:** F9 (the palette), F13 (rows, sidebar, peek), F14 (the archive predicate), F19 (cloud workspaces, sync, members), F21 (teams, custom workflow states, priority, estimates) · **Unlocks:** F26's triage views and rules reuse the filter language; F27's guest permissions filter saved views
> Only the `- [ ]` checkboxes under **Tasks** become cards when this file is imported as a plan; everything else is context.
>
> **Layout rule for this file:** every task's description bullets sit after a **blank line**. The plan
> parser folds any indented line that directly follows a checkbox into that task's *title*
> (`apps/client/src/main/planParser.ts:173-177`); the blank line is what keeps descriptions out of it.

## Why

A tracker is used hundreds of times a day, in short bursts: find a ticket, change its status,
assign it, look at what is mine, look at what is late. Every one of those today is a mouse trip
through a screen built for something else — the board for runs, the Backlog for one project's
epics. There is no "my issues", no saved filter, no way to change ten tickets at once, no
search inside descriptions, and no answer to "how long does work take us".

F25 makes the tracker fast to drive and easy to slice: keyboard everywhere, the command palette
as the place every action lives, one set of views (list, board, timeline) over one filter
language that can be saved and pinned, bulk edit, full-text search, and plain insights from the
history the app already records.

Most of it works on a **local workspace** too. The parts that need the team model (shared
saved views, views over other people's work, server-side search and team-wide insights) wait
for F19 and F21. Each task below says which it is.

## What we have today

- **Keyboard** — no shortcut layer. Ad-hoc `window.addEventListener('keydown', …)` handlers,
  each with its own "not in an INPUT/TEXTAREA/SELECT/contentEditable" guard:
  `apps/client/src/renderer/src/MyTasks.tsx:1087-1100` (arrow delete / Escape),
  `apps/web/src/board/BoardScreen.tsx:414` (the same, copied) and
  `packages/ui/src/projects/TimelinePane.tsx:900` (bar dragging). No row or card can be
  selected or moved from the keyboard. F13 adds Space / Enter / Esc for peek and full screen.
- **Command palette (F9)** — what has landed, per `git log`: **F9.1** (the pure model,
  `packages/ui/src/palette/paletteModel.ts`: `PaletteCommand`, `PaletteSource`,
  `PaletteContext { currentProjectId }`, groups `navigate | cards | projects | actions`,
  `paletteScore`, `rankCommands`, `paletteReduce`), **F9.7** (the dictation spike) and **F9.8**
  (the dictation state machine). Not landed: the shortcut hook (F9.2), the dialog (F9.3), the
  desktop and web sources (F9.4 / F9.5) and the hint (F9.6). F9's out-of-scope list names
  rebindable shortcuts, searching inside descriptions and frecency — exactly what F25 adds.
- **Views and filters** — `projects/Projects.tsx` switches Backlog / Timeline / Graph for one
  ticket project. `backlogView.ts`'s `filterTickets` matches title, key and labels
  case-blind; sort is `'key' | 'due'`; grouping is by epic only. The board has its own display
  options (`board/BoardDisplayMenu.tsx`), the JIRA "current sprint" filter
  (`board/currentSprint.ts`), focus mode, folded columns and `AppSettings.boardScopeId`. None of
  these can be saved under a name, and none is shared between screens.
- **"Me"** — `person:setMe` marks one `people` row as the user (`packages/shared/src/ipc.ts`,
  Phase 24); tickets carry `assigneeId` / `reporterId`. Nothing lists "assigned to me".
- **Bulk edit** — none. `ticket:update(taskId, patch)` edits one ticket; F12 makes each field
  save on its own.
- **Search** — no full-text index. SQLite FTS5 is not used in `apps/client/src/main/store.ts`.
  The server is Azure SQL through TypeORM `mssql`
  (`apps/server/src/database/typeormOptions.ts:60`) and stores mirrored tasks as JSON payloads
  (`taskMirror.entity.ts`, `simple-json`), which cannot be indexed for text as they stand.
- **History for insights (F2)** — `activity_log` (`store.ts:1895-1910`) records
  `status-moved` rows with `detail: { from, to }` for every **human** status change, from both
  `task:setStatus` (`apps/client/src/main/ipc.ts:1704-1717`) and `task:move` (`:5172-5185`),
  through `moveActivity.ts`; `activityBackfill.ts` backfilled thirty days. Agent runs **borrow**
  a card's status and give it back (`preRunStatus`; memory *card-state-is-the-humans*), so a
  card's live `status` is not its human status while a run holds it — time-in-status must be
  read from the log, not from `status`. `pruneActivity` exists (`store.ts:6406`) but nothing
  calls it, so the log is unbounded today. There is no `doneAt` on a task. F2's screen
  (`packages/ui/src/activity/ActivityScreen.tsx`) shows a feed and outcome tiles, not flow
  metrics.
- **Trigger trap** — `tasks` already has one combined AFTER INSERT / UPDATE / DELETE trigger
  per write kind, kept as one body on purpose so the nested `updatedAt` touch never cross-fires a
  second trigger and double-logs to `cloud_outbox` (comment at `store.ts:2443-2470`). Any new
  trigger on `tasks` (an FTS index, say) must be proven not to double the outbox rows.

## Design

### Data model & contracts

**One view definition** (`packages/shared/src/views.ts`), used by every list, board and timeline:

```ts
interface IssueView {
  layout: 'list' | 'board' | 'timeline';
  filter: FilterExpr;              // AND of clauses; a clause is OR of values
  groupBy: 'status' | 'assignee' | 'milestone' | 'epic' | 'priority' | 'label' | 'none';
  sortBy: 'key' | 'updated' | 'due' | 'priority' | 'manual';
  show: { subIssues: boolean; done: 'all' | 'recent' | 'none'; includeArchived: boolean };
}
type FilterClause =
  | { field: 'status' | 'assignee' | 'reporter' | 'milestone' | 'epic' | 'label' | 'type'
             | 'priority' | 'project' | 'team'; op: 'is' | 'isNot'; values: string[] }
  | { field: 'due' | 'created' | 'updated'; op: 'before' | 'after' | 'within'; value: string }
  | { field: 'run'; op: 'is'; values: ('running' | 'parked' | 'idle')[] }
  | { field: 'hasMr' | 'hasAgent'; op: 'is'; value: boolean }
  | { field: 'text'; op: 'matches'; value: string };
```

`me`, `today`, `this week` are symbolic values resolved at evaluation, so a saved "My issues
due this week" stays true tomorrow. `evaluateFilter(task, expr, ctx)` is pure; `ctx` carries
the registries, the `me` id, the clock, the live-run index and F14's archive index.
`team` and custom states are accepted only in cloud workspaces (F21).

**Saved views and favourites**

- Local workspace: tables `saved_views (id, projectId NULL, name, view JSON, createdAt,
  updatedAt, sortOrder)` and `favourites (id, kind 'view'|'ticket'|'milestone'|'epic'|'project',
  targetId, sortOrder)` in the desktop store.
- Cloud workspace: the same shapes as server tables under the workspace (F19), with
  `ownerId` and `visibility: 'personal' | 'workspace'`; favourites are always personal. They
  sync through F19's replica and outbox like any workspace row.

**Bulk edit** — `ticket:updateMany(ids, patch)` returns `{ updated: string[], refused:
{ id, reason }[] }`; one transaction locally, one batch of commands through the outbox in a
cloud workspace (field-level last-writer-wins applies per ticket, as F19 decided).

**Search** — `search:issues(query, { includeArchived, projectIds?, limit })` returns ranked
hits with the matched field and a snippet. Locally an FTS5 table; in a cloud workspace a server
endpoint over the server's own ticket tables (F19 makes them real columns, not JSON).

**Insights** — computed from status transitions: `cycleTime` (first move into an in-progress
category → done), `leadTime` (created → done), `timeInStatus` (per status, summed over every
visit), `throughput` (done per week). Statuses are mapped to categories (`backlog`, `todo`,
`started`, `review`, `done`, `cancelled`); locally the category is fixed by `TaskStatus`, in a
cloud workspace F21's custom states declare theirs.

### Engine / desktop main process

- **Keymap.** No main-process change: shortcuts are renderer-only, and Electron menu
  accelerators stay unused (F9 decided against `globalShortcut`).
- **Saved views, favourites, bulk edit, search** — new store methods and IPC channels:
  `view:list|save|remove|reorder`, `favourite:list|add|remove|reorder`, `ticket:updateMany`,
  `search:issues`. Each is classified `'relay'` (rows only, no filesystem) in
  `packages/shared/src/ipcRelay.ts`; `view:changed` and `favourite:changed` are
  `'replace-last'` in `ipcEventFanout.ts`.
- **FTS5.** A `tickets_fts` virtual table (title, description, key, labels; comments when F22
  brings native comments) kept in step by explicit writes in the store's ticket write paths
  rather than a new trigger on `tasks` — or, if a trigger is chosen, the verification script
  proves the outbox still gets exactly one row per edit. FTS5 being compiled into the shipped
  `better-sqlite3` is checked in F25.14's first step, under `ELECTRON_RUN_AS_NODE`.
- **Status history.** The `status-moved` log already covers both human paths. F25 adds the
  missing writers: ticket creation (a `created` baseline so lead time has a start), status set
  through `ticket:update` if F12 routes status there, and bulk edit. A grep of every
  `status` writer for native tickets is part of the task (typecheck cannot find them). Engine
  borrowing is never logged as a move.

### Server & relay

- Cloud workspaces: `saved_views`, `favourites` server tables and endpoints (F19's module
  layout); bulk edit as a command batch; a full-text index on the ticket tables (Azure SQL
  full-text catalog, or a `LIKE`-based fallback below a size threshold — open question 3);
  insights aggregated server-side over F22's ticket history so the numbers cover every member's
  changes, not only this desktop's.
- The web uses the same relayed channels for a local workspace (desktop reachable) and the
  server endpoints for a cloud workspace (no desktop needed, per F19).

### UI — desktop

- **Keyboard everywhere** (`packages/ui/src/keys/keymap.ts`): one registry of bindings with
  scopes (`global`, `list`, `board`, `timeline`, `detail`, `dialog`), single keys and
  two-key sequences (`g i` Inbox, `g m` My issues, `g b` board), the field guard written once,
  IME-safe, and the palette's `mod+k` from F9.2. Defaults: `j/k` move, `x` select, `shift+j/k`
  extend, Space peek, Enter open, Esc back, `c` new issue, `s` status, `a` assign, `l` labels,
  `p` priority, `d` due, `m` milestone, `e` epic, `f` favourite, `/` filter, `?` the shortcut
  sheet. On the board: `h/l` between columns, `shift+h/l` moves the selected card a column
  (through the same `task:move` path, so JIRA transitions and the activity log still happen).
  Every binding is also a palette command, so the palette is the discoverable half of the
  keymap.
- **Palette** (F9) gains: actions on the selection ("Set status…", "Assign to…", "Move to
  milestone…", "Add label…", "Archive epic", "Start agent" when legal), issue search across all
  projects with the "include archived" toggle, saved views and favourites as `navigate` rows,
  and recent items first (frecency, stored per device).
- **Views.** One `IssueViewScreen` renders an `IssueView` as a list (F13's `IssueRow`, grouped),
  a board (`KanbanColumn`, grouped by status category) or a timeline (`TimelinePane`). A
  filter bar of chips sits above it; *Save view* names it; the sidebar lists saved views and
  favourites under the workspace.
- **My issues** — a built-in view: assigned to me, not done, grouped by status, with tabs
  *Assigned*, *Created* (reporter = me), *Agents* (cards whose agent runs on this desktop) and,
  in a cloud workspace, *Subscribed* (F22).
- **Bulk edit** — multi-select with `x`, shift-click, ctrl-click or `shift+j/k`; a glass action
  bar shows the count and the common fields; one edit applies to all, with an undo toast that
  re-applies each ticket's previous values; refusals listed by key.
- **Search** — the palette's "Search issues…" and a results view (it is an `IssueView` with a
  `text` clause, so it can be refined and saved).
- **Insights** — a screen (and a tab on a milestone, an epic and a saved view) with cycle and
  lead time as median and 85th percentile, time in status as a stacked bar per status, and
  weekly throughput. Charts follow the theme's tokens; one accent for the measured series, grey
  for the rest (memory *board-colour-budget*).

### UI — web

- All of the above through the shared `@tm/ui` screens (memory *web-mirrors-the-desktop*). For
  a local workspace the web needs a reachable desktop (relay) and is read-only without one; for
  a cloud workspace it talks to the server directly. Browser-reserved keys (`ctrl+k` in some
  layouts, `/` in Firefox) call `preventDefault` only when the app handles them, as F9.5
  planned.

### Failure modes & edge cases

- **A shortcut while typing**: the single guard skips every binding except the palette's
  opener; IME composition is ignored. A binding that collides with a Fluent control's own key
  (e.g. Space on a checkbox) yields to the focused control.
- **A saved view that names something deleted** (a milestone, a person, a label): the clause
  keeps the id, shows it as "(deleted)" and matches nothing; the view never errors.
- **A saved view naming an archived milestone**: it still works and shows the tickets — opening
  a view that asks for archived work explicitly is the "include archived" case.
- **Bulk edit across projects** with a field that does not exist in one of them (a milestone of
  project A on a ticket of project B): refused per ticket with the reason; the rest apply.
- **Bulk status change** goes through the same per-ticket path as a move, so tracker
  transitions and activity rows happen for each; a JIRA ticket that refuses its transition is
  listed, not rolled back silently (memory *jira-transitions-on-every-move*).
- **Insights with little data**: fewer than five completed tickets shows the numbers with "too
  few to be a trend", never a confident chart. Tickets done before the log existed (or before
  the thirty-day backfill reached) are excluded rather than given a made-up start.
- **Engine-borrowed status** never appears in time-in-status.
- **FTS drift**: if the index and the table disagree (a crash between writes), a rebuild on boot
  when the counts differ; search results are always re-read by id before display.
- **Offline cloud workspace**: views, favourites and bulk edits queue in F19's outbox; search
  falls back to the local replica (FTS over the replica) and says "offline — searching this
  device".

## Out of scope (v1)

- User-rebindable shortcuts (the registry makes it possible later; defaults only for now).
- A query language typed as text (`assignee:me status:todo`); the filter bar's chips are the
  only editor in v1, though the palette accepts a few prefixes.
- Custom dashboards, chart builders, burndown/burnup (F24 owns cycle reports).
- Searching agent transcripts or code.
- Cross-workspace views (one view over a local and a cloud workspace at once).

## Open questions

1. **Single-key shortcuts or modifier-only?** Single keys (`c`, `s`, `j/k`) are fastest but can
   surprise someone who types into a non-field area. *Recommended default:* single keys in list,
   board and detail scopes, off while any field, dialog or the composer has focus, and a
   Settings switch to turn single-key shortcuts off.
2. **Where do saved views live for a local workspace — per project or global?** *Recommended
   default:* global with an optional project scope (`projectId` nullable), so "My issues due
   this week" spans every local project.
3. **Server search engine.** Azure SQL's full-text index needs real columns, which F19
   provides. *Recommended default:* full-text index on the ticket title/description columns once
   F19 lands; until then the web searches through the desktop relay.
4. **Activity log retention.** Insights need history, and `pruneActivity` is not called today.
   *Recommended default:* keep it unpruned; if a retention is ever added, status-moved rows are
   exempt or rolled up into a `ticket_status_history` table first.
5. **Bulk edit undo across a sync.** In a cloud workspace another member may edit one of the
   tickets before undo. *Recommended default:* undo re-applies only fields still holding the
   bulk value, and reports the others as "changed since".

## Tasks

### F25 · Phase 1 — Keyboard

- [ ] F25.1 Write the shared keymap registry with scopes, sequences and one field guard

  - `packages/ui/src/keys/keymap.ts`: `KeyBinding { id, keys, scope, when?, run }`,
    `matchKey(state, event)` for single keys and two-key sequences with a timeout, the
    field/IME guard, scope precedence (dialog > detail > list/board/timeline > global) and
    conflict detection. `useKeymap` mounts one window listener. Reuses F9.2's `shortcutMatches`
    if it has landed, or supersedes it. Local and cloud workspaces alike.
  - Acceptance: `keymap.test.ts` on plain event objects — sequences, timeout, guard in a
    textarea, IME composition ignored, a dialog scope shadowing a list binding, a duplicate
    binding in one scope rejected at registration. `pnpm typecheck`, `pnpm test`, `pnpm build`
    green.

- [ ] F25.2 Move the existing keydown handlers onto the keymap @needs: F25.1 Write the shared keymap registry with scopes, sequences and one field guard

  - `MyTasks.tsx:1087-1100`, `BoardScreen.tsx:414` and `TimelinePane.tsx:900` register
    bindings instead of their own listeners; behaviour unchanged.
  - Acceptance: a structural test (root, like `shell-parity.test.ts`) that no file under
    `packages/ui/src`, `apps/client/src/renderer/src` or `apps/web/src` adds a `keydown`
    window listener outside `keymap.ts`; the arrow-delete behaviour is covered by a reducer
    test. Gates green.

- [ ] F25.3 Add list and board navigation, selection and the field shortcuts @needs: F25.2 Move the existing keydown handlers onto the keymap

  - `j/k`, `h/l`, `x`, `shift+j/k`, Space / Enter / Esc (with F13's peek), `c`, `s`, `a`, `l`,
    `p`, `d`, `m`, `e`, `f`, `/`, and `shift+h/l` to move a card through `task:move`. Each
    field shortcut opens the same picker the panel uses. Works on local workspaces.
  - Acceptance: a pure `listCursorReduce` (move, wrap at group ends, skip folded groups, keep
    the cursor on a ticket that moves group) and `boardCursorReduce` with tests; a card moved
    by keyboard writes one `status-moved` row (verification script). Gates green.

- [ ] F25.4 Generate the shortcut sheet and the Settings list from the registry @needs: F25.3 Add list and board navigation, selection and the field shortcuts

  - `?` opens a sheet of the bindings in the current scope; Settings → Keyboard lists all of
    them (F9.6's read-only list, generated rather than hand-written), with the single-key
    switch from open question 1.
  - Acceptance: a test that every registered binding appears on the sheet and that the
    switch disables exactly the single-key bindings. Gates green.

### F25 · Phase 2 — The palette as the action layer

- [ ] F25.5 Register selection actions and saved destinations as palette commands @needs: F25.3 Add list and board navigation, selection and the field shortcuts

  - A `PaletteSource` built from the keymap and the current selection: set status, assign,
    move to milestone or epic, label, priority, due, favourite, archive (F14), start/stop agent
    (existing predicates only); `navigate` rows for saved views, favourites and Inbox / My
    issues. Needs F9.3–F9.5 shipped. Host-only channels are dropped in the web through
    `RELAY_POLICY`, as F9.5 does.
  - Acceptance: a pure `buildSelectionCommands(selection, ctx)` with tests (a mixed selection
    offers only fields common to all; an archived ticket offers Restore not Archive; a running
    card offers Stop); `ipc-relay-coverage.test.ts` green. Gates green.

- [ ] F25.6 Search tickets across projects from the palette with recent items first @needs: F25.5 Register selection actions and saved destinations as palette commands

  - The palette's `cards` source covers every project's tickets through F14's predicate, with
    an "include archived" toggle (`alt+a`); a per-device frecency list puts recently opened
    tickets and views first on an empty query.
  - Acceptance: `paletteModel` tests extended — archived excluded unless toggled; frecency
    order on empty query, score order once typing; frecency capped and pruned of deleted ids.
    Gates green.

### F25 · Phase 3 — Views, filters, My issues, favourites

- [ ] F25.7 Define the view model and the filter evaluator

  - `packages/shared/src/views.ts`: `IssueView`, `FilterClause`, `evaluateFilter`,
    `groupIssues`, `sortIssues`, symbolic `me` / `today` / `this week`, and a version field so a
    saved view can be migrated. Team and custom-state clauses accepted only with a cloud
    context (F21).
  - Acceptance: `views.test.ts` — each field and operator; OR within a clause, AND across;
    `me` with no person marked as me matches nothing and says so; a deleted referent matches
    nothing; archived excluded unless `includeArchived`; done `recent` = last 14 days. Gates
    green.

- [ ] F25.8 Render one issue view as a list, a board or a timeline with a filter bar @needs: F25.7 Define the view model and the filter evaluator, F25.3 Add list and board navigation, selection and the field shortcuts

  - `packages/ui/src/views/IssueViewScreen.tsx` with the layout switch, grouping and the chip
    filter bar; list = F13's `IssueRow`, board = `KanbanColumn` grouped by status, timeline =
    `TimelinePane`. The Tickets screen's Backlog becomes the default view of a project. Works on
    local workspaces.
  - Acceptance: `backlogView.test.ts` still green against the new grouping (or migrated case
    by case); a test that a view switched between layouts keeps its filter and selection;
    `shell-parity.test.ts` asserts both hosts render the shared screen. Gates green.

- [ ] F25.9 Store saved views and favourites on the desktop and classify their channels @needs: F25.7 Define the view model and the filter evaluator

  - `saved_views` and `favourites` tables in `store.ts` (new tables in the schema block, not
    ALTERs), `view:*` / `favourite:*` channels and `*:changed` events, classified in
    `ipcRelay.ts` and `ipcEventFanout.ts`.
  - Acceptance: a `scripts/verify-views-store.mjs` under `ELECTRON_RUN_AS_NODE` (memory
    *the-store-has-no-tests*): save, reorder, delete, reopen an existing database without the
    tables and see them created; `ipc-relay-coverage.test.ts` green. Gates green.

- [ ] F25.10 Add saved views, favourites and My issues to the sidebar @needs: F25.8 Render one issue view as a list, a board or a timeline with a filter bar, F25.9 Store saved views and favourites on the desktop and classify their channels

  - *Save view* in the filter bar; the sidebar (F13's `sidebarModel`) lists favourites and
    saved views; `f` toggles a favourite; My issues is a built-in view with Assigned / Created /
    Agents tabs (Subscribed waits for F22).
  - Acceptance: `sidebarModel` tests for favourites order and a dangling favourite (dropped
    from the list, kept in storage until the target is deleted); My issues shows nothing and
    offers "Set who you are" when no person is marked as me. Gates green.

- [ ] F25.11 Sync saved views and favourites in cloud workspaces with personal and shared views @needs: F25.10 Add saved views, favourites and My issues to the sidebar

  - Server tables, endpoints and F19 replica/outbox wiring; `visibility: personal |
    workspace`; only the owner or an admin edits a shared view; guests see shared views
    filtered by what they can read (F27 refines). Cloud only.
  - Acceptance: server tests for create, share, edit by a non-owner (refused), and a
    conflicting rename resolved by last-writer-wins; the desktop replica shows a shared view
    created on the web. Server and web builds green.

### F25 · Phase 4 — Bulk edit

- [ ] F25.12 Add multi-select and the bulk edit channel @needs: F25.3 Add list and board navigation, selection and the field shortcuts

  - A pure `selectionReduce` (toggle, range, select all in group, clear on view change);
    `ticket:updateMany(ids, patch)` in one store transaction returning `updated` and `refused`;
    status changes go through the per-ticket move path so JIRA transitions and activity rows
    happen. Classified `'relay'`. Works on local workspaces.
  - Acceptance: reducer tests; verification-script section — ten tickets updated in one
    transaction, one refused with its reason, the rest committed, one outbox row each. Gates
    green.

- [ ] F25.13 Build the bulk action bar with undo @needs: F25.12 Add multi-select and the bulk edit channel

  - A glass action bar (F13) with the count, the common fields and Archive; undo re-applies
    each ticket's previous values, skipping fields changed since (open question 5); in a cloud
    workspace the edit goes out as one command batch through F19's outbox.
  - Acceptance: a pure `undoPatchFor(before, after, now)` with tests (a field changed since is
    skipped and reported); a refused ticket stays selected after apply. Gates green.

### F25 · Phase 5 — Full-text search

- [ ] F25.14 Index tickets locally with FTS5 and expose search @needs: F25.9 Store saved views and favourites on the desktop and classify their channels

  - First prove FTS5 is compiled into the shipped `better-sqlite3` (a probe under
    `ELECTRON_RUN_AS_NODE`). Then a `tickets_fts` table over title, description, key and labels,
    filled at creation and kept current from the ticket write paths, rebuilt when counts differ
    at boot; `search:issues` with snippets, ranked, archive-aware. Works on local workspaces.
  - Acceptance: `scripts/verify-ticket-search.mjs` — prefix and phrase queries, a description
    hit, an archived hit only with the flag, a rebuild after a forced drift, and exactly one
    `cloud_outbox` row per ticket edit before and after the index exists. Gates green.

- [ ] F25.15 Search cloud workspaces on the server and fall back to the replica offline @needs: F25.14 Index tickets locally with FTS5 and expose search

  - A server search endpoint over F19's ticket tables (full-text index per open question 3),
    permission-filtered; the desktop uses it online and FTS over its replica offline, labelled
    "offline — searching this device". Cloud only.
  - Acceptance: server tests for ranking, a guest not seeing a ticket outside their access,
    and archived filtering; the desktop's choice of source is a pure function with tests.
    Server and web builds green.

- [ ] F25.16 Build the search results view and wire it into the palette @needs: F25.8 Render one issue view as a list, a board or a timeline with a filter bar, F25.14 Index tickets locally with FTS5 and expose search

  - "Search issues…" in the palette opens an `IssueView` with a `text` clause, highlighted
    snippets and the include-archived toggle; it can be refined with chips and saved.
  - Acceptance: a test that a search view round-trips through save and load; snippets are
    escaped (no HTML from ticket text). Gates green.

### F25 · Phase 6 — Insights

- [ ] F25.17 Complete the ticket status history the insights read

  - Grep every writer of a native ticket's `status` (typecheck will not find them) and make
    each human path write a `status-moved` row: ticket creation (a baseline row), the panel's
    status field if it goes through `ticket:update`, bulk edit, plan import. Engine borrowing
    (`preRunStatus`) is never logged as a move.
  - Acceptance: the grep list is recorded in the PR; a verification-script section drives
    each path and counts the rows; an agent run that borrows and returns the status writes
    none. Gates green.

- [ ] F25.18 Write the pure insight calculations

  - `packages/shared/src/insights.ts`: `transitionsFor(task, rows)`, `cycleTime`,
    `leadTime`, `timeInStatus`, `throughputByWeek`, median and 85th percentile, over status
    categories; local categories fixed from `TaskStatus`, cloud categories from F21's states.
  - Acceptance: `insights.test.ts` — a ticket reopened after done, a ticket that skipped
    in-progress, a ticket done before history began (excluded), a week with no completions
    (zero, not missing), fewer than five samples flagged. Gates green.

- [ ] F25.19 Build the insights screen for projects, milestones, epics and saved views @needs: F25.8 Render one issue view as a list, a board or a timeline with a filter bar, F25.17 Complete the ticket status history the insights read, F25.18 Write the pure insight calculations

  - A shared `InsightsScreen` and a tab on a milestone, an epic and a saved view: cycle and
    lead time (median, p85), time in status, weekly throughput; tokens only, one accent series.
    Local workspaces read the desktop's log through a relayed `insights:query`; cloud
    workspaces read a server aggregate over F22's ticket history.
  - Acceptance: `ipc-relay-coverage.test.ts` green for `insights:query`; the screen renders
    the "too few to be a trend" state from a pure view model with tests; web build green.

- [ ] F25.20 Verify speed and views end to end and document them @needs: F25.6 Search tickets across projects from the palette with recent items first, F25.11 Sync saved views and favourites in cloud workspaces with personal and shared views, F25.13 Build the bulk action bar with undo, F25.16 Build the search results view and wire it into the palette, F25.19 Build the insights screen for projects, milestones, epics and saved views

  - `scripts/verify-speed-and-views.mjs` on a temp DB: save a view, bulk-edit through IPC,
    search, compute insights, and check the list, board and palette read the same tickets.
    `docs/` gains a keyboard reference generated from the registry and a views/insights page;
    `docs/05-glossary.md` defines view, favourite, cycle time, lead time.
  - Acceptance: the script fails when the filter evaluator or the bulk transaction is
    mutated and passes as written (memory *headless-scenario-harness-traps*); `pnpm
    typecheck`, `pnpm test`, `pnpm build` green with `--force`.
