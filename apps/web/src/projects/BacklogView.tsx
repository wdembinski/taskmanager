/**
 * A project's backlog: every ticket, filterable by status/label/epic (JIRA's own three),
 * one line each (`TicketRow`), click through to the full ticket page
 * (`/projects/:projectId/tickets/:ticketId`, `TicketDetailRoute`).
 *
 * All three filters degrade to "show everything" the moment their own option list is
 * empty — a project with no labels yet gets no label dropdown, not an empty one that
 * matches nothing.
 */
import { useMemo, useState } from 'react';
import {
  Body1,
  Button,
  Caption1,
  Dropdown,
  Option,
  Title3,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { AddRegular } from '@fluentui/react-icons';
import type { Project, Task } from '@tm/shared/model';
import { MANUAL_STATUS_OPTIONS } from '@tm/ui/taskStatus';
import {
  EMPTY_BACKLOG_FILTERS,
  NO_EPIC,
  backlogEpics,
  backlogLabels,
  filterBacklogTasks,
  selectBacklogTasks,
  type BacklogFilters,
} from './backlogSelectors';
import type { CloudBoardState } from '../board/cloudBoardStore';
import type { ProjectsApiDeps } from './projectsApi';
import { TicketFormDialog } from './TicketFormDialog';
import { TicketRow } from './TicketRow';

const useStyles = makeStyles({
  root: {
    display: 'flex',
    flexDirection: 'column',
    gap: '12px',
    flex: 1,
    minHeight: 0,
    padding: '12px 16px',
  },
  header: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px' },
  hint: { color: tokens.colorNeutralForeground3 },
  filters: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
  filterPicker: { minWidth: '160px' },
  list: { display: 'flex', flexDirection: 'column', overflowY: 'auto', flex: 1, minHeight: 0 },
  empty: { padding: '8px 4px' },
});

const NO_EPIC_LABEL = 'No epic';

export interface BacklogViewProps {
  state: CloudBoardState;
  project: Project;
  apiDeps: ProjectsApiDeps;
  onTaskSaved: (task: Task) => void;
  onOpenTicket: (taskId: string) => void;
}

export function BacklogView({
  state,
  project,
  apiDeps,
  onTaskSaved,
  onOpenTicket,
}: BacklogViewProps): JSX.Element {
  const styles = useStyles();
  const [filters, setFilters] = useState<BacklogFilters>(EMPTY_BACKLOG_FILTERS);
  const [creating, setCreating] = useState(false);

  const tasks = useMemo(() => selectBacklogTasks(state, project.id), [state, project.id]);
  const epics = useMemo(() => backlogEpics(tasks), [tasks]);
  const labels = useMemo(() => backlogLabels(tasks), [tasks]);
  const epicNameById = useMemo(() => new Map(epics.map((e) => [e.id, e.title])), [epics]);
  const rows = useMemo(() => filterBacklogTasks(tasks, filters), [tasks, filters]);

  return (
    <div className={styles.root}>
      <div className={styles.header}>
        <Title3>Backlog</Title3>
        {project.kind === 'ticket' && (
          <Button appearance="primary" icon={<AddRegular />} onClick={() => setCreating(true)}>
            New ticket…
          </Button>
        )}
      </div>

      <div className={styles.filters}>
        <Dropdown
          className={styles.filterPicker}
          placeholder="Status"
          multiselect
          selectedOptions={[...filters.statuses]}
          value={
            filters.statuses.size === 0
              ? 'Any status'
              : MANUAL_STATUS_OPTIONS.filter((o) => filters.statuses.has(o.value))
                  .map((o) => o.label)
                  .join(', ')
          }
          onOptionSelect={(_e, d) =>
            setFilters((f) => ({ ...f, statuses: new Set(d.selectedOptions) }))
          }
        >
          {MANUAL_STATUS_OPTIONS.map((o) => (
            <Option key={o.value} value={o.value}>
              {o.label}
            </Option>
          ))}
        </Dropdown>

        {labels.length > 0 && (
          <Dropdown
            className={styles.filterPicker}
            placeholder="Label"
            value={filters.label ?? 'Any label'}
            selectedOptions={filters.label ? [filters.label] : []}
            onOptionSelect={(_e, d) => setFilters((f) => ({ ...f, label: d.optionValue ?? null }))}
          >
            <Option value="">Any label</Option>
            {labels.map((label) => (
              <Option key={label} value={label}>
                {label}
              </Option>
            ))}
          </Dropdown>
        )}

        {epics.length > 0 && (
          <Dropdown
            className={styles.filterPicker}
            placeholder="Epic"
            value={
              filters.epicId === NO_EPIC
                ? NO_EPIC_LABEL
                : (epicNameById.get(filters.epicId ?? '') ?? 'Any epic')
            }
            selectedOptions={filters.epicId ? [filters.epicId] : []}
            onOptionSelect={(_e, d) => setFilters((f) => ({ ...f, epicId: d.optionValue || null }))}
          >
            <Option value="">Any epic</Option>
            <Option value={NO_EPIC}>{NO_EPIC_LABEL}</Option>
            {epics.map((epic) => (
              <Option key={epic.id} value={epic.id}>
                {epic.title}
              </Option>
            ))}
          </Dropdown>
        )}
      </div>

      {rows.length === 0 ? (
        <Caption1 className={styles.empty}>
          {tasks.length === 0 ? 'Nothing in this backlog yet.' : 'No tickets match these filters.'}
        </Caption1>
      ) : (
        <div className={styles.list}>
          {rows.map((task) => (
            <TicketRow
              key={task.id}
              task={task}
              epicName={task.epicTaskId ? epicNameById.get(task.epicTaskId) : undefined}
              onOpen={onOpenTicket}
            />
          ))}
        </div>
      )}

      {tasks.length === 0 && project.kind !== 'ticket' && (
        <Body1 className={styles.hint}>
          Native tickets are created on ticket projects — this one holds agent or plan cards
          instead, so there is nothing to file here yet.
        </Body1>
      )}

      {project.kind === 'ticket' && (
        <TicketFormDialog
          open={creating}
          projectId={project.id}
          epics={epics}
          apiDeps={apiDeps}
          onClose={() => setCreating(false)}
          onCreated={onTaskSaved}
        />
      )}
    </div>
  );
}
