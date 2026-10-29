/**
 * The needs/unblocks row (F13.20) a card wears in place of its chain chip once Off has turned
 * the gutter arrows off — what the arrow says, said instead in plain words.
 *
 * Drawn as v10-7e draws it: ONE line, never wrapped, mono 11px muted, a small link glyph at its
 * start, then "needs …" and "unblocks …" side by side. Each half ellipsizes on its own when the
 * card is too narrow, so the row can shrink but never grows a second line.
 */
import { makeStyles, tokens } from '@fluentui/react-components';
import { LinkRegular } from '@fluentui/react-icons';
import { FLUO_VAR } from '../tokens';
import type { LinkChips } from './linkChips';

const useStyles = makeStyles({
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    flexWrap: 'nowrap',
    overflow: 'hidden',
    whiteSpace: 'nowrap',
    minWidth: 0,
    fontFamily: `var(--tm-mono, ${tokens.fontFamilyMonospace})`,
    fontSize: '11px',
    lineHeight: '16px',
    color: `var(--tm-text-muted, ${tokens.colorNeutralForeground3})`,
  },
  icon: { fontSize: '12px', flexShrink: 0 },
  part: {
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    minWidth: 0,
  },
  /** The one predecessor whose finishing releases this card right now — cyan, the overlay's
   *  own "starting next", and the only colour this row spends. */
  releasing: { color: FLUO_VAR.cyan },
});

/** The row for `chips`, or nothing when the card neither needs nor unblocks anything. */
export function NeedsUnblocksRow({ chips }: { chips: LinkChips }) {
  const styles = useStyles();
  const { needs, unblocks } = chips;
  if (needs.length === 0 && unblocks.length === 0) return null;
  return (
    <span className={styles.row} data-link-chips="">
      <LinkRegular className={styles.icon} aria-hidden />
      {needs.length > 0 && (
        <span
          className={styles.part}
          title={`Needs ${needs.map((n) => n.key).join(', ')} to run first`}
        >
          needs{' '}
          {needs.map((n, i) => (
            <span key={n.key}>
              {i > 0 && ', '}
              <span className={n.tone === 'releasing' ? styles.releasing : undefined}>{n.key}</span>
            </span>
          ))}
        </span>
      )}
      {unblocks.length > 0 && (
        <span
          className={styles.part}
          title={`Unblocks ${unblocks.map((u) => u.key).join(', ')} once done`}
        >
          unblocks {unblocks.map((u) => u.key).join(', ')}
        </span>
      )}
    </span>
  );
}
