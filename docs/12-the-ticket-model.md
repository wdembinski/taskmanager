# 12. The ticket model

Phase 24 let the app *be* a tracker, not only mirror one. The whole design rests on one
decision, made before any code: a native ticket project is **a `projects` row** with
`kind: 'ticket'`, and a ticket is **a `tasks` row** with `source: 'ticket'`. Nothing below is
a second copy of the board — it is twelve new columns on `tasks`, two new columns on
`projects`, and four small tables, all reusing the cascades, the IPC plumbing and the board
machinery that already existed. The design itself is recorded in
[`docs/plan/README.md`](plan/README.md#phase-24--projects-and-their-tickets); this page is
the reference for what actually shipped, proved by
[`scripts/verify-tickets.mjs`](../apps/client/scripts/verify-tickets.mjs) — the only thing in
this repo that can open a real SQLite database, since Vitest's Node has no Electron ABI.

Phase 24 put project creation and the ticket backlog on one nav destination. The later
"Tickets and Projects tabs" plan split that in two: a `'projects'` tab manages a project's
identity (name, colour, the tickets-or-personal choice, shared with the browser through
`packages/ui/src/projects/ProjectAdmin.tsx`), and a `'tickets'` tab only picks a project and
browses its backlog/Gantt. Nothing on this page about the schema, key allocation or the link
vocabulary changed — the split is a UI reorganisation over the same `projects`/`tasks` rows.

---

## The schema

`projects` gains two columns ([`store.ts:918-924`](../apps/client/src/main/store.ts)):

- `ticketPrefix TEXT COLLATE NOCASE` — the key prefix (`'TM'`), `NULL` for every project that
  isn't a ticket project.
- `ticketSeq INTEGER NOT NULL DEFAULT 0` — the allocator. See **Key allocation** below for why
  this is not a field on `Project`.

`tasks` gains twelve ([`store.ts:985-1002`](../apps/client/src/main/store.ts)): `ticketKey`,
`ticketNumber`, `issueType`, `epicTaskId`, `milestoneId`, `labels`, `storyPoints`,
`estimateDays`, `startAt`, `dueAt`, `assigneeId`, `reporterId`. Four of them —
`epicTaskId`, `milestoneId`, `assigneeId`, `reporterId` — carry **no foreign key**, exactly as
`parentTaskId` already doesn't. `foreign_keys = ON` is set at open
([`store.ts:898`](../apps/client/src/main/store.ts)), so a declared cascade would really fire —
and it would change task rows with no IPC event behind it, which nothing in this renderer
polls for. So their owners null them with an explicit `UPDATE` inside the same transaction as
the delete, then push the event by hand: `clearEpicOnTasks` inside `deleteTaskDeep`
([`store.ts:2802-2814`](../apps/client/src/main/store.ts)), `deletePersonTx`
([`store.ts:2886-2890`](../apps/client/src/main/store.ts)), `deleteMilestoneTx`
([`store.ts:2893-2896`](../apps/client/src/main/store.ts)).

Two real cascades are kept, and only two — the places a delete already means "the renderer
re-reads the whole list anyway": `ticket_links` cascades from `tasks` on **both** ends
([`store.ts:1253-1262`](../apps/client/src/main/store.ts)), and `ticket_labels` /
`milestones` cascade from `projects` ([`store.ts:1213-1239`](../apps/client/src/main/store.ts)).

Four new tables: `people` (app-wide — a person works across projects, so it carries no
`projectId` at all), `milestones`, `ticket_labels` and `ticket_links`. `ticket_labels` is a
**registry** — it gives a label its colour and the filter dropdown its list — but a ticket's
own `labels` column is a JSON array of **names**, not ids
([`store.ts:1224-1231`](../apps/client/src/main/store.ts)), read back with `parseStringArray`
([`store.ts:2587`](../apps/client/src/main/store.ts)), the same decoder `dependsOn` already
uses. Names rather than ids for two reasons: the board read is the hottest query in the app
and a join table would add a second query plus a per-render regroup to it, and deleting a
label should degrade a chip to grey rather than leave a dangling reference.

### Why the three partial indexes are partial

Every one of them protects a fact that is only sometimes true, and the *rest* of the rows must
not be forced to agree on a placeholder value to coexist:

| Index | Rows it covers | The rows it lets alone |
| --- | --- | --- |
| `idx_projects_ticket_prefix` ON `projects(ticketPrefix)` WHERE `ticketPrefix IS NOT NULL` ([`store.ts:1402-1405`](../apps/client/src/main/store.ts)) | one ticket project per prefix | every plan/agent project, and a ticket project with no prefix yet |
| `idx_tasks_ticket_key` ON `tasks(ticketKey)` WHERE `ticketKey IS NOT NULL` ([`store.ts:1643-1646`](../apps/client/src/main/store.ts)) | one row per issued key | every task that isn't a native ticket |
| `idx_people_me` ON `people(isMe)` WHERE `isMe = 1` ([`store.ts:1207`](../apps/client/src/main/store.ts)) | the single person who is "me" | every other person, who is `isMe = 0` |

A plain (non-partial) unique index can't do this: SQLite's index already treats `NULL`
specially — two `NULL`s are never considered equal, so a `UNIQUE` index alone would already let
every prefix-less project or key-less task coexist. The `WHERE` clause is there for the
opposite reason, on the *other* value: `people(isMe)` has no `NULL`, only `0` and `1`, and
without the partial clause a plain unique index on `isMe` would let at most **one person exist
in the whole database**, since every non-"me" row is `isMe = 0` and those would collide with
each other. `WHERE isMe = 1` is what lets the many `0`s pile up while still capping the `1`s at
one. Proven behaviourally, not just by reading the DDL, in
[`verify-tickets.mjs`](../apps/client/scripts/verify-tickets.mjs) §2 ("All three are genuinely
PARTIAL").

All three are created **after** their `ALTER TABLE`, not inside the `CREATE TABLE IF NOT
EXISTS` block: on a database that predates Phase 24 the column doesn't exist until the ALTER
has run, the same discipline `idx_tasks_parent` already followed
([`store.ts:1637-1639`](../apps/client/src/main/store.ts)).

---

## Key allocation

`ticketKey` (`'TM-123'`) and `ticketNumber` (the durable ordinal) both live on the task row.
Storing both means the card, the backlog row, the Gantt gutter and the link picker read
`task.ticketKey` with no project lookup, and a prefix rename stays one `UPDATE` over the
project's rows rather than a re-numbering.

The number **never** comes from `MAX(ticketNumber)`. It comes from `projects.ticketSeq`, an
allocator that is deliberately **not** a field on `Project` — read and bumped only inside
`createTicketTx`, never by `updateProject`'s patch builder — because deleting `TM-500` must
not make the next ticket `TM-500` again. A key is a permanent name: it goes into commit
messages, branch names, chat and other people's notes, and re-issuing one makes every one of
those a lie about which ticket it refers to.

The clearest way to see why is to put the allocator beside the ordering counter the file
already has, because the two look almost identical and mean opposite things
([`store.ts:1882-1884`](../apps/client/src/main/store.ts)):

```sql
-- nextOrder: right for a POSITION
SELECT COALESCE(MAX("order"), -1) + 1 AS next FROM tasks WHERE projectId = ?
```

`nextOrder` recomputes a card's place in the column from whatever currently exists. That's
correct for an ordering: if the last card in a column is deleted, the next card dropped there
should absolutely reuse the freed-up position — a gap in `order` has no meaning to anyone, and
nothing anywhere has written that number down as a name.

```ts
// createTicketTx: fatal for a NAME
bumpTicketSeq.run(projectId);
const ticketNumber = (readTicketSeq.get(projectId) as { ticketSeq: number }).ticketSeq;
```

A `MAX(ticketNumber)`-style allocator would make `ticketSeq` exactly as forgetful as
`nextOrder` — and that forgetfulness is the bug. Once `TM-500` is deleted, `MAX` over what
remains has no memory that `500` was ever issued, and the very next create would hand `TM-500`
to a completely different ticket. `ticketSeq` is a monotonic counter precisely because it has
to remember what *used to exist*, not just what exists now — the one thing an ordering never
needs to do and a name always does.

The bump and the insert are one `db.transaction()`
([`store.ts:2830-2882`](../apps/client/src/main/store.ts)), so a refused create (blank title,
unknown project, a project that isn't `kind: 'ticket'`, or one with no usable prefix) never
burns a number — every refusal is checked *before* the bump. The one refusal that can't be
checked in advance — another project already holding the prefix this one is being renamed to —
is caught by `idx_projects_ticket_prefix` and rolls the counter back with it. The partial
unique index on `tasks(ticketKey)` is the schema-level backstop under the whole promise: no
matter what a caller does, including a raw SQL write that bypasses the allocator entirely, two
rows can never wear the same key (`verify-tickets.mjs` §4).

A prefix rename is the one patch field that rewrites *other* rows — every ticket carries a
denormalised `ticketKey`, so renaming `TM` to `PLAT` has to re-key all of them or the board
goes on showing a prefix the project no longer has:

```sql
UPDATE tasks SET ticketKey = @prefix || '-' || ticketNumber
   WHERE projectId = @id AND ticketNumber IS NOT NULL
```

`||` concatenates and SQLite coerces the integer ordinal to text, so this is the *whole* rename
in one statement, with the numbers — the durable half of a ticket's identity — untouched. It
runs inside the same `db.transaction()` as the `projects.ticketPrefix` write
([`store.ts:3166-3175`](../apps/client/src/main/store.ts)), and `verify-tickets.mjs` §12 proves
why that matters with a real collision rather than an inspection of the code: 500 tickets are
created under one prefix, a bystander row is planted (by raw SQL, bypassing the allocator) on
the exact key the rename is about to try to hand to a real ticket, and the rename is attempted.
It throws — the partial unique index refuses the collision mid-`UPDATE` — and because the whole
thing is one transaction, **not one of the 500 tickets is rekeyed and the project's own
`ticketPrefix` column reverts too**, not just the tickets. A rename either fully happens or it
leaves everything exactly as it was; there is no state where some tickets answer to the new
prefix and the rest don't.

Clearing a prefix (`ticketPrefix: ''`) is refused, not obeyed, once a project has issued at
least one key: there is no way to write "no prefix" onto `TM-14` that leaves it still called
anything.

---

## The link vocabulary

`ticket_links` is named apart from `task_links` on purpose, and the split is not cosmetic:
`task_links` is the **chain of execution** — an arrow there gates whether a run may start
(`@shared/taskChain`'s `linkSatisfied`/`blockedBy`). A `TicketLink` documents a relationship
and gates **nothing at all**. Conflating the two would mean marking a ticket "duplicates"
another and having the scheduler refuse to start it — a human recording a fact about two issues
would accidentally be blocking work.

`@shared/ticketLinks.ts` owns the vocabulary, six types, each with how it reads from either end
and whether it's symmetric:

| Type | Outward | Inward | Symmetric |
| --- | --- | --- | --- |
| `blocks` | blocks | is blocked by | no |
| `duplicates` | duplicates | is duplicated by | no |
| `relates` | relates to | relates to | yes |
| `implements` | implements | is implemented by | no |
| `causes` | causes | is caused by | no |
| `clones` | clones | is cloned by | no |

One row per link, **directed, with an inverse lookup** — not two rows, which would double
every write and make "delete this link" ambiguous. `linksFor(links, taskId)` phrases every
link touching a ticket from *that ticket's* point of view, so the same row reads as "blocks"
from one end and "is blocked by" from the other, and no two surfaces (the drawer, the picker,
a future backlog table) can word the inverse differently, because there is exactly one function
that does the wording.

`canLinkTickets` returns a refusal **as data** (`'missing' | 'self' | 'duplicate'`), the same
shape `@shared/taskChain`'s `LinkResult` already uses for the chain of execution — "those two
already relate that way" is something to tell a human, not an exception to catch. A
**symmetric** type's mirror (`B relates A` when `A relates B` exists) is refused as a
duplicate, because it states the same fact twice; a directed type's reverse (`B blocks A` when
`A blocks B` exists) is a *different* fact and is allowed.

---

## The JIRA and GitHub isolation guarantee

`Task['source']` gained `'ticket'` as its own value, structurally distinct from `'jira'` and
`'github'`. This matters because both reconcilers filter on `source` in **both** directions —
adopting an external issue and archiving one that disappeared upstream both start by asking
"is this row mine?" — and a native ticket answers "no" to each of them by construction, not by
a convention either sync module has to remember to honour:

- **JIRA** — `jiraSync.ts` filters `t.source === 'jira'` (or `task.source !== 'jira'` as the
  early-exit) at five separate points:
  [`:357`](../apps/client/src/main/jira/jiraSync.ts),
  [`:378`](../apps/client/src/main/jira/jiraSync.ts),
  [`:411`](../apps/client/src/main/jira/jiraSync.ts),
  [`:498`](../apps/client/src/main/jira/jiraSync.ts),
  [`:545`](../apps/client/src/main/jira/jiraSync.ts).
- **GitHub** — `githubIssueSync.ts` does the identical thing, on `source === 'github'`, at
  [`:345`](../apps/client/src/main/github/githubIssueSync.ts),
  [`:376`](../apps/client/src/main/github/githubIssueSync.ts),
  [`:466`](../apps/client/src/main/github/githubIssueSync.ts),
  [`:517`](../apps/client/src/main/github/githubIssueSync.ts).

These are **two independent facts**, not one guarantee that happens to apply twice — they are
two different modules, each with its own filter, each of which would need its own bug to ever
adopt, rewrite or archive a native ticket. `verify-tickets.mjs` §9 proves both: a JIRA-sourced
row and a GitHub-sourced row can each wear a native ticket's key text as their own
`externalKey` — a look-alike, not a merge — and the native ticket itself, read back afterwards,
is untouched by either.

**GitLab has no issue reconciler**, and that is a structural fact rather than an oversight to
fix: `gitlab/gitlabSync.ts` exists, but it syncs *merge requests* into `merge_requests`, a
table a ticket never touches. There is no `gitlabIssueSync.ts` — GitLab issues were never
mirrored onto `tasks` at all, so there is no third filter to write, because there is no third
reconciler for a native ticket to be structurally isolated from in the first place.

---

## The relay classification

Phase 24 added 21 new `IpcApi` channels and 5 new `IpcEvents`, and every one of them was
classified rather than left to a default the day it was declared — both `ipcRelay.ts` and
`ipcEventFanout.ts` are `satisfies`-checked exhaustively over their respective contracts
([`docs/11`](11-ci-cd-pipeline.md) territory: this is a `pnpm typecheck` gate, not a review
habit), so a channel that shipped unclassified would fail to compile rather than silently pick
a behaviour.

The 21 invoke channels — `ticketProject:list|add|update|remove`, `board:scopes`,
`ticket:create|update`, `person:list|add|update|remove|setMe`, `label:list|save|remove`,
`milestone:list|save|remove`, `ticketLink:list|add|remove`
([`ipcRelay.ts:147-173`](../packages/shared/src/ipcRelay.ts)) — are every one classified
`'relay'`: a web client may invoke them against a desktop `Client` exactly as the desktop
renderer does. None needed a stricter tier, because a ticket project has no filesystem and no
exec target to protect (**D2** below) — there is nothing about these channels a browser tab
can reach that the desktop app itself couldn't already.

The 5 events — `ticketProject:changed`, `ticketLink:changed`, `person:changed`,
`label:changed`, `milestone:changed`
([`ipcEventFanout.ts:118-124`](../packages/shared/src/ipcEventFanout.ts)) — are all
`'replace-last'`: each one is a whole-list replacement, reproducible from its own `*:list`
read, so a queue holding three of them is holding two stale copies worth discarding, the same
class `chain:changed` and `settings:changed` are already in. `project:tasksChanged` — the
event a ticket's own row-level change actually rides on — is deliberately **not** one of the
five: it's a `'drop'` for every project, ticket or not, because those rows already reach a
browser through the cloud mirror on their own schedule, and forwarding them over the event
channel too would ship the same data twice with the second copy the one that can go stale.

---

## Decisions taken without the human

Recorded in the design so a later reader can tell a decision from a guess
([`docs/plan/README.md`](plan/README.md#decisions-taken-without-the-human)):

- **D1 — `board:tasks` gained an optional `projectId` instead of a second channel.** It is
  `(projectId?: string) => Promise<Task[]>`, defaulting to `PERSONAL_PROJECT_ID`, with
  `board:archived` following it. `getBoardTasks`/`getArchivedTasksFor` are the general form
  underneath; `getPersonalTasks`/`getArchivedTasks` are now one-line wrappers over them pinned
  to the Personal board. This is also the fact behind the board's dangling-scope fallback: a
  `board:tasks(projectId)` call for a project id that no longer exists — a ticket project
  deleted out from under a saved `AppSettings.boardScopeId` — hits a plain parameterised
  `SELECT ... WHERE projectId = ?` that matches nothing. It answers `[]`, not an error
  (`verify-tickets.mjs` §15), which is what lets `resolveBoardScope` in `@shared/boardScope.ts`
  fall back to the Personal board instead of the UI having to catch a rejected promise.
- **D2 — a ticket project has no repo path.** `path` and `planPath` are both `''`, the same
  value the Personal board itself already seeds with. If a ticket project ever needs a repo —
  because someone wants to delegate one of its tickets to an agent — that already works today
  through the card's own `agentProjectId`, pointing at a real agent project; the ticket project
  itself never becomes a run target.
- **D3 — the version ladder this branch bumps from.** The branch opened against a
  `package.json` that was about to be superseded by a release already in flight, so build step
  1 deliberately started its bump one PATCH after the version that had actually shipped rather
  than continuing the plan's own draft numbering. Every step since has bumped from whatever
  `apps/client/package.json` actually said, not from the plan's original ladder — recorded in
  each step's own commit rather than re-drafted here, because [`CONTRIBUTING.md`](../CONTRIBUTING.md)
  §4 pins the number to the manifest, not to a plan written before the branch existed.
