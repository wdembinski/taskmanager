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
 * The seed here loads the ticket projects themselves plus settings (for `showTaskDetail` and
 * the pane's own display/feature flags); the app-wide people/milestone/label/link registries a
 * ticket can point at come from `useTicketRegistries`, scoped to whichever project is selected,
 * and are handed straight to `TaskDetailHost` the same way both boards already do (F12.6).
 * `board:tasks` for the selected project's own tickets is each view's own to fetch — a project
 * switch should not re-fetch the roster, and a roster edit should not re-fetch every project's
 * tickets.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button, ToggleButton, makeStyles } from '@fluentui/react-components';
import { PanelRightContractRegular, PanelRightExpandRegular } from '@fluentui/react-icons';
import { agentProjectsOf } from '@tm/shared/agentProjects';
import '@xyflow/react/dist/style.css';
import { ownsTickets, type Project } from '@tm/shared/model';
import { DEFAULT_BOARD_DISPLAY, type AppSettings } from '@tm/shared/settings';
import { PaneLoading } from '../PaneLoading';
import { useBoardLayoutStyles } from '../board/boardLayout';
import { TaskDetailHost } from '../TaskDetailHostView';
import { useTransport } from '../transport';
import { useInitialLoad } from '../useInitialLoad';
import { BacklogTable } from './BacklogTable';
import { GraphPane } from './GraphPane';
import { ProjectPicker } from './ProjectPicker';
import { TimelinePane } from './TimelinePane';
import { useTicketRegistries } from './useTicketRegistries';

const useStyles = makeStyles({
  root: { display: 'flex', gap: '20px', minHeight: 0, height: '100%' },
  admin: { flex: '0 0 320px', minWidth: 0, overflowY: 'auto' },
  backlog: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: '10px' },
  viewSwitch: { display: 'flex', alignItems: 'center', gap: '4px' },
  viewSwitchSpacer: { flex: 1 },
});

/** The Projects screen's own views of one project's tickets. */
type ProjectView = 'backlog' | 'timeline' | 'graph';

export function Projects(): JSX.Element {
  const styles = useStyles();
  const layout = useBoardLayoutStyles();
  const transport = useTransport();
  const [projects, setProjects] = useState<Project[] | null>(null);
  /** The repos a ticket can be delegated to — for resolving `agentProjectId` to a name
   *  wherever a ticket surface shows its assignee, alongside the human `people` roster. */
  const [agentProjects, setAgentProjects] = useState<Project[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [view, setView] = useState<ProjectView>('backlog');
  const [settings, setSettings] = useState<AppSettings | null>(null);
  /** The ticket open in the shared detail pane — cleared on every project switch, the same
   *  way the board clears its own selection when the scope changes. */
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);

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

  useEffect(() => {
    return transport.on('settings:changed', setSettings);
  }, [transport]);

  // Keep a project selected once there is one to select — the backlog otherwise has nothing
  // to show and the picker's list has nothing highlighted.
  useEffect(() => {
    if (!projects || projects.length === 0) return;
    if (selectedProjectId && projects.some((p) => p.id === selectedProjectId)) return;
    setSelectedProjectId(projects[0].id);
  }, [projects, selectedProjectId]);

  useEffect(() => {
    setSelectedTaskId(null);
  }, [selectedProjectId]);

  const selectedProject = useMemo(
    () => projects?.find((p) => p.id === selectedProjectId) ?? null,
    [projects, selectedProjectId],
  );

  const showDetail = settings?.showTaskDetail ?? true;
  const setShowDetail = useCallback(
    (value: boolean) => {
      setSettings((prev) => {
        if (!prev) return prev;
        const next = { ...prev, showTaskDetail: value };
        void transport.invoke('settings:save', next);
        return next;
      });
    },
    [transport],
  );

  /** Open a ticket in the shared detail pane — and reveal the pane itself if it was folded
   *  away, the same way clicking a card would be pointless with no pane to show it in. */
  const selectTicket = useCallback(
    (id: string) => {
      setSelectedTaskId(id);
      if (!showDetail) setShowDetail(true);
    },
    [showDetail, setShowDetail],
  );

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

  return (
    <div className={styles.root}>
      <div className={styles.admin}>
        <ProjectPicker
          projects={projects}
          selectedProjectId={selectedProjectId}
          onSelect={setSelectedProjectId}
        />
      </div>
      <div className={styles.backlog}>
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
              {/* Fold the detail pane away — the board's own toggle (`MyTasks.tsx`), redrawn
                  here so the two screens offer the same control for the same thing. */}
              <Button
                size="small"
                appearance="subtle"
                icon={showDetail ? <PanelRightContractRegular /> : <PanelRightExpandRegular />}
                title={showDetail ? 'Hide the detail pane' : 'Show the detail pane'}
                aria-label={showDetail ? 'Hide the detail pane' : 'Show the detail pane'}
                aria-pressed={showDetail}
                onClick={() => setShowDetail(!showDetail)}
              />
            </div>
            {/* Keyed on the project: switching the selection is rare enough that a clean
                remount — a fresh seed load, a fresh subscription — beats reconciling any
                pane's state onto a different project mid-life. The three views are a SWITCH,
                never mounted together, so there is nothing for their independent ticket
                loads to disagree about. */}
            {view === 'backlog' && (
              <BacklogTable
                key={selectedProject.id}
                projectId={selectedProject.id}
                people={registries.people}
                agentProjects={agentProjects}
                selectedTicketId={selectedTaskId}
                onSelectTicket={selectTicket}
              />
            )}
            {view === 'timeline' && (
              <TimelinePane
                key={selectedProject.id}
                projectId={selectedProject.id}
                milestones={registries.milestones}
                selectedTicketId={selectedTaskId}
                onSelectTicket={selectTicket}
              />
            )}
            {view === 'graph' && (
              <GraphPane
                key={selectedProject.id}
                projectId={selectedProject.id}
                selectedTicketId={selectedTaskId}
                onSelectTicket={selectTicket}
              />
            )}
          </>
        )}
      </div>

      {/* Unmounted rather than hidden when folded away — `TaskDetail`'s own reasoning
          (`MyTasks.tsx`): remounting re-runs its activity load and re-marks the ticket read,
          which is what you want the moment the pane comes back anyway. */}
      {showDetail && (
        <div className={layout.right}>
          <TaskDetailHost
            taskId={selectedTaskId}
            agentProjects={agentProjects}
            people={registries.people}
            milestones={registries.milestones}
            labels={registries.labels}
            ticketLinks={registries.links}
            statusKeywords={settings?.statusKeywords}
            priorityDisplay={display.priorityDisplay}
            afterMergePipeline={settings?.features.afterMergePipeline}
            mrRebaseButton={settings?.features.mrRebaseButton}
            mrMergeButton={settings?.features.mrMergeButton}
            quietAgentProgress={settings?.features.quietAgentProgress}
            onOpenTask={selectTicket}
            ticketFold={{ key: 'tm.projects.ticketOpen', defaultOpen: true }}
          />
        </div>
      )}
    </div>
  );
}
