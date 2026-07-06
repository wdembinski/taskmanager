# 2. Architecture (in plain English)

This app is built with **Electron**. Electron lets you build a desktop app using
web technology (HTML/CSS/React) instead of native Windows APIs. The catch is that
an Electron app is not one program — it's **three cooperating parts**. Understanding
those three parts is 80% of understanding this codebase.

---

## The three parts

```
        ┌─────────────────────────────────────────────────────────┐
        │                   Your computer                          │
        │                                                          │
        │   ┌───────────────┐   IPC    ┌────────────────────────┐  │
        │   │  RENDERER      │ <──────> │  MAIN process (Node)   │  │
        │   │  (React UI)    │  messages│  the "engine"          │  │
        │   │  in a Chromium │          │  - spawns Claude       │  │
        │   │  window        │          │  - scheduler           │  │
        │   │                │          │  - SQLite database     │  │
        │   └───────▲────────┘          └───────────┬────────────┘  │
        │           │  only through                 │ full access   │
        │           │  the PRELOAD bridge           │ to OS/files   │
        │      ┌────┴─────┐                    ┌─────▼──────┐        │
        │      │ PRELOAD  │                    │  claude    │        │
        │      │ (small   │                    │  CLI / SDK │        │
        │      │  safe API)│                   └────────────┘        │
        │      └──────────┘                                         │
        └─────────────────────────────────────────────────────────┘
```

### 1. Main process — the "engine" (`src/main/`)

This is a normal **Node.js** program. It has full access to the operating system:
it can read files, open a SQLite database, and — most importantly — **spawn and
control Claude**. All the interesting logic lives here:

- the **session runner** (starts a Claude session for a task),
- the **scheduler** (decides which task runs next),
- the **usage-limit gate** (pauses everything when a limit is hit, resumes on
  reset),
- **persistence** (remembering projects, tasks, and progress).

There is exactly **one** main process. It starts first (`src/main/index.ts`).

### 2. Renderer — the UI (`src/renderer/`)

This is a normal **React web app**, styled with **Fluent UI**. It runs inside a
Chromium window — essentially a locked-down web browser. For safety, it has **no
direct access** to Node, files, or the OS. It can only draw the interface and ask
the engine to do things.

### 3. Preload — the bridge (`src/preload/`)

The renderer still needs *some* way to talk to the engine. The **preload** script
is that doorway. It runs with special privileges and exposes a tiny, explicit API
onto the web page as `window.api`. The UI can only call the exact methods we
choose to expose — nothing else. This is what keeps a desktop app that runs local
code safe.

---

## How they talk: IPC

The renderer and main process cannot call each other's functions directly (they
are separate programs). They communicate by sending messages over named
**channels** — this is called **IPC** (Inter-Process Communication).

There are two directions:

- **Invoke (request → response).** The UI asks the engine a question and awaits an
  answer. Example: "what's Claude's status?" Looks like an `await`ed function call.
- **Events (push).** The engine notifies the UI when something happens, at any
  time. Example: "a new line of Claude output arrived." The UI subscribes and
  reacts.

### The contract keeps both sides honest

Every channel — its name, its arguments, and what it returns — is declared once in
[`src/shared/ipc.ts`](../src/shared/ipc.ts). Both the engine and the UI import
these types. If the engine changes what a channel returns, the UI **stops
compiling** until it's updated. No guessing, no silent breakage.

### A concrete round-trip (Phase 0 example)

1. **UI** (`src/renderer/src/App.tsx`) runs
   `window.api.invoke('claude:getStatus')`.
2. That crosses the **preload** bridge (`src/preload/index.ts`), which forwards it
   over IPC.
3. The **engine** handler (`src/main/ipc.ts`) receives it and calls
   `getClaudeStatus()` (`src/main/claudeStatus.ts`), which runs `claude --version`
   and checks the login.
4. The result travels back the same way, and React renders it.

Follow that trail in the code — it's the pattern every future screen uses.

---

## Why this split matters to you as a contributor

- **UI work?** You'll spend your time in `src/renderer/`. When you need data from
  the engine, add a channel to the contract and call it via `window.api`.
- **Engine work** (running Claude, scheduling, database)? You'll be in
  `src/main/`. You expose your feature to the UI by registering an IPC handler.
- **New data crossing the boundary?** Add its types to `src/shared/ipc.ts` first —
  that's the seam that connects the two worlds.

Next: [How orchestration works](03-how-orchestration-works.md) — the heart of the
app, i.e. how we actually drive Claude.
