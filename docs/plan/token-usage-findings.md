# Token-usage findings, ranked by saving

Step 1 of the *Task Manager audit for token usage optimization*. This file is the
**evidence and the ranking** the rest of the plan is built on: what each site actually
costs, measured rather than assumed, and therefore which order the fixes are worth doing
in. Step 2 turns this into the audit document proper; steps 3–8 implement the fixes; step
9 re-measures.

The six sites are the ones the approved plan names. They keep their plan numbers as IDs
(**S1**–**S6**) so later steps map cleanly, but they are **listed here in order of
measured saving**, which is not the plan's order.

---

## How the numbers were obtained

Two independent measurements, both reproducible.

**1. What the app really spent.** The app records every turn's token counts and each
run's cost in its own `token_usage` table (`store.ts`, written by
`Scheduler.recordUsage` / `recordCost`). The live database was read **read-only** —
never launch the app to do this; see the `verify-electron-app` rule — with Electron's
own Node so the `better-sqlite3` ABI matches:

```
ELECTRON_RUN_AS_NODE=1 <checkout>/node_modules/electron/dist/electron.exe query.cjs
# query.cjs:
#   new Database(process.env.APPDATA + '/claude-orchestrator/orchestrator.db',
#                { readonly: true, fileMustExist: true })
```

Frequencies come from `task_events` (the run notes the scheduler files, matched by their
own wording — `%Auto-retrying%`, `%attempting AI resolution%`) and from `task_activity`
(the chain summaries, matched by `%Plan complete%`).

**Window: 30 Jul 2026 12:59Z → 4 Aug 2026 19:30Z — 5.3 days, one machine, real work.**
It covers phases 22 and 23 and several interim releases, so it is a representative busy
week rather than a synthetic run. Everything below that says "per window" means per those
5.3 days.

**2. What the prompts actually weigh.** The prompt builders are pure, so they were
measured directly by calling them with synthetic inputs outside the repo (Node 22's type
stripping on copies of `agentTaskPrompt.ts`, `chainSummary.ts`, `alignPrompt.ts`). Sizes
are in characters; tokens are quoted at the usual ≈4 chars/token and are approximations.

Nothing was written to the database, and no harness was left in the tree.

---

## The finding that reorders the whole audit

| | tokens | share |
|---|---:|---:|
| cache **read** | 1,745,518,016 | 96.1% |
| cache **creation** | 69,950,230 | 3.85% |
| fresh **input** | 516,141 | 0.03% |
| **output** | 232,574 | 0.01% |

236 runs recorded (222 of them spent tokens), across 167 cards, costing **$815.02**.
Per run: mean **$3.67**, median **$2.57**, p25 $1.26, p75 $4.74, p90 $8.80, max $25.79.

Re-pricing those four buckets reproduces $791 of the $815 at Sonnet-tier rates
(≈$3.75/M cache-write, ≈$0.30/M cache-read), so as a working rule for this app:
**cache reads are ~2/3 of the bill, cache creation ~1/3, and everything a prompt says
lands in the cache-creation third exactly once.**

The consequence is blunt and it decides the ranking:

> **A prompt's text is not where the money is. A session is.** One average run costs
> $3.67. Every prompt-side saving in this plan put together is worth a few dollars per
> week; **not starting one session** is worth $2.57–3.67 on its own, and the sites that
> start whole sessions nobody asked for fire 30-odd times a week.

That does not make the prompt caps pointless — S1 is unbounded, and an unbounded thing
eventually stops being small — but it does mean the audit's headline is *sessions*, and
the caps are hygiene.

---

## The ranking

| Rank | Site | What fires | Times per window | Est. saving per window | Confidence |
|---:|---|---|---:|---:|---|
| 1 | **S5** `scheduler.ts:4036 seedParentReviewSession` | a whole fresh session per chain completion | 17 summaries / 15 cards, **only 4 cards ever typed at afterwards** | **$28–48** | high — count and unit cost both measured |
| 2 | **S3** `scheduler.ts:3183 handleRunFailure` | an identical re-run, no failure context | 12 auto-retries (35 park events on 16 cards) | **$8–22** of the $31–44 spent | medium — the unretryable share is estimated |
| 3 | **S4** `scheduler.ts:3524 dispatchConflictFix` | up to 2 full sessions per merge conflict | 5 dispatches on 3 cards; only 1 conflict ever reached a human | **$6–9** of the $13–18 spent | medium — the lockfile-only share is estimated |
| 4 | **S6** `ipc.ts:536 project:alignPlan` | a session to insert a line and stub a file | **0** in this window (no auxiliary runs at all) | $0 measured; **~$2.6–3.7 per use** | high per-use, unknown frequency |
| 5 | **S1** `scheduler.ts:2399 taskNotes` / `2176 collectTicketComments` | the card's whole comment + chat history, re-read every launch | every launch — 236 runs, 146 of them chain steps | **$1–5**, and **unbounded** | high on the per-launch cost, low on the tail |
| 6 | **S2** `scheduler.ts:2223-2234` | a full brief rebuilt on top of a `--resume` | 17 (the 12 retries + 5 conflict fixes) | **$0.10–0.50** measured | high on the text; the re-orientation effect is unmeasured |

Realistic total: **$45–85 per 5.3 days, i.e. 6–10% of the bill** — of which the prompt
trimming (S1 + S2) is under 1 point. Everything else is sessions that did not have to
start.

---

## S5 — a session per chain completion (rank 1)

`finishParentChain` builds the chain summary deterministically — `buildChainSummary`
already knows every step's title, status and closing words — files it on the card, and
then calls `seedParentReviewSession`, which starts **a real, fresh, full-cost run** whose
only job is to have read that summary in case the human says something.

Measured: **17** `**Plan complete**` summaries across **15** cards; on only **4** of those
cards did the human type anything afterwards. So roughly **11 of 15 seeded sessions were
never spoken to**. At the median run cost that is **$28–40**; at the mean, $40–48.

The prompt itself is cheap (`buildChainHandbackPrompt` on a 9-step chain measures 4,631
chars ≈ 1,160 tokens). It is not the prompt: it is that the run then reads merged code and
writes a reply into a conversation nobody opened.

**Fix (step 8).** Start the session when the human actually types. The summary is already
filed by then, so the card is not silent in the meantime — and the deferred session gets a
*better* brief, because it can be given the human's question along with the summary.

**What must not break.** The card must still stop spinning and stay In Progress; the
existing refusal reasons (`resumeForChat`, `chainInFlight`) must not start rejecting the
first message typed at a finished chain — that message is now what *starts* the session.

## S3 — retries that cannot succeed (rank 2)

`handleRunFailure` re-runs the task `maxAutoRetries` times (default **1**) with no notion
of *why* it failed and no failure context handed to the retry. Measured: **12** auto-retry
notes and **35** park-after-failure events on 16 cards. Twelve retries at $2.57–3.67 is
**$31–44** spent on second attempts.

Not all of that is waste — a retry that succeeds is worth every cent. What is waste is the
class of failure where a second identical attempt cannot possibly do better. The failure
reasons the scheduler itself produces already separate cleanly:

- **cannot succeed on retry** — `Worktree preparation error: …` (raised before any session
  starts, and already bypasses the retry path), a removed agent project, a dirty base, a
  refusal from the permission broker;
- **may succeed** — `the process exited with code N`, `the session ended without running a
  turn — nothing was sent to the model` (6 events on 4 cards: a dead process, genuinely
  transient), and `the planning session ended without presenting a plan` (13 events on 8
  cards — retryable, and note how often it happens).

Assuming a quarter to a half of the retries are in the first class: **$8–22 per window**,
plus the latency of a doomed attempt.

**Fix (step 5).** Park the unretryable ones immediately; give the retryable ones the
reason, so the second attempt is not the first one again. The reason text is already
computed (`describeEmptyOutcome`, `settle`) — the classification is the only new logic, and
it belongs in a pure, testable function beside `shouldAutoRetry`.

## S4 — an agent to resolve a lockfile conflict (rank 3)

`escalateConflict` gives the agent up to `MAX_CONFLICT_FIX_ATTEMPTS` (2) full sessions per
merge conflict before a human sees it. Measured: **5** dispatches on 3 cards, and only
**1** conflict ever reached a human — so the ladder does work, at **$13–18** per window.

The tell is in the prompt this site writes itself:

> *"If a lockfile (e.g. `pnpm-lock.yaml`) conflicts, regenerate it (e.g. `pnpm install`)
> and stage it."*

That is a mechanical instruction being paid for at agent rates. In this repo a lockfile or
a `package.json` version line is *the* recurring conflict, because every release bumps it.
Resolving those two cases in code before dispatching an agent removes the dispatch
entirely whenever they were the only conflicting files: estimate **$6–9 per window**, and
a merge that finishes in seconds instead of minutes.

**Fix (step 6).** A mechanical rung between today's union-merge (Rung 1) and the agent
(Rung 2): regenerate a conflicted lockfile, take the higher version on a version-only
conflict, stage them; dispatch the agent only for what is left. Conflicts it cannot handle
must fall through unchanged.

## S6 — a session to insert one line (rank 4)

`project:alignPlan` starts a full session (planning model, `acceptEdits`) whose brief
(`buildAlignPrompt`, 2,548 chars ≈ 640 tokens) asks for two things: append `@needs:`
clauses where a task genuinely depends on another — **judgement** — and insert the exact
literal line `- [ ] Define shared contract in CONTRACT.md @contract` at the top of the
qualifying milestones, plus scaffold a `CONTRACT.md` — **mechanics the app already
decides**, in `planValidate`, which is what tells the user to run Align in the first place.

Measured frequency in this window: **zero**. There are no `orchestrator`-source rows in
`token_usage` at all, so no auxiliary session ran in 5.3 days. Per use it is worth a whole
run ($2.57–3.67); as a share of the current bill it is worth nothing.

That is why it ranks fourth rather than second, and it is the one place where the plan's
ordering and the data disagree most. It stays in scope because the *whole* saving is the
whole run when it does fire, and because doing the mechanical half in code also makes the
result deterministic — an agent asked to insert a literal line sometimes rewords it.

**Fix (step 7).** Insert the `@contract` line and scaffold `CONTRACT.md` from code, using
the phases `planValidate` already identifies; ask the agent only for the dependency
judgement — or not at all when there is none to make.

## S1 — the notes and the comment thread, re-read every launch (rank 5)

`taskNotes` reads the card's **entire** comment + chat history on every launch, and
`collectTicketComments` fetches the ticket's **entire** thread for every fresh run. Neither
is capped. Every step of a chain re-reads the parent's whole history.

Measured, both sides:

| prompt | chars | ≈ tokens |
|---|---:|---:|
| card prompt, no notes or comments | 2,135 | 534 |
| step prompt, no notes | 2,780 | 695 |
| + per note (300-char note) | +322 | +80 |
| + per ticket comment (700-char comment) | +725 | +181 |
| card prompt, 10 notes + 10 comments | 12,381 | 3,095 |
| card prompt, 30 ticket comments | 23,535 | 5,884 |

And what the cards actually carry today: 34 comments averaging **1,695** chars (max 4,873)
and 26 chat messages averaging 72; per card the distribution is 1 note (12 cards), 2 (9),
3 (3), 4 (2), 6 (1), 7 (1). The heaviest card holds **11,493 chars ≈ 2,900 tokens**, and a
chain averages **8.6 steps** (146 steps across 17 chains; longest 13) — so that card's
notes are re-paid ~9 times, ≈26k cache-creation tokens, well under a dollar. Across the
window: **$1–5**.

So today this is small. Two things still make it worth doing, in this order:

1. **It is unbounded.** A JIRA ticket with 100 comments of 700 chars is ~70 KB ≈ 17,500
   tokens *per launch*, ~$0.28 a launch and ~$2.50 across a 9-step chain — and long before
   the money hurts, it is crowding the context window of every step with a thread that
   mostly predates the work.
2. **Nothing tells the agent it was truncated**, because nothing truncates. The fix must
   say what it dropped, or a capped brief silently becomes a lying brief.

**Fix (step 3).** Bound by recency and a character budget, keep the newest, and emit an
explicit omission line ("… 42 earlier comments omitted"). Note the existing deliberate
omission that must be preserved: a **step** is briefed on its step, not on the ticket
thread (`collectTicketComments` returns `[]` for a subtask) — that is already the saving,
and it must not be undone by a cap that starts including them.

## S2 — a resume that re-briefs itself (rank 6)

In `launch`, the prompt is `chatPrompt ?? (resumeSessionId && !failureNote ? RESUME_NUDGE :
full brief)`. So any queued `failureNote` — set by an "AI fix & retry" *and* by every
conflict dispatch — forces the **whole** brief to be rebuilt even when the run is a
`--resume` of a session that already has all of it.

Measured delta: the nudge is **89 chars (~22 tokens)**; the same run's full card brief with
10 notes and 10 comments is **12,381 chars (~3,095 tokens)**; the failure note on its own
would be ~184 chars (~46 tokens). Times the 17 occasions in the window (12 retries + 5
conflict fixes), the text is worth **$0.10–0.50**. It is last on measured saving and it is
honest to say so.

What is *not* measured, and is plausibly worth more: a resumed session handed a full
fresh brief re-orients — re-reads the ticket, re-reads files it already has in context —
because the brief tells it to ("Read whatever you need to understand the codebase
first…"). That is session-shaped cost hiding behind a prompt-shaped change. Step 9 can
test it directly by comparing a retry's run cost before and after.

**Fix (step 4).** When resuming, carry the failure note alone. Keep the full rebuild for a
genuinely fresh run (no `sessionId`) — the note without the brief would then be a note
about nothing.

---

## What the data also showed (outside this plan's scope)

Recorded here because it was measured, not to widen the plan:

- **13 planning runs ended without presenting a plan**, on 8 cards. Each is a full session
  that produced nothing; `describeEmptyOutcome` catches them, so they are already visible.
  At the median that is ~$33 per window — larger than four of the six sites in this plan.
- **6 runs ended without running a turn at all**, on 4 cards.
- **40 "finished on branch, NOT merged" notes** on 29 cards: work sitting unmerged is not a
  token cost, but a card that is later re-run to re-check the same branch is.
- The **9 release runs** and the negotiation vote were left alone deliberately by the plan;
  nothing in the data argues with that.

## What step 9 should re-measure

Same window length, same two instruments, and specifically:

1. `token_usage` per-run mean and median (baseline: $3.67 / $2.57).
2. Count of `**Plan complete**` summaries vs. the number of runs started on those cards
   (S5 should drop to the number of cards actually typed at).
3. Count of `%Auto-retrying%` notes and, of those, how many were second failures (S3).
4. Count of `%attempting AI resolution%` dispatches (S4 should fall to the conflicts the
   mechanical rung could not settle).
5. Prompt sizes from the pure builders, capped inputs vs. today's uncapped ones (S1, S2).

Baselines for 1–5, in one place, are the tables above.
