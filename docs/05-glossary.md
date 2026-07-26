# 5. Glossary

Plain-language definitions of every term used in this project. Skim it once; come
back when a word trips you up.

### Electron

A framework for building **desktop apps** with web technology (HTML, CSS,
JavaScript/React). It bundles Chromium (a browser) and Node.js together. See
[Architecture](02-architecture.md).

### Main process

The **Node.js** part of an Electron app. Full access to the operating system,
files, and other programs. Our "engine" (running Claude, scheduling, database)
lives here, under `src/main/`. There is only one.

### Renderer (process)

The **web page** part of an Electron app — our React + Fluent UI interface, in
`src/renderer/`. It runs in a sandboxed Chromium window and cannot touch the OS
directly.

### Preload

A small, privileged **bridge** script (`src/preload/`) that exposes a controlled
API (`window.api`) from the engine to the UI. The only doorway between the two.

### IPC (Inter-Process Communication)

The messaging system Electron uses so the renderer and main process can talk. Two
styles: **invoke** (request→response) and **events** (push). Our channels are
typed in `src/shared/ipc.ts`.

### Channel

A named "mailbox" for IPC messages, e.g. `claude:getStatus`. Each has a fixed
argument and return type in the contract.

### Contract

Our name for `src/shared/ipc.ts` — the single file that declares every IPC channel
and its types, so the UI and engine can't drift apart.

### Claude CLI

The `claude` command-line program (Claude Code). The engine this app orchestrates.
We run it in headless mode.

### Claude Agent SDK

`@anthropic-ai/claude-agent-sdk` — Anthropic's official Node library for driving
Claude. We deliberately **do not** use it: it is proprietary ("All rights
reserved"), which conflicts with our MIT/Apache-only rule. Instead we drive the
`claude` CLI as an external subprocess. See [licensing](06-licensing.md).

### Subprocess

A separate program our app launches and communicates with (here, `claude`). We
read its output and write to its input, but it is not part of our codebase — like
how a build script might call `git`.

### Headless / print mode

Running `claude` non-interactively (`-p`) so a program — not a human at a
terminal — can drive it and read structured output.

### Session

One continuous conversation with Claude about **one task**. Identified by a
**session id** (UUID) so it can be resumed later.

### Session id / resume

The UUID of a session. Passing it to `--resume` continues that exact conversation
with its full history — how we pick back up after a limit reset or app restart.

### Streaming (stream-json)

A mode where Claude's input and output are sent as a live stream of small JSON
**events** rather than one final blob. Lets us show live progress and inject
answers mid-task.

### Permission mode

How autonomous Claude is. `acceptEdits` (our default) auto-runs edits but stops
for real decisions; `manual` asks about everything; `bypassPermissions` asks about
nothing. Set per project — and per assignment for a **delegated task**.

### Attention inbox

The dashboard area listing things that need a human: permission requests and
clarifying questions. Answering one resumes its task.

### Usage limit

A cap on how much you can use your Claude **subscription** in a time window: a
rolling ~5-hour limit and a **weekly cap**. Hitting one pauses work.

### Usage-limit gate

Our engine component that pauses all sessions when a limit is hit and
**auto-resumes** them when it resets. See [doc 03](03-how-orchestration-works.md).

### Plan / plan.md

A markdown file describing a project's work as phases and checkbox tasks. The app
parses it into runnable tasks.

### Task status

Where a task is in its life: `pending` → `running` → (`waiting-input` /
`blocked-by-limit`) → `done` (or `failed`).

### Scheduler

The engine component that decides which task runs next, respecting phase order,
dependencies, and how many sessions may run at once (concurrency).

### Concurrency

How many of a project's tasks the scheduler runs in parallel. Set **per project**
(its Edit dialog); the global Settings value only seeds new projects. `1` = strictly
one task at a time.

### `@needs:` (task dependency)

A clause appended to a plan checkbox — `- [ ] Build API @needs: Set up DB` — that
holds the task until the named prerequisite task(s) are `done`. Referenced by exact
title. Independent tasks (no `@needs:`) run in parallel up to the concurrency cap.
**Align plan…** (Projects tab) uses Claude to add these to an existing plan.

### My Tasks

The personal Kanban board: your own tasks and your synced JIRA tickets as cards,
independent of the plan-driven **Board**. Its cards live on the built-in
*Personal* project.

### Agent project

A **repo folder plus the JIRA epics it owns** — the target you delegate a My Tasks
card to (managed in **Settings → Agents**). It has no `plan.md` and is never
queued; it is stored as a project with `kind: 'agent'` so worktrees, auto-merge and
the usage-limit gate work on it unchanged. The seed of the projects concept meant
to replace the legacy plan.md/queue **Projects** tab.

### Delegated task ("Assign to an agent")

A single My Tasks card handed to Claude to work on in an agent project's repo. One
card, one session, no queue and no auto-start; you answer its questions in the
card's detail sidebar, and JIRA is never written to. See
[doc 03](03-how-orchestration-works.md#delegating-one-task-to-an-agent).

### Epic Link field

The JIRA field holding a ticket's epic. On Server/DC it is a per-instance custom
field (`customfield_NNNNN`), so the app discovers its id once, caches it, and falls
back to the issue's `parent`. Used to guess which **agent project** a ticket
belongs to.

### Git worktree

A second working directory checked out from the same repository, on its own
branch. Delegated (and plan) runs work in one so the agent never touches your
files; a clean finish merges the branch back and removes the worktree.

### electron-vite

Our build tool. Compiles the three parts (main/preload/renderer) from TypeScript
and gives hot-reload during `pnpm dev`.

### Fluent UI

Microsoft's React component library (v9). Our UI building blocks — buttons, cards,
message bars — matching the `vipper-iam` and `ee.manager` projects.

### makeStyles

Fluent UI's styling function. We use it instead of inline CSS so components share
the same design tokens (colors, spacing, light/dark).
