/**
 * The pure half of the Tickets screen's peek/full-screen behaviour (F13.13) — the reducer
 * `issueViewReduce` and the breadcrumb it feeds, kept apart from the screen so Space/Enter/Esc
 * and the deletion notice can be proven without a DOM. The same split `issueRowParts.ts` and
 * `taskDetailHost.ts` already keep.
 *
 * See `docs/14-design-system.md#peek-vs-full-screen` for the design this implements (F13.13);
 * the transitions below follow that section's own wording, not a re-derivation.
 */
import type { Milestone, Project, Task } from '@tm/shared/model';

export type IssueViewLayout = 'closed' | 'peek' | 'full';

export interface IssueViewState {
  selectedId: string | null;
  layout: IssueViewLayout;
  /** The selected ticket's `ticketKey ?? title`, used in the deletion message. */
  label: string | null;
  /** Whether `selectedId` has appeared in a `tickets` snapshot at least once — see `tickets`
   *  below for why that is what tells a closed selection from a deleted one. */
  seen: boolean;
  notice: string | null;
}

export const INITIAL_ISSUE_VIEW: IssueViewState = {
  selectedId: null,
  layout: 'closed',
  label: null,
  seen: false,
  notice: null,
};

/** The one field a `tickets` snapshot needs per row to tell "still here" from "gone" and to
 *  refresh `label`. */
export type IssueViewTicket = Pick<Task, 'id' | 'ticketKey' | 'title'>;

export type IssueViewAction =
  | { type: 'select'; id: string; label: string }
  | { type: 'open'; id: string; label: string }
  | { type: 'space' }
  | { type: 'enter' }
  | { type: 'escape' }
  | { type: 'expand' }
  | { type: 'close' }
  | { type: 'tickets'; tickets: readonly IssueViewTicket[] }
  | { type: 'dismissNotice' }
  | { type: 'reset' };

/**
 * One keystroke/row-event's effect on the issue view. Each case below is this module's own
 * record of the F13.13 design entry's wording — read that entry before changing a transition,
 * not this comment.
 */
export function issueViewReduce(state: IssueViewState, action: IssueViewAction): IssueViewState {
  switch (action.type) {
    case 'select': {
      // `closed` becomes `peek` so a click still opens the panel as it does today; `peek` and
      // `full` stay as they are, so following a sub-issue link while in `full` keeps you there.
      const layout = state.layout === 'closed' ? 'peek' : state.layout;
      return { selectedId: action.id, layout, label: action.label, seen: false, notice: null };
    }

    case 'open':
      return {
        selectedId: action.id,
        layout: 'full',
        label: action.label,
        seen: false,
        notice: null,
      };

    case 'space': {
      if (!state.selectedId || state.layout === 'full') return state;
      return { ...state, layout: state.layout === 'peek' ? 'closed' : 'peek' };
    }

    case 'enter': {
      if (!state.selectedId || state.layout === 'full') return state;
      return { ...state, layout: 'full' };
    }

    case 'escape': {
      if (state.layout === 'full') return { ...state, layout: 'peek' };
      if (state.layout === 'peek') return { ...state, layout: 'closed' };
      if (!state.selectedId) return state;
      return { ...state, selectedId: null, label: null, seen: false };
    }

    case 'expand': {
      if (!state.selectedId) return state;
      return { ...state, layout: 'full' };
    }

    case 'close':
      return { ...state, layout: 'closed' };

    case 'tickets': {
      if (!state.selectedId) return state;
      const stillThere = action.tickets.find((t) => t.id === state.selectedId);
      if (stillThere) {
        return { ...state, seen: true, label: stillThere.ticketKey ?? stillThere.title };
      }
      // Missing from this snapshot. `seen` is what tells the two reasons apart: once the
      // selection has actually appeared in this project's list, its disappearance means the
      // ticket was deleted. Until then it is a cross-project link opened from the panel, whose
      // target never was and may never be in THIS project's list — not a deletion.
      if (!state.seen) return state;
      return {
        selectedId: null,
        layout: 'closed',
        label: null,
        seen: false,
        notice: `${state.label ?? state.selectedId} was deleted, so its panel closed.`,
      };
    }

    case 'dismissNotice':
      return { ...state, notice: null };

    case 'reset':
      return { ...INITIAL_ISSUE_VIEW };
  }
}

/**
 * The full-screen breadcrumb: project name, then the milestone name when `task.milestoneId`
 * resolves, then the epic title when `task.epicTaskId` resolves. A link that does not resolve
 * is dropped from the array, never rendered as a placeholder like "None" — matches the
 * full-screen mockup's `Task Manager › M4 Reach › F4 Linear integration` row.
 */
export function issueBreadcrumb(
  task: Pick<Task, 'milestoneId' | 'epicTaskId'>,
  project: Pick<Project, 'name'> | null,
  milestones: readonly Pick<Milestone, 'id' | 'name'>[],
  ticketsById: ReadonlyMap<string, Pick<Task, 'title'>>,
): string[] {
  const crumbs: string[] = [];
  if (project) crumbs.push(project.name);

  if (task.milestoneId) {
    const milestone = milestones.find((m) => m.id === task.milestoneId);
    if (milestone) crumbs.push(milestone.name);
  }

  if (task.epicTaskId) {
    const epic = ticketsById.get(task.epicTaskId);
    if (epic) crumbs.push(epic.title);
  }

  return crumbs;
}

/**
 * The peek header's epic, after v9-1's `TM-71   F4 Linear integration`: the linked epic's own
 * title when `task.epicTaskId` resolves, else a mirrored card's tracker epic by name
 * (`externalEpicName`) — the same fallback the board's epic chip uses (`cardParts.ts`).
 */
export function peekEpic(
  task: Pick<Task, 'epicTaskId' | 'externalEpicName'>,
  ticketsById: ReadonlyMap<string, Pick<Task, 'title'>>,
): string | undefined {
  const linked = task.epicTaskId ? ticketsById.get(task.epicTaskId)?.title : undefined;
  return linked ?? task.externalEpicName ?? undefined;
}

/** A structural subset of `EventTarget`/`HTMLElement` so tests can pass plain objects without
 *  jsdom — the same shape `palette/shortcut.ts`'s `EditableTargetLike` uses, plus `closest`. */
export interface KeyTargetLike {
  tagName?: string;
  isContentEditable?: boolean;
  closest?: (selectors: string) => unknown;
}

/**
 * Whether the Projects root's Space/Esc handler must leave `target`'s own keystroke alone
 * rather than dispatching: a literal editable field (`input`, `textarea`, `select`, or
 * anything `contentEditable` — so a space typed into the search box or the panel's reply
 * composer still works), or anything inside a Fluent dialog, menu or listbox portal — needed
 * because React's events bubble out of those portals rather than following the DOM tree the
 * root listens on.
 */
export function isKeyTargetEditable(target: KeyTargetLike | null | undefined): boolean {
  if (!target) return false;
  if (target.isContentEditable) return true;
  if (target.tagName && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return true;
  return Boolean(target.closest?.('[role="dialog"], [role="menu"], [role="listbox"]'));
}
