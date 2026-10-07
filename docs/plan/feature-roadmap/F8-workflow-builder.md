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
  with `retryFrom` resolved to the target step's task id), `Task.workflowId`, `Task.gateAttempts`.
  Editing a workflow later never changes cards it was already applied to.

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

- [ ] F8.5 Run a gate command in the card's worktree through the exec host @needs: F8.2 Decide gate outcomes with a pure function covering every branch

  - `apps/client/src/main/gateRunner.ts`: shell per target, cwd existence check, timeout with `terminate()`, bounded tail, typed result.
  - Acceptance: `gateRunner.test.ts` with a fake `ExecHost`: exit codes, timeout kills, missing cwd, spawn error — each returns a result, none throws.

- [ ] F8.6 Dispatch gate steps from the step chain and loop failures back to the agent step @needs: F8.3 Turn a workflow into a card's step rows with a pure instantiator, F8.4 Store workflows and per-step specs in the desktop store, F8.5 Run a gate command in the card's worktree through the exec host

  - `scheduler.ts` `advanceSubtasks` dispatches by kind; gates bypass limit/auth parks; retry resets steps and sets `failureNote`; fail raises the inbox item with Run again / Send back / Skip; Stop terminates; boot reconcile; every outcome writes a status. Keep the logic in a deps-injected `gateStep.ts` so it is testable without the scheduler.
  - Acceptance: `gateStep.test.ts`; `scripts/verify-workflow-gates.mjs` with a stub `claude` on PATH drives fail → loop back → pass end-to-end and is shown to fail when the reset is removed (prove red before green).

- [ ] F8.7 Apply a workflow to a card over IPC with typed refusals @needs: F8.6 Dispatch gate steps from the step chain and loop failures back to the agent step

  - Channels for workflow CRUD/import/export and `workflow:apply` with refusals (`unfinished-steps`, `is-step`, `no-project`, `invalid`); relay registration.
  - Acceptance: handler tests per refusal; `test/ipc-relay-coverage.test.ts` passes.

- [ ] F8.8 Require a desktop to trust a gate command before it first runs @needs: F8.6 Dispatch gate steps from the step chain and loop failures back to the agent step

  - Machine-local trusted-hash set (local settings key, never in `GLOBAL_SETTINGS_KEYS`); untrusted gate parks as an inbox item; Trust and run / Decline.
  - Acceptance: tests that an edited command is untrusted again, that the key is classified local by the settings guard, and that a declined gate writes `failed` with the reason.

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
