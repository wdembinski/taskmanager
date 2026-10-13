import { describe, expect, it } from 'vitest';
import { PERSONAL_PROJECT_ID, type Task } from '@shared/model';
import type { LinearStateType } from '@shared/settings';
import {
  resolveLinearMove,
  shouldLearnState,
  type LinearMoveSettings,
  type LinearTeamStates,
  type LinearWorkflowState,
} from './linearMove';

const task = (over: Partial<Task>): Task => ({
  id: 't',
  projectId: PERSONAL_PROJECT_ID,
  phase: '',
  title: 'x',
  status: 'pending',
  sessionId: null,
  order: 0,
  dependsOn: [],
  source: 'linear',
  isContract: false,
  isScaffold: false,
  externalSource: 'linear',
  externalKey: 'ENG-1',
  externalId: '1',
  ...over,
});

const state = (
  id: string,
  name: string,
  type: LinearStateType,
  position: number,
): LinearWorkflowState => ({ id, name, type, position });

const team = (states: LinearWorkflowState[], teamKey = 'ENG'): LinearTeamStates => ({
  teamKey,
  states,
});

const settings = (over: Partial<LinearMoveSettings> = {}): LinearMoveSettings => ({
  stateColumnOverrides: {},
  learnedStateColumns: {},
  columnTargetStates: {},
  ...over,
});

describe('resolveLinearMove', () => {
  describe('tier order', () => {
    // Without the configured entry, "Code Review" would win on the explicit tier.
    it('a configured state beats an explicit override', () => {
      const t = team([state('1', 'Code Review', 'started', 0), state('2', 'QA', 'started', 1)]);
      const s = settings({
        stateColumnOverrides: { 'Code Review': 'in-review' },
        columnTargetStates: { ENG: { 'in-review': 'QA' } },
      });
      const r = resolveLinearMove(task({}), 'in-review', t, s);
      expect(r.target).toMatchObject({ via: 'configured', state: { name: 'QA' } });
    });

    // Without the explicit override, "QA" would win on the learned tier.
    it('an explicit override beats a learned state', () => {
      const t = team([state('1', 'Code Review', 'started', 0), state('2', 'QA', 'started', 1)]);
      const s = settings({
        stateColumnOverrides: { 'Code Review': 'in-review' },
        learnedStateColumns: { QA: 'in-review' },
      });
      const r = resolveLinearMove(task({}), 'in-review', t, s);
      expect(r.target).toMatchObject({ via: 'explicit', state: { name: 'Code Review' } });
    });

    // Without the learned entry, "Code Review" would win on the heuristic tier — its name
    // alone reads as a review step.
    it('a learned state beats a review-name heuristic match', () => {
      const t = team([state('1', 'Code Review', 'started', 0), state('2', 'QA', 'started', 1)]);
      const s = settings({ learnedStateColumns: { QA: 'in-review' } });
      const r = resolveLinearMove(task({}), 'in-review', t, s);
      expect(r.target).toMatchObject({ via: 'learned', state: { name: 'QA' } });
    });

    // IN REVIEW has no `LinearStateType` of its own (`TYPE_PREFERENCE['in-review']` is empty),
    // so the position fallback can never service it on its own — the heuristic is the only
    // tier standing between a plain review-named state and a refusal.
    it('a review-name heuristic match beats the position fallback, which has nothing to offer IN REVIEW', () => {
      const t = team([
        state('1', 'Code Review', 'started', 0),
        state('2', 'In Progress', 'started', 1),
      ]);
      const r = resolveLinearMove(task({}), 'in-review', t, settings());
      expect(r.target).toMatchObject({ via: 'heuristic', state: { name: 'Code Review' } });

      // Drop the only reviewish name: the same states, minus "Code Review", have nothing the
      // position fallback can substitute — proving it never competes for this column at all.
      const withoutReview = team([state('2', 'In Progress', 'started', 1)]);
      const refused = resolveLinearMove(task({}), 'in-review', withoutReview, settings());
      expect(refused.target).toBeNull();
      expect(refused.refusal).not.toBeNull();
    });
  });

  it('a stale configured name falls through to the next tier', () => {
    const t = team([state('1', 'To Do', 'unstarted', 0)]);
    const s = settings({ columnTargetStates: { ENG: { todo: 'Backlog (renamed)' } } });
    const r = resolveLinearMove(task({ status: 'in-progress' }), 'todo', t, s);
    expect(r.target).toMatchObject({ via: 'category', state: { name: 'To Do' } });
  });

  describe('position fallback', () => {
    // Neither name is literally "To Do" — so the name tie-break `pickNamedOrLowestPosition`
    // would otherwise prefer never applies, and only the position comparison is on test.
    it('of two unstarted states the lower position wins regardless of array order', () => {
      const t = team([state('1', 'Ready', 'unstarted', 5), state('2', 'Queued', 'unstarted', 1)]);
      const r = resolveLinearMove(task({ status: 'in-progress' }), 'todo', t, settings());
      expect(r.target).toMatchObject({ state: { name: 'Queued' } });

      const reversed = team([
        state('2', 'Queued', 'unstarted', 1),
        state('1', 'Ready', 'unstarted', 5),
      ]);
      const r2 = resolveLinearMove(task({ status: 'in-progress' }), 'todo', reversed, settings());
      expect(r2.target).toMatchObject({ state: { name: 'Queued' } });
    });

    it('prefers unstarted over backlog and triage for TO DO, even when they sit at a lower position', () => {
      const t = team([
        state('1', 'Triage', 'triage', 0),
        state('2', 'Backlog', 'backlog', 1),
        state('3', 'Todo', 'unstarted', 2),
      ]);
      const r = resolveLinearMove(task({ status: 'in-progress' }), 'todo', t, settings());
      expect(r.target).toMatchObject({ state: { name: 'Todo' } });
    });
  });

  it('IN REVIEW: a started "In Review" state is picked by heuristic', () => {
    const t = team([
      state('1', 'Todo', 'unstarted', 0),
      state('2', 'In Review', 'started', 1),
      state('3', 'Done', 'completed', 2),
    ]);
    const r = resolveLinearMove(task({}), 'in-review', t, settings());
    expect(r.target).toMatchObject({ via: 'heuristic', state: { name: 'In Review' } });
  });

  describe('BLOCKED', () => {
    it('target and refusal are both null, and preBlockStatus is set — even with a "Blocked" state present', () => {
      const t = team([
        state('1', 'In Progress', 'started', 0),
        state('2', 'Blocked', 'started', 1),
      ]);
      const s = settings({ stateColumnOverrides: { Blocked: 'blocked' } });
      const r = resolveLinearMove(task({ status: 'in-progress' }), 'blocked', t, s);
      expect(r.target).toBeNull();
      expect(r.refusal).toBeNull();
      expect(r.preBlockStatus).toBe('in-progress');
      expect(r.localStatus).toBe('blocked');
    });
  });

  describe('DONE never canceled', () => {
    it('skips a canceled state configured for DONE and falls through to a completed one', () => {
      const t = team([state('1', "Won't Fix", 'canceled', 0), state('2', 'Done', 'completed', 1)]);
      const s = settings({ columnTargetStates: { ENG: { done: "Won't Fix" } } });
      const r = resolveLinearMove(task({}), 'done', t, s);
      expect(r.target).toMatchObject({ state: { name: 'Done', type: 'completed' } });
    });

    it('skips a canceled state explicitly mapped to DONE and falls through to a completed one', () => {
      const t = team([state('1', "Won't Fix", 'canceled', 0), state('2', 'Done', 'completed', 1)]);
      const s = settings({ stateColumnOverrides: { "Won't Fix": 'done' } });
      const r = resolveLinearMove(task({}), 'done', t, s);
      expect(r.target).toMatchObject({ state: { name: 'Done', type: 'completed' } });
    });

    it('never picks a canceled state in the position tier, even at a lower position than the completed one', () => {
      const t = team([state('1', "Won't Fix", 'canceled', 0), state('2', 'Done', 'completed', 1)]);
      const r = resolveLinearMove(task({}), 'done', t, settings());
      expect(r.target).toMatchObject({ state: { name: 'Done', type: 'completed' } });
    });

    it('a team with only a canceled state refuses', () => {
      const t = team([state('1', "Won't Fix", 'canceled', 0)]);
      const r = resolveLinearMove(task({}), 'done', t, settings());
      expect(r.target).toBeNull();
      expect(r.refusal).not.toBeNull();
    });
  });

  it('refuses with the exact message for a team with no review-type state on an IN REVIEW drag', () => {
    const t = team([state('1', 'Todo', 'unstarted', 0), state('2', 'Doing', 'started', 1)], 'DES');
    const r = resolveLinearMove(task({}), 'in-review', t, settings());
    expect(r.target).toBeNull();
    expect(r.refusal).toBe(
      'Linear team DES has no state for IN REVIEW — pick one in Settings → Linear.',
    );
  });

  it('a non-Linear task has no target', () => {
    const t = team([state('1', 'In Review', 'started', 0)]);
    const r = resolveLinearMove(
      task({ source: 'adhoc', externalSource: null, externalKey: null }),
      'in-review',
      t,
      settings(),
    );
    expect(r.target).toBeNull();
    expect(r.refusal).toBeNull();
  });

  it('a no-op drop (same column) has no target', () => {
    const t = team([state('1', 'Todo', 'unstarted', 0)]);
    const r = resolveLinearMove(task({ status: 'pending' }), 'todo', t, settings());
    expect(r.noop).toBe(true);
    expect(r.target).toBeNull();
    expect(r.refusal).toBeNull();
  });
});

describe('shouldLearnState', () => {
  it('says nothing about a blank name', () => {
    expect(shouldLearnState('   ', 'started', 'in-review', settings())).toBe(false);
  });

  it('refuses to learn anything from a blocked-ish name', () => {
    expect(shouldLearnState('On Hold', 'started', 'in-review', settings())).toBe(false);
  });

  it('never overwrites what the user explicitly mapped', () => {
    const s = settings({ stateColumnOverrides: { QA: 'done' } });
    expect(shouldLearnState('QA', 'started', 'in-review', s)).toBe(false);
  });

  it('writes no entry for a state that already resolves to that column', () => {
    expect(shouldLearnState('QA', 'started', 'in-progress', settings())).toBe(false);
  });

  it('learns a heuristic-picked state whose resolver column differs from where it was dropped', () => {
    expect(shouldLearnState('Code Review', 'started', 'in-progress', settings())).toBe(true);
  });
});
