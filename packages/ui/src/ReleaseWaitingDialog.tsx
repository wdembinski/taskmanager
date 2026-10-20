/**
 * ReleaseWaitingDialog — what to do about the cards waiting on a card a human just called Done.
 *
 * An `after-merge` arrow waits for the card's `landedAt`, and a move to Done by hand never
 * writes it, so the cards chained after it would wait forever (`@tm/shared/releaseOnDone`).
 * The move has ALREADY happened when this opens: it decides only the release. "Release"
 * marks the card landed without a merge (`chain:releaseLanded`), and the chain starts whatever
 * that frees exactly as a merge would. "Keep waiting", Esc or closing does nothing at all.
 *
 * Shaped like `ConfirmMergeDialog`: busy while the release runs, and a refusal stays open
 * with its sentence in a `MessageBar` rather than closing blind. The answer the decision
 * picked (`releaseDefault`) is the primary button and holds the initial focus.
 *
 * {@link useReleaseOnDone} is how the three human move paths (the desktop board, the web
 * board and the status dropdown) and the panel's **Release waiting cards** open it. It is
 * never asked from a `task:changed` listener — a sync's move must not ask.
 */
import { useCallback, useState } from 'react';
import {
  Button,
  Dialog,
  DialogActions,
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
import type { Task } from '@tm/shared/model';
import { releasePrompt, type ReleaseChoice, type ReleaseMr } from '@tm/shared/releaseOnDone';
import type { TaskLink } from '@tm/shared/taskChain';
import { useTransport } from './transport';

const useStyles = makeStyles({
  content: { display: 'flex', flexDirection: 'column', gap: '12px' },
  list: { margin: 0, paddingLeft: '20px', display: 'flex', flexDirection: 'column', gap: '4px' },
  key: { color: tokens.colorNeutralForeground3, marginRight: '6px' },
});

/** A card's key as the board shows it — a native ticket's, else a tracker's. */
function keyOf(task: Pick<Task, 'externalKey' | 'ticketKey'>): string | null {
  return task.ticketKey || task.externalKey || null;
}

/** "1 card" / "2 cards". */
export function cardCount(n: number): string {
  return `${n} ${n === 1 ? 'card' : 'cards'}`;
}

export interface ReleaseWaitingDialogProps {
  /** The card moved to Done — the one that would be marked landed. */
  task: Pick<Task, 'id' | 'title' | 'externalKey' | 'ticketKey'>;
  /** The cards its `after-merge` arrows still hold (`heldSuccessors`). */
  targets: readonly Pick<Task, 'id' | 'title' | 'externalKey' | 'ticketKey'>[];
  /** The primary, autofocused answer. */
  defaultChoice: ReleaseChoice;
  onClose: () => void;
}

export function ReleaseWaitingDialog({
  task,
  targets,
  defaultChoice,
  onClose,
}: ReleaseWaitingDialogProps): React.JSX.Element {
  const styles = useStyles();
  const transport = useTransport();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const n = targets.length;

  async function release(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const refusal = await transport.invoke('chain:releaseLanded', task.id);
      if (refusal) setError(refusal);
      else onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const releaseFirst = defaultChoice === 'release';
  return (
    <Dialog open onOpenChange={(_e, d) => !d.open && !busy && onClose()}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>Release {n === 1 ? '1 waiting card' : `${n} waiting cards`}?</DialogTitle>
          <DialogContent className={styles.content}>
            {error && (
              <MessageBar intent="error">
                <MessageBarBody>{error}</MessageBarBody>
              </MessageBar>
            )}
            <Text>
              <b>{keyOf(task) ? `${keyOf(task)} — ${task.title}` : task.title}</b> is Done, but its
              branch has not merged through this app, so {cardCount(n)} chained to run after it{' '}
              {n === 1 ? 'is' : 'are'} still waiting:
            </Text>
            <ul className={styles.list}>
              {targets.map((t) => (
                <li key={t.id}>
                  {keyOf(t) && <span className={styles.key}>{keyOf(t)}</span>}
                  {t.title}
                </li>
              ))}
            </ul>
            <Text>
              Releasing marks it landed without a merge, and the chain starts them as it would after
              one.
            </Text>
          </DialogContent>
          <DialogActions>
            <Button
              appearance={releaseFirst ? 'secondary' : 'primary'}
              autoFocus={!releaseFirst}
              disabled={busy}
              onClick={onClose}
            >
              Keep waiting until its branch merges
            </Button>
            <Button
              appearance={releaseFirst ? 'primary' : 'secondary'}
              autoFocus={releaseFirst}
              disabled={busy}
              icon={busy ? <Spinner size="tiny" /> : undefined}
              onClick={() => void release()}
            >
              {busy ? 'Releasing…' : `Release ${cardCount(n)} now`}
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

interface Open {
  task: Task;
  targets: Task[];
  defaultChoice: ReleaseChoice;
}

/**
 * The release dialog for a HUMAN's move into Done.
 *
 * `askAfterMove` is called by a human move path once its move resolved, with the card as it
 * was and as the move returned it; it opens the dialog when `releasePrompt` says to, always
 * with `origin: 'human'`. `offer` opens it directly — the panel's **Release waiting cards**.
 * Render `dialog` anywhere under the same `TransportProvider`.
 */
export function useReleaseOnDone(): {
  askAfterMove: (
    before: Task,
    after: Task,
    links: readonly TaskLink[],
    byId: ReadonlyMap<string, Task>,
    mrs: readonly ReleaseMr[],
  ) => void;
  offer: (task: Task, targets: Task[], defaultChoice?: ReleaseChoice) => void;
  dialog: React.JSX.Element | null;
} {
  const [open, setOpen] = useState<Open | null>(null);
  const askAfterMove = useCallback(
    (
      before: Task,
      after: Task,
      links: readonly TaskLink[],
      byId: ReadonlyMap<string, Task>,
      mrs: readonly ReleaseMr[],
    ) => {
      const prompt = releasePrompt({
        origin: 'human',
        before,
        after,
        links,
        byId,
        mergeRequests: mrs,
      });
      if (prompt) setOpen({ task: after, ...prompt });
    },
    [],
  );
  const offer = useCallback(
    (task: Task, targets: Task[], defaultChoice: ReleaseChoice = 'release') => {
      if (targets.length) setOpen({ task, targets, defaultChoice });
    },
    [],
  );
  const dialog = open ? (
    <ReleaseWaitingDialog
      key={open.task.id}
      task={open.task}
      targets={open.targets}
      defaultChoice={open.defaultChoice}
      onClose={() => setOpen(null)}
    />
  ) : null;
  return { askAfterMove, offer, dialog };
}
