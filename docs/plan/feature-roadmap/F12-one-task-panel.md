# F12 — One task panel

> **Status:** proposed · **Where:** `packages/ui` (desktop and web) · **Depends on:** — · **Unlocks:** managing a ticket from whichever screen you are on
> Only the `- [ ]` checkboxes under **Tasks** become cards when this file is imported as a plan; everything else is context.
>
> **Layout rule for this file:** every task's description bullets sit after a **blank line**. The plan
> parser folds any indented line that directly follows a checkbox into that task's *title*
> (`apps/client/src/main/planParser.ts:173-177`); the blank line is what keeps descriptions out of it.

## Why

A native ticket has two different detail views, and each one shows half of it.

- **On the Kanban board**, clicking a card opens `TaskDetail` in the right-hand pane. It has the
  title, key, priority, status, description, files, steps, the execution chain, merge requests,
  the agent controls and the conversation. It has **none** of the ticket fields (type, epic,
  milestone, labels, points, estimate, start and due dates, assignee, reporter) and **none** of
  the ticket links ("blocks", "duplicates", …).
- **In Projects** (Backlog and Timeline), clicking a ticket opens `TicketDrawer`. It has exactly
  those ticket fields and links, and none of the rest: no description, no status, no agent and no
  conversation.

So to set a milestone on a card you are working on, you leave the board, find the ticket in the
Backlog and open the drawer. To see what blocks a card, you open the Timeline. To talk to the agent
about a ticket you found in the Backlog, you go back to the board and look for its card.

F12 makes **one panel**. It is `TaskDetail`, which gains the ticket fields and the links, and it
opens from every screen: the board, the Backlog, the Timeline and the Graph. `TicketDrawer` is
retired. Wherever you are, clicking a ticket shows all of it, and every part of it can be edited
there.

## What we have today

- **`TaskDetail`** (`packages/ui/src/TaskDetail.tsx`, props at `:200`) is the board's pane. Its
  top band holds the identity row, the agent controls, `TaskDetailsCell` (status, the foldable
  description and the files), the steps and `TaskChain`. The desktop renders it at
  `apps/client/src/renderer/src/MyTasks.tsx:1488`, and the web at
  `apps/web/src/board/BoardScreen.tsx` (imported at `:63`). Many of its props come from the
  board's own state, not from the task: `attention`, `liveRunTaskIds`, `mergingTaskIds`,
  `chainWaitingOn` / `chainMergeHeld` from the chain index, `chainLinks`, `mrsByTask` and
  `attachmentsByTask`.
- **`TicketDrawer`** (`packages/ui/src/projects/TicketDrawer.tsx`) is an `OverlayDrawer` with an
  explicit **Save** button. Its header says why it leaves out the title, description and
  priority: those already go through `task:setDescription` / `task:setPriority`, which
  `TaskDetail` uses. It holds the twelve ticket-only fields, edited through `ticket:update` with
  `ticketPatchFrom` (`ticketFields.ts`); the inline managers for labels (`LabelRegistry`) and
  milestones (`MilestoneList`); and `TicketLinksEditor`. It is opened from
  `BacklogTable.tsx:262` / `:323` and `TimelinePane.tsx:1238`. `GraphPane` opens nothing.
- **`TicketLinksEditor`** (`projects/TicketLinksEditor.tsx`) loads `ticketLink:list` itself
  (`:65`) and phrases each row from the ticket's end through `linksFor()`
  (`@tm/shared/ticketLinks`). A refusal comes back as data and is shown as a message.
- **Two kinds of link, kept apart on purpose.** *Chain links* (`TaskLink`, `chain:links`) are
  execution order: the arrows on the board, which the release engine acts on. *Ticket links*
  (`TicketLink`, `ticketLink:*`) are documentation: "blocks", "relates to", and so on. They are
  not chain arrows (memory *roadmap-imported-as-tickets*). `TaskDetail` already shows the first
  kind in `TaskChain` and has never shown the second.
- **The registries.** `Projects.tsx:64-66` seeds `person:list`, `milestone:list` and
  `label:list`. The desktop board loads only `person:list` (`MyTasks.tsx:304`), and so does the
  web board (`useBoardExtras.ts:200`). The change events `person:changed`, `label:changed`,
  `milestone:changed` and `ticketLink:changed` are all already polled on the web
  (`apps/web/src/board/polledEvents.ts:95-101`), so the web needs no new relay work.
- **Saving.** `TaskDetailsCell` saves the description per field, through a `useDraft` (memory
  *web-mirrors-the-desktop*). `TicketDrawer` drafts text fields the same way, but holds the
  pickers in plain state until **Save**.

## Design

### The panel's sections

`TaskDetail`'s top band gains two sections. The pane stays one shape, read top to bottom, as its
header asks.

- **Ticket** (native tickets only, foldable, after the description). It holds type and epic
  (`TicketTypeFields`), milestone, labels, story points, estimate, start, due, assignee and
  reporter. The read-only "delegated to" indicator stays beside Assignee. The label and
  milestone managers stay as the small settings buttons they are in the drawer. Folded, it shows
  one quiet summary line ("Story · M1 — Work while away · 3 pts · due 14 Oct") so the board's
  pane stays short.
- **Links** (every card that has any). Ticket links are grouped by how they read from this
  ticket ("blocks", "is blocked by", "relates to", "duplicates"), with add and remove from
  `TicketLinksEditor`. Each row is the linked ticket's type glyph, key, title and status, and
  clicking it opens that ticket in the same panel. The execution chain stays in `TaskChain` as it
  is; the Links section only points to it ("Runs after TM-31 — see Chain"), because chain arrows
  are an engine fact and ticket links are not.
- **JIRA, GitHub, GitLab and ad-hoc cards** get no Ticket section, since those fields belong to
  the tracker or do not exist. They get the Links section only when they have ticket links.

### Saving

- **Each field saves on its own**, on change for a picker and on blur for text, through
  `ticket:update` with a one-field `TicketPatch`. That is how the description already saves in
  the same pane, and a **Save** button in a pane with a live conversation would be the only one
  there.
- Text fields keep their `useDraft` keys, so switching cards does not lose half-typed text.
- A refused save shows inline under its field and keeps the old value, like a refused link.

### One host for the panel

- **`TaskDetailHost`** (new, `packages/ui`) takes a task id and loads everything `TaskDetail`
  needs that is not the task itself: subtasks and parent, merge requests, attachments, chain
  links and the chain index, attention, live runs and merges, and the ticket registries. The
  board passes in what it already holds, so nothing is fetched twice. Projects lets the host load
  the rest itself.
- **`useTicketRegistries(projectId)`** (new, `packages/ui`) loads people, milestones, labels and
  ticket links, and refreshes on their four `*:changed` events. `Projects.tsx`'s seed, both
  boards and the host all use it.
- **Both boards render through the host**, so the board and Projects can never show the same
  ticket two different ways.

### Where it opens

- **Board:** unchanged. The right-hand pane, with the new sections.
- **Projects (Backlog, Timeline, Graph):** clicking a ticket opens the same panel as a right-hand
  pane beside the table, chart or graph, instead of `TicketDrawer`'s overlay. It uses the board's
  pane width and its show/hide setting (`showTaskDetail`). The Graph gains the click it lacks
  today.
- **Navigation inside the panel:** opening a linked ticket keeps a short **Back** history, so you
  can follow "is blocked by" and return. A **Show on board** action switches to the board with the
  card selected. If the board's filters hide the card (focus mode, Current sprint, a folded
  column), the board says which filter hid it instead of selecting nothing.
- **A ticket that is not on any board** (archived, or in a scope the board is not showing) still
  opens, because the panel reads by id, not from the board's list.

### Failure modes & edge cases

- **A ticket deleted while it is open:** the panel closes and says so, the same as the drawer
  closing on a missing row.
- **A ticket moved to another project:** the epic and milestone pickers re-scope to the new
  project, and a pointer into the old project is shown as "(other project)" until cleared.
- **The web without a reachable desktop:** the sections render read-only, wearing `TaskDetail`'s
  existing `readOnlyNotice`, like every other relayed edit.
- **A linked ticket the viewer cannot open** (its project was deleted): the row stays, greyed,
  with its key, so the link can still be removed.
- **Colour:** the new sections are monochrome. Only the moving things keep colour, such as a
  linked ticket's live status (memory *board-colour-budget*).

## Out of scope (v1)

- Editing JIRA, GitHub or GitLab fields from the panel; their tickets stay the tracker's.
- Showing chain links and ticket links on one graph inside the panel; the Graph tab already does.
- Bulk edits across several tickets.
- Creating a new ticket from the panel; that stays with the Add task dialog and `NewTicketDialog`.

## Open questions

1. **Save per field, or keep a Save button for the ticket fields?** *Recommended default:* per
   field, as the description already saves. One pane should not have two save models.
2. **Does the Projects pane include the conversation?** *Recommended default:* yes. It is the
   same panel, so the conversation is there; it starts scrolled to the end and the bands keep
   their 50% cap, so the ticket fields stay in view.
3. **Is the Ticket section open or folded by default?** *Recommended default:* folded on the
   board (the summary line is enough while you work) and open in Projects (you came to edit the
   ticket). The fold is remembered per device, like the other folds.

## Tasks

### F12 · Phase 1 — Shared pieces

- [ ] F12.1 Extract the ticket field editors into a TicketFieldsSection that saves per field

  - Move the twelve field editors, the label and milestone managers and the delegated-agent
    indicator out of `TicketDrawer.tsx` into `packages/ui/src/projects/TicketFieldsSection.tsx`.
    Each field saves on its own through `ticket:update`, with a one-field patch from
    `ticketFields.ts`. `TicketDrawer` renders the section until F12.8 retires it.
  - Acceptance: `ticketFields.test.ts` cases that each single-field patch carries only that field,
    that clearing a picker sends `null`, and that an unchanged field sends nothing. `pnpm
    typecheck` and `pnpm test` green.

- [ ] F12.2 Add the useTicketRegistries hook shared by every screen

  - `packages/ui/src/projects/useTicketRegistries.ts`: people, milestones and labels for a
    project, plus ticket links, refreshed on `person:changed`, `milestone:changed`,
    `label:changed` and `ticketLink:changed`. `Projects.tsx`'s seed (`:64-66`) moves onto it.
  - Acceptance: a test of the pure scoping helper (a project's milestones and labels only;
    closed milestones kept for display but not offered); Projects loads unchanged; `pnpm build`
    green.

- [ ] F12.3 Write the pure linked-tickets view model

  - `packages/ui/src/projects/linkedTickets.ts`: `linkedTicketRows(ticket, ticketLinks,
    tasksById)` groups a ticket's links by how they read from its end (through `linksFor()`),
    with each row's key, title, type and status. A missing ticket becomes a greyed row that can
    still be removed. A chain link becomes one pointer row that defers to `TaskChain`.
  - Acceptance: `linkedTickets.test.ts` covers both directions of "blocks", a duplicate pair, a
    linked ticket in another project, a deleted ticket, a ticket with no links (no section), and
    the chain pointer.

### F12 · Phase 2 — The board's panel

- [ ] F12.4 Add the Ticket section to TaskDetail for native tickets @needs: F12.1 Extract the ticket field editors into a TicketFieldsSection that saves per field, F12.2 Add the useTicketRegistries hook shared by every screen

  - A foldable **Ticket** section after the description in `TaskDetail`'s top band, rendering
    `TicketFieldsSection`, with a one-line summary when folded and the fold remembered per device.
    Native tickets only (`isNativeTicket`).
  - Acceptance: a pure `ticketSummaryLine` with tests (empty fields drop out, dates in the local
    format, points singular and plural); JIRA and ad-hoc cards render no section; `pnpm build`
    green; a headless smoke check (memory *verify-electron-app*, never launch the user's app)
    shows the section on a seeded native ticket.

- [ ] F12.5 Add the Links section to TaskDetail @needs: F12.3 Write the pure linked-tickets view model, F12.4 Add the Ticket section to TaskDetail for native tickets

  - A **Links** section rendering `linkedTicketRows`, with add and remove from
    `TicketLinksEditor`. Clicking a row calls `onOpenTask` with the linked ticket's id. The chain
    pointer row scrolls to `TaskChain`.
  - Acceptance: a refusal from `ticketLink:add` shows as a message, not an error; the section is
    absent for a card with no links; adding a link from the panel shows up in the Timeline's
    arrows without a reload (`ticketLink:changed`).

- [ ] F12.6 Load the ticket registries on both boards @needs: F12.4 Add the Ticket section to TaskDetail for native tickets, F12.5 Add the Links section to TaskDetail

  - `MyTasks.tsx` and the web `BoardScreen.tsx` / `useBoardExtras.ts` use `useTicketRegistries`
    for the selected card's project and pass the results to `TaskDetail`. The existing
    `person:list` loads fold into the hook.
  - Acceptance: the web board edits a milestone and a link through the relay with a desktop
    connected, and shows the sections read-only with `readOnlyNotice` without one; `pnpm
    typecheck`, `pnpm test` and `pnpm build` green for both apps.

### F12 · Phase 3 — One panel in Projects

- [ ] F12.7 Extract a TaskDetailHost that loads the panel for any task id @needs: F12.6 Load the ticket registries on both boards

  - `packages/ui/src/TaskDetailHost.tsx` takes a task id plus whatever the caller already holds,
    and loads the rest: subtasks and parent, merge requests, attachments, chain links and the
    chain index, attention, live runs and merges. `MyTasks.tsx:1488` and the web board render
    through it, passing their own state so nothing is fetched twice.
  - Acceptance: the board's pane is unchanged: `TaskDetail` has no tests of its own, so a
    headless smoke check renders the same seeded card before and after and compares the
    sections shown; a test of the host's pure prop-assembly helper that a caller-supplied value
    always wins over a loaded one; `pnpm build` green.

- [ ] F12.8 Open the shared panel from the Backlog, Timeline and Graph and retire TicketDrawer @needs: F12.7 Extract a TaskDetailHost that loads the panel for any task id

  - `Projects.tsx` gains a right-hand pane hosting `TaskDetailHost`, with the board's pane width
    and `showTaskDetail`. `BacklogTable.tsx:262`, `TimelinePane.tsx:1238` and a new node click in
    `GraphPane.tsx` select into it. `TicketDrawer.tsx` is deleted.
  - Acceptance: nothing imports `TicketDrawer`; every field the drawer edited can be edited from
    the pane, checked against the field list in `ticketFields.ts`; `pnpm build` green; a headless
    smoke check opens a Backlog ticket and shows its conversation and Ticket section.

- [ ] F12.9 Follow links inside the panel and jump to the card on the board @needs: F12.5 Add the Links section to TaskDetail, F12.8 Open the shared panel from the Backlog, Timeline and Graph and retire TicketDrawer

  - A short **Back** history in the panel when a linked ticket is opened. A **Show on board**
    action switches to the board with the card selected; when a board filter hides it, the
    board names the filter instead of selecting nothing.
  - Acceptance: pure tests for the history (push, back, a deleted entry skipped) and for
    `hiddenBy(card, boardState)` naming focus mode, Current sprint and a folded column.

### F12 · Phase 4 — Web and verification

- [ ] F12.10 Bring the Projects panel to the web @needs: F12.8 Open the shared panel from the Backlog, Timeline and Graph and retire TicketDrawer, F12.9 Follow links inside the panel and jump to the card on the board

  - The web Projects screen renders the same pane through the shared `Projects`, with the
    relayed loads the host needs and `readOnlyNotice` when no desktop is reachable.
  - Acceptance: `httpTransport` tests that every channel the host calls is relayed, not refused;
    `test/ipc-relay-coverage.test.ts` stays green; web build green.

- [ ] F12.11 Verify the one panel end to end and document it @needs: F12.10 Bring the Projects panel to the web

  - A `scripts/verify-one-task-panel.mjs` scenario on a temp DB: edit a milestone and add a link
    through the IPC layer, as the panel does, and check that the Backlog row and the board card
    read the same values back. Update the ticket-model and UI docs (`docs/12-the-ticket-model.md`,
    `docs/05-glossary.md`) to name one panel, and drop `TicketDrawer` from them.
  - Acceptance: the script fails when the per-field patch or the link refresh is mutated, and
    passes as written (memory *headless-scenario-harness-traps*).
