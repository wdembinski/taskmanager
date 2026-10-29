/**
 * *Ask AI to review* (F16.13) as the review workspace header draws it in its `ai-review` slot:
 * an outlined bot button while a review can be asked for (disabled, with the refusal as its
 * tooltip, when it cannot), or a chip and a subtle Cancel while one is under way. Pure — the
 * state comes from `aiReviewControlState`.
 *
 * Colour budget (memory *board-colour-budget*): the running chip is the one moving thing, so it
 * alone takes the run tokens (`RunTokens`, as `IssueRow`'s run chip); a queued or
 * parked chip is neutral ink — it waits, it does not move.
 */
import type { JSX } from 'react';
import { Button, Tooltip, makeStyles, mergeClasses, tokens } from '@fluentui/react-components';
import { BotRegular } from '@fluentui/react-icons';
import type { AiReviewControlState } from './aiReviewModel';

const useStyles = makeStyles({
  chip: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '5px',
    height: '20px',
    padding: '0 10px 0 7px',
    borderRadius: '10px',
    fontSize: tokens.fontSizeBase200,
    whiteSpace: 'nowrap',
    flexShrink: 0,
    backgroundColor: tokens.colorNeutralBackground3,
    color: tokens.colorNeutralForeground2,
  },
  running: {
    backgroundColor: `var(--tm-run-pill, ${tokens.colorNeutralBackground3})`,
    color: `var(--tm-run-ink, ${tokens.colorNeutralForeground2})`,
  },
  dot: {
    flexShrink: 0,
    width: '6px',
    height: '6px',
    borderRadius: '50%',
    backgroundColor: 'var(--tm-run-dot, currentColor)',
  },
  button: { flexShrink: 0 },
});

export interface AiReviewControlProps {
  control: AiReviewControlState;
  onAsk: () => void;
  onCancel: () => void;
}

export function AiReviewControl({ control, onAsk, onCancel }: AiReviewControlProps): JSX.Element {
  const styles = useStyles();

  if (control.kind === 'running' || control.kind === 'queued' || control.kind === 'parked') {
    const running = control.kind === 'running';
    return (
      <>
        <span
          className={mergeClasses(styles.chip, running && styles.running)}
          data-ai-review={control.kind}
          data-running={running ? '' : undefined}
          role="status"
        >
          {running && <span className={styles.dot} aria-hidden />}
          {control.chip}
        </span>
        <Button size="small" appearance="subtle" onClick={onCancel} data-ai-cancel>
          Cancel
        </Button>
      </>
    );
  }

  const button = (
    <Button
      className={styles.button}
      size="small"
      appearance="outline"
      shape="circular"
      icon={<BotRegular />}
      disabledFocusable={control.reason !== null}
      onClick={control.reason === null ? onAsk : undefined}
      data-ai-review={control.kind}
      data-refusal={control.reason ?? undefined}
    >
      {control.label}
    </Button>
  );
  if (control.reason !== null) {
    return (
      <Tooltip content={control.reason} relationship="description">
        {button}
      </Tooltip>
    );
  }
  if (control.kind === 'failed') {
    return (
      <Tooltip content={control.error} relationship="description">
        {button}
      </Tooltip>
    );
  }
  return button;
}
