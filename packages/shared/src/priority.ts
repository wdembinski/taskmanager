/**
 * One vocabulary for task priority, shared by the card's colour square and the
 * board's sort order.
 *
 * A priority is a NAME, not a number: it comes from JIRA, where every instance
 * spells its own scale ("Highest"/"Blocker"/"P1"/"Trivial"…). So both the colour and
 * the rank are derived by bucketing the name, and they must bucket it the same way —
 * a card that sorts as high but paints as low would be worse than either alone.
 * Hence one bucketing function here, in `shared`, rather than a copy per surface.
 *
 * Order matters when matching: "highest" contains "high", so the checks run from the
 * most specific spelling down. This is exactly what the board's old inline colour
 * helper got wrong.
 */
import type { PriorityDisplay } from './settings';

/** The five rungs of the scale, plus "nobody said". */
export type PriorityBucket = 'highest' | 'high' | 'medium' | 'low' | 'lowest' | 'none';

/**
 * The priorities offered for an INTERNAL task (one with no JIRA issue behind it).
 * A JIRA card is offered its own instance's names instead — see `jira:priorities` —
 * because writing back a name the workflow doesn't have would be rejected.
 */
export const DEFAULT_PRIORITIES = ['Highest', 'High', 'Medium', 'Low', 'Lowest'] as const;

/**
 * Which rung a priority name sits on. Matched on substrings, because instances name
 * the same rung differently ("Blocker"/"Critical" are the top; "Major" is the middle
 * on a classic JIRA scale; "Trivial" is the bottom).
 */
export function priorityBucket(name: string | null | undefined): PriorityBucket {
  if (!name) return 'none';
  const p = name.trim().toLowerCase();
  if (!p) return 'none';
  // Most specific first: every "highest" is also a "high", and every "lowest" a "low".
  if (p.includes('highest') || p.includes('critical') || p.includes('blocker') || p === 'p1')
    return 'highest';
  if (p.includes('lowest') || p.includes('trivial')) return 'lowest';
  if (p.includes('high') || p === 'p2') return 'high';
  if (p.includes('medium') || p.includes('major') || p.includes('normal') || p === 'p3')
    return 'medium';
  if (p.includes('low') || p.includes('minor') || p === 'p4') return 'low';
  return 'medium'; // a name we don't recognise is still a priority — treat it as middling
}

/** Sort weight: higher is more urgent. Unprioritised sinks below every named rung. */
export function priorityRank(name: string | null | undefined): number {
  switch (priorityBucket(name)) {
    case 'highest':
      return 4;
    case 'high':
      return 3;
    case 'medium':
      return 2;
    case 'low':
      return 1;
    case 'lowest':
      return 0;
    case 'none':
      return -1;
  }
}

/**
 * The card's priority-square colour per rung. `none` is null — the square is not
 * drawn at all rather than drawn in a colour that would read as a real priority.
 */
export const PRIORITY_COLOR: Record<PriorityBucket, string | null> = {
  highest: '#E5484D',
  high: '#F2721E',
  medium: '#F5A623',
  low: '#30A46C',
  lowest: '#5A8A76',
  none: null,
};

/** The card square's colour for a priority name, or null when there is none to show. */
export function priorityColor(name: string | null | undefined): string | null {
  return PRIORITY_COLOR[priorityBucket(name)];
}

/**
 * Whether a board set to `mode` draws **anything at all** for this priority.
 *
 * Asked twice per card and it must give the same answer both times: once by the indicator
 * itself, and once by the card's footer deciding whether that row needs to exist. Getting
 * those two out of step leaves an empty row holding a glyph nobody drew.
 *
 * The two modes deliberately disagree about the middle rung. `color` paints all five,
 * because a scale of squares with a hole in it reads as a bug. `mono` skips `medium`: medium
 * IS normal, and the point of the colourless mode is that only an abnormal priority is worth
 * ink — a board where most cards say nothing is a board where the ones that do are seen.
 * That also silences a name nobody recognises, since `priorityBucket` calls those `medium`,
 * and "we couldn't read this one" is not worth a mark either.
 */
export function priorityIndicatorShown(
  mode: PriorityDisplay,
  name: string | null | undefined,
): boolean {
  if (mode === 'off') return false;
  const bucket = priorityBucket(name);
  if (bucket === 'none') return false;
  return mode === 'color' || bucket !== 'medium';
}
