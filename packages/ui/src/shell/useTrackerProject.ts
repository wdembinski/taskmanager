/**
 * The ticket project the sidebar's `team` tree shows, shared between any host that lifts it
 * (desktop App, Tickets workspace, web App) — wires `sidebarProject.ts`'s pure
 * {@link resolveSidebarProject} to a device's remembered choice, the same single-read-then-
 * persist shape `sidebarFolds.ts`'s `useDeviceFolds` already uses for folds.
 */
import { useMemo, useState } from 'react';
import type { Project } from '@tm/shared/model';
import { ownsTickets } from '@tm/shared/model';
import { pickableProjects } from '@tm/shared/trackerArchive';
import {
  parseRememberedProject,
  resolveSidebarProject,
  serializeRememberedProject,
} from './sidebarProject';

const STORAGE_KEY = 'sidebar-project';

export interface TrackerProjectOption {
  id: string;
  name: string;
}

export interface UseTrackerProjectResult {
  /** The resolved ticket project id, or `null` while `projects` has not loaded yet, or when
   *  there is no ticket project to show at all. */
  projectId: string | null;
  /** The ticket projects a switcher should offer — archived ones dropped. */
  projectOptions: TrackerProjectOption[];
  /** Remembers `id` as this device's choice and re-resolves `projectId` to it. */
  selectProject: (id: string) => void;
}

/**
 * Resolves and remembers which ticket project the sidebar's `team` tree shows.
 *
 * `projects === null` means "not loaded yet" — `projectId` reads as `null` in that state
 * rather than resolving against an empty list.
 */
export function useTrackerProject(
  projects: readonly Project[] | null,
  openCounts: ReadonlyMap<string, number>,
): UseTrackerProjectResult {
  const [rememberedId, setRememberedId] = useState<string | null>(() => {
    try {
      return parseRememberedProject(localStorage.getItem(STORAGE_KEY));
    } catch {
      return null;
    }
  });

  const projectId = useMemo(() => {
    if (projects === null) return null;
    return resolveSidebarProject({ projects, openCounts, rememberedId });
  }, [projects, openCounts, rememberedId]);

  const projectOptions = useMemo(() => {
    if (projects === null) return [];
    return pickableProjects(projects)
      .filter(ownsTickets)
      .map((project) => ({ id: project.id, name: project.name }));
  }, [projects]);

  function selectProject(id: string): void {
    setRememberedId(id);
    try {
      localStorage.setItem(STORAGE_KEY, serializeRememberedProject(id));
    } catch {
      // Storage unavailable — the choice just is not remembered next time.
    }
  }

  return { projectId, projectOptions, selectProject };
}
