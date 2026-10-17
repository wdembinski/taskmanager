/**
 * The board's three ways of drawing its chain links — Off, Focus, All (F13.20) — and the
 * pure view each one produces over a given selection.
 *
 * All is today's behaviour, every link routed and drawn at rest. Off draws nothing at all —
 * the needs/unblocks chips on the card itself (a later step) carry the same facts without
 * spending a gutter on them. Focus is the middle ground: with a card selected, only the
 * links that touch it directly stay at their ordinary ink, every other link on the board
 * fades, and every card that is neither the selection nor one of those direct neighbours
 * dims — so a busy board reads as one chain at a time instead of the whole tangle.
 *
 * Kept free of React, Fluent and the DOM like every other `*.ts` in this folder: which links
 * fade and which cards dim is a question about the graph, not about pixels, and the two
 * boards (`MyTasks`, the web's `BoardScreen`) must answer it identically.
 */
import type { TaskLink } from '@tm/shared/taskChain';

/** The three modes, in the order the switch cycles them and the segments read left to right. */
export const LINK_MODES = ['off', 'focus', 'all'] as const;

export type LinkMode = (typeof LINK_MODES)[number];

/** `L` cycles the switch: off → focus → all → off. */
export function nextLinkMode(mode: LinkMode): LinkMode {
  const i = LINK_MODES.indexOf(mode);
  return LINK_MODES[(i + 1) % LINK_MODES.length];
}

/** What a given mode and selection means for the board's links and cards. */
export interface LinkView {
  /** Whether `ChainOverlay` draws at all. False only for Off. */
  drawn: boolean;
  /** The selected card's own links — direct neighbours only, never the whole route. */
  litIds: ReadonlySet<string>;
  /** Every other link, drawn at low opacity with no hit band. Empty outside Focus. */
  fadedLinkIds: ReadonlySet<string>;
  /** Cards that are neither the selection nor one of its direct neighbours. */
  dimmedTaskIds: ReadonlySet<string>;
}

const EMPTY_SET: ReadonlySet<string> = new Set();

/**
 * Off draws nothing; All draws everything at rest, same as before this switch existed;
 * Focus — with nothing selected — is the same as All, because there is no card to focus on
 * yet. Only Focus with a selection fades and dims anything.
 */
export function linkView(
  links: readonly TaskLink[],
  mode: LinkMode,
  selectedTaskId: string | null | undefined,
): LinkView {
  if (mode === 'off') {
    return { drawn: false, litIds: EMPTY_SET, fadedLinkIds: EMPTY_SET, dimmedTaskIds: EMPTY_SET };
  }
  if (mode === 'all' || !selectedTaskId) {
    return { drawn: true, litIds: EMPTY_SET, fadedLinkIds: EMPTY_SET, dimmedTaskIds: EMPTY_SET };
  }

  const litIds = new Set<string>();
  const neighbours = new Set<string>();
  for (const link of links) {
    if (link.fromTaskId === selectedTaskId || link.toTaskId === selectedTaskId) {
      litIds.add(link.id);
      neighbours.add(link.fromTaskId === selectedTaskId ? link.toTaskId : link.fromTaskId);
    }
  }

  const fadedLinkIds = new Set<string>();
  const dimmedTaskIds = new Set<string>();
  for (const link of links) {
    if (litIds.has(link.id)) continue;
    fadedLinkIds.add(link.id);
    for (const taskId of [link.fromTaskId, link.toTaskId]) {
      if (taskId !== selectedTaskId && !neighbours.has(taskId)) dimmedTaskIds.add(taskId);
    }
  }

  return { drawn: true, litIds, fadedLinkIds, dimmedTaskIds };
}
