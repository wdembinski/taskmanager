/**
 * The repository's commit graph — what `git log --graph` draws, as data.
 *
 * The board says what there is to do and the chain says in what order (`@shared/taskChain`);
 * neither can say what actually HAPPENED in the repo. A card that merged, a branch that is
 * three commits behind base, two agents whose branches forked from the same commit — all of
 * that lives in git and nowhere else, and today the only way to see it is to leave the app.
 *
 * This module is the pure half of showing it: the types that cross IPC, the parser that turns
 * one `git log` invocation into those types, and the **lane assignment** that decides which
 * column each commit is drawn in. No git, no React, no Electron — so the engine (which reads
 * the repo) and the board (which draws it) share one definition and cannot disagree about
 * where a line goes. The same discipline as `@shared/taskChain`.
 *
 * Reading the repo is `src/main/gitGraph.ts`; it runs the command and hands the output here.
 */

/** What kind of thing a decoration on a commit is, in git's own vocabulary. */
export type GitRefKind = 'branch' | 'remote' | 'tag' | 'other';

/**
 * Why a ref matters HERE.
 *
 * A repo is full of refs and almost none of them mean anything to this app. Two do: the
 * branch everything is integrated into, and the branch a card's agent is working on. Marking
 * them is what turns a generic commit graph into a picture of the board — so the drawing can
 * say "this is DEMO-101's branch" rather than "orch/abc123", and can tell at a glance which
 * cards have landed. Everything else is `plain`: still drawn, never highlighted.
 */
export type GitRefRole = 'base' | 'card' | 'plain';

/** One ref pointing at a commit — a branch, a remote-tracking branch, or a tag. */
export interface GitRef {
  /** The name as a human writes it: `main`, `origin/main`, `v0.64.5`. */
  name: string;
  kind: GitRefKind;
  role: GitRefRole;
  /** True when `HEAD` is on this ref — i.e. the branch the main checkout has out. */
  isHead: boolean;
  /** The card whose work this branch carries. Set only when `role === 'card'`. */
  taskId?: string;
}

/** One commit, with everything the drawing needs and nothing else. */
export interface GitCommitNode {
  /** The full 40-character SHA — the identity everything else joins on. */
  sha: string;
  /** Git's own abbreviation, for showing. Never used as a key: it can collide. */
  shortSha: string;
  /** Full SHAs of the parents, first-parent first. Empty for a root commit. */
  parents: string[];
  /** Author name (`%an`), not the committer: it is the person who wrote the change. */
  author: string;
  /** Author date as UNIX **seconds** (`%at`) — seconds, not milliseconds. */
  authoredAt: number;
  /** The first line of the message. `%s` is always one line, so this never wraps. */
  subject: string;
  /** Refs pointing at this commit, already role-marked. Usually empty. */
  refs: GitRef[];
}

/**
 * One parent link, in the coordinates the drawing works in.
 *
 * Both endpoints are given as a row (index into {@link GitGraph.commits}) and a lane, so the
 * UI draws a line without re-deriving anything — and so the "which commit is where" question
 * is answered once, here, where it is tested.
 */
export interface GitGraphEdge {
  /** The child — the newer commit, higher up the list. */
  fromSha: string;
  /** The parent. */
  toSha: string;
  fromRow: number;
  toRow: number;
  fromLane: number;
  toLane: number;
  /**
   * Which parent this is: `0` is the first parent (the branch's own line), `1` and up are the
   * ones a merge commit pulled IN. Drawings usually style those differently.
   */
  parentIndex: number;
}

/** The output of lane assignment: where every commit sits, and every line between them. */
export interface GitGraphLayout {
  /** Lane (column) per commit, index-aligned with the commits that went in. */
  lanes: number[];
  /** How many lanes are occupied — the width the drawing has to fit. */
  laneCount: number;
  edges: GitGraphEdge[];
}

/** A repository's history, ready to draw. The return of `git:graph`. */
export interface GitGraph extends GitGraphLayout {
  /** Newest first, in `git log --date-order` order. Empty when {@link reason} is set. */
  commits: GitCommitNode[];
  /**
   * The branch this project integrates into, resolved — the project's `baseBranch`, or the
   * name the main checkout happens to have out when it is left empty.
   */
  baseBranch: string;
  /** True when `limit` cut the history short, so the UI can say "older commits not shown". */
  truncated: boolean;
  /**
   * Why there is nothing to show, when there isn't: not a repo, no commits yet, folder gone,
   * git unreachable. Absent on success. Reading a graph is never an error — a project that
   * isn't a repo is a perfectly normal project, so this says so rather than throwing.
   */
  reason?: string;
}

/** Fields within one record, and records within the output — see {@link GIT_LOG_FORMAT}. */
const FIELD_SEP = '\u0000';
const RECORD_SEP = '\u001e';

/**
 * The `--format` the parser below expects, kept next to it so the two cannot drift.
 *
 * Fields are separated by NUL (`%x00`) because it is the one byte that cannot appear in a
 * commit message, an author name or a ref name — a plain delimiter like `|` would be eaten by
 * the first subject that contains one. Records end with ASCII "record separator" (`%x1e`)
 * rather than a newline, since `git log`'s own trailing newline would then be ambiguous.
 *
 * Read with `--decorate=full`, so `%D` names refs unambiguously (`refs/heads/x` vs
 * `refs/remotes/origin/x`) instead of leaving us to guess whether `origin/x` is a remote
 * branch or a local branch someone called `origin/x`.
 */
export const GIT_LOG_FORMAT = '%H%x00%h%x00%P%x00%an%x00%at%x00%D%x00%s%x1e';

/**
 * Turn one decoration entry (`refs/heads/main`, `tag: refs/tags/v1`, `HEAD`) into a ref.
 *
 * Everything arrives `role: 'plain'`; {@link withRefRoles} is what promotes the two that
 * matter, because only the engine knows the project's base branch and its cards.
 */
function parseRef(entry: string): GitRef | null {
  const trimmed = entry.trim();
  if (!trimmed) return null;

  // `HEAD -> refs/heads/main` is one entry naming one ref: the branch that is checked out.
  const arrow = trimmed.indexOf(' -> ');
  const isHead = arrow !== -1;
  const target = isHead ? trimmed.slice(arrow + 4).trim() : trimmed;

  // A bare `HEAD` (no arrow) means a detached checkout — worth drawing, but it is not a branch.
  if (target === 'HEAD') return { name: 'HEAD', kind: 'other', role: 'plain', isHead: true };

  const full = target.startsWith('tag: ') ? target.slice(5).trim() : target;
  const plain = { role: 'plain' as const, isHead };
  if (full.startsWith('refs/heads/')) {
    return { name: full.slice('refs/heads/'.length), kind: 'branch', ...plain };
  }
  if (full.startsWith('refs/remotes/')) {
    return { name: full.slice('refs/remotes/'.length), kind: 'remote', ...plain };
  }
  if (full.startsWith('refs/tags/')) {
    return { name: full.slice('refs/tags/'.length), kind: 'tag', ...plain };
  }
  // `refs/stash`, `refs/notes/commits`, anything a tool of theirs invented. Kept, not guessed at.
  return { name: full, kind: 'other', ...plain };
}

/**
 * Parse the stdout of `git log --decorate=full --format={@link GIT_LOG_FORMAT}`.
 *
 * Deliberately forgiving: a record that doesn't have all its fields is skipped rather than
 * throwing, because a graph is a nice-to-have view and one odd commit must not blank it.
 */
export function parseGitLog(stdout: string): GitCommitNode[] {
  const commits: GitCommitNode[] = [];
  for (const record of stdout.split(RECORD_SEP)) {
    // git prints its own newline after each record's format, so every record but the first
    // arrives with one glued to the front.
    const fields = record.replace(/^[\r\n]+/, '').split(FIELD_SEP);
    if (fields.length < 7) continue;
    const [sha, shortSha, parents, author, authoredAt, decorations, subject] = fields;
    if (!sha) continue;
    commits.push({
      sha,
      shortSha,
      parents: parents.split(' ').filter(Boolean),
      author,
      authoredAt: Number.parseInt(authoredAt, 10) || 0,
      subject,
      refs: decorations
        .split(',')
        .map(parseRef)
        .filter((ref): ref is GitRef => ref !== null),
    });
  }
  return commits;
}

/** Which branches in this repo the app has an opinion about. */
export interface RefOwnership {
  /** The resolved integration branch. `''` when it could not be resolved. */
  baseBranch: string;
  /** Local branch name → the id of the card whose work it carries. */
  cardBranches: ReadonlyMap<string, string>;
}

/**
 * Re-mark every ref with its role, returning new commits (the input is untouched).
 *
 * Only LOCAL branches are matched. A remote-tracking `origin/main` is the same commit as
 * `main` and would double every highlight, and a card's branch is local by construction —
 * the app has never pushed one.
 */
export function withRefRoles(commits: GitCommitNode[], owned: RefOwnership): GitCommitNode[] {
  return commits.map((commit) => ({
    ...commit,
    refs: commit.refs.map((ref) => {
      if (ref.kind !== 'branch') return ref;
      if (owned.baseBranch && ref.name === owned.baseBranch)
        return { ...ref, role: 'base' as const };
      const taskId = owned.cardBranches.get(ref.name);
      return taskId ? { ...ref, role: 'card' as const, taskId } : ref;
    }),
  }));
}

/**
 * Give every commit a lane, and every parent link a pair of coordinates.
 *
 * The algorithm is the one `gitk` and every graph drawer uses: walk the commits newest-first
 * keeping a list of ACTIVE lanes, where each lane is "reserved for the commit I expect next".
 * A commit takes the lane reserved for it (or the leftmost free one), hands that lane to its
 * FIRST parent — so a branch keeps one column for its whole length — and reserves a further
 * lane for each additional parent, which is what makes a merge fan out to the right. A lane
 * whose commit has been placed is released, so columns get reused rather than growing forever.
 *
 * Parents outside the window (history cut off by `-n`, or a shallow clone) are skipped
 * entirely: reserving a lane for a commit that will never arrive would leave a permanent gap
 * in the drawing and inflate `laneCount` for nothing.
 *
 * This relies on git's ordering guarantee — `--date-order`, like `--topo-order`, never shows
 * a parent before all of its children — which is why one pass suffices.
 */
export function assignLanes(commits: GitCommitNode[]): GitGraphLayout {
  const rowOf = new Map<string, number>();
  commits.forEach((commit, row) => rowOf.set(commit.sha, row));

  /** Per lane: the SHA it is being held for, or null when it is free. */
  const active: (string | null)[] = [];
  const lanes: number[] = [];
  const edges: GitGraphEdge[] = [];

  /** The lane already held for `sha`, else the leftmost free one, else a new one. */
  const claim = (sha: string): number => {
    const held = active.indexOf(sha);
    if (held !== -1) return held;
    const free = active.indexOf(null);
    if (free !== -1) {
      active[free] = sha;
      return free;
    }
    active.push(sha);
    return active.length - 1;
  };

  commits.forEach((commit, row) => {
    const lane = claim(commit.sha);
    lanes.push(lane);
    // Any OTHER lane still waiting for this same commit is a branch that has just merged back
    // into it; both lines end here, so those lanes are free again.
    for (let i = 0; i < active.length; i += 1) {
      if (active[i] === commit.sha) active[i] = null;
    }

    commit.parents.forEach((parent, parentIndex) => {
      const toRow = rowOf.get(parent);
      if (toRow === undefined) return; // outside the window — nothing to draw to
      let toLane: number;
      if (parentIndex === 0) {
        // The first parent continues this branch, so it keeps this lane — unless another lane
        // is already held for that parent, in which case the two lines converge into it.
        const held = active.indexOf(parent);
        if (held !== -1) {
          toLane = held;
        } else {
          active[lane] = parent;
          toLane = lane;
        }
      } else {
        toLane = claim(parent);
      }
      edges.push({
        fromSha: commit.sha,
        toSha: parent,
        fromRow: row,
        toRow,
        fromLane: lane,
        toLane,
        parentIndex,
      });
    });
  });

  const laneCount = lanes.reduce((widest, lane) => Math.max(widest, lane + 1), 0);
  return { lanes, laneCount, edges };
}

/** Lay out a parsed history and stamp on what the UI needs to caption it. */
export function buildGitGraph(
  commits: GitCommitNode[],
  meta: { baseBranch: string; truncated?: boolean },
): GitGraph {
  return {
    commits,
    ...assignLanes(commits),
    baseBranch: meta.baseBranch,
    truncated: meta.truncated ?? false,
  };
}

/** A graph with nothing in it, and the sentence explaining why. See {@link GitGraph.reason}. */
export function emptyGitGraph(reason: string, baseBranch = ''): GitGraph {
  return {
    commits: [],
    lanes: [],
    laneCount: 0,
    edges: [],
    baseBranch,
    truncated: false,
    reason,
  };
}
