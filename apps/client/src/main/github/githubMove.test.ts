import { describe, expect, it } from 'vitest';
import { PERSONAL_PROJECT_ID, type BoardColumn, type Task } from '@shared/model';
import { planLabelChange, resolveMove, shouldLearnLabel, type LabelSettings } from './githubMove';

const task = (over: Partial<Task>): Task => ({
  id: 't',
  projectId: PERSONAL_PROJECT_ID,
  phase: 'acme/web',
  title: 'x',
  status: 'pending',
  sessionId: null,
  order: 0,
  dependsOn: [],
  source: 'github',
  isContract: false,
  isScaffold: false,
  externalSource: 'github',
  externalKey: 'acme/web#12',
  externalId: 'I_1',
  ...over,
});

const settings = (
  labelColumnOverrides: Record<string, BoardColumn> = {},
  learnedLabelColumns: Record<string, BoardColumn> = {},
): LabelSettings => ({ labelColumnOverrides, learnedLabelColumns });

describe('resolveMove', () => {
  it('is a no-op when dropped into the same column', () => {
    expect(resolveMove(task({ status: 'pending' }), 'todo')).toMatchObject({
      noop: true,
      target: null,
    });
  });

  it('gives the issue the column that was dropped on, and the local status with it', () => {
    expect(resolveMove(task({ status: 'pending' }), 'in-review')).toMatchObject({
      localStatus: 'in-review',
      target: 'in-review',
      preBlockStatus: null,
      noop: false,
    });
  });

  it('offers the pre-block column, read from where the card RESTS', () => {
    // Mid-run: `status` is the run's, `preRunStatus` is the human's. Un-blocking must restore
    // the column the human left it in, never the run state.
    const r = resolveMove(task({ status: 'running', preRunStatus: 'in-progress' }), 'blocked');
    expect(r).toMatchObject({
      localStatus: 'blocked',
      preBlockStatus: 'in-progress',
      target: 'blocked',
    });
  });

  it('says nothing about a card GitHub has never heard of', () => {
    // Both halves still resolve — the card moves — but there is no issue to write to.
    expect(resolveMove(task({ source: 'adhoc', externalSource: null }), 'done')).toMatchObject({
      localStatus: 'done',
      target: null,
    });
    expect(
      resolveMove(task({ source: 'jira', externalSource: 'jira', externalKey: 'AB-1' }), 'done')
        .target,
    ).toBeNull();
    expect(resolveMove(task({ externalKey: null }), 'done').target).toBeNull();
  });
});

describe('planLabelChange', () => {
  it('closes the issue for DONE, and reopens it for every move out of DONE', () => {
    expect(planLabelChange([], 'open', 'done', settings())).toMatchObject({
      state: 'closed',
      addLabel: null,
      removeLabels: [],
      columnLabel: null,
      stateAfter: 'closed',
    });
    expect(planLabelChange([], 'closed', 'todo', settings())).toMatchObject({
      state: 'open',
      addLabel: null,
      stateAfter: 'open',
    });
  });

  it('leaves the state alone when the issue already says the right thing', () => {
    expect(planLabelChange([], 'closed', 'done', settings())?.state).toBeNull();
    expect(planLabelChange([], 'open', 'todo', settings())?.state).toBeNull();
    // A state neither we nor `resolveGitHubColumn` has heard of reads as closed, in both
    // places — so a DONE drop onto it is not a needless PATCH.
    expect(planLabelChange([], 'archived', 'done', settings())?.state).toBeNull();
  });

  it('adds no label for TO DO or DONE — the issue state already says both', () => {
    const map = settings({ wip: 'in-progress' });
    expect(planLabelChange([], 'open', 'todo', map)?.addLabel).toBeNull();
    expect(planLabelChange([], 'open', 'done', map)?.addLabel).toBeNull();
  });

  it('refuses IN PROGRESS and IN REVIEW when no label means them', () => {
    // The refusal is the point: applied locally, the card would sit in a column the issue
    // never entered, and the next poll would drag it straight back out.
    expect(planLabelChange(['bug'], 'open', 'in-progress', settings())).toBeNull();
    expect(planLabelChange(['bug'], 'open', 'in-review', settings())).toBeNull();
  });

  it("adds the user's mapped label, and drops the one that spoke for the old column", () => {
    const map = settings({ wip: 'in-progress', 'in review': 'in-review' });
    expect(planLabelChange(['wip', 'backend'], 'open', 'in-review', map)).toMatchObject({
      state: null,
      addLabel: 'in review',
      removeLabels: ['wip'],
      columnLabel: 'in review',
      labelsAfter: ['backend', 'in review'],
    });
  });

  it('prefers a mapped label already on the issue over one it would have to add', () => {
    const map = settings({ doing: 'in-progress', wip: 'in-progress' });
    expect(planLabelChange(['wip'], 'open', 'in-progress', map)).toMatchObject({
      addLabel: null,
      removeLabels: [],
      columnLabel: 'wip',
      labelsAfter: ['wip'],
    });
  });

  it('takes the learned map only when the user has not spoken', () => {
    const map = settings({ 'in review': 'in-review' }, { wip: 'in-progress' });
    expect(planLabelChange([], 'open', 'in-progress', map)?.addLabel).toBe('wip');
  });

  it('strips a stale column label on the way into DONE, so reopening cannot resurrect it', () => {
    // Nothing removes a label when you close an issue. Left behind, `in review` would speak
    // again the moment the card is dragged back out of DONE.
    const map = settings({ 'in review': 'in-review' });
    expect(planLabelChange(['in review', 'bug'], 'open', 'done', map)).toMatchObject({
      state: 'closed',
      removeLabels: ['in review'],
      labelsAfter: ['bug'],
    });
  });

  it('never removes a label nobody mapped, however blocked-ish it reads', () => {
    // "Awaiting triage" reads as BLOCKED to the name tier and may well be a rota nobody wants
    // a drag to strip. A guess is good enough to ADD a meaning, not to delete somebody's data.
    const plan = planLabelChange(['awaiting triage', 'wip'], 'open', 'in-review', {
      labelColumnOverrides: { 'in review': 'in-review' },
      learnedLabelColumns: { wip: 'in-progress' },
    });
    expect(plan).toMatchObject({ addLabel: 'in review', removeLabels: ['wip'] });
  });

  it('reads a label by NAME when no map does, and adds nothing — it is already there', () => {
    // The tier that makes a drag teach the app something. See `shouldLearnLabel`.
    expect(
      planLabelChange(['Status: In-Progress'], 'open', 'in-progress', settings()),
    ).toMatchObject({ addLabel: null, columnLabel: 'Status: In-Progress' });
    expect(planLabelChange(['needs review'], 'open', 'in-review', settings())?.columnLabel).toBe(
      'needs review',
    );
  });

  it('lets a learned entry speak for anything except a name that says blocked', () => {
    // The poisoned entry `resolveStatusColumn` refuses on JIRA, one forge over: a drag that
    // "succeeded" into Blocked must not make "blocked" mean IN PROGRESS for ever after.
    expect(
      planLabelChange(['blocked'], 'open', 'in-progress', settings({}, { blocked: 'in-progress' })),
    ).toBeNull();
    // The human may still say so explicitly.
    expect(
      planLabelChange(['blocked'], 'open', 'in-progress', settings({ blocked: 'in-progress' }))
        ?.columnLabel,
    ).toBe('blocked');
  });
});

describe('shouldLearnLabel', () => {
  it('learns the label a drag proved the meaning of', () => {
    expect(shouldLearnLabel('in progress', 'in-progress', settings())).toBe(true);
    expect(shouldLearnLabel('needs review', 'in-review', settings())).toBe(true);
  });

  it('says nothing new about a label the user or the app already mapped', () => {
    expect(shouldLearnLabel('wip', 'in-progress', settings({ wip: 'in-progress' }))).toBe(false);
    expect(shouldLearnLabel('wip', 'in-progress', settings({}, { wip: 'in-progress' }))).toBe(
      false,
    );
    // The user's map outranks anything we could infer, even when it disagrees.
    expect(shouldLearnLabel('wip', 'in-review', settings({ wip: 'in-progress' }))).toBe(false);
  });

  it('never learns a name that says blocked — the map is shown to the human as facts', () => {
    expect(shouldLearnLabel('blocked', 'in-progress', settings())).toBe(false);
    expect(shouldLearnLabel('on hold', 'in-review', settings())).toBe(false);
    expect(shouldLearnLabel('blocked', 'blocked', settings())).toBe(false);
  });

  it('learns nothing from a blank label, or from one that already resolves there', () => {
    expect(shouldLearnLabel('   ', 'in-progress', settings())).toBe(false);
    // An unmapped label on an open issue already means TO DO, so a TO DO drop teaches nothing.
    expect(shouldLearnLabel('bug', 'todo', settings())).toBe(false);
  });
});
