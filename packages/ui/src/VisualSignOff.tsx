/**
 * VisualSignOff — the card panel's own look at the shots `ui-shots.mjs` left on the owner
 * card, and the one place a human actually signs off on them.
 *
 * TM-446 made every UI-shaped task screenshot the real app next to its mockup, but the shots
 * landed on a planned card's STEP (`run.taskId`), reachable only through that step's own
 * editor (`TaskSteps`' `attachmentsInScope`). This section is the fix's visible half: it
 * reads the OWNER card's own attachments — `scheduler.ts`'s `ingestAttachOutbox` now writes
 * there, never to a step — groups them back into one row per screen with
 * `@tm/shared/visualSignOff`'s `shotPairs`, and renders nothing at all when there is nothing
 * to show (a card that was never shot by `ui-shots.mjs`).
 *
 * The header's own state (pending/approved/needs changes) and each row's agent verdict both
 * come from `latestVisualState`, reading the SAME timeline comments `attachOutbox.ts` posts
 * (the agent's own `formatVisualSignOffComment`) and this section posts back
 * (`formatSignOff`) — no new schema, no migration, just two more shapes of comment the one
 * shared module agrees on (see the plan's own "verdicts travel as timeline comments"
 * decision).
 *
 * Approving or flagging changes posts a comment via the same `task:addComment` channel the
 * composer already uses, then re-reads the card's own activity — the one piece of state this
 * section cannot get handed down, since nothing above it reloads on its behalf. Flagging
 * changes ALSO hands the composer a starting line (`onNeedsChanges`), so the human's own words
 * land right under a message that already says which screens they mean.
 */
import { useEffect, useState } from 'react';
import {
  Badge,
  Button,
  Caption1,
  Dialog,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  MessageBar,
  MessageBarBody,
  Spinner,
  Text,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import {
  CheckmarkCircleRegular,
  ClockRegular,
  DismissRegular,
  OpenRegular,
  WarningRegular,
} from '@fluentui/react-icons';
import { attachmentUrl, type TaskAttachment } from '@tm/shared/attachments';
import type { TaskActivityEntry } from '@tm/shared/model';
import {
  latestVisualState,
  shotPairs,
  type ShotPair,
  type SignOffStatus,
} from '@tm/shared/visualSignOff';
import { useTransport, type Transport } from './transport';

const useStyles = makeStyles({
  root: {
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
    padding: '8px',
    borderRadius: tokens.borderRadiusMedium,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  head: { display: 'flex', alignItems: 'center', gap: '8px' },
  grow: { flex: 1 },
  rows: { display: 'flex', flexDirection: 'column', gap: '10px' },
  row: { display: 'flex', flexDirection: 'column', gap: '4px' },
  rowHead: { display: 'flex', alignItems: 'center', gap: '8px' },
  thumbs: { display: 'flex', gap: '6px' },
  thumbWrap: { display: 'flex', flexDirection: 'column', gap: '2px', alignItems: 'center' },
  thumb: {
    maxWidth: '160px',
    maxHeight: '110px',
    borderRadius: tokens.borderRadiusSmall,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    display: 'block',
    objectFit: 'cover',
  },
  thumbLabel: { color: tokens.colorNeutralForeground3 },
  hint: { color: tokens.colorNeutralForeground3 },
  mismatch: { color: tokens.colorPaletteRedForeground1 },
  error: { color: tokens.colorPaletteRedForeground1 },
  dialogImages: { display: 'flex', gap: '12px', flexWrap: 'wrap' },
  dialogFigure: { flex: '1 1 0', minWidth: 0 },
  dialogImg: { display: 'block', width: '100%', borderRadius: tokens.borderRadiusSmall },
});

export interface VisualSignOffProps {
  /** The owner card's own attachments — never a step's. */
  attachments: readonly TaskAttachment[];
  /** The card's own timeline, read for the latest agent verdict and human sign-off. */
  activity: readonly TaskActivityEntry[];
  /** Flagging changes hands the composer this starting line. */
  onNeedsChanges: (text: string) => void;
}

type Busy = 'approve' | 'needs-changes' | null;

/**
 * Posts a human's verdict through `task:visualSignOff` — the one channel both buttons below
 * call, so a recording transport can prove each one reaches it with the right status (and,
 * for `needs-changes`, the right screens) without rendering anything.
 */
export function submitVisualSignOff(
  transport: Transport,
  taskId: string,
  status: SignOffStatus,
  screens?: readonly string[],
): Promise<TaskActivityEntry> {
  return transport.invoke('task:visualSignOff', taskId, status, screens);
}

/** The attachment the desktop's "Open comparison" opens for one row: its own side-by-side
 *  page, else the contact sheet, else the real PNG itself. */
export function comparisonTarget(pair: ShotPair, indexHtml?: TaskAttachment): TaskAttachment {
  return pair.html ?? indexHtml ?? pair.real;
}

/** Opens `comparisonTarget` through `attachment:open` — what the desktop button calls. */
export function openComparisonOnDesktop(
  transport: Transport,
  pair: ShotPair,
  indexHtml?: TaskAttachment,
): void {
  void transport.invoke('attachment:open', comparisonTarget(pair, indexHtml).id);
}

/** `transport.attachmentUrl?.(a) ?? attachmentUrl(a.id)` — `AttachmentStrip.tsx`'s own
 *  expression, so an image preview resolves the same way everywhere it is used. */
function imageSrc(
  transport: { attachmentUrl?(a: TaskAttachment): string },
  a: TaskAttachment,
): string {
  return transport.attachmentUrl?.(a) ?? attachmentUrl(a.id);
}

function StateBadge({ state }: { state: 'pending' | 'approved' | 'needs-changes' }): JSX.Element {
  if (state === 'approved') {
    return (
      <Badge appearance="tint" color="success" icon={<CheckmarkCircleRegular />}>
        Approved
      </Badge>
    );
  }
  if (state === 'needs-changes') {
    return (
      <Badge appearance="tint" color="warning" icon={<WarningRegular />}>
        Needs changes
      </Badge>
    );
  }
  return (
    <Badge appearance="tint" color="informative" icon={<ClockRegular />}>
      Pending
    </Badge>
  );
}

export function VisualSignOff({
  attachments,
  activity,
  onNeedsChanges,
}: VisualSignOffProps): JSX.Element | null {
  const styles = useStyles();
  const transport = useTransport();
  /**
   * A freshly re-fetched activity list, standing in for `activity` until the parent's OWN
   * reload catches up — nothing above this section reloads on its behalf after Approve or
   * Needs changes. Dropped the moment a new `activity` array arrives from the parent, so a
   * card switch (or the parent's own later reload) is never shadowed by a stale override.
   */
  const [activityOverride, setActivityOverride] = useState<readonly TaskActivityEntry[] | null>(
    null,
  );
  useEffect(() => setActivityOverride(null), [activity]);
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);
  const [dialogRow, setDialogRow] = useState<ShotPair | null>(null);

  const { pairs, indexHtml } = shotPairs(attachments);

  // Nothing here is the common case — most cards are never shot by `ui-shots.mjs`.
  if (pairs.length === 0) return null;

  const taskId = pairs[0].real.taskId;
  const screens = pairs.map((p) => p.name);
  const state = latestVisualState(activityOverride ?? activity, screens);

  async function refreshActivity(): Promise<void> {
    const fresh = await transport.invoke('task:activity', taskId).catch(() => null);
    if (fresh) setActivityOverride(fresh);
  }

  async function approve(): Promise<void> {
    setBusy('approve');
    setError(null);
    try {
      await submitVisualSignOff(transport, taskId, 'approved');
      await refreshActivity();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function flagNeedsChanges(): Promise<void> {
    setBusy('needs-changes');
    setError(null);
    try {
      await submitVisualSignOff(transport, taskId, 'needs-changes', screens);
      await refreshActivity();
      onNeedsChanges(`Needs changes on: ${screens.join(', ')} — `);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  function openComparison(pair: ShotPair): void {
    if (transport.host === 'web') {
      setDialogRow(pair);
      return;
    }
    openComparisonOnDesktop(transport, pair, indexHtml);
  }

  return (
    <div className={styles.root} data-visual-signoff>
      <div className={styles.head}>
        <Text weight="semibold">Visual sign-off</Text>
        <StateBadge state={state.human} />
        {/* Rows open their own side-by-side page now, so the contact sheet keeps its own
            link — desktop only, since the web host's dialog is per-row. */}
        {indexHtml && transport.host !== 'web' && (
          <Button
            size="small"
            appearance="subtle"
            icon={<OpenRegular />}
            onClick={() => void transport.invoke('attachment:open', indexHtml.id)}
          >
            Open all
          </Button>
        )}
        <span className={styles.grow} />
        <Button
          size="small"
          appearance="subtle"
          disabled={busy !== null}
          icon={busy === 'needs-changes' ? <Spinner size="tiny" /> : <DismissRegular />}
          onClick={() => void flagNeedsChanges()}
        >
          Needs changes
        </Button>
        <Button
          size="small"
          appearance="primary"
          disabled={busy !== null}
          icon={busy === 'approve' ? <Spinner size="tiny" /> : <CheckmarkCircleRegular />}
          onClick={() => void approve()}
        >
          Approve
        </Button>
      </div>

      {error && (
        <MessageBar intent="error">
          <MessageBarBody>{error}</MessageBarBody>
        </MessageBar>
      )}

      <div className={styles.rows}>
        {pairs.map((pair) => {
          const row = state.rows.get(pair.name);
          return (
            <div key={pair.name} className={styles.row}>
              <div className={styles.rowHead}>
                <Text weight="semibold">{pair.name}</Text>
                {row?.status === 'mismatch' && (
                  <Caption1 className={styles.mismatch}>{row.note}</Caption1>
                )}
                {row?.status === 'ok' && (
                  <Caption1 className={styles.hint}>Matched the mockup</Caption1>
                )}
                {(!row || row.status === 'unknown') && (
                  <Caption1 className={styles.hint}>No agent verdict yet</Caption1>
                )}
              </div>
              <div className={styles.thumbs}>
                <div className={styles.thumbWrap}>
                  <img
                    className={styles.thumb}
                    src={imageSrc(transport, pair.real)}
                    alt={`${pair.name} — real`}
                  />
                  <Caption1 className={styles.thumbLabel}>real</Caption1>
                </div>
                {pair.mockup && (
                  <div className={styles.thumbWrap}>
                    <img
                      className={styles.thumb}
                      src={imageSrc(transport, pair.mockup)}
                      alt={`${pair.name} — mockup`}
                    />
                    <Caption1 className={styles.thumbLabel}>mockup</Caption1>
                  </div>
                )}
              </div>
              <Button
                size="small"
                appearance="subtle"
                icon={<OpenRegular />}
                // On the web host this opens the in-panel Dialog below, not the desktop's
                // `attachment:open` — `aria-haspopup="dialog"` says so for assistive tech,
                // and is also what tells the two branches apart in a static-markup test.
                aria-haspopup={transport.host === 'web' ? 'dialog' : undefined}
                onClick={() => openComparison(pair)}
              >
                Open comparison
              </Button>
            </div>
          );
        })}
      </div>

      {dialogRow && (
        <Dialog open onOpenChange={(_e, d) => !d.open && setDialogRow(null)}>
          <DialogSurface>
            <DialogBody>
              <DialogTitle>{dialogRow.name}</DialogTitle>
              <DialogContent>
                <div className={styles.dialogImages}>
                  <figure className={styles.dialogFigure}>
                    <Caption1 className={styles.thumbLabel}>real</Caption1>
                    {imageSrc(transport, dialogRow.real) ? (
                      <img
                        className={styles.dialogImg}
                        src={imageSrc(transport, dialogRow.real)}
                        alt={`${dialogRow.name} — real`}
                      />
                    ) : (
                      <Caption1 className={styles.hint}>
                        This host can&apos;t load this image yet.
                      </Caption1>
                    )}
                  </figure>
                  {dialogRow.mockup && (
                    <figure className={styles.dialogFigure}>
                      <Caption1 className={styles.thumbLabel}>mockup</Caption1>
                      {imageSrc(transport, dialogRow.mockup) ? (
                        <img
                          className={styles.dialogImg}
                          src={imageSrc(transport, dialogRow.mockup)}
                          alt={`${dialogRow.name} — mockup`}
                        />
                      ) : (
                        <Caption1 className={styles.hint}>
                          This host can&apos;t load this image yet.
                        </Caption1>
                      )}
                    </figure>
                  )}
                </div>
              </DialogContent>
            </DialogBody>
          </DialogSurface>
        </Dialog>
      )}
    </div>
  );
}
