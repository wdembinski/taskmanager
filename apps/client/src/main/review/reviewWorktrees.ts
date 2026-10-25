/**
 * The throwaway checkouts an AI review runs against (F16.7,
 * `docs/plan/feature-roadmap/F16-ai-reviewer.md` §"Worktree").
 *
 * **Detached, so the review leaves no trace.** Each review gets
 * `git worktree add --detach <root>/<reviewId> <headSha>`: no branch is created and no ref
 * moves, so the project's main checkout — its HEAD, index and every `refs/heads/*` — is
 * exactly as it was before the review and after it. Removing the worktree removes the review.
 *
 * **Outside any repo.** The root is `userData/review-worktrees/`, never inside a project: a
 * checkout nested in a work tree is part of that tree (it shows up in `git status`, and a
 * tool walking up for `.git` finds the wrong repo).
 *
 * **A WSL project's root lives inside the distro** —
 * `<distro $HOME>/.local/share/claude-orchestrator/review-worktrees`, cached per distro —
 * for the reason `WorktreeManager.workspaceFor` gives: a Linux `git` cannot sanely own a
 * worktree on the Windows side of a 9p share, and the path it records would mean nothing to
 * the other machine. "Under userData" is the local case of the same rule.
 *
 * **Who cleans up.** The review runner (F16.8) calls {@link ReviewWorktrees.create} before a
 * launch and {@link ReviewWorktrees.remove} when the run settles; boot owns
 * {@link ReviewWorktrees.sweep}, which removes whatever a crash left behind. Nothing here
 * throws: a removal runs on settle, where a throw would mask the run's real result, so
 * failures come back as text.
 */
import { existsSync, mkdirSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import type { Project } from '@shared/model';
import { hostFor, hostJoin, type ExecHost, type ExecTarget } from '../exec';
import { addDetachedWorktree, listWorktrees, pruneWorktrees, removeWorktree } from '../git';

/** Same retry as `WorktreeManager`'s debris removal: a lock is usually a process on its way out. */
const RM_RETRY = { maxRetries: 4, retryDelay: 200 } as const;

/** A review id becomes a path segment, so nothing that could leave the root is accepted. */
const REVIEW_ID = /^[A-Za-z0-9_-]+$/;

export type CreateResult = { ok: true; path: string } | { ok: false; reason: string };

export interface SweepResult {
  removed: string[];
  failed: Array<{ path: string; why: string }>;
}

function errText(err: unknown): string {
  return (err as Error)?.message ?? String(err);
}

export class ReviewWorktrees {
  private readonly wslRoots = new Map<string, string>();

  /** @param localRoot Where local projects' review worktrees go (`userData/review-worktrees`). */
  constructor(
    private readonly localRoot: string,
    private readonly hostOf: (t: ExecTarget) => ExecHost = hostFor,
  ) {}

  /** Root for the project's host: `localRoot`, or the distro root (cached per distro). */
  async rootFor(project: Project): Promise<{ host: ExecHost; root: string }> {
    const host = this.hostOf(project.target);
    if (project.target.kind !== 'wsl') return { host, root: this.localRoot };

    const { distro } = project.target;
    let root = this.wslRoots.get(distro);
    if (!root) {
      root = hostJoin(
        await host.homeDir(),
        '.local',
        'share',
        'claude-orchestrator',
        'review-worktrees',
      );
      this.wslRoots.set(distro, root);
    }
    return { host, root };
  }

  /** Where a review's worktree lives, in the host's shape. */
  async pathFor(project: Project, reviewId: string): Promise<string> {
    const { root } = await this.rootFor(project);
    return hostJoin(root, reviewId);
  }

  /** Check `sha` out, detached, at `<root>/<reviewId>`. Refuses rather than throws. */
  async create(project: Project, reviewId: string, sha: string): Promise<CreateResult> {
    if (!REVIEW_ID.test(reviewId)) {
      return { ok: false, reason: `"${reviewId}" is not a valid review id.` };
    }
    try {
      const { host, root } = await this.rootFor(project);
      const path = hostJoin(root, reviewId);
      if (existsSync(host.toApp(path))) {
        // A stale one from an earlier attempt at the same review: clear it first.
        const why = await this.remove(project, reviewId);
        if (existsSync(host.toApp(path))) {
          return {
            ok: false,
            reason: `A review worktree already exists at ${path} and could not be removed${why ? `: ${why}` : '.'}`,
          };
        }
      }
      mkdirSync(host.toApp(root), { recursive: true });
      const res = await addDetachedWorktree(project.path, path, sha, host);
      if (res.code !== 0) {
        const stderr = res.stderr.trim() || `git exited ${res.code}`;
        return { ok: false, reason: `Could not check out ${sha} for review: ${stderr}` };
      }
      return { ok: true, path };
    } catch (err) {
      return { ok: false, reason: `Could not create the review worktree: ${errText(err)}` };
    }
  }

  /**
   * Remove a review's worktree. Returns null once the directory is gone (including when it
   * never existed), or the failure text. Never throws.
   */
  async remove(project: Project, reviewId: string): Promise<string | null> {
    if (!REVIEW_ID.test(reviewId)) return `"${reviewId}" is not a valid review id.`;
    try {
      const { host, root } = await this.rootFor(project);
      const path = hostJoin(root, reviewId);
      const res = await removeWorktree(project.path, path, host);
      let why: string | null = null;
      if (existsSync(host.toApp(path))) {
        // git no longer knows it (or would not let go): plain debris removal.
        try {
          rmSync(host.toApp(path), { recursive: true, force: true, ...RM_RETRY });
        } catch (err) {
          why = `${errText(err)}${res.code !== 0 && res.stderr.trim() ? ` (git: ${res.stderr.trim()})` : ''}`;
        }
      }
      await pruneWorktrees(project.path, host);
      return why;
    } catch (err) {
      return errText(err);
    }
  }

  /**
   * Remove every review worktree not in `keep` (empty at boot, when no review is live). Per
   * root: (1) ask each project's git to remove its worktrees under the root; (2) delete every
   * remaining child directory — orphans git no longer knows; (3) prune each project's admin
   * records. A missing root is nothing to do. Failures are collected, never thrown.
   */
  async sweep(
    projects: readonly Project[],
    keep: ReadonlySet<string> = new Set(),
  ): Promise<SweepResult> {
    const result: SweepResult = { removed: [], failed: [] };

    const byRoot = new Map<string, { host: ExecHost; root: string; projects: Project[] }>();
    for (const project of projects) {
      try {
        const { host, root } = await this.rootFor(project);
        const group = byRoot.get(root) ?? { host, root, projects: [] };
        group.projects.push(project);
        byRoot.set(root, group);
      } catch (err) {
        result.failed.push({ path: project.path, why: errText(err) });
      }
    }

    for (const { host, root, projects: group } of byRoot.values()) {
      const appRoot = host.toApp(root);
      if (!existsSync(appRoot)) continue;
      const childOf = childMatcher(host, root, appRoot);

      // (1) Worktrees git still knows: let git remove them, so its admin record goes too.
      for (const project of group) {
        for (const entry of await listWorktrees(project.path, host)) {
          const id = childOf(entry.path);
          if (id === null || keep.has(id)) continue;
          await removeWorktree(project.path, entry.path, host);
          if (!existsSync(host.toApp(hostJoin(root, id)))) {
            result.removed.push(hostJoin(root, id));
          }
          // Still there: step (2) deletes it as debris and says so if it can't.
        }
      }

      // (2) Directories git never knew, or has forgotten (their `.git` file is gone).
      let children: string[] = [];
      try {
        children = readdirSync(appRoot, { withFileTypes: true })
          .filter((d) => d.isDirectory())
          .map((d) => d.name);
      } catch (err) {
        result.failed.push({ path: root, why: errText(err) });
      }
      for (const name of children) {
        if (keep.has(name)) continue;
        const path = hostJoin(root, name);
        try {
          rmSync(host.toApp(path), { recursive: true, force: true, ...RM_RETRY });
          result.removed.push(path);
        } catch (err) {
          result.failed.push({ path, why: errText(err) });
        }
      }

      // (3) Drop the admin records of anything deleted out from under git.
      for (const project of group) await pruneWorktrees(project.path, host);
    }
    return result;
  }
}

/**
 * Turn a path git printed into the review id it names — the direct child of `root` — or
 * null when it lies elsewhere. git prints `C:/…` on Windows, so separators are normalised,
 * and case is folded where the filesystem ignores it. A local root is also matched through
 * its real path, since git records the resolved one (no 8.3 short names, no junctions).
 */
function childMatcher(host: ExecHost, root: string, appRoot: string): (p: string) => string | null {
  const foldCase = process.platform === 'win32' && host.target.kind !== 'wsl';
  const slashes = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '');
  const fold = (s: string) => (foldCase ? s.toLowerCase() : s);
  const roots = new Set([fold(slashes(root))]);
  if (host.target.kind !== 'wsl') {
    try {
      roots.add(fold(slashes(realpathSync.native(appRoot))));
    } catch {
      // the plain root is still compared
    }
  }
  return (p) => {
    const path = slashes(p);
    for (const r of roots) {
      if (!fold(path).startsWith(`${r}/`)) continue;
      // The id keeps its own case: `keep` holds ids as the runner made them.
      const rest = path.slice(r.length + 1);
      if (rest && !rest.includes('/')) return rest;
    }
    return null;
  };
}
