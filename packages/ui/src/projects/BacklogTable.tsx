/**
 * BacklogTable — every ticket in one native ticket project, grouped by STATUS and drawn with
 * `IssueRow` (F13.15) — the same row the mockups' Issues list uses, one `textMuted` caption
 * per group instead of a Fluent `Table`'s header/group rows.
 *
 * A row click opens the ticket in `Projects.tsx`'s own shared detail pane (F12.8) — this
 * component's job stays what it always was: loading the project's tickets, the search box,
 * the sort toggle, and rendering `backlogStatus`'s grouped rows with `IssueRow`.
 *
 * Keyed by `projectId` at the call site (`Projects.tsx`) rather than reacting to it changing
 * in place: switching the selected project is rare enough that a remount — a fresh seed load,
 * a fresh subscription — is simpler than reconciling this component's state to a new project
 * mid-life, and `useInitialLoad` already gives a clean loading skeleton for it.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Button,
  Input,
  ToggleButton,
  Body1,
  Caption1,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { AddRegular, SearchRegular } from '@fluentui/react-icons';
import type { Person, Project, Task } from '@tm/shared/model';
import { delegatedAgentName } from '@tm/shared/tickets';
import { IssueRow } from '../issues/IssueRow';
import type { IssueRowContext } from '../issues/issueRowParts';
import { PaneLoading } from '../PaneLoading';
import { useTransport } from '../transport';
import { useInitialLoad } from '../useInitialLoad';
import { type BacklogStatusGroup, backlogStatusGroups } from './backlogStatus';
import { type BacklogSortKey } from './backlogView';
import { NewTicketDialog } from './NewTicketDialog';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: '10px', minHeight: 0 },
  toolbar: { display: 'flex', alignItems: 'center', gap: '8px' },
  search: { flex: 1, maxWidth: '320px' },
  scroll: {
    overflowY: 'auto',
    minHeight: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: '12px',
  },
  group: { display: 'flex', flexDirection: 'column', gap: '2px' },
  groupCaption: {
    padding: '0 10px',
    fontSize: tokens.fontSizeBase200,
    fontWeight: tokens.fontWeightSemibold,
    color: `var(--tm-text-muted, ${tokens.colorNeutralForeground3})`,
  },
  empty: { color: tokens.colorNeutralForeground3, padding: '8px 0' },
});

export interface BacklogTableProps {
  projectId: string;
  /** App-wide roster, for the assignee column. */
  people: Person[];
  /** The repos a ticket can be delegated to — resolves `agentProjectId` to a name for the
   *  assignee column's `<human> / <agent>` display. */
  agentProjects: Project[];
  /** The ticket open in `Projects.tsx`'s own shared detail pane — highlights its row. */
  selectedTicketId?: string | null;
  /** Open a ticket in the shared detail pane. */
  onSelectTicket: (id: string) => void;
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
  selectedTicketId,
  onSelectTicket,
}: BacklogTableProps): JSX.Element {
  const styles = useStyles();
  const transport = useTransport();
  const [tickets, setTickets] = useState<Task[] | null>(null);
  const [liveRunTaskIds, setLiveRunTaskIds] = useState<ReadonlySet<string>>(new Set());
  const [query, setQuery] = useState('');
  const [sortKey, setSortKey] = useState<BacklogSortKey>('key');
  /** `NewTicketDialog`'s own open state — `null` means closed, anything else is the toolbar's
   *  plain "New ticket" (there is no per-group "Add child" once rows are grouped by status
   *  rather than epic). */
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

  // `scheduler:activeRuns`, for `IssueRow`'s "Step n of m" pill — a task's own status
  // changing is exactly what moves it into or out of a live run, so `task:changed` reloads
  // this too. See `TaskDetailHostView.tsx`.
  useEffect(() => {
    let live = true;
    const reload = (): void => {
      void transport
        .invoke('scheduler:activeRuns')
        .then((runs) => live && setLiveRunTaskIds(new Set(runs.map((r) => r.taskId))));
    };
    reload();
    const off = transport.on('task:changed', reload);
    return () => {
      live = false;
      off();
    };
  }, [transport]);

  const groups = useMemo(
    () => (tickets ? backlogStatusGroups(tickets, query, sortKey) : []),
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
          {groups.map((group: BacklogStatusGroup) => (
            <div key={group.column} className={styles.group}>
              <Caption1 className={styles.groupCaption}>{group.label}</Caption1>
              {group.tickets.map((ticket) => {
                const assignee = ticket.assigneeId
                  ? people.find((p) => p.id === ticket.assigneeId)
                  : undefined;
                const ctx: IssueRowContext = {
                  now: Date.now(),
                  assignee,
                  agentName: agentNameOf(agentProjects, ticket),
                  liveRunTaskIds,
                };
                return (
                  <IssueRow
                    key={ticket.id}
                    task={ticket}
                    ctx={ctx}
                    selected={ticket.id === selectedTicketId}
                    onSelect={onSelectTicket}
                    onOpen={onSelectTicket}
                  />
                );
              })}
            </div>
          ))}
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
