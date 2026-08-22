/**
 * Projects — the Tickets tab: pick a ticket project (`ProjectPicker`) and browse the selected
 * one's backlog (`BacklogTable`). Managing projects themselves — adding, renaming, choosing what
 * a project owns — lives on the Projects tab's own `ProjectAdmin` pane, not here; this screen
 * only reads the list, it never writes one.
 *
 * Shared rather than desktop-only, unlike the desktop's own repo-picker `Projects` admin
 * screen: a ticket project is nothing but rows in the store (no folder, no native picker),
 * reachable over the same relayed channels either host can call — see `ProjectAdmin`'s own
 * header and `shell-parity.test.ts`'s "agent projects" block, which is about *repo* projects
 * and does not apply here.
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
import { ProjectPicker } from './ProjectPicker';
import { TimelinePane } from './TimelinePane';

const useStyles = makeStyles({
  root: { display: 'flex', gap: '20px', minHeight: 0, height: '100%' },
  admin: { flex: '0 0 320px', minWidth: 0, overflowY: 'auto' },
  backlog: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: '10px' },
  viewSwitch: { display: 'flex', gap: '4px' },
});

/** The Projects screen's own two views of one project's tickets. */
type ProjectView = 'backlog' | 'timeline';

export function Projects(): JSX.Element {
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
  // to show and the picker's list has nothing highlighted.
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
