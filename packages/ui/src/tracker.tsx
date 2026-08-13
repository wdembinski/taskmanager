/**
 * Which tracker a card came from, as the renderer needs to say it: its **mark**, its
 * **name**, and how its **key** is spelled where there is no room for the whole thing.
 *
 * One module because the answers have to agree. The card's footer badge, the detail pane's
 * title badge and the archived list all show the same fact about the same card, and a board
 * where the card says `#12` and the pane says `owner/repo#12` reads as two different tickets.
 * Before this there was one branch — `externalSource === 'jira' && <JiraMark/>` — inlined in
 * `TaskCard`, which is precisely the shape that goes stale when a third tracker arrives.
 *
 * Presentation only. Nothing here decides anything; `Task.externalSource` is the fact and
 * these are three renderings of it. The tracker NAMES live in `./chat/turns` (`TRACKER_NAME`)
 * and are imported rather than re-declared — a bubble that says JIRA over a GitHub comment is
 * the same bug as a badge that does.
 */
import type { Task } from '@tm/shared/model';

import { GitHubMark } from './GitHubMark';
import { JiraMark } from './JiraMark';
import { TRACKER_NAME } from './chat/turns';

/** A card's tracker, narrowed off `externalSource` — null for a card that is nobody's ticket. */
export type Tracker = 'jira' | 'github';

/**
 * Which tracker this card belongs to, or null.
 *
 * A function rather than a cast because `externalSource` is a stored string: a row written by
 * a newer build (or a hand-edited DB) naming a tracker this build has never heard of must read
 * as "no tracker" and lose its mark, not draw the wrong one.
 */
export function trackerOf(task: Pick<Task, 'externalSource'>): Tracker | null {
  return task.externalSource === 'github' || task.externalSource === 'jira'
    ? task.externalSource
    : null;
}

/** What to call this tracker on screen — "JIRA", "GitHub", or null when there is none. */
export function trackerName(task: Pick<Task, 'externalSource'>): string | null {
  const tracker = trackerOf(task);
  return tracker && TRACKER_NAME[tracker];
}

/**
 * The card's key as a **tight** surface should print it, or null when it has none.
 *
 * JIRA's `PROJ-123` is already as short as it gets. GitHub's is `owner/repo#123` — repo-scoped
 * on purpose, because issue 123 exists in every repository there has ever been (see
 * `Task.externalKey`) — and that is three quarters of a card's width spent on a fact the human
 * already knows: they picked the repository. So the badge prints `#123` and the tooltip carries
 * the whole key, which is the same bargain `mrRef` strikes for a merge request's number.
 *
 * Only where space is tight. The archived-cards dialog has a full row per card and prints the
 * whole key, because there the repository is the part you are actually scanning for.
 */
export function shortTicketKey(task: Pick<Task, 'externalSource' | 'externalKey'>): string | null {
  const key = task.externalKey ?? null;
  if (key === null || trackerOf(task) !== 'github') return key;
  // `lastIndexOf`, so a repository name that somehow contains a '#' still leaves the issue
  // number attached rather than being cut in half.
  const hash = key.lastIndexOf('#');
  return hash === -1 ? key : key.slice(hash);
}

export interface TrackerMarkProps {
  task: Pick<Task, 'externalSource'>;
  /** Edge length in px. The badges use 12. */
  size?: number;
  /**
   * Fill, when the surface needs to override the mark's own. The ticket badge passes
   * `currentColor` while it wears the unread tint, so JIRA's brand blue does not sit on
   * orange; GitHub's mark is `currentColor` already and is unaffected either way.
   */
  color?: string;
}

/**
 * The card's tracker, drawn in that tracker's own mark — or nothing at all for a card that has
 * no tracker.
 *
 * Not another tracker's logo, ever: a GitHub card wearing Atlassian's chevrons would be a lie
 * drawn in brand colour, which is why this branch existed (rendering the mark for JIRA and
 * nothing for GitHub) before GitHub had a mark of its own.
 */
export function TrackerMark({ task, size = 12, color }: TrackerMarkProps): JSX.Element | null {
  switch (trackerOf(task)) {
    case 'jira':
      return <JiraMark size={size} color={color} />;
    case 'github':
      return <GitHubMark size={size} color={color} />;
    default:
      return null;
  }
}
