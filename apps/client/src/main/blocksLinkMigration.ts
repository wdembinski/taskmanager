/**
 * Turning the old `blocks` ticket links into order arrows, now that the arrows are the one
 * place a dependency lives.
 *
 * Two systems used to say "A has to happen before B". An order arrow (`task_links`) holds a
 * card: the engine will not start B until A's gate is met, and the board's chips say so. A
 * `blocks` ticket link (`ticket_links`) said the same thing in the Links section and held
 * nothing — so a card could sit chained behind six others with "Blocked by" empty, or list a
 * blocker the engine had never heard of. The Links section now reads the arrows, and the
 * `ticketLink:add` handler turns a new `blocks` into an arrow, which leaves the rows written
 * before that rule: each is either made an arrow, or kept as the plain fact it was.
 *
 * Every `blocks` link `A blocks B`, oldest first, against an arrow set that GROWS as the plan
 * goes — each arrow planned is fed back into what {@link canLink} sees, so two `blocks` links
 * that form a loop between them convert the older one and demote the newer:
 *
 * - the arrow A→B already exists → the ticket link is deleted (`duplicate`);
 * - either end is gone → deleted (`missing`; the foreign keys make this near-impossible);
 * - A or B is a step of a plan → rewritten to `relates` (`step`) — steps already run in order;
 * - A→B would close a loop → rewritten to `relates` (`cycle`) — a loop can never start;
 * - A is in DONE but never landed (finished outside the app) → rewritten to `relates`
 *   (`unlanded`): an `after-merge` arrow from it could never be satisfied, and would hold B
 *   forever for a blocker everyone agrees is finished;
 * - otherwise an `after-merge` arrow A→B is inserted and the link deleted (`converted`).
 *
 * A rewrite to `relates` whose pair already carries a `relates` (either way round — it is
 * symmetric, and `ticket_links` is unique on `(from, to, type)`) deletes instead: the fact is
 * already stated, and an UPDATE onto the existing row would fail the unique index.
 *
 * Demoting rather than deleting is the point of `relates`: the human wrote that these two
 * tickets belong together, and that stays true even where it cannot become a hold.
 *
 * **It must run exactly once.** Afterwards an arrow is something a human can erase — and a
 * second pass would quietly redraw it from a `blocks` link if one ever reappeared (a sync, a
 * restore, a release that predates the redirect). The caller guards it with an `app_state`
 * key; the decision here is pure so it can be tested, which the store cannot be. Run twice
 * over its own output it plans nothing, which the tests hold too.
 */
import { columnForTask } from '@shared/board';
import type { Task, TicketLink } from '@shared/model';
import { canLink, type TaskLink } from '@shared/taskChain';

/** What became of one `blocks` link. See the header for each. */
export type BlocksOutcome = 'converted' | 'duplicate' | 'missing' | 'step' | 'cycle' | 'unlanded';

/** An arrow to insert — `after-merge`, the gate the `blocks` link always meant. */
export interface PlannedArrow {
  fromTaskId: string;
  toTaskId: string;
}

/** Everything the store applies, in one transaction. */
export interface BlocksMigrationPlan {
  insertArrows: PlannedArrow[];
  /** Ticket link ids to delete. */
  deleteTicketLinks: string[];
  /** Ticket link ids to rewrite to `relates`. */
  toRelates: string[];
  /** How many `blocks` links met each outcome — the `app_state` value the guard stores. */
  counts: Record<BlocksOutcome, number>;
}

/** The pair as a key the `relates` set can look up in either direction. */
function pairKey(a: string, b: string): string {
  return a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`;
}

/** Plan the one-shot conversion. See the header for the rules and their order. */
export function planBlocksMigration(
  ticketLinks: readonly TicketLink[],
  taskLinks: readonly TaskLink[],
  tasksById: ReadonlyMap<string, Task>,
): BlocksMigrationPlan {
  const plan: BlocksMigrationPlan = {
    insertArrows: [],
    deleteTicketLinks: [],
    toRelates: [],
    counts: { converted: 0, duplicate: 0, missing: 0, step: 0, cycle: 0, unlanded: 0 },
  };
  const arrows: TaskLink[] = [...taskLinks];
  const related = new Set(
    ticketLinks.filter((l) => l.type === 'relates').map((l) => pairKey(l.fromTaskId, l.toTaskId)),
  );
  const blocks = ticketLinks
    .filter((l) => l.type === 'blocks')
    .sort((a, b) => a.createdAt - b.createdAt);

  const demote = (link: TicketLink, outcome: BlocksOutcome) => {
    plan.counts[outcome]++;
    const key = pairKey(link.fromTaskId, link.toTaskId);
    if (related.has(key)) {
      plan.deleteTicketLinks.push(link.id);
      return;
    }
    related.add(key);
    plan.toRelates.push(link.id);
  };

  for (const link of blocks) {
    const from = tasksById.get(link.fromTaskId);
    const to = tasksById.get(link.toTaskId);
    const refusal = canLink(arrows, from, to);
    if (refusal === 'duplicate' || refusal === 'missing' || refusal === 'self') {
      // `self` cannot be stored (the store refuses it), but if one ever were, it holds
      // nothing and says nothing — the same answer as a missing end.
      plan.counts[refusal === 'duplicate' ? 'duplicate' : 'missing']++;
      plan.deleteTicketLinks.push(link.id);
      continue;
    }
    if (refusal === 'step' || refusal === 'cycle') {
      demote(link, refusal);
      continue;
    }
    if (from && columnForTask(from) === 'done' && from.landedAt == null) {
      demote(link, 'unlanded');
      continue;
    }
    plan.counts.converted++;
    plan.insertArrows.push({ fromTaskId: link.fromTaskId, toTaskId: link.toTaskId });
    plan.deleteTicketLinks.push(link.id);
    arrows.push({
      id: `planned:${link.id}`,
      fromTaskId: link.fromTaskId,
      toTaskId: link.toTaskId,
      gate: 'after-merge',
      createdAt: link.createdAt,
    });
  }
  return plan;
}
