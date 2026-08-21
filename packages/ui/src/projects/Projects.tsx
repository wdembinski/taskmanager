/**
 * Projects — the native ticket projects screen (Phase 24): manage the projects themselves
 * (`ProjectAdmin`) and browse the selected one's backlog (`BacklogTable`).
 *
 * Shared rather than desktop-only, unlike the desktop's own repo-picker `Projects` admin
 * screen: a ticket project is nothing but rows in the store, reachable over the same relayed
 * channels either host can call — see `shell-parity.test.ts`'s "agent projects" block, which
 * is about *repo* projects and does not apply here. Whether the drawer this screen opens
 * offers anything about a folder is the `repo` prop's call, threaded straight through to
 * `ProjectAdmin` — see that file's own header for why.
 *
 * The seed loads the four collections every part of this screen reads: the ticket projects
 * themselves, and the app-wide people/milestone/label registries a ticket can point at.
 * `board:tasks` for the selected project's own tickets is `BacklogTable`'s to fetch — a
 * project switch should not re-fetch the roster, and a roster edit should not re-fetch every
 * project's tickets.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ToggleButton, makeStyles } from '@fluentui/react-components';
import {
  ownsTickets,
  type Milestone,
  type Person,
  type Project,
  type TicketLabel,
} from '@tm/shared/model';
import { PaneLoading } from '../PaneLoading';
import { useTransport } from '../transport';
import { useInitialLoad } from '../useInitialLoad';
import { BacklogTable } from './BacklogTable';
import { ProjectAdmin } from './ProjectAdmin';
import type { ProjectFormRepoCapability } from './ProjectForm';
import { TimelinePane } from './TimelinePane';

const useStyles = makeStyles({
  root: { display: 'flex', gap: '20px', minHeight: 0, height: '100%' },
  admin: { flex: '0 0 320px', minWidth: 0, overflowY: 'auto' },
  backlog: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: '10px' },
  viewSwitch: { display: 'flex', gap: '4px' },
});

/** The Projects screen's own two views of one project's tickets. */
type ProjectView = 'backlog' | 'timeline';

export interface ProjectsProps {
  /** Present only for a host that can attach a repo to a project (the desktop) — threaded
   *  down to `ProjectAdmin`'s own `ProjectForm`. Absent on the web, so its drawer stays
   *  repo-free. See `ProjectAdmin`'s file header. */
  repo?: ProjectFormRepoCapability;
}

export function Projects({ repo }: ProjectsProps = {}): JSX.Element {
  const styles = useStyles();
  const transport = useTransport();
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [people, setPeople] = useState<Person[]>([]);
  const [milestones, setMilestones] = useState<Milestone[]>([]);
  const [labels, setLabels] = useState<TicketLabel[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [view, setView] = useState<ProjectView>('backlog');

  const seed = useCallback(async () => {
    const [allProjects, allPeople, allMilestones, allLabels] = await Promise.all([
      transport.invoke('project:list'),
      transport.invoke('person:list'),
      transport.invoke('milestone:list'),
      transport.invoke('label:list'),
    ]);
    setProjects(allProjects.map((p) => p.project).filter(ownsTickets));
    setPeople(allPeople);
    setMilestones(allMilestones);
    setLabels(allLabels);
  }, [transport]);
  const initial = useInitialLoad(seed);

  // No `project:*`-list-changed push, unlike `person:*`/`milestone:*`/`label:*` below — a
  // plain project write re-reads through `refreshProjects` instead (`ProjectAdmin`'s own
  // `onProjectsChanged`), the same pattern the desktop's own admin pane uses.
  const refreshProjects = useCallback(async () => {
    const allProjects = await transport.invoke('project:list');
    setProjects(allProjects.map((p) => p.project).filter(ownsTickets));
  }, [transport]);

  useEffect(() => {
    const offPeople = transport.on('person:changed', setPeople);
    const offMilestones = transport.on('milestone:changed', setMilestones);
    const offLabels = transport.on('label:changed', setLabels);
    return () => {
      offPeople();
      offMilestones();
      offLabels();
    };
  }, [transport]);

  // Keep a project selected once there is one to select — the backlog otherwise has nothing
  // to show and the admin pane's list has nothing highlighted.
  useEffect(() => {
    if (!projects || projects.length === 0) return;
    if (selectedProjectId && projects.some((p) => p.id === selectedProjectId)) return;
    setSelectedProjectId(projects[0].id);
  }, [projects, selectedProjectId]);

  const selectedProject = useMemo(
    () => projects?.find((p) => p.id === selectedProjectId) ?? null,
    [projects, selectedProjectId],
  );

  const projectMilestones = useMemo(
    () => (selectedProject ? milestones.filter((m) => m.projectId === selectedProject.id) : []),
    [milestones, selectedProject],
  );
  const projectLabels = useMemo(
    () => (selectedProject ? labels.filter((l) => l.projectId === selectedProject.id) : []),
    [labels, selectedProject],
  );

  if (projects === null) {
    return (
      <PaneLoading
        label="Loading projects…"
        error={initial.error}
        onRetry={initial.retry}
        shape="rows"
      />
    );
  }

  return (
    <div className={styles.root}>
      <div className={styles.admin}>
        <ProjectAdmin
          projects={projects}
          selectedProjectId={selectedProjectId}
          onSelect={setSelectedProjectId}
          onProjectsChanged={() => void refreshProjects()}
          repo={repo}
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
            </div>
            {/* Keyed on the project: switching the selection is rare enough that a clean
                remount — a fresh seed load, a fresh subscription — beats reconciling either
                pane's state onto a different project mid-life. The two views are a SWITCH,
                never mounted together, so there is nothing for their independent ticket
                loads to disagree about. */}
            {view === 'backlog' ? (
              <BacklogTable
                key={selectedProject.id}
                projectId={selectedProject.id}
                people={people}
                labels={projectLabels}
                milestones={projectMilestones}
              />
            ) : (
              <TimelinePane
                key={selectedProject.id}
                projectId={selectedProject.id}
                people={people}
                labels={projectLabels}
                milestones={projectMilestones}
              />
            )}
          </>
        )}
      </div>
    </div>
  );
}
