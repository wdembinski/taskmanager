import { describe, expect, it } from 'vitest';
import {
  GIT_LOG_FORMAT,
  assignLanes,
  buildGitGraph,
  emptyGitGraph,
  parseGitLog,
  withRefRoles,
  type GitCommitNode,
} from './gitGraph';

/** A commit with only the fields lane assignment looks at: its sha and its parents. */
const commit = (sha: string, ...parents: string[]): GitCommitNode => ({
  sha,
  shortSha: sha,
  parents,
  author: 'Someone',
  authoredAt: 0,
  subject: sha,
  refs: [],
});

/** The lane of every commit, in the order they went in — what the drawing puts in columns. */
const lanesOf = (commits: GitCommitNode[]): number[] => assignLanes(commits).lanes;

/** The edge `from → to`, so a failure names commits rather than array indices. */
const edge = (commits: GitCommitNode[], from: string, to: string) =>
  assignLanes(commits).edges.find((e) => e.fromSha === from && e.toSha === to);

describe('assignLanes — linear history', () => {
  // c3 ── c2 ── c1, newest first. One branch, one column, all the way down.
  const history = [commit('c3', 'c2'), commit('c2', 'c1'), commit('c1')];

  it('keeps a single line in one lane', () => {
    expect(lanesOf(history)).toEqual([0, 0, 0]);
    expect(assignLanes(history).laneCount).toBe(1);
  });

  it('draws one edge per parent link, first-parent all the way down', () => {
    const { edges } = assignLanes(history);
    expect(edges).toHaveLength(2);
    expect(edges.every((e) => e.parentIndex === 0)).toBe(true);
    expect(edge(history, 'c3', 'c2')).toMatchObject({
      fromRow: 0,
      toRow: 1,
      fromLane: 0,
      toLane: 0,
    });
  });
});

describe('assignLanes — a fork', () => {
  // Two tips on the same parent: `main`, and a card's branch that hasn't merged yet.
  //   main ──┐
  //   card ──┴── base
  const history = [commit('main', 'base'), commit('card', 'base'), commit('base')];

  it('gives the second tip its own lane', () => {
    expect(lanesOf(history)).toEqual([0, 1, 0]);
    expect(assignLanes(history).laneCount).toBe(2);
  });

  it('brings the second lane back to the shared parent', () => {
    expect(edge(history, 'card', 'base')).toMatchObject({ fromLane: 1, toLane: 0 });
    expect(edge(history, 'main', 'base')).toMatchObject({ fromLane: 0, toLane: 0 });
  });

  it('reuses a freed lane rather than growing a new one', () => {
    // A commit on top of `main` must land back in lane 0, not push the graph wider.
    const later = [commit('tip', 'main'), ...history];
    expect(lanesOf(later)).toEqual([0, 0, 1, 0]);
    expect(assignLanes(later).laneCount).toBe(2);
  });
});

describe('assignLanes — a merge commit', () => {
  // A card's branch landing in base: `merge` has two parents, the second being the branch.
  const history = [
    commit('merge', 'base2', 'card'),
    commit('base2', 'base1'),
    commit('card', 'base1'),
    commit('base1'),
  ];

  it('keeps the first parent in the merge commit’s own lane', () => {
    expect(lanesOf(history)).toEqual([0, 0, 1, 0]);
    expect(edge(history, 'merge', 'base2')).toMatchObject({
      fromLane: 0,
      toLane: 0,
      parentIndex: 0,
    });
  });

  it('fans the merged-in parent out to a lane of its own, and says which parent it was', () => {
    expect(edge(history, 'merge', 'card')).toMatchObject({
      fromLane: 0,
      toLane: 1,
      parentIndex: 1,
    });
    expect(assignLanes(history).laneCount).toBe(2);
  });
});

describe('assignLanes — two roots', () => {
  // Two histories that never meet: an unrelated repo grafted in, or an `--orphan` branch.
  const history = [commit('a1', 'a0'), commit('b1', 'b0'), commit('a0'), commit('b0')];

  it('keeps each history in its own lane and never crosses them', () => {
    expect(lanesOf(history)).toEqual([0, 1, 0, 1]);
    expect(assignLanes(history).laneCount).toBe(2);
    expect(edge(history, 'a1', 'a0')).toMatchObject({ fromLane: 0, toLane: 0 });
    expect(edge(history, 'b1', 'b0')).toMatchObject({ fromLane: 1, toLane: 1 });
  });

  it('has nothing to lay out for an empty history', () => {
    expect(assignLanes([])).toEqual({ lanes: [], laneCount: 0, edges: [] });
  });
});

describe('assignLanes — history cut off by the limit', () => {
  // The oldest commit read still names a parent, which `-n` left outside the window.
  const history = [commit('c2', 'c1'), commit('c1', 'c0')];

  it('drops the edge to a parent that was not read, without reserving a lane for it', () => {
    const { edges, laneCount } = assignLanes(history);
    expect(edges.map((e) => e.toSha)).toEqual(['c1']);
    expect(laneCount).toBe(1);
  });
});

// ---- The parser, against captured `git log` output ---------------------------------

/** The two separators the format uses. Spelled out because both are invisible in a file. */
const NUL = '\u0000';
const RS = '\u001e';

/**
 * One record exactly as `git log --format=<GIT_LOG_FORMAT>` writes it: the seven fields with
 * NUL between them, the record separator, and git's own trailing newline.
 *
 * Re-assembled from the captured fields rather than pasted whole, because a NUL pasted into a
 * source file is both unreadable and easily eaten by an editor. The test below pins
 * {@link GIT_LOG_FORMAT} itself, so this helper cannot quietly stop matching what git emits.
 */
const record = (...fields: string[]): string => fields.join(NUL) + RS + '\n';

const MERGE_SHA = '3b8e0c1f6a4d2e5b7c9081f2a3b4c5d6e7f80912';
const CARD_SHA = '5f6e7d8c9b0a1234567890abcdef1234567890ab';
const ROOT_SHA = '9d1c2b3a4f5e60718293a4b5c6d7e8f9012345ab';

/** Captured from `git log --date-order --all -n 3 --decorate=full --format=…`. */
const CAPTURED =
  record(
    MERGE_SHA,
    '3b8e0c1',
    `${ROOT_SHA} ${CARD_SHA}`,
    'Wojciech Dembinski',
    '1753970000',
    'HEAD -> refs/heads/main, refs/remotes/origin/main, tag: refs/tags/v0.64.5',
    "Merge branch 'feat/read-the-commit-graph'",
  ) +
  record(
    CARD_SHA,
    '5f6e7d8',
    ROOT_SHA,
    'Claude',
    '1753969000',
    'refs/heads/feat/read-the-commit-graph',
    'feat(git): read the repository commit graph',
  ) +
  record(ROOT_SHA, '9d1c2b3', '', 'Wojciech Dembinski', '1753960000', '', 'Initial commit');

describe('parseGitLog', () => {
  const commits = parseGitLog(CAPTURED);

  it('asks git for exactly the fields, and the separators, it parses back', () => {
    expect(GIT_LOG_FORMAT).toBe('%H%x00%h%x00%P%x00%an%x00%at%x00%D%x00%s%x1e');
  });

  it('reads every commit, and no phantom one from the trailing separator', () => {
    expect(commits).toHaveLength(3);
    expect(commits.map((c) => c.shortSha)).toEqual(['3b8e0c1', '5f6e7d8', '9d1c2b3']);
  });

  it('splits a merge commit’s parents, and leaves a root commit with none', () => {
    expect(commits[0].parents).toEqual([ROOT_SHA, CARD_SHA]);
    expect(commits[1].parents).toEqual([ROOT_SHA]);
    expect(commits[2].parents).toEqual([]);
  });

  it('keeps the author, the author date in seconds, and a subject with a quote in it', () => {
    expect(commits[0].author).toBe('Wojciech Dembinski');
    expect(commits[0].authoredAt).toBe(1753970000);
    expect(commits[0].subject).toBe("Merge branch 'feat/read-the-commit-graph'");
  });

  it('separates a branch, its remote, its tag, and where HEAD is', () => {
    expect(commits[0].refs).toEqual([
      { name: 'main', kind: 'branch', role: 'plain', isHead: true },
      { name: 'origin/main', kind: 'remote', role: 'plain', isHead: false },
      { name: 'v0.64.5', kind: 'tag', role: 'plain', isHead: false },
    ]);
  });

  it('reads a branch name containing slashes, and a commit with no refs at all', () => {
    expect(commits[1].refs).toEqual([
      { name: 'feat/read-the-commit-graph', kind: 'branch', role: 'plain', isHead: false },
    ]);
    expect(commits[2].refs).toEqual([]);
  });

  it('ignores a record it cannot make sense of instead of throwing', () => {
    expect(parseGitLog('')).toEqual([]);
    expect(parseGitLog(`half a record${NUL}two fields${RS}\n`)).toEqual([]);
  });

  it('lays the captured history out with the branch beside the line it merged into', () => {
    const { lanes, laneCount } = assignLanes(commits);
    expect(lanes).toEqual([0, 1, 0]);
    expect(laneCount).toBe(2);
  });
});

describe('withRefRoles', () => {
  const commits = parseGitLog(CAPTURED);
  const marked = withRefRoles(commits, {
    baseBranch: 'main',
    cardBranches: new Map([['feat/read-the-commit-graph', 't-42']]),
  });

  it('marks the base branch, and the branch a card is working on', () => {
    expect(marked[0].refs[0]).toMatchObject({ name: 'main', role: 'base' });
    expect(marked[1].refs[0]).toMatchObject({ role: 'card', taskId: 't-42' });
  });

  it('leaves the remote and the tag alone — they would only double the highlight', () => {
    expect(marked[0].refs[1].role).toBe('plain');
    expect(marked[0].refs[2].role).toBe('plain');
  });

  it('does not touch the commits it was given', () => {
    expect(commits[0].refs[0].role).toBe('plain');
  });
});

describe('buildGitGraph', () => {
  it('carries the base branch and the truncation flag alongside the layout', () => {
    const graph = buildGitGraph([commit('c2', 'c1'), commit('c1')], {
      baseBranch: 'development',
      truncated: true,
    });
    expect(graph.commits).toHaveLength(2);
    expect(graph.lanes).toEqual([0, 0]);
    expect(graph.baseBranch).toBe('development');
    expect(graph.truncated).toBe(true);
    expect(graph.reason).toBeUndefined();
  });

  it('has an empty form that explains itself', () => {
    const graph = emptyGitGraph('This folder is not a git repository.');
    expect(graph.commits).toEqual([]);
    expect(graph.laneCount).toBe(0);
    expect(graph.reason).toContain('not a git repository');
  });
});
