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
import { useState } from 'react';
import {
  Badge,
  Body1,
  Button,
  Caption1,
  Input,
  makeStyles,
  mergeClasses,
  tokens,
} from '@fluentui/react-components';
import { RenameRegular } from '@fluentui/react-icons';
import { UNREAD_ORANGE } from '@tm/shared/accent';
import {
  forgeName,
  mergeBlockerLabel,
  mergeBlockers,
  mrIsSettled,
  mrAttentionReason,
  mrHeading,
  mrLabel,
  mrNeedsAttention,
  mrNoun,
  mrReadyToMerge,
  mrRef,
  mrVerdict,
  verdictSummary,
  type MergeBlocker,
  type MergeRequest,
  type PipelineStatus,
} from '@tm/shared/mergeRequest';
import { FLUO, PIPELINE_COLOR } from './theme';

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
  /**
   * The stage row. Reads left to right in pipeline order, so it doubles as a progress
   * indicator: where the green stops is how far CI got.
   */
  stages: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' },
  /**
   * One stage: its own dot, then its name. No chip behind it and no arrows between — the
   * dots are the thing being read, and a filled pill around each one competed with them for
   * the same glance. The gap does the separating.
   */
  stage: {
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
    color: tokens.colorNeutralForeground2,
  },
  stageDot: { width: '7px', height: '7px', borderRadius: '50%', flexShrink: 0 },
  /**
   * A stage the runners are on, blinking between the spinner's two cyans — the same pair the
   * agent glyph pulses in, so "working" looks like one thing across the app.
   */
  stageDotRunning: {
    animationName: {
      '0%, 100%': { backgroundColor: FLUO.cyanDeep },
      '50%': { backgroundColor: FLUO.cyan },
    },
    animationDuration: '1s',
    animationIterationCount: 'infinite',
    animationTimingFunction: 'ease-in-out',
    // Without motion the dot must still read as the live one, so hold it at the bright end.
    '@media (prefers-reduced-motion: reduce)': {
      animationName: 'none',
      backgroundColor: FLUO.cyan,
    },
  },
});

/** How a pipeline status should read: colour and words. */
const PIPELINE_BADGE: Record<
  PipelineStatus,
  { color: 'success' | 'danger' | 'warning' | 'brand' | 'subtle'; label: string }
> = {
  // Not "no pipeline" — that would claim a fact we don't have. We simply haven't gotten a
  // clean answer yet; `none` below is the badge that gets to say there isn't one.
  unknown: { color: 'subtle', label: 'pipeline unknown' },
  none: { color: 'subtle', label: 'no pipeline' },
  created: { color: 'subtle', label: 'pipeline queued' },
  pending: { color: 'subtle', label: 'pipeline pending' },
  manual: { color: 'subtle', label: 'pipeline manual' },
  skipped: { color: 'subtle', label: 'pipeline skipped' },
  running: { color: 'brand', label: 'pipeline running' },
  success: { color: 'success', label: 'pipeline passed' },
  failed: { color: 'danger', label: 'pipeline failed' },
  canceled: { color: 'warning', label: 'pipeline cancelled' },
};

/**
 * Blockers another element of the row already accounts for, so the reason badges say only
 * what would otherwise go unsaid. Keeping this list here rather than in `mergeBlockers` is
 * deliberate: the ENGINE must know every reason a merge is blocked, and only this surface
 * knows which of them it has already drawn.
 */
const SAID_ELSEWHERE: ReadonlySet<MergeBlocker> = new Set([
  'pipeline', // the pipeline badge, plus a dot per stage
  'approvals', // the approval badge beside it
  'changes-requested', // ditto — it is what that badge turns into
  'draft', // the "draft" chip in the title row
]);

export interface MergeRequestsProps {
  mergeRequests: readonly MergeRequest[];
  /** Clear the comment half of an MR's attention. */
  onMarkRead: (mrId: string) => void;
  /** Acknowledge the pipeline/approval half. */
  onMarkEventsSeen: (mrId: string) => void;
  /** Rename an MR in this app only; null restores the upstream title. */
  onRename: (mrId: string, name: string | null) => void;
}

export function MergeRequests({
  mergeRequests,
  onMarkRead,
  onMarkEventsSeen,
  onRename,
}: MergeRequestsProps): React.JSX.Element | null {
  const styles = useStyles();
  // Which row is being renamed, and the text so far. One at a time: two open editors would
  // both be claiming to be the name of something.
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draft, setDraft] = useState('');

  /**
   * Save and close. A blank name clears the override rather than storing an empty string —
   * "no name" and "the name is nothing" must not be two different states.
   */
  const commitRename = (mrId: string): void => {
    setRenaming(null);
    onRename(mrId, draft.trim() || null);
  };

  if (!mergeRequests.length) return null;

  return (
    <div className={styles.root}>
      <div className={styles.head}>
        {/* The forge's own word for these — "Pull requests" over GitHub's. Shared with the
            card's section head, which shows the same list one pane over. */}
        <Body1>{mrHeading(mergeRequests)}</Body1>
        <Caption1 className={styles.muted}>({mergeRequests.length})</Caption1>
      </div>

      {mergeRequests.map((mr) => {
        const pipeline = PIPELINE_BADGE[mr.pipelineStatus];
        const reason = mrAttentionReason(mr);
        const verdict = mrVerdict(mr);
        const settled = mrIsSettled(mr);
        const blockers = mergeBlockers(mr).filter((b) => !SAID_ELSEWHERE.has(b));
        return (
          <div
            key={mr.id}
            className={mrNeedsAttention(mr) ? `${styles.item} ${styles.loud}` : styles.item}
          >
            <div className={styles.titleRow}>
              <a className={styles.link} href={mr.webUrl} target="_blank" rel="noreferrer">
                {mrRef(mr)}
              </a>
              {renaming === mr.id ? (
                <Input
                  size="small"
                  className={styles.title}
                  value={draft}
                  autoFocus
                  placeholder={mr.title}
                  onChange={(_e, d) => setDraft(d.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commitRename(mr.id);
                    if (e.key === 'Escape') setRenaming(null);
                  }}
                  onBlur={() => commitRename(mr.id)}
                />
              ) : (
                <>
                  {/* The tooltip always carries the upstream title, so a renamed MR never
                      hides what the forge actually calls it — and it names the forge it
                      belongs to, which is only true if it reads the row's own provider. */}
                  <Caption1
                    className={styles.title}
                    title={
                      mr.displayName
                        ? `${mr.displayName}\n${forgeName(mr.provider)}: ${mr.title}`
                        : mr.title
                    }
                  >
                    {mrLabel(mr)}
                  </Caption1>
                  <Button
                    size="small"
                    appearance="transparent"
                    icon={<RenameRegular />}
                    title={
                      mr.displayName
                        ? `Rename in this app (empty to restore the ${forgeName(mr.provider)} title)`
                        : 'Rename in this app'
                    }
                    aria-label={`Rename this ${mrNoun(mr.provider)} in this app`}
                    onClick={() => {
                      setRenaming(mr.id);
                      setDraft(mr.displayName ?? '');
                    }}
                  />
                </>
              )}
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
              {/* The verdict: how it ENDED once it has, else where its review stands.
                  Merged wears the same violet as the card row's merge glyph, so the two
                  surfaces read as one fact. "approvals unknown" rather than a confident
                  0/0 — /approvals is tier-gated and 403s on plenty of instances. */}
              <Badge
                appearance="tint"
                size="small"
                color={verdict === 'changes-requested' ? 'danger' : 'informative'}
                style={verdict === 'merged' ? { color: FLUO.violet } : undefined}
              >
                {verdictSummary(mr)}
              </Badge>
              {/* The one piece of good news worth a badge: nothing is left to do but merge
                  it. Fluo green rather than a Fluent tint so it reads as the row's verdict
                  and not as another field. */}
              {mrReadyToMerge(mr) && (
                <Badge
                  appearance="outline"
                  size="small"
                  style={{ color: FLUO.green, borderColor: FLUO.green }}
                >
                  ready to merge
                </Badge>
              )}
              {/* …and its opposite, which the pane could not say at all until now: the
                  reasons GitLab is refusing the merge. Only the ones nothing else on the row
                  already carries — the pipeline has its own badge and its stage dots, the
                  approval bar has the badge beside it, and a draft has its chip up in the
                  title. What is left is exactly what the row could not previously express:
                  conflicts, a branch needing a rebase, another MR in the way, unresolved
                  threads. Listed rather than summarised, because GitLab surfaces them
                  together and fixing one at a time is a trip per reason. */}
              {blockers.map((blocker) => (
                <Badge
                  key={blocker}
                  appearance="outline"
                  size="small"
                  style={{ color: FLUO.red, borderColor: FLUO.red }}
                >
                  {mergeBlockerLabel(blocker, mr.provider)}
                </Badge>
              ))}
              <Caption1 className={styles.muted}>
                {mr.sourceBranch} → {mr.targetBranch}
              </Caption1>
            </div>

            {/* Every stage, in pipeline order. The overall badge above says whether CI is
                green; this says how far it got and which part broke — the question you
                actually have while an MR sits there. Absent when the jobs could not be
                read (the endpoint is permission-gated), rather than faked from the
                overall status. */}
            {mr.pipelineStages.length > 0 && (
              <div className={styles.stages}>
                {mr.pipelineStages.map((stage) => (
                  <Caption1
                    key={stage.name}
                    className={styles.stage}
                    title={`${stage.name}: ${stage.status}`}
                  >
                    <span
                      className={mergeClasses(
                        styles.stageDot,
                        stage.status === 'running' && styles.stageDotRunning,
                      )}
                      // The animation owns the colour while running, so setting it here too
                      // would be the value the keyframes immediately override.
                      style={
                        stage.status === 'running'
                          ? undefined
                          : { backgroundColor: PIPELINE_COLOR[stage.status] }
                      }
                    />
                    {stage.name}
                  </Caption1>
                ))}
              </div>
            )}

            {reason && <Caption1 style={{ color: UNREAD_ORANGE }}>{reason}</Caption1>}

            {/* Both actions silence an MR that is shouting, and a settled one cannot shout
                (see `mrNeedsAttention`) — so on a merged or closed row they are two buttons
                that do nothing. The row stays; the controls for a live MR do not. */}
            {!settled && (
              <div className={styles.actions}>
                <Button size="small" appearance="subtle" onClick={() => onMarkRead(mr.id)}>
                  Mark comments read
                </Button>
                <Button size="small" appearance="subtle" onClick={() => onMarkEventsSeen(mr.id)}>
                  Acknowledge pipeline
                </Button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
