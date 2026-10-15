/**
 * `workflowPickerState.ts`'s pure state: option building/sorting, selection reconciliation, the
 * refusal predictor, and the apply outcome mapper.
 */
import { describe, expect, it } from 'vitest';
import type { Task } from '@tm/shared/model';
import {
  WORKFLOW_APPLY_REFUSAL_MESSAGE,
  type WorkflowApplyResult,
  type WorkflowDoc,
} from '@tm/shared/workflow';
import {
  applyOutcome,
  predictApplyRefusal,
  reconcileSelection,
  workflowOptions,
} from './workflowPickerState';

const doc = (over: Partial<WorkflowDoc> = {}): WorkflowDoc => ({
  version: 1,
  id: 'wf-1',
  name: 'Implement + test gate',
  steps: [{ id: 'a1', kind: 'agent', title: 'Implement', brief: 'Do it.' }],
  ...over,
});

type ApplyTarget = Pick<Task, 'parentTaskId' | 'agentProjectId'>;

const task = (over: Partial<ApplyTarget> = {}): ApplyTarget => ({
  parentTaskId: null,
  agentProjectId: 'proj-1',
  ...over,
});

const step = (over: Partial<Pick<Task, 'status'>> = {}): Pick<Task, 'status'> => ({
  status: 'done',
  ...over,
});

describe('workflowOptions', () => {
  it('sorts by name and captions with the step count', () => {
    const options = workflowOptions([
      doc({
        id: 'wf-b',
        name: 'Zeta',
        steps: [{ id: 'a1', kind: 'agent', title: 't', brief: 'b' }],
      }),
      doc({
        id: 'wf-a',
        name: 'Alpha',
        steps: [
          { id: 'a1', kind: 'agent', title: 't', brief: 'b' },
          { id: 'a2', kind: 'agent', title: 't2', brief: 'b2' },
        ],
      }),
    ]);

    expect(options).toEqual([
      { id: 'wf-a', name: 'Alpha', caption: '2 steps' },
      { id: 'wf-b', name: 'Zeta', caption: '1 step' },
    ]);
  });

  it('is empty for no workflows', () => {
    expect(workflowOptions([])).toEqual([]);
  });
});

describe('reconcileSelection', () => {
  it('keeps the selection when the workflow still exists', () => {
    expect(reconcileSelection('wf-1', [doc({ id: 'wf-1' })])).toBe('wf-1');
  });

  it('clears the selection when the workflow was deleted', () => {
    expect(reconcileSelection('wf-1', [doc({ id: 'wf-2' })])).toBeNull();
  });

  it('stays null when nothing was selected', () => {
    expect(reconcileSelection(null, [doc({ id: 'wf-1' })])).toBeNull();
  });
});

describe('predictApplyRefusal', () => {
  it("predicts 'is-step' for a step rather than a card", () => {
    expect(predictApplyRefusal(task({ parentTaskId: 'parent-1' }), [], 'proj-1')).toBe('is-step');
  });

  it("predicts 'no-project' when the task and the dialog both name no project", () => {
    expect(predictApplyRefusal(task({ agentProjectId: null }), [], null)).toBe('no-project');
  });

  it("does not predict 'no-project' when the dialog's own choice supplies one", () => {
    expect(predictApplyRefusal(task({ agentProjectId: null }), [], 'proj-2')).toBeNull();
  });

  it("predicts 'unfinished-steps' for a pending step", () => {
    expect(predictApplyRefusal(task(), [step({ status: 'pending' })], 'proj-1')).toBe(
      'unfinished-steps',
    );
  });

  it("does not predict 'unfinished-steps' when every step is done or cancelled", () => {
    expect(
      predictApplyRefusal(
        task(),
        [step({ status: 'done' }), step({ status: 'cancelled' })],
        'proj-1',
      ),
    ).toBeNull();
  });

  it('predicts nothing when every knowable precondition passes', () => {
    expect(predictApplyRefusal(task(), [], 'proj-1')).toBeNull();
  });

  it('checks is-step before no-project', () => {
    expect(
      predictApplyRefusal(task({ parentTaskId: 'parent-1', agentProjectId: null }), [], null),
    ).toBe('is-step');
  });
});

describe('applyOutcome', () => {
  it('reports the fresh step count on success', () => {
    const result: WorkflowApplyResult = {
      ok: true,
      steps: [{}, {}] as unknown as Task[],
    };
    expect(applyOutcome(result)).toEqual({ kind: 'applied', stepCount: 2 });
  });

  it('reports a refusal sentence for a reason with no issues', () => {
    const result: WorkflowApplyResult = {
      ok: false,
      reason: 'is-step',
      message: WORKFLOW_APPLY_REFUSAL_MESSAGE['is-step'],
    };
    expect(applyOutcome(result)).toEqual({
      kind: 'refused',
      sentence: WORKFLOW_APPLY_REFUSAL_MESSAGE['is-step'],
    });
  });

  it("reports a refusal sentence for every other non-'invalid' reason", () => {
    for (const reason of ['no-project', 'unfinished-steps', 'chain-full'] as const) {
      const result: WorkflowApplyResult = {
        ok: false,
        reason,
        message: WORKFLOW_APPLY_REFUSAL_MESSAGE[reason],
      };
      expect(applyOutcome(result)).toEqual({
        kind: 'refused',
        sentence: WORKFLOW_APPLY_REFUSAL_MESSAGE[reason],
      });
    }
  });

  it("reports the sentence plus issues for 'invalid'", () => {
    const issues = ['A workflow needs at least one step.'];
    const result: WorkflowApplyResult = {
      ok: false,
      reason: 'invalid',
      message: WORKFLOW_APPLY_REFUSAL_MESSAGE.invalid,
      issues,
    };
    expect(applyOutcome(result)).toEqual({
      kind: 'refused',
      sentence: WORKFLOW_APPLY_REFUSAL_MESSAGE.invalid,
      issues,
    });
  });
});
