# F10 — Variants

> **Status:** proposed — **lowest priority of this roadmap; a YAGNI candidate.** Build it only after F6 has shipped and only if hard cards keep coming back with a wrong first attempt. · **Where:** client (engine + renderer), web (compare + pick through the relay) · **Depends on:** **F6** (the in-app diff viewer — the compare view is that viewer, three times) · **Unlocks:** nothing else depends on it
> Only the `- [ ]` checkboxes under **Tasks** become cards when this file is imported as a plan; everything else is context.

## Why

On a hard card the first attempt is often not the best one, and the only way to get a second today is Retry fresh — sequential, and it throws the first attempt away. Variants run the same card **N times in parallel**, each in its own worktree, show the diffs side by side, and let the human keep one.

**Why it is last:** it multiplies cost. The token audit (memory *token-audit-findings*) puts one session at roughly **$3.67**, almost all of it cache reads — ×3 is ~$11 per card before any retries, and three sessions also burn the usage limit three times faster. Every other F-feature makes the tool more useful per session; this one buys quality with more sessions. Keep it small, opt-in per card, and invisible at ×1.

## What we have today

- **One run per card** is enforced by `RunRefusal 'already-running'` (`packages/shared/src/scheduler.ts`) — two agents must never share a worktree. Variants must keep that true **per row**, not weaken it.
- Worktrees are keyed by task id: `taskBranch(taskId)` and `WorktreeManager.prepare/inspect/cleanup` in `apps/client/src/main/worktreeManager.ts`. `inspect` already resolves through an **owner task id** (steps run in their parent's worktree), and `cleanup` sweeps the `-2`…`-10` fall-forward slots (memory *a-step-added-after-the-merge*).
- Parallelism: `Project.concurrency` (`packages/shared/src/model.ts:219`), seeded from `AppSettings.concurrency`.
- Steps use `Task.parentTaskId` and run **sequentially** as a chain — so variants must *not* be modelled as steps.
- Board rules (memory *card-state-is-the-humans*): an agent run never moves a card; the run borrows `status` and `preRunStatus` remembers the human's column; `isBoardCard` = Personal board and no `parentTaskId`.
- Archiving exists (`Task.archivedAt`, `TaskArchiveReason`).
- Merge/PR/auto-release act on a card's worktree; memory *a-merged-card-merges-again* is the warning that "is there work here?" must be a real git question, not an existence check.
- There is no in-app diff viewer yet — that is F6.

## Design

### Data model & contracts

- The human's card stays the **leader**. With ×N, the leader itself does **not** run; the engine creates N hidden **variant rows**: `Task.variantOf: string | null` (leader id) and `Task.variantLabel: 'A' | 'B' | 'C' | null`. Each row has its own id → its own worktree, branch and session, so `already-running` keeps meaning exactly what it means today.
- Leader gains `Task.pickedVariantId: string | null`. Before a pick the leader has no work of its own; after it, every "where is this card's work" question (inspect, merge, PR, auto-release) resolves through `pickedVariantId` — the same owner-id indirection steps already use.
- `TaskArchiveReason` gains `'variant-discarded'`.
- IPC (all `relay`): `task:startVariants(leaderId, count: 2 | 3, input: AssignAgentInput)`, `variants:summary(leaderId)` → per variant `{ id, label, status, costUsd, diffStat: { files, added, removed }, summary }`, `variants:pick(leaderId, variantId)`.
- Store migration adds the three columns (cover it with the recipe in *the-store-has-no-tests*).

### Engine / main process

- `startVariants`: validates the leader (board card, not a step, not running, has an agent project), creates N rows copying title/description/attachments/agent settings, appends the fixed hint for B and C, and enqueues them through the normal scheduler path so `concurrency`, the limit gate and the sign-in gate all apply unchanged (a park is still a park).
- The leader's displayed run state is derived (`variantGroupState(leader, rows)`): running if any row runs, waiting if any waits for input, done when all have settled — but the leader's own `status` is the human's and is never written by this (card-state rule).
- `pick`: stop any live loser, `cleanup` each loser's worktree (all slots), archive with `'variant-discarded'`, set `pickedVariantId`, and add a timeline note "picked B of 3". Idempotent: picking again with the same id is a no-op; picking a different one after a merge is refused.
- Merge / PR / auto-release on a leader without a pick are refused with a clear message ("pick a variant first"); chains waiting on the leader wait as they would on any unfinished card.

### Server & sync

- The three new columns ride the existing mirrored task shape in `packages/protocol`; the web needs `variantOf` to hide rows and group the tile. The new channels relay over the existing `ipc-invoke` kind — no server code.

### UI — desktop

- **Assign agent** gains a `×1 ×2 ×3` segmented control (default ×1, the control is the whole UI). ×2/×3 calls `task:startVariants` instead of `task:assignAgent`.
- **Board**: variant rows are never drawn as cards (filtered by `variantOf`); the leader tile shows a small "×3" badge with a per-variant status strip (monochrome per *board-colour-budget*; only the moving state gets colour).
- **Compare view** in the task detail pane: one column per variant — label, status, cost, files/+/−, one-line summary (first lines of the run's final message), **Pick**; below, F6's diff viewer per variant, collapsible.

### UI — web

- Same compare view from `packages/ui`; Pick relays. Starting variants from the web is allowed (the channel relays) — the desktop does the work.

### Failure modes & edge cases

- **A variant fails**: it stays in the compare view as failed (pickable only if it produced a diff); Retry on a variant retries that row only.
- **All variants fail**: the leader shows failed; the human can pick nothing and Retry fresh starts a new group.
- **Limit hits mid-group**: running rows park individually and resume at the reset; nothing special.
- **App restart mid-group**: rows are ordinary tasks, so the scheduler's existing recovery applies; the group is recomputed from `variantOf`.
- **Loser worktree undeletable** (Windows lock under `node_modules`): cleanup logs it on the leader's timeline and leaves the inert directory, as *a-step-added-after-the-merge* already does; the pick still succeeds.
- **Leader deleted while variants run**: stop and clean up all rows first (delete is already refused mid-run).
- **Concurrency 1**: variants run one after another — correct, just slow; the dialog says so when `concurrency < count`.
- **Cost surprise**: the ×N control shows "≈ N sessions" next to it.

## Out of scope (v1)

- An AI judge that ranks variants.
- Combining hunks from several variants.
- Variants on different models or different agents (easy later: the hint becomes a model choice).
- More than 3 variants.
- Variants for steps of a chain.

## Open questions

1. **Should the leader run as variant A instead of staying idle?** Saves one row, but then the human's card *is* a run, and a pick of B would have to move B's worktree under A's id. *Recommended default:* the leader never runs; all N are rows.
2. **Diversification hints or identical prompts?** Identical prompts on the same model often converge. *Recommended default:* fixed diversification hints for B/C, revisited after the live check in F10.7.
3. **Is this worth building at all?** *Recommended default:* defer until F6 ships, then decide from real usage — if Retry fresh is rarely pressed, drop F10.

## Tasks

### F10 · Phase 1 — Variant rows

- [ ] F10.1 Add variant fields to Task with a store migration and keep variant rows off the board

  - `packages/shared/src/model.ts`: `variantOf`, `variantLabel`, `pickedVariantId`, archive reason `'variant-discarded'`; migration in `apps/client/src/main/store.ts`; protocol task shape; board selectors in `packages/shared/src/board.ts` drop rows with `variantOf`.
  - Acceptance: board selector tests (variant rows never become cards, the leader does); migration covered by the drop-column recipe from *the-store-has-no-tests*. Gates `pnpm typecheck`, `pnpm test`, `pnpm build` green.
- [ ] F10.2 Add the pure variant planner and the derived group state

  - `packages/shared/src/variants.ts`: `planVariants(leader, count, input)` → N row drafts (labels, hints for B/C, copied attachments/agent settings); `variantGroupState(leader, rows)`; `canStartVariants(leader)` with the same refusals vocabulary as `RunRefusal`.
  - Acceptance: tests — step and running leader refused; ×2 yields A,B with one hint; group state running/waiting/done/failed combinations; leader status never part of the output. Gates green.
- [ ] F10.3 Start variants from Assign agent with a count control in the engine @needs: F10.1 Add variant fields to Task with a store migration and keep variant rows off the board, F10.2 Add the pure variant planner and the derived group state

  - `task:startVariants` channel (relay) in `packages/shared/src/ipc.ts` + `ipcRelay.ts`; handler in `apps/client/src/main/ipc.ts` creates rows and enqueues them through the normal scheduler path; `×1 ×2 ×3` segmented control in `packages/ui/src/AssignAgentDialog.tsx` with the "≈ N sessions" note.
  - Acceptance: engine test — ×3 with `concurrency` 2 runs two and queues one; each row prepares its own worktree path; a limit park parks rows individually. Gates green.

### F10 · Phase 2 — Compare and pick

- [ ] F10.4 Add the variant summary channel with status cost and diffstat per variant @needs: F10.3 Start variants from Assign agent with a count control in the engine

  - `variants:summary` reads each row's status, recorded cost, `git diff --stat` against the base in its worktree (through `WorktreeManager.inspect`), and the run's final-message first line.
  - Acceptance: tests with a scratch repo per *headless-scenario-harness-traps* — diffstat matches, a failed row with no diff reports zero files, result stays under the relay result cap. Gates green.
- [ ] F10.5 Build the variants compare view on top of the F6 diff viewer @needs: F10.4 Add the variant summary channel with status cost and diffstat per variant

  - Requires F6. Columns per variant in the task detail pane (`packages/ui`), Pick buttons, collapsible full diffs; leader tile badge + status strip on the board.
  - Acceptance: pure `compareColumns(summary)` tested (ordering, pickable only with a diff, failed label); component is wiring only. Gates green.
- [ ] F10.6 Pick a variant and discard the losing runs and worktrees @needs: F10.4 Add the variant summary channel with status cost and diffstat per variant

  - `variants:pick`: stop live losers, `cleanup` all their slots, archive `'variant-discarded'`, set `pickedVariantId`, timeline note; merge/PR/auto-release resolve the leader's work through `pickedVariantId` and refuse before a pick.
  - Acceptance: tests — exactly one worktree/branch survives; pick is idempotent; re-pick after merge refused; merging an unpicked leader refused with the "pick a variant first" message; an undeletable loser directory is logged, not fatal. Gates green.
- [ ] F10.7 Verify a three-variant run end to end with the stub CLI harness @needs: F10.6 Pick a variant and discard the losing runs and worktrees

  - `scripts/verify-variants.mjs` using *stub-claude-on-path*: the stub writes a different file per variant; start ×3 → summary → pick B → merge; prove the script can fail by mutation (per *a-cached-gate-is-not-a-gate*). Note that a live check with the real CLI (do the hints produce different approaches?) is owed to a human.
  - Acceptance: the script passes, and fails when the pick's cleanup is disabled. Gates green.
