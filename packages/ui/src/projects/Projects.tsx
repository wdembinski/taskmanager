/**
 * Projects — the Tickets tab: pick a ticket project (`ProjectPicker`), browse the selected
 * one's backlog/timeline/graph, and open a ticket in the SAME shared detail pane (`TaskDetail`
 * via `TaskDetailHost`) every other board shows it in (F12.8) — there is no drawer of its own
 * any more. Managing projects themselves — adding, renaming, choosing what a project owns —
 * lives on the Projects tab's own `ProjectAdmin` pane, not here; this screen only reads the
 * list, it never writes one.
 *
 * Shared rather than desktop-only, unlike the desktop's own repo-picker `Projects` admin
 * screen: a ticket project is nothing but rows in the store (no folder, no native picker),
 * reachable over the same relayed channels either host can call — see `ProjectAdmin`'s own
 * header and `shell-parity.test.ts`'s "agent projects" block, which is about *repo* projects
 * and does not apply here.
 *
 * The seed here loads the ticket projects themselves plus settings (for the pane's own
 * display/feature flags); the app-wide people/milestone/label/link registries a ticket can
 * point at come from `useTicketRegistries`, scoped to whichever project is selected, and are
 * handed straight to `TaskDetailHost` the same way both boards already do (F12.6).
 * `useProjectTickets` loads the selected project's own tickets — a project switch should not
 * re-fetch the roster, and a roster edit should not re-fetch every project's tickets.
 *
 * `readOnlyNotice` and `hostUnreachable` forward straight through to `TaskDetailHost` — the
 * web app passes both (F12.10), the desktop neither, the same convention `TaskDetail.tsx`'s
 * own header documents for the props themselves.
 *
 * Whether the opened ticket is a `peek` beside the list or a `full`-screen page (F13.13) is
 * this screen's own `issueViewReduce` state — see `issues/issueView.ts` for the reducer and
 * `issues/IssueViewPanes.tsx` for the two surfaces it drives.
 */
import { useCallback, useEffect, useMemo, useReducer, useState, type KeyboardEvent } from 'react';
import {
  Button,
  MessageBar,
  MessageBarActions,
  MessageBarBody,
  ToggleButton,
  makeStyles,
} from '@fluentui/react-components';
import {
  DismissRegular,
  PanelRightContractRegular,
  PanelRightExpandRegular,
} from '@fluentui/react-icons';
import { agentProjectsOf } from '@tm/shared/agentProjects';
import '@xyflow/react/dist/style.css';
import { ownsTickets, type Project } from '@tm/shared/model';
import { DEFAULT_BOARD_DISPLAY, type AppSettings } from '@tm/shared/settings';
import { archiveIndexOf } from '@tm/shared/trackerArchive';
import { PaneLoading } from '../PaneLoading';
import { TaskDetailHost } from '../TaskDetailHostView';
import { useTransport } from '../transport';
import { useInitialLoad } from '../useInitialLoad';
import { IssueFullPage, IssuePeek } from '../issues/IssueViewPanes';
import {
  INITIAL_ISSUE_VIEW,
  isKeyTargetEditable,
  issueBreadcrumb,
  issueViewReduce,
  type KeyTargetLike,
} from '../issues/issueView';
import { BacklogTable } from './BacklogTable';
import { GraphPane } from './GraphPane';
import { EMPTY_HISTORY, backHistory, pushHistory, type PanelHistory } from './panelHistory';
import { ArchivedPane } from './ArchivedPane';
import { ProjectPicker } from './ProjectPicker';
import { TimelinePane } from './TimelinePane';
import { useProjectTickets } from './useProjectTickets';
import { useTicketRegistries } from './useTicketRegistries';

const useStyles = makeStyles({
  root: { display: 'flex', gap: '20px', minHeight: 0, height: '100%' },
  admin: { flex: '0 0 320px', minWidth: 0, overflowY: 'auto' },
  backlog: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: '10px' },
  viewSwitch: { display: 'flex', alignItems: 'center', gap: '4px' },
  viewSwitchSpacer: { flex: 1 },
});

/** The Projects screen's own views of one project's tickets — `'archived'` (F14.8) is the one
 *  member with no `ProjectPicker` column alongside it (see the root `return` below) and no
 *  tickets of its own feeding it: it reads `archive:list()`/`board:tasks('all')` itself. */
export type ProjectView = 'backlog' | 'timeline' | 'graph' | 'archived';

export interface ProjectsProps {
  /** Jump to a ticket's card on the board (F12.9) — forwarded straight through to the
   *  shared pane's own "Show on board" button. Left `undefined` when this screen is hosted
   *  with no board of its own to jump to (the host decides, the same way `TaskDetail` does). */
  onShowOnBoard?: (taskId: string) => void;
  /** Hands the selected ticket project to this screen rather than letting it default to the
   *  first one — the desktop App and the web App both lift it so their sidebar switcher
   *  (`useTrackerProject`) and this workspace always agree on which project is open. Passing
   *  `undefined` (the default) keeps this screen's own first-project selection instead; a
   *  controlling host must pass `onSelectProject` alongside it. */
  selectedProjectId?: string | null;
  /** Reports a `ProjectPicker` pick back up to the controlling host — only read while
   *  `selectedProjectId` is passed. */
  onSelectProject?: (id: string) => void;
  /** Hands the active Backlog/Timeline/Graph/Archived view to this screen — same optional-
   *  controlled shape as `selectedProjectId`/`onSelectProject`, so the sidebar's own "Archived"
   *  row (F14.8) can land a host straight on it. Passing `undefined` (the default) keeps this
   *  screen's own view state instead; a controlling host must pass `onViewChange` alongside it. */
  view?: ProjectView;
  onViewChange?: (view: ProjectView) => void;
  /** Forwarded straight through to `TaskDetailHost` — see `TaskDetail.tsx`'s own doc for
   *  this prop. Unset on the desktop. */
  readOnlyNotice?: string;
  /** Forwarded straight through to `TaskDetailHost` — see `TaskDetail.tsx`'s own doc for
   *  this prop. Unset on the desktop. */
  hostUnreachable?: string;
}

export function Projects({
  onShowOnBoard,
  selectedProjectId: controlledProjectId,
  onSelectProject,
  view: controlledView,
  onViewChange,
  readOnlyNotice,
  hostUnreachable,
}: ProjectsProps = {}): JSX.Element {
  const styles = useStyles();
  const transport = useTransport();
  const [projects, setProjects] = useState<Project[] | null>(null);
  /** The repos a ticket can be delegated to — for resolving `agentProjectId` to a name
   *  wherever a ticket surface shows its assignee, alongside the human `people` roster. */
  const [agentProjects, setAgentProjects] = useState<Project[]>([]);
  /** This screen's own first-project default (:126) — ignored once a host controls the
   *  selection via `selectedProjectId`. */
  const [internalProjectId, setInternalProjectId] = useState<string | null>(null);
  const controlled = controlledProjectId !== undefined;
  const selectedProjectId = controlled ? controlledProjectId : internalProjectId;
  const setSelectedProjectId = useCallback(
    (id: string) => {
      if (controlled) {
        onSelectProject?.(id);
      } else {
        setInternalProjectId(id);
      }
    },
    [controlled, onSelectProject],
  );
  /** This screen's own view default (:118) — ignored once a host controls it via `view`,
   *  the same `controlled`/`setSelectedProjectId` shape just above. */
  const [internalView, setInternalView] = useState<ProjectView>('backlog');
  const viewControlled = controlledView !== undefined;
  const view = viewControlled ? controlledView : internalView;
  const setView = useCallback(
    (next: ProjectView) => {
      if (viewControlled) {
        onViewChange?.(next);
      } else {
        setInternalView(next);
      }
    },
    [viewControlled, onViewChange],
  );
  const [settings, setSettings] = useState<AppSettings | null>(null);
  /** Whether the selected ticket is closed, a peek beside the list, or a full-screen page —
   *  cleared on every project switch, the same way the board clears its own selection when
   *  the scope changes. */
  const [viewState, dispatch] = useReducer(issueViewReduce, INITIAL_ISSUE_VIEW);
  /** The pane's own "Back" trail (F12.9) — ids a followed link left behind, cleared
   *  wherever the selection itself starts over: a fresh list/timeline/graph pick, or a
   *  project switch. */
  const [history, setHistory] = useState<PanelHistory>(EMPTY_HISTORY);
  /** The Backlog/Timeline/Graph "Include archived" toggle (F14.6) — off by default, and reset
   *  on a project switch the same way `viewState` is: a project picked up fresh has nothing
   *  archived-but-shown to carry over from the last one. */
  const [includeArchived, setIncludeArchived] = useState(false);

  const seed = useCallback(async () => {
    const [allProjects, allSettings] = await Promise.all([
      transport.invoke('project:list'),
      transport.invoke('settings:get'),
    ]);
    const projectList = allProjects.map((p) => p.project);
    setProjects(projectList.filter(ownsTickets));
    setAgentProjects(agentProjectsOf(projectList));
    setSettings(allSettings);
  }, [transport]);
  const initial = useInitialLoad(seed);
  const registries = useTicketRegistries(selectedProjectId);
  const ticketsLoad = useProjectTickets(selectedProjectId);

  useEffect(() => {
    return transport.on('settings:changed', setSettings);
  }, [transport]);

  // Keep a project selected once there is one to select — the backlog otherwise has nothing
  // to show and the picker's list has nothing highlighted. Skipped while a host controls the
  // selection: it owns the default (and the empty-state) instead.
  useEffect(() => {
    if (controlled) return;
    if (!projects || projects.length === 0) return;
    if (selectedProjectId && projects.some((p) => p.id === selectedProjectId)) return;
    setSelectedProjectId(projects[0].id);
  }, [controlled, projects, selectedProjectId]);

  useEffect(() => {
    dispatch({ type: 'reset' });
    setHistory(EMPTY_HISTORY);
    setIncludeArchived(false);
  }, [selectedProjectId]);

  // Keeps the reducer's own `seen`/`label`/deletion-notice bookkeeping current — see
  // `issueView.ts`'s `tickets` action. Skipped while the seed is still loading (`null`), so
  // a project switch never reads as "every ticket just got deleted".
  useEffect(() => {
    if (ticketsLoad.tickets === null) return;
    dispatch({ type: 'tickets', tickets: ticketsLoad.tickets });
  }, [ticketsLoad.tickets]);

  const selectedProject = useMemo(
    () => projects?.find((p) => p.id === selectedProjectId) ?? null,
    [projects, selectedProjectId],
  );

  const selectedTask = useMemo(
    () =>
      viewState.selectedId
        ? (ticketsLoad.tickets?.find((t) => t.id === viewState.selectedId) ?? null)
        : null,
    [viewState.selectedId, ticketsLoad.tickets],
  );

  const ticketsById = useMemo(
    () => new Map((ticketsLoad.tickets ?? []).map((t) => [t.id, t] as const)),
    [ticketsLoad.tickets],
  );

  /** The Backlog's own archive lookup (F14.6) — milestones from the registries, epics from
   *  this project's own tickets (every ticket is offered, not only the epics; `archiveIndexOf`
   *  only ever looks an id up by exact match), and projects from the admin list. */
  const archiveIndex = useMemo(
    () => archiveIndexOf(registries.milestones, ticketsLoad.tickets ?? [], projects ?? []),
    [registries.milestones, ticketsLoad.tickets, projects],
  );

  const breadcrumb = useMemo(() => {
    if (selectedTask) {
      return issueBreadcrumb(selectedTask, selectedProject, registries.milestones, ticketsById);
    }
    return selectedProject ? [selectedProject.name] : [];
  }, [selectedTask, selectedProject, registries.milestones, ticketsById]);

  /** The ticket's `ticketKey ?? title`, for the reducer's `label` — falls back to the id
   *  itself for a cross-project link this project's own list has never carried. */
  const ticketLabel = useCallback(
    (id: string): string => {
      const ticket = ticketsLoad.tickets?.find((t) => t.id === id);
      return ticket ? (ticket.ticketKey ?? ticket.title) : id;
    },
    [ticketsLoad.tickets],
  );

  /** A row click — opens (or keeps) the ticket as a peek. Resets the Back history: a
   *  list/timeline/graph pick starts over somewhere new, it never follows on from wherever
   *  the pane happened to be. */
  const selectTicket = useCallback(
    (id: string) => {
      setHistory(EMPTY_HISTORY);
      dispatch({ type: 'select', id, label: ticketLabel(id) });
    },
    [ticketLabel],
  );

  /** A row's Enter/double-click — opens the ticket straight to full screen, resetting the
   *  Back history the same way `selectTicket` does. */
  const openTicket = useCallback(
    (id: string) => {
      setHistory(EMPTY_HISTORY);
      dispatch({ type: 'open', id, label: ticketLabel(id) });
    },
    [ticketLabel],
  );

  /** Follow a link INSIDE the pane (`TaskDetailHost`'s `onOpenTask`) — leaves the ticket
   *  being left behind on the Back history instead of resetting it, so a chain of links can
   *  be unwound hop by hop. A `select`, so the peek/full layout stays as it is. */
  const followLink = useCallback(
    (id: string) => {
      setHistory((h) => pushHistory(h, viewState.selectedId));
      dispatch({ type: 'select', id, label: ticketLabel(id) });
    },
    [viewState.selectedId, ticketLabel],
  );

  /** Pop the Back history, skipping any id that no longer exists — the same `board:tasks`
   *  read `TaskDetailHost` itself makes, so a deleted ticket is never offered twice. When
   *  every remaining entry is gone the pane stays where it is; only the button goes away. */
  const goBack = useCallback(async () => {
    const tasks = await transport.invoke('board:tasks', 'all');
    const ids = new Set(tasks.map((t) => t.id));
    const result = backHistory(history, (id) => ids.has(id));
    setHistory(result.history);
    if (result.taskId) {
      dispatch({ type: 'select', id: result.taskId, label: ticketLabel(result.taskId) });
    }
  }, [transport, history, ticketLabel]);

  const onKeyDown = useCallback((e: KeyboardEvent<HTMLDivElement>) => {
    if (e.defaultPrevented) return;
    if (isKeyTargetEditable(e.target as KeyTargetLike)) return;
    if (e.key === ' ') {
      e.preventDefault();
      dispatch({ type: 'space' });
    } else if (e.key === 'Escape') {
      dispatch({ type: 'escape' });
    }
  }, []);

  if (projects === null || !registries.loaded) {
    return (
      <PaneLoading
        label="Loading projects…"
        error={initial.error ?? registries.error}
        onRetry={() => {
          initial.retry();
          registries.retry();
        }}
        shape="rows"
      />
    );
  }

  const display = settings?.board ?? DEFAULT_BOARD_DISPLAY;

  const detailPane = (
    <TaskDetailHost
      taskId={viewState.selectedId}
      agentProjects={agentProjects}
      people={registries.people}
      milestones={registries.milestones}
      labels={registries.labels}
      ticketLinks={registries.links}
      ticketProjects={projects}
      statusKeywords={settings?.statusKeywords}
      priorityDisplay={display.priorityDisplay}
      afterMergePipeline={settings?.features.afterMergePipeline}
      mrRebaseButton={settings?.features.mrRebaseButton}
      mrMergeButton={settings?.features.mrMergeButton}
      quietAgentProgress={settings?.features.quietAgentProgress}
      onOpenTask={followLink}
      onBack={history.stack.length > 0 ? goBack : undefined}
      onShowOnBoard={onShowOnBoard}
      ticketFold={{ key: 'tm.projects.ticketOpen', defaultOpen: true }}
      readOnlyNotice={readOnlyNotice}
      hostUnreachable={hostUnreachable}
    />
  );

  if (viewState.layout === 'full') {
    return (
      <div className={styles.root} onKeyDown={onKeyDown}>
        <IssueFullPage breadcrumb={breadcrumb} onBack={() => dispatch({ type: 'escape' })}>
          {detailPane}
        </IssueFullPage>
      </div>
    );
  }

  return (
    <div className={styles.root} onKeyDown={onKeyDown}>
      {/* No picker alongside the Archived view (F14.8) — it is not scoped to picking a
          project to browse the way Backlog/Timeline/Graph are; its own Projects tab lists
          every archived ticket project regardless of which one is open here. */}
      {view !== 'archived' && (
        <div className={styles.admin}>
          <ProjectPicker
            projects={projects}
            selectedProjectId={selectedProjectId}
            onSelect={setSelectedProjectId}
          />
        </div>
      )}
      <div className={styles.backlog}>
        {viewState.notice && (
          <MessageBar intent="info">
            <MessageBarBody>{viewState.notice}</MessageBarBody>
            <MessageBarActions
              containerAction={
                <Button
                  appearance="transparent"
                  icon={<DismissRegular />}
                  aria-label="Dismiss"
                  onClick={() => dispatch({ type: 'dismissNotice' })}
                />
              }
            />
          </MessageBar>
        )}
        {selectedProject && (
          <>
            <div className={styles.viewSwitch}>
              <ToggleButton
                size="small"
                appearance="subtle"
                checked={view === 'backlog'}
                onClick={() => setView('backlog')}
              >
                Backlog
              </ToggleButton>
              <ToggleButton
                size="small"
                appearance="subtle"
                checked={view === 'timeline'}
                onClick={() => setView('timeline')}
              >
                Timeline
              </ToggleButton>
              <ToggleButton
                size="small"
                appearance="subtle"
                checked={view === 'graph'}
                onClick={() => setView('graph')}
              >
                Graph
              </ToggleButton>
              <div className={styles.viewSwitchSpacer} />
              {/* The peek toggle — dispatches `space`, the same key this button's title
                  names. Disabled with no selection: there is nothing yet for a peek to show. */}
              <Button
                size="small"
                appearance="subtle"
                icon={
                  viewState.layout === 'peek' ? (
                    <PanelRightContractRegular />
                  ) : (
                    <PanelRightExpandRegular />
                  )
                }
                title={
                  viewState.layout === 'peek' ? 'Close the ticket panel' : 'Open the ticket panel'
                }
                aria-label={
                  viewState.layout === 'peek' ? 'Close the ticket panel' : 'Open the ticket panel'
                }
                aria-pressed={viewState.layout === 'peek'}
                disabled={!viewState.selectedId}
                onClick={() => dispatch({ type: 'space' })}
              />
            </div>
            {/* Keyed on the project: switching the selection is rare enough that a clean
                remount — a fresh search/sort state — beats reconciling any pane's state onto
                a different project mid-life. The three views are a SWITCH, never mounted
                together, so there is nothing for their independent ticket loads to disagree
                about. */}
            {view === 'backlog' && (
              <BacklogTable
                key={selectedProject.id}
                projectId={selectedProject.id}
                tickets={ticketsLoad.tickets}
                loadError={ticketsLoad.error}
                loadRetry={ticketsLoad.retry}
                people={registries.people}
                agentProjects={agentProjects}
                selectedTicketId={viewState.selectedId}
                onSelectTicket={selectTicket}
                onOpenTicket={openTicket}
                archiveIndex={archiveIndex}
                includeArchived={includeArchived}
                onIncludeArchivedChange={setIncludeArchived}
              />
            )}
            {view === 'timeline' && (
              <TimelinePane
                key={selectedProject.id}
                projectId={selectedProject.id}
                milestones={registries.milestones}
                selectedTicketId={viewState.selectedId}
                onSelectTicket={selectTicket}
                projects={projects}
                includeArchived={includeArchived}
                onIncludeArchivedChange={setIncludeArchived}
              />
            )}
            {view === 'graph' && (
              <GraphPane
                key={selectedProject.id}
                projectId={selectedProject.id}
                selectedTicketId={viewState.selectedId}
                onSelectTicket={selectTicket}
                milestones={registries.milestones}
                projects={projects}
                includeArchived={includeArchived}
                onIncludeArchivedChange={setIncludeArchived}
              />
            )}
            {view === 'archived' && (
              <ArchivedPane
                key={selectedProject.id}
                projectId={selectedProject.id}
                selectedTicketId={viewState.selectedId}
                onSelectTicket={selectTicket}
                onProjectsChanged={initial.retry}
              />
            )}
          </>
        )}
      </div>

      {viewState.layout === 'peek' && viewState.selectedId && (
        <IssuePeek
          onExpand={() => dispatch({ type: 'expand' })}
          onClose={() => dispatch({ type: 'close' })}
        >
          {detailPane}
        </IssuePeek>
      )}
    </div>
  );
}
