# 8. Token usage: what the app spends, and on what

This app's entire product is _starting sessions with someone else's model_, so its running
cost is not an operational detail — it is the thing the app does. This document is the
audit of that cost: every place the app can spend a token, what the spending actually looks
like when measured, which sites were changed and why, and — the part that matters most for
future changes — the standing rule about what should never become an agent in the first
place.

The evidence behind every number here lives in
[`docs/plan/token-usage-findings.md`](plan/token-usage-findings.md): how the database was
read, over what window, and how each prompt was weighed. This document is the conclusion;
that one is the working.

> **Read this before you add a session.** The single most expensive line of code you can
> write in this repo is one that starts a run. Not because a prompt is long — see
> _[Where the money actually goes](#where-the-money-actually-goes)_ — but because a session
> is a fixed ~$3 that the app decided to spend on the human's behalf.

---

## The whole surface is four sites

You can audit this app's token spend exhaustively, because there are only four places it
runs the `claude` binary at all, and only three of them talk to a model:

| Site                                                                      | What it starts                                                                      | Costs tokens?                          |
| ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | -------------------------------------- |
| [`claudeStatus.ts:26`](../src/main/claudeStatus.ts)                       | `claude --version`, to see whether the CLI is installed and on which host           | **No** — no model call                 |
| [`ipc.ts:434`](../src/main/ipc.ts) (`session:start`)                      | the manual Session view: the human types a prompt and watches it                    | Yes, human-initiated                   |
| [`scheduler.ts:1469`](../src/main/scheduler.ts) (`startAuxiliarySession`) | the one-shot "Align plan" run                                                       | Yes, human-initiated                   |
| [`scheduler.ts:2243`](../src/main/scheduler.ts) (`Scheduler.launch`)      | **every** task run: fresh, resumed, chat, retry, conflict fix, release, review seed | Yes — and most of it **app**-initiated |

All three session sites funnel through one primitive, `SessionManager.start`
([`sessionManager.ts:51`](../src/main/sessionManager.ts)), which spawns exactly one process
([`claudeSession.ts:378`](../src/main/claudeSession.ts)). There is no other path to the
model — no SDK, no HTTP client, no background summarizer. That is a deliberate property of
the architecture (see [doc 02](02-architecture.md) and the licensing reason in
[doc 06](06-licensing.md)), and the audit benefits from it: nothing can be leaking
somewhere unlisted.

The fourth row is worth its line in the table precisely because it is free. A reader
scanning for "where do we call the model" should be able to dismiss it in a second rather
than re-derive that a `--version` probe is harmless.

### The one system prompt

Every session — including a chat resume, whose prompt is the human's own raw words — gets
`HEADLESS_TURN_CONTRACT` ([`headlessContract.ts:27`](../src/main/headlessContract.ts))
appended via `--append-system-prompt-file`. It is ~250 words explaining that the turn is
single-shot and that a background subagent dies with it.

It is the only text the app adds to _every_ session, so it is the only text where "make it
shorter" would compound. It is also the one place where shortening would be a false
economy: it exists because a run once spent $1.70 on 50 tool calls and produced nothing,
having stopped to wait for background subagents that headless mode never delivers. Paying
~60 tokens per session to prevent that is the best trade in the file. Left as is.

---

## Where the money actually goes

Over a representative 5.3-day window of real work — 236 runs, 167 cards, **$815.02**:

|                    |        tokens | share |
| ------------------ | ------------: | ----: |
| cache **read**     | 1,745,518,016 | 96.1% |
| cache **creation** |    69,950,230 | 3.85% |
| fresh **input**    |       516,141 | 0.03% |
| **output**         |       232,574 | 0.01% |

Per run: mean **$3.67**, median **$2.57**, p90 $8.80.

Everything a prompt builder writes lands in the cache-creation bucket, once. Everything the
session then does — reading files, running tools, thinking across turns — lands in the
cache-read bucket, repeatedly. Which gives the rule this whole audit is organized around:

> **A prompt's text is not where the money is. A session is.**
> Every prompt-side saving in this audit put together is worth a few dollars a week.
> _Not starting one session_ is worth $2.57–3.67 on its own — and the sites that start
> sessions nobody asked for fire around thirty times a week.

This is why the findings below are ranked by measured saving rather than by how obviously
wasteful they look in the source. The most quotably wasteful line in the codebase (an agent
being told, at agent rates, to run `pnpm install`) ranks third; the site that simply starts
a session the human usually never opens ranks first.

---

## The findings

Ranked by measured saving over that window. `Sn` are the audit's own IDs, kept so the
implementation steps and the re-measurement map onto each other.

|      # | Site                                                                                                                                 | What it does today                                                                                                                     |              Saving / window |
| -----: | ------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------: |
| **S5** | [`scheduler.ts:4036`](../src/main/scheduler.ts) `seedParentReviewSession`                                                            | starts a whole fresh session the moment a chain finishes, so the card has something to talk to — 17 seeded, only 4 cards ever typed at |                   **$28–48** |
| **S3** | [`scheduler.ts:3183`](../src/main/scheduler.ts) `handleRunFailure`                                                                   | re-runs a failed task identically, with no notion of _why_ it failed and no failure context handed to the retry                        |          **$8–22** of $31–44 |
| **S4** | [`scheduler.ts:3524`](../src/main/scheduler.ts) `dispatchConflictFix`                                                                | up to two full agent sessions per merge conflict — including conflicts that are only a lockfile or a version line                      |           **$6–9** of $13–18 |
| **S6** | [`ipc.ts:536`](../src/main/ipc.ts) `project:alignPlan`                                                                               | a full session whose brief asks for one judgement _and_ for the insertion of a literal line the app already knows                      | $0 measured; **~$3 per use** |
| **S1** | [`scheduler.ts:2399`](../src/main/scheduler.ts) `taskNotes`, [`scheduler.ts:2176`](../src/main/scheduler.ts) `collectTicketComments` | re-reads the card's entire comment + chat history, and the ticket's entire thread, into every launch — uncapped                        |          **$1–5**, unbounded |
| **S2** | [`scheduler.ts:2223`](../src/main/scheduler.ts)–2234 (the prompt ternary in `launch`)                                                | a queued failure note forces the _whole_ brief to be rebuilt even on a `--resume` that already has it                                  |               **$0.10–0.50** |

Two of these deserve a note on why they are in the list at all despite their numbers.

**S1 is here because it is unbounded, not because it is large.** Today's cards carry a
handful of notes and the cost is dollars. A JIRA ticket with 100 comments is ~17,500 tokens
_per launch_, and a chain averages 8.6 steps. The fix is a cap, and the thing a cap must
never do quietly is lie: if a brief drops history, it has to say so, or the agent is being
told a partial thread is the whole thread.

**S6 is here despite firing zero times in the window.** Per _use_ it is a whole run, and
mechanizing the deterministic half also makes the result deterministic — an agent asked to
insert an exact literal line sometimes rewords it. This is the one place where the ranking
and the audit's plan order disagree most, and the disagreement is recorded rather than
smoothed over.

What the window also showed, outside this audit's scope but measured and worth someone's
attention: **13 planning runs ended without ever presenting a plan** (~$33), and 6 runs
ended without running a turn at all. Neither is a cause S3's classifier refuses — it names
only the four walls a second attempt provably meets again (no CLI, no credentials, a closed
usage window, a missing directory); both of these are transient, and still buy their retry.

---

## Correctly not an agent

The findings above are all one rule being broken. The rule:

> **If the answer is decidable from data the app already holds, decide it in code.**
> Ask the model only for judgement — and only where the judgement is genuinely open.

That rule is invisible when you only read the places that break it, which is why this
inventory exists. The app follows it in far more places than it breaks it, and every one of
these is a session that never starts:

| What could have been an agent                                      | Where it is code instead                                                                                                                                                         |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Summarizing what a finished chain did                              | `buildChainSummary` ([`chainSummary.ts:60`](../src/main/chainSummary.ts)) — every step's title, status and closing words are already in the store                                |
| Reading a `plan.md` into phases and tasks; ticking a box back      | `parsePlan` / `tickPlanCheckbox` ([`planParser.ts:219`](../src/main/planParser.ts), [`:233`](../src/main/planParser.ts))                                                         |
| Turning an approved plan into ordered steps                        | `splitPlanIntoSteps`, `toSubtaskTitle` ([`planToSubtasks.ts:229`](../src/main/planToSubtasks.ts), [`:162`](../src/main/planToSubtasks.ts))                                       |
| Judging whether a plan needs alignment work                        | `validatePlan` ([`planValidate.ts:135`](../src/main/planValidate.ts)) — this is what _tells the user_ to run Align                                                               |
| Naming a branch for a card                                         | `buildBranchName`, `dedupeBranchName` ([`branchName.ts:135`](../src/shared/branchName.ts), [`:196`](../src/shared/branchName.ts))                                                |
| Deciding whether a tool call is risky                              | `evaluateToolUse` ([`permissionPolicy.ts:74`](../src/main/permissionPolicy.ts)) — a policy, vetoing pre-execution                                                                |
| Mapping a JIRA status onto a board column                          | `resolveStatusColumn` ([`statusResolve.ts:61`](../src/shared/statusResolve.ts))                                                                                                  |
| Deciding whether an MR is mergeable, and what blocks it            | `detailedMergeBlocker`, `mrVerdict` ([`mergeRequest.ts:184`](../src/shared/mergeRequest.ts), [`:353`](../src/shared/mergeRequest.ts)) — GitLab's own verdict, never inferred     |
| Working out what a chain may run next                              | `linkSatisfied`, `readyToRelease`, `blockedBy` ([`taskChain.ts:230`](../src/shared/taskChain.ts), [`:248`](../src/shared/taskChain.ts), [`:289`](../src/shared/taskChain.ts))    |
| Choosing planning vs. execution model for a run                    | `resolveRunModel` ([`model.ts:344`](../src/shared/model.ts)) — a ladder, not a preference the model states                                                                       |
| Working out which runs survived a restart                          | `reconcileTasks` ([`taskReconcile.ts:45`](../src/main/taskReconcile.ts))                                                                                                         |
| Explaining what a dirty base or unborn HEAD means                  | `describeGitPreflight` ([`gitPreflight.ts:41`](../src/shared/gitPreflight.ts))                                                                                                   |
| Explaining why a session produced nothing                          | `describeEmptyOutcome` ([`scheduler.ts:272`](../src/main/scheduler.ts))                                                                                                          |
| Naming a conflicting file set in a note                            | `summarizeFiles` ([`scheduler.ts:200`](../src/main/scheduler.ts))                                                                                                                |
| Auto-resolving additive config conflicts (conflict ladder, Rung 1) | `UNION_MERGE_FILES` + `withUnionAttributes` ([`worktreeManager.ts:57`](../src/main/worktreeManager.ts)) — git's own `union` driver, scoped to files where ordering cannot matter |
| Deciding when a usage limit resets, and what to un-park            | `computeResumeAt`, `LimitGate` ([`limitGate.ts:65`](../src/main/limitGate.ts), [`:101`](../src/main/limitGate.ts))                                                               |
| Deciding whether a card auto-releases                              | `autoReleaseOn` ([`release.ts:34`](../src/shared/release.ts))                                                                                                                    |
| Deciding which events are worth showing a human                    | `shouldSurfaceEvent`, `mergeActivity` ([`eventNoise.ts:100`](../src/main/eventNoise.ts), [`activityMerge.ts:29`](../src/main/activityMerge.ts))                                  |
| Rolling spend up into the Performance dashboard                    | `rollupWindow`, `burnRate`, `bucketSeries` ([`usageRollup.ts:201`](../src/main/usageRollup.ts), [`:93`](../src/main/usageRollup.ts), [`:115`](../src/main/usageRollup.ts))       |

Two things follow from reading that list next to the findings.

First, **the six findings are outliers, not a pattern.** The app's instinct is already
right; six sites drifted.

Second, and more useful when you are the one writing the next feature: notice what the
column headings have in common. Every row on the left is phrased as a question, and every
question has exactly one defensible answer given data the app already stores. A model asked
that question would produce the same answer _most_ of the time, for ~$3, non-reproducibly.
That is the test. If you can write the assertion, write the function.

---

## The three sites left as agent work

Three sites were examined and deliberately left spending tokens. Each is here because the
question it asks is genuinely open — the app cannot write the assertion.

**1. The release run** ([`scheduler.ts:4107`](../src/main/scheduler.ts), prompt from
`buildReleasePrompt`, [`releasePrompt.ts:51`](../src/main/releasePrompt.ts)). Nine of these
ran in the window. Releasing is driven by the repo's own `RELEASE.md` — prose one human
wrote for another, different in every repo, and rewritten without telling us. Reading a
document whose format is not fixed and doing what it says _is_ the job of a model; a parser
for it would be a permanent liability, and a release that goes wrong is expensive to undo.
See [doc 03](03-how-orchestration-works.md) and the app's one standing override of
`RELEASE.md`: a draft is published, never left hanging.

**2. The planning run** (a card started in `plan` mode, ending at `ExitPlanMode`). The
window recorded 13 planning runs that produced no plan — visibly wasteful, and the largest
single loss the audit measured outside its own six sites. It stays anyway, because a plan is
the deliverable, not overhead: breaking a ticket into steps is the judgement the human
delegated. The waste is in the failure mode (a session that ends without calling
`ExitPlanMode`), not in the session existing, which is why the fix for it belongs with S3's
retry classification rather than here.

**3. The cross-agent negotiation vote**
([`scheduler.ts:4217`](../src/main/scheduler.ts) `sendProposalToSibling`). When one agent
proposes changing a shared approach, its in-flight teammates are asked to AGREE or OBJECT.
"Does this proposal break the work I am in the middle of?" is not answerable from anything
the app stores — the work is half-written, in someone else's worktree. And this site is
already the cheapest possible shape: it uses `sessions.send` into a session that is
**already running**, so a vote costs a few hundred tokens on an existing context rather
than a new session. It is worth studying as the model for anything similar.

There is also a fourth, partial case worth naming so it is not mistaken for a
contradiction: S4 and S6 are not being removed, they are being _split_. Both keep an agent
for their judgement half (resolving a genuine source conflict; deciding whether one task
really depends on another) and lose it for their mechanical half (regenerating a lockfile;
inserting a literal line the app already composed). Splitting a site is usually the right
answer when the rule and the code disagree.

---

## How any of this gets measured

The app already records everything needed to see these savings, and it records it _after
the fact_, from what the CLI reports:

- **`token_usage`** ([`store.ts:550`](../src/main/store.ts)) — one row per recorded model
  call: input, output, cache-creation and cache-read tokens, plus the run's cost. Written
  by `Scheduler.recordUsage` / `recordCost`
  ([`scheduler.ts:2444`](../src/main/scheduler.ts), [`:2474`](../src/main/scheduler.ts)),
  tagged `task` or `orchestrator` so an auxiliary run is distinguishable from work. The
  table deliberately has no foreign key: spend history outlives the project it was spent
  on.
- **`usageRollup.ts`** — `rollupWindow`, `burnRate`, `bucketSeries` turn those rows into
  the Performance dashboard.
- **`task_events` / `task_activity`** — the frequencies. Every site in the findings files a
  note in its own recognizable wording (`Auto-retrying`, `attempting AI resolution`,
  `**Plan complete**`), which is what made counting them possible at all.

So a before/after for any change here is: same window length, the same two queries, and the
per-run mean and median from `token_usage`. Baselines are in
[the findings](plan/token-usage-findings.md#what-step-9-should-re-measure).

### There is no pre-flight estimate, and this audit does not add one

Nothing in the app predicts what a run will cost before starting it, and that is a choice
rather than a gap:

1. **The decisions in this audit are yes/no, not how-much.** Every fix above is "don't
   start this session" or "don't repeat this text" — none of them needs a number to be
   made. An estimator would inform no decision the app actually takes.
2. **A prompt's size does not predict a run's cost.** 96% of the bill is cache reads
   generated by what the session _does_ after it starts. A perfect estimate of the brief
   would predict under 4% of the spend and mislead about the rest.
3. **An estimator is a second model of the prompt, and it drifts.** Every prompt builder
   would grow a shadow twin that must be updated in lockstep and is silently wrong when it
   is not.

The honest instrument is the one already wired: let the run report what it spent, and
compare windows. If a budget-style feature is ever wanted (refuse to start a run when the
week's spend passes a threshold), it should be built on `token_usage` — measured history —
not on a guess about a prompt.

---

Next: [Development roadmap](plan/README.md) — the phases this app was built in, and
[the findings](plan/token-usage-findings.md) — the measurements behind every number above.
