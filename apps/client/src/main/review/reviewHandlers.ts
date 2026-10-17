/**
 * The eleven `review:*`/`task:diff*` IPC handler bodies F15.10 adds or widens, pulled out of
 * `ipc.ts` the same way `archiveHandlers.ts` pulls its three out — so they can be driven
 * through a real `RelayRegistry` in a test without standing up Electron. No import here
 * reaches `electron`; `ipc.ts` still does the `ipcMain.handle` / `relayRegistry.register`
 * wiring itself, via its own `handle()` helper.
 *
 * `task:diffSummary`/`task:diffFile`/`task:diffImage` (F6.6) move in here unchanged in
 * contract, just routed through `ReviewSubjectService` instead of `DiffService` directly —
 * `taskSubjectId(taskId)` is the one translation, since the service's whole point is to
 * answer a `subjectId`, task or PR alike.
 *
 * `review:queues`/`review:refreshQueues` cap each queue in the snapshot at
 * `REVIEW_QUEUE_MAX_ROWS`, listing whichever queues that cut into in `truncated` — a browser
 * fetching a huge "Requested from me" queue still gets one bounded answer, the same reasoning
 * `DIFF_FILE_MAX_BYTES` already applies to a single file's patch.
 *
 * Every argument arriving on `review:subjectFile`/`subjectImage`/`context`/`viewed`/
 * `setViewed` is validated before it reaches `ReviewSubjectService` or the store: a relayed
 * call arrives over the untyped web wire, where nothing but this function stands between a
 * malformed command and a confusing crash deep inside a git read. A bad argument throws a
 * readable `Error`, which `RelayRegistry.invoke` turns into `{ ok: false, error }` for a
 * browser and `ipcMain.handle` turns into a rejected promise for the desktop renderer either
 * way.
 */
import {
  REVIEW_QUEUE_MAX_ROWS,
  taskSubjectId,
  type DiffContextResult,
  type DiffFileResult,
  type DiffImageResult,
  type DiffSide,
  type DiffSummaryResult,
  type ReviewQueue,
  type ReviewQueuesSnapshot,
  type ReviewViewedMark,
} from '@shared/review';
import type { IpcApi } from '@shared/ipc';
import type { Store } from '../store';
import type { ReviewQueueService } from './queueService';
import type { ReviewSubjectService } from './subjectService';

export interface ReviewHandlersDeps {
  subjects: Pick<ReviewSubjectService, 'summary' | 'file' | 'image' | 'context'>;
  queues: Pick<ReviewQueueService, 'open' | 'refresh' | 'snapshot'>;
  store: Pick<Store, 'listReviewViewed' | 'setReviewViewed' | 'clearReviewViewed'>;
  now(): number;
}

/** The subset of `IpcApi` these eleven channels implement — same contract, no Electron import. */
export type ReviewHandlers = Pick<
  IpcApi,
  | 'task:diffSummary'
  | 'task:diffFile'
  | 'task:diffImage'
  | 'review:queues'
  | 'review:refreshQueues'
  | 'review:subjectSummary'
  | 'review:subjectFile'
  | 'review:subjectImage'
  | 'review:context'
  | 'review:viewed'
  | 'review:setViewed'
>;

function requireString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value === '') {
    throw new Error(`${name} must be a non-empty string.`);
  }
  return value;
}

function requireInt(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new Error(`${name} must be an integer.`);
  }
  return value;
}

/** `from`/`to`: both integers, 1-based, and in order — `review:context`'s own range. */
function requireRange(from: unknown, to: unknown): { from: number; to: number } {
  const f = requireInt(from, 'from');
  const t = requireInt(to, 'to');
  if (f < 1 || f > t) throw new Error('from/to must satisfy 1 <= from <= to.');
  return { from: f, to: t };
}

function requireSide(value: unknown): DiffSide {
  if (value !== 'old' && value !== 'new') throw new Error('side must be "old" or "new".');
  return value;
}

/** `null` clears a viewed mark; anything else must be the blob sha it is being set to. */
function requireBlobSha(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value === 'string' && value !== '') return value;
  throw new Error('blobSha must be a non-empty string or null.');
}

/**
 * `snapshot` with each queue cut down to `REVIEW_QUEUE_MAX_ROWS`, in whatever order
 * `snapshot.items` already carries them — a browser fetching a queue nobody has pruned in a
 * while still gets one bounded answer. `truncated` names only the queues this actually cut
 * into, on top of whatever `partial` already said about the refresh itself.
 */
function capQueues(snapshot: ReviewQueuesSnapshot): ReviewQueuesSnapshot {
  const counts: Partial<Record<ReviewQueue, number>> = {};
  const truncated = new Set<ReviewQueue>();
  const items = snapshot.items.filter((item) => {
    const count = (counts[item.queue] ?? 0) + 1;
    counts[item.queue] = count;
    if (count > REVIEW_QUEUE_MAX_ROWS) {
      truncated.add(item.queue);
      return false;
    }
    return true;
  });
  return { ...snapshot, items, truncated: [...truncated] };
}

export function createReviewHandlers(deps: ReviewHandlersDeps): ReviewHandlers {
  return {
    'task:diffSummary': async (taskId): Promise<DiffSummaryResult> =>
      deps.subjects.summary(taskSubjectId(taskId)),
    'task:diffFile': async (taskId, diffId, path): Promise<DiffFileResult> =>
      deps.subjects.file(taskSubjectId(taskId), diffId, path),
    'task:diffImage': async (taskId, diffId, path): Promise<DiffImageResult> =>
      deps.subjects.image(taskSubjectId(taskId), diffId, path),

    'review:queues': async () => capQueues(deps.queues.open()),
    'review:refreshQueues': async () => {
      await deps.queues.refresh();
      return capQueues(deps.queues.snapshot());
    },

    'review:subjectSummary': async (subjectId): Promise<DiffSummaryResult> =>
      deps.subjects.summary(requireString(subjectId, 'subjectId')),
    'review:subjectFile': async (subjectId, diffId, path): Promise<DiffFileResult> =>
      deps.subjects.file(
        requireString(subjectId, 'subjectId'),
        requireString(diffId, 'diffId'),
        requireString(path, 'path'),
      ),
    'review:subjectImage': async (subjectId, diffId, path): Promise<DiffImageResult> =>
      deps.subjects.image(
        requireString(subjectId, 'subjectId'),
        requireString(diffId, 'diffId'),
        requireString(path, 'path'),
      ),
    'review:context': async (
      subjectId,
      diffId,
      path,
      side,
      from,
      to,
    ): Promise<DiffContextResult> => {
      const sid = requireString(subjectId, 'subjectId');
      const did = requireString(diffId, 'diffId');
      const p = requireString(path, 'path');
      const s = requireSide(side);
      const { from: f, to: t } = requireRange(from, to);
      return deps.subjects.context(sid, did, p, s, f, t);
    },

    'review:viewed': async (subjectId): Promise<ReviewViewedMark[]> =>
      deps.store.listReviewViewed(requireString(subjectId, 'subjectId')),
    'review:setViewed': async (subjectId, path, blobSha): Promise<ReviewViewedMark[]> => {
      const sid = requireString(subjectId, 'subjectId');
      const p = requireString(path, 'path');
      const sha = requireBlobSha(blobSha);
      if (sha === null) return deps.store.clearReviewViewed(sid, p);
      return deps.store.setReviewViewed({
        subjectId: sid,
        path: p,
        blobSha: sha,
        viewedAt: deps.now(),
      });
    },
  };
}
