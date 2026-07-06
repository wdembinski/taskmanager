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

`@anthropic-ai/claude-agent-sdk` — the official Node library that drives the
`claude` CLI programmatically (streaming events, permission callbacks, session
resume). What our engine uses instead of parsing the CLI by hand.

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

### `canUseTool`

A callback the SDK calls **before** Claude uses a tool, asking our app to allow or
deny it. Where our permission policy and the Attention inbox connect.

### Permission mode

How autonomous Claude is. `acceptEdits` (our default) auto-runs edits but stops
for real decisions; `manual` asks about everything; `bypassPermissions` asks about
nothing. Set per project.

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

### electron-vite

Our build tool. Compiles the three parts (main/preload/renderer) from TypeScript
and gives hot-reload during `pnpm dev`.

### Fluent UI

Microsoft's React component library (v9). Our UI building blocks — buttons, cards,
message bars — matching the `vipper-iam` and `ee.manager` projects.

### makeStyles

Fluent UI's styling function. We use it instead of inline CSS so components share
the same design tokens (colors, spacing, light/dark).
