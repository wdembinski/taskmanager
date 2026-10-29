# F29 — Performance at scale

> **Status:** proposed · **Written:** 2026-10-29 · **Where:** client (main process +
> renderer), packages/ui, web · **Depends on:** — · **Unlocks:** F25 (filters, views and
> search assume a board that stays responsive) · **Mockups:** the existing v9/v10 screens;
> F29 changes how they draw, not how they look
> Only the `- [ ]` checkboxes under **Tasks** become cards when this file is imported as a
> plan; everything else is context.

## Why

The owner's board froze on Approve and lagged on scroll. Measured on the live database on
2026-10-29:

- the Task Manager project has **1,562 cards**, and its full task list serialises to
  **8.6 MB**, because every card carries its plan and ticket text;
- `project:tasksChanged` sends that whole list after many actions (26 call sites in
  `apps/client/src/main/ipc.ts`, Approve among them) and `send` also publishes it to the
  cloud mirror;
- the renderer then redraws every card; nothing in the UI virtualises a list;
- the database file is **1.1 GB**, most of it **716,441 `task_events` rows** that are never
  pruned.

The goal: the UI answers within one frame (16 ms) on a 5,000-card board, for Approve,
drag, scroll, opening a card and expanding a group.

## Design

### Measure first

- A seeded 5,000-card fixture (steps, plans and ticket text at today's average sizes) that
  both the headless UI shots and a perf script can load.
- Long-task logging in the renderer (`PerformanceObserver` for `longtask`) and timing of
  every IPC handler in the main process, both written to the existing log with the channel
  name. Off in production unless a setting turns it on.
- A perf script that drives the five interactions above against the fixture and fails over
  budget. Every F29 card quotes its before and after numbers from it.

### Send less

- The board receives **card summaries**: key, title, status, column, chips, agent state,
  link counts, epic and milestone ids. Plan, ticket text, run output and attachments load on
  demand when a card opens (`task:get`).
- After an action the main process sends only the cards that changed
  (`task:changed` with the summary, or a small batch event), never the whole list. A full
  list is sent once on load and on project switch.
- The cloud mirror publishes summaries and deltas the same way.

### Draw less

- Board columns, the issue list and the sidebar tree render only the rows in view (a small
  windowing helper in packages/ui or an established library, chosen by the card's plan).
- Cards are memoised on their summary, so an unrelated change redraws nothing.
- Large updates use `startTransition` so input stays responsive.

### Keep the main process free

- Prune `task_events`: keep every event of the last N runs per card (default 5) and of any
  run in the last 30 days; delete the rest in small batches when idle, then compact.
- No synchronous work over the whole task list in an IPC handler; anything that must be,
  moves to an idle batch.

### Navigate thousands of cards

- **Accordion sidebar:** opening a milestone or group closes its siblings at the same level.
  Alt-click opens one without closing the others. "Collapse all" in the sidebar header. The
  remembered fold state (AppSettings fold lists, memory *folding-steps-on-a-card*) keeps
  working.
- **Load a group when it opens:** a closed group shows its count only; its rows are fetched
  and drawn when it opens.
- **Done and Archived are hidden by default** in the sidebar tree and the issue list, behind
  one "Show done" switch that is remembered.
- Search, filters, saved views and keyboard navigation stay in **F25**; run F25.6 (palette
  search), F25.7 and F25.8a (filter bar) after F29.

## Baseline (F29.1, 2026-10-29)

These numbers come before any F29 fix. Every later F29 card quotes its before and after
numbers against this table, from the same command on the same fixture.

| Interaction   | longest task (ms) | longest frame gap (ms) | long tasks (count) | IPC in (KB) | events (KB) | budget (ms) | verdict |
| ------------- | ----------------: | ---------------------: | -----------------: | ----------: | ----------: | ----------: | ------- |
| open-card     |             716.8 |                  716.8 |                  4 |         7.9 |         0.0 |          16 | over    |
| approve       |             516.6 |                  516.6 |                  2 |     27734.0 |     27731.1 |          16 | over    |
| drag-card     |             616.7 |                  616.7 |                  3 |         2.4 |         0.9 |          16 | over    |
| scroll-column |             733.5 |                  733.5 |                 49 |         0.6 |         0.0 |          16 | over    |
| scroll-issues |              33.4 |                   33.4 |                  0 |         0.0 |         0.0 |          16 | over    |
| expand-group  |             116.7 |                  116.7 |                  2 |         0.0 |         0.0 |          16 | over    |

Each value is the median of 3 runs. "Longest task" is the larger of the longest `longtask`
entry (Chrome reports 50 ms and up) and the longest gap between animation frames, which
catches the 16–50 ms range. The verdict is `over` when a long task was seen or a frame gap
passed 20 ms (one frame plus vsync jitter). Approve moves 27 MB twice: the
`project:tasksChanged` event with the whole board, then the `board:tasks` re-read.

- **Command:** `node scripts/perf-board.mjs --runs 3`.
  It builds the renderer, boots it in headless Chrome at 1440×900 and exits 0 even over
  budget; `--enforce` makes over budget exit 1.
- **Machine:** Windows 11 Pro, Intel Core i7-9700K @ 3.60 GHz, 32 GB RAM, Node 22.22.0,
  headless Chrome 156.0.8078.49.
- **Fixture:** `scripts/fixtures/scaleFixture.mjs`, 5,000 seeded cards, a task list of
  27.08 MB JSON (≈5.4 KB per card, matching the live database's average).
- **Main-process numbers** are not in this table: the script models main with a stub and
  never launches the app. For real numbers, start the app with `VIPPER_PERF_LOG=1` and grep
  `perf ` in `main.log` (in the app's logs folder). Each IPC call logs
  `perf ipc <channel> <ms>ms in=<bytes>B out=<bytes>B`, each event
  `perf event <channel> <bytes>B`, and each renderer long task
  `perf longtask <screen> <ms>ms`.
- **IPC bytes are modelled.** `scripts/lib/perfStub.mjs` answers from the fixture and, for
  the channels that change state, emits what main's handlers send today: Approve and the
  other `project:tasksChanged` senders send the whole board, a drag sends `task:changed`
  with the moved card. When F29.2 changes what main sends, the stub must change with it.

## Out of scope

- Server-side pagination for cloud workspaces (F19 owns the cloud read path).
- Changing what any screen shows.

## Tasks

### F29 · Phase 1 — Measure and send less

- [ ] F29.1 Measure the UI on a 5,000-card board with long-task logging and a perf budget

  - Fixture, logging, perf script, baseline numbers recorded in the doc.

- [ ] F29.2 Send card summaries and only the cards that changed

  - Summary shape, on-demand card detail, delta events, cloud mirror on summaries.

### F29 · Phase 2 — Draw less and stay light

- [ ] F29.3 Draw only the visible cards in the board, the issue list and the sidebar

  - Windowing, memoised cards, transitions; numbers before and after.

- [ ] F29.4 Prune old run events, compact the database and keep IPC handlers short

  - Retention rule, idle batches, compaction, handler timings under budget.

### F29 · Phase 3 — Navigate

- [ ] F29.5 Open one sidebar group at a time and load a group's cards when it opens

  - Accordion with Alt-click, Collapse all, lazy groups, Done and Archived hidden by default.
