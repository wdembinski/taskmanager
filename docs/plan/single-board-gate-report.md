# Single board for all tickets — critical files, and the merge this branch is heading into

Step 9 of this branch's plan (`feat/single-board-for-all-tickets-and`). The plan names eight
files/areas this round lives or dies on. Each was re-opened on the finished tip (`4799804`)
rather than trusted from what an earlier step measured, and the four gates were re-run there,
forced, so a number that had moved would mean something drifted underneath.

## The eight, read on the finished tip

| File                                                      | What it had to be                                                                                                                                                   | Confirmed                                                                                                                                                                                                                                                                                                                                                            |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/shared/src/model.ts`                            | `Project`'s capabilities derived from fields (`hasPlan`/`hasRepo`/`ownsTickets`/`isBoardProject`), no `kind` discriminator left in the type; `ProjectPatch` widened | ✅ — `hasPlan`/`hasRepo`/`ownsTickets`/`isBoardProject`/`isPersonalBoard` at `:107-152`, each a one-line predicate over a field, with the header explaining why capability is derived rather than stored                                                                                                                                                             |
| `packages/shared/src/ipc.ts`                              | The unified `project:*` contract, `board:tasks`/`board:archived` widened to take a scope                                                                            | ✅ — no `agentProject:*` or `ticketProject:*` left; `board:tasks`/`board:archived` both take `BoardScope \| undefined`                                                                                                                                                                                                                                               |
| `packages/shared/src/ipcRelay.ts`                         | Every channel classified, exhaustively (`RELAY_POLICY` is `satisfies`-checked over `keyof IpcApi`)                                                                  | ✅ — `board:tasks`/`board:archived`/`board:scopes`/`ticket:create`/`task:setProject` all `'relay'`; `test/ipc-relay-coverage.test.ts` passes, which is the strong half of this guarantee and does not need re-proving here                                                                                                                                           |
| `apps/client/src/main/store.ts`                           | `getAllBoardTasks`/`getAllArchivedBoardTasks` added beside the existing per-project reads; `addProject`/`createTicketTx` unaffected in shape                        | ✅ — `getBoardTasks`/`getArchivedTasksFor` (per-project) sit beside `getAllBoardTasks`/`getAllArchivedBoardTasks` (unioned) at `:2809-2828`; `createTicketTx` (`:2868`) still allocates atomically off the project's own `ticketSeq`                                                                                                                                 |
| `apps/client/src/main/ipc.ts`                             | `board:tasks`/`board:archived` branch on `scope`; `board:scopes` offers Personal plus every `isBoardProject` project                                                | ✅ — `:2204-2225`. **The `kind === 'agent'` guard named in the plan is gone** — see "One stale phrase" below                                                                                                                                                                                                                                                         |
| `apps/client/src/renderer/src/MyTasks.tsx`                | The scope dropdown, and the seven-subscription effect kept off `scope`'s own dependency list                                                                        | ✅ — the live-update effect at `:361-405` subscribes exactly seven channels (`task:changed`, `project:tasksChanged`, `settings:changed`, `mergeRequests:changed`, `chain:changed`, `attachment:changed`, `board:notice`) on `[patchTask, refreshArchived]`; `scopeRef`/`scopeIdsRef` (`:147-153`) are how the effect reads the current scope without depending on it |
| `packages/ui/src/AddTaskDialog.tsx`                       | `addTaskPlan` stays pure, and knows about `boardId`                                                                                                                 | ✅ — `:197-236`, no side effect, `board: form.boardId` on the `'card'` branch; `AddTaskDialog.test.ts:64` asserts a project board carries through onto `plan.board`                                                                                                                                                                                                  |
| `apps/web/src/board/boardSelectors.ts`, `BoardScreen.tsx` | The web restates `store.ts`'s scope filter in JS                                                                                                                    | ✅ — `selectBoardTasks`/`selectArchivedTasks` (`boardSelectors.ts:36-54`) match `getAllBoardTasks`'s join exactly (`inScope` falls back to `isBoardProject` on the mirrored `Project`, or `PERSONAL_PROJECT_ID` when the project has not mirrored yet); `BoardScreen.tsx:218-228` is the only caller                                                                 |

## One stale phrase, already resolved by an earlier step

The plan describes `apps/client/src/main/ipc.ts` by "the `kind === 'agent'` guards." That
phrase describes the file **before** this branch's own step 1
(`ef614d0 refactor(projects): derive project capabilities from fields, drop kind
discriminator`) ran. On the finished tip there is no `kind === 'agent'` (or any `project.kind`)
comparison left in `ipc.ts` — every guard reads `hasRepo`/`isBoardProject`/`isPersonalBoard`
instead (`ipc.ts:595,672,817,911,1015,2221`). The `kind` **column** is still written to the
database — `store.ts:1338-1339,1415-1423` keeps it as a one-way migration safety net for
databases that predate the field-derived model — but nothing in this branch's TypeScript
branches on it any more. Nothing to fix here: the code already reflects the newer design: the
plan's own phrasing simply predates the step that changed it.

## The gates, forced, on the finished tip (`4799804`)

| Gate                     | Exit | Result                                                                       |
| ------------------------ | ---- | ---------------------------------------------------------------------------- |
| `pnpm format:check`      | 0    | All matched files use Prettier code style                                    |
| `pnpm typecheck --force` | 0    | 9 successful, 9 total — **0 cached**, 25.5s                                  |
| `pnpm build --force`     | 0    | 6 successful, 6 total — **0 cached**, 31.0s                                  |
| `pnpm test`              | 0    | 178 files passed, 1 skipped (179); **2983 passed, 11 skipped (2994)**, 56.2s |

`test/ipc-relay-coverage.test.ts` is inside that count and is the file that would fail if
`ipc.ts` and `ipcRelay.ts` had drifted apart — it passed, which is the strong confirmation for
row 2 and row 3 of the table above.

## The merge this branch is heading into — and it is not a quiet one

`origin/development` is **78 commits ahead** of this branch's base (`0079851`). A read-only
`git merge-tree 0079851 HEAD origin/development` was run to see what an actual rebase would
face, rather than guessing from the commit count. It produced **44 unresolved conflict
markers across 14 files** — seven of them are this round's own eight critical files:

| File                                        | Conflict markers |
| ------------------------------------------- | ---------------- |
| `apps/client/src/renderer/src/MyTasks.tsx`  | 9                |
| `apps/web/src/board/BoardScreen.tsx`        | 7                |
| `packages/shared/src/ipc.ts`                | 4                |
| `apps/web/src/board/BoardToolbar.tsx`       | 3                |
| `apps/web/src/board/boardSelectors.ts`      | 3                |
| `packages/ui/src/board/TaskCard.tsx`        | 3                |
| `test/shell-parity.test.ts`                 | 4                |
| `apps/client/src/main/ipc.ts`               | 2                |
| `apps/client/src/renderer/src/Settings.tsx` | 2                |
| `apps/web/src/board/useBoardExtras.ts`      | 2                |
| `apps/web/src/settings/SettingsScreen.tsx`  | 2                |
| `apps/client/src/renderer/src/App.tsx`      | 1                |
| `apps/web/src/board/boardSelectors.test.ts` | 1                |
| `packages/shared/src/ipcRelay.ts`           | 1                |

`packages/shared/src/model.ts` and `apps/client/src/main/store.ts` — the other two critical
files — DO show up as "changed in both", but both resolve cleanly: `development` only adds an
unrelated `autoCreatePr` field/column next to `autoRelease`, on lines adjacent to this branch's
own edits. `packages/ui/src/AddTaskDialog.tsx` has no overlap with `development` at all.

**This is not textual proximity — it is the same problem solved twice, differently.**
`development` already shipped its own answer to "tickets on a board", independently of this
branch, while this branch was in flight. Reading the `their` side of the conflicts above:

- `development` kept the `kind` discriminator this branch's step 1 removed — `ipc.ts`'s
  `their` side still filters `project.kind === 'agent'` / `'ticket'`.
- `development` kept `agentProject:*` and added a **parallel** `ticketProject:*`,
  `ticket:*`, `person:*`, `label:*`, `milestone:*` and `ticketLink:*` surface —
  `packages/shared/src/ipcRelay.ts`'s `their` side classifies 21 channels this branch's
  `RELAY_POLICY` has never heard of, none of them present here.
- `development` built a **separate** `Projects` tab (`packages/ui/src/projects/Projects.tsx`,
  `TicketDrawer.tsx`, `ganttLayout.ts`, `backlogView.ts`, `ticketFields.ts`,
  `PeopleSettings.tsx`, `ProjectAdmin.tsx`) with its own Gantt/backlog view and its own
  `boardScope.ts` — none of which exists on this branch, and none of which this branch's
  single-board design (`board:tasks(scope)`, `isBoardProject`) was written against.
- `apps/client/src/renderer/src/App.tsx`'s own conflict is the two designs describing
  themselves in the same doc comment: this branch says the Personal board "is itself a
  project"; `development` says the same thing and then describes the Phase 24 `Projects` tile
  it added next to it.

None of the 44 markers are proximity noise from two unrelated diffs landing near each other —
every one sampled here is two designs for the same feature disagreeing about what the feature
is. A mechanical resolution (take one side per hunk) would very likely leave the app with two
half-wired ticket models — one branch's fields-derived, single-board version and
`development`'s `kind`-discriminated, separate-tab-and-Gantt version, neither fully wired to
the other's IPC surface. **That choice is not this step's to make** — a step may not reshape
the branch, and which of two independently-built designs the app keeps is a product decision,
not a merge-conflict resolution. It is recorded here so the integrator does not discover it by
running `pnpm typecheck` red after a rebase that looked clean commit-by-commit.
