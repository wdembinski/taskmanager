/**
 * Projects — the native ticket projects screen (Phase 24): manage the projects themselves
 * (`ProjectAdmin`) and browse the selected one's backlog (`BacklogTable`).
 *
 * Shared rather than desktop-only, unlike Settings' "Agent projects" section: a ticket
 * project is nothing but rows in the store (no folder, no native picker), reachable over the
 * same relayed channels either host can call — see `ProjectAdmin`'s own header and
 * `shell-parity.test.ts`'s "the one configuration the web deliberately does not mirror" block,
 * which is about *agent* projects and does not apply here.
 *
 * The seed loads the four collections every part of this screen reads: the ticket projects
 * themselves, and the app-wide people/milestone/label registries a ticket can point at.
 * `board:tasks` for the selected project's own tickets is `BacklogTable`'s to fetch — a
 * project switch should not re-fetch the roster, and a roster edit should not re-fetch every
 * project's tickets.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { makeStyles } from '@fluentui/react-components';
import type { Milestone, Person, Project, TicketLabel } from '@tm/shared/model';
import { PaneLoading } from '../PaneLoading';
import { useTransport } from '../transport';
import { useInitialLoad } from '../useInitialLoad';
import { BacklogTable } from './BacklogTable';
import { ProjectAdmin } from './ProjectAdmin';

const useStyles = makeStyles({
  root: { display: 'flex', gap: '20px', minHeight: 0, height: '100%' },
  admin: { flex: '0 0 320px', minWidth: 0, overflowY: 'auto' },
  backlog: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' },
});

export function Projects(): JSX.Element {
  const styles = useStyles();
  const transport = useTransport();
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [people, setPeople] = useState<Person[]>([]);
  const [milestones, setMilestones] = useState<Milestone[]>([]);
  const [labels, setLabels] = useState<TicketLabel[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);

  const seed = useCallback(async () => {
    const [ticketProjects, allPeople, allMilestones, allLabels] = await Promise.all([
      transport.invoke('ticketProject:list'),
      transport.invoke('person:list'),
      transport.invoke('milestone:list'),
      transport.invoke('label:list'),
    ]);
    setProjects(ticketProjects);
    setPeople(allPeople);
    setMilestones(allMilestones);
    setLabels(allLabels);
  }, [transport]);
  const initial = useInitialLoad(seed);

  useEffect(() => {
    const offProjects = transport.on('ticketProject:changed', setProjects);
    const offPeople = transport.on('person:changed', setPeople);
    const offMilestones = transport.on('milestone:changed', setMilestones);
    const offLabels = transport.on('label:changed', setLabels);
    return () => {
      offProjects();
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
        />
      </div>
      <div className={styles.backlog}>
        {selectedProject && (
          // Keyed on the project: switching the selection is rare enough that a clean
          // remount — a fresh seed load, a fresh subscription — beats reconciling
          // `BacklogTable`'s state onto a different project mid-life.
          <BacklogTable
            key={selectedProject.id}
            projectId={selectedProject.id}
            people={people}
            labels={projectLabels}
            milestones={projectMilestones}
          />
        )}
      </div>
    </div>
  );
}
