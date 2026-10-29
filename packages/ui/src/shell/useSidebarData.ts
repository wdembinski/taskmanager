/**
 * useSidebarData — wires `sidebarModel.ts`'s pure `buildSidebar` to the transport, the same
 * shape `useTicketRegistries` already wires the backlog's registries: one seed, kept current
 * by the narrowest event each piece actually has.
 *
 * `projectId` selects which ticket project's milestone/epic/ticket tree the `team` section
 * shows — the SAME optional scoping `board:tasks`/`milestone:list` already take. The
 * `machine` section is NOT scoped to it: it is every project this machine can run an agent
 * in (`hasRepo`), plus the built-in Personal board, independently of whichever ticket project
 * is currently selected — see `machineProjectsOf`'s own doc for why Personal is included by
 * name rather than by `hasRepo` alone.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Milestone, Project } from '@tm/shared/model';
import type { TaskSummary } from '@tm/shared/taskSummary';
import { PERSONAL_PROJECT_ID, hasRepo, isPersonalBoard } from '@tm/shared/model';
import { archivedViewModel } from '../projects/archivedView';
import { useTransport } from '../transport';
import { useInitialLoad, type InitialLoad } from '../useInitialLoad';
import { useTaskSummaries } from '../useTaskSummaries';
import { buildSidebar, type SidebarInput, type SidebarSection } from './sidebarModel';

/** Every project this machine can run an agent in, Personal first — Personal has no `path`
 *  (`hasRepo` is false for it), but it is still unambiguously a destination on THIS machine,
 *  so it is named explicitly rather than folded into the `hasRepo` filter. */
function machineProjectsOf(projects: readonly Project[]): Array<Pick<Project, 'id' | 'name'>> {
  const personal = projects.find((p) => isPersonalBoard(p.id));
  const repos = projects.filter((p) => !isPersonalBoard(p.id) && hasRepo(p));
  return [...(personal ? [personal] : []), ...repos].map((p) => ({ id: p.id, name: p.name }));
}

/** `milestone:list`'s own rows carry archived ones too (the store does not filter them, see
 *  `ipc.ts`'s `listMilestones`) — without this, `buildMilestoneTree` reads every one of them as live,
 *  contradicting the Archived view's own "hidden from the tree" copy (`ArchivedPane.tsx`). A
 *  stable module-level reference, not an inline closure, so it never busts `sections`' own
 *  `useMemo` on its own. */
function isMilestoneArchived(milestone: Milestone): boolean {
  return milestone.archivedAt != null;
}

/** A stable empty list, so `sections`' own `useMemo` is not busted while nothing is loaded. */
const NO_TICKETS: TaskSummary[] = [];

export interface UseSidebarDataOptions {
  /** How many items wait on a human — the Inbox row's own count, read by whichever host
   *  already subscribes to `attention:new`/`attention:resolved` for its own badge. */
  attentionCount: number;
  /** This device's folded tree-node ids (`useDeviceFolds`). */
  folds: readonly string[];
  /** F15; omitted hides the Reviews row, same default as `buildSidebar` itself. */
  reviewsEnabled?: boolean;
  /** The Reviews row's count (`useRequestedReviewCount`); omitted draws the row without one. */
  reviewsCount?: number;
  /** The cloud team's name while signed in — the workspace header reads it over "Cloud";
   *  omitted, the header is "Personal" over "Local". NOT the hook's own `teamName`, which is
   *  the selected ticket project and already heads the tree below. */
  cloudTeamName?: string;
}

export interface SidebarData extends Pick<InitialLoad, 'error' | 'retry'> {
  sections: SidebarSection[];
  /** True once the seed has resolved at least once. */
  loaded: boolean;
  /** The selected project's own tickets, as card summaries (F29.2) — `NewTicketDialog`'s
   *  own `tickets` prop needs exactly this list. */
  tickets: TaskSummary[];
}

export function useSidebarData(
  projectId: string | null,
  options: UseSidebarDataOptions,
): SidebarData {
  const transport = useTransport();
  const [teamName, setTeamName] = useState<string | undefined>(undefined);
  const [machineProjects, setMachineProjects] = useState<Array<Pick<Project, 'id' | 'name'>>>([]);
  const [milestones, setMilestones] = useState<Milestone[]>([]);
  const [archivedCount, setArchivedCount] = useState(0);
  const [loaded, setLoaded] = useState(false);

  /** The Archived row's own count (F14.8) — `archive:list()` unscoped (its `projects` are
   *  never narrowed by a project id, see `ArchivedView.tsx`'s own header), read through
   *  `archivedViewModel` purely for its `.total`; `tickets: []` since a count needs none of
   *  the per-row tallying `archivedTicketSummary` does with them. */
  const loadArchivedCount = useCallback(async () => {
    const listing = await transport.invoke('archive:list');
    setArchivedCount(archivedViewModel(listing, [], projectId).total);
  }, [transport, projectId]);

  // The selected project's tickets, merged from deltas (F29.2). A delta can archive or
  // restore a ticket, so it re-reads the Archived row's count too — never the board.
  const summaries = useTaskSummaries(projectId, {
    onDelta: () => void loadArchivedCount().catch(() => undefined),
  });
  const tickets = projectId ? (summaries.tasks ?? NO_TICKETS) : NO_TICKETS;

  const seed = useCallback(async () => {
    const [allProjects, projectMilestones] = await Promise.all([
      transport.invoke('project:list'),
      transport.invoke('milestone:list', projectId ?? undefined),
      loadArchivedCount(),
    ]);
    const projectList = allProjects.map((p) => p.project);
    setTeamName(projectList.find((p) => p.id === projectId)?.name);
    setMachineProjects(machineProjectsOf(projectList));
    setMilestones(projectMilestones);
    setLoaded(true);
  }, [transport, projectId, loadArchivedCount]);
  const initial = useInitialLoad(seed);

  useEffect(
    () =>
      transport.on('milestone:changed', (ms) => {
        setMilestones(ms);
        void loadArchivedCount();
      }),
    [transport, loadArchivedCount],
  );

  const sections = useMemo(() => {
    const input: SidebarInput = {
      workspaces: [
        options.cloudTeamName
          ? { id: PERSONAL_PROJECT_ID, name: options.cloudTeamName, sub: 'Cloud' }
          : { id: PERSONAL_PROJECT_ID, name: 'Personal', sub: 'Local' },
      ],
      activeWorkspaceId: PERSONAL_PROJECT_ID,
      projects: machineProjects,
      teamName,
      milestones,
      tickets,
      attentionCount: options.attentionCount,
      archivedCount,
      folds: options.folds,
      reviewsEnabled: options.reviewsEnabled,
      reviewsCount: options.reviewsCount,
      isMilestoneArchived,
    };
    return buildSidebar(input);
  }, [
    machineProjects,
    teamName,
    milestones,
    tickets,
    options.attentionCount,
    archivedCount,
    options.folds,
    options.reviewsEnabled,
    options.reviewsCount,
    options.cloudTeamName,
  ]);

  return {
    sections,
    // The tree is not drawn from half its inputs: the tickets' own load counts too.
    loaded: loaded && (projectId === null || summaries.tasks !== null),
    tickets,
    error: initial.error ?? summaries.error,
    retry: () => {
      initial.retry();
      summaries.retry();
    },
  };
}
