import { describe, expect, it } from 'vitest';
import {
  boundOutputTail,
  decideGateOutcome,
  GATE_FAILURE_NOTE_TAIL_BYTES,
  GATE_TIMELINE_TAIL_BYTES,
  instantiateWorkflow,
  isAgentStep,
  isGateStep,
  MAX_WORKFLOW_STEPS,
  validateWorkflow,
  type AgentStep,
  type GateOutcome,
  type GateRunResult,
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

  it('rejects a skillRefs that is not an array, or that contains an unparseable ref', () => {
    for (const skillRefs of ['lib:1' as unknown as string[], ['not-a-ref']]) {
      const result = validateWorkflow(workflowDoc({ steps: [agentStep({ skillRefs })] }));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.issues.some((i) => i.toLowerCase().includes('skillrefs'))).toBe(true);
      }
    }
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

const gateRunResult = (over: Partial<GateRunResult> = {}): GateRunResult => ({
  exitCode: 1,
  timedOut: false,
  attemptsUsed: 0,
  ...over,
});

describe('decideGateOutcome', () => {
  it.each<[string, GateRunResult, GateOutcome]>([
    [
      'exit 0 with onFail passes',
      gateRunResult({ exitCode: 0, onFail: { retryFrom: 'a1', maxAttempts: 3 } }),
      { kind: 'pass' },
    ],
    ['exit 0 without onFail passes', gateRunResult({ exitCode: 0 }), { kind: 'pass' }],
    [
      'retryOn absent retries on any code',
      gateRunResult({ exitCode: 7, onFail: { retryFrom: 'a1', maxAttempts: 3 } }),
      { kind: 'retry', retryFrom: 'a1', attempt: 1, maxAttempts: 3 },
    ],
    [
      'retryOn empty array retries on any code',
      gateRunResult({ exitCode: 7, onFail: { retryFrom: 'a1', maxAttempts: 3, retryOn: [] } }),
      { kind: 'retry', retryFrom: 'a1', attempt: 1, maxAttempts: 3 },
    ],
    [
      'a listed exit code retries',
      gateRunResult({
        exitCode: 2,
        onFail: { retryFrom: 'a1', maxAttempts: 3, retryOn: [1, 2, 3] },
      }),
      { kind: 'retry', retryFrom: 'a1', attempt: 1, maxAttempts: 3 },
    ],
    [
      'a non-retryable exit code fails',
      gateRunResult({
        exitCode: 99,
        onFail: { retryFrom: 'a1', maxAttempts: 3, retryOn: [1, 2, 3] },
      }),
      { kind: 'fail', reason: 'non-retryable-code' },
    ],
    [
      'attempts exhausted (attemptsUsed === maxAttempts) fails',
      gateRunResult({ exitCode: 1, attemptsUsed: 3, onFail: { retryFrom: 'a1', maxAttempts: 3 } }),
      { kind: 'fail', reason: 'attempts-exhausted' },
    ],
    [
      'the last allowed attempt (attemptsUsed === maxAttempts - 1) still retries',
      gateRunResult({ exitCode: 1, attemptsUsed: 2, onFail: { retryFrom: 'a1', maxAttempts: 3 } }),
      { kind: 'retry', retryFrom: 'a1', attempt: 3, maxAttempts: 3 },
    ],
    [
      'a timeout fails even with an onFail that would otherwise retry',
      gateRunResult({
        exitCode: 1,
        timedOut: true,
        onFail: { retryFrom: 'a1', maxAttempts: 3 },
      }),
      { kind: 'fail', reason: 'timeout' },
    ],
    [
      'a timeout fails even on exit 0',
      gateRunResult({ exitCode: 0, timedOut: true }),
      { kind: 'fail', reason: 'timeout' },
    ],
    [
      'exitCode null fails as no-exit-code',
      gateRunResult({ exitCode: null, onFail: { retryFrom: 'a1', maxAttempts: 3 } }),
      { kind: 'fail', reason: 'no-exit-code' },
    ],
    [
      'no onFail fails as no-on-fail',
      gateRunResult({ exitCode: 1 }),
      { kind: 'fail', reason: 'no-on-fail' },
    ],
  ])('%s', (_description, result, expected) => {
    expect(decideGateOutcome(result)).toEqual(expected);
  });
});

describe('boundOutputTail', () => {
  it('leaves output under the limit unchanged', () => {
    expect(boundOutputTail('short', 1024)).toBe('short');
  });

  it('leaves output exactly at the limit unchanged', () => {
    const output = 'x'.repeat(10);
    expect(boundOutputTail(output, 10)).toBe(output);
  });

  it('keeps the tail and a marker when over the limit, within maxBytes', () => {
    const output = Array.from({ length: 2000 }, (_, i) => `line ${i}`).join('\n');
    const maxBytes = 512;
    const result = boundOutputTail(output, maxBytes);

    expect(result).not.toBe(output);
    expect(result).toContain('bytes truncated');
    expect(result.endsWith(output.slice(-20))).toBe(true);
    expect(new TextEncoder().encode(result).length).toBeLessThanOrEqual(maxBytes);
  });

  it('never splits a multibyte code point, for accented text', () => {
    const output = 'é'.repeat(2000);
    const result = boundOutputTail(output, 100);
    expect(result).not.toContain('�');
  });

  it('never splits a multibyte code point, for emoji', () => {
    const output = '🎉'.repeat(2000);
    const result = boundOutputTail(output, 100);
    expect(result).not.toContain('�');
  });

  it('returns an empty string when maxBytes is 0', () => {
    expect(boundOutputTail('anything at all', 0)).toBe('');
  });

  it('defines the tail byte caps as 16384 and 8192', () => {
    expect(GATE_TIMELINE_TAIL_BYTES).toBe(16384);
    expect(GATE_FAILURE_NOTE_TAIL_BYTES).toBe(8192);
  });
});

describe('instantiateWorkflow', () => {
  const card = { id: 'card-1' };

  it('maps a mixed workflow (agent, gate, agent with overrides, gate with retryOn)', () => {
    const doc = workflowDoc({
      id: 'wf-mixed',
      steps: [
        agentStep({ id: 'a1', title: 'First step', brief: 'Do the first thing.' }),
        gateStep({ id: 'g1', title: 'First gate', onFail: { retryFrom: 'a1', maxAttempts: 3 } }),
        agentStep({
          id: 'a2',
          title: 'Second step',
          brief: 'Do the second thing.',
          model: 'sonnet',
          mode: 'plan',
          skillRefs: ['lib:abc123', 'repo:my-skill'],
        }),
        gateStep({
          id: 'g2',
          title: 'Second gate',
          onFail: { retryFrom: 'a2', maxAttempts: 2, retryOn: [1] },
        }),
      ],
    });

    const drafts = instantiateWorkflow(doc, card, 2);

    expect(drafts).toHaveLength(4);
    expect(drafts.map((d) => d.title)).toEqual([
      'First step',
      'First gate',
      'Second step',
      'Second gate',
    ]);
    expect(drafts.map((d) => d.description)).toEqual([
      'Do the first thing.',
      null,
      'Do the second thing.',
      null,
    ]);

    for (const draft of drafts) {
      expect(draft.parentTaskId).toBe('card-1');
      expect(draft.planRound).toBe(2);
      expect(draft.workflowId).toBe('wf-mixed');
    }

    expect(drafts.map((d) => d.agentModel)).toEqual([null, null, 'sonnet', null]);
    expect(drafts.map((d) => d.agentMode)).toEqual([null, null, 'plan', null]);
    expect(drafts.map((d) => d.skillRefs)).toEqual([
      null,
      null,
      ['lib:abc123', 'repo:my-skill'],
      null,
    ]);

    const g1 = drafts[1].stepSpec as GateStep & { onFail: { retryFromIndex: number } };
    const g2 = drafts[3].stepSpec as GateStep & { onFail: { retryFromIndex: number } };
    expect(g1.onFail.retryFromIndex).toBe(0);
    expect(g2.onFail.retryFromIndex).toBe(2);

    expect(drafts.map((d) => d.stepNumber)).toEqual([1, 2, 3, 4]);
    expect(drafts.map((d) => d.stepCount)).toEqual([4, 4, 4, 4]);
    expect(drafts.map((d) => d.agentStepNumber)).toEqual([1, null, 2, null]);
    expect(drafts.map((d) => d.agentStepCount)).toEqual([2, 2, 2, 2]);
  });

  it('handles a gate-first workflow (no onFail, agent after)', () => {
    const doc = workflowDoc({
      id: 'wf-gate-first',
      steps: [
        gateStep({ id: 'g1', title: 'Lint', onFail: undefined }),
        agentStep({ id: 'a1', title: 'Fix it up', brief: 'Fix whatever needs fixing.' }),
      ],
    });

    const drafts = instantiateWorkflow(doc, card, 1);

    expect(drafts).toHaveLength(2);
    const [gateDraft, agentDraft] = drafts;

    expect('onFail' in gateDraft.stepSpec).toBe(false);
    expect(gateDraft.agentStepNumber).toBeNull();
    expect(gateDraft.stepNumber).toBe(1);
    expect(gateDraft.stepCount).toBe(2);

    expect(agentDraft.agentStepNumber).toBe(1);
    expect(agentDraft.agentStepCount).toBe(1);
    expect(agentDraft.stepNumber).toBe(2);
    expect(agentDraft.stepCount).toBe(2);
  });

  it('never aliases the source doc — a mutation after the call leaves prior drafts untouched', () => {
    const doc = workflowDoc({
      id: 'wf-snapshot',
      steps: [
        agentStep({ id: 'a1', title: 'Original title', brief: 'Original brief.' }),
        gateStep({ id: 'g1', onFail: { retryFrom: 'a1', maxAttempts: 3 } }),
      ],
    });

    const drafts = instantiateWorkflow(doc, card, 1);
    const before = JSON.parse(JSON.stringify(drafts));

    (doc.steps[0] as AgentStep).title = 'Mutated title';
    (doc.steps[0] as AgentStep).brief = 'Mutated brief.';
    (doc.steps[0] as AgentStep).skillRefs = (doc.steps[0] as AgentStep).skillRefs ?? [];
    (doc.steps[0] as AgentStep).skillRefs?.push('lib:late-add');
    (doc.steps[1] as GateStep).onFail!.maxAttempts = 5;
    doc.steps.push(agentStep({ id: 'a-new', title: 'Appended step' }));

    expect(drafts).toEqual(before);
    expect(drafts[0].stepSpec).not.toBe(doc.steps[0]);
  });

  it('throws when a gate onFail.retryFrom cannot be resolved', () => {
    const doc = workflowDoc({
      id: 'wf-bad-retry',
      steps: [
        agentStep({ id: 'a1' }),
        gateStep({ id: 'g1', onFail: { retryFrom: 'nope', maxAttempts: 3 } }),
      ],
    });

    expect(() => instantiateWorkflow(doc, card, 1)).toThrow();
  });
});
