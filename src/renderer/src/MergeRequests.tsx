/**
 * MergeRequests — the rich list in the detail pane, beside a card's steps.
 *
 * The card shows one row per MR; this is where the row's detail lives — pipeline,
 * approvals, reviewer state, and the two "mark it seen" actions.
 *
 * Those actions are two, not one, and that is the point: a comment and a red pipeline
 * are separate reasons for the card to be shouting, tracked by separate markers, so
 * clearing one must never silence the other. Reading a discussion after CI went red
 * should not quietly hide the fact that CI went red.
 */
import { Badge, Body1, Button, Caption1, makeStyles, tokens } from '@fluentui/react-components';
import { UNREAD_ORANGE } from '@shared/accent';
import {
  approvalSummary,
  mrAttentionReason,
  mrNeedsAttention,
  type MergeRequest,
  type PipelineStatus,
} from '@shared/mergeRequest';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: '8px' },
  head: { display: 'flex', alignItems: 'baseline', gap: '8px' },
  muted: { color: tokens.colorNeutralForeground3 },
  item: {
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
    padding: '8px',
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground3,
  },
  /** The same row treatment the card uses, so the two surfaces agree at a glance. */
  loud: { borderLeft: `3px solid ${UNREAD_ORANGE}` },
  titleRow: { display: 'flex', alignItems: 'baseline', gap: '6px' },
  title: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' },
  link: { color: tokens.colorBrandForegroundLink, textDecoration: 'none' },
  meta: { display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' },
  actions: { display: 'flex', gap: '6px', flexWrap: 'wrap' },
});

/** How a pipeline status should read: colour and words. */
const PIPELINE_BADGE: Record<
  PipelineStatus,
  { color: 'success' | 'danger' | 'warning' | 'brand' | 'subtle'; label: string }
> = {
  unknown: { color: 'subtle', label: 'no pipeline' },
  created: { color: 'subtle', label: 'pipeline queued' },
  pending: { color: 'subtle', label: 'pipeline pending' },
  manual: { color: 'subtle', label: 'pipeline manual' },
  skipped: { color: 'subtle', label: 'pipeline skipped' },
  running: { color: 'brand', label: 'pipeline running' },
  success: { color: 'success', label: 'pipeline passed' },
  failed: { color: 'danger', label: 'pipeline failed' },
  canceled: { color: 'warning', label: 'pipeline cancelled' },
};

export interface MergeRequestsProps {
  mergeRequests: readonly MergeRequest[];
  /** Clear the comment half of an MR's attention. */
  onMarkRead: (mrId: string) => void;
  /** Acknowledge the pipeline/approval half. */
  onMarkEventsSeen: (mrId: string) => void;
}

export function MergeRequests({
  mergeRequests,
  onMarkRead,
  onMarkEventsSeen,
}: MergeRequestsProps): React.JSX.Element | null {
  const styles = useStyles();
  if (!mergeRequests.length) return null;

  return (
    <div className={styles.root}>
      <div className={styles.head}>
        <Body1>Merge requests</Body1>
        <Caption1 className={styles.muted}>({mergeRequests.length})</Caption1>
      </div>

      {mergeRequests.map((mr) => {
        const pipeline = PIPELINE_BADGE[mr.pipelineStatus];
        const reason = mrAttentionReason(mr);
        return (
          <div
            key={mr.id}
            className={mrNeedsAttention(mr) ? `${styles.item} ${styles.loud}` : styles.item}
          >
            <div className={styles.titleRow}>
              <a className={styles.link} href={mr.webUrl} target="_blank" rel="noreferrer">
                !{mr.iid}
              </a>
              <Caption1 className={styles.title} title={mr.title}>
                {mr.title}
              </Caption1>
              {mr.draft && (
                <Badge appearance="outline" size="small">
                  draft
                </Badge>
              )}
            </div>

            <div className={styles.meta}>
              <Badge appearance="tint" color={pipeline.color} size="small">
                {mr.pipelineUrl ? (
                  <a className={styles.link} href={mr.pipelineUrl} target="_blank" rel="noreferrer">
                    {pipeline.label}
                  </a>
                ) : (
                  pipeline.label
                )}
              </Badge>
              {/* "approvals unknown" rather than a confident 0/0: /approvals is
                  tier-gated and 403s on plenty of instances. */}
              <Badge
                appearance="tint"
                size="small"
                color={mr.changesRequested ? 'danger' : 'informative'}
              >
                {mr.changesRequested ? 'changes requested' : approvalSummary(mr)}
              </Badge>
              <Caption1 className={styles.muted}>
                {mr.sourceBranch} → {mr.targetBranch}
              </Caption1>
            </div>

            {reason && <Caption1 style={{ color: UNREAD_ORANGE }}>{reason}</Caption1>}

            <div className={styles.actions}>
              <Button size="small" appearance="subtle" onClick={() => onMarkRead(mr.id)}>
                Mark comments read
              </Button>
              <Button size="small" appearance="subtle" onClick={() => onMarkEventsSeen(mr.id)}>
                Acknowledge pipeline
              </Button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
