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

### Attachment / `@name` (attachment reference)

A file attached to a card or to one of its steps: the screenshot of the bug, the
mockup a layout has to match, the CSV that reproduces it. The bytes are **copied**
into the app's own data (`userData/attachments/<taskId>/<name>`), so the original can
be moved or deleted afterwards without breaking anything. Writing `@mockup.png` in a
description or a step brief points at one; the prompt that starts the run carries a
legend of every attached file and its real path, so the agent opens the actual file.
A step can name its own attachments **and** its card's.

Not to be confused with `@needs:` above — different syntax, different place, different
job. `@needs:` is a dependency clause in a **plan file**, resolved against task titles;
`@name` is a file reference in a **card or step brief**, resolved against that task's
attachment list. A token matching no attachment is simply prose, which is why the two
never collide.

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

### Plan mode

A permission mode in which Claude may **read and search but not change anything**:
it researches the ticket and ends by proposing a plan (an `ExitPlanMode` call). We
delegate a card this way when we want a human to see the approach before any code is
written. See [doc 03](03-how-orchestration-works.md#plan-first-then-execute-in-steps).

### Plan approval

The Attention item a plan-mode run produces: the plan markdown plus the steps it
would create. **Approve plan** turns them into subtasks and starts the first;
**Re-plan** sends your note back to the same planning session, which keeps its
research context and revises.

### Subtask (step)

One phase of an approved plan, stored as a normal task with `parentTaskId` pointing
at the card and the plan section as its **brief** (`description`). Steps run
**one at a time, each in its own session** — the point of the feature, since a step
then pays only for its own context. All the steps of a card share one git worktree
and one branch; only the last one merges it back, and the parent card is never
auto-completed. You can also write steps by hand instead of planning.

### Chat (with an agent)

Opening a turn yourself instead of answering one. Typed in the card's **Chat** tab and
recorded on the timeline as its own activity kind, so the card still reads as one story.
A live run hears it through its open input stream; an idle card is **resumed**. Chat
never *starts* a conversation — a card that has never run is not chattable — and it
cannot answer an approve/deny, which needs the pending request. See
[doc 03](03-how-orchestration-works.md#talking-to-the-agent-on-a-card).

### Chat resume

The run a chat message starts on an idle card: `claude --resume <sessionId>` prompted
with what you typed rather than the usual continue-nudge. It is an ordinary run in every
other way — reserved slot, the card's worktree, settling and integration — so it costs a
fresh process and is not instant.

### Chat target

The task that actually receives a message typed on a card. Normally the card itself; but
a card executing an approved plan holds no session of its own, so the target is the
**step** that is running (`chatTarget` in `src/shared/board.ts`). The composer names it.

### Parked chain

A card whose approved plan has stopped: some step is `failed` or waiting on a question,
so its siblings stay pending. The card wears the orange frame and reads `2/4 · stopped`,
and the step's resolutions are offered from the card's own pane. An app restart parks an
interrupted step the same way — nothing re-enters a chain on its own. This is a **step
chain** — one card's own work — not a [chain](#chain-of-execution) between cards.

### Chain (of execution)

The ordering between **whole cards**, drawn as arrows on the board: *this one runs after
that one*. Every card keeps its own branch, its own worktree and its own merge — which is
what makes it a different thing from a card's [steps](#subtask-step), where one branch is
shared and only the last step integrates. A chain can be a line, a fan or a diamond
(a card waits for **all** the arrows into it); it can never be a loop, and it can never
include a step at either end. A chain never moves a card between columns. See
[doc 03](03-how-orchestration-works.md#chaining-cards).

### Link (edge)

One arrow: a `task_links` row saying `toTaskId` runs after `fromTaskId`, under one
**gate**. Drawn by dragging the handle on a card's right edge, from *Add task*'s
*Runs after…* picker, or listed and unlinked in the pane's **Chain** section. Deliberately
not `@needs:`, which is matched by title inside one plan project's file and re-derived on
every sync; a link is between arbitrary cards, made by a human, and survives a re-sync.

### Gate

What "after" means for one link. **After merge** (`after-merge`, the default) waits for the
predecessor to have **landed** — settled code, the safe choice. **Stacked on this branch**
(`stacked`) fires as soon as the predecessor stops writing, so the next card starts sooner
on a base that may still be rewritten under it. Both the board and the release engine ask
the same function (`linkSatisfied` in `src/shared/taskChain.ts`), so they cannot disagree
about whether a card is ready.

### Stacked branch

The successor's worktree in a `stacked` link, cut from the **predecessor's** branch rather
than from the project's base, so it starts with that card's commits already in its tree.
The merge target is unchanged (still the base branch) — which means merging the successor
carries the predecessor's work along with it, so the predecessor should merge first. The
card's timeline says so when it is released.

### Landed

A card's work is in the base branch (`Task.landedAt`) — the fact every `after-merge` gate
waits on. Stored rather than inferred, so a card dragged back out of Done or a merge-request
list a poll behind cannot un-release a chain that already started. Stamped from two places:
a local integrate that merges the branch, and a linked **merge request** GitLab reports as
`merged` — the only signal that exists on a project where nobody merges locally.

### Nav rail

The vertical strip of icons down the left of the window — My Tasks, Projects, Board,
Performance, Attention, Settings, Scratch run. It replaced a horizontal tab strip, which
cost every screen a band of height at the top. Glyph-only: each destination's label is its
tooltip and its accessible name.

### Status bar

The coloured line across the bottom of the window: Claude readiness on the left, app
version on the right. The editor's blue at rest, and the app's **orange** with a count the
moment anything is waiting on a human — so that signal is visible from every screen, not
only the **attention inbox**.

### Details cell

The fixed band at the top of a card's detail pane: identity, agent controls, status,
dependencies, a foldable description and the steps. One shaded slab a step *lighter* than
the board beside it, capped at half the pane's height. The **chat** below it is the only
part that scrolls.

### Description (the app's copy)

The ticket body the agent's prompt quotes, editable from the details cell. For a JIRA card
it is a **copy**: nothing is written back to the tracker, and the next sync replaces it
with the issue's text. Editing it still changes what the next run is told to do.

### Epic Link field

The JIRA field holding a ticket's epic. On Server/DC it is a per-instance custom
field (`customfield_NNNNN`), so the app discovers its id once, caches it, and falls
back to the issue's `parent`. Used to guess which **agent project** a ticket
belongs to.

### Merge request (MR)

GitLab's name for a pull request. The app fetches the ones you created that are still
open and files each under the board card whose **JIRA key** appears in its branch, title
or description — so the ticket and the code review sit in one place. A red pipeline, an
unread review comment or a request for changes raises the same orange **attention** ring
an unread ticket comment does.

### Read markers

The pair of timestamps that decide whether something is shouting: what happened, and
when you last looked. A ticket has one pair for comments; an MR has **two** — comments
and pipeline/approval events — kept separate so acknowledging a red pipeline never
silences a comment that arrives a second later.

### Project tag vs agent project

Two different things a card can point at, and for a long time one column. The **project
tag** (`projectTagId`) is what a card is *about* — it draws the colour stripe. The
**agent project** (`agentProjectId`) is the repo a delegated run happens in — it draws
the agent glyph. Filing a card is not delegating it.

### Git worktree

A second working directory checked out from the same repository, on its own
branch. Delegated (and plan) runs work in one so the agent never touches your
files; a clean finish merges the branch back and removes the worktree.

### Base branch

The branch a project's task branches start FROM and are merged back INTO — set per
project (**Base branch** on the project form). Left unset it follows whatever the main
checkout has out, which is how this always worked.

Naming it is the sturdier setup, for a reason worth knowing: `git merge` can only advance
the branch that is *checked out*, so integrating into the checked-out branch writes files
into your folder and has to be refused whenever you have uncommitted work there — even
work with nothing to do with it. A base branch you do NOT keep checked out is integrated
by moving the branch pointer instead (`git fetch . <branch>:<base>`), which touches no
file and so can never be blocked by one.

### Auto-release

"When this card's branch merges, release it too." Set as a preference on the agent
project and overridden per card in the detail pane; a card that has never been switched
follows its project. The app decides *when*, never *how* — the recipe is the repo's own
`RELEASE.md`.

### `RELEASE.md`

A file at a repo's root telling an agent how that project is released. There is no
schema: it is prose an agent follows, and it is the only thing an auto-release run is
given beyond "the branch merged into this base". A repo without one is never released
automatically, and the card says so rather than the switch quietly doing nothing.

### electron-vite

Our build tool. Compiles the three parts (main/preload/renderer) from TypeScript
and gives hot-reload during `pnpm dev`.

### Fluent UI

Microsoft's React component library (v9). Our UI building blocks — buttons, cards,
message bars — matching the `vipper-iam` and `ee.manager` projects.

### makeStyles

Fluent UI's styling function. We use it instead of inline CSS so components share
the same design tokens (colors, spacing, light/dark).
