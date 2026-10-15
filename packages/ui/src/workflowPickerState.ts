/**
 * The workflow picker's pure state (F8.11), shared by the assign dialog and the agent panel —
 * same shape as `skillPickerState.ts`. No React: a row list, a selection reconciler, a refusal
 * predictor and an outcome mapper, each a pure transform the two surfaces drive their own
 * rendering from.
 *
 * `predictApplyRefusal` only predicts what is knowable before a workflow is even chosen —
 * `is-step`, `no-project`, `unfinished-steps` — never `invalid` or `chain-full`, which depend
 * on the workflow document itself. Both it and `applyOutcome` read their sentences off
 * `WORKFLOW_APPLY_REFUSAL_MESSAGE` (`@tm/shared/workflow`), so a predicted refusal and the one
 * `workflow:apply` actually returns can never contradict each other in a way the human sees as
 * a lie — same posture `taskChat.ts`'s `chatAvailability` takes for a chat send.
 */
import type { Task } from '@tm/shared/model';
import {
  WORKFLOW_APPLY_REFUSAL_MESSAGE,
  type WorkflowApplyResult,
  type WorkflowDoc,
} from '@tm/shared/workflow';

/** One row the picker lists: a workflow's id, name and step count. */
export interface WorkflowOption {
  id: string;
  name: string;
  caption: string;
}

/** `docs`, sorted by name — the picker's row order. */
export function workflowOptions(docs: WorkflowDoc[]): WorkflowOption[] {
  return docs
    .map((doc): WorkflowOption => ({
      id: doc.id,
      name: doc.name,
      caption: `${doc.steps.length} step${doc.steps.length === 1 ? '' : 's'}`,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * `selectedId` if it still names one of `docs`, else `null` — what a picker's selection
 * becomes after a reload (e.g. a workflow was deleted out from under an open dialog).
 */
export function reconcileSelection(selectedId: string | null, docs: WorkflowDoc[]): string | null {
  return docs.some((doc) => doc.id === selectedId) ? selectedId : null;
}

/** The task fields {@link predictApplyRefusal} reads. */
export type WorkflowApplyTarget = Pick<Task, 'parentTaskId' | 'agentProjectId'>;

/** The three refusals {@link predictApplyRefusal} can predict — the ones knowable without the
 *  workflow document itself. `invalid` and `chain-full` need the document, so only
 *  `workflow:apply` itself can tell those apart. */
export type PredictedApplyRefusal = 'is-step' | 'no-project' | 'unfinished-steps';

/**
 * The refusal `workflow:apply` would certainly return for `task`, given `subtasks` (the
 * card's current steps) and `agentProjectId` (the dialog's chosen project, if any, over the
 * task's own) — or `null` when nothing knowable yet rules it out.
 *
 * Checked in the same order `workflow:apply` checks them: a step is refused before a project
 * is even considered, and a missing project before the existing steps are.
 */
export function predictApplyRefusal(
  task: WorkflowApplyTarget,
  subtasks: Pick<Task, 'status'>[],
  agentProjectId: string | null,
): PredictedApplyRefusal | null {
  if (task.parentTaskId) return 'is-step';
  if (!(agentProjectId || task.agentProjectId)) return 'no-project';
  if (subtasks.some((step) => step.status !== 'done' && step.status !== 'cancelled')) {
    return 'unfinished-steps';
  }
  return null;
}

/** What applying a workflow produced, for the picker to show: a step count on success, or the
 *  refusal's sentence (and, for `'invalid'`, its issues) on refusal. */
export type ApplyOutcome =
  { kind: 'applied'; stepCount: number } | { kind: 'refused'; sentence: string; issues?: string[] };

/** `workflow:apply`'s result, reduced to what the picker shows. */
export function applyOutcome(result: WorkflowApplyResult): ApplyOutcome {
  if (result.ok) return { kind: 'applied', stepCount: result.steps.length };
  const sentence = WORKFLOW_APPLY_REFUSAL_MESSAGE[result.reason];
  return result.issues
    ? { kind: 'refused', sentence, issues: result.issues }
    : { kind: 'refused', sentence };
}
