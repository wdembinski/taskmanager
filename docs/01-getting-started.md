# 1. Getting started

Welcome! This guide gets the app running on your machine and explains the daily
development loop. It assumes **no prior Electron experience**. If a word is new,
check the [glossary](05-glossary.md).

---

## What you need installed

| Tool          | Why                                            | Check it works       |
| ------------- | ---------------------------------------------- | -------------------- |
| **Node.js** 20+ | Runs all our JavaScript/TypeScript tooling.    | `node --version`     |
| **pnpm**      | Installs dependencies (faster than npm).       | `pnpm --version`     |
| **Git**       | Version control.                               | `git --version`      |
| **claude** CLI | The engine this app orchestrates.             | `claude --version`   |

Install pnpm with `npm install -g pnpm` if you don't have it.

### Log in to Claude once

This app never asks for your password or an API key. It relies on the `claude`
CLI already being **logged in with your subscription**. Do that once in a
terminal:

```bash
claude          # opens Claude; follow the prompt to sign in, then quit with Ctrl+C
```

> ⚠️ **Do NOT set `ANTHROPIC_API_KEY`.** If that environment variable is set,
> Claude switches to the paid per-token API. The app detects this and warns you.
> We want the free subscription path.

---

## Run it

From the project folder:

```bash
pnpm install    # first time only (and after someone changes dependencies)
pnpm dev        # starts the app
```

`pnpm dev` does three things at once (electron-vite handles it):

1. compiles the **main** process (the Node "backend"),
2. compiles the **preload** bridge,
3. starts a dev server for the **renderer** (the React UI) with hot-reload.

Then it opens the app window. Change a file under `src/renderer` and the UI
updates instantly. Change `src/main`, and electron-vite restarts the app.

---

## The commands you'll actually use

```bash
pnpm dev         # develop with hot-reload
pnpm typecheck   # verify TypeScript types — ALWAYS run before committing
pnpm test        # run unit tests (Vitest)
pnpm build       # produce a production build in ./out
pnpm format      # auto-format code with Prettier
pnpm package     # build a Windows installer in ./dist
```

**Our rule of thumb:** a change isn't "done" until `pnpm typecheck` **and**
`pnpm test` both pass. (This mirrors the house rule in the sibling `vipper-iam`
project.)

---

## Where things are

```
task-manager/
├─ src/
│  ├─ main/       ← the Node "backend": engine, IPC handlers, Claude control
│  ├─ preload/    ← the secure bridge between UI and backend
│  ├─ renderer/   ← the React + Fluent UI app (what you see)
│  └─ shared/     ← types shared by both sides (e.g. the IPC contract)
├─ docs/          ← you are here
├─ out/           ← build output (git-ignored)
└─ dist/          ← packaged installers (git-ignored)
```

The next doc, [Architecture](02-architecture.md), explains **why** the code is
split into `main` / `preload` / `renderer` and how a click in the UI turns into
real work.

---

## Troubleshooting

- **"claude was not found" banner** — the CLI isn't on your PATH. Install Claude
  Code and restart the app.
- **"not logged in" banner** — run `claude` in a terminal and sign in.
- **"ANTHROPIC_API_KEY is set" warning** — unset it (`unset ANTHROPIC_API_KEY` on
  macOS/Linux, or remove it from your Windows environment variables) so you use
  the subscription instead of paid API.
- **A blank window** — open the dev tools (View → Toggle Developer Tools) and
  check the Console tab for errors.
