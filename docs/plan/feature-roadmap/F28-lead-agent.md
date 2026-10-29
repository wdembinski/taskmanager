# F28 — Lead agent and orchestrated runs

> **Status:** proposed · **Written:** 2026-10-29 · **Where:** client (engine + renderer), web
> (the same screens through the relay) · **Depends on:** F10 (variant compare), F16 (AI
> reviewer), F8 (step workflows) · **Mockups:** `mockups/v11-*` (light and dark) and the
> clickable prototype `mockups/v11-lead-agent-prototype.html`
> Only the `- [ ]` checkboxes under **Tasks** become cards when this file is imported as a
> plan; everything else is context.

## Why

Today a card runs as one agent per step, and the owner reviews every plan by hand. Nothing
checks a step's diff before the next step starts, nothing compares two ways of solving the
same part, and the helper agents an agent starts are invisible. Effort is not settable at
all.

F28 adds a **lead**: one long-lived agent per card that orchestrates the run. It reviews
each plan before work starts and each diff after it ends, sends work back with a reason,
compares competing attempts and picks one, and brings the owner in only for real decisions.
The same lead works in both run modes:

| Mode | Who does the work | What the lead does |
|---|---|---|
| **Step by step** (today's flow) | one worker session per step, run by the engine | reviews each step's plan before it starts and its diff after it ends; sends a step back for another round |
| **Workflow** | helper agents in parallel, started by the lead in its own session | splits the work into parts, may run two attempts at a hard part, reviews and compares, merges the best into one branch |

## What we have today

- Sessions: `apps/client/src/main/claudeSession.ts` spawns `claude -p --output-format
  stream-json --input-format stream-json`, with `--disallowedTools` and a subagent model env
  var. The installed CLI (2.1.312) also accepts `--effort low|medium|high|xhigh|max` and
  `--agents <json>` (named roles with their own prompt and model). Neither is used.
- Every session gets `HEADLESS_TURN_CONTRACT` (`headlessContract.ts`), which forbids
  background subagents, because a headless turn that ends kills them (memory
  *headless-turn-has-no-next-turn*). The engine settles a run on the CLI's `result` event.
- Stream events carrying `parent_tool_use_id` (work done by a helper agent) are not read;
  the string appears nowhere in the code.
- Model ladder: `planningModel ?? defaultModel`, and F16 adds `reviewModel`
  (`aiReviewRunner.ts`). There is no effort setting anywhere.
- F10 variants: hidden variant rows, `variants:summary`, `VariantCompare.tsx`,
  `compareColumns.ts`, `variants:pick`. F16: `AiReviewRunner`, AI visual sign-off.
- F8 "workflows" are step templates applied to a card. The new **Workflow mode** is a
  different thing: one lead running parallel helper agents. An F8 workflow can still supply
  the steps for step-by-step mode.

## Design

### Roles, models and effort

- Four roles: **lead**, **planner**, **workers** (steps or parts), **reviewer**. Each has a
  model and an effort (`low | medium | high | xhigh | max`).
- Ladder per role: card setting, else project setting, else app default. Effort is passed to
  every session as `--effort`. The lead may change one worker's effort for one part and must
  say so in its thread.
- The Start dialog (`v11-4`) shows mode, lead on/off, the four roles, limits, "Ask me when"
  and an estimate. Without the lead the dialog is today's: the owner approves each plan.

### The lead

- One session per card, kept open for the whole run (`--input-format stream-json` already
  keeps stdin open). Its system prompt holds the review rules below; the engine sends it a
  message at every decision point and reads a structured verdict back.
- Decision points: plan ready, step or part finished, attempts finished, limit reached.
- Verdicts: `approve`, `send-back { reason }`, `pick { attempt, reason }`, `escalate {
  question }`. A send-back starts the next round of that step or part with the reason in its
  prompt. Rounds are capped (default 2); one more send-back escalates.
- The lead reuses what exists: the F16 AI reviewer for the code review, the AI visual
  sign-off for screens, the F10 compare data for attempts.
- Escalation goes to the Inbox as an attention item with the lead's question, and to the
  card's thread. Defaults: the overall plan, a part sent back the maximum number of times,
  spend reaching the cap, a tie the lead cannot break. Optional: every step's plan.
- Limits per card: agents (or sessions), rounds per part, spend cap. Reaching one pauses the
  run and escalates; nothing is killed mid-write.

### Workflow mode

- The lead runs the plan itself: it starts helper agents (the CLI's Agent tool, roles defined
  with `--agents`), each in its own worktree for a part, or two worktrees for two attempts at
  one part.
- The run stays open until every helper has reported back (F28.3); background helpers are
  allowed only in this mode and only through that mechanism.
- Parts merge into the card's branch in the lead's order; attempts that are not picked keep
  their branch for 7 days (F10's discard rules).

### What the owner sees

- **Run tab** (`v11-1`, `v11-2`): the lead's thread on one side; on the other the agent tree
  (workflow) or the steps with the lead's plan and diff verdicts (step by step). Each agent
  or step shows status, model, effort meter, time and cost. The header shows spend against
  the cap and agents or sessions against the limit. Clicking an agent filters the thread and
  lets the owner change its effort. The owner can message the lead.
- **Compare** (`v11-3`): F10's compare view with the lead's pick and reason on top, the same
  criteria for each attempt, and "Use C1 instead" to override.
- **Colour** follows the board's budget: cyan for running, orange for sent back; settled
  verdicts (approved, picked) are monochrome.

## Failure modes

- **The lead session dies:** the engine parks the card with the lead's last verdict; Resume
  restarts the lead with the thread so far. Workers already running keep going and report to
  the new lead.
- **Usage limit mid-run:** parks the lead and every worker (memory
  *limit-gate-is-the-only-memory*); they resume together.
- **Spend cap reached during a long turn:** the current turn finishes; nothing new starts;
  the owner is asked.
- **Owner overrides a pick:** recorded in the thread; the lead re-runs the reviewer on the
  new pick before it asks for sign-off.
- **The lead disagrees with the owner's plan approval:** it may only escalate, never
  silently change the plan.

## Out of scope (v1)

- More than two attempts per part, and combining hunks from two attempts.
- A lead that spans several cards.
- Leads on the web runner; the desktop runs them, the web shows and controls them.

## Open questions

1. **Name of the mode.** "Workflow" collides with F8's step workflows. *Recommended:* keep
   "Workflow" in the UI as drawn, and call F8's feature "step templates" in new text.
2. **Lead on by default?** *Recommended:* off until F28.7 has run on real cards; then on for
   new cards with the owner's per-card switch.

## Tasks

### F28 · Phase 1 — Effort and visibility

- [ ] F28.1 Set model and effort per role and pass --effort to every session

  - Roles, ladder and Start dialog roles table as in Design; store migration; `--effort` on
    every spawn; v11-4 roles section.

- [ ] F28.2 Read helper agents from the stream and show the agent tree

  - Parse `parent_tool_use_id` and the helper lifecycle events; an agent tree per run; the
    right column of v11-1 for any run.

- [ ] F28.3 Keep a run open until its background agents report back

  - Spike the CLI's background-task events first; settle on the last report, not the first
    `result`; scope the headless contract by mode.

### F28 · Phase 2 — The lead

- [ ] F28.4 Add the lead to step-by-step runs

  - Lead session, decision points, verdicts, rounds, limits, escalation to the Inbox, the
    lead thread and step verdicts (v11-2), lead switch, limits and "Ask me when" in v11-4.

- [ ] F28.5 Run workflow mode: the lead starts parts and attempts in parallel

  - Roles via `--agents`, worktree per part or attempt, merge order, agent tree with verdicts
    and per-agent effort (v11-1), Workflow option in v11-4.

- [ ] F28.6 Compare attempts with the lead's pick on the variant compare view

  - Lead verdict banner, shared criteria, override (v11-3).

- [ ] F28.7 Verify lead runs end to end with the stub CLI and document them

  - Stub-CLI scenarios for both modes, send-back, limit, escalation and override; docs.
