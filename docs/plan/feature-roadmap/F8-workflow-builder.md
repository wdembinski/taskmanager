# F8 — Workflow builder

> **Status:** proposed · **Where:** client + server + web · **Depends on:** F7 (skills, for the per-step skill picker) · **Unlocks:** F1 (an automation runs a workflow), Variants
> Only the `- [ ]` checkboxes under **Tasks** become cards when this file is imported as a plan; everything else is context.

## Why

Today a card's steps come from one place: an agent's approved plan (or a human typing them).
Every step is an agent session, and "is it actually done?" is answered only by the agent saying so
and, much later, by a human reviewing the branch. The process people repeat — _implement, run the
tests, if they fail send the agent back with the output, then review_ — cannot be written down once
and reused.

A **workflow** is that process as data: an ordered list of **agent steps** (a brief, optional skills,
model, mode) and **gate steps** (a shell command whose exit code decides; on failure, loop back to
an earlier agent step with the output, a bounded number of times). Built in a UI, saved, applied to
any card.

## What we have today

- `packages/shared/src/taskChain.ts` + `apps/client/src/main/chainRunner.ts` — the **chain of
  execution**: arrows _between cards_ with `after-merge`/`stacked` gates. Not the same thing as a
  card's own steps, and not what a workflow compiles into.
- `apps/client/src/main/planToSubtasks.ts` — an approved plan becomes **steps**: child tasks
  (`Task.parentTaskId`, `planRound`), each its own session, sharing the card's worktree and branch.
- `apps/client/src/main/scheduler.ts` — `advanceSubtasks` runs the next `pending` step, one at a
  time, parking it behind the limit/sign-in gates; `nextRunnableStep` makes Start honour hand-written
  steps; a failed step parks in the inbox and leaves its siblings pending; the orchestrator merges
  after the last step. Every rule learned the hard way (`hand-written-steps-were-bypassed`,
  `a-step-that-never-stops-running`, `limit-gate-is-the-only-memory`, `a-session-is-not-work`) lives
  on this path.
- `apps/client/src/main/agentTaskPrompt.ts` — `buildAgentSubtaskPrompt` already takes `failureNote`
  ("why the previous attempt failed") and "step N of M" orientation.
- `apps/client/src/main/exec/types.ts` — `ExecHost.exec/spawn` with `terminate()`, the same host the
  CLI runs on (Windows or WSL).
- `AppSettings.maxAutoRetries` — the existing AI-assisted retry budget for a failed run.
- `packages/ui/src/TaskSteps.tsx`, `TaskAgentPanel.tsx`, `AssignAgentDialog.tsx`, `ModelField.tsx` —
  where steps are shown and runs configured.
- No YAML, zod or drag-and-drop dependency anywhere in the repo.

## Design

### Data model & contracts

New pure module `packages/shared/src/workflow.ts`:

```ts
interface WorkflowDoc {
  version: 1;
  id: string;
  name: string;
  description?: string;
  steps: WorkflowStep[];
}
type WorkflowStep = AgentStep | GateStep;
interface AgentStep {
  id: string;
  kind: 'agent';
  title: string;
  brief: string;
  skillRefs?: string[]; // F7 refs
  model?: ClaudeModel | null; // null = follow the card/project ladder
  mode?: PermissionMode | null;
}
interface GateStep {
  id: string;
  kind: 'gate';
  title: string;
  command: string;
  timeoutSec?: number; // default 1200
  onFail?: { retryFrom: string; maxAttempts: number; retryOn?: number[] };
}
```

- `validateWorkflow(unknown)` → `{ ok: true, doc } | { ok: false, issues: string[] }`, hand-written
  (no schema library): unique ids, ≥1 step, ≤ `MAX_WORKFLOW_STEPS` (20), `retryFrom` names an
  **earlier agent** step, `maxAttempts` 1–5, `retryOn` positive integers (0 is an error, not a
  no-op), non-empty commands and titles. Issues are sentences.
- Storage: **app DB, JSON** — desktop `workflows` table holds the document; import/export as a
  `<name>.workflow.json` file. Chosen over YAML-in-repo because: no YAML dependency exists; the web
  must be able to build workflows; writing into a project's main checkout dirties the base branch,
  which blocks unrelated merges (`merge-only-moves-the-checked-out-branch`); and a validator over
  JSON round-trips losslessly. Repo-file discovery is an open question, not v1.
- Instantiated step: a normal step task plus `Task.stepSpec` (JSON snapshot of its `WorkflowStep`,
  with a gate's `onFail.retryFrom` resolved to `retryFromIndex` — a POSITION among the round's
  steps, not a task id, since no step has a task id yet at instantiation time. A retry resolves
  that position back to the actual sibling task AT RUN TIME, by position and step id together
  (`resolveRetryTarget`, grouped by `workflowId`/`planRound` and ordered by `order`)),
  `Task.workflowId`, `Task.gateAttempts`. Editing a workflow later never changes cards it was
  already applied to.

### Engine

**Compile into steps, not a new runtime.** Applying a workflow to a card writes one step task per
workflow step (a new `planRound`, so step folding works), exactly as an approved plan does. The only
engine change is in `advanceSubtasks`: the next pending step is dispatched **by kind**.

- **Agent step** → today's `startTask` path untouched. Its `brief` is the step description; its
  `skillRefs` feed F7's resolver; `model`/`mode` land on the step's `agentModel`/`agentMode`, so the
  model ladder applies unchanged. When the card has 2+ agent steps, the "step N of M — an earlier
  step's done is not yours" orientation goes into `buildAgentSubtaskPrompt`.
- **Gate step** → new `GateRunner` (`apps/client/src/main/gateRunner.ts`): runs `command` in the
  card's worktree through the project's `ExecHost` (`bash -lc` on WSL/Linux, `cmd.exe /d /s /c` on
  Windows), with a timeout that terminates the process tree; captures exit code and a bounded output
  tail (16 KiB to the timeline, 8 KiB for the failure note). No Claude session, so it **costs
  nothing and is not held by the usage-limit or sign-in gates** — but the agent step it loops back to
  is.
- Outcome is decided by a pure `decideGateOutcome({ exitCode, timedOut, attemptsUsed, onFail })`:
  - exit 0 → `pass`: step `done`, `advanceSubtasks`.
  - non-zero, `onFail` present, code retryable (`retryOn` empty = any), attempts left → `retry`:
    `gateAttempts++`, every step from `retryFrom` through the gate goes back to `pending`, the target
    step's `failureNote` = the output tail, timeline note "tests failed — sending step 2 back (attempt
    2/3)", `advanceSubtasks`.
  - otherwise → `fail`: gate step `failed`, an inbox item naming the command, exit code and reason
    (non-retryable code / attempts exhausted / timeout), siblings left pending — the chain's existing
    contract. Inbox actions: **Run gate again**, **Send back to agent** (one more loop), **Skip gate**.
- **Every outcome writes a status** (the rule from `a-step-that-never-stops-running`), including
  stop, timeout and spawn errors.
- **Stop** on the card terminates a running gate and marks the step `stopped`.
- **Boot reconcile**: a gate step found `running` with no process is re-run once, with a timeline
  note — a gate is a check, re-running it is safe; an agent step keeps today's behaviour.
- The merge after the last step is unchanged; a final gate is therefore a pre-merge gate.
- A timeout is treated as non-retryable by default (an infrastructure fact, not a defect in the diff).

### Server & sync

- Desktop SQLite is the source of truth; workflows mirror through a dedicated endpoint
  (`GET /v1/workflows`, `PUT/DELETE /v1/workflows/:id`, 64 KiB cap), pushed only when changed — never
  inside `SyncRequest` (`one-answer-wedges-the-mirror`).
- A card's steps already mirror; `stepSpec` kind and `gateAttempts` ride the task mirror so the web
  can draw gate steps. Gate output stays in the timeline, which already mirrors.
- Both fields are plain `Task` fields, so they ride the existing whole-`Task` mirror
  (`buildMirrorDelta`, `TaskMirror.data`) with no `MirrorDelta` shape change and no
  `PROTOCOL_VERSION` bump — confirmed by a round-trip test on each side (`cloudDelta.test.ts`,
  `mirror.service.test.ts`), not a new field added for this ticket.
- **Command trust is local.** A gate command is arbitrary shell run unattended, and a workflow can be
  authored on the web. So each desktop keeps its own set of trusted command hashes (machine-local,
  never synced); the first time an untrusted command would run, the gate parks as an inbox item
  "Trust and run `<command>`?" instead of executing. A cloud account compromise therefore cannot run
  code on a desktop without a human at that desktop.

### UI — desktop

- **Workflows** screen (Settings → Workflows in v1): list, New, Duplicate, Delete, Import, Export.
- **Builder**: a vertical list of step cards; "Add agent step" / "Add gate step"; reorder by
  move-up/move-down buttons plus native HTML drag (no new dependency); a step editor — agent: title,
  brief, F7 skill picker, `ModelField`, mode; gate: title, command, timeout, _retry from_ (a select
  limited to earlier agent steps), max attempts, retry-on codes. Validation issues inline, Save
  disabled until clean; a read-only JSON preview with Copy.
- **Apply workflow…** in `AssignAgentDialog` (instead of "plan first") and `TaskAgentPanel`; a
  refusal names its reason.
- **Steps list** (`TaskSteps.tsx`): a gate step shows a terminal icon (real Fluent icon, monochrome —
  colour only for what moves), its status, an "attempt 2/3" chip, and an expander with the last
  output tail.
- Pure `workflowBuilderState.ts` and a gate-step view model, tested like `taskTimeline.ts`.

### UI — web

The builder and Apply are the shared `@tm/ui` components; writes are relay commands to the desktop.
Trust prompts appear only on the desktop; the web shows "waiting for <desktop> to trust this
command".

### Failure modes & edge cases

- **Applied to a card that still has unfinished steps** → refused ("finish or remove the current
  steps first"); applied to a step → refused; card with no agent project → refused (`no-project`).
- **`retryFrom` step deleted by hand after applying** → the gate fails with a note naming the missing
  step rather than looping into nothing.
- **Human reorders steps after applying** → allowed; the resolved task id still targets the right
  step; a target now _after_ the gate makes the gate fail with that reason.
- **Worktree path missing** → `spawn … ENOENT` is a bad cwd (`spawn-enoent-is-a-bad-cwd`); checked
  before spawning, failing with "the card's worktree no longer exists".
- **Gate leaves the tree dirty** (generated files) → noted on the timeline after the gate; nothing is
  cleaned automatically.
- **Hanging command / huge output** → timeout + bounded tail.
- **Chat on a card mid-workflow** → the existing `chain-busy` refusal holds.
- **Usage limit during a loop-back** → the agent step parks in the limit gate as any step does; the
  gate attempt counter is persisted, so the reset resumes at the right attempt.

## Out of scope (v1)

- Branching, parallel or conditional steps (linear only).
- Workflow files discovered from the repo.
- A plan step inside a workflow (a workflow replaces "plan first", it does not contain it).
- Per-step tool allowlists.
- Running a workflow without a card (that is F1's automations).

## Open questions

- **Should repo files (`.vipper/workflows/*.workflow.json`) be discovered read-only?** Default: not
  in v1; export/import covers sharing.
- **Should a gate count against `maxAutoRetries`?** Default: no — gate attempts are their own budget
  per gate.
- **Default timeout?** Default: 20 minutes, editable per gate.
- **Should starter workflows ship?** Default: yes, two ("Implement + test gate", "Implement → review →
  test gate"), trusted only after first confirmation like any other command.

## Tasks

### F8 · Phase 1 — Workflow model

- [ ] F8.1 Define the workflow document types and validator in shared

  - New `packages/shared/src/workflow.ts`: `WorkflowDoc`, `AgentStep`, `GateStep`, `validateWorkflow`, `MAX_WORKFLOW_STEPS`, `isGateStep`.
  - Acceptance: `workflow.test.ts` covers every issue (duplicate id, forward/self/gate `retryFrom`, retryOn 0, empty command, too many steps) and a valid round-trip through JSON.

- [ ] F8.2 Decide gate outcomes with a pure function covering every branch @needs: F8.1 Define the workflow document types and validator in shared

  - `decideGateOutcome` + `boundOutputTail` in `packages/shared/src/workflow.ts` (or `gateOutcome.ts`).
  - Acceptance: table-driven tests for pass, retry (any code / listed code), non-retryable code, attempts exhausted, timeout, no `onFail`.

- [ ] F8.3 Turn a workflow into a card's step rows with a pure instantiator @needs: F8.1 Define the workflow document types and validator in shared

  - `instantiateWorkflow(doc, card, round)` → step drafts with `stepSpec`, `retryFrom` resolved by position, agent `model`/`mode`/`skillRefs` mapped, "step N of M" counts.
  - Acceptance: tests for a mixed workflow, a gate-first workflow, and that the drafts carry a snapshot (mutating the doc afterwards changes nothing).

### F8 · Phase 2 — Engine

- [ ] F8.4 Store workflows and per-step specs in the desktop store @needs: F8.1 Define the workflow document types and validator in shared

  - `store.ts`: `CREATE TABLE workflows`; `ALTER TABLE tasks ADD` `step_spec`, `workflow_id`, `gate_attempts`; CRUD.
  - Acceptance: `scripts/verify-workflow-migration.mjs` (drop-column + `ELECTRON_RUN_AS_NODE` recipe) proves fresh and upgraded DBs, and fails when an ALTER is removed.

- [x] F8.5 Run a gate command in the card's worktree through the exec host @needs: F8.2 Decide gate outcomes with a pure function covering every branch

  - `apps/client/src/main/gateRunner.ts`: shell per target, cwd existence check, timeout with `terminate()`, bounded tail, typed result.
  - Acceptance: `gateRunner.test.ts` with a fake `ExecHost`: exit codes, timeout kills, missing cwd, spawn error — each returns a result, none throws.

- [x] F8.6 Dispatch gate steps from the step chain and loop failures back to the agent step @needs: F8.3 Turn a workflow into a card's step rows with a pure instantiator, F8.4 Store workflows and per-step specs in the desktop store, F8.5 Run a gate command in the card's worktree through the exec host

  - `scheduler.ts` `advanceSubtasks` dispatches by kind; gates bypass limit/auth parks; retry resets steps and sets `failureNote`; fail raises the inbox item with Run again / Send back / Skip; Stop terminates; boot reconcile; every outcome writes a status. Keep the logic in a deps-injected `gateStep.ts` so it is testable without the scheduler.
  - Acceptance: `gateStep.test.ts`; `scripts/verify-workflow-gates.mjs` with a stub `claude` on PATH drives fail → loop back → pass end-to-end and is shown to fail when the reset is removed (prove red before green).

- [ ] F8.7 Apply a workflow to a card over IPC with typed refusals @needs: F8.6 Dispatch gate steps from the step chain and loop failures back to the agent step

  - Channels for workflow CRUD/import/export and `workflow:apply` with refusals (`unfinished-steps`, `is-step`, `no-project`, `invalid`); relay registration.
  - Acceptance: handler tests per refusal; `test/ipc-relay-coverage.test.ts` passes.

- [x] F8.8 Require a desktop to trust a gate command before it first runs @needs: F8.6 Dispatch gate steps from the step chain and loop failures back to the agent step

  - Setting: `AppSettings.trustedGateCommands: string[]` (SHA-256 hex of the exact command
    string), default `[]`, kept OUT of `GLOBAL_SETTINGS_KEYS` (`packages/shared/src/settings.ts:1051`)
    and added instead to `settings.test.ts`'s `LOCAL_SETTINGS_KEYS` — its doc comment says why it is
    local (a workflow can be authored on the web; trust is a fact about ONE desktop) and that only
    `gate:trust` ever writes it.
  - Hashing lives in the main process (`node:crypto`'s `createHash('sha256')`, the same primitive
    `review/diffService.ts:computeDiffId` already uses, full hex digest here rather than a sliced
    one): new `apps/client/src/main/gateTrust.ts` — `gateCommandHash(command): string`,
    `isCommandTrusted(trusted, command): boolean`, `withTrustedHash(trusted, hash): string[]`
    (dedup, order-preserving). Hashing the exact bytes means any edit, even whitespace, makes the
    command untrusted again — there is deliberately no normalisation.
  - Shared constant: `GATE_TRUST_ACTION = { trust: 'Trust and run', decline: 'Decline' }` in
    `packages/shared/src/workflow.ts`, next to `GateStep`/`decideGateOutcome`. Both the main process
    and `packages/ui` match on this text instead of each hand-writing it.
  - Engine (`apps/client/src/main/gateStep.ts`): `GateStepDeps` gains `isTrusted(command): boolean`
    and `raiseTrust(task, command): void`. `GateStepRunner.start()` (currently: guard on
    `this.running`, reserve `'starting'`, `setStatus('running')`, THEN `prepare()`) checks trust
    FIRST, before any of that — untrusted calls `raiseTrust` and returns without touching `running`
    or the task's status. Every path that reaches a gate's `start()` — `advanceSubtasks`, `requeue`,
    "Run gate again", boot `reconcile`, and a limit/sign-in resume — goes through this one check, so
    none of them needs its own trust gate.
  - Scheduler (`apps/client/src/main/scheduler.ts`):
    - `PendingFailure.kind` (line ~1077: `'run' | 'integration' | 'pull-request' | 'gate'`) gains
      `'gate-trust'`, plus an optional `commandHash` — the hash of the command the human was SHOWN,
      so a later edit to the step can't silently trust something else. `failureActionsFor('gate-trust')`
      returns `[GATE_TRUST_ACTION.trust, GATE_TRUST_ACTION.decline]`.
    - `raiseGateTrust` is `raiseTaskFailed`'s inbox persistence (the `AttentionItem` carries
      `kind: 'task-failed'`, same as today's gate failures; `pendingFailures.set` + `store.saveAttention`)
      with its own prompt — "Trust and run `<command>` on this desktop?" — and timeline note. Status
      `waiting-input`, so `rehydrateAttention` restores it after a restart exactly as a parked gate
      failure already does.
    - `applyFailureChoice` grows two cases for `f.kind === 'gate-trust'`:
      - `GATE_TRUST_ACTION.decline` → gate `failed`, timeline note "Declined to trust `<command>` on
        this desktop — the gate did not run." Siblings stay `pending` — the chain's existing
        failure contract, unchanged.
      - `GATE_TRUST_ACTION.trust` arriving through this path (i.e. via `attention:answer`, not the
        dedicated channel below — a relay hop or a stale UI) is REFUSED: re-park the same ask
        (`raiseTaskFailed(f)`, the same fallback the `default:` branch already uses for an
        unrecognised answer) with a note that trust must be granted at the desktop. Trust is never
        granted off this path.
    - New public `trustGateCommand(itemId: string): void`: find the `gate-trust` pending failure,
      `store.saveSettings` the trusted set with `withTrustedHash(trusted, f.commandHash)`, resolve
      the attention item, add a "Trusted on this desktop" timeline note, then set the gate `pending`
      and `advanceSubtasks` — the same ending `FAILURE_ACTION.runGateAgain` already uses. Routing
      back through `start()` means an edited command re-checks `isTrusted` on the CURRENT command and
      parks again if it no longer matches `commandHash` — trust never silently extends to a command
      nobody saw.
  - IPC: `'gate:trust': (itemId: string) => Promise<void>` in `packages/shared/src/ipc.ts`, next to
    `'attention:answer'`. Classified `host-only` in `packages/shared/src/ipcRelay.ts`'s
    `HOST_ONLY_REASONS`/`RELAY_POLICY` under a new `HostOnlyReason`, `'trust-grant'`, with
    `REASON_TEXT['trust-grant']` = "it lets that machine run a command, which only someone at that
    machine can allow" — the same shape as the existing `credential-write`/`live-session` reasons, not
    a one-off special case. Handler in `apps/client/src/main/ipc.ts` (next to the `'attention:answer'`
    handler at line 1758) calls `scheduler.trustGateCommand(itemId)`.
  - UI (`packages/ui`): a pure helper `attentionAnswerCall(id, answer)` returns `['gate:trust', id]`
    when `answer` is a `reply` carrying `GATE_TRUST_ACTION.trust`, and `['attention:answer', id, answer]`
    otherwise. Its three current direct callers of `transport.invoke('attention:answer', …)` —
    `Attention.tsx`'s `useAttentionItems.answer` (line 388), `CompactInbox.tsx`'s `answer` (line 182)
    and `TaskAgentPanel.tsx`'s `answer` (line 513) — call through it instead, each spreading the
    tuple into `transport.invoke(...)`. On the web, `httpTransport.ts`'s existing host-only refusal
    (`hostOnlyMessage`) already shows a message for any host-only channel, so `gate:trust` needs no
    new web-side branch. The web's "waiting for `<desktop>`" wording is F8.13's, not this step's.
  - Acceptance: `gateTrust.test.ts` — `gateCommandHash` is deterministic and whitespace-sensitive
    (one trailing space changes the hash), `isCommandTrusted`/`withTrustedHash` round-trip and dedup.
    `settings.test.ts` places `trustedGateCommands` in `LOCAL_SETTINGS_KEYS`, not
    `GLOBAL_SETTINGS_KEYS`. `gateStep.test.ts` covers an untrusted `start()` calling `raiseTrust`
    without reserving a running slot or writing `running`, and a trusted one proceeding exactly as
    today. `scheduler`/`gateStep` tests cover: decline writes `failed` with the reason and leaves
    siblings `pending`; trust via `trustGateCommand` adds the hash, resolves the item, and reruns the
    gate; trust arriving through `applyFailureChoice` (simulating `attention:answer`) is refused and
    re-parks the same ask; an edited command after a park is untrusted again on the next `start()`.
    `ipcRelay.test.ts` covers `gate:trust` as `host-only` with reason `trust-grant`.
    `scripts/verify-workflow-gates.mjs`'s Scenario C drives the whole thing against the real
    `Scheduler`: parks on an untrusted command without running it, `trustGateCommand` makes it
    really run and pass, an edit to the step's command (written straight to the store, the one
    piece of state it otherwise never patches post-instantiation) parks it again rather than
    inheriting the grant, and Decline fails it with the reason on the timeline — shown to fail
    when the trust check is removed (prove red before green).

### F8 · Phase 3 — Desktop UI

- [ ] F8.9 Build the workflow builder screen on a pure editor state machine @needs: F8.7 Apply a workflow to a card over IPC with typed refusals

  - `packages/ui`: `workflowBuilderState.ts` + `WorkflowBuilder.tsx` (step cards, add/reorder/remove, editors, inline issues, JSON preview/copy, import/export); uses F7's skill picker and `ModelField`; Settings → Workflows.
  - Acceptance: state-machine tests (reorder keeps `retryFrom` valid or flags it, Save disabled with issues, import of an invalid file lists issues); `pnpm build` green.

- [ ] F8.10 Show gate steps with attempts and output on a card's steps list @needs: F8.6 Dispatch gate steps from the step chain and loop failures back to the agent step

  - `TaskSteps.tsx` gate row: Fluent terminal icon, status, attempt chip, output expander; pure view model.
  - Acceptance: view-model tests for pending/running/passed/failed/awaiting-trust; monochrome except status.

- [ ] F8.11 Offer Apply workflow from the assign dialog and the agent panel @needs: F8.7 Apply a workflow to a card over IPC with typed refusals, F8.9 Build the workflow builder screen on a pure editor state machine

  - Workflow picker in `AssignAgentDialog` and `TaskAgentPanel`; refusal sentences from one map.
  - Acceptance: tests for the picker's state and that each refusal maps to a sentence.

### F8 · Phase 4 — Cloud and web

- [ ] F8.12 Mirror workflows to the cloud through a dedicated bounded endpoint @needs: F8.4 Store workflows and per-step specs in the desktop store

  - Server entity + migration + controller (`GET /v1/workflows`, `PUT/DELETE /v1/workflows/:id`, 64 KiB cap); desktop pusher (changed-only); `stepSpec` kind and `gateAttempts` on the task mirror.
  - Acceptance: controller tests (auth, cap, tombstone); pusher test for no re-send; `nest build` emits.

- [ ] F8.13 Build and apply workflows from the web client @needs: F8.12 Mirror workflows to the cloud through a dedicated bounded endpoint, F8.9 Build the workflow builder screen on a pure editor state machine, F8.11 Offer Apply workflow from the assign dialog and the agent panel

  - `apps/web`: Workflows settings section, relay writes and apply, gate rows on steps, "waiting for <desktop> to trust" state.
  - Acceptance: `test/shell-parity.test.ts` and settings section tests pass; a relayed apply creates steps on the desktop (transport test).

- [ ] F8.14 Ship two starter workflows and document the builder @needs: F8.13 Build and apply workflows from the web client

  - Seed "Implement + test gate" and "Implement → review → test gate"; `docs/03-how-orchestration-works.md` (steps vs chain arrows vs workflows, gates, trust), glossary entries.
  - Acceptance: starters validate with `validateWorkflow`; docs match behaviour; formatter clean.
