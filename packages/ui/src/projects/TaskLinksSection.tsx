/**
 * The Links section of `TaskDetail`'s band — every order arrow and ticket link that touches
 * one ticket (`linkedTicketRows`).
 *
 * "Blocked by" and "Blocks" come first and are read off the order ARROWS — the same
 * `dependencyLists` the engine and the board's chips read — so what this section says holds a
 * card is what actually holds it. Each row names the other card, its status and whether the
 * predecessor's work has merged; removing one unlinks the arrow (`chain:unlink`). The gate
 * itself is changed in `TaskChain`, not here. The remaining ticket links (relates,
 * duplicates, …) follow, grouped the way `linksFor()` phrases them, and decide nothing.
 *
 * Always renders the "Links" heading, even with nothing to show — an unlinked ticket gets an
 * empty-state line and the add row instead of the section vanishing outright. A host whose
 * own query came back empty (over a flaky relay, say) and a ticket that genuinely has no
 * links must look the same: something the reader can trust, not a heading that is there some
 * of the time.
 *
 * Monochrome on purpose, the same rule `TaskChain` states for its own gate row: a link is a
 * standing fact about the card, and colour on this board is for things that MOVE. The one
 * exception is the linked ticket's own status badge (`columnBadge`), reused unchanged from
 * the board column it reads off — "merged" / "not merged" stays a grey caption.
 */
import { useState } from 'react';
import { Badge, Button, Caption1, Text, makeStyles, tokens } from '@fluentui/react-components';
import { DeleteRegular } from '@fluentui/react-icons';
import { columnForTask } from '@tm/shared/board';
import type { Task, TicketLink } from '@tm/shared/model';
import type { DependencyRow, TaskLink } from '@tm/shared/taskChain';
import { columnBadge } from '../taskStatus';
import { useTransport } from '../transport';
import { issueTypeGlyph } from './issueTypeGlyph';
import { linkedTicketRows, type LinkedTicketRow } from './linkedTickets';
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
  merged: { flexShrink: 0, color: tokens.colorNeutralForeground3 },
});

export interface TaskLinksSectionProps {
  task: Task;
  /** See `useTicketLinks` — absent, this section loads and keeps its own copy live. */
  ticketLinks?: readonly TicketLink[];
  /** Every order arrow on the board; this section picks out the ones touching `task`. */
  chainLinks?: readonly TaskLink[];
  tasksById: ReadonlyMap<string, Task>;
  /** This project's other tickets — candidates for the add row at the bottom. */
  candidates?: LinkCandidate[];
  /** Show the ticket at the other end of a row in this same pane. */
  onOpenTask?: (taskId: string) => void;
  /** Set when the host relaying ticket writes is unreachable — rows still open the linked
   *  ticket, but Remove is hidden and the add row at the bottom is disabled. */
  readOnly?: boolean;
}

export function TaskLinksSection({
  task,
  ticketLinks,
  chainLinks = [],
  tasksById,
  candidates = [],
  onOpenTask,
  readOnly = false,
}: TaskLinksSectionProps): JSX.Element {
  const styles = useStyles();
  const transport = useTransport();
  const links = useTicketLinks(ticketLinks);
  const [busyId, setBusyId] = useState<string | null>(null);

  const section = linkedTicketRows(task, links, tasksById, chainLinks);

  async function remove(
    linkId: string,
    channel: 'ticketLink:remove' | 'chain:unlink',
  ): Promise<void> {
    setBusyId(linkId);
    try {
      await transport.invoke(channel, linkId);
    } finally {
      setBusyId(null);
    }
  }

  function openButton(
    otherTaskId: string,
    key: string,
    title: string | null,
    missing: boolean,
  ): JSX.Element {
    return (
      <button
        type="button"
        className={missing ? `${styles.open} ${styles.openDead}` : styles.open}
        disabled={missing}
        title={missing ? undefined : `Open ${key}`}
        onClick={() => onOpenTask?.(otherTaskId)}
      >
        <Text className={styles.title}>
          {key}
          {title ? ` ${title}` : ''}
        </Text>
      </button>
    );
  }

  function removeButton(
    linkId: string,
    label: string,
    channel: 'ticketLink:remove' | 'chain:unlink',
  ): JSX.Element | null {
    if (readOnly) return null;
    return (
      <Button
        size="small"
        appearance="subtle"
        icon={<DeleteRegular />}
        disabled={busyId === linkId}
        aria-label={label}
        title={label}
        onClick={() => void remove(linkId, channel)}
      />
    );
  }

  function dependencyRow(r: DependencyRow): JSX.Element {
    // A card with no key, or one that is gone, is named by its id — the same fallback a
    // ticket-link row uses.
    const key = r.key || r.taskId;
    const badge = r.task ? columnBadge(columnForTask(r.task)) : null;
    return (
      <div key={r.linkId} className={styles.row} data-dependency-row={r.linkId}>
        <div className={styles.rowLabel}>
          {r.task?.issueType && (
            <span className={styles.type}>{issueTypeGlyph(r.task.issueType)}</span>
          )}
          {openButton(r.taskId, key, r.task?.title ?? null, r.missing)}
          {badge && (
            <Badge appearance="tint" size="small" color={badge.color}>
              {badge.label}
            </Badge>
          )}
          {!r.missing && (
            <Caption1 className={styles.merged}>{r.merged ? 'merged' : 'not merged'}</Caption1>
          )}
        </div>
        {removeButton(r.linkId, `Remove dependency on ${key}`, 'chain:unlink')}
      </div>
    );
  }

  function ticketRow(r: LinkedTicketRow): JSX.Element {
    const badge = r.column ? columnBadge(r.column) : null;
    return (
      <div key={r.linkId} className={styles.row}>
        <div className={styles.rowLabel}>
          {r.issueType && <span className={styles.type}>{issueTypeGlyph(r.issueType)}</span>}
          {openButton(r.otherTaskId, r.key, r.title, r.missing)}
          {r.otherProject && <Caption1 className={styles.hint}>(other project)</Caption1>}
          {badge && (
            <Badge appearance="tint" size="small" color={badge.color}>
              {badge.label}
            </Badge>
          )}
        </div>
        {removeButton(r.linkId, `Remove link to ${r.key}`, 'ticketLink:remove')}
      </div>
    );
  }

  return (
    <div className={styles.box}>
      <Text weight="semibold">Links</Text>
      {section ? (
        <>
          {section.blockedBy.length > 0 && (
            <div className={styles.group} data-links-blocked-by="">
              <Caption1 className={styles.hint}>Blocked by</Caption1>
              {section.blockedBy.map(dependencyRow)}
            </div>
          )}
          {section.blocks.length > 0 && (
            <div className={styles.group} data-links-blocks="">
              <Caption1 className={styles.hint}>Blocks</Caption1>
              {section.blocks.map(dependencyRow)}
            </div>
          )}
          {section.groups.map((group) => (
            <div key={group.phrase} className={styles.group}>
              <Caption1 className={styles.hint}>{group.phrase}</Caption1>
              {group.rows.map(ticketRow)}
            </div>
          ))}
        </>
      ) : (
        <Caption1 className={styles.hint}>No linked tickets.</Caption1>
      )}
      <TicketLinkAddRow
        ticket={task}
        candidates={candidates}
        chainLinks={chainLinks}
        disabled={readOnly}
      />
    </div>
  );
}
