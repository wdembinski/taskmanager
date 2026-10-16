/**
 * The sidebar's own view logic — the milestone/epic/ticket tree, the fixed section order and
 * the view/archived/machine rows around it — kept pure and apart from the renderer (F13.11) so
 * the placement rules and the "TM-9 before TM-10" sort can be tested without a DOM.
 */
import type { Milestone, Project, Task } from '@tm/shared/model';
import { isEpic } from '@tm/shared/tickets';
import { NO_EPIC_GROUP, sortBacklog } from '../projects/backlogView';

/**
 * The bucket every ticket whose `milestoneId` is null, or names a milestone not in this
 * project's list, lands in — the sibling {@link NO_EPIC_GROUP} already names for epics. Named
 * rather than left blank, for the same reason.
 */
export const NO_MILESTONE_GROUP = 'No milestone';

export interface SidebarWorkspace {
  id: string;
  name: string;
}

export interface SidebarView {
  id: 'inbox' | 'myIssues' | 'reviews';
  label: string;
  count?: number;
}

/**
 * One row of the milestone/epic/ticket tree.
 *
 * Ids are stable and unique across the whole tree: `milestone:<id>` (or `milestone:none` for
 * the {@link NO_MILESTONE_GROUP} bucket), `epic:<milestoneId|none>:<epicId|none>` (the `none`
 * epic id is the {@link NO_EPIC_GROUP} bucket), `ticket:<taskId>`. An epic's id is qualified by
 * the milestone it is grouped under because the SAME epic can head a group in two different
 * milestones — see {@link buildSidebar}'s placement rule.
 *
 * `count` is the number of non-epic tickets under the node: for a milestone, every leaf under
 * every one of its epic groups plus its own `No epic` bucket; for an epic, its direct children.
 * `folded` just mirrors whether this id was in the input `folds` — `children` are always
 * returned regardless, since the renderer (not this model) decides what a fold hides, and the
 * count above must stay correct either way.
 */
export interface SidebarTreeNode {
  id: string;
  kind: 'milestone' | 'epic' | 'ticket';
  label: string;
  ticketKey?: string;
  taskId?: string;
  milestoneId?: string;
  closed?: boolean;
  count: number;
  folded: boolean;
  children: SidebarTreeNode[];
}

export type SidebarSection =
  | { kind: 'workspace'; workspaces: readonly SidebarWorkspace[]; activeWorkspaceId: string | null }
  | { kind: 'views'; views: SidebarView[] }
  | { kind: 'team'; name: string | undefined; tree: SidebarTreeNode[] }
  | { kind: 'archived'; count: number }
  | { kind: 'machine'; projects: readonly Pick<Project, 'id' | 'name'>[] }
  | { kind: 'newIssue'; shortcut: string };

export interface SidebarInput {
  /** Only "This machine" until F19. */
  workspaces: readonly SidebarWorkspace[];
  /** Defaults to the first workspace. */
  activeWorkspaceId?: string | null;
  /** The "This machine" entries. */
  projects: readonly Pick<Project, 'id' | 'name'>[];
  /** The selected ticket project's name, for the `team` section's header. */
  teamName?: string;
  milestones: readonly Milestone[];
  /** The selected ticket project's tickets, epics included. */
  tickets: readonly Task[];
  attentionCount: number;
  archivedCount: number;
  /** Folded tree-node ids. */
  folds: readonly string[];
  /** F15; default `false` omits the Reviews row entirely. */
  reviewsEnabled?: boolean;
  /** F14's predicate; default hides nothing. */
  isMilestoneArchived?: (milestone: Milestone) => boolean;
}

/**
 * Milestones sort open-first elsewhere; within either group the order is due date ascending
 * with undated (`dueAt: null`) ones last — `sortBacklog`'s `'due'` convention — then by
 * `createdAt` ascending, then by name, so two milestones sharing a due date (or lacking one)
 * still land in a fixed order instead of whatever order the input happened to list them in.
 */
function compareMilestones(a: Milestone, b: Milestone): number {
  if (a.dueAt == null && b.dueAt != null) return 1;
  if (a.dueAt != null && b.dueAt == null) return -1;
  if (a.dueAt != null && b.dueAt != null && a.dueAt !== b.dueAt) return a.dueAt - b.dueAt;
  if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
  return a.name.localeCompare(b.name);
}

function ticketNode(ticket: Task, foldSet: ReadonlySet<string>): SidebarTreeNode {
  const id = `ticket:${ticket.id}`;
  return {
    id,
    kind: 'ticket',
    label: ticket.title,
    ticketKey: ticket.ticketKey ?? undefined,
    taskId: ticket.id,
    count: 0,
    folded: foldSet.has(id),
    children: [],
  };
}

/**
 * One milestone bucket's epic groups: tickets are placed by their OWN `epicTaskId`, looked up
 * against `epicsById` — the whole project's epics, not just the ones placed in this bucket —
 * because an epic can be planned for a different milestone than a ticket that names it as its
 * epic (see {@link buildSidebar}). `epicsPlacedHere` are the epic tickets whose own
 * `milestoneId` resolved to this bucket; each still heads a group here even with no children,
 * the same "a header never vanishes" rule `backlogView.ts`'s `groupTickets` keeps.
 */
function buildEpicGroups(
  milestoneKey: string,
  nonEpicTickets: readonly Task[],
  epicsPlacedHere: readonly Task[],
  epicsById: ReadonlyMap<string, Task>,
  foldSet: ReadonlySet<string>,
): SidebarTreeNode[] {
  const childrenByEpicId = new Map<string, Task[]>();
  for (const epic of epicsPlacedHere) {
    if (!childrenByEpicId.has(epic.id)) childrenByEpicId.set(epic.id, []);
  }

  const orphans: Task[] = [];
  for (const ticket of nonEpicTickets) {
    const epic = ticket.epicTaskId ? epicsById.get(ticket.epicTaskId) : undefined;
    if (!epic) {
      orphans.push(ticket);
      continue;
    }
    if (!childrenByEpicId.has(epic.id)) childrenByEpicId.set(epic.id, []);
    childrenByEpicId.get(epic.id)!.push(ticket);
  }

  const epicsHere = sortBacklog(
    [...childrenByEpicId.keys()].map((id) => epicsById.get(id)!),
    'key',
  );

  const groups: SidebarTreeNode[] = epicsHere.map((epic) => {
    const id = `epic:${milestoneKey}:${epic.id}`;
    const children = sortBacklog(childrenByEpicId.get(epic.id)!, 'key');
    return {
      id,
      kind: 'epic',
      label: epic.title,
      ticketKey: epic.ticketKey ?? undefined,
      taskId: epic.id,
      milestoneId: milestoneKey === 'none' ? undefined : milestoneKey,
      count: children.length,
      folded: foldSet.has(id),
      children: children.map((t) => ticketNode(t, foldSet)),
    };
  });

  if (orphans.length > 0) {
    const id = `epic:${milestoneKey}:none`;
    const children = sortBacklog(orphans, 'key');
    groups.push({
      id,
      kind: 'epic',
      label: NO_EPIC_GROUP,
      milestoneId: milestoneKey === 'none' ? undefined : milestoneKey,
      count: children.length,
      folded: foldSet.has(id),
      children: children.map((t) => ticketNode(t, foldSet)),
    });
  }

  return groups;
}

function buildMilestoneNode(
  milestoneId: string | null,
  label: string,
  closed: boolean | undefined,
  bucketTickets: readonly Task[],
  epicsById: ReadonlyMap<string, Task>,
  foldSet: ReadonlySet<string>,
): SidebarTreeNode {
  const milestoneKey = milestoneId ?? 'none';
  const id = `milestone:${milestoneKey}`;
  const nonEpics = bucketTickets.filter((t) => !isEpic(t));
  const epicsPlacedHere = bucketTickets.filter(isEpic);
  const children = buildEpicGroups(milestoneKey, nonEpics, epicsPlacedHere, epicsById, foldSet);
  return {
    id,
    kind: 'milestone',
    label,
    milestoneId: milestoneId ?? undefined,
    closed,
    count: nonEpics.length,
    folded: foldSet.has(id),
    children,
  };
}

/**
 * The milestone/epic/ticket tree alone — the `team` section's `tree`.
 *
 * Placement rule: a ticket's own `milestoneId` decides its milestone bucket (an unknown one
 * falling back to {@link NO_MILESTONE_GROUP}, same as `groupTickets` does for a missing epic);
 * its `epicTaskId` decides its epic group WITHIN that bucket, independently of what milestone
 * the epic ticket itself is placed in. So a ticket in M2 whose epic is planned for M1 shows
 * under M2 › that epic, and the epic also heads its own (possibly empty) group under M1.
 *
 * A milestone that `isMilestoneArchived` flags is dropped from the tree together with every
 * ticket placed into it — never reassigned to {@link NO_MILESTONE_GROUP}. The two named
 * buckets are themselves never archived.
 */
function buildTree(
  milestones: readonly Milestone[],
  tickets: readonly Task[],
  isMilestoneArchived: (milestone: Milestone) => boolean,
  foldSet: ReadonlySet<string>,
): SidebarTreeNode[] {
  const archivedIds = new Set(milestones.filter(isMilestoneArchived).map((m) => m.id));
  const liveMilestones = milestones.filter((m) => !archivedIds.has(m.id));
  const liveIds = new Set(liveMilestones.map((m) => m.id));
  const liveTickets = tickets.filter((t) => !(t.milestoneId && archivedIds.has(t.milestoneId)));

  const epicsById = new Map<string, Task>();
  for (const ticket of liveTickets) {
    if (isEpic(ticket)) epicsById.set(ticket.id, ticket);
  }

  const bucketed = new Map<string | null, Task[]>();
  for (const ticket of liveTickets) {
    const key = ticket.milestoneId && liveIds.has(ticket.milestoneId) ? ticket.milestoneId : null;
    if (!bucketed.has(key)) bucketed.set(key, []);
    bucketed.get(key)!.push(ticket);
  }

  const open = liveMilestones.filter((m) => !m.closed).sort(compareMilestones);
  const closed = liveMilestones.filter((m) => m.closed).sort(compareMilestones);

  const tree: SidebarTreeNode[] = [];
  for (const m of open) {
    tree.push(
      buildMilestoneNode(m.id, m.name, m.closed, bucketed.get(m.id) ?? [], epicsById, foldSet),
    );
  }
  const unplaced = bucketed.get(null) ?? [];
  if (unplaced.length > 0) {
    tree.push(
      buildMilestoneNode(null, NO_MILESTONE_GROUP, undefined, unplaced, epicsById, foldSet),
    );
  }
  for (const m of closed) {
    tree.push(
      buildMilestoneNode(m.id, m.name, m.closed, bucketed.get(m.id) ?? [], epicsById, foldSet),
    );
  }
  return tree;
}

/**
 * The whole sidebar: workspace picker, the fixed views (Inbox / My issues / Reviews), the
 * team's milestone/epic/ticket tree, Archived, the "This machine" project list and New issue —
 * always in that order, so the renderer (F13.11) never has to branch on section identity to
 * decide where it goes.
 */
export function buildSidebar(input: SidebarInput): SidebarSection[] {
  const foldSet = new Set(input.folds);
  const isMilestoneArchived = input.isMilestoneArchived ?? (() => false);

  const views: SidebarView[] = [
    { id: 'inbox', label: 'Inbox', count: input.attentionCount },
    { id: 'myIssues', label: 'My issues' },
  ];
  if (input.reviewsEnabled) views.push({ id: 'reviews', label: 'Reviews' });

  return [
    {
      kind: 'workspace',
      workspaces: input.workspaces,
      activeWorkspaceId: input.activeWorkspaceId ?? input.workspaces[0]?.id ?? null,
    },
    { kind: 'views', views },
    {
      kind: 'team',
      name: input.teamName,
      tree: buildTree(input.milestones, input.tickets, isMilestoneArchived, foldSet),
    },
    { kind: 'archived', count: input.archivedCount },
    { kind: 'machine', projects: input.projects },
    { kind: 'newIssue', shortcut: 'C' },
  ];
}
