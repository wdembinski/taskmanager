import { describe, expect, it } from 'vitest';
import type { GitGraphEdge, GitRef } from '@tm/shared/gitGraph';
import { PERSONAL_PROJECT_ID, type Project, type Task } from '@tm/shared/model';
import { LOCAL_TARGET } from '@tm/shared/execTarget';
import {
  DOT_RADIUS,
  LANE_ORIGIN,
  LANE_WIDTH,
  ROW_HEIGHT,
  defaultGraphProjectId,
  edgePath,
  gutterWidth,
  laneX,
  refLabel,
  relativeAge,
  rowY,
  visibleRefs,
} from './gitGraphView';

const edge = (over: Partial<GitGraphEdge>): GitGraphEdge => ({
  fromSha: 'child',
  toSha: 'parent',
  fromRow: 0,
  toRow: 1,
  fromLane: 0,
  toLane: 0,
  parentIndex: 0,
  ...over,
});

const ref = (over: Partial<GitRef> & { name: string }): GitRef => ({
  kind: 'branch',
  role: 'plain',
  isHead: false,
  ...over,
});

const task = (over: Partial<Task> & { id: string }): Task => ({
  projectId: PERSONAL_PROJECT_ID,
  phase: '',
  title: over.id,
  status: 'pending',
  sessionId: null,
  order: 0,
  dependsOn: [],
  source: 'adhoc',
  isContract: false,
  isScaffold: false,
  ...over,
});

const project = (id: string): Project => ({
  id,
  name: id,
  path: `/repos/${id}`,
  planPath: '',
  defaultModel: 'sonnet',
  planningModel: null,
  defaultPermissionMode: 'acceptEdits',
  concurrency: 1,
  useWorktrees: true,
  baseBranch: '',
  writeBackPlan: false,
  autoRelease: false,
  autoIntegrate: null,
  planAligned: true,
  kind: 'agent',
  jiraEpicKeys: [],
  ticketPrefix: '',
  target: LOCAL_TARGET,
  instructions: '',
  color: '',
  createdAt: 0,
});

describe('geometry', () => {
  it('puts a commit at the middle of its own row', () => {
    expect(rowY(0)).toBe(ROW_HEIGHT / 2);
    expect(rowY(3) - rowY(2)).toBe(ROW_HEIGHT);
  });

  it('spaces lanes evenly from the gutter’s left edge', () => {
    expect(laneX(0)).toBe(LANE_ORIGIN);
    expect(laneX(2) - laneX(1)).toBe(LANE_WIDTH);
  });

  it('leaves room for a dot on either side of the widest lane', () => {
    // The gutter has to hold the last lane's dot AND the padding lane 0 gets on its left,
    // or a two-branch repo draws its right-hand lane under the subject text.
    expect(gutterWidth(3)).toBeGreaterThan(laneX(2) + DOT_RADIUS);
    // No lanes at all (an empty or unreadable graph) takes no width, so the reason for it
    // starts at the pane's own edge rather than indented under a gutter that draws nothing.
    expect(gutterWidth(0)).toBe(0);
  });
});

describe('edgePath', () => {
  it('draws a straight line when the parent is in the same lane', () => {
    expect(edgePath(edge({}))).toBe(`M ${laneX(0)} ${rowY(0)} L ${laneX(0)} ${rowY(1)}`);
  });

  it('keeps a first parent in the child’s lane until the join', () => {
    // The branch owns its column for its whole length and only bends in at the commit it
    // actually joins — so the vertical run is drawn at the CHILD's x.
    const d = edgePath(edge({ fromLane: 1, toLane: 0, toRow: 4, parentIndex: 0 }));
    expect(d).toBe(
      `M ${laneX(1)} ${rowY(0)} L ${laneX(1)} ${rowY(4) - ROW_HEIGHT / 2} ` +
        `Q ${laneX(1)} ${rowY(4)} ${laneX(0)} ${rowY(4)}`,
    );
  });

  it('fans a merge’s second parent out at once, then runs down its lane', () => {
    const d = edgePath(edge({ fromLane: 0, toLane: 1, toRow: 3, parentIndex: 1 }));
    expect(d).toBe(
      `M ${laneX(0)} ${rowY(0)} Q ${laneX(1)} ${rowY(0)} ${laneX(1)} ${rowY(0) + ROW_HEIGHT / 2} ` +
        `L ${laneX(1)} ${rowY(3)}`,
    );
  });

  it('bends inside its own gap between adjacent rows', () => {
    // The corner may never overshoot the commit at the far end: half the vertical run is the
    // ceiling, and between neighbours that is exactly half a row.
    const d = edgePath(edge({ fromLane: 0, toLane: 2, toRow: 1, parentIndex: 1 }));
    expect(d).toContain(`${laneX(2)} ${rowY(0) + ROW_HEIGHT / 2}`);
  });
});

describe('refLabel', () => {
  const tasks = new Map([['t1', task({ id: 't1', title: 'Add SSO' })]]);

  it('shows the CARD, not the branch the app generated for it', () => {
    const label = refLabel(
      ref({ name: 'orch/t1', role: 'card', taskId: 't1' }),
      tasks,
      new Set<string>(),
    );
    expect(label.name).toBe('Add SSO');
    expect(label.title).toContain('orch/t1');
    expect(label.live).toBe(false);
  });

  it('colours a card branch only while its agent is actually running', () => {
    const cardRef = ref({ name: 'orch/t1', role: 'card', taskId: 't1' });
    expect(refLabel(cardRef, tasks, new Set(['t1'])).live).toBe(true);
    expect(refLabel(cardRef, tasks, new Set(['t2'])).live).toBe(false);
  });

  it('falls back to the branch name for a card this board does not hold', () => {
    // A delegated card lives on the Personal board; a graph opened elsewhere never sees it.
    const label = refLabel(
      ref({ name: 'orch/gone', role: 'card', taskId: 'gone' }),
      tasks,
      new Set<string>(),
    );
    expect(label.name).toBe('orch/gone');
  });

  it('marks the base branch and never lights it', () => {
    const label = refLabel(ref({ name: 'main', role: 'base' }), tasks, new Set(['t1']));
    expect(label.isBase).toBe(true);
    expect(label.live).toBe(false);
  });
});

describe('visibleRefs', () => {
  it('drops remote-tracking branches, which are the same commit twice', () => {
    const names = visibleRefs([
      ref({ name: 'origin/main', kind: 'remote' }),
      ref({ name: 'main', role: 'base' }),
    ]).map((r) => r.name);
    expect(names).toEqual(['main']);
  });

  it('drops a detached HEAD, which names no branch', () => {
    expect(visibleRefs([ref({ name: 'HEAD', kind: 'other', isHead: true })])).toEqual([]);
  });

  it('puts the refs the app has an opinion about first', () => {
    const names = visibleRefs([
      ref({ name: 'v1.2.0', kind: 'tag' }),
      ref({ name: 'main', role: 'base' }),
      ref({ name: 'orch/t1', role: 'card', taskId: 't1' }),
    ]).map((r) => r.name);
    expect(names).toEqual(['orch/t1', 'main', 'v1.2.0']);
  });
});

describe('relativeAge', () => {
  const now = Date.UTC(2026, 7, 3, 12, 0, 0);
  const secondsAgo = (n: number): number => Math.round(now / 1000) - n;

  it('reads relatively while relative is the useful reading', () => {
    expect(relativeAge(secondsAgo(5), now)).toBe('now');
    expect(relativeAge(secondsAgo(90), now)).toBe('1m');
    expect(relativeAge(secondsAgo(3 * 3600), now)).toBe('3h');
    expect(relativeAge(secondsAgo(3 * 86400), now)).toBe('3d');
  });

  it('switches to a date once nobody would count the days back', () => {
    const old = relativeAge(secondsAgo(40 * 86400), now);
    expect(old).not.toMatch(/^\d+d$/);
    // Same year as `now`, so the year would be noise on every row.
    expect(old).not.toContain('2026');
  });

  it('names the year once it is not this one', () => {
    expect(relativeAge(Math.round(Date.UTC(2024, 2, 12) / 1000), now)).toContain('2024');
  });

  it('never reports the future as an age', () => {
    // Clock skew between machines is real, and "-4m" on a commit reads as a bug in the app.
    expect(relativeAge(secondsAgo(-600), now)).toBe('now');
  });
});

describe('defaultGraphProjectId', () => {
  const repos = [project('a'), project('b')];

  it('opens on the repo the selected card actually runs in', () => {
    const card = task({ id: 't1', projectId: 'plan', agentProjectId: 'b' });
    expect(defaultGraphProjectId(repos, card)).toBe('b');
  });

  it('ignores where a card is FILED — the graph is a picture of a working copy', () => {
    const card = task({ id: 't1', projectTagId: 'a', agentProjectId: null });
    expect(defaultGraphProjectId(repos, card)).toBeNull();
  });

  it('ignores an agent project that is no longer in the app', () => {
    const card = task({ id: 't1', agentProjectId: 'gone' });
    expect(defaultGraphProjectId(repos, card)).toBeNull();
  });

  it('picks the only repo there is, since that choice has one answer', () => {
    expect(defaultGraphProjectId([project('a')], null)).toBe('a');
    expect(defaultGraphProjectId(repos, null)).toBeNull();
    expect(defaultGraphProjectId([], null)).toBeNull();
  });
});
