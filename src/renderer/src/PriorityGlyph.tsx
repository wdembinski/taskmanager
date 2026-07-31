/**
 * A task's priority, drawn the way this board is set to draw it.
 *
 * One component for the card and the detail pane, in the shape of `AgentGlyph` and
 * `JiraMark`, because the two surfaces used to own separate copies of the colour square —
 * and the moment priority became configurable, two copies meant the card could be showing a
 * chevron while the pane beside it still showed a coloured block for the same task.
 *
 * The three modes are three different answers to "how loud should a fact that never changes
 * be" (see `BoardDisplaySettings.priorityDisplay`):
 *
 *  - **`color`** — the rounded square, as the board has always looked. Fastest to read, and
 *    the most ink on a board already spending colour on step dots, pipeline dots and the
 *    running band.
 *  - **`mono`** — JIRA's own chevrons, which is what makes them worth using: anyone who has
 *    seen a JIRA backlog already knows that up is urgent and doubled is more so, so rank is
 *    read from direction and weight rather than hue. **Medium draws nothing at all** — see
 *    `priorityIndicatorShown` for why that is the point rather than an omission.
 *  - **`off`** — nothing. The sort order still honours priority (`sortCards`).
 */
import { makeStyles, tokens } from '@fluentui/react-components';
import {
  ChevronDoubleDownFilled,
  ChevronDoubleUpFilled,
  ChevronDownFilled,
  ChevronUpFilled,
} from '@fluentui/react-icons';
import { priorityBucket, priorityColor, priorityIndicatorShown } from '@shared/priority';
import type { PriorityBucket } from '@shared/priority';
import type { PriorityDisplay } from '@shared/settings';

/**
 * The rung → chevron table. Filled rather than outline: this is a 16–18px mark carrying a
 * five-way distinction on a dark card, and an outline chevron at that size is two hairlines.
 *
 * `medium` and `none` are null by design, not by oversight — the map is total over
 * `PriorityBucket` so a new rung could not be added without deciding what it draws.
 */
const CHEVRON: Record<PriorityBucket, JSX.Element | null> = {
  highest: <ChevronDoubleUpFilled />,
  high: <ChevronUpFilled />,
  medium: null,
  low: <ChevronDownFilled />,
  lowest: <ChevronDoubleDownFilled />,
  none: null,
};

const useStyles = makeStyles({
  square: { borderRadius: '3px', flexShrink: 0 },
  /**
   * Brighter than the muted grey this started at (`colorNeutralForeground3`): the glyph is
   * the only thing saying the priority, where the square at least had hue to carry it.
   */
  glyph: {
    display: 'flex',
    alignItems: 'center',
    flexShrink: 0,
    color: tokens.colorNeutralForeground2,
  },
});

export interface PriorityGlyphProps {
  /** Which indicator this board is set to. */
  mode: PriorityDisplay;
  /** The instance's own priority NAME ("Blocker", "P2", "Trivial"), or null. */
  priority: string | null | undefined;
  /**
   * The glyph's font size in px. The colour square is drawn 4px smaller, which is exactly
   * the two sizes these surfaces already used — 18/14 on the card, 16/12 in the pane — so
   * switching modes changes the shape without nudging the row it sits in.
   */
  size?: number;
}

export function PriorityGlyph({ mode, priority, size = 18 }: PriorityGlyphProps): JSX.Element | null {
  const styles = useStyles();
  // Asked here and by the card's footer, so a row can never be drawn for a mark that isn't.
  if (!priorityIndicatorShown(mode, priority)) return null;

  // Neither shape can carry a word, so the instance's own name for the rung — which is the
  // only form that means anything to a human — rides in the tooltip on both.
  const label = priority ?? undefined;

  if (mode === 'color') {
    const color = priorityColor(priority);
    if (!color) return null; // unreachable via the predicate; keeps the type honest
    return (
      <span
        className={styles.square}
        style={{ width: `${size - 4}px`, height: `${size - 4}px`, backgroundColor: color }}
        title={label}
        aria-label={label && `Priority: ${label}`}
      />
    );
  }

  const glyph = CHEVRON[priorityBucket(priority)];
  if (!glyph) return null; // ditto — `medium`/`none` are filtered above
  return (
    <span
      className={styles.glyph}
      style={{ fontSize: `${size}px` }}
      title={label}
      aria-label={label && `Priority: ${label}`}
    >
      {glyph}
    </span>
  );
}
