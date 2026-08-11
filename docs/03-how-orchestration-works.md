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

**Everything the limit stopped is parked, not just what was running.** The gate is
what remembers work across the reset, so anything that would have started while it
is up is parked behind it too — above all the **next step of a card's plan**, whose
predecessor finished mid-limit. A step held this way says *Paused — usage limit* on
its card and starts by itself at the reset. Three things follow from the same rule:

- a task the limit caught **before its session id existed** (the wall was hit while
  its worktree was still being prepared) is *started* at the reset rather than
  resumed — there is no conversation to lose, and skipping it was what left cards
  parked behind a gate that had already cleared;
- a **card** with steps outstanding hands back to its chain at the reset instead of
  opening a session beside them (its own session is the planner's, and two agents in
  one worktree is exactly what the chain exists to prevent);
- on startup, anything still `blocked-by-limit` is adopted by the restored gate — or,
  if no gate survived, resumed at once. Nothing else would ever raise it again.

**Stop** still wins: stopping a card drops it *and* any step the gate is holding, so
nothing comes back to life at the reset after you said stop.

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

## The My Tasks board is a query

A plan project's tasks are a **queue**: rows the app owns, which nothing outside it can
take away. The **My Tasks** board is the other thing — it is whatever your JQL returns,
redrawn every sync (default: every two minutes). That is what makes it useful, and it is
also the whole difficulty. *A ticket missing from an answer* and *a ticket that has left
the query* look identical from here, and the app used to treat the first as the second and
delete the card.

It no longer does. The rule the sync now enforces:

> **No card leaves the board unless JIRA was asked about it by key and answered.**

A short page, a failed batch, a question nobody put — every one of them means *keep*.
When JIRA does answer, and answers no, the card is **removed from the board, not
deleted**: the row keeps its timeline, its attachments, its chain arrows and any agent
transcript, it appears under **Removed cards** in the My Tasks toolbar with the reason it
left, and one click puts it back with the same id. Only two things destroy a card — you
saying so, and the 180-day sweep over cards that have sat in that list untouched.

### Risks, stated up front

Everything below is a known consequence of that design, not an open bug.

- **The first sync after upgrading is noisy.** The old sync read one page of 100 issues
  and treated it as the whole query, so on a board matching more than that, every issue
  past the hundredth was invisible — and cards for them were deleted for not coming back.
  Now the query is paged to the end, so they all return at once and the board can grow by
  hundreds in one poll. The direction is the reassuring part: that first sync *adds*. It
  settles from the second sync on, and **Removed cards** is there to make it inspectable.

- **A permanently wrong JQL costs you a confirmation every sync.** Save a query that
  matches nothing (or narrow a filter and forget), and every card on the board becomes a
  removal candidate on every poll: the guard refuses to remove more than a quarter of a
  board at once, the warning bar comes back, and the confirmation costs one request per
  fifty cards every two minutes. Nothing is removed and nothing is lost — it is noise and
  request volume until the query is fixed. If it ever becomes a real problem, the fix is
  written down in `ipc.ts` beside the pass: skip the confirmation on the sync after a
  refusal unless the query itself changed.

- **A ticket deleted in JIRA leaves its card on the board forever.** Asking about a
  deleted key fails the whole batch it travels in, so the card is never confirmed — and an
  unconfirmed card is kept, by the rule above. Deleting it is your call — **Delete task**, in
  the card's details. This is on purpose and should stay: JIRA answers a ticket it cannot show
  your token exactly as it answers one that does not exist, so a smarter guess here would
  delete live cards during a permissions blip. A stale card is a nuisance you can see; a
  destroyed card is work you cannot get back.

- **Removed cards accumulate, and the 180-day sweep is a real delete.** They cost a row
  each and are hidden from every board read, so the pile is cheap — but it has no ceiling
  until the sweep at startup, which destroys a card archived longer ago than that exactly
  as **Delete** would, timeline and transcript included. The bound is the card's age rather
  than a maximum count on purpose: a "keep the newest N" rule would prune hardest precisely
  when a board had started losing cards, which is when you most want to look.

- **Recovery of already-deleted cards is best-effort.** `scripts/recover-deleted-tasks.mjs`
  digs cards that were deleted by older versions back out of SQLite's free pages and WAL,
  and its odds fall with every minute the app keeps running afterwards. It is for the
  damage done before this landed. Nothing in the sync depends on it, and nothing should:
  no code may delete a card on the assumption that the scavenger could dig it out.

---

## Delegating one task to an agent

Plans are the batch mode: a queue of tasks the scheduler works through. There is
also a **single-ticket mode** for the **My Tasks** board — pick one card (a JIRA
ticket or an in-app task), hand it to Claude, and it works that one thing.

### Agent projects

A card on My Tasks belongs to the built-in *Personal* board, which has no folder,
so there is nowhere to run. You give it one by creating an **agent project** in
**Settings → Agents**: a name, a **repo folder**, optional **JIRA epic keys**, a
permission mode, and its two models — a **steps execution model** and an optional
**planning model** (see [Two models](#two-models-one-to-plan-with-one-to-execute)).

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

The model dropdown offers **Project default** as well as the three models, and that
is what most cards want: it leaves the card following its project's pair, so a
planning turn and a step of the same card can cost different things. Naming a model
here pins *every* run of this card to it, planning included — see
[Two models](#two-models-one-to-plan-with-one-to-execute).

The card keeps its place on the Personal board — only the **run** happens in the
agent project. That is what keeps this per-card: the queue scheduler never sees
the task at all.

### What the agent is told, and what it may do

The prompt is a single-ticket brief: key, URL and title, the ticket description,
its JIRA comments oldest→newest, your own notes, and your extra instructions. No
plan, no queue, no phases. It may read the repo's docs and memory files, and it
commits on its own branch in an isolated **git worktree**. When the run finishes
cleanly that branch is either merged back into the base branch or left for you to
merge from the card — see [Merging the branch](#merging-the-branch) below. Either
way a merge conflict comes back to you as an Attention item.

The base branch is the project's **Base branch** setting — pick the one your repo
actually integrates on (`main`, `master`, `development`, …). Left unset it follows
whatever the main checkout has out at the time, which is how this always behaved but
does mean the base moves when you switch branches. Pinning one you don't keep checked
out also makes integration immune to your own uncommitted work: that merge only moves
the branch pointer, so it never has to refuse in order to protect your files.

> **A delegated run never writes to JIRA.** Assigning, starting or finishing one
> never transitions a ticket or posts a comment. You can write to JIRA yourself —
> drag a card between columns, post a comment, create a card as a real issue — but
> the agent never does it on your behalf.

### Merging the branch

Whether a finished branch merges itself is asked of the **card**, and answered by the
first of these that has an opinion:

1. **the card**, on the board — the *Merge when finished* switch in its Details Panel;
2. **the project**, in its dialog — *Merge finished branches automatically*;
3. **the app**, in Settings → General — *Merging a finished branch*, off out of the box.

A level you never touch keeps following the one above it, which is the point: turn the
app's switch over and every project that never disagreed with it moves too, and set a
project's and every one of its cards moves with it. Setting a switch back to whatever it
was inheriting hands it back to inheriting — agreeing with a default is not disagreeing
with it, and its label says which default it is following.

Merging automatically merges at the moment the work has been reviewed *least*, which is
why the app-wide default is off: a finished branch then waits, its worktree is kept, and
the card offers a **Merge branch** button. Nothing is discarded on either path. Steps of
an approved plan are never asked — they share the card's branch and the whole plan merges
once, so the card's answer governs.

That button, and the two switches above it, are offered on one condition: an agent has
actually **run** on the card, in a repo that uses worktrees. "Has run" is a stored fact
about the card (`Task.workedAt`), deliberately not "does it hold a Claude session" — a
card whose plan finishes has its session cleared on purpose, and reading that as "this
card never ran" is what once made all three controls vanish at the exact moment the
card's own timeline said *review it, then choose Merge on the card*.

The switch is read when the run **finishes**, not when it starts, so you can change your
mind while the agent is still working.

### Releasing after the merge

A merge is not always the end of the job. If a repo knows how to release itself, the
app can carry straight on and do that too — but it never guesses what releasing means.

**The repo says how, in a `RELEASE.md` at its root.** That file is the whole recipe:
gates, version bump, tag, publish, whatever this project actually does. The
orchestrator only decides *when* to ask, which is why there is no release procedure
anywhere in its own code. A repo without a `RELEASE.md` is simply left alone — and the
card's timeline says so, rather than the switch silently doing nothing.

Two switches decide it, and the second one wins:

| Where | What it is |
| --- | --- |
| **Settings → Agents → the project → *Release after merge by default*** | The project's preference. Every card assigned to it starts here. |
| **The card's detail pane → *Release after merge*** | This card's answer. Overrides the project in either direction. |

A card that has never been switched **follows the project**, so turning the preference
on later turns it on for every card nobody has ruled on. Setting a card back to what the
project already prefers puts it back to following, rather than pinning today's answer.

When the branch merges, the card's own session is given one more turn: read
`RELEASE.md`, follow it, report what shipped. It runs in the project directory rather
than a worktree — the branch has just been merged and deleted, and what is being
released is the integration branch. If the merge only moved the base *ref* (your
checkout is on something else), the agent is told that before anything else: a release
cut from the wrong branch is the one mistake that cannot be taken back.

Nothing about the card moves. A release that fails files what happened on the timeline
and stops there — it does not retry, does not park a failed task, and does not touch
the column you left the card in. The work is merged either way, and re-running half a
publish is how you get two tags for one version.

> **This repo's own [`RELEASE.md`](../RELEASE.md)** is worth reading as an example:
> gates first, a stop-and-ask rule for anything needing a credential or a decision, and
> an explicit "leave the draft unpromoted and hand back" for the platform an unattended
> run cannot build.

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

### Stopping it

**Stop** is on the card itself — a small square-in-circle button beside the agent
glyph — and again in the detail pane's **Agent** panel. It appears whenever there is
work a click could stop, which is wider than "this card says `running`":

- the card's own run, including the moment between the session spawning and the board
  hearing about it;
- a card executing an approved plan, whose *step* holds the run while the card sits
  *In Progress* — one Stop covers the card and every step of its chain;
- a chain caught between steps, whose next step would start by itself;
- a card parked behind the usage limit, which Stop unparks so it does not come back to
  life at the reset.

Stopping keeps the branch and the worktree, so the work is picked up again by sending
the agent a message. It changes no column: stopping is a run's end, not a card's, and
only you move a card (see *Where the card sits while it works* below).

Usage limits behave exactly as they do for plan tasks: the task parks as
`blocked-by-limit` behind the global gate and resumes by session id at reset.

### Where the card sits while it works

**A running agent never moves a card, and never stops you moving one.** A card left in
TO DO stays in TO DO while its agent works, and after it finishes; that a run is happening
is said by the spinner, the agent glyph and the run strip, not by the column.

The reverse holds too, and is the same rule read the other way: you can drag a card to any
column — or pick a state in the detail pane — **while its agent is mid-run**, including a
card running an approved plan's steps. The card moves, the linked JIRA issue transitions as
it would for any other move, and the run carries on untouched. Moving a card says where the
work belongs, not that it should stop; stopping is what **Stop** is for.

Under the hood a run *borrows* the card's status field rather than owning it, and the state
you pick is parked in `preRunStatus` and handed back to the card when the run settles — so
your move is neither lost nor able to evict the run (`src/main/cardStatusGuard.ts`).

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

### Running the step chain

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
  `stopped`. Usage limits park and resume a step like any other task — including the
  step that had not started yet when the limit arrived, which is parked behind the
  same gate so the reset can start it (see *Usage limits* above).
- Each step's prompt is deliberately narrow: *step N of M*, its own brief, the sibling
  titles as one-liners, your notes on the card, and the shared-branch rule (commit;
  never reset/rebase/merge/switch). The JIRA comment thread is **not** included — it is
  the context a step should not pay for. As always, nothing is written back to JIRA.

### Two models: one to plan with, one to execute

Planning is the one run whose whole output is judgement — it reads a repo it has
never seen and decides what the work *is* — while a step is handed a brief that
already says what to do. They do not have to cost the same. A project therefore
names **two** models, in **Settings → Agents** (and in the Projects tab's dialog):

- **Steps execution model** — what work runs on. The field that has always been
  there (`defaultModel` in the schema); only its label changed.
- **Planning model** — what a planning turn runs on. Leave it at *Same as
  execution* — the default, and what every project that predates the split carries
  — and nothing about that project changes: both halves use the execution model.

A card or a step may still overrule both, from the assign dialog, the composer
strip, or the step's own controls. The whole ladder is one pure function
(`resolveRunModel`, `src/shared/model.ts`):

```
task.agentModel                                 // this card's / this step's own choice
  ?? (planning ? project.planningModel : null)  // "Same as execution" puts nothing here
  ?? project.defaultModel                       // the steps execution model
```

**What counts as planning is the turn, not the mode.** A run is billed as planning
only when it was *asked* for a plan and is held to it: the first `plan`-mode run of
a card, and a **re-plan**. A card assigned Plan mode also *chats* in Plan mode, and
is briefed on its finished chain in Plan mode, and neither of those is planning —
they are conversations that merely may not write, and they use the execution model.
(`run.expectsPlan && run.permissionMode === 'plan'` is the pair that decides, the
same pair the mode itself is read from.)

**Steps carry no model of their own.** Approving a plan creates steps that inherit
where they run and the forced `bypassPermissions`, but *not* the model their parent
was planned on — inheriting it would silently bill the whole chain at the planning
rate. A step's model is empty, meaning *Project default*, and a step that genuinely
needs a better one is set one step at a time.

**The ladder is read once, when the run starts,** and the answer is captured on the
run. Changing a model — the card's, the step's or the project's — therefore decides
the **next** run and can never move one already in flight.

### Writing the steps yourself

You don't need a planning round. Every card's detail sidebar has a **Steps** box: add
steps by hand with a title and a brief, then assign the parent — the chain runs your
steps directly. On the board, a parent card shows its steps as rows under its body
with a `2/5` progress caption; selecting a step gives it a breadcrumb back to the
parent and "Step N of M".

**Folding the rows away.** A nine-step plan is most of a column on its own, so the
card's **Steps** heading is also a fold: click it and the rows go, leaving the
heading, its `2/9` and the counter in the card's title row. The fold is per card and
it is **saved** — leaving the screen unmounts the board, and closing the app takes
the window with it, so a fold you had to redo on every visit would not be worth
making. Nothing ever unfolds a card for you: a running step, a step that has parked
the chain, and a card that wants you all still ring, count and say what they are
doing on the card's own body.

---

## Chaining cards

A board says what there is to do. It has never said what **order** it has to happen
in: two cards that touch the same file, or one that cannot start until another's
branch has landed, look exactly like two independent cards, and the ordering lives in
the head of whoever set the work up. A **chain** writes that down — an arrow from one
card to another, plus the **gate** that says what "after" means for that pair.

### A chain is not a card's steps

The two features share the word and almost nothing else. Steps are one card's work,
split up; a chain is several cards, ordered.

| | **Steps** (of one card) | **A chain** (between cards) |
|---|---|---|
| What it is | phases of one approved plan, `parentTaskId` → the card | links (`task_links`) between two ordinary cards |
| Where the work happens | **one** branch in **one** worktree, shared by every step | each card keeps **its own** branch and worktree |
| Integration | **once**, when the last step finishes | **each card merges itself**, in its own time |
| Order | implicit and total — `order`, one at a time | whatever arrows you drew: a line, a fan, a diamond |
| Who made it | the planner (or you, by hand, in the Steps box) | you, by dragging |
| Failure | the rest of the steps stop | the successor is simply never released |

Which is why a **step may not be chained at either end**: its order *is* a chain
already, and a second one over the top of it could only ever disagree. Chain the
parent cards — the steps come along with them. A loop is refused for a blunter
reason: every card in it would be waiting for a card that is waiting for it, so it
could never start, and nothing downstream would ever say so.

### The two gates

A link carries one, and it is the whole of what the link means.

- **After merge** (`after-merge`, the default) — the predecessor's work has **landed**:
  its branch is in the base branch. The successor starts from settled code. This is the
  safe one, and the one to use when the successor would otherwise build on something
  still under review and still liable to change.
- **Stacked on this branch** (`stacked`) — the predecessor has stopped *writing*, and
  there is a branch to build on. The successor's worktree is **cut from the predecessor's
  branch** instead of from base, so it starts with those commits already in its tree.
  Sooner, at a price: the branch underneath may still be rebased or rewritten in review,
  and merging the successor carries the predecessor's work along with it. The successor's
  timeline says both of those in words when it is released.

"Landed" is a stored fact (`Task.landedAt`), not one inferred from the card's column or
its merge request's current state — a card dragged back out of Done, or a GitLab poll
that has not run yet, must not pull a start out from under a card that already began. It
is stamped from **two** places: a local integrate that merges the branch, and a linked
merge request GitLab reports as `merged`. On a project whose branches go through review
nobody merges locally, so the second one is how the app ever learns the work shipped.

The merge **target** is never affected by a gate: a stacked card still integrates into
its project's base branch, exactly like every other card.

### Drawing one

Drag the dot on a card's right edge onto the card that should run **after** it. Every
other card is marked the moment the drag begins — valid, already linked, or refused —
and an invalid target cancels the drop in the cursor rather than in a message afterwards.
The handle is a real button, so **Enter** arms a link that the next card you pick
completes. Click an arrow to select it: a small panel on its middle switches the gate,
**Delete** erases it.

Two more routes to the same fact, neither needing a mouse or a visible board:

- **Add task** has a *Runs after…* picker, so a card can be chained as it is created.
- The card's detail pane has a **Chain** section — *Waiting on* above, *Releases* below,
  each row naming the gate, opening that card, and carrying an unlink button.

### What the board shows

One arrow per link, drawn over the board in a single SVG that scrolls with the cards. The
ink is budgeted: a resting arrow is a 1px neutral hairline, and anything louder is earned
by something moving.

- **Dashed** while the gate is not yet met; **cyan and travelling** while the predecessor
  is actually running; **2px accent** along the whole route upstream and downstream of the
  card you selected or hovered.
- A **stacked** gate is a double hairline — the two gates are told apart without spending
  a colour on a fact that never changes.
- An arrow leaves and enters the two edges that **face each other**, because a board's
  chains mostly run backwards (the card doing the work is in In Progress, the card waiting
  on it is still in To Do, to its left). An end the board is not currently showing — Done
  hidden, filtered out by the sprint switch — becomes a counted stub into the board's edge
  rather than a line to nowhere.
- The card itself carries a monochrome **`waiting on KEY`** chip, and **`ready`** once
  every predecessor is satisfied but nothing has started. When the card it names has already
  finished writing and is only waiting to be merged, the chip says **`waiting on KEY to
  merge`** — same neutral chip, same link icon, one extra word, because "waiting on VIP-3"
  otherwise reads the same whether VIP-3 has not been started or has been sitting in review
  for two days, and only the second is something you can fix. The card's pane goes further:
  it offers **Merge VIP-3** beside *Open VIP-3*, so the one thing holding the chain up is a
  click from where you already are.
- **Chain focus** in the toolbar reduces the board to the selected card's chain —
  everything upstream, everything downstream, and the siblings entangled with it. The cards
  stay in their real columns; it is a filter, not a pipeline of its own. It is deliberately
  not remembered between launches.

### What happens when a predecessor finishes

`src/main/chainRunner.ts` owns this, called by the scheduler whenever the world changes in
a way that could release a card. Two of those moments are a card of its own finishing — a
branch landed, a run finished writing. The rest have no card to point at: nothing finished,
something around the chain merely changed. Those all come through one **re-ask**
(`reconsider`), which starts every card whose predecessors are already satisfied and which
has never run — today the app booting and a usage limit lifting. Each names its own cause
on the card's timeline, because "started automatically" with no subject is the entry that
sends you hunting through three other cards' logs.

- A card fed by several arrows waits for **all** of them (an AND-join) — a diamond is the
  commonest shape a chain takes, and releasing on the first arrow would start the work whose
  whole reason for waiting was the other two.
- A release **starts** the successor only if it is assigned to an agent and still resting in
  To Do or In Progress, with its own work neither landed nor under way. Anything else gets a
  note on its timeline naming what released it, and is left alone.
- **The only column a chain writes is the one it starts a card into.** Where a card sits
  stays yours, exactly as it is for every other run — with one exception, and it is what
  makes the rule honest: a card the **app** starts by itself is moved to In Progress, because
  nobody was here to move it and a card being worked on that still reads To Do is a lie. The
  move is said on the card's timeline, and the card comes back to In Progress when the run
  settles. Nothing else moves a card: not a decline, not a run finishing, and not **Release
  now** — there you are looking at the board and already chose the column.
- A predecessor you **stopped or cancelled** releases nothing: whatever state its branch is
  in, that is not "carry on with the next one". A **usage limit** holds a release exactly as
  it holds everything else — and nothing is lost, because `landedAt` is on disk and the
  moment the limit lifts the chain is re-asked, so a card released behind the gate starts
  then rather than at the next restart. That re-ask is the last thing the resume does, after
  every parked run has re-reserved its slot, so no card is started twice.
- **A merge nobody has pressed is the commonest reason a chain looks stalled**, so both ends
  say so. The predecessor's timeline note — the one you already read to learn its branch was
  *not* merged — ends by naming the cards parked until it is (`ChainRunner.heldByMerge`);
  "merge it when you get to it" and "three cards are waiting on you" are different decisions.
  From the other end, `awaitingMerge` picks out the predecessors waiting on nothing but a
  human, which is what the successor's chip and its **Merge** button are drawn from. It asks
  one question — *would a `stacked` gate already be satisfied where this `after-merge` one is
  not?* — so there is a single definition of "the work is written" rather than a second copy
  that could drift from the gate the engine applies.
- **Release now**, in a blocked card's pane, starts it anyway. Some chains only ever recorded
  the order things ought to be *looked at*, and there the gate is an obstacle rather than a
  safeguard. The link stays; the timeline says it went ahead of it.

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
  step chain can never crowd out the conversation. On a *step*, the brief replaces the details
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
you most want to change just before you say something. The model list includes **Project
default**, which hands the card back to its project's planning/execution pair rather than
pinning it to one model; picking a named model pins every run of this card, planning
included (see [Two models](#two-models-one-to-plan-with-one-to-execute)). Changing either
restarts nothing: a live run captured its model and mode when it started, so the choice
applies to the **next** run. (Reassigning the card is still what you want if you mean
"start over with these.")

Where the message goes:

- **A live run** hears it immediately — it is written into the session's open input
  stream. If the agent had asked a question, your message *is* the answer, and the
  inbox item clears.
- **An idle card that has run before** is resumed: `claude --resume <sessionId>` with
  your text as the prompt instead of the usual continue-nudge. That is a **real run** —
  it reserves a slot, prepares the card's worktree and settles (and integrates) like any
  other — so it is not instant, and it appears in the timeline as a run.
- **A delegated card with no session to resume** gets a *fresh* conversation, opened with
  your message and the card's full brief. Two cards look like this: one assigned without
  being started, and one whose approved plan has just finished — a finished chain clears
  the card's session on purpose, because the planner's context predates every line its
  steps wrote and resuming it is the most expensive thing in the chain.
- **A card no agent owns** is not chattable at all. *Assign to an agent* comes first.

Anything that cannot work says so above the box before you press anything: a run held on
an **approve/deny** (free text cannot approve a tool call — answer the request first), a
**usage limit** holding all work, or a card whose **plan is still running**. That last
one matters: a card executing an approved plan holds only its *planner's* session, so
the conversation lives on the step — chatting with such a card talks to the working
step, and the composer says which one ("Talking to step 2 of 4 — …").

### When a step chain stops

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
