import { describe, expect, it } from 'vitest';
import { PERSONAL_PROJECT_ID, type Task } from '@shared/model';
import { pickTransition, resolveMove } from './jiraMove';
import type { JiraTransition } from './jiraClient';

const task = (over: Partial<Task>): Task => ({
  id: 't',
  projectId: PERSONAL_PROJECT_ID,
  phase: '',
  title: 'x',
  status: 'pending',
  sessionId: null,
  order: 0,
  dependsOn: [],
  source: 'jira',
  isContract: false,
  isScaffold: false,
  externalSource: 'jira',
  externalKey: 'AB-1',
  externalId: '1',
  ...over,
});

describe('resolveMove', () => {
  it('is a no-op when dropped into the same column', () => {
    const r = resolveMove(task({ status: 'pending' }), 'todo');
    expect(r.noop).toBe(true);
  });

  it('TO DO → IN PROGRESS transitions the JIRA issue', () => {
    const r = resolveMove(task({ status: 'pending' }), 'in-progress');
    expect(r).toMatchObject({
      localStatus: 'in-progress',
      jiraTransition: 'toInProgress',
      preBlockStatus: null,
    });
  });

  it('moving into Blocked never touches JIRA and remembers the pre-block status', () => {
    const r = resolveMove(task({ status: 'in-progress' }), 'blocked');
    expect(r).toMatchObject({
      localStatus: 'blocked',
      jiraTransition: null,
      preBlockStatus: 'in-progress',
    });
  });

  it('un-blocking into In Progress re-transitions JIRA and clears preBlockStatus', () => {
    const r = resolveMove(
      task({ status: 'blocked', preBlockStatus: 'in-progress' }),
      'in-progress',
    );
    expect(r).toMatchObject({
      localStatus: 'in-progress',
      jiraTransition: 'toInProgress',
      preBlockStatus: null,
    });
  });

  it('moving back to TO DO does not transition JIRA', () => {
    const r = resolveMove(task({ status: 'blocked', preBlockStatus: 'pending' }), 'todo');
    expect(r).toMatchObject({ localStatus: 'pending', jiraTransition: null });
  });

  it('moving into In Review transitions JIRA to In Review', () => {
    const r = resolveMove(task({ status: 'in-progress' }), 'in-review');
    expect(r).toMatchObject({
      localStatus: 'in-review',
      jiraTransition: 'toInReview',
      preBlockStatus: null,
    });
  });

  it('moving into Done transitions JIRA to Done', () => {
    const r = resolveMove(task({ status: 'in-progress' }), 'done');
    expect(r.jiraTransition).toBe('toDone');
  });

  it('internal (non-JIRA) tasks never transition anything', () => {
    const r = resolveMove(task({ source: 'adhoc', externalSource: null }), 'in-progress');
    expect(r.jiraTransition).toBeNull();
    expect(r.localStatus).toBe('in-progress');
  });
});

const T = (id: string, name: string, categoryKey: string): JiraTransition => ({
  id,
  name,
  to: { name, statusCategory: { key: categoryKey, name } },
});

describe('pickTransition', () => {
  const transitions = [T('11', 'Start Progress', 'indeterminate'), T('31', 'Resolve', 'done')];

  it('matches In Progress by destination category', () => {
    expect(pickTransition(transitions, 'toInProgress', {})?.id).toBe('11');
  });
  it('matches Done by destination category', () => {
    expect(pickTransition(transitions, 'toDone', {})?.id).toBe('31');
  });
  it('honors an exact-name override', () => {
    const withExtra = [...transitions, T('99', 'Kickoff', 'indeterminate')];
    expect(
      pickTransition(withExtra, 'toInProgress', { inProgressTransitionName: 'Kickoff' })?.id,
    ).toBe('99');
  });
  it('returns null when no transition fits', () => {
    expect(pickTransition([T('5', 'Close', 'done')], 'toInProgress', {})).toBeNull();
  });

  // In Review lives in the same `indeterminate` category as In Progress, so the map
  // (or the name) is the only thing that can tell the two apart.
  describe('In Review', () => {
    const workflow = [
      T('11', 'Start Progress', 'indeterminate'),
      T('21', 'Code Review', 'indeterminate'),
      T('31', 'Resolve', 'done'),
    ];
    const map = { statusCategoryOverrides: { 'code review': 'in-review' as const } };

    it('picks the transition whose destination the user mapped to In Review', () => {
      expect(pickTransition(workflow, 'toInReview', map)?.id).toBe('21');
    });

    it('matches the map case-insensitively', () => {
      const upper = { statusCategoryOverrides: { 'CODE REVIEW': 'in-review' as const } };
      expect(pickTransition(workflow, 'toInReview', upper)?.id).toBe('21');
    });

    it('falls back to an indeterminate transition named "…review…" with no map', () => {
      expect(pickTransition(workflow, 'toInReview', {})?.id).toBe('21');
    });

    it('prefers an exact-name override over the map', () => {
      const withExtra = [...workflow, T('99', 'Hand off', 'indeterminate')];
      expect(
        pickTransition(withExtra, 'toInReview', { ...map, inReviewTransitionName: 'Hand off' })?.id,
      ).toBe('99');
    });

    it('returns null when the workflow has no review step', () => {
      expect(
        pickTransition([T('11', 'Start Progress', 'indeterminate')], 'toInReview', {}),
      ).toBeNull();
    });

    // The regression that motivated the map: "Code Review" comes first in this
    // workflow, so a bare category match would send an IN PROGRESS drag to review.
    it('In Progress never grabs a transition mapped to In Review', () => {
      const reviewFirst = [
        T('21', 'Code Review', 'indeterminate'),
        T('11', 'Start Progress', 'indeterminate'),
      ];
      expect(pickTransition(reviewFirst, 'toInProgress', map)?.id).toBe('11');
    });

    it('In Progress still matches by category when nothing is mapped', () => {
      expect(pickTransition(workflow, 'toInProgress', {})?.id).toBe('11');
    });

    it('picks a transition whose destination we learned from an earlier drag', () => {
      const qaWorkflow = [
        T('11', 'Start Progress', 'indeterminate'),
        T('41', 'QA', 'indeterminate'),
      ];
      expect(
        pickTransition(qaWorkflow, 'toInReview', { learnedStatusColumns: { QA: 'in-review' } })?.id,
      ).toBe('41');
    });

    it('prefers the user map over what was learned', () => {
      const both = [T('21', 'Code Review', 'indeterminate'), T('41', 'QA', 'indeterminate')];
      expect(
        pickTransition(both, 'toInReview', {
          statusCategoryOverrides: { QA: 'in-review' },
          learnedStatusColumns: { 'Code Review': 'in-review' },
        })?.id,
      ).toBe('41');
    });
  });

  // Tier by tier, not first-match-wins down the transition list: a workflow returns its
  // transitions in whatever order it declares them, so scanning once would let a
  // category guess listed first beat the status the user explicitly mapped.
  it('takes an explicitly mapped destination over one that only matches by category', () => {
    const workflow = [T('11', 'Ship It', 'done'), T('12', 'Sign Off', 'done')];
    expect(
      pickTransition(workflow, 'toDone', { statusCategoryOverrides: { 'Sign Off': 'done' } })?.id,
    ).toBe('12');
  });
});
