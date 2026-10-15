/**
 * The mic button and its recording overlay (F9.9) — Fluent v9, tokens only, and the board's
 * own colour budget: colour is for things that MOVE, so the pulsing red dot is the only
 * accent anywhere in this component; everything else, including the clock and the partial
 * text, stays monochrome.
 *
 * Renders `null` outright when {@link useDictation} says the host/browser combination can't
 * dictate at all — there is no third "offer it but explain why not" state for that case, only
 * for the narrower one where the API exists but the user has already refused the mic
 * permission (`blocked`), which is shown as a disabled button with its reason.
 *
 * The root wrapper stays relatively positioned at all times (not just while recording) so the
 * overlay — mounted in the exact same spot as the idle button — can lay itself out with
 * `position: absolute` and `bottom: 100%`, i.e. directly above wherever the button sits. In
 * the composer that is the action row, which is what puts the overlay above it without this
 * component needing to know anything about the row it's in.
 */
import { Button, Caption1, makeStyles, tokens } from '@fluentui/react-components';
import { MicRegular } from '@fluentui/react-icons';
import { formatElapsed } from './dictationAvailability';
import { useDictation } from './useDictation';

const useStyles = makeStyles({
  anchor: { position: 'relative', display: 'inline-flex' },
  overlay: {
    position: 'absolute',
    bottom: 'calc(100% + 6px)',
    left: 0,
    zIndex: 1,
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
    minWidth: '320px',
    maxWidth: '420px',
    padding: '8px 10px',
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow16,
  },
  row: { display: 'flex', alignItems: 'center', gap: '8px' },
  dot: {
    flexShrink: 0,
    width: '8px',
    height: '8px',
    borderRadius: '50%',
    backgroundColor: tokens.colorPaletteRedBackground3,
    animationName: { '0%, 100%': { opacity: 1 }, '50%': { opacity: 0.25 } },
    animationDuration: '1s',
    animationIterationCount: 'infinite',
    animationTimingFunction: 'ease-in-out',
    '@media (prefers-reduced-motion: reduce)': { animationName: 'none' },
  },
  clock: {
    flexShrink: 0,
    fontVariantNumeric: 'tabular-nums',
    color: tokens.colorNeutralForeground3,
  },
  partial: { flex: 1, minWidth: 0, color: tokens.colorNeutralForeground1 },
  interim: { color: tokens.colorNeutralForeground3 },
  actions: { display: 'flex', justifyContent: 'flex-end', gap: '6px' },
  error: { color: tokens.colorPaletteRedForeground1 },
  blockedReason: { color: tokens.colorNeutralForeground3 },
});

export interface DictationControlProps {
  onInsert: (text: string) => void;
  /** Offered only when the caller passes it — not every host does anything with "send". */
  onInsertAndSend?: (text: string) => void;
  disabled?: boolean;
}

export function DictationControl({
  onInsert,
  onInsertAndSend,
  disabled = false,
}: DictationControlProps): JSX.Element | null {
  const styles = useStyles();
  const dictation = useDictation((commit) => {
    if (commit.send && onInsertAndSend) onInsertAndSend(commit.text);
    else onInsert(commit.text);
  });

  if (!dictation.available) return null;

  if (dictation.phase === 'idle') {
    const label = dictation.blocked
      ? 'Microphone access was refused — allow it in the browser to dictate'
      : dictation.tooltip;
    return (
      <div className={styles.anchor}>
        <Button
          size="small"
          appearance="subtle"
          icon={<MicRegular />}
          title={label}
          aria-label={label}
          disabled={disabled || dictation.blocked}
          onClick={dictation.start}
        />
        {dictation.blocked && <Caption1 className={styles.blockedReason}>{label}</Caption1>}
      </div>
    );
  }

  return (
    <div className={styles.anchor}>
      <div className={styles.overlay}>
        <div className={styles.row}>
          <span className={styles.dot} />
          <Caption1 className={styles.clock}>{formatElapsed(dictation.elapsedMs)}</Caption1>
          <Caption1 aria-live="polite" className={styles.partial}>
            {dictation.final}
            {dictation.interim && (
              <span className={styles.interim}>
                {dictation.final ? ' ' : ''}
                {dictation.interim}
              </span>
            )}
          </Caption1>
        </div>
        {dictation.error && <Caption1 className={styles.error}>{dictation.error}</Caption1>}
        <div className={styles.actions}>
          <Button size="small" appearance="subtle" onClick={dictation.cancel}>
            Cancel
          </Button>
          <Button size="small" disabled={disabled} onClick={() => dictation.insert(false)}>
            Insert
          </Button>
          {onInsertAndSend && (
            <Button
              size="small"
              appearance="primary"
              disabled={disabled}
              onClick={() => dictation.insert(true)}
            >
              Insert & send
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
