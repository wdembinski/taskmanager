# 3. How orchestration works

This is the heart of the app: how we drive Claude. Read this before touching the
engine code. It explains the concepts first, then how we use them.

---

## The one idea to hold onto

We do **not** re-implement Claude. We start the same `claude` program you run in a
terminal, but in a **headless** mode designed for automation, and we read its
output as a stream of structured events instead of pretty text.

We drive it as an **external subprocess** — like calling `git` — rather than using
Anthropic's SDK, because the SDK is proprietary and we keep our bundled
dependencies permissive (see [licensing](06-licensing.md)). The mechanics live in
[`src/main/claudeSession.ts`](../src/main/claudeSession.ts): we spawn
`claude -p --output-format stream-json --verbose …` in the project's directory,
feed the **prompt over stdin** (so no shell-quoting headaches), and parse the
newline-delimited JSON it streams back into our small `SessionEvent` type.

Because it's the same CLI with the same login, everything runs on your
**subscription** — no paid API, no extra cost.

---

## Key concepts

### Sessions (one per task)

A **session** is a single continuous conversation with Claude about one task. Each
session has a **session id** (a UUID). We assign one task = one session. The id
lets us **resume** that exact conversation later — after a usage limit, or after
the app restarts — without losing context.

> Rule: **capture and save the session id the moment a session starts.** If the
> app crashes before we've stored it, we lose the ability to resume that work.

### Streaming, in both directions

We run each session with streaming turned on **both ways**:

- **Output stream** — Claude emits events as it works: "assistant said X", "I want
  to use tool Y", "tool returned Z", and finally a `result` event (with token
  counts and why it stopped). We turn these into live updates in the UI.
- **Input stream** — because we keep the input channel open, we can **send Claude
  a message mid-session** (for example, the answer to a question) and it continues
  right where it left off. No restart, no lost context.

### Permissions

Before Claude runs a tool (edit a file, run a shell command, etc.) it consults a
**permission mode** we pass on the command line (`--permission-mode`). Our default
is `acceptEdits`: edits happen automatically, but genuinely risky operations stop
and wait. In Phase 4 we add a finer policy on top — auto-approving safe actions
while **routing risky ones** (pushing to git, deleting, anything touching
secrets/`.env`) and clarifying questions to the **Attention inbox** for a human.

### Questions vs. permissions

Two different things end up in the **Attention inbox**:

1. **Permission requests** — "may I run this tool?" (from `canUseTool`).
2. **Clarifying questions** — Claude genuinely needs information to proceed.

Both pause that one task and surface in the dashboard. When you answer, we push
your reply into the session's **input stream** and it carries on.

---

## Usage limits — the "respawn when reset" feature

This is the reason the app exists. Two things can stop Claude:

- the **5-hour rolling limit** (you hit it fairly often), and
- the **weekly cap** (the hard ceiling; nothing can bypass it).

When a session stops because of a limit, the SDK surfaces an error/`result` that
tells us **when the limit resets**. The engine then:

1. marks the task `blocked-by-limit`,
2. puts **all** sessions behind a single global **gate** (no point retrying — the
   limit is account-wide),
3. schedules a timer for the reset time (plus a little random jitter),
4. when the timer fires, **resumes** each parked session by its saved session id.

The dashboard shows a banner with a live countdown so you always know why work is
paused and when it'll pick back up.

> **Honest expectations:** orchestration makes Claude *resume* after a reset. It
> cannot give you more capacity. If you exhaust the **weekly** cap, work waits
> until the weekly window rolls over — that's a subscription limit, not a bug.

---

## Where plans come from

Each project points at a `plan.md` (or similar). We parse its structure into
tasks:

- headings (`## Phase 4`, `### Some milestone`) become **phases/milestones**,
- checkbox list items (`- [ ] do the thing`) become **tasks**.

The app then owns the live status of each task in its database, and can optionally
tick the checkbox (`- [x]`) back in the file when a task completes. You can also
add ad-hoc tasks directly in the app.

---

## Putting it together: the life of a task

```
pending
   │  scheduler picks it (phase order, dependencies, concurrency limit)
   ▼
running ──────────────► streams live output to the Session view
   │   │
   │   ├─ Claude asks / needs permission ─► waiting-input ─► you answer ─► running
   │   │
   │   └─ usage limit hit ─► blocked-by-limit ─► (auto-resume at reset) ─► running
   ▼
done  ──► scheduler advances to the next task / next phase
```

If a session ends in an error we can't recover from, the task becomes `failed` and
surfaces for a human — the scheduler moves on so one bad task doesn't stall the
queue.

Next: [Contributing guide](04-contributing-guide.md) — how to make your first
change safely.
