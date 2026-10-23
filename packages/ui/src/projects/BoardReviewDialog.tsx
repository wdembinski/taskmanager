/**
 * BoardReviewDialog — "Review open tickets": the readable view of a project's latest ticket
 * review (`@tm/shared/boardReview`), opened from the Projects panel's **Review tickets**.
 *
 * It reads `project:boardReview` on open and follows `project:boardReviewChanged`, so a run
 * started here fills in while the dialog stays open. Four states, one per record status
 * plus "never reviewed": a start button, a spinner with Stop, the failure with Run again, and
 * the report — summary, one row per open ticket with its verdict badge, reason and evidence,
 * the files several tickets touch, and the waves they can run in.
 *
 * Nothing is applied on its own. Every non-OK ticket has its own Apply
 * (`project:applyReviewItem`), and an item applied once reads "Applied" for good — the
 * outcome lives on the review (`applied`), not in this component. A refused Apply keeps its
 * button and shows the refusal beside it.
 *
 * Host-neutral: everything goes through `useTransport()`, so the desktop's `Projects.tsx`
 * and the web's `ProjectAdmin.tsx` open the very same dialog.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Badge,
  Body1,
  Button,
  Caption1,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  MessageBar,
  MessageBarBody,
  Spinner,
  Subtitle2,
  Text,
  makeStyles,
  tokens,
  type BadgeProps,
} from '@fluentui/react-components';
import { CheckmarkCircleRegular, CopyRegular, WarningRegular } from '@fluentui/react-icons';
import {
  boardReviewRecommendations,
  type BoardReviewRecord,
  type BoardReviewTicket,
  type BoardReviewVerdict,
} from '@tm/shared/boardReview';
import type { Project } from '@tm/shared/model';
import { DEFAULT_READY_LANES } from '@tm/shared/readyLanes';
import { useTransport } from '../transport';

const MONO = 'ui-monospace, Consolas, monospace';

const useStyles = makeStyles({
  surface: { width: '1240px', maxWidth: 'calc(100vw - 48px)' },
  content: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalM,
    maxHeight: 'calc(100vh - 168px)',
    overflowY: 'auto',
    paddingRight: tokens.spacingHorizontalS,
  },
  meta: { color: tokens.colorNeutralForeground3 },
  /** Tickets on the left; the files and waves that order them beside, so one screen holds
   *  the whole report. */
  layout: {
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 1fr) 340px',
    gap: tokens.spacingHorizontalL,
    alignItems: 'start',
  },
  side: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM },
  section: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS },
  rows: {
    display: 'flex',
    flexDirection: 'column',
    border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
  },
  row: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: tokens.spacingHorizontalM,
    padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalM}`,
    borderTop: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
    ':first-child': { borderTop: 'none' },
  },
  verdict: { flexShrink: 0, width: '76px', justifyContent: 'center' },
  rowBody: { display: 'flex', flexDirection: 'column', gap: '2px', flex: 1, minWidth: 0 },
  rowHead: { display: 'flex', alignItems: 'baseline', gap: tokens.spacingHorizontalS },
  ref: { fontFamily: MONO, color: tokens.colorNeutralForeground3, flexShrink: 0 },
  title: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  detail: { color: tokens.colorNeutralForeground2 },
  evidence: { margin: 0, padding: 0, listStyleType: 'none' },
  evidenceLine: { fontFamily: MONO, color: tokens.colorNeutralForeground3 },
  apply: {
    flexShrink: 0,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-end',
    gap: '2px',
    maxWidth: '200px',
    textAlign: 'right',
  },
  applied: { color: tokens.colorPaletteGreenForeground1 },
  refused: { color: tokens.colorPaletteRedForeground1 },
  path: { fontFamily: MONO, overflowWrap: 'anywhere' },
  refs: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: tokens.spacingHorizontalXS,
    paddingTop: tokens.spacingVerticalXXS,
  },
  refBadge: { fontFamily: MONO },
  overCap: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalXS,
    color: tokens.colorPaletteDarkOrangeForeground1,
  },
  copy: { marginRight: 'auto' },
});

/** One badge colour per verdict — the badge is the row's whole call, so it carries one. */
const VERDICT_COLOR: Record<BoardReviewVerdict, BadgeProps['color']> = {
  OK: 'success',
  REWRITE: 'informative',
  SPLIT: 'brand',
  MERGE: 'important',
  DROP: 'danger',
  REORDER: 'warning',
  DECIDE: 'severe',
};

/** "3 tickets" / "1 ticket". */
function ticketCount(n: number): string {
  return `${n} ${n === 1 ? 'ticket' : 'tickets'}`;
}

/** The verdict's own field, as one line under the reason — empty for OK and DROP. */
function verdictDetail(t: BoardReviewTicket): string | null {
  switch (t.verdict) {
    case 'REWRITE':
      return t.rewrite ? `New title: ${t.rewrite.title}` : null;
    case 'SPLIT':
      return t.parts ? `Into: ${t.parts.map((p, i) => `${i + 1}. ${p.title}`).join('  ')}` : null;
    case 'MERGE':
      return t.mergeInto ? `Merge into ${t.mergeInto}` : null;
    case 'REORDER':
      return t.after?.length ? `Run after ${t.after.join(', ')}` : null;
    case 'DECIDE':
      return t.question ? `Ask: ${t.question}` : null;
    default:
      return null;
  }
}

export interface BoardReviewDialogProps {
  project: Pick<Project, 'id' | 'name' | 'readyLanes'>;
  onClose: () => void;
}

export function BoardReviewDialog({ project, onClose }: BoardReviewDialogProps): JSX.Element {
  const styles = useStyles();
  const transport = useTransport();
  const [review, setReview] = useState<BoardReviewRecord | null | undefined>(undefined);
  const [titles, setTitles] = useState<ReadonlyMap<string, string>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [applying, setApplying] = useState<string | null>(null);
  const [refusals, setRefusals] = useState<Record<string, string>>({});

  const reload = useCallback(async () => {
    setReview(await transport.invoke('project:boardReview', project.id));
  }, [transport, project.id]);

  useEffect(() => {
    void reload().catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
    // Titles are a nicety beside the refs the report names tickets by; a failed read just
    // leaves the refs on their own.
    void transport
      .invoke('board:tasks', project.id)
      .then((tasks) => setTitles(new Map(tasks.map((t) => [t.id, t.title]))))
      .catch(() => undefined);
    return transport.on('project:boardReviewChanged', (e) => {
      if (e.projectId === project.id) setReview(e.review);
    });
  }, [transport, project.id, reload]);

  async function start(): Promise<void> {
    setStarting(true);
    setError(null);
    setRefusals({});
    try {
      const result = await transport.invoke('project:reviewTickets', project.id);
      if (!result.reviewId) setError(result.error ?? 'The review could not start.');
      else await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setStarting(false);
    }
  }

  async function stop(): Promise<void> {
    try {
      await transport.invoke('project:stopReview', project.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function apply(reviewId: string, recId: string): Promise<void> {
    setApplying(recId);
    try {
      const result = await transport.invoke('project:applyReviewItem', reviewId, recId);
      setRefusals((r) => {
        const next = { ...r };
        if (result.ok) delete next[recId];
        else next[recId] = result.message;
        return next;
      });
      await reload();
    } catch (e) {
      setRefusals((r) => ({ ...r, [recId]: e instanceof Error ? e.message : String(e) }));
    } finally {
      setApplying(null);
    }
  }

  const finished = review?.status === 'done' ? review : null;
  const report = finished?.report ?? null;
  const recommendations = useMemo(
    () => new Map((report ? boardReviewRecommendations(report) : []).map((r) => [r.id, r])),
    [report],
  );
  const cap = project.readyLanes ?? DEFAULT_READY_LANES;
  const running = review?.status === 'running';
  // The parser's own over-cap sentence is drawn on its wave row instead, so it is not said
  // twice; every other warning stays in the bar.
  const warnings = (report?.warnings ?? []).filter(
    (w) =>
      !report?.waves.some(
        (wave, i) =>
          w ===
          `Wave ${i + 1} has ${wave.refs.length} tickets, more than the ready-lane cap of ${cap}.`,
      ),
  );

  return (
    <Dialog open onOpenChange={(_e, d) => !d.open && onClose()}>
      <DialogSurface className={styles.surface} data-board-review="">
        <DialogBody>
          <DialogTitle>Review open tickets</DialogTitle>
          <DialogContent className={styles.content}>
            <Caption1 className={styles.meta}>
              {project.name}
              {review?.finishedAt
                ? ` · reviewed ${new Date(review.finishedAt).toLocaleString()}`
                : ''}
              {report ? ` · ${ticketCount(report.tickets.length)}` : ''}
            </Caption1>

            {error && (
              <MessageBar intent="error">
                <MessageBarBody>{error}</MessageBarBody>
              </MessageBar>
            )}

            {review === undefined && <Spinner size="small" label="Loading the last review…" />}

            {review === null && (
              <Body1>
                One read-only agent run reads every open ticket against the repo and gives each a
                verdict, with the files several tickets touch and the order they can run in. Nothing
                changes until you apply a recommendation.
              </Body1>
            )}

            {running && <Spinner size="small" label="Reviewing the open tickets…" />}

            {review?.status === 'failed' && (
              <MessageBar intent="error">
                <MessageBarBody>
                  The review failed: {review.error ?? 'no reason given.'}
                </MessageBarBody>
              </MessageBar>
            )}

            {report && (
              <>
                {report.summary && <Body1>{report.summary}</Body1>}
                {warnings.length > 0 && (
                  <MessageBar intent="warning">
                    <MessageBarBody>{warnings.join(' ')}</MessageBarBody>
                  </MessageBar>
                )}

                <div className={styles.layout}>
                  <div className={styles.section}>
                    <Subtitle2>Tickets</Subtitle2>
                    <div className={styles.rows}>
                      {report.tickets.map((t) => {
                        const rec = recommendations.get(t.ref);
                        const done = finished?.applied[t.ref];
                        const refusal = refusals[t.ref] ?? (done && !done.ok ? done.message : null);
                        const detail = verdictDetail(t);
                        return (
                          <div key={t.ref} className={styles.row} data-verdict={t.verdict}>
                            <Badge
                              className={styles.verdict}
                              appearance="tint"
                              color={VERDICT_COLOR[t.verdict]}
                            >
                              {t.verdict}
                            </Badge>
                            <div className={styles.rowBody}>
                              <div className={styles.rowHead}>
                                <Text className={styles.ref}>{t.ref}</Text>
                                <Text weight="semibold" className={styles.title}>
                                  {titles.get(t.taskId) ?? ''}
                                </Text>
                              </div>
                              {t.reason && <Text size={200}>{t.reason}</Text>}
                              {detail && <Caption1 className={styles.detail}>{detail}</Caption1>}
                              {t.evidence.length > 0 && (
                                <ul className={styles.evidence}>
                                  {t.evidence.map((line) => (
                                    <li key={line}>
                                      <Caption1 className={styles.evidenceLine}>{line}</Caption1>
                                    </li>
                                  ))}
                                </ul>
                              )}
                            </div>
                            {rec && (
                              <div className={styles.apply}>
                                {done?.ok ? (
                                  <Caption1 className={styles.applied} title={done.message}>
                                    <CheckmarkCircleRegular /> Applied
                                  </Caption1>
                                ) : (
                                  <Button
                                    size="small"
                                    data-apply={rec.id}
                                    title={rec.label}
                                    aria-label={rec.label}
                                    disabled={applying !== null || running}
                                    icon={applying === rec.id ? <Spinner size="tiny" /> : undefined}
                                    onClick={() => finished && void apply(finished.id, rec.id)}
                                  >
                                    Apply
                                  </Button>
                                )}
                                {refusal && !done?.ok && (
                                  <Caption1 className={styles.refused}>{refusal}</Caption1>
                                )}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>

                  <div className={styles.side}>
                    {report.hotFiles.length > 0 && (
                      <div className={styles.section}>
                        <Subtitle2>Hot files</Subtitle2>
                        <div className={styles.rows}>
                          {report.hotFiles.map((f) => (
                            <div key={f.path} className={styles.row} data-hot-file={f.path}>
                              <div className={styles.rowBody}>
                                <Text size={200} className={styles.path}>
                                  {f.path}
                                </Text>
                                {f.note && <Caption1 className={styles.detail}>{f.note}</Caption1>}
                                <div className={styles.refs}>
                                  {f.refs.map((ref) => (
                                    <Badge
                                      key={ref}
                                      appearance="tint"
                                      color="informative"
                                      className={styles.refBadge}
                                    >
                                      {ref}
                                    </Badge>
                                  ))}
                                </div>
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {report.waves.length > 0 && (
                      <div className={styles.section}>
                        <Subtitle2>Waves</Subtitle2>
                        <div className={styles.rows}>
                          {report.waves.map((w, i) => {
                            const over = cap > 0 && w.refs.length > cap;
                            return (
                              <div key={i} className={styles.row} data-wave={i + 1}>
                                <div className={styles.rowBody}>
                                  <Text size={200} weight="semibold">
                                    Wave {i + 1} · {ticketCount(w.refs.length)}
                                  </Text>
                                  {w.note && (
                                    <Caption1 className={styles.detail}>{w.note}</Caption1>
                                  )}
                                  {over && (
                                    <Caption1 className={styles.overCap} data-over-cap="">
                                      <WarningRegular /> More than the ready-lane cap of {cap} — the
                                      rest wait for a lane.
                                    </Caption1>
                                  )}
                                  <div className={styles.refs}>
                                    {w.refs.map((ref) => (
                                      <Badge
                                        key={ref}
                                        appearance="tint"
                                        color="informative"
                                        className={styles.refBadge}
                                      >
                                        {ref}
                                      </Badge>
                                    ))}
                                  </div>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </>
            )}
          </DialogContent>
          <DialogActions>
            {report && (
              <Button
                className={styles.copy}
                appearance="subtle"
                icon={<CopyRegular />}
                onClick={() => void navigator.clipboard.writeText(JSON.stringify(report, null, 2))}
              >
                Copy JSON
              </Button>
            )}
            {running ? (
              <Button onClick={() => void stop()}>Stop review</Button>
            ) : (
              review !== undefined && (
                <Button
                  appearance={review ? 'secondary' : 'primary'}
                  disabled={starting}
                  icon={starting ? <Spinner size="tiny" /> : undefined}
                  onClick={() => void start()}
                >
                  {review ? 'Run again' : 'Start review'}
                </Button>
              )
            )}
            <Button appearance={review ? 'primary' : 'secondary'} onClick={onClose}>
              Close
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
