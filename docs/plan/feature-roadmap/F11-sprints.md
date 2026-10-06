# F11 — Sprints

> **Status:** proposed · **Where:** client + server + web · **Depends on:** — · **Unlocks:** working the roadmap one sprint at a time
> Only the `- [ ]` checkboxes under **Tasks** become cards when this file is imported as a plan; everything else is context.
>
> **Layout rule for this file:** every task's description bullets sit after a **blank line**. The plan
> parser folds any indented line that directly follows a checkbox into that task's *title*
> (`apps/client/src/main/planParser.ts:173-177`); the blank line is what keeps descriptions out of it.

## Why

A native ticket board shows every ticket it has. After the roadmap import that is 138 cards in To
Do on the TM board, across four milestones, and nothing narrows it to "what we are doing now".
JIRA boards already have that answer: the **Current sprint** switch folds `sprint in
openSprints()` into the sync's JQL, and the board shows only the running sprint. Native tickets
have no sprint at all, so the same switch does nothing for them, and it is not even drawn unless
JIRA is enabled.

F11 gives ticket projects their own time-boxed sprints. You plan a sprint in the Backlog, start
it, and work the board with **Current sprint** on, exactly as on a JIRA board. When it ends, you
complete it and its unfinished tickets roll into the next sprint or back to the backlog.
Milestones keep their own job: they are the long-term goals (M1–M4), and sprints are the slices
pulled from them.

## What we have today

- **The switch** is `jira.currentSprintOnly` (`packages/shared/src/settings.ts:61`, default
  `false` at `:149`). It is read at `apps/client/src/renderer/src/MyTasks.tsx:263`, drawn only
  `{jiraEnabled && …}` (`MyTasks.tsx:1142`), and saved, then re-synced, at `MyTasks.tsx:850-858`.
  The web has the same switch in `apps/web/src/board/BoardToolbar.tsx:150`, wired at
  `BoardScreen.tsx:568-572`, plus a copy in `apps/web/src/settings/SettingsScreen.tsx:589`. The
  JIRA side applies it at `apps/client/src/main/ipc.ts:3228`
  (`withCurrentSprint(jira.jql)`). It is a **filter on the fetch**, not on the board.
- **`jira` is a global settings key** (`GLOBAL_SETTINGS_KEYS`, `settings.ts:747-768`, which also
  holds `board`). So the switch already travels to every device through the settings mirror
  (memory *settings-mirror-global-vs-local*).
- **The status bar** names the sprint from `currentSprintName(tasks)`
  (`packages/ui/src/board/currentSprint.ts`), and only when the switch is on (`App.tsx:222`). It
  ignores non-JIRA cards, and it returns `null` when the cards disagree.
- **The card's sprint chip** is `sprintShown && task.externalSprint` (`TaskCard.tsx:1558-1576`).
  Both boards pass `showSprint={!currentSprintOnly}` (`MyTasks.tsx:1349,1459`,
  `BoardScreen.tsx:625,734`), since on a single-sprint board the chip repeats itself.
- **Milestones are the closest precedent** for a new per-project record. The `milestones` table
  (`store.ts:1298-1308`) cascades from `projects`. `tasks.milestoneId` is plain TEXT with no
  foreign key (`store.ts:179-180`), added by the guarded column loop (`store.ts:1770-1792`) and
  indexed at `:1836`. Deleting one clears the pointer in a transaction (`deleteMilestoneTx`,
  `:3268`). The store methods are `listMilestones` / `addMilestone` / `updateMilestone` /
  `deleteMilestone` (`store.ts:645-652`).
  - The channels are `milestone:list|save|remove`, all `'relay'` (`ipcRelay.ts:166-168`).
  - The event is `milestone:changed`, `replace-last` (`ipcEventFanout.ts:123`, sent at
    `ipc.ts:2875`).
  - The UI is `MilestoneList.tsx` inside `TicketDrawer`.
- **Milestones do not travel as rows on the cloud mirror.** `MirrorDelta`
  (`packages/protocol/src/wire.ts:26-31`) carries only `tasks` and `projects`. The web reads
  milestones through the relayed `milestone:list`, and `milestoneId` reaches it on each `Task`.
- **The Backlog** is `packages/ui/src/projects/BacklogTable.tsx`. Its rows come from
  `backlogRows` (`backlogView.ts`), grouped by epic. Ticket edits go through `TicketDrawer`, using
  `ticketFields.ts`'s `ticketPatchFrom`. `TicketPatch` (`model.ts:1297-1311`) lists the editable
  ticket fields and has no sprint.
- **The board pipeline** is `groupSubtasks` → `focusCards` → `partitionShelved`
  (`MyTasks.tsx:517-539`, all in `packages/ui/src/board/boardColumns.ts`). That is where a card
  filter has to live so that both hosts get it. The web scopes its tasks in
  `apps/web/src/board/boardSelectors.ts:51` (`selectBoardTasks`).

## Design

### Data model & contracts

- **`Sprint`** in `packages/shared/src/model.ts`, beside `Milestone`:
  `{ id, projectId, name, goal, startAt: number | null, endAt: number | null,
  state: 'future' | 'active' | 'closed', createdAt, completedAt: number | null }`.
  `SprintInput` is `{ name, goal?, startAt?, endAt? }`. A sprint is created `future`, and
  `state` changes only through start and complete, never through a generic patch.
- **`Task.sprintId: string | null`**, native tickets only. It is added to `TicketInput` and
  `TicketPatch`, so the drawer edits it through the same `ticket:update` path as `milestoneId`.
  Mirrored JIRA cards keep `externalSprint` and never get a `sprintId`.
- **Pure rules** in a new `packages/shared/src/sprints.ts`:
  - `canStartSprint(sprints, id)` refuses when the sprint is not `future`, another sprint in the
    project is already `active`, or it has no `endAt`. Refusals are values, in the spirit of
    `RunRefusal`.
  - `planCompletion(sprint, tickets, target)` returns which tickets move where: unfinished
    tickets (any status outside the Done column) go to `target`, a future sprint or `null` for
    the backlog, and done tickets stay on the closed sprint as its history.
  - `nextSprintName(sprints)` suggests "Sprint N+1".
  - `activeSprintOf(sprints, projectId)`.
- **The board filter**, `currentSprintCards(cards, sprintsByProject)` in
  `packages/ui/src/board/currentSprint.ts`, next to `currentSprintName`:
  - A native ticket is kept when its `sprintId` is its project's active sprint.
  - **A ticket in a project that has no active sprint is kept**, and the screen says so (see
    *UI — desktop*). JIRA's `openSprints()` with no open sprint returns nothing, but an emptied
    board reads as lost work; focus mode refused the same trap (memory
    *chain-of-execution-arrows*).
  - Cards with no sprint concept pass through untouched: ad-hoc personal cards and GitHub,
    GitLab and Linear mirrors. JIRA cards pass through too, because JQL already narrowed them.
  - Steps follow their parent card, since the filter runs after `groupSubtasks`.
- **`currentSprintName`** is extended to take the sprint list. On a native board it returns the
  active sprint's name, and the existing disagreement rule (JIRA and native naming different
  sprints) still returns `null`.

### Engine / store

- **Schema.** A `sprints` table that cascades from `projects`, exactly like `milestones`:
  `(id, projectId, name, goal, startAt, endAt, state, createdAt, completedAt)`, with
  `idx_sprints_project`. A **partial unique index**
  `ON sprints(projectId) WHERE state = 'active'` makes "one active sprint per project" a schema
  fact, not just a check, the same backstop `idx_tasks_ticket_key` gives keys.
  `['sprintId', 'TEXT']` joins the guarded column loop (`store.ts:1770`), with
  `idx_tasks_sprint`. There is no foreign key, for the reason `milestoneId` has none.
- **Methods:**
  - `listSprints(projectId)`: active first, then future in creation order, then closed newest
    first.
  - `addSprint`, `updateSprint` (name, goal and dates only).
  - `startSprint(id)`: checked with `canStartSprint`; a race loses to the unique index and
    returns `undefined`.
  - `completeSprint(id, targetSprintId | null)`: **one transaction**. It applies
    `planCompletion`, setting `sprintId` on the moved tickets, then sets `state = 'closed'` and
    `completedAt`.
  - `deleteSprint(id)`: refused while the sprint is active. It clears `sprintId` on its tickets
    the way `deleteMilestoneTx` does.
- **Completing a sprint never moves a card between columns** (memory *card-state-is-the-humans*).
  It changes only which sprint a ticket belongs to, and `status` is never written.
- **The settings switch moves to `board.currentSprintOnly`.** It no longer means "JIRA's
  switch"; it means "this board, current sprint". A one-time fold in the settings read path does
  the move, in the same shape as the `syncIntervalMinutes` fold already in the store: read
  `jira.currentSprintOnly` into `board.currentSprintOnly` and write it back once. The JIRA sync
  (`ipc.ts:3228`) reads the new key. Both keys are global, so the setting stays account-wide. For
  one release the save path also writes `jira.currentSprintOnly`, so an older desktop on the same
  account keeps honouring the switch.

### Server & sync

- **Sprints are relayed, not mirrored**, exactly as milestones are. They get new channels
  `sprint:list|save|start|complete|remove`, all `'relay'` in `ipcRelay.ts`, plus
  `sprint:changed`, `replace-last`, in `ipcEventFanout.ts`. `test/ipc-relay-coverage.test.ts`
  fails until every new channel is classified, which is the point (memory
  *support-all-interactions-in-the-web*).
- **`sprintId` travels on `Task`** in `MirrorDelta` for free, because the task row is mirrored
  whole. `apps/server` keeps the task as a JSON payload in its mirror rows, so there is no server
  migration. It is an optional field an older peer may ignore, so `PROTOCOL_VERSION` stays 2.
- **The board filter on the web** needs the active sprint ids. It loads them with the relayed
  `sprint:list` and keeps them fresh from `sprint:changed`, the same way the web already learns
  milestones.

### UI — desktop

Copy the real components; do not redraw them (memory *mock-the-real-components*).

- **Backlog** (`BacklogTable.tsx`):
  - **Sprint sections** sit above the existing epic-grouped backlog. The active one comes first,
    then future ones, each with a header showing name, dates, ticket count and points. The active
    header has a **Complete sprint** button, and a future one has **Start sprint**.
  - **Create sprint** prefills `nextSprintName` and a two-week window from today.
  - A row's menu gains **Move to sprint ▸** (each open sprint, and *Backlog*). Multi-select moves
    are out of scope.
  - The pure layout goes in a new `sprintSections.ts`, tested like `backlogView.ts`.
- **Complete sprint dialog:** "N tickets are not done. Move them to:" a future sprint, a *new
  sprint*, or *Backlog*. Done tickets stay on the closed sprint, and the dialog says so.
- **Ticket drawer** (`TicketDrawer.tsx`): a **Sprint** field next to Milestone, offering open
  sprints and *None*, saved through `ticket:update`.
- **Board toggle:**
  - The **Current sprint** switch is drawn when JIRA is enabled **or** the scope holds a native
    ticket project that has sprints. It saves `board.currentSprintOnly`, and it re-syncs only
    when JIRA is enabled, since native filtering needs no fetch.
  - The filter runs in the `MyTasks.tsx:517` pipeline, after `groupSubtasks` and before
    `focusCards`.
  - The status bar names the sprint, using the extended `currentSprintName`.
  - With no active sprint, the switch's tooltip and a quiet line under the toolbar say
    "No active sprint in TM — showing all cards".
- **Never hide what needs you:**
  - When the filter hides a card that wants attention (ring, question, failed gate), a
    monochrome "N hidden · 1 needs you" control appears next to the switch, and clicking it turns
    the filter off.
  - Arrows to hidden cards reuse focus mode's dangling-end count.
  - Colour stays on the moving things (memory *board-colour-budget*).
- **Chip:** a native card shows its sprint name in the existing sprint chip, resolved from the
  sprint list and passed down like `epicName`. It stays hidden while the switch is on, as today.

### UI — web

- The same `BacklogTable` sprint sections, the drawer field and the board filter come from
  `packages/ui`. `apps/web` only loads the relayed `sprint:list` and subscribes to
  `sprint:changed` (memory *web-mirrors-the-desktop*).
- `BoardToolbar.tsx`'s switch gets the same "drawn when" rule, and the web Settings toggle saves
  `board.currentSprintOnly`.

### Failure modes & edge cases

- **Two devices start a sprint at once:** the partial unique index lets only one win. The loser
  gets a refusal saying another sprint is already active, never a second active sprint.
- **A ticket moves to another project:** its `sprintId` would point at a foreign sprint. The
  filter treats a sprint outside the ticket's own project as "no sprint", and the drawer clears
  it on save.
- **Deleting a sprint that has tickets:** refused while it is active. Otherwise it clears the
  pointers in one transaction, and the tickets land in the backlog.
- **A done ticket reopened after its sprint closed:** it stays on the closed sprint until a human
  moves it. A closed sprint is history, and nothing re-files work automatically.
- **The setting fold on an old database:** idempotent, and it writes back only when the new key
  is absent, so it can never overwrite a later choice. Older desktops keep reading
  `jira.currentSprintOnly`, which is written alongside for one release.
- **JIRA parity limits:** a JIRA card's sprint stays JIRA's. Native sprints never write back to
  JIRA, and JIRA sprints never appear in the native sprint list.
- **An emptied filter result:** if every native ticket is outside the active sprint, the board
  says "Sprint 3 has no tickets yet — plan it in the Backlog" instead of drawing blank columns.

## Out of scope (v1)

- Burndown, velocity and capacity charts.
- Multi-select and drag-and-drop between sprints; moving is via the row menu and the drawer.
- Sprints spanning several projects, and sprints on the Personal board.
- Writing native sprints to JIRA, or importing JIRA sprints as native ones.
- Automatic sprint start or completion on dates (it could be an F1 automation later).

## Open questions

1. **Global or per-scope switch?** Today it is one account-wide flag. *Recommended default:* keep
   one flag in `board.currentSprintOnly`. A per-scope map adds a second state to explain, and a
   board without sprints already shows everything.
2. **What does Complete do with done tickets?** *Recommended default:* they stay on the closed
   sprint as its record. Only unfinished tickets move.
3. **Default sprint length?** *Recommended default:* two weeks from the day it is created,
   editable in the dialog. No project-level setting in v1.
4. **Can a ticket outside the active sprint be started by an agent?** *Recommended default:* yes.
   Sprints scope the *view*, never the engine (the same rule as links and milestones).
5. **How long is `jira.currentSprintOnly` written as well?** *Recommended default:* one release.
   Then drop the write; keep the read fold permanently.

## Tasks

### F11 · Phase 1 — Contracts and pure logic

- [ ] F11.1 Add the Sprint contract and sprintId to the ticket model

  - `Sprint`, `SprintInput` and `SprintState` in `packages/shared/src/model.ts` beside `Milestone`;
    `sprintId` on `Task`, `TicketInput` and `TicketPatch` (`model.ts:1297`).
  - Acceptance: `pnpm typecheck` green across the workspace; `ticketFields.ts`'s
    `draftFromTicket` / `ticketPatchFrom` carry `sprintId`, with a round-trip test in
    `ticketFields.test.ts`.

- [ ] F11.2 Write the pure sprint rules in packages/shared @needs: F11.1 Add the Sprint contract and sprintId to the ticket model

  - New `packages/shared/src/sprints.ts`: `canStartSprint`, `planCompletion`, `nextSprintName`,
    `activeSprintOf`, `orderSprints`.
  - Acceptance: tests that refuse starting a second active sprint, a closed sprint, or a sprint
    with no end date; that `planCompletion` keeps done tickets and moves every other status
    (including blocked and in-review) to the target or the backlog; and the naming sequence
    after gaps and deletions.

- [ ] F11.3 Write the current-sprint card filter shared by both boards @needs: F11.1 Add the Sprint contract and sprintId to the ticket model

  - `currentSprintCards` plus an extended `currentSprintName` in
    `packages/ui/src/board/currentSprint.ts`, and a `hiddenNeedsYou` count for the "N hidden ·
    1 needs you" control.
  - Acceptance: tests in `currentSprint.test.ts` showing that a native ticket in the active
    sprint is kept and one in a future sprint or the backlog is hidden; that a project with no
    active sprint keeps everything; that JIRA, GitHub and ad-hoc cards pass through; that steps
    follow their parent; that a foreign-project `sprintId` counts as none; and that the hidden
    attention count is right.

### F11 · Phase 2 — Store and migration

- [ ] F11.4 Add the sprints table, the sprintId column and their migration @needs: F11.1 Add the Sprint contract and sprintId to the ticket model

  - In `apps/client/src/main/store.ts`: the `sprints` table and `idx_sprints_project`; the partial
    unique index for one active sprint per project; `['sprintId', 'TEXT']` in the guarded column
    loop (`:1770`); `idx_tasks_sprint`; and `sprintId` in `taskToRow` / `rowToTask` and the
    task `INSERT`.
  - Acceptance: the store has no tests (memory *the-store-has-no-tests*), so prove it with the
    electron-as-node recipe. Snapshot a real DB with the backup API, open it with `createStore`
    twice (the second open is a no-op), downgrade by dropping the column and the table, then
    reopen to exercise the ALTER path. Row counts before and after are equal, and a second
    `active` insert for one project fails on the index.

- [ ] F11.5 Implement sprint store methods and the complete-sprint transaction @needs: F11.4 Add the sprints table, the sprintId column and their migration, F11.2 Write the pure sprint rules in packages/shared

  - `listSprints`, `addSprint`, `updateSprint`, `startSprint`, `completeSprint` (one
    transaction: move unfinished tickets, then close), and `deleteSprint` (refused while active;
    it clears pointers like `deleteMilestoneTx`).
  - Acceptance: a `scripts/verify-sprints.mjs` scenario on a temp DB that creates two sprints and
    starts one, shows a second start is refused, completes with tickets in every column, and
    asserts that **no ticket's `status` changed** (memory *card-state-is-the-humans*), that done
    tickets stay, and that the others moved. Prove it can fail by mutation (memory
    *headless-scenario-harness-traps*).

- [ ] F11.6 Fold jira.currentSprintOnly into board.currentSprintOnly @needs: F11.1 Add the Sprint contract and sprintId to the ticket model

  - `board.currentSprintOnly` in `packages/shared/src/settings.ts`; a one-time fold in the
    settings read path, the same shape as the `syncIntervalMinutes` fold; the JIRA sync at
    `ipc.ts:3228` reads the new key; the save path also writes the old one for one release.
  - Acceptance: settings tests that an old blob with the JIRA flag on comes out with
    `board.currentSprintOnly: true`; that a blob that already has the new key is never
    overwritten; and that the fold is idempotent. `GLOBAL_SETTINGS_KEYS` is unchanged (both live
    under global keys), so the mirror replay test stays green.

### F11 · Phase 3 — IPC, relay and sync

- [ ] F11.7 Add the sprint IPC channels, relay classification and the sprint:changed event @needs: F11.5 Implement sprint store methods and the complete-sprint transaction

  - `sprint:list|save|start|complete|remove` in `packages/shared/src/ipc.ts` and handlers in
    `apps/client/src/main/ipc.ts`, next to `milestone:*`, with `assertTicketRefs` widened to
    validate a `sprintId` belonging to the same project. `'relay'` in `ipcRelay.ts`;
    `sprint:changed` as `replace-last` in `ipcEventFanout.ts`; and `project:tasksChanged` after a
    completion.
  - Acceptance: `test/ipc-relay-coverage.test.ts` and the fanout test pass with the new
    channels; handler tests that the refusals come back as readable errors (second active
    sprint, foreign-project sprint on a ticket).

- [ ] F11.8 Carry sprintId through the cloud mirror @needs: F11.4 Add the sprints table, the sprintId column and their migration

  - Confirm `sprintId` survives `cloudDelta` shaping, `apps/server` mirror storage and
    `cloudBoardApply` on the desktop; add it wherever a task field list is spelled out.
  - Acceptance: `cloudDelta.test.ts` and a `mirror.service` test round-trip a ticket with a
    `sprintId`; an older payload without the field still applies.

### F11 · Phase 4 — Desktop UI

- [ ] F11.9 Add sprint sections with Start and Complete to the Backlog @needs: F11.7 Add the sprint IPC channels, relay classification and the sprint:changed event

  - The pure `packages/ui/src/projects/sprintSections.ts` (sections, counts, points) and the
    `BacklogTable.tsx` sections with headers, Create sprint, Start sprint, the Complete sprint
    dialog, and **Move to sprint ▸** on rows.
  - Acceptance: `sprintSections.test.ts` covers ordering, counts and the empty states; `pnpm
    build` green; a headless smoke check (memory *verify-electron-app*, never launch the user's
    app) renders a seeded project with an active and a future sprint.

- [ ] F11.10 Add the sprint field to the ticket drawer @needs: F11.7 Add the sprint IPC channels, relay classification and the sprint:changed event

  - A **Sprint** dropdown next to Milestone in `TicketDrawer.tsx` (open sprints, plus *None*),
    saved through `ticket:update`.
  - Acceptance: the `ticketFields.test.ts` patch cases for setting, clearing and unchanged; a
    closed sprint is never offered, but a ticket already on one still shows its name read-only.

- [ ] F11.11 Apply the Current sprint toggle to native tickets on the board @needs: F11.3 Write the current-sprint card filter shared by both boards, F11.6 Fold jira.currentSprintOnly into board.currentSprintOnly, F11.7 Add the sprint IPC channels, relay classification and the sprint:changed event

  - In `MyTasks.tsx`: the new "drawn when" rule, the save to `board.currentSprintOnly`, a
    re-sync only when JIRA is enabled, the filter in the `:517` pipeline, the "N hidden · 1 needs
    you" control, and the no-active-sprint line. `App.tsx:222` uses the extended
    `currentSprintName`. Native cards get their sprint name in the existing chip.
  - Acceptance: selector tests from F11.3 wired in unchanged; `pnpm typecheck`, `pnpm test` and
    `pnpm build` green; on a seeded TM board with an active sprint, To Do shows only that
    sprint's tickets and the status bar names it.

### F11 · Phase 5 — Web and verification

- [ ] F11.12 Bring sprint planning and the toggle to the web board @needs: F11.9 Add sprint sections with Start and Complete to the Backlog, F11.11 Apply the Current sprint toggle to native tickets on the board, F11.8 Carry sprintId through the cloud mirror

  - `apps/web` loads `sprint:list` over the relay and subscribes to `sprint:changed`.
    `BoardToolbar.tsx`'s switch gets the same drawn-when rule and saves `board.currentSprintOnly`
    (`SettingsScreen.tsx:589` too). The shared Backlog and drawer render unchanged.
  - Acceptance: `httpTransport` tests that the sprint channels are relayed, not refused;
    `boardSelectors` tests that the web board filters exactly like the desktop's; web build green.

- [ ] F11.13 Write the sprints end-to-end verification and docs @needs: F11.12 Bring sprint planning and the toggle to the web board

  - Extend `scripts/verify-sprints.mjs` across the IPC layer (create, start, move tickets,
    filter, complete into a new sprint). Add a "Sprints" section to
    `docs/12-the-ticket-model.md` and glossary entries in `docs/05-glossary.md`.
  - Acceptance: the script fails when any one of start-refusal, completion-moves-status or the
    filter is mutated, and passes as written; docs mention every new channel and the setting fold.
