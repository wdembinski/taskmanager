import { describe, expect, it } from 'vitest';
import type { AgentStep, GateStep, WorkflowDoc } from '@tm/shared/workflow';
import {
  addStep,
  applyImportResult,
  applySaveResult,
  canSave,
  cancelPendingSelection,
  confirmPendingSelection,
  duplicateWorkflow,
  editStep,
  editWorkflow,
  importFromText,
  isDirty,
  moveStep,
  nextStepId,
  openWorkflowBuilder,
  removeStep,
  retryFromOptions,
  selectWorkflow,
  setGateOnFail,
  setRetryOnText,
  setStepModel,
  startNew,
  stepIssues,
  workflowIssues,
  type WorkflowBuilderState,
} from './workflowBuilderState';

function agent(id: string, overrides: Partial<AgentStep> = {}): AgentStep {
  return { id, kind: 'agent', title: `Title ${id}`, brief: `Brief ${id}`, ...overrides };
}

function gate(id: string, overrides: Partial<GateStep> = {}): GateStep {
  return { id, kind: 'gate', title: `Title ${id}`, command: `echo ${id}`, ...overrides };
}

function doc(overrides: Partial<WorkflowDoc> = {}): WorkflowDoc {
  return {
    version: 1,
    id: 'w1',
    name: 'My workflow',
    steps: [agent('agent-1')],
    ...overrides,
  };
}

describe('reorder/remove semantics', () => {
  function chainDoc(): WorkflowDoc {
    return doc({
      steps: [
        agent('agent-1'),
        gate('gate-2', { onFail: { retryFrom: 'agent-1', maxAttempts: 1 } }),
        agent('agent-3'),
      ],
    });
  }

  function openChain(): WorkflowBuilderState {
    return selectWorkflow(openWorkflowBuilder([chainDoc()]), 'w1');
  }

  it('a move that keeps the target earlier leaves retryFrom intact with no issues', () => {
    const state = openChain();

    // [agent-1, gate-2, agent-3] -> [agent-1, agent-3, gate-2]; agent-1 is still before gate-2.
    const next = moveStep(state, 2, 1);

    const gateStep = next.draft?.steps.find((s) => s.id === 'gate-2') as GateStep;
    expect(gateStep.onFail?.retryFrom).toBe('agent-1');
    expect(stepIssues(next)['gate-2']).toBeUndefined();
    expect(workflowIssues(next)).toEqual([]);
  });

  it('moving the gate above its target keeps retryFrom and flags an issue', () => {
    const state = openChain();

    // [agent-1, gate-2, agent-3] -> [gate-2, agent-1, agent-3]
    const next = moveStep(state, 1, 0);

    const gateStep = next.draft?.steps.find((s) => s.id === 'gate-2') as GateStep;
    expect(gateStep.onFail?.retryFrom).toBe('agent-1');
    expect(stepIssues(next)['gate-2']).toBeDefined();
    expect(stepIssues(next)['gate-2'].length).toBeGreaterThan(0);
  });

  it('moving the target below the gate keeps retryFrom and flags an issue', () => {
    const state = openChain();

    // [agent-1, gate-2, agent-3] -> [gate-2, agent-3, agent-1]
    const next = moveStep(state, 0, 2);

    const gateStep = next.draft?.steps.find((s) => s.id === 'gate-2') as GateStep;
    expect(gateStep.onFail?.retryFrom).toBe('agent-1');
    expect(stepIssues(next)['gate-2']).toBeDefined();
  });

  it('removing the target flags the gate', () => {
    const state = openChain();

    const next = removeStep(state, 'agent-1');

    const gateStep = next.draft?.steps.find((s) => s.id === 'gate-2') as GateStep;
    expect(gateStep.onFail?.retryFrom).toBe('agent-1');
    expect(stepIssues(next)['gate-2']).toBeDefined();
  });

  it('moving the step back clears the issue', () => {
    const state = openChain();
    const broken = moveStep(state, 1, 0);
    expect(stepIssues(broken)['gate-2']).toBeDefined();

    const fixed = moveStep(broken, 0, 1);

    expect(stepIssues(fixed)['gate-2']).toBeUndefined();
    expect(workflowIssues(fixed)).toEqual([]);
  });
});

describe('canSave', () => {
  it('is false when the title is empty', () => {
    const state = startNew(openWorkflowBuilder([]));
    const edited = editWorkflow(state, { name: 'Valid name' });
    const titled = editStep(edited, 'agent-1', { title: '', brief: 'A brief' });

    expect(canSave(titled)).toBe(false);
  });

  it('is false when a gate command is empty', () => {
    const state = startNew(openWorkflowBuilder([]));
    const named = editWorkflow(state, { name: 'Valid name' });
    const withGate = addStep(named, 'gate');
    const edited = editStep(withGate, 'gate-2', { title: 'Gate', command: '' });

    expect(canSave(edited)).toBe(false);
  });

  it('is false when retry-on text does not parse', () => {
    const state = startNew(openWorkflowBuilder([]));
    const named = editWorkflow(state, { name: 'Valid name' });
    const withGate = addStep(named, 'gate');
    const gated = editStep(withGate, 'gate-2', { title: 'Gate', command: 'echo hi' });
    const withOnFail = setGateOnFail(gated, 'gate-2', { retryFrom: 'agent-1', maxAttempts: 1 });
    const bad = setRetryOnText(withOnFail, 'gate-2', '1, abc');

    expect(canSave(bad)).toBe(false);
  });

  it('is false when maxAttempts is 0', () => {
    const state = startNew(openWorkflowBuilder([]));
    const named = editWorkflow(state, { name: 'Valid name' });
    const withGate = addStep(named, 'gate');
    const gated = editStep(withGate, 'gate-2', { title: 'Gate', command: 'echo hi' });
    const withOnFail = setGateOnFail(gated, 'gate-2', { retryFrom: 'agent-1', maxAttempts: 0 });

    expect(canSave(withOnFail)).toBe(false);
  });

  it('is false when clean but not dirty', () => {
    const state = selectWorkflow(openWorkflowBuilder([doc()]), 'w1');

    expect(isDirty(state)).toBe(false);
    expect(canSave(state)).toBe(false);
  });

  it('is true when dirty and clean', () => {
    const state = selectWorkflow(openWorkflowBuilder([doc()]), 'w1');

    const next = editWorkflow(state, { name: 'Renamed' });

    expect(isDirty(next)).toBe(true);
    expect(canSave(next)).toBe(true);
  });
});

describe('applyImportResult', () => {
  it('invalid lists every issue', () => {
    const state = openWorkflowBuilder([]);

    const next = applyImportResult(state, {
      ok: false,
      reason: 'invalid',
      issues: ['Issue one.', 'Issue two.'],
    });

    expect(next.importIssues).toEqual(['Issue one.', 'Issue two.']);
  });

  it('null is a no-op', () => {
    const state = openWorkflowBuilder([]);

    const next = applyImportResult(state, null);

    expect(next).toBe(state);
  });

  it('ok upserts and selects the imported workflow', () => {
    const state = openWorkflowBuilder([]);
    const imported = doc({ id: 'imported-1', name: 'Imported' });

    const next = applyImportResult(state, { ok: true, workflow: imported });

    expect(next.library).toEqual([imported]);
    expect(next.selection).toEqual({ kind: 'library', id: 'imported-1' });
    expect(isDirty(next)).toBe(false);
  });
});

describe('importFromText', () => {
  it('lists a sentence on bad JSON', () => {
    const state = openWorkflowBuilder([]);

    const next = importFromText(state, '{not json');

    expect(next.importIssues).toHaveLength(1);
    expect(next.draft).toBeNull();
  });

  it('lists both problems on a doc with two', () => {
    const state = openWorkflowBuilder([]);
    const bad = { version: 1, id: '', name: '', steps: [agent('agent-1')] };

    const next = importFromText(state, JSON.stringify(bad));

    expect(next.importIssues).toEqual([
      'A workflow must have a non-empty id.',
      'A workflow must have a non-empty name.',
    ]);
  });

  it('opens a valid import as a dirty new draft with no id', () => {
    const state = openWorkflowBuilder([]);
    const imported = doc({ id: 'from-text', name: 'From text' });

    const next = importFromText(state, JSON.stringify(imported));

    expect(next.selection).toEqual({ kind: 'new' });
    expect(next.draft?.id).toBeUndefined();
    expect(next.draft?.name).toBe('From text');
    expect(isDirty(next)).toBe(true);
    expect(next.importIssues).toBeNull();
  });
});

describe('nextStepId', () => {
  it('is unique, counting up past existing ids', () => {
    const first = nextStepId([], 'agent');
    expect(first).toBe('agent-1');

    const steps = [agent('agent-1')];
    const second = nextStepId(steps, 'gate');
    expect(second).toBe('gate-2');

    const collidingSteps = [agent('agent-1'), gate('agent-2')];
    const third = nextStepId(collidingSteps, 'agent');
    expect(third).toBe('agent-3');
  });
});

describe('duplicateWorkflow', () => {
  it('opens a new, clean draft named "<name> (copy)" with no id', () => {
    const state = openWorkflowBuilder([doc({ name: 'Original' })]);

    const next = duplicateWorkflow(state, 'w1');

    expect(next.selection).toEqual({ kind: 'new' });
    expect(next.draft?.id).toBeUndefined();
    expect(next.draft?.name).toBe('Original (copy)');
    expect(isDirty(next)).toBe(false);
  });
});

describe('pending selection', () => {
  it('confirm applies the pending switch once the draft is dirty', () => {
    const state = selectWorkflow(
      openWorkflowBuilder([doc({ id: 'w1' }), doc({ id: 'w2', name: 'Other' })]),
      'w1',
    );
    const dirty = editWorkflow(state, { name: 'Changed' });

    const switched = selectWorkflow(dirty, 'w2');
    expect(switched.pendingSelection).toEqual({
      target: { kind: 'select', selection: { kind: 'library', id: 'w2' } },
    });
    expect(switched.selection).toEqual({ kind: 'library', id: 'w1' });

    const confirmed = confirmPendingSelection(switched);
    expect(confirmed.selection).toEqual({ kind: 'library', id: 'w2' });
    expect(confirmed.pendingSelection).toBeNull();
    expect(isDirty(confirmed)).toBe(false);
  });

  it('cancel keeps the current selection and draft', () => {
    const state = selectWorkflow(openWorkflowBuilder([doc({ id: 'w1' })]), 'w1');
    const dirty = editWorkflow(state, { name: 'Changed' });

    const switched = startNew(dirty);
    const next = cancelPendingSelection(switched);

    expect(next.pendingSelection).toBeNull();
    expect(next.selection).toEqual({ kind: 'library', id: 'w1' });
    expect(next.draft).toEqual(dirty.draft);
  });
});

describe('applySaveResult', () => {
  it('ok upserts, re-baselines, and selects the saved id', () => {
    const state = startNew(openWorkflowBuilder([]));
    const edited = editWorkflow(state, { name: 'New workflow' });

    const saved = doc({ id: 'minted', name: 'New workflow' });
    const next = applySaveResult(edited, { ok: true, workflow: saved });

    expect(next.library).toEqual([saved]);
    expect(next.selection).toEqual({ kind: 'library', id: 'minted' });
    expect(isDirty(next)).toBe(false);
  });

  it('invalid appends every issue as a notice, leaving the draft untouched', () => {
    const state = startNew(openWorkflowBuilder([]));
    const edited = editWorkflow(state, { name: 'New workflow' });

    const next = applySaveResult(edited, { ok: false, reason: 'invalid', issues: ['Bad thing.'] });

    expect(next.notices).toEqual(['Bad thing.']);
    expect(next.draft).toEqual(edited.draft);
  });
});

describe('retryFromOptions', () => {
  it('excludes gates and later steps', () => {
    const state = selectWorkflow(
      openWorkflowBuilder([
        doc({
          steps: [
            agent('agent-1'),
            gate('gate-2'),
            agent('agent-3'),
            gate('gate-4'),
            agent('agent-5'),
          ],
        }),
      ]),
      'w1',
    );

    const options = retryFromOptions(state, 'gate-4');

    expect(options).toEqual([
      { id: 'agent-1', title: 'Title agent-1' },
      { id: 'agent-3', title: 'Title agent-3' },
    ]);
  });
});

describe('setStepModel', () => {
  it('sets and then deletes the model override', () => {
    const state = selectWorkflow(openWorkflowBuilder([doc()]), 'w1');

    const set = setStepModel(state, 'agent-1', 'opus');
    expect((set.draft?.steps[0] as AgentStep).model).toBe('opus');

    const cleared = setStepModel(set, 'agent-1', null);
    expect((cleared.draft?.steps[0] as AgentStep).model).toBeUndefined();
  });
});
