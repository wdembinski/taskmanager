/**
 * The sidebar's own view logic — the milestone/epic/ticket tree, the fixed section order and
 * the view/archived/machine rows around it — kept pure and apart from the renderer (F13.11) so
 * the placement rules and the "TM-9 before TM-10" sort can be tested without a DOM.
 */
import type { Milestone, Project, Task, TaskStatus } from '@tm/shared/model';
import { columnForStatus } from '@tm/shared/board';
import { isEpic } from '@tm/shared/tickets';
import { NO_EPIC_GROUP, sortBacklog } from '../projects/backlogView';
import { isFolded } from './sidebarFolds';

/**
 * The bucket every ticket whose `milestoneId` is null, or names a milestone not in this
 * project's list, lands in — the sibling {@link NO_EPIC_GROUP} already names for epics. Named
 * rather than left blank, for the same reason.
 */
export const NO_MILESTONE_GROUP = 'No milestone';

export interface SidebarWorkspace {
  id: string;
  name: string;
  /** The muted line under the name in the header — "Cloud" or "Local" (v9-1). */
  sub?: string;
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
 * `folded` is {@link isFolded} against `defaultFolded` — not a plain mirror of the input
 * `folds` — so a milestone/epic with no open work underneath starts folded even with an empty
 * `folds` list; `children` are always returned regardless, since the renderer (not this model)
 * decides what a fold hides, and the count above must stay correct either way.
 */
export interface SidebarTreeNode {
  id: string;
  kind: 'milestone' | 'epic' | 'ticket';
  label: string;
  ticketKey?: string;
  taskId?: string;
  milestoneId?: string;
  status?: TaskStatus;
  closed?: boolean;
  /** Milestone/epic nodes only: true when every ticket under the node is in the `done`
   *  board column (and there is at least one). Decides `defaultFolded` and the node's band
   *  in its parent's open-work-first ordering. */
  finished?: boolean;
  defaultFolded?: boolean;
  count: number;
  /** Milestone nodes only: how many of `count`'s tickets are still open — lets the renderer
   *  show "open/total" instead of a bare total. */
  openCount?: number;
  folded: boolean;
  children: SidebarTreeNode[];
}

export type SidebarSection =
  | { kind: 'workspace'; workspaces: readonly SidebarWorkspace[]; activeWorkspaceId: string | null }
  | { kind: 'views'; views: SidebarView[] }
  | { kind: 'team'; name: string | undefined; tree: SidebarTreeNode[] }
  | { kind: 'archived'; count: number }
  | {
      kind: 'machine';
      label: string;
      /** Shown after each project row. Only `local` until F19's cloud workspaces carry their
       *  own location through the same field. */
      location: 'local';
      projects: readonly Pick<Project, 'id' | 'name'>[];
    }
  | { kind: 'newIssue'; shortcut: string };

export interface SidebarInput {
  /** Only one until F19: the cloud team, or "Personal" when not signed in. */
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
  /** The Reviews row's count — the *Requested from me* rows (F15.14b); omitted draws none. */
  reviewsCount?: number;
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
    // `ticketKey` is a native ticket's own key; a mirrored tracker row (jira/github/linear)
    // carries its key as `externalKey` instead — same fallback `cardParts.ts`/`issueRowParts.ts`
    // already use, so a row like LIN-203 shows its key here too.
    ticketKey: ticket.ticketKey ?? ticket.externalKey ?? undefined,
    taskId: ticket.id,
    status: ticket.status,
    count: 0,
    folded: isFolded(foldSet, id, false),
    children: [],
  };
}

/** Whether `ticket` is done, failed, stopped or cancelled — the board's `done` column — the
 *  sense of "no open work left" that decides a milestone/epic group's finished/open banding. */
function isFinishedTicket(ticket: Task): boolean {
  return columnForStatus(ticket.status) === 'done';
}

/** A group (milestone or epic) is finished when it has at least one ticket and every one of
 *  them is finished — an empty group counts as having open work, not as finished. */
function isGroupFinished(tickets: readonly Task[]): boolean {
  return tickets.length > 0 && tickets.every(isFinishedTicket);
}

/** `tickets`, open ones first then finished ones, `sortBacklog(…, 'key')` order within each
 *  half — the order every group's children (and every milestone's leaf tickets) are shown in. */
function orderByOpenFirst(tickets: readonly Task[]): Task[] {
  const open = sortBacklog(
    tickets.filter((t) => !isFinishedTicket(t)),
    'key',
  );
  const finished = sortBacklog(tickets.filter(isFinishedTicket), 'key');
  return [...open, ...finished];
}

/**
 * One milestone bucket's epic groups: tickets are placed by their OWN `epicTaskId`, looked up
 * against `epicsById` — the whole project's epics, not just the ones placed in this bucket —
 * because an epic can be planned for a different milestone than a ticket that names it as its
 * epic (see {@link buildSidebar}). `epicsPlacedHere` are the epic tickets whose own
 * `milestoneId` resolved to this bucket; each still heads a group here even with no children,
 * the same "a header never vanishes" rule `backlogView.ts`'s `groupTickets` keeps.
 *
 * Groups with open work sort before finished groups (key order preserved within each band);
 * the `No epic` bucket is always appended last regardless of its own finished state.
 *
 * When this milestone bucket heads no real epic group at all (no epic ticket placed here, and
 * no ticket here names an epic placed elsewhere either), there is nothing for a `No epic` label
 * to distinguish itself from — every ticket returned is a leaf, not a group, so the milestone
 * lists them directly instead of adding an empty indirection level under every epic-less
 * milestone.
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

  if (epicsHere.length === 0) {
    return orderByOpenFirst(orphans).map((t) => ticketNode(t, foldSet));
  }

  const openEpics = epicsHere.filter((epic) => !isGroupFinished(childrenByEpicId.get(epic.id)!));
  const finishedEpics = epicsHere.filter((epic) => isGroupFinished(childrenByEpicId.get(epic.id)!));

  const groups: SidebarTreeNode[] = [...openEpics, ...finishedEpics].map((epic) => {
    const id = `epic:${milestoneKey}:${epic.id}`;
    const rawChildren = childrenByEpicId.get(epic.id)!;
    const children = orderByOpenFirst(rawChildren);
    const finished = isGroupFinished(rawChildren);
    return {
      id,
      kind: 'epic',
      label: epic.title,
      ticketKey: epic.ticketKey ?? undefined,
      taskId: epic.id,
      milestoneId: milestoneKey === 'none' ? undefined : milestoneKey,
      count: children.length,
      finished,
      defaultFolded: finished,
      folded: isFolded(foldSet, id, finished),
      children: children.map((t) => ticketNode(t, foldSet)),
    };
  });

  if (orphans.length > 0) {
    const id = `epic:${milestoneKey}:none`;
    const children = orderByOpenFirst(orphans);
    const finished = isGroupFinished(orphans);
    groups.push({
      id,
      kind: 'epic',
      label: NO_EPIC_GROUP,
      milestoneId: milestoneKey === 'none' ? undefined : milestoneKey,
      count: children.length,
      finished,
      defaultFolded: finished,
      folded: isFolded(foldSet, id, finished),
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
  const finished = isGroupFinished(nonEpics);
  return {
    id,
    kind: 'milestone',
    label,
    milestoneId: milestoneId ?? undefined,
    closed,
    count: nonEpics.length,
    openCount: nonEpics.filter((t) => !isFinishedTicket(t)).length,
    finished,
    defaultFolded: finished,
    folded: isFolded(foldSet, id, finished),
    children,
  };
}

/**
 * The milestone/epic/ticket tree alone — the `team` section's `tree`.
 *
 * A step (`parentTaskId` set) never reaches a bucket, an epic map or a count — it is dropped
 * before anything else runs, and so never appears anywhere in the tree.
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
 *
 * Order: open milestones with open work (due-date order) → `No milestone` if it has open work
 * → finished open milestones → `No milestone` if finished → closed milestones last. `No
 * milestone` appears at most once, banded by its own finished state; the closed-last rule and
 * each band's relative order are otherwise unchanged from before finished-banding existed.
 *
 * Exported so the Backlog's milestone grouping (`backlogGrouping.ts`) takes its order from
 * this one place instead of a second copy of these rules; `folds` there is simply omitted.
 */
export function buildMilestoneTree(
  milestones: readonly Milestone[],
  tickets: readonly Task[],
  isMilestoneArchived: (milestone: Milestone) => boolean,
  folds: readonly string[] = [],
): SidebarTreeNode[] {
  const foldSet = new Set(folds);
  const archivedIds = new Set(milestones.filter(isMilestoneArchived).map((m) => m.id));
  const liveMilestones = milestones.filter((m) => !archivedIds.has(m.id));
  const liveIds = new Set(liveMilestones.map((m) => m.id));
  const liveTickets = tickets.filter(
    (t) => !t.parentTaskId && !(t.milestoneId && archivedIds.has(t.milestoneId)),
  );

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

  const openNodes = open.map((m) =>
    buildMilestoneNode(m.id, m.name, m.closed, bucketed.get(m.id) ?? [], epicsById, foldSet),
  );
  const openWithWork = openNodes.filter((n) => !n.finished);
  const openFinished = openNodes.filter((n) => n.finished);

  const unplaced = bucketed.get(null) ?? [];
  const noMilestoneNode =
    unplaced.length > 0
      ? buildMilestoneNode(null, NO_MILESTONE_GROUP, undefined, unplaced, epicsById, foldSet)
      : null;

  const closedNodes = closed.map((m) =>
    buildMilestoneNode(m.id, m.name, m.closed, bucketed.get(m.id) ?? [], epicsById, foldSet),
  );

  return [
    ...openWithWork,
    ...(noMilestoneNode && !noMilestoneNode.finished ? [noMilestoneNode] : []),
    ...openFinished,
    ...(noMilestoneNode && noMilestoneNode.finished ? [noMilestoneNode] : []),
    ...closedNodes,
  ];
}

/**
 * The whole sidebar: workspace picker, the fixed views (Inbox / My issues / Reviews), the
 * team's milestone/epic/ticket tree, Archived, the "This machine" project list and New issue —
 * always in that order, so the renderer (F13.11) never has to branch on section identity to
 * decide where it goes. The tail is fixed as `archived → machine → newIssue` (F13.10/F13.11):
 * New issue is always last, pinned at the bottom.
 */
export function buildSidebar(input: SidebarInput): SidebarSection[] {
  const isMilestoneArchived = input.isMilestoneArchived ?? (() => false);

  const views: SidebarView[] = [
    { id: 'inbox', label: 'Inbox', count: input.attentionCount },
    { id: 'myIssues', label: 'My issues' },
  ];
  if (input.reviewsEnabled) {
    views.push(
      input.reviewsCount === undefined
        ? { id: 'reviews', label: 'Reviews' }
        : { id: 'reviews', label: 'Reviews', count: input.reviewsCount },
    );
  }

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
      tree: buildMilestoneTree(input.milestones, input.tickets, isMilestoneArchived, input.folds),
    },
    { kind: 'archived', count: input.archivedCount },
    { kind: 'machine', label: 'This machine', location: 'local', projects: input.projects },
    { kind: 'newIssue', shortcut: 'C' },
  ];
}
