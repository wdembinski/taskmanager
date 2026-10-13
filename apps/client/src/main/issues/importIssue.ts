/**
 * The idempotent half of F5 (F5.6): what `issues:import` actually does once a tracker and
 * key are chosen in the issue browser.
 *
 * Pure — no store, no Electron — so `ipc.ts` supplies every side effect through `deps` and
 * this file is left with just the decision: a card already on the board (in any archived
 * state) gets restored and pinned in place; anything else is fetched fresh and inserted
 * pinned. Importing the same issue twice is then "find, don't create" on the second call,
 * which is what makes the browser's "Add to board" safe to click more than once.
 */
import type { IssueProviderId } from '@shared/issues';
import type { Task } from '@shared/model';

export interface ImportIssueDeps {
  /** The board's own card for `(source, key)`, in ANY archived state, or undefined. */
  findCard(source: IssueProviderId, key: string): Task | undefined;
  /** Read the issue fresh from the tracker and build the card it would land on the board as. */
  fetchCard(provider: IssueProviderId, key: string): Promise<Task>;
  /** Write a brand-new card. */
  insert(task: Task): Task;
  /** Take a card off the archived list — `archivedAt`/`archivedReason` back to null. */
  unarchive(id: string): void;
  /** Set `Task.pinnedImport` and return the card as it now stands. */
  pin(id: string): Task;
}

/**
 * GitLab has no client support yet in v1 (see `@shared/issues`'s `ISSUE_PROVIDERS` note) —
 * the browser can list nothing for it to begin with, so this is reached only if a caller
 * asks anyway.
 */
const GITLAB_NOT_SUPPORTED = 'GitLab issue import is not supported yet.';

export async function importIssue(
  provider: IssueProviderId,
  key: string,
  deps: ImportIssueDeps,
): Promise<Task> {
  if (provider === 'gitlab') throw new Error(GITLAB_NOT_SUPPORTED);

  const existing = deps.findCard(provider, key);
  if (existing) {
    if (existing.archivedAt != null) deps.unarchive(existing.id);
    return deps.pin(existing.id);
  }

  const card = await deps.fetchCard(provider, key);
  return deps.insert({ ...card, pinnedImport: true });
}
