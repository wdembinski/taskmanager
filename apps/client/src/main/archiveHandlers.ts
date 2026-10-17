/**
 * The three `archive:*` IPC handler bodies, pulled out of `ipc.ts` the same way
 * `automationHandlers.ts` pulls its six out — so they can be run through a real
 * {@link RelayRegistry} in a test without standing up Electron. No import here reaches
 * `electron`; `ipc.ts` still does the `ipcMain.handle` / `relayRegistry.register` wiring
 * itself, via the small `handle()` helper it already has.
 *
 * `apply`/`restore` switch on `target.kind` to pick the one store method that matches — the
 * switch is exhaustive over `ArchiveTarget['kind']`, but a relayed call arrives over the
 * untyped web wire, so an unrecognised kind still falls through to a `not-found` refusal
 * rather than a thrown error, exactly as the store methods themselves never throw.
 *
 * A push only follows a `{ ok: true }` result, and only the push that result's own flags say
 * is due: `milestonesChanged` for `pushMilestones()`, a non-empty `changedTaskIds` for
 * `pushTasks(result.projectId)`. A refusal and a project target (whose `ArchiveResult` carries
 * neither flag) push nothing — a project's own row changed instead, which is why `ipc.ts`'s
 * `archive:apply`/`archive:restore` docstrings point the renderer at a `project:list` re-read
 * for that case, not a push from here.
 */
import type { IpcApi } from '@shared/ipc';
import type { Milestone } from '@shared/model';
import type { ArchiveResult, ArchiveTarget, OpenTicketsChoice } from '@shared/trackerArchive';
import type { Store } from './store';

export interface ArchiveHandlersDeps {
  store: Pick<
    Store,
    | 'archiveMilestone'
    | 'restoreMilestone'
    | 'archiveEpic'
    | 'restoreEpic'
    | 'archiveTicketProject'
    | 'restoreTicketProject'
    | 'listArchived'
  >;
  /** `send('milestone:changed', …)` — the board push `milestone:save`/`milestone:remove` already
   *  make after a store write lands. */
  pushMilestones(): Milestone[];
  /** `send('project:tasksChanged', …)` for one project — the board push every other `task:*`
   *  write in `ipc.ts` makes after a store write lands. */
  pushTasks(projectId: string): void;
  now(): number;
}

/** The subset of `IpcApi` these three channels implement — same contract, no Electron import. */
export type ArchiveHandlers = Pick<IpcApi, 'archive:apply' | 'archive:restore' | 'archive:list'>;

export function createArchiveHandlers(deps: ArchiveHandlersDeps): ArchiveHandlers {
  function applyTo(target: ArchiveTarget, choice: OpenTicketsChoice | undefined): ArchiveResult {
    switch (target.kind) {
      case 'milestone':
        return deps.store.archiveMilestone(target.id, choice, deps.now());
      case 'epic':
        return deps.store.archiveEpic(target.id, deps.now());
      case 'project':
        return deps.store.archiveTicketProject(target.id, deps.now());
      default:
        return { ok: false, reason: 'not-found', message: 'Unknown archive target' };
    }
  }

  function restoreFrom(target: ArchiveTarget): ArchiveResult {
    switch (target.kind) {
      case 'milestone':
        return deps.store.restoreMilestone(target.id);
      case 'epic':
        return deps.store.restoreEpic(target.id);
      case 'project':
        return deps.store.restoreTicketProject(target.id);
      default:
        return { ok: false, reason: 'not-found', message: 'Unknown archive target' };
    }
  }

  function pushIfChanged(result: ArchiveResult): ArchiveResult {
    if (result.ok) {
      if (result.milestonesChanged) deps.pushMilestones();
      if (result.changedTaskIds.length > 0) deps.pushTasks(result.projectId);
    }
    return result;
  }

  return {
    'archive:apply': async (target, choice) => pushIfChanged(applyTo(target, choice)),
    'archive:restore': async (target) => pushIfChanged(restoreFrom(target)),
    'archive:list': async (projectId) => deps.store.listArchived(projectId),
  };
}
