/**
 * The review workspace's pure helpers: how the queues group, what a subject is called in the
 * header, which badge its diff source earns, where it lives on the forge and how the viewed
 * count reads — with no React in it, the same split `reviewView.ts` makes for the Changes pane.
 */
import type {
  DiffSummary,
  ReviewQueue,
  ReviewQueueItem,
  ReviewQueuesSnapshot,
} from '@tm/shared/review';

/** The queue column's fixed group order, top to bottom. */
export const QUEUE_ORDER: readonly ReviewQueue[] = ['requested', 'mine', 'agent'];

export const QUEUE_LABELS: Readonly<Record<ReviewQueue, string>> = {
  requested: 'Requested from me',
  mine: 'My PRs / MRs',
  agent: 'Agent cards',
};

export interface QueueGroup {
  queue: ReviewQueue;
  label: string;
  items: ReviewQueueItem[];
}

/**
 * Every queue in {@link QUEUE_ORDER}, each with its own rows in snapshot order — an empty queue
 * still gets its group (and its `0`), so the column's shape never shifts as queues fill.
 */
export function groupQueue(snapshot: ReviewQueuesSnapshot): QueueGroup[] {
  return QUEUE_ORDER.map((queue) => ({
    queue,
    label: QUEUE_LABELS[queue],
    items: snapshot.items.filter((item) => item.queue === queue),
  }));
}

export interface SourceBadge {
  text: string;
  /** The fallback reason, when the diff only reached `forge-api` by falling off `local-ref`. */
  title?: string;
}

/**
 * The header's source badge: either local source reads "local clone", the forge's API
 * "forge API · read only". `null` when the summary names no source (an older builder), so
 * the header draws nothing rather than guessing.
 */
export function sourceBadge(
  summary: Pick<DiffSummary, 'source' | 'fallbackReason'>,
): SourceBadge | null {
  const text =
    summary.source === 'worktree' || summary.source === 'local-ref'
      ? 'local clone'
      : summary.source === 'forge-api'
        ? 'forge API · read only'
        : null;
  if (text === null) return null;
  return summary.fallbackReason ? { text, title: summary.fallbackReason } : { text };
}

/**
 * Where *Open on forge* goes. GitHub's host is fixed; a GitLab row carries no host (it may be
 * self-hosted), so it answers `null` and the button renders disabled. A task subject has no
 * forge page of its own.
 */
export function forgeUrlFor(item: Pick<ReviewQueueItem, 'subject'>): string | null {
  const { subject } = item;
  if (subject.kind !== 'pr' || subject.provider !== 'github') return null;
  return `https://github.com/${subject.repoPath}/pull/${subject.number}`;
}

/** The header's `owner/repo#N` for a PR; a card's own branch `ref` otherwise. */
export function subjectLabel(item: Pick<ReviewQueueItem, 'subject' | 'ref'>): string {
  const { subject } = item;
  return subject.kind === 'pr' ? `${subject.repoPath}#${subject.number}` : item.ref;
}

/** The file column's "N / M viewed". */
export function viewedLabel(viewed: number, total: number): string {
  return `${viewed} / ${total} viewed`;
}
