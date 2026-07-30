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

### Declaring dependencies (`@needs:`)

By default a project runs up to **concurrency** tasks in parallel (set per project
in its Edit dialog). To force ordering, append a `@needs:` clause naming the exact
titles a task depends on — the scheduler won't start it until every named
prerequisite is `done`:

```markdown
## Setup
- [ ] Set up the database
- [ ] Set up config

## Build
- [ ] Build the API @needs: Set up the database
- [ ] Build the UI  @needs: Set up the database
- [ ] Deploy        @needs: Build the API, Build the UI
```

Here the two setup tasks run in parallel; API and UI both wait for the database,
then run in parallel; Deploy waits for both. Independent tasks (no `@needs:`) run
in parallel up to the concurrency cap. References are matched by exact title; a
misspelled or missing reference leaves the task waiting, and the **Projects** tab
flags dangling references and dependency cycles. Don't have dependencies annotated
yet? Use **Align plan…** on the Projects tab to have Claude add `@needs:` clauses
to an existing plan for you to review.

---

## Delegating one task to an agent

Plans are the batch mode: a queue of tasks the scheduler works through. There is
also a **single-ticket mode** for the **My Tasks** board — pick one card (a JIRA
ticket or an in-app task), hand it to Claude, and it works that one thing.

### Agent projects

A card on My Tasks belongs to the built-in *Personal* board, which has no folder,
so there is nowhere to run. You give it one by creating an **agent project** in
**Settings → Agents**: a name, a **repo folder**, optional **JIRA epic keys**, and
a default model and permission mode.

An agent project is stored as a normal project row with `kind: 'agent'`, so
worktrees, auto-merge, usage attribution and the limit gate all treat it like any
other project. It has no `plan.md`, it never appears on the legacy **Projects**
tab, and nothing is ever queued from it.

**What the folder has to be.** The form checks its git as you choose it, rather
than letting the first run discover the problem: a folder that is not a repo runs
tasks directly in it (no isolation, no auto-merge), and a repo with **no commits
yet** has nothing for a task's branch to start from. That last one used to reach
git as `git worktree add -b <branch> <path> ''` and fail with `fatal: not a valid
object name: ''` — a message pointing at the branch name rather than the empty
repo, and one that no retry could get past. Such a repo is now given an **empty**
`Initial commit` on the first run (`--allow-empty`, nothing staged, your untracked
files left alone), which is noted in the task's activity.

### Assigning

Select a card, then **Assign to an agent…** in its detail sidebar. The dialog
pre-selects a repo when it can: an explicit earlier assignment wins, otherwise the
ticket's **epic** is matched against each agent project's epic keys. (The Epic
Link field is a per-instance custom field on JIRA Server/DC, so the app discovers
its id once, caches it, and falls back to the issue's `parent` — and then to you
picking manually.) You also choose the model, the permission mode, and optional
extra instructions, which are recorded as a comment on the task so they survive a
re-run and show up in the timeline.

The card keeps its place on the Personal board — only the **run** happens in the
agent project. That is what keeps this per-card: the queue scheduler never sees
the task at all.

### What the agent is told, and what it may do

The prompt is a single-ticket brief: key, URL and title, the ticket description,
its JIRA comments oldest→newest, your own notes, and your extra instructions. No
plan, no queue, no phases. It may read the repo's docs and memory files, and it
commits on its own branch in an isolated **git worktree**, which is auto-merged
back into the base branch when the run finishes cleanly (a merge conflict comes
back to you as an Attention item).

> **A delegated run never writes to JIRA.** Assigning, starting or finishing one
> never transitions a ticket or posts a comment. You can write to JIRA yourself —
> drag a card between columns, post a comment, create a card as a real issue — but
> the agent never does it on your behalf.

### Merge requests on the card

With **Settings → GitLab** configured, your open merge requests are fetched on their
own timer and each is filed under the card whose JIRA key it names — in the branch, the
title or the description. A key nothing on the board carries is ignored, which is what
keeps `UTF-8` and `ISO-8601` from being read as tickets.

The MR shows as a row on the card (pipeline dot, `!123`, source branch) and as a fuller
block in the detail pane: pipeline, approvals, reviewer state, and two separate "seen"
actions. Two, because a review comment and a red pipeline are separate reasons for the
card to be shouting and are tracked separately — acknowledging the pipeline must not
silence a comment that lands a second later.

Only MRs you **created** are fetched. Ones where you are merely a reviewer are someone
else's to land, and folding them in would double the board's noise.

> **Approvals may read "unknown".** GitLab's `/approvals` endpoint is tier-gated and
> refuses on some instances; the pane says so rather than showing a confident `0/0`.

### Answering it

A delegated task uses the same machinery as everything else: permission requests
and `@@NEEDS_INPUT@@` questions park the run and appear in the **Attention**
inbox. On My Tasks you don't have to go there — the card gets an **orange frame**
(the same treatment as an unread JIRA comment) and the question, with its
one-click options or a free-text reply, renders in the card's detail sidebar. The
live transcript streams into the same timeline as your comments and status
changes. **Stop** ends the run and keeps the worktree.

Usage limits behave exactly as they do for plan tasks: the task parks as
`blocked-by-limit` behind the global gate and resumes by session id at reset.

---

## Plan first, then execute in steps

A big ticket in one session is expensive: everything the agent read in hour one is
still being dragged through the context in hour three. So a card can instead be
delegated in **plan mode** — the agent researches, proposes a plan, you approve it,
and each phase of that plan then runs as its **own task in its own session**. A step
pays only for its own context.

### Planning, and the hold at the end

Assign the card with the permission mode **Plan**. The run starts with
`--permission-mode plan`, so the agent may read and search but not edit. When it is
done it calls `ExitPlanMode` with the plan attached — and we **hold** that call: the
plan lands in the Attention inbox (and in the card's sidebar) as a **plan approval**,
with the plan markdown and the list of steps approving it would create.

Nothing has been written to the repo at this point. Your two answers:

- **Approve plan** — the steps are created, the held `ExitPlanMode` is *denied* with a
  hand-over message so the planning session stops instead of implementing, the card
  goes *In Progress*, and step 1 starts.
- **Re-plan** — your note goes back to the **same** planning session, which keeps its
  research context and revises rather than starting over.

### Plan → steps

`src/main/planToSubtasks.ts` splits the approved markdown, forgivingly: the
shallowest heading level that yields at least two real sections wins (so `# Title` /
`## Phase 1` / `## Phase 2` splits at the phases, and deeper headings stay inside a
step's brief); failing that, a top-level list; failing that, the whole plan becomes
one step. Framing headings (*Context*, *Risks*, *Out of scope*, …) are skipped, and
the count is capped at 20. It never produces zero steps — an approved plan always
leaves something to run.

Each step becomes a normal task row with `parentTaskId` set and the section's own
text as its `description` (its **brief**).

### Running the chain

Steps run **strictly one at a time, in order**, in `bypassPermissions` — you approved
the plan, so the steps are full-auto.

- **One shared worktree per ticket.** Every step of a card runs on the parent's
  `orch/<parentId>` branch in the same worktree, so step 3 sees what step 1 built.
- **Integration happens once.** A finished step with a pending sibling marks itself
  done and starts the next one; only the **last** step merges the branch back into the
  base and removes the worktree.
- **The parent is never auto-completed.** After the final merge the card stays *In
  Progress* with a "ready for review" comment — moving it to Done is yours.
- A **failed** step parks and the chain simply stops; fixing it and marking it done
  resumes the chain. **Stop** on the parent stops the running step and marks the rest
  `stopped`. Usage limits park and resume a step like any other task.
- Each step's prompt is deliberately narrow: *step N of M*, its own brief, the sibling
  titles as one-liners, your notes on the card, and the shared-branch rule (commit;
  never reset/rebase/merge/switch). The JIRA comment thread is **not** included — it is
  the context a step should not pay for. As always, nothing is written back to JIRA.

### Writing the steps yourself

You don't need a planning round. Every card's detail sidebar has a **Steps** box: add
steps by hand with a title and a brief, then assign the parent — the chain runs your
steps directly. On the board, a parent card shows its steps as rows under its body
with a `2/5` progress caption; selecting a step gives it a breadcrumb back to the
parent and "Step N of M".

---

## Talking to the agent on a card

Answering a question the agent asked is one half of a conversation. The other half is
opening one yourself: *"actually, skip the cache"* while it works, or *"why did you drop
the index?"* after it stopped. The card's detail pane is that conversation.

### One pane, two halves

The pane is not tabbed. What a card *is* is context you read *while* talking to the agent
working it, not an alternative to it — so both are on screen at once:

- **A fixed band at the top** — the card's identity (type glyph, title, ticket key as a
  link to JIRA, type · priority · phase), then the agent controls, the **Details** cell
  (status, dependencies, a foldable description) and the **Steps**. One shaded slab, no
  boxes inside it, capped at half the pane's height with its own scroll so a long step
  chain can never crowd out the conversation. On a *step*, the brief replaces the details
  and the steps — for a step the brief is the whole spec.
- **The conversation below**, which is the only thing that scrolls. The live-run rows and
  the composer stay pinned beneath it.

The description folds away by default, because on a JIRA card it is usually twenty lines
of reproduction steps you have already read. **Edit** rewrites it in place — and that is
real work, since the agent's prompt quotes this text. It is deliberately one-way: nothing
is written back to the tracker, and the next JIRA sync replaces your text with the
issue's. The pane says so where you type.

Who wrote something decides where it sits in the conversation. One bubble shape throughout; the side, the
fill and a small tag carry all the meaning:

| Entry | Side | Look |
|---|---|---|
| Your message to the agent | right | brand fill |
| Your note | right | the same fill, a shade back — nobody else ever reads a note |
| Your JIRA comment | right | brand fill with a `JIRA` tag: it left the app |
| Someone else's JIRA comment | left | grey, with their name above it |
| The agent | left | **full width, no bubble**, under the agent glyph |

The agent's turn stays full width because tables and fenced code need the room; its
markdown is rendered, and every code block gets a language label and a **Copy** button.
A stretch of tool work folds into one muted line — *Worked with 12 tools* — that expands
to name any sub-agents it spawned. Failures are never folded away.

Knowing which ticket comment is *yours* needs to know who you are on JIRA, so the app
caches `GET /myself` (the call *Test connection* makes) per site. If it has never
connected, every comment renders as someone else's — better than putting words in your
mouth on the wrong side of the pane.

### Sending

One composer at the bottom of the pane, with the text area and its actions inside a single
surface. **Enter** sends to the agent, **Shift+Enter** starts a new line, and all three
destinations for the same text stay visible: **Chat with agent**, **Add note** (only you
ever read it) and **Add JIRA comment** on a linked card. The live *Agent running* rows sit
**above** the composer, not in the scroll, so the state of the run never scrolls out of
sight.

Under the box, a muted strip names who runs this card — *"Run by Claude in Demo Agent
Repo"* — with the **model** and **permission mode** editable right there. They are what
you most want to change just before you say something. Changing either restarts nothing: a
live run captured its model and mode when it started, so the choice applies to the **next**
run. (Reassigning the card is still what you want if you mean "start over with these.")

Where the message goes:

- **A live run** hears it immediately — it is written into the session's open input
  stream. If the agent had asked a question, your message *is* the answer, and the
  inbox item clears.
- **An idle card that has run before** is resumed: `claude --resume <sessionId>` with
  your text as the prompt instead of the usual continue-nudge. That is a **real run** —
  it reserves a slot, prepares the card's worktree and settles (and integrates) like any
  other — so it is not instant, and it appears in the timeline as a run.
- **A card that has never run** is not chattable. Chat continues a conversation; it does
  not start one. *Assign to an agent* does that.

Anything that cannot work says so above the box before you press anything: a run held on
an **approve/deny** (free text cannot approve a tool call — answer the request first), a
**usage limit** holding all work, or a card whose **plan is still running**. That last
one matters: a card executing an approved plan holds only its *planner's* session, so
the conversation lives on the step — chatting with such a card talks to the working
step, and the composer says which one ("Talking to step 2 of 4 — …").

### When a chain stops

A step that fails, or one parked on a question, now shows on **its card**: the orange
"wants you" frame, and a step count that reads `2/4 · stopped` rather than a bare `2/4`.
Its resolutions — retry, retry fresh, AI fix & retry, clean up, mark done — are offered
in the card's own pane, labelled with the step they belong to, and *Mark done* starts the
next step. If the app was closed mid-step, the step comes back parked (its session is
kept) with a **Run this step again** button, because nothing re-enters a chain on its own.

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
