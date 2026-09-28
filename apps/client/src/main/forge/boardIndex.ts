/**
 * Building the board's key index — the pure loop behind `ipc.ts#boardKeyIndex`, pulled out so
 * it can be exercised without the `registerIpc` closure around it (see `the-store-has-no-tests`
 * for why nothing in that closure has a test file today).
 *
 * Takes whatever slice of tasks the caller considers "the board" and indexes their keys, so a
 * merge request's issue references can be matched to a card. No behavior beyond the loop
 * itself: callers decide which tasks to pass in (and thus whether archived rows are excluded).
 */
import type { Task } from '@shared/model';

export function buildBoardIndex(tasks: readonly Task[]): {
  knownKeys: string[];
  taskIdByKey: Map<string, string>;
  knownTaskIds: Set<string>;
} {
  const taskIdByKey = new Map<string, string>();
  const knownTaskIds = new Set<string>();
  for (const task of tasks) {
    knownTaskIds.add(task.id);
    // Any tracker's key, not JIRA's alone: a GitHub pull request names its issue as
    // `owner/repo#123`, which is the same kind of fact about the same kind of card. The
    // upper-casing is what makes the lookup case-insensitive on both spellings.
    if (task.externalSource && task.externalKey) {
      taskIdByKey.set(task.externalKey.toUpperCase(), task.id);
    }
    // A NATIVE ticket's key (`TM-12`) counts too, and leaving it out was a hole rather
    // than a decision: it is the key this app puts in front of the title of every pull
    // request it opens (`prTitle`), the key a human types into a branch name, and the one
    // the card itself prints — but nothing here indexed it, so no merge request naming it
    // could ever be matched to it. A card with a native ticket behind it looked, to every
    // reconciler, exactly like a card with no key at all.
    const ticketKey = task.ticketKey?.trim();
    // Never over a tracker's own: `externalKey` is the mirrored issue's real name, and if
    // some board somehow spells both the same, the mirrored card is the one whose key the
    // forge's text is quoting.
    if (ticketKey && !taskIdByKey.has(ticketKey.toUpperCase())) {
      taskIdByKey.set(ticketKey.toUpperCase(), task.id);
    }
  }
  return { knownKeys: [...taskIdByKey.keys()], taskIdByKey, knownTaskIds };
}
