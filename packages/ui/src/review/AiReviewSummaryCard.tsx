/**
 * The AI review's summary card (F16.13), drawn at the top of the workspace's file list once the
 * subject's latest review has settled. Done: the verdict as plain text, the reviewer's summary,
 * "N findings · M dropped · $x · Model" and which checklist it used. Failed: the failure text
 * and *Ask AI again*. Anything else draws nothing.
 *
 * Colour budget (memory *board-colour-budget*): a finished review is a static fact, so the card
 * is neutral ink throughout — the verdict included.
 */
import type { JSX } from 'react';
import { Body1, Button, Caption1, makeStyles, tokens } from '@fluentui/react-components';
import { BotRegular } from '@fluentui/react-icons';
import type { AiReview } from '@tm/shared/aiReview';
import { checklistLine, summaryLine, verdictText } from './aiReviewModel';

const useStyles = makeStyles({
  card: {
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
    padding: '8px 10px',
    borderRadius: tokens.borderRadiusMedium,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
    minWidth: 0,
  },
  head: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    color: tokens.colorNeutralForeground3,
  },
  verdict: { fontWeight: tokens.fontWeightSemibold, color: tokens.colorNeutralForeground1 },
  body: { color: tokens.colorNeutralForeground2, overflowWrap: 'anywhere' },
  faint: { color: tokens.colorNeutralForeground3 },
  action: { alignSelf: 'flex-start' },
});

export interface AiReviewSummaryCardProps {
  review: AiReview;
  /** The review's model as the CLI names it. */
  modelLabel: string;
  /** *Ask AI again* on a failed review; omitted, the action is not drawn. */
  onAskAgain?: () => void;
  /** Why asking again is not allowed right now; disables the action. */
  askReason?: string | null;
}

export function AiReviewSummaryCard({
  review,
  modelLabel,
  onAskAgain,
  askReason = null,
}: AiReviewSummaryCardProps): JSX.Element | null {
  const styles = useStyles();

  if (review.status === 'failed') {
    return (
      <div className={styles.card} data-ai-summary="failed">
        <Caption1 className={styles.head}>
          <BotRegular aria-hidden />
          AI review failed
        </Caption1>
        <Body1 className={styles.body} data-ai-error>
          {review.error ?? 'the AI review failed'}
        </Body1>
        {onAskAgain && (
          <Button
            className={styles.action}
            size="small"
            appearance="outline"
            disabledFocusable={askReason !== null}
            onClick={askReason === null ? onAskAgain : undefined}
            title={askReason ?? undefined}
          >
            Ask AI again
          </Button>
        )}
      </div>
    );
  }

  if (review.status !== 'done') return null;
  const checklist = checklistLine(review);
  return (
    <div className={styles.card} data-ai-summary="done">
      <Caption1 className={styles.head}>
        <BotRegular aria-hidden />
        AI review
      </Caption1>
      {review.verdict && (
        <Body1 className={styles.verdict} data-verdict={review.verdict}>
          {verdictText(review.verdict)}
        </Body1>
      )}
      {review.summary && <Body1 className={styles.body}>{review.summary}</Body1>}
      <Caption1 className={styles.faint} data-ai-summary-line>
        {summaryLine(review, modelLabel)}
      </Caption1>
      {checklist && (
        <Caption1 className={styles.faint} data-ai-checklist>
          {checklist}
        </Caption1>
      )}
    </div>
  );
}
