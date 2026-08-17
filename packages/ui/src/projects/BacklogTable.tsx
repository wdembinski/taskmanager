/**
 * BacklogTable — every ticket in one native ticket project, grouped by epic.
 *
 * A row click opens `TicketDrawer` on that ticket — labels, milestones and links are all
 * managed from there, so this component's own job stays what it always was: loading the
 * project's tickets, the search box, the sort toggle, and rendering `backlogView`'s grouped
 * rows as a plain Fluent `Table` — `StatusMapViewer.tsx` is the repo's only other one, and
 * there is no `DataGrid` in this workspace to reach for instead.
 *
 * Keyed by `projectId` at the call site (`Projects.tsx`) rather than reacting to it changing
 * in place: switching the selected project is rare enough that a remount — a fresh seed load,
 * a fresh subscription — is simpler than reconciling this component's state to a new project
 * mid-life, and `useInitialLoad` already gives a clean loading skeleton for it.
 */
import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import {
  Avatar,
  Badge,
  Caption1,
  Input,
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  ToggleButton,
  Body1,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import {
  BeakerRegular,
  BugRegular,
  BookmarkRegular,
  NoteRegular,
  PersonRegular,
  SearchRegular,
  SparkleRegular,
  TaskListSquareLtrRegular,
} from '@fluentui/react-icons';
import type { Milestone, Person, Task, TicketLabel } from '@tm/shared/model';
import { typeIconKeyFor, type TypeIconKey } from '@tm/shared/tickets';
import { PriorityGlyph } from '../PriorityGlyph';
import { PaneLoading } from '../PaneLoading';
import { useTransport } from '../transport';
import { useInitialLoad } from '../useInitialLoad';
import { type BacklogSortKey, backlogRows } from './backlogView';
import { TicketDrawer } from './TicketDrawer';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: '10px', minHeight: 0 },
  toolbar: { display: 'flex', alignItems: 'center', gap: '8px' },
  search: { flex: 1, maxWidth: '320px' },
  scroll: { overflowY: 'auto', minHeight: 0 },
  typeCell: { display: 'flex', alignItems: 'center', color: tokens.colorNeutralForeground2 },
  groupRow: { backgroundColor: tokens.colorNeutralBackground2 },
  groupCell: { fontWeight: tokens.fontWeightSemibold },
  muted: { color: tokens.colorNeutralForeground3 },
  labelsCell: { display: 'flex', flexWrap: 'wrap', gap: '4px' },
  empty: { color: tokens.colorNeutralForeground3, padding: '8px 0' },
  clickableRow: { cursor: 'pointer' },
});

/**
 * The card's own type icon, keyed the same way `TaskCard.typeIcon` resolves one, so a ticket
 * reads the same glyph here as it would on a board. Not imported from there directly: that
 * function reads `externalType`/`type`, board-card fields a native ticket doesn't carry the
 * same way — `typeIconKeyFor` (`@tm/shared/tickets`) is the pure, ticket-aware equivalent.
 */
const TYPE_ICON: Record<TypeIconKey, JSX.Element> = {
  epic: <SparkleRegular />,
  story: <BookmarkRegular />,
  task: <TaskListSquareLtrRegular />,
  bug: <BugRegular />,
  subtask: <PersonRegular />,
  feature: <BeakerRegular />,
  note: <NoteRegular />,
};

export interface BacklogTableProps {
  projectId: string;
  /** App-wide roster, for the assignee column. */
  people: Person[];
  /** This project's label registry, for chip colours — tickets carry label NAMES, not ids. */
  labels: TicketLabel[];
  /** This project's milestones, for the milestone column — tickets carry only `milestoneId`. */
  milestones: Milestone[];
}

function personName(people: Person[], id: string | null | undefined): string | null {
  if (!id) return null;
  return people.find((p) => p.id === id)?.name ?? null;
}

function labelColor(labels: TicketLabel[], name: string): string | undefined {
  return labels.find((l) => l.name.toLowerCase() === name.toLowerCase())?.color || undefined;
}

function milestoneName(milestones: Milestone[], id: string | null | undefined): string | null {
  if (!id) return null;
  return milestones.find((m) => m.id === id)?.name ?? null;
}

export function BacklogTable({
  projectId,
  people,
  labels,
  milestones,
}: BacklogTableProps): JSX.Element {
  const styles = useStyles();
  const transport = useTransport();
  const [tickets, setTickets] = useState<Task[] | null>(null);
  const [query, setQuery] = useState('');
  const [sortKey, setSortKey] = useState<BacklogSortKey>('key');
  const [selectedTicketId, setSelectedTicketId] = useState<string | null>(null);

  const seed = useCallback(
    async () => setTickets(await transport.invoke('board:tasks', projectId)),
    [transport, projectId],
  );
  const initial = useInitialLoad(seed);

  useEffect(() => {
    const offTask = transport.on('task:changed', ({ task }) => {
      if (task.projectId !== projectId) return;
      setTickets((prev) => (prev ? prev.map((t) => (t.id === task.id ? task : t)) : prev));
    });
    // The whole list, replaced — a ticket can also leave this way (deleted), which no
    // per-task patch would ever say.
    const offTasks = transport.on('project:tasksChanged', ({ projectId: changed, tasks }) => {
      if (changed !== projectId) return;
      setTickets(tasks);
    });
    return () => {
      offTask();
      offTasks();
    };
  }, [transport, projectId]);

  const rows = useMemo(
    () => (tickets ? backlogRows(tickets, query, sortKey) : []),
    [tickets, query, sortKey],
  );

  if (tickets === null) {
    return (
      <PaneLoading
        label="Loading backlog…"
        error={initial.error}
        onRetry={initial.retry}
        shape="rows"
      />
    );
  }

  // Derived, not stored: as `tickets` is replaced by the `task:changed` / `project:tasksChanged`
  // subscriptions above, the open drawer picks up the fresh row on its own next render — no
  // callback needed to tell it a save landed.
  const selectedTicket = tickets.find((t) => t.id === selectedTicketId) ?? null;

  return (
    <div className={styles.root}>
      <div className={styles.toolbar}>
        <Input
          className={styles.search}
          contentBefore={<SearchRegular />}
          value={query}
          onChange={(_e, d) => setQuery(d.value)}
          placeholder="Search title, key or label…"
        />
        <ToggleButton
          size="small"
          appearance="subtle"
          checked={sortKey === 'key'}
          onClick={() => setSortKey('key')}
        >
          Sort by key
        </ToggleButton>
        <ToggleButton
          size="small"
          appearance="subtle"
          checked={sortKey === 'due'}
          onClick={() => setSortKey('due')}
        >
          Sort by due date
        </ToggleButton>
      </div>

      {tickets.length === 0 ? (
        <Body1 className={styles.empty}>No tickets in this project yet.</Body1>
      ) : (
        <div className={styles.scroll}>
          <Table size="small" aria-label="Backlog">
            <TableHeader>
              <TableRow>
                <TableHeaderCell style={{ width: '32px' }} />
                <TableHeaderCell>Key</TableHeaderCell>
                <TableHeaderCell>Title</TableHeaderCell>
                <TableHeaderCell>Assignee</TableHeaderCell>
                <TableHeaderCell>Priority</TableHeaderCell>
                <TableHeaderCell>Due</TableHeaderCell>
                <TableHeaderCell>Milestone</TableHeaderCell>
                <TableHeaderCell>Labels</TableHeaderCell>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((group) => (
                <Fragment key={`group:${group.epicId ?? 'none'}`}>
                  <TableRow className={styles.groupRow}>
                    <TableCell colSpan={8} className={styles.groupCell}>
                      {group.epicTitle} · {group.tickets.length}
                    </TableCell>
                  </TableRow>
                  {group.tickets.map((ticket) => (
                    <TableRow
                      key={ticket.id}
                      className={styles.clickableRow}
                      onClick={() => setSelectedTicketId(ticket.id)}
                    >
                      <TableCell className={styles.typeCell}>
                        {TYPE_ICON[typeIconKeyFor(ticket)]}
                      </TableCell>
                      <TableCell>{ticket.ticketKey ?? '—'}</TableCell>
                      <TableCell>{ticket.title}</TableCell>
                      <TableCell>
                        {ticket.assigneeId ? (
                          <Avatar
                            name={personName(people, ticket.assigneeId) ?? undefined}
                            size={20}
                          />
                        ) : (
                          <Caption1 className={styles.muted}>Unassigned</Caption1>
                        )}
                      </TableCell>
                      <TableCell>
                        <PriorityGlyph mode="mono" priority={ticket.externalPriority} size={16} />
                      </TableCell>
                      <TableCell>
                        {ticket.dueAt ? (
                          new Date(ticket.dueAt).toLocaleDateString()
                        ) : (
                          <Caption1 className={styles.muted}>—</Caption1>
                        )}
                      </TableCell>
                      <TableCell>
                        {milestoneName(milestones, ticket.milestoneId) ?? (
                          <Caption1 className={styles.muted}>—</Caption1>
                        )}
                      </TableCell>
                      <TableCell>
                        <div className={styles.labelsCell}>
                          {(ticket.labels ?? []).map((name) => (
                            <Badge
                              key={name}
                              appearance="tint"
                              style={
                                labelColor(labels, name)
                                  ? { backgroundColor: labelColor(labels, name) }
                                  : undefined
                              }
                            >
                              {name}
                            </Badge>
                          ))}
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </Fragment>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <TicketDrawer
        ticket={selectedTicket}
        tickets={tickets}
        people={people}
        labels={labels}
        milestones={milestones}
        onClose={() => setSelectedTicketId(null)}
      />
    </div>
  );
}
