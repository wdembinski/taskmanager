/**
 * The Links section of `TaskDetail`'s band — every ticket link and chain link that touches
 * one ticket (`linkedTicketRows`), grouped the way `linksFor()` already phrases them. Absent
 * entirely when the ticket has neither kind of link, so an unchained, unlinked card — most
 * of them — grows no empty section.
 *
 * The chain pointer row only POINTS at `TaskChain` ("Runs after TM-31 — see Chain"); it never
 * repeats what that section already draws, because chain arrows are an engine fact kept in
 * one place. Clicking it scrolls `chainRef` into view, when there is one mounted to scroll
 * to — on the compact phone layout, Chain lives on a different tab, so the ref stays null and
 * the row is shown but inert; switching tabs there is not this section's job.
 *
 * Monochrome on purpose, the same rule `TaskChain` states for its own gate row: a link is a
 * standing fact about the card, and colour on this board is for things that MOVE. The one
 * exception is the linked ticket's own status badge (`columnBadge`), reused unchanged from
 * the board column it reads off.
 */
import { useState, type RefObject } from 'react';
import { Badge, Button, Caption1, Text, makeStyles, tokens } from '@fluentui/react-components';
import { DeleteRegular } from '@fluentui/react-icons';
import type { Task, TicketLink } from '@tm/shared/model';
import type { TaskLink } from '@tm/shared/taskChain';
import { columnBadge } from '../taskStatus';
import { useTransport } from '../transport';
import { issueTypeGlyph } from './issueTypeGlyph';
import { linkedTicketRows, type ChainPointer, type LinkedTicketRow } from './linkedTickets';
import { TicketLinkAddRow, type LinkCandidate } from './TicketLinksEditor';
import { useTicketLinks } from './useTicketLinks';

const useStyles = makeStyles({
  box: { display: 'flex', flexDirection: 'column', gap: '8px' },
  group: { display: 'flex', flexDirection: 'column', gap: '2px' },
  hint: { color: tokens.colorNeutralForeground3 },
  row: { display: 'flex', alignItems: 'center', gap: '6px', justifyContent: 'space-between' },
  rowLabel: { display: 'flex', alignItems: 'center', gap: '6px', minWidth: 0 },
  type: { display: 'flex', flexShrink: 0, color: tokens.colorNeutralForeground3 },
  open: {
    display: 'flex',
    minWidth: 0,
    background: 'none',
    border: 'none',
    padding: 0,
    textAlign: 'left',
    cursor: 'pointer',
    color: tokens.colorNeutralForeground1,
  },
  openDead: { color: tokens.colorNeutralForeground3, cursor: 'default' },
  title: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  chainPointer: {
    background: 'none',
    border: 'none',
    padding: '4px 0',
    textAlign: 'left',
    cursor: 'pointer',
    color: tokens.colorNeutralForeground3,
  },
});

function chainPointerText(chain: ChainPointer): string {
  return [
    chain.runsAfter.length ? `Runs after ${chain.runsAfter.join(', ')}` : null,
    chain.runsBefore.length ? `Runs before ${chain.runsBefore.join(', ')}` : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

export interface TaskLinksSectionProps {
  task: Task;
  /** See `useTicketLinks` — absent, this section loads and keeps its own copy live. */
  ticketLinks?: readonly TicketLink[];
  /** Every link on the board; this section picks out the ones touching `task`. */
  chainLinks?: readonly TaskLink[];
  tasksById: ReadonlyMap<string, Task>;
  /** This project's other tickets — candidates for the add row at the bottom. */
  candidates?: LinkCandidate[];
  /** Show the ticket at the other end of a row in this same pane. */
  onOpenTask?: (taskId: string) => void;
  /** `TaskChain`'s own wrapper, so the chain pointer row can scroll to it — null when that
   *  section is not mounted (a compact tab showing `details`, not `steps`). */
  chainRef?: RefObject<HTMLElement>;
}

export function TaskLinksSection({
  task,
  ticketLinks,
  chainLinks = [],
  tasksById,
  candidates = [],
  onOpenTask,
  chainRef,
}: TaskLinksSectionProps): JSX.Element | null {
  const styles = useStyles();
  const transport = useTransport();
  const links = useTicketLinks(ticketLinks);
  const [busyId, setBusyId] = useState<string | null>(null);

  const section = linkedTicketRows(task, links, tasksById, chainLinks);
  if (!section) return null;

  async function remove(linkId: string): Promise<void> {
    setBusyId(linkId);
    try {
      await transport.invoke('ticketLink:remove', linkId);
    } finally {
      setBusyId(null);
    }
  }

  function row(r: LinkedTicketRow): JSX.Element {
    const badge = r.column ? columnBadge(r.column) : null;
    return (
      <div key={r.linkId} className={styles.row}>
        <div className={styles.rowLabel}>
          {r.issueType && <span className={styles.type}>{issueTypeGlyph(r.issueType)}</span>}
          <button
            type="button"
            className={r.missing ? `${styles.open} ${styles.openDead}` : styles.open}
            disabled={r.missing}
            title={r.missing ? undefined : `Open ${r.key}`}
            onClick={() => onOpenTask?.(r.otherTaskId)}
          >
            <Text className={styles.title}>
              {r.key}
              {r.title ? ` ${r.title}` : ''}
            </Text>
          </button>
          {r.otherProject && <Caption1 className={styles.hint}>(other project)</Caption1>}
          {badge && (
            <Badge appearance="tint" size="small" color={badge.color}>
              {badge.label}
            </Badge>
          )}
        </div>
        <Button
          size="small"
          appearance="subtle"
          icon={<DeleteRegular />}
          disabled={busyId === r.linkId}
          aria-label={`Remove link to ${r.key}`}
          title={`Remove link to ${r.key}`}
          onClick={() => void remove(r.linkId)}
        />
      </div>
    );
  }

  return (
    <div className={styles.box}>
      <Text weight="semibold">Links</Text>
      {section.groups.map((group) => (
        <div key={group.phrase} className={styles.group}>
          <Caption1 className={styles.hint}>{group.phrase}</Caption1>
          {group.rows.map(row)}
        </div>
      ))}
      {section.chain && (
        <button
          type="button"
          className={styles.chainPointer}
          onClick={() =>
            chainRef?.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
          }
        >
          <Caption1>{chainPointerText(section.chain)} — see Chain</Caption1>
        </button>
      )}
      <TicketLinkAddRow ticket={task} candidates={candidates} />
    </div>
  );
}
