import { describe, expect, it } from 'vitest';
import {
  isAgentStep,
  isGateStep,
  MAX_WORKFLOW_STEPS,
  validateWorkflow,
  type AgentStep,
  type GateStep,
  type WorkflowDoc,
  type WorkflowStep,
} from './workflow';

const agentStep = (over: Partial<AgentStep> = {}): AgentStep => ({
  id: 'a1',
  kind: 'agent',
  title: 'Implement the feature',
  brief: 'Add the thing the ticket asks for.',
  ...over,
});

const gateStep = (over: Partial<GateStep> = {}): GateStep => ({
  id: 'g1',
  kind: 'gate',
  title: 'Run tests',
  command: 'pnpm test',
  onFail: { retryFrom: 'a1', maxAttempts: 3 },
  ...over,
});

const workflowDoc = (over: Partial<WorkflowDoc> = {}): WorkflowDoc => ({
  version: 1,
  id: 'wf-1',
  name: 'Implement + test gate',
  steps: [agentStep(), gateStep()],
  ...over,
});

describe('validateWorkflow', () => {
  it('passes a valid doc with an agent step and a gate step', () => {
    const result = validateWorkflow(workflowDoc());
    expect(result.ok).toBe(true);
  });

  it('round-trips through JSON.parse(JSON.stringify(...)) to a deep-equal doc, and a second pass is identical', () => {
    const firstResult = validateWorkflow(workflowDoc());
    expect(firstResult.ok).toBe(true);
    if (!firstResult.ok) return;

    const roundTripped = JSON.parse(JSON.stringify(firstResult.doc));
    expect(roundTripped).toEqual(firstResult.doc);

    const secondResult = validateWorkflow(roundTripped);
    expect(secondResult).toEqual(firstResult);
  });

  it('rejects a non-object input', () => {
    for (const bad of [null, undefined, 42, 'nope', true]) {
      const result = validateWorkflow(bad);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.issues).toContain('A workflow must be an object.');
    }
  });

  it('rejects a version other than 1', () => {
    const result = validateWorkflow({ ...workflowDoc(), version: 2 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues).toContain('Version must be 1.');
  });

  it('rejects a workflow with no steps', () => {
    const result = validateWorkflow(workflowDoc({ steps: [] }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues).toContain('A workflow needs at least one step.');
  });

  it(`rejects a workflow with more than ${MAX_WORKFLOW_STEPS} steps`, () => {
    const steps = Array.from({ length: MAX_WORKFLOW_STEPS + 1 }, (_, i) =>
      agentStep({ id: `a${i}` }),
    );
    const result = validateWorkflow(workflowDoc({ steps }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toContain(`A workflow may have at most ${MAX_WORKFLOW_STEPS} steps.`);
    }
  });

  it('rejects a duplicate step id', () => {
    const steps = [agentStep({ id: 'dup' }), gateStep({ id: 'dup', onFail: undefined })];
    const result = validateWorkflow(workflowDoc({ steps }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((i) => i.includes('duplicate id') && i.includes('dup'))).toBe(true);
    }
  });

  it('rejects an unknown step kind', () => {
    const steps = [
      agentStep(),
      { id: 'x1', kind: 'oops', title: 'Mystery' } as unknown as WorkflowStep,
    ];
    const result = validateWorkflow(workflowDoc({ steps }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((i) => i.includes('unknown kind') && i.includes('oops'))).toBe(
        true,
      );
    }
  });

  it('rejects an empty title', () => {
    const result = validateWorkflow(workflowDoc({ steps: [agentStep({ title: '   ' })] }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.some((i) => i.includes('title'))).toBe(true);
  });

  it('rejects an empty or whitespace command', () => {
    for (const command of ['', '   ']) {
      const result = validateWorkflow(
        workflowDoc({ steps: [agentStep(), gateStep({ command, onFail: undefined })] }),
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.issues.some((i) => i.includes('command'))).toBe(true);
    }
  });

  describe('retryFrom', () => {
    it('rejects a retryFrom pointing at a later step', () => {
      const steps = [
        gateStep({ id: 'g1', onFail: { retryFrom: 'a1', maxAttempts: 3 } }),
        agentStep({ id: 'a1' }),
      ];
      const result = validateWorkflow(workflowDoc({ steps }));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.issues.some((i) => i.includes('a1') && i.includes('after'))).toBe(true);
      }
    });

    it('rejects a retryFrom pointing at the gate itself', () => {
      const steps = [
        agentStep({ id: 'a1' }),
        gateStep({ id: 'g1', onFail: { retryFrom: 'g1', maxAttempts: 3 } }),
      ];
      const result = validateWorkflow(workflowDoc({ steps }));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.issues.some((i) => i.includes('itself'))).toBe(true);
      }
    });

    it('rejects a retryFrom pointing at another gate step', () => {
      const steps = [
        gateStep({ id: 'g1', onFail: undefined }),
        agentStep({ id: 'a1' }),
        gateStep({ id: 'g2', onFail: { retryFrom: 'g1', maxAttempts: 3 } }),
      ];
      const result = validateWorkflow(workflowDoc({ steps }));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.issues.some((i) => i.includes('g1') && i.includes('gate'))).toBe(true);
      }
    });

    it('rejects a retryFrom naming an unknown step id', () => {
      const steps = [
        agentStep({ id: 'a1' }),
        gateStep({ id: 'g1', onFail: { retryFrom: 'nope', maxAttempts: 3 } }),
      ];
      const result = validateWorkflow(workflowDoc({ steps }));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.issues.some((i) => i.includes('nope'))).toBe(true);
      }
    });
  });

  describe('onFail bounds', () => {
    it('rejects a retryOn list containing 0', () => {
      const steps = [
        agentStep({ id: 'a1' }),
        gateStep({ id: 'g1', onFail: { retryFrom: 'a1', maxAttempts: 3, retryOn: [0, 1] } }),
      ];
      const result = validateWorkflow(workflowDoc({ steps }));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.issues.some((i) => i.toLowerCase().includes('retry'))).toBe(true);
      }
    });

    it('rejects a negative or non-integer retryOn entry', () => {
      for (const retryOn of [[-1], [1.5]]) {
        const steps = [
          agentStep({ id: 'a1' }),
          gateStep({ id: 'g1', onFail: { retryFrom: 'a1', maxAttempts: 3, retryOn } }),
        ];
        const result = validateWorkflow(workflowDoc({ steps }));
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.issues.some((i) => i.toLowerCase().includes('retry'))).toBe(true);
        }
      }
    });

    it('rejects maxAttempts of 0', () => {
      const steps = [
        agentStep({ id: 'a1' }),
        gateStep({ id: 'g1', onFail: { retryFrom: 'a1', maxAttempts: 0 } }),
      ];
      const result = validateWorkflow(workflowDoc({ steps }));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.issues.some((i) => i.toLowerCase().includes('attempt'))).toBe(true);
      }
    });

    it('rejects maxAttempts of 6', () => {
      const steps = [
        agentStep({ id: 'a1' }),
        gateStep({ id: 'g1', onFail: { retryFrom: 'a1', maxAttempts: 6 } }),
      ];
      const result = validateWorkflow(workflowDoc({ steps }));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.issues.some((i) => i.toLowerCase().includes('attempt'))).toBe(true);
      }
    });
  });

  it('rejects a bad model', () => {
    const result = validateWorkflow(workflowDoc({ steps: [agentStep({ model: 'bad model!' })] }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.some((i) => i.toLowerCase().includes('model'))).toBe(true);
  });

  it('rejects a bad mode', () => {
    const result = validateWorkflow(
      workflowDoc({ steps: [agentStep({ mode: 'yolo' as unknown as AgentStep['mode'] })] }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.some((i) => i.toLowerCase().includes('mode'))).toBe(true);
  });

  it('reports every problem in a document with several', () => {
    const steps = [
      agentStep({ id: 'dup', title: '   ' }),
      gateStep({ id: 'dup', command: '', onFail: { retryFrom: 'nope', maxAttempts: 9 } }),
    ];
    const result = validateWorkflow(workflowDoc({ version: 2 as unknown as 1, steps }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toContain('Version must be 1.');
      expect(result.issues.some((i) => i.includes('duplicate id'))).toBe(true);
      expect(result.issues.some((i) => i.includes('title'))).toBe(true);
      expect(result.issues.some((i) => i.includes('command'))).toBe(true);
      expect(result.issues.some((i) => i.includes('nope'))).toBe(true);
      expect(result.issues.some((i) => i.toLowerCase().includes('attempt'))).toBe(true);
      expect(result.issues.length).toBeGreaterThanOrEqual(5);
    }
  });
});

describe('isAgentStep / isGateStep', () => {
  it('narrows an agent step', () => {
    const step: WorkflowStep = agentStep();
    expect(isAgentStep(step)).toBe(true);
    expect(isGateStep(step)).toBe(false);
  });

  it('narrows a gate step', () => {
    const step: WorkflowStep = gateStep();
    expect(isGateStep(step)).toBe(true);
    expect(isAgentStep(step)).toBe(false);
  });
});
