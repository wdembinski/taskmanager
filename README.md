# VIPPER Task Manager

A **desktop app** that runs the [Claude](https://claude.com/claude-code) CLI for
you — across many projects, around the clock.

You give it your projects and a `plan.md` for each. It works through the plan one
task at a time, running a **separate Claude session per task**. When Claude hits a
usage limit, the app waits and **automatically resumes** when the limit resets.
When Claude needs a decision (a permission or a question), it appears in a
**dashboard inbox** for you to answer — and the session continues instantly. You can
also start the conversation yourself: every card has a **chat** with the agent working
it, live or resumed.

> **Why this exists.** The `claude` CLI stops when it hits a usage limit and never
> comes back on its own; it also treats each task as a one-off and won't move on
> to the next item in your plan. This app is the "manager" that sits on top of it.

---

## Is this going to cost me money?

**No extra money.** The app drives the same `claude` command you already use in a
terminal, signed in with your **subscription** (Pro/Max). It never uses the paid
per-token API. The only real limit is your subscription's usage window (a rolling
~5-hour limit plus a weekly cap) — the app is designed to respect and wait those
out, not to get around them.

---

## Quick start (5 minutes)

You need [Node.js](https://nodejs.org) 20+ and [pnpm](https://pnpm.io), plus the
`claude` CLI installed and logged in (`claude` → sign in once).

```bash
pnpm install      # install dependencies (downloads Electron the first time)
pnpm dev          # launch the app with hot-reload
```

A window opens. On first run it checks that `claude` is installed and logged in
and shows you the result. That's the Phase 0 scaffold — the full dashboard is
being built out phase by phase (see `docs/plan` and the task list).

Other commands:

```bash
pnpm typecheck    # check types (run this before committing)
pnpm test         # run unit tests
pnpm build        # compile a production build into ./out
pnpm package      # build a Windows installer into ./dist
```

---

## New here? Read these in order

The `docs/` folder is written for someone **new to Electron and to this project**.
Start at the top:

1. [`docs/01-getting-started.md`](docs/01-getting-started.md) — set up your
   machine and run the app.
2. [`docs/02-architecture.md`](docs/02-architecture.md) — how the app is put
   together (the three-process Electron model, in plain English).
3. [`docs/03-how-orchestration-works.md`](docs/03-how-orchestration-works.md) —
   how we actually drive Claude: sessions, questions, and usage limits.
4. [`docs/04-contributing-guide.md`](docs/04-contributing-guide.md) — how to make
   your first change, where code lives, and our conventions.
5. [`docs/05-glossary.md`](docs/05-glossary.md) — every unfamiliar word, defined.
6. [`docs/06-licensing.md`](docs/06-licensing.md) — the MIT/Apache-only rule and
   how to keep the app commercially usable.

Then, before your first commit, read [`CONTRIBUTING.md`](CONTRIBUTING.md) — how
commit messages are written here, and the rule that every change bumps and tags
the version in the same commit.

---

## Tech stack

- **Electron** — turns a web app into a native desktop app.
- **React 18 + Fluent UI v9** — the user interface (same UI toolkit as the
  `vipper-iam` and `ee.manager` projects).
- **TypeScript** (strict) everywhere.
- The **`claude` CLI** — driven as an external subprocess over its stream-json
  protocol (we do **not** bundle Anthropic's SDK; see
  [`docs/06-licensing.md`](docs/06-licensing.md) for why).
- **electron-vite** for fast builds/hot-reload, **Vitest** for tests,
  **electron-builder** for packaging.

All bundled dependencies are permissive (MIT/Apache/BSD-style) so the app can be
used commercially. See [`docs/06-licensing.md`](docs/06-licensing.md).
