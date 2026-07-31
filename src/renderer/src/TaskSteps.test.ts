/**
 * Grouping a card's chain into planning rounds (Phase 18).
 *
 * The rule under test is the one the panel's fold depends on: rounds decide what can be
 * collapsed, but they must never renumber the chain. A card re-planned twice still runs
 * one ordered sequence, and the numbers the human reads have to match the card's own
 * `done/total` counter — which counts every step, whatever round produced it.
 */
import { describe, expect, it } from 'vitest';
import type { Task } from '@shared/model';
import { groupStepsByRound } from './TaskSteps';

const step = (id: string, planRound?: number): Task =>
  ({
    id,
    projectId: 'personal',
    phase: 'JIRA',
    title: `Step ${id}`,
    status: 'done',
    sessionId: null,
    order: 0,
    source: 'adhoc',
    dependsOn: [],
    isContract: false,
    isScaffold: false,
    parentTaskId: 'c1',
    planRound,
  }) as Task;

describe('groupStepsByRound', () => {
  it('leaves a single-round chain as one group', () => {
    const groups = groupStepsByRound([step('s1', 1), step('s2', 1)]);
    expect(groups).toHaveLength(1);
    expect(groups[0].round).toBe(1);
    expect(groups[0].steps.map((s) => s.step.id)).toEqual(['s1', 's2']);
  });

  it('splits a re-planned chain into its rounds, in order', () => {
    const groups = groupStepsByRound([step('s1', 1), step('s2', 1), step('s3', 2), step('s4', 2)]);
    expect(groups.map((g) => g.round)).toEqual([1, 2]);
    expect(groups[1].steps.map((s) => s.step.id)).toEqual(['s3', 's4']);
  });

  // The numbering is the card's, not the round's: round 2's first step is step 3 of 4, and
  // showing it as "1." would contradict the counter on the card.
  it('numbers steps across the WHOLE chain, never restarting per round', () => {
    const groups = groupStepsByRound([step('s1', 1), step('s2', 1), step('s3', 2)]);
    expect(groups.flatMap((g) => g.steps.map((s) => s.index))).toEqual([0, 1, 2]);
    expect(groups[1].steps[0].index).toBe(2);
  });

  // Every step that predates the field came from the card's one and only approved plan.
  it('treats steps with no round as round 1, so an upgraded card still groups', () => {
    const groups = groupStepsByRound([step('s1'), step('s2'), step('s3', 2)]);
    expect(groups.map((g) => g.round)).toEqual([1, 2]);
    expect(groups[0].steps).toHaveLength(2);
  });

  it('is empty for a card with no steps', () => {
    expect(groupStepsByRound([])).toEqual([]);
  });
});
