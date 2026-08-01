/**
 * The **Chain** section of the My Tasks detail pane — this card's links, written out.
 *
 * The board draws the chain as arrows, which is the right shape for "what runs after what"
 * and the wrong one for anybody not using a mouse: a link is DRAWN by dragging a handle
 * across the board, and unpicked from a popover hanging off a curve. This section is the
 * same facts as a list — *Waiting on* above, *Releases* below — where every row opens that
 * card, names the gate, and carries an unlink button. Everything the drag does, reachable
 * from the keyboard.
 *
 * Only the card's OWN links, one hop each way. The route two and three cards out is the
 * board's job — select a card and its whole route lights up, or switch Chain focus on and
 * the board reduces to it — and a pane this narrow listing a nine-card component would be
 * a worse map than the arrows already are.
 */
import { useEffect, useState } from 'react';
import {
  Button,
  Caption1,
  Text,
  makeStyles,
  mergeClasses,
  tokens,
} from '@fluentui/react-components';
import { LinkDismissRegular } from '@fluentui/react-icons';
import type { Task } from '@shared/model';
import {
  LINK_GATE_LABEL,
  incomingLinks,
  linkSatisfied,
  outgoingLinks,
  type TaskLink,
} from '@shared/taskChain';
import { FoldToggle } from './FoldToggle';

const useStyles = makeStyles({
  /** A **section** of the pane's details cell, like Steps beside it — no border of its own. */
  box: { display: 'flex', flexDirection: 'column', gap: '8px' },
  head: { display: 'flex', alignItems: 'center', gap: '8px' },
  group: { display: 'flex', flexDirection: 'column', gap: '2px' },
  hint: { color: tokens.colorNeutralForeground3 },
  list: { display: 'flex', flexDirection: 'column' },
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
    borderTop: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  /**
   * The card's name and its gate, as a real `<button>` rather than a row with an
   * `onClick` — this whole section exists to be the keyboard route, and a clickable
   * `<div>` would be exactly the thing it is here to replace.
   */
  open: {
    display: 'flex',
    alignItems: 'baseline',
    gap: '8px',
    flex: 1,
    minWidth: 0,
    background: 'none',
    border: 'none',
    padding: '6px 4px',
    textAlign: 'left',
    cursor: 'pointer',
    color: tokens.colorNeutralForeground1,
    ':hover': { backgroundColor: tokens.colorNeutralBackground1Hover },
  },
  /** A predecessor the board no longer holds — nothing to open, so nothing to press. */
  openDead: {
    cursor: 'default',
    color: tokens.colorNeutralForeground3,
    // Declared after `open`, so Griffel's later rule wins and the row does not light up
    // under a pointer that has nothing to click.
    ':hover': { backgroundColor: 'transparent' },
  },
  title: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' },
  /**
   * The gate, and — on an incoming row — whether it is met yet. Monochrome on purpose: a
   * link is a standing fact about the card, and colour on this board is for things that
   * MOVE. The same reasoning as the card's own `waiting on` chip.
   */
  gate: { color: tokens.colorNeutralForeground3, flexShrink: 0 },
});

export interface TaskChainProps {
  /** The card whose chain this is. Never a step — `canLink` refuses those at either end. */
  task: Task;
  /** Every link on the board; this section picks out its own. */
  links: readonly TaskLink[];
  /** Every task, so a row can name the card at the other end (and judge its gate). */
  tasksById: ReadonlyMap<string, Task>;
  /** Show the card at the other end of a row in this pane. */
  onOpen: (taskId: string) => void;
  /** Erase one link. The board owns the call, so the arrow and this row cannot disagree. */
  onUnlink: (linkId: string) => void;
}

export function TaskChain({
  task,
  links,
  tasksById,
  onOpen,
  onUnlink,
}: TaskChainProps): JSX.Element | null {
  const styles = useStyles();
  /**
   * Open to start with, unlike Steps — this section renders at all only when the card HAS
   * links, and then it is two or three rows. A fold that hides three rows you asked for by
   * chaining them would be a fold for its own sake; it is still offered, because the pane
   * is capped at half the screen and the conversation underneath is the half you work in.
   */
  const [open, setOpen] = useState(true);
  useEffect(() => setOpen(true), [task.id]);

  const incoming = incomingLinks(links, task.id);
  const outgoing = outgoingLinks(links, task.id);
  // An unchained card is most cards on this board: it gets no empty section.
  if (incoming.length === 0 && outgoing.length === 0) return null;

  /** One row. `otherId` is the card at the far end — the predecessor, or the successor. */
  function row(link: TaskLink, otherId: string, side: 'in' | 'out'): JSX.Element {
    const other = tasksById.get(otherId);
    const name = other ? other.externalKey || other.title : 'a card this board is not showing';
    // Said only on an incoming row: "waiting" is a fact about THIS card's turn. On an
    // outgoing row the same link is the other card's business, and its own pane says it.
    const waiting = side === 'in' && !linkSatisfied(link, other);
    return (
      <div key={link.id} className={styles.row}>
        <button
          type="button"
          className={mergeClasses(styles.open, !other && styles.openDead)}
          disabled={!other}
          title={other ? `Open ${name}` : undefined}
          onClick={() => other && onOpen(other.id)}
        >
          <Text className={styles.title}>{name}</Text>
          {/* The gate as a clause, so the row reads as a sentence under its heading:
              "Waiting on ACME-3 · runs after the branch merges". */}
          <Caption1 className={styles.gate}>
            {LINK_GATE_LABEL[link.gate]}
            {waiting ? ' · waiting' : ''}
          </Caption1>
        </button>
        <Button
          size="small"
          appearance="subtle"
          icon={<LinkDismissRegular />}
          title={`Unlink ${name}`}
          aria-label={`Unlink ${name}`}
          onClick={() => onUnlink(link.id)}
        />
      </div>
    );
  }

  const summary = [
    incoming.length ? `waits on ${incoming.length}` : null,
    outgoing.length ? `releases ${outgoing.length}` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <div className={styles.box}>
      <div className={styles.head}>
        <FoldToggle open={open} onToggle={() => setOpen((v) => !v)} summary={summary}>
          <Text weight="semibold">Chain</Text>
        </FoldToggle>
      </div>

      {open && incoming.length > 0 && (
        <div className={styles.group}>
          <Caption1 className={styles.hint}>Waiting on</Caption1>
          <div className={styles.list}>{incoming.map((l) => row(l, l.fromTaskId, 'in'))}</div>
        </div>
      )}

      {open && outgoing.length > 0 && (
        <div className={styles.group}>
          <Caption1 className={styles.hint}>Releases</Caption1>
          <div className={styles.list}>{outgoing.map((l) => row(l, l.toTaskId, 'out'))}</div>
        </div>
      )}
    </div>
  );
}
