import { describe, expect, it } from 'vitest';
import {
  STARTER_IMPLEMENT_REVIEW_TEST_WORKFLOW_ID,
  STARTER_IMPLEMENT_TEST_WORKFLOW_ID,
  STARTER_WORKFLOWS,
} from './workflowStarters';
import { instantiateWorkflow, isAgentStep, isGateStep, validateWorkflow } from './workflow';

describe('STARTER_WORKFLOWS', () => {
  it('has exactly the implement+test and implement/review/test starters', () => {
    expect(STARTER_WORKFLOWS.map((doc) => doc.id)).toEqual([
      STARTER_IMPLEMENT_TEST_WORKFLOW_ID,
      STARTER_IMPLEMENT_REVIEW_TEST_WORKFLOW_ID,
    ]);
  });

  it('has unique ids', () => {
    const ids = STARTER_WORKFLOWS.map((doc) => doc.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('passes validateWorkflow', () => {
    for (const doc of STARTER_WORKFLOWS) {
      const result = validateWorkflow(doc);
      expect(result.ok).toBe(true);
    }
  });

  it('round-trips through JSON unchanged', () => {
    for (const doc of STARTER_WORKFLOWS) {
      expect(JSON.parse(JSON.stringify(doc))).toEqual(doc);
    }
  });

  it("the review starter's gate retries from an agent step that comes before it", () => {
    const review = STARTER_WORKFLOWS.find(
      (doc) => doc.id === STARTER_IMPLEMENT_REVIEW_TEST_WORKFLOW_ID,
    );
    expect(review).toBeDefined();
    if (!review) return;

    const gateIndex = review.steps.findIndex(isGateStep);
    const gate = review.steps[gateIndex];
    if (!isGateStep(gate) || !gate.onFail) throw new Error('expected a gate with onFail');

    const retryIndex = review.steps.findIndex((step) => step.id === gate.onFail?.retryFrom);
    expect(retryIndex).toBeGreaterThanOrEqual(0);
    expect(retryIndex).toBeLessThan(gateIndex);
    expect(isAgentStep(review.steps[retryIndex])).toBe(true);
  });

  it('instantiates into a draft per step for every starter', () => {
    for (const doc of STARTER_WORKFLOWS) {
      const drafts = instantiateWorkflow(doc, { id: 'card-1' }, 1);
      expect(drafts).toHaveLength(doc.steps.length);
      expect(drafts.every((draft) => draft.workflowId === doc.id)).toBe(true);
    }
  });
});
