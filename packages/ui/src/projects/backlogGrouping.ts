/**
 * The Backlog's "Group by" switch — status (the default, F13.15), epic or milestone — with all
 * three modes normalised into one {@link BacklogSection} shape so `BacklogTable` renders a
 * single recursive header list whichever is picked. Pure apart from the storage hook at the
 * bottom, so each mode's order can be tested without a DOM.
 */
import { useState } from 'react';
import type { Milestone, Task } from '@tm/shared/model';
import type { ArchiveIndex } from '@tm/shared/trackerArchive';
import { buildMilestoneTree, type SidebarTreeNode } from '../shell/sidebarModel';
import { backlogStatusGroups } from './backlogStatus';
import {
  archiveVisibleTickets,
  type BacklogSortKey,
  filterTickets,
  groupTickets,
  sortBacklog,
} from './backlogView';

export type BacklogGroupMode = 'status' | 'epic' | 'milestone';

/**
 * One header and what sits under it.
 *
 * `id` is the fold id, unique across one mode's list: `status:<column>`, `epic:<epicId|none>`,
 * `milestone:<id|none>` and `milestone:<id|none>/epic:<epicId|none>`. `level` 2 is only ever a
 * milestone's epic sub-header. `addChildEpicId` is set on a REAL epic's header only — the
 * epic a new ticket filed from that header's "Add child" lands under; `No epic` has none.
 * `tickets` are the header's own rows, in the user's sort order; a level-1 milestone that has
 * epic sub-headers carries its rows in those `sections` instead.
 */
export interface BacklogSection {
  id: string;
  label: string;
  level: 1 | 2;
  addChildEpicId?: string;
  tickets: Task[];
  sections: BacklogSection[];
}

export interface BacklogGroupsInput {
  tickets: readonly Task[];
  milestones: readonly Milestone[];
  query: string;
  sortKey: BacklogSortKey;
  archive?: { index: ArchiveIndex; includeArchived?: boolean };
}

const GROUP_MODES: readonly BacklogGroupMode[] = ['status', 'epic', 'milestone'];

/** A stored mode back as a {@link BacklogGroupMode}; anything else — a never-written key, a
 *  value from some later build — is `'status'`, the mockup's own default. */
export function parseGroupMode(raw: string | null | undefined): BacklogGroupMode {
  return GROUP_MODES.find((mode) => mode === raw) ?? 'status';
}

/** archive → filter → sort, the same three calls (in the same order) as `backlogRows`. */
function visibleSorted(input: BacklogGroupsInput): Task[] {
  return sortBacklog(
    filterTickets(archiveVisibleTickets(input.tickets, input.archive), input.query),
    input.sortKey,
  );
}

/** Status mode: `backlogStatusGroups` unchanged, one section per column. */
export function backlogStatusSections(input: BacklogGroupsInput): BacklogSection[] {
  return backlogStatusGroups(input.tickets, input.query, input.sortKey, input.archive).map(
    (group) => ({
      id: `status:${group.column}`,
      label: group.label,
      level: 1,
      tickets: group.tickets,
      sections: [],
    }),
  );
}

/**
 * Epic mode: `groupTickets` over the visible, sorted list — with steps (`parentTaskId` set)
 * dropped first, the TM-451 rule the status mode and the sidebar already keep — so every epic
 * still heads a group even with no children, and `No epic` comes last when it has rows.
 */
export function backlogEpicGroups(input: BacklogGroupsInput): BacklogSection[] {
  return groupTickets(visibleSorted(input).filter((t) => !t.parentTaskId)).map((group) => ({
    id: `epic:${group.epicId ?? 'none'}`,
    label: group.epicTitle,
    level: 1,
    ...(group.epicId ? { addChildEpicId: group.epicId } : {}),
    tickets: group.tickets,
    sections: [],
  }));
}

/** The ticket ids a sidebar node lists — its own ticket leaves, never an epic header. */
function leafIds(node: SidebarTreeNode): Set<string> {
  return new Set(
    node.children.filter((c) => c.kind === 'ticket' && c.taskId).map((c) => c.taskId!),
  );
}

/**
 * Milestone mode: the ORDER comes from the sidebar's own `buildMilestoneTree` (open milestones
 * with work by due date, `No milestone`, finished ones, closed last; epics open-first, then
 * `No epic`), but each header's rows are the visible, sorted list filtered to that node's
 * tickets — so Sort by key / due still decides row order inside a group, as it does in the
 * other two modes.
 *
 * Epic sub-headers appear only where the sidebar nests them: a milestone that heads no epic
 * group lists its rows directly. A milestone left with no rows and no sub-header (every
 * ticket filtered out by a search, say) is dropped, so a query never leaves a wall of empty
 * headers; an empty epic sub-header stays, keeping its "Add child" reachable. An archived
 * milestone is dropped with its tickets unless `includeArchived` is on.
 */
export function backlogMilestoneGroups(input: BacklogGroupsInput): BacklogSection[] {
  const sorted = visibleSorted(input);
  const isMilestoneArchived = input.archive?.includeArchived
    ? () => false
    : (m: Milestone) => m.archivedAt != null;
  const tree = buildMilestoneTree(input.milestones, sorted, isMilestoneArchived);

  const rowsOf = (node: SidebarTreeNode): Task[] => {
    const ids = leafIds(node);
    return sorted.filter((t) => ids.has(t.id));
  };

  const sections: BacklogSection[] = [];
  for (const milestone of tree) {
    const milestoneId = `milestone:${milestone.milestoneId ?? 'none'}`;
    const epicNodes = milestone.children.filter((c) => c.kind === 'epic');
    const subSections: BacklogSection[] = epicNodes.map((epic) => ({
      id: `${milestoneId}/epic:${epic.taskId ?? 'none'}`,
      label: epic.label,
      level: 2,
      ...(epic.taskId ? { addChildEpicId: epic.taskId } : {}),
      tickets: rowsOf(epic),
      sections: [],
    }));
    const tickets = rowsOf(milestone);
    if (tickets.length === 0 && subSections.length === 0) continue;
    sections.push({
      id: milestoneId,
      label: milestone.label,
      level: 1,
      tickets,
      sections: subSections,
    });
  }
  return sections;
}

/** The sections `mode` groups `input` into. */
export function backlogGroups(mode: BacklogGroupMode, input: BacklogGroupsInput): BacklogSection[] {
  switch (mode) {
    case 'epic':
      return backlogEpicGroups(input);
    case 'milestone':
      return backlogMilestoneGroups(input);
    default:
      return backlogStatusSections(input);
  }
}

const GROUP_MODE_KEY = 'tm.backlog.groupBy';

/**
 * The Backlog's grouping, remembered per DEVICE under `tm.backlog.groupBy` and read back
 * through {@link parseGroupMode}. Both sides are wrapped in `try`, as `deviceFold.ts`'s are,
 * so storage that refuses (private mode, a full quota) only means the choice is not kept.
 */
export function useBacklogGroupMode(): [
  mode: BacklogGroupMode,
  setMode: (mode: BacklogGroupMode) => void,
] {
  const [mode, setModeState] = useState<BacklogGroupMode>(() => {
    try {
      return parseGroupMode(localStorage.getItem(GROUP_MODE_KEY));
    } catch {
      return 'status';
    }
  });

  function setMode(next: BacklogGroupMode): void {
    setModeState(next);
    try {
      localStorage.setItem(GROUP_MODE_KEY, next);
    } catch {
      // Storage unavailable — the grouping just is not remembered next time.
    }
  }

  return [mode, setMode];
}
