/**
 * The issue browser's contract (F5.5): one shape every tracker's provider answers to, and
 * the pure helpers that turn a provider's raw page into the `IssuePage` `issues:list` hands
 * back. See `@shared/issues` for the wire-level types this builds on — this file is where
 * JIRA, GitHub and GitLab stop looking different.
 *
 * Deliberately provider-agnostic: nothing here knows how to talk to a tracker, only how to
 * shape what one says. The three providers (`jira/`, `github/`, `gitlab/`) each implement
 * {@link IssueProvider} and reuse {@link normalizeLabels}/{@link facetLabels} for their own
 * wire shapes; `listIssuePage` is what every one of them is read through.
 */
import type { IssuePage, IssueProviderId, IssueQuery, IssueSummary } from '@shared/issues';
import { clampIssuePage } from '@shared/issues';
import type { Task } from '@shared/model';

/**
 * One page of a tracker's own issues, before `onBoardTaskId` exists.
 *
 * A provider never knows which issues are already on the board — that is a fact about
 * OUR store, not the tracker — so it answers with everything else and leaves the field
 * out entirely rather than guessing at it.
 */
export interface ProviderPage {
  items: Array<Omit<IssueSummary, 'onBoardTaskId'>>;
  /** Every label the provider can offer for the filter chips — see {@link facetLabels}. */
  labels: string[];
  nextCursor: string | null;
}

/** One tracker's own way of answering `issues:list` — JIRA, GitHub or GitLab. */
export interface IssueProvider {
  id: IssueProviderId;
  list(q: IssueQuery): Promise<ProviderPage>;
}

/**
 * A tracker's raw labels, normalized to the plain strings {@link IssueSummary.labels} and
 * the filter chips expect.
 *
 * Two trackers, two shapes: JIRA hands back bare strings, GitHub and GitLab hand back
 * label *objects* whose `name` is what a human reads — `{ name?: string | null }` is
 * written loosely because a label missing its name (deleted between the list and the
 * read, a malformed webhook payload) is a real shape to tolerate, not a bug to crash on.
 * Trimmed and de-duplicated case-insensitively, the same rule {@link facetLabels} and
 * `@shared/tickets`' own `normalizeLabels` use, so "Bug" and "bug" never both show up as
 * separate chips for what is the same label to everyone but a string comparison.
 */
export function normalizeLabels(raw: Array<string | { name?: string | null }>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of raw) {
    const label = typeof entry === 'string' ? entry : entry?.name;
    if (!label) continue;
    const trimmed = label.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

/**
 * The label chips the issue browser offers to filter by — the union of what this page
 * saw, what the scope is already known to carry, and whatever is currently selected.
 *
 * `selected` is folded in for one reason: a label a human has already filtered BY must
 * never disappear from its own filter just because a narrower query's page no longer
 * happens to return an issue wearing it. Losing it would leave a selected chip with
 * nothing to un-select.
 */
export function facetLabels(
  pageLabels: string[],
  scopeLabels: string[],
  selected: string[],
): string[] {
  return normalizeLabels([...scopeLabels, ...pageLabels, ...selected]);
}

/**
 * Which board task, if any, each `(provider, key)` pair already lives on.
 *
 * Archived cards are excluded: a card the human archived is not "on the board" in the
 * sense the browser means by the phrase, and offering it back as already-imported would
 * make it unreachable by the only path that still exists to find it (import again).
 * A task from a DIFFERENT source is never matched even when its key happens to collide —
 * `key` is only ever unique within one tracker.
 */
export function onBoardIndex(
  tasks: readonly Pick<Task, 'id' | 'externalSource' | 'externalKey' | 'archivedAt'>[],
): (provider: IssueProviderId, key: string) => string | null {
  const taskIdByKey = new Map<string, string>();
  for (const task of tasks) {
    if (task.archivedAt != null) continue;
    if (!task.externalSource || !task.externalKey) continue;
    taskIdByKey.set(`${task.externalSource}\u0000${task.externalKey}`, task.id);
  }
  return (provider, key) => taskIdByKey.get(`${provider}\u0000${key}`) ?? null;
}

/**
 * What `issues:list` actually does: ask the provider, resolve `onBoardTaskId` against the
 * board the provider itself has no view of, and clamp the result to what the IPC relay can
 * carry.
 */
export async function listIssuePage(
  provider: IssueProvider,
  query: IssueQuery,
  tasks: readonly Pick<Task, 'id' | 'externalSource' | 'externalKey' | 'archivedAt'>[],
): Promise<IssuePage> {
  const page = await provider.list(query);
  const resolve = onBoardIndex(tasks);
  return clampIssuePage({
    items: page.items.map((item) => ({
      ...item,
      onBoardTaskId: resolve(provider.id, item.key),
    })),
    labels: page.labels,
    nextCursor: page.nextCursor,
  });
}
