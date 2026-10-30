/**
 * Apply ONE recommendation of a stored "Review open tickets" report (`@shared/boardReview`)
 * — the Apply button's whole body. Nothing in a report is ever applied on its own; each
 * button calls this once, and the outcome is stored on the review so it is never applied
 * twice.
 *
 * What each verdict does:
 * - **REWRITE** — the ticket's title and description are replaced. Native tickets only: a
 *   JIRA/GitHub card's text belongs to its tracker.
 * - **SPLIT** — one new ticket per part, under the original's epic and milestone, chained
 *   part to part by after-merge arrows (N parts, N-1 arrows); the original moves into Dropped.
 * - **MERGE** — the ticket moves into Dropped, with a comment on it and on the one that
 *   absorbs it.
 * - **DROP** — the ticket moves into Dropped, with the reason as a comment.
 * - **REORDER** — an after-merge arrow from each ticket it must run after. Any card.
 * - **DECIDE** — the ticket is marked Needs decision with the question. Any card.
 *
 * "Dropped" is an ARCHIVED native epic of the project — found among the project's archived
 * epics, or created and archived on first use. Archiving an epic hides its children without
 * writing to them, so a dropped ticket leaves the board at once and comes back with the
 * epic's Restore. An ACTIVE epic that happens to be called Dropped is a real epic and is never
 * reused. `store.archiveTask` — the board-removal archive `pruneArchivedBefore` deletes from —
 * is never called: a dropped ticket's own `archivedAt` stays null.
 */
import {
  boardReviewRecommendations,
  type BoardReviewRecord,
  type BoardReviewTicket,
} from '@shared/boardReview';
import type { Task } from '@shared/model';
import { LINK_REFUSAL_MESSAGE, type LinkGate, type LinkResult } from '@shared/taskChain';
import { isEpic, isNativeTicket } from '@shared/tickets';
import type { ArchiveResult, ArchiveTarget } from '@shared/trackerArchive';
import type { Store } from './store';

/** The store reads and writes applying needs — a slice, so tests can fake it. */
export type BoardReviewApplyStore = Pick<
  Store,
  | 'getBoardReview'
  | 'setBoardReviewApplied'
  | 'getTask'
  | 'getBoardTasks'
  | 'updateTask'
  | 'createTicket'
  | 'listArchived'
>;

export interface BoardReviewApplyDeps {
  store: BoardReviewApplyStore;
  /** `Scheduler.setDecision` — `task:setDecision`'s body. */
  setDecision(taskId: string, question: string | null): unknown;
  /** `drawChainLink` — `chain:link`'s body, refusals and all. */
  drawLink(fromTaskId: string, toTaskId: string, gate?: LinkGate): LinkResult;
  /** `archiveHandlers['archive:apply']`, only ever called with an epic target. */
  archiveEpic(target: ArchiveTarget): Promise<ArchiveResult>;
  /** A local comment on the card's timeline (`task:addComment`). */
  addComment(taskId: string, body: string): void;
  now(): number;
  /** Push `project:boardReviewChanged`. */
  emitReview(projectId: string, review: BoardReviewRecord): void;
  /** `pushTaskDelta(projectId)` — push the board's changed cards as `tasks:changed`. */
  pushTasks(projectId: string): void;
}

export interface BoardReviewApplyResult {
  ok: boolean;
  message: string;
}

/** The title the archived epic holding every dropped ticket goes by. */
export const DROPPED_EPIC_TITLE = 'Dropped';

const DROPPED_EPIC_DESCRIPTION =
  'Tickets a board review dropped, merged or split. Archived, so they are off the board; ' +
  'restore this epic to bring them back.';

/** Stop applying with a sentence for the human; the caller turns it into `{ok: false}`. */
function refuse(message: string): never {
  throw new Error(message);
}

function quoted(text: string): string {
  return `"${text}"`;
}

/** How a card is named in messages and comments: its key, else its title. */
function nameOf(task: Task): string {
  return task.ticketKey ?? task.externalKey ?? quoted(task.title);
}

function isDroppedEpic(task: Task): boolean {
  return isEpic(task) && task.title.trim().toLowerCase() === DROPPED_EPIC_TITLE.toLowerCase();
}

export async function applyBoardReviewItem(
  deps: BoardReviewApplyDeps,
  reviewId: string,
  recId: string,
): Promise<BoardReviewApplyResult> {
  const { store } = deps;
  const review = store.getBoardReview(reviewId);
  if (!review) return { ok: false, message: 'That review no longer exists.' };
  if (!review.report) return { ok: false, message: 'That review has no report to apply.' };
  if (!boardReviewRecommendations(review.report).some((r) => r.id === recId)) {
    return { ok: false, message: `The review has no recommendation for ${recId}.` };
  }
  if (review.applied[recId]?.ok) {
    return { ok: false, message: `${recId} was already applied.` };
  }
  const item = review.report.tickets.find((t) => t.ref === recId)!;

  /** A live card, or null — a row taken off the board counts as gone. */
  const live = (id: string): Task | null => {
    const task = store.getTask(id);
    return task && task.archivedAt == null ? task : null;
  };

  /** A ref the report used, back to its card: the report's own rows first, then by key. */
  const resolve = (ref: string): Task | null => {
    const reviewed = review.report!.tickets.find((t) => t.ref === ref);
    if (reviewed) return live(reviewed.taskId);
    const byKey = store
      .getBoardTasks(review.projectId)
      .find((t) => t.ticketKey === ref || t.externalKey === ref);
    return byKey ? live(byKey.id) : null;
  };

  /** The archived Dropped epic, created and archived the first time it is needed. */
  const droppedEpic = async (): Promise<Task> => {
    const archived = store.listArchived(review.projectId).epics.find(isDroppedEpic);
    if (archived) return archived;
    const epic = store.createTicket(review.projectId, {
      title: DROPPED_EPIC_TITLE,
      description: DROPPED_EPIC_DESCRIPTION,
      issueType: 'epic',
    });
    if (!epic) refuse('Could not create the Dropped epic — the project files no tickets.');
    const result = await deps.archiveEpic({ kind: 'epic', id: epic.id });
    if (!result.ok) refuse(`Could not archive the Dropped epic: ${result.message}`);
    return epic;
  };

  /** Move a ticket under Dropped — the board hides it through the archived epic. */
  const moveIntoDropped = (task: Task, epic: Task): void => {
    if (!store.updateTask(task.id, { epicTaskId: epic.id })) {
      refuse(`Could not move ${nameOf(task)} into Dropped.`);
    }
  };

  /** The checks every verdict that moves a ticket into Dropped makes first. */
  const assertDroppable = (task: Task, verb: string): void => {
    if (!isNativeTicket(task)) {
      refuse(`${nameOf(task)} is not a native ticket — ${verb} it in its own tracker.`);
    }
    if (isEpic(task)) refuse(`${nameOf(task)} is an epic — an epic cannot move into Dropped.`);
  };

  const act = async (task: Task, t: BoardReviewTicket): Promise<BoardReviewApplyResult> => {
    const why = t.reason ? ` ${t.reason}` : '';
    switch (t.verdict) {
      case 'REWRITE': {
        if (!isNativeTicket(task)) {
          refuse(`${nameOf(task)} is not a native ticket — rewrite it in its own tracker.`);
        }
        const rewrite = t.rewrite!;
        store.updateTask(task.id, {
          title: rewrite.title,
          externalDescription: rewrite.description,
        });
        return { ok: true, message: `Rewrote ${nameOf(task)} as ${quoted(rewrite.title)}.` };
      }
      case 'SPLIT': {
        assertDroppable(task, 'split');
        const epic = await droppedEpic();
        const inherited = {
          epicTaskId: task.epicTaskId ?? null,
          milestoneId: task.milestoneId ?? null,
          issueType: task.issueType ?? 'task',
        };
        const parts: Task[] = [];
        for (const part of t.parts!) {
          const created = store.createTicket(task.projectId, {
            title: part.title,
            description: part.description,
            ...inherited,
          });
          if (!created) refuse(`Could not create ${quoted(part.title)}.`);
          parts.push(created);
        }
        const refused: string[] = [];
        for (let i = 1; i < parts.length; i++) {
          const result = deps.drawLink(parts[i - 1].id, parts[i].id, 'after-merge');
          if (result.status === 'refused') refused.push(LINK_REFUSAL_MESSAGE[result.reason]);
        }
        moveIntoDropped(task, epic);
        const names = parts.map(nameOf).join(', ');
        deps.addComment(task.id, `Split by the board review into ${names}.${why}`);
        const message = `Split ${nameOf(task)} into ${names}; the original moved into Dropped.`;
        return refused.length === 0
          ? { ok: true, message }
          : { ok: false, message: `${message} Not every arrow was drawn: ${refused.join('; ')}.` };
      }
      case 'MERGE': {
        assertDroppable(task, 'merge');
        const target = resolve(t.mergeInto!);
        if (!target) refuse(`${t.mergeInto} is no longer on the board.`);
        const epic = await droppedEpic();
        moveIntoDropped(task, epic);
        deps.addComment(task.id, `Merged by the board review into ${nameOf(target)}.${why}`);
        deps.addComment(target.id, `Absorbs ${nameOf(task)}, merged in by the board review.`);
        return {
          ok: true,
          message: `Merged ${nameOf(task)} into ${nameOf(target)}; it moved into Dropped.`,
        };
      }
      case 'DROP': {
        assertDroppable(task, 'drop');
        const epic = await droppedEpic();
        moveIntoDropped(task, epic);
        deps.addComment(task.id, `Dropped by the board review.${why}`);
        return { ok: true, message: `Moved ${nameOf(task)} into Dropped.` };
      }
      case 'REORDER': {
        const drawn: string[] = [];
        const refused: string[] = [];
        for (const ref of t.after!) {
          const before = resolve(ref);
          if (!before) {
            refused.push(`${ref}: no longer on the board`);
            continue;
          }
          const result = deps.drawLink(before.id, task.id, 'after-merge');
          if (result.status === 'ok' || result.reason === 'duplicate') drawn.push(ref);
          else refused.push(`${ref}: ${LINK_REFUSAL_MESSAGE[result.reason]}`);
        }
        const head = drawn.length
          ? `${nameOf(task)} now runs after ${drawn.join(', ')}.`
          : `No arrow was drawn into ${nameOf(task)}.`;
        return refused.length === 0
          ? { ok: true, message: head }
          : { ok: false, message: `${head} Refused: ${refused.join('; ')}.` };
      }
      case 'DECIDE':
        deps.setDecision(task.id, t.question!);
        return { ok: true, message: `${nameOf(task)} now needs a decision: ${t.question}` };
      case 'OK':
        return { ok: false, message: `${t.ref} needs no change.` };
    }
  };

  let outcome: BoardReviewApplyResult;
  const task = live(item.taskId);
  if (!task) {
    outcome = { ok: false, message: `${recId} is no longer on the board.` };
  } else {
    try {
      outcome = await act(task, item);
    } catch (err) {
      outcome = { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  }

  const record = store.setBoardReviewApplied(reviewId, recId, { at: deps.now(), ...outcome });
  if (record) deps.emitReview(review.projectId, record);
  deps.pushTasks(review.projectId);
  return outcome;
}
