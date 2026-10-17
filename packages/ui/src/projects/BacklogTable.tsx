/**
 * BacklogTable — every ticket in one native ticket project, grouped by epic.
 *
 * A row click opens the ticket in `Projects.tsx`'s own shared detail pane (F12.8) — this
 * component's job stays what it always was: loading the project's tickets, the search box,
 * the sort toggle, and rendering `backlogView`'s grouped rows as a plain Fluent `Table` —
 * `StatusMapViewer.tsx` is the repo's only other one, and there is no `DataGrid` in this
 * workspace to reach for instead.
 *
 * Keyed by `projectId` at the call site (`Projects.tsx`) rather than reacting to it changing
 * in place: switching the selected project is rare enough that a remount — a fresh seed load,
 * a fresh subscription — is simpler than reconciling this component's state to a new project
 * mid-life, and `useInitialLoad` already gives a clean loading skeleton for it.
 */
import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import {
  Badge,
  Button,
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
  Tooltip,
  makeStyles,
  mergeClasses,
  tokens,
} from '@fluentui/react-components';
import { AddRegular, SearchRegular } from '@fluentui/react-icons';
import { columnForTask } from '@tm/shared/board';
import type { Milestone, Person, Project, Task, TicketLabel, TicketLink } from '@tm/shared/model';
import { delegatedAgentName, typeIconKeyFor } from '@tm/shared/tickets';
import { startReadiness, type StartReadiness } from '@tm/shared/ticketLinks';
import { PriorityGlyph } from '../PriorityGlyph';
import { PaneLoading } from '../PaneLoading';
import { columnBadge } from '../taskStatus';
import { useTransport } from '../transport';
import { useInitialLoad } from '../useInitialLoad';
import { AssigneeDisplay } from './AssigneeDisplay';
import { type BacklogSortKey, backlogRows } from './backlogView';
import { issueTypeGlyph } from './issueTypeGlyph';
import { NewTicketDialog } from './NewTicketDialog';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: '10px', minHeight: 0 },
  toolbar: { display: 'flex', alignItems: 'center', gap: '8px' },
  search: { flex: 1, maxWidth: '320px' },
  scroll: { overflowY: 'auto', minHeight: 0 },
  typeCell: { display: 'flex', alignItems: 'center', color: tokens.colorNeutralForeground2 },
  groupRow: { backgroundColor: tokens.colorNeutralBackground2 },
  groupCell: { fontWeight: tokens.fontWeightSemibold },
  groupHeader: { display: 'flex', alignItems: 'center', justifyContent: 'space-between' },
  muted: { color: tokens.colorNeutralForeground3 },
  labelsCell: { display: 'flex', flexWrap: 'wrap', gap: '4px' },
  empty: { color: tokens.colorNeutralForeground3, padding: '8px 0' },
  clickableRow: { cursor: 'pointer' },
  /** The row backing the ticket open in the shared detail pane — a brand-tinted background
   *  is the one colour change selection is allowed (see `board-colour-budget`'s own rule). */
  selectedRow: { backgroundColor: tokens.colorNeutralBackground1Selected },
});

export interface BacklogTableProps {
  projectId: string;
  /** App-wide roster, for the assignee column. */
  people: Person[];
  /** The repos a ticket can be delegated to — resolves `agentProjectId` to a name for the
   *  assignee column's `<human> / <agent>` display. */
  agentProjects: Project[];
  /** This project's label registry, for chip colours — tickets carry label NAMES, not ids. */
  labels: TicketLabel[];
  /** This project's milestones, for the milestone column — tickets carry only `milestoneId`. */
  milestones: Milestone[];
  /** The ticket open in `Projects.tsx`'s own shared detail pane — highlights its row. */
  selectedTicketId?: string | null;
  /** Open a ticket in the shared detail pane. */
  onSelectTicket: (id: string) => void;
}

function labelColor(labels: TicketLabel[], name: string): string | undefined {
  return labels.find((l) => l.name.toLowerCase() === name.toLowerCase())?.color || undefined;
}

function milestoneName(milestones: Milestone[], id: string | null | undefined): string | null {
  if (!id) return null;
  return milestones.find((m) => m.id === id)?.name ?? null;
}

function ticketLabel(t: Pick<Task, 'title' | 'ticketKey'>): string {
  return t.ticketKey ? `${t.ticketKey} ${t.title}` : t.title;
}

/**
 * The "Can start" column's cell — a ticket's {@link StartReadiness} read as a badge. `done`
 * shows nothing: there is no longer anything to be ready FOR. `waiting`'s tooltip names the
 * open blockers so the badge alone never leaves a reader guessing what it is waiting on.
 */
function CanStartCell({ readiness }: { readiness: StartReadiness }): JSX.Element {
  const styles = useStyles();
  if (readiness.kind === 'done') {
    return <Caption1 className={styles.muted}>—</Caption1>;
  }
  if (readiness.kind === 'ready') {
    return (
      <Badge appearance="tint" color="success">
        Ready
      </Badge>
    );
  }
  const names = readiness.open.map((o) =>
    o.task ? `${ticketLabel(o.task)} (${columnBadge(columnForTask(o.task)).label})` : o.id,
  );
  return (
    <Tooltip relationship="label" content={`Waiting on ${names.join(', ')}`}>
      <Badge appearance="tint" color="warning">
        Waiting
      </Badge>
    </Tooltip>
  );
}

/** The agent delegated to a ticket, by name — `undefined` for anything not native or
 *  not delegated, the same `delegatedAgentName` gate `TaskCard` applies before showing one. */
function agentNameOf(agentProjects: Project[], ticket: Task): string | undefined {
  return delegatedAgentName(
    ticket,
    agentProjects.find((p) => p.id === ticket.agentProjectId)?.name,
  );
}

export function BacklogTable({
  projectId,
  people,
  agentProjects,
  labels,
  milestones,
  selectedTicketId,
  onSelectTicket,
}: BacklogTableProps): JSX.Element {
  const styles = useStyles();
  const transport = useTransport();
  const [tickets, setTickets] = useState<Task[] | null>(null);
  const [links, setLinks] = useState<TicketLink[]>([]);
  const [query, setQuery] = useState('');
  const [sortKey, setSortKey] = useState<BacklogSortKey>('key');
  /** `NewTicketDialog`'s own open state, folded into the epic it should preset — `null`
   *  means closed, `{ epicTaskId: null }` is the toolbar's plain "New ticket", and a group
   *  header's "Add child" sets it to that epic's id. */
  const [newTicketDialog, setNewTicketDialog] = useState<{ epicTaskId: string | null } | null>(
    null,
  );

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

  useEffect(() => {
    let live = true;
    void transport.invoke('ticketLink:list').then((all) => {
      if (live) setLinks(all);
    });
    const off = transport.on('ticketLink:changed', setLinks);
    return () => {
      live = false;
      off();
    };
  }, [transport]);

  const rows = useMemo(
    () => (tickets ? backlogRows(tickets, query, sortKey) : []),
    [tickets, query, sortKey],
  );
  const byId = useMemo(() => new Map((tickets ?? []).map((t) => [t.id, t])), [tickets]);

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
        <Button
          size="small"
          appearance="primary"
          icon={<AddRegular />}
          onClick={() => setNewTicketDialog({ epicTaskId: null })}
        >
          New ticket
        </Button>
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
                <TableHeaderCell>Can start</TableHeaderCell>
                <TableHeaderCell>Labels</TableHeaderCell>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((group) => (
                <Fragment key={`group:${group.epicId ?? 'none'}`}>
                  <TableRow className={styles.groupRow}>
                    <TableCell colSpan={9} className={styles.groupCell}>
                      <div className={styles.groupHeader}>
                        <span>
                          {group.epicTitle} · {group.tickets.length}
                        </span>
                        {/* Only a real epic can be filed under — the "No epic" bucket has no
                            id to preset, and "adding a child" to it would just be another
                            plain "New ticket". */}
                        {group.epicId && (
                          <Button
                            size="small"
                            appearance="subtle"
                            icon={<AddRegular />}
                            onClick={() => setNewTicketDialog({ epicTaskId: group.epicId })}
                          >
                            Add child
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                  {group.tickets.map((ticket) => (
                    <TableRow
                      key={ticket.id}
                      className={mergeClasses(
                        styles.clickableRow,
                        ticket.id === selectedTicketId && styles.selectedRow,
                      )}
                      aria-selected={ticket.id === selectedTicketId}
                      onClick={() => onSelectTicket(ticket.id)}
                    >
                      <TableCell className={styles.typeCell}>
                        {issueTypeGlyph(typeIconKeyFor(ticket))}
                      </TableCell>
                      <TableCell>{ticket.ticketKey ?? '—'}</TableCell>
                      <TableCell>{ticket.title}</TableCell>
                      <TableCell>
                        {(() => {
                          const assignee = ticket.assigneeId
                            ? people.find((p) => p.id === ticket.assigneeId)
                            : undefined;
                          const agentName = agentNameOf(agentProjects, ticket);
                          return assignee || agentName ? (
                            <AssigneeDisplay assignee={assignee} agentName={agentName} size={20} />
                          ) : (
                            <Caption1 className={styles.muted}>Unassigned</Caption1>
                          );
                        })()}
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
                        <CanStartCell readiness={startReadiness(ticket, links, byId)} />
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

      <NewTicketDialog
        open={newTicketDialog !== null}
        projectId={projectId}
        tickets={tickets}
        defaultEpicTaskId={newTicketDialog?.epicTaskId ?? null}
        onClose={() => setNewTicketDialog(null)}
      />
    </div>
  );
}
