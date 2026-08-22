/**
 * Live plan watcher (Phase 8, Deliverable C2).
 *
 * The whole app is driven by each project's plan file — and that file isn't static:
 * a human can edit it, and, crucially, the **agent can rewrite the plan while it
 * works** (adding milestones/tasks as it discovers them). This watcher makes those
 * edits show up on the Board without a manual "Sync": it polls each project's plan
 * file and, on change, re-parses + reconciles it into the store, then emits the
 * project's fresh task list.
 *
 * Reconciliation (see `taskReconcile`) preserves live status/sessionId and never
 * drops a mid-flight or ad-hoc task, so re-syncing during a run is safe.
 *
 * We use `fs.watchFile` (polling) rather than `fs.watch` because editors and the
 * agent write via atomic rename/replace, which breaks inode-based `fs.watch`;
 * polling is robust across all of them, and a ~1s latency is fine for this.
 */
import { readFileSync, unwatchFile, watchFile, type Stats } from 'node:fs';
import { hasPlan, type Project, type Task } from '@shared/model';
import { parsePlan } from './planParser';
import { appPlanPath } from './projectPaths';
import type { Store } from './store';

const POLL_INTERVAL_MS = 1000;

export class PlanWatcher {
  /** projectId → the plan path we're currently watching + its listener. */
  private readonly watched = new Map<
    string,
    { planPath: string; listener: (curr: Stats, prev: Stats) => void }
  >();

  constructor(
    private readonly store: Store,
    /** Deliver a project's freshly reconciled task list to the UI. */
    private readonly onTasksChanged: (projectId: string, tasks: Task[]) => void,
  ) {}

  /** Start watching every known project's plan file. Call once at startup. */
  watchAll(): void {
    for (const project of this.store.listProjects()) this.watch(project);
  }

  /** Watch (or re-watch) a single project's plan file. Idempotent. */
  watch(project: Project): void {
    // Only a project with a plan file has one to watch — the Personal board, an agent
    // project and a ticket project all carry an empty planPath. Never watch the others, or
    // an empty-plan re-sync would wipe the Personal board's JIRA/ad-hoc tasks (and, now, a
    // ticket project's tickets).
    //
    // Asked as `hasPlan`, not as "not personal and not agent": that elimination was
    // correct only while `plan` and `agent` were the only two shapes there were, and it
    // would have adopted a ticket project the day a third appeared.
    if (!hasPlan(project)) return;
    this.unwatch(project.id);
    // Named the way THIS process can open it: a WSL project's plan is on the distro's
    // filesystem, reachable from Windows only through the UNC share.
    const planPath = appPlanPath(project);
    const listener = (curr: Stats, prev: Stats): void => {
      // Ignore the initial poll (prev zeroed) and no-op ticks; act only on a real
      // mtime change. A deleted/missing file (mtimeMs 0) is left alone.
      if (prev.mtimeMs !== 0 && curr.mtimeMs !== prev.mtimeMs && curr.mtimeMs !== 0) {
        this.resync(project.id, planPath);
      }
    };
    watchFile(planPath, { interval: POLL_INTERVAL_MS }, listener);
    this.watched.set(project.id, { planPath, listener });
  }

  /** Stop watching a project (removed, or its plan path changed). */
  unwatch(projectId: string): void {
    const entry = this.watched.get(projectId);
    if (!entry) return;
    unwatchFile(entry.planPath, entry.listener);
    this.watched.delete(projectId);
  }

  /** Stop all watchers (app shutdown). */
  dispose(): void {
    for (const id of [...this.watched.keys()]) this.unwatch(id);
  }

  /** Re-read a plan file, reconcile it into the store, and push the new task list. */
  private resync(projectId: string, planPath: string): void {
    let markdown = '';
    try {
      markdown = readFileSync(planPath, 'utf8');
    } catch {
      return; // transient during an atomic save — the next poll will catch up
    }
    const tasks = this.store.syncTasksFromPlan(projectId, parsePlan(markdown));
    this.onTasksChanged(projectId, tasks);
  }
}
