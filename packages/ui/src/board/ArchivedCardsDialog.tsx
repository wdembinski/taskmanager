/**
 * Removed cards — the list of everything that has left the board without being destroyed,
 * and the way back onto it.
 *
 * The board is the JQL result, so cards leave it: a ticket stops matching the query, a
 * finished card's retention runs out, a ticket is deleted in JIRA. Every one of those used to
 * be a `DELETE` — the card and its timeline, its files, its chain arrows and its transcript
 * went with it, silently, on a poll nobody was watching. They are archived now, and this is
 * the screen that makes that visible: what left, when, why, and one click to put it back.
 *
 * **No colour anywhere on it**, deliberately. This board spends colour on things that MOVE —
 * the running band, the travelling dash on a merging card — and a list of cards that are not
 * on the board is the least moving thing in the app. Buttons are neutral, the reasons are
 * prose, and the only emphasis is the key.
 *
 * The formatting is pure and takes `now`, in the same shape as `@tm/shared/sync`'s labels:
 * there is no renderer test infrastructure, so anything with a rule in it lives in a function
 * a `.test.ts` can call without a DOM.
 *
 * Shared with the browser client, which shows the same list for the same reason and can do
 * nothing about it: restoring a card is a write to the board's own database, and there is no
 * `restore` command kind on the wire. That is what {@link ArchivedCardsDialogProps.onRestore}
 * being OPTIONAL means — absent, the rows carry no Restore button. A read-only list is the
 * honest degrade: a card missing from the web board is missing there too, and "why" is the
 * question this dialog answers whether or not the reader can undo it.
 */
import { useState } from 'react';
import {
  Button,
  Caption1,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  makeStyles,
  MessageBar,
  MessageBarBody,
  Text,
  tokens,
} from '@fluentui/react-components';
import { ARCHIVE_RETENTION_DAYS } from '@tm/shared/board';
import type { Task, TaskArchiveReason } from '@tm/shared/model';

/**
 * The CARDS among the archived rows — what the list shows and what the count counts.
 *
 * `board:archived` hands back rows, and archiving a card takes its steps with it (a step has
 * no board presence of its own, so one left behind would be unreachable). Those step rows are
 * archived in every sense the database cares about and belong to nothing the human removed: a
 * card of five steps would otherwise read as six removed cards, and five of the six would have
 * a Restore button that puts back something that is already back.
 */
export function archivedCards(rows: readonly Task[]): Task[] {
  return rows.filter((t) => !t.parentTaskId);
}

/**
 * Why a card is not on the board, in a sentence — one per {@link TaskArchiveReason}, plus the
 * null case.
 *
 * Null is not a shrug at the human's expense: it is the honest answer for a row archived by a
 * version that recorded only the timestamp, and inventing a reason for those would make every
 * other line in this list less trustworthy.
 */
export function archiveReasonText(
  reason: TaskArchiveReason | null | undefined,
  tracker = 'JIRA',
): string {
  switch (reason) {
    case 'left-query':
      return `${tracker} says it no longer matches this board’s query.`;
    case 'retention-expired':
      return 'It was finished, kept past the query, and the retention window ran out.';
    case 'gone-from-jira':
      return `${tracker} no longer has the issue — deleted, or not visible to your token.`;
    default:
      return 'Removed by an earlier version, which did not record why.';
  }
}

/** "today", "yesterday", "6 days ago", "on 12 Mar 2026" — how long ago it left. */
export function removedAgo(archivedAt: number | null | undefined, now: number): string {
  if (archivedAt == null) return 'at some point';
  // Whole days from the elapsed time rather than from calendar boundaries: this sits beside a
  // retention measured in days, and the two should count the same thing.
  const days = Math.floor(Math.max(0, now - archivedAt) / 86_400_000);
  if (days === 0) return 'today';
  if (days === 1) return 'yesterday';
  // Past a week the count stops being something anybody holds in their head, so the date
  // takes over — and it is the date they would search their JIRA history for.
  if (days < 7) return `${days} days ago`;
  return `on ${new Date(archivedAt).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  })}`;
}

/**
 * The whole second line of a row: when it went, and which question sent it.
 *
 * The tracker's NAME comes off the card rather than out of the reason, because the stored
 * reason is a neutral vocabulary shared by both syncs (see `TaskArchiveReason`) and telling
 * someone “JIRA says it no longer matches” about a GitHub issue is exactly the kind of
 * confident wrong sentence this list exists to avoid.
 */
export function removedLine(task: Task, now: number): string {
  const tracker = task.externalSource === 'github' ? 'GitHub' : 'JIRA';
  return `Removed ${removedAgo(task.archivedAt, now)} · ${archiveReasonText(task.archivedReason, tracker)}`;
}

/**
 * What the toolbar button says: the bare count, and nothing else.
 *
 * A number with no noun, because the button is only rendered when the count is non-zero and
 * an archive glyph sits immediately to its left — "3 removed" beside an archive icon says the
 * same thing twice. The sentence belongs in the tooltip, where {@link archivedCountTitle} puts
 * it, and that is also what a screen reader is given.
 */
export function archivedCountLabel(count: number): string {
  return String(count);
}

/** The button's tooltip and accessible name — the noun the label leaves out. */
export function archivedCountTitle(count: number): string {
  return count === 1
    ? '1 card has been removed from the board — click to see it, or put it back'
    : `${count} cards have been removed from the board — click to see them, or put them back`;
}

const useStyles = makeStyles({
  // min(…) rather than a bare 520px: that overflows a 360px phone worse than
  // AddTaskDialog's own 440px does, and the calc side is a no-op at desktop widths.
  body: {
    display: 'flex',
    flexDirection: 'column',
    gap: '12px',
    minWidth: 'min(520px, calc(100vw - 32px))',
  },
  // The list scrolls, the dialog does not: a board that lost thirty cards to a bad JQL is
  // exactly when this screen is opened, and thirty rows must not push the buttons off-screen.
  list: {
    display: 'flex',
    flexDirection: 'column',
    maxHeight: '46vh',
    overflowY: 'auto',
  },
  row: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: '12px',
    padding: '8px 4px',
    // A hairline between rows rather than a card each: these are entries in a list, not
    // objects to be manipulated, and boxing them would make them look like board cards.
    borderBottom: `1px solid ${tokens.colorNeutralStroke3}`,
  },
  rowText: { display: 'flex', flexDirection: 'column', gap: '2px', flex: 1, minWidth: 0 },
  key: { fontFamily: 'ui-monospace, Consolas, monospace', color: tokens.colorNeutralForeground3 },
  title: { overflow: 'hidden', textOverflow: 'ellipsis' },
  why: { color: tokens.colorNeutralForeground3 },
  note: { color: tokens.colorNeutralForeground3 },
});

export interface ArchivedCardsDialogProps {
  open: boolean;
  /** The removed cards, most recently removed first (`board:archived` already orders them). */
  archived: Task[];
  /** Now, in epoch ms — injected so the labels are pure and the tests need no clock. */
  now: number;
  onClose: () => void;
  /**
   * Put one back. Rejects with something worth showing; the dialog reports it.
   *
   * **Optional**, and absent means the list is read-only: no Restore on a row, no Restore
   * all in the footer. That is the browser client's case — a restore is a write to the
   * board's own database and no command on the wire carries one — and a button that could
   * only ever fail would be worse than the list simply saying what is not on the board.
   */
  onRestore?: (taskId: string) => Promise<void>;
}

export function ArchivedCardsDialog({
  open,
  archived,
  now,
  onClose,
  onRestore,
}: ArchivedCardsDialogProps): JSX.Element {
  const styles = useStyles();
  /** The id being restored, `'all'` while the whole list is, or null. Disables the buttons. */
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function restore(taskId: string): Promise<void> {
    if (!onRestore) return;
    setBusy(taskId);
    setError(null);
    try {
      await onRestore(taskId);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  /**
   * One at a time, in the order shown, and it stops at the first failure.
   *
   * Sequential rather than `Promise.all`: each restore pushes the whole board back at every
   * window, so twenty at once is twenty full board pushes racing each other. And stopping on
   * the first error leaves the rest of the list still there to retry — a half-finished
   * "restore all" that also swallowed the reason would be the worse of the two outcomes.
   */
  async function restoreAll(): Promise<void> {
    if (!onRestore) return;
    setBusy('all');
    setError(null);
    try {
      for (const task of archived) await onRestore(task.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(_e, d) => !d.open && onClose()}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>Removed cards</DialogTitle>
          <DialogContent>
            <div className={styles.body}>
              <Caption1 className={styles.note}>
                These cards are off the board but not deleted — their timeline, their files, the
                arrows drawn to and from them and any transcript are all still here
                {onRestore
                  ? ', and restoring one brings it back with the same id'
                  : ', and the desktop app can put any of them back'}
                . They are kept for {ARCHIVE_RETENTION_DAYS} days and then removed for good.
              </Caption1>

              {error && (
                <MessageBar intent="error">
                  <MessageBarBody>{error}</MessageBarBody>
                </MessageBar>
              )}

              {archived.length === 0 ? (
                <Text>Nothing has been removed from the board.</Text>
              ) : (
                <div className={styles.list}>
                  {archived.map((task) => (
                    <div key={task.id} className={styles.row}>
                      <div className={styles.rowText}>
                        <Text className={styles.title} weight="semibold">
                          {task.externalKey && (
                            <span className={styles.key}>{task.externalKey} </span>
                          )}
                          {task.title}
                        </Text>
                        <Caption1 className={styles.why}>{removedLine(task, now)}</Caption1>
                      </div>
                      {onRestore && (
                        <Button
                          size="small"
                          appearance="secondary"
                          disabled={busy !== null}
                          onClick={() => void restore(task.id)}
                        >
                          Restore
                        </Button>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </DialogContent>
          <DialogActions>
            {onRestore && archived.length > 1 && (
              <Button
                appearance="secondary"
                disabled={busy !== null}
                onClick={() => void restoreAll()}
              >
                Restore all
              </Button>
            )}
            <Button appearance="secondary" disabled={busy !== null} onClick={onClose}>
              Close
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
