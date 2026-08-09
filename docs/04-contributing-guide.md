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
