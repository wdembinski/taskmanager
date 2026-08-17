# 4. Contributing guide

This guide shows you how to make a change **end to end** and the conventions we
follow. If you've read docs 1–3, you're ready.

---

## The golden rule

**A change is done when `pnpm typecheck` and `pnpm test` both pass**, and — for
anything with a visible effect — you've run `pnpm dev` and seen it work. We keep
`main` (the default branch) green at all times.

---

## Conventions (borrowed from the sibling projects)

- **TypeScript strict**, no `any` unless you truly cannot avoid it (and comment
  why). `noUnusedLocals`/`noUnusedParameters` are on, so tidy up.
- **Formatting** is automated: `pnpm format` (Prettier — single quotes, semicolons,
  100-char lines). Don't hand-format.
- **Comment for a beginner.** This codebase is meant to be readable by someone new.
  Explain *why*, not just *what*. Match the density of comments already in the
  files you touch.
- **Small, self-contained commits.** Each commit should build and pass tests on its
  own. How the message is written — Conventional Commits, the 50/72 body shape,
  the `Ticket ID:`/`Tested:` trailers — and the rule that every commit bumps and
  tags the version are all in [`CONTRIBUTING.md`](../CONTRIBUTING.md). Read it
  before your first commit.
- **Security first.** Never widen the renderer's powers (keep `contextIsolation`
  on, `nodeIntegration` off). Never auto-approve dangerous tools by default. Never
  commit secrets; never set `ANTHROPIC_API_KEY`.

---

## Recipe A: add a new thing the UI can ask the engine for

Say you want the UI to fetch the list of projects. You'll touch three files, in
this order — always start at the **contract**:

1. **Declare the channel** in `packages/shared/src/ipc.ts`:

   ```ts
   export interface IpcApi {
     // ...existing channels...
     'projects:list': () => Promise<Project[]>;
   }
   ```

2. **Implement it in the engine** in `apps/client/src/main/ipc.ts`:

   ```ts
   handle('projects:list', () => projectStore.listAll());
   ```

   (`handle` is our type-safe wrapper — if your return type doesn't match the
   contract, it won't compile.)

3. **Call it from the UI** in a React component:

   ```ts
   useEffect(() => {
     void window.api.invoke('projects:list').then(setProjects);
   }, []);
   ```

That's the whole pattern. The preload bridge already forwards any channel in the
contract, so you don't touch it for a normal request/response.

## Recipe B: push a live update from the engine to the UI

When the engine needs to *notify* the UI (e.g. new Claude output), use an **event**
channel instead:

1. Add its payload type to `IpcEvents` in `packages/shared/src/ipc.ts`.
2. In the engine, send it: `window.webContents.send('session:output', payload)`.
3. In the UI, subscribe and clean up:

   ```ts
   useEffect(() => window.api.on('session:output', handleOutput), []);
   ```

   (`window.api.on` returns an unsubscribe function; returning it from `useEffect`
   makes React clean up automatically.)

---

## Recipe C: add a UI screen

Renderer code lives in `apps/client/src/renderer/src/`. Build screens from **Fluent UI v9**
components (`@fluentui/react-components`) and icons (`@fluentui/react-icons`) — the
same toolkit as `vipper-iam`. Style with `makeStyles` (as in `App.tsx`), not
inline CSS, so the design tokens (light/dark, spacing) stay consistent.

---

## Recipe D: add a field to a native ticket

A ticket field is a `tasks` column, so it enters at **seven stops in `apps/client/src/main/store.ts`**
— miss one and the field is silently dropped, usually at creation, which is exactly what
happened to `projectTagId`: the comment still sitting inside the `INSERT` at
[`store.ts:1840-1845`](../apps/client/src/main/store.ts) is the scar from that. Work through
them in this order:

1. **The `CREATE TABLE tasks` block** ([`store.ts:935-1005`](../apps/client/src/main/store.ts))
   — add the column so a brand-new database has it from the start.
2. **The PRAGMA-guarded `ALTER TABLE` list**
   ([`store.ts:1540-1609`](../apps/client/src/main/store.ts)) — add the same column here too,
   with a comment saying what `NULL` means for every row that predates the field. This is what
   an *existing* database picks up on its next open; skip it and only a fresh install gets the
   column.
3. **`TaskRow`** ([`store.ts:84`](../apps/client/src/main/store.ts)) — the raw shape a `SELECT *`
   comes back as. It is not the same type as `Task`: booleans are `0`/`1`, arrays are JSON
   strings.
4. **`taskToRow`** ([`store.ts:2614`](../apps/client/src/main/store.ts)) — `Task` → `TaskRow`,
   for the write side.
5. **`rowToTask`** ([`store.ts:2696`](../apps/client/src/main/store.ts)) — `TaskRow` → `Task`,
   for the read side. A JSON array column goes through `parseStringArray`
   ([`store.ts:2587`](../apps/client/src/main/store.ts)), the same decoder `labels` and
   `dependsOn` already use.
6. **`insertTask`'s column list *and* value list**
   ([`store.ts:1816-1847`](../apps/client/src/main/store.ts)) — both, not just one. SQLite
   accepts an `INSERT` whose column list and `VALUES` list are different lengths only if you
   get the count wrong in a way that still parses, which a missing field usually does not — but
   a field present in `TaskRow`/`taskToRow` and absent from *this* statement compiles cleanly
   and simply never reaches the database. That is the `projectTagId` bug exactly, and it is why
   the twelve ticket columns are called out **twice** in this one `INSERT`, once in each list.
7. **`updateTask`'s column allowlist** ([`store.ts:3192-3239`](../apps/client/src/main/store.ts))
   — so the field is patchable after creation. A JSON array column is handled apart from the
   loop, the way `labels` is (`store.ts:3261-3264`): better-sqlite3 refuses to bind an `Array`.

If the field can be set **at creation**, `createTicketTx`
([`store.ts:2830-2882`](../apps/client/src/main/store.ts)) also needs the one line that copies
it off `TicketInput` onto the `Task` literal it builds — easy to forget precisely because it
looks like an eighth store stop but is really just "did you wire the ticket you're creating,
not only the one you're editing".

Then four more stops finish the contract, outside `store.ts`:

1. **`Task`** in [`packages/shared/src/model.ts`](../packages/shared/src/model.ts) — the field
   on the domain type itself, documented for why it's nullable (native-ticket fields are `null`
   for every task that isn't one).
2. **`TicketInput`/`TicketPatch`**, same file — add the field to `TicketInput` if a human should
   be able to set it while creating a ticket, and to the `Pick<Task, ...>` union behind
   `TicketPatch` if it should be editable afterwards. Most fields want both.
3. **`assertTicketRefs`** in `apps/client/src/main/ipc.ts` — only if the field is a reference to
   another row (an id like `epicTaskId`/`milestoneId`/`assigneeId`/`reporterId`). `ticket:create`
   and `ticket:update` otherwise forward `TicketInput`/`TicketPatch` straight through to the
   store with no per-field code, so a plain scalar needs nothing here at all.
4. **The renderer field** — `ticketFields.ts` (parsing/validation) and `TicketDrawer.tsx` (the
   control itself), so a human has somewhere to put the value the first six stops now know how
   to keep.

---

## Testing

- **Unit tests** (Vitest) live next to the code as `*.test.ts`. Prefer testing
  **pure functions** — logic with no side effects. See
  `apps/client/src/main/claudeStatus.test.ts`: we split the file-system/`spawn` parts away
  from a pure `summarizeClaudeStatus()` and test the pure part. Do the same with
  your logic (plan parsing, limit detection, scheduling decisions).
- Run `pnpm test` (once) or `pnpm test:watch` (while developing).

---

## Before you open a pull request

```bash
pnpm format
pnpm typecheck
pnpm test
pnpm dev        # click through anything you changed
```

Then write a short description of *what* and *why*. Keep the diff focused on one
logical change.

---

## Where to look when you're stuck

| I want to…                              | Look in…                                     |
| --------------------------------------- | --------------------------------------------- |
| Change what the UI looks like           | `apps/client/src/renderer/src/`               |
| Change how Claude is run                | `apps/client/src/main/` (session runner, engine) |
| Add/adjust data crossing UI↔engine      | `packages/shared/src/ipc.ts` first            |
| Understand the security boundary        | `apps/client/src/preload/index.ts` + doc 02   |
| Understand sessions/limits/questions    | doc 03                                        |
| Look up a term                          | [Glossary](05-glossary.md)                    |
