/**
 * Chat availability for a card's composer (Phase 12, phase 3).
 *
 * The scheduler is the authority on whether a typed message can be delivered — it
 * refuses with a `ChatRefusal` rather than throwing. This module is the *renderer's*
 * copy of the same rules, used only to disable the button and explain itself before the
 * round trip; anything it lets through and the scheduler then refuses is turned into a
 * message by `REFUSAL_HINT`, so the two can never contradict each other in a way the
 * human sees as a lie.
 *
 * It reuses the pure helpers the scheduler itself calls (`chatTarget`, `chainInFlight`)
 * rather than re-deriving either rule.
 */
import type { AttentionItem } from '@shared/attention';
import { chainInFlight, chatTarget, isAgentAssigned, MAX_PLAN_STEPS } from '@shared/board';
import type { ChatRefusal, Task } from '@shared/model';

export interface ChatAvailability {
  /** The task that would receive the message: a card's live step, or the card itself. */
  target: Task;
  /** Whether the card can be chatted with at all (an undelegated card cannot). */
  offered: boolean;
  /** False when sending cannot work — `hint` says why. */
  can: boolean;
  /** The button's tooltip: why it is disabled, or what pressing it will do. */
  hint: string;
  /** True while the target holds a live session, so the message arrives at once. */
  live: boolean;
}

/**
 * What the composer should do for `task`, given its chain and the inbox item (if any)
 * parked on the chat target.
 */
export function chatAvailability(
  task: Task,
  subtasks: Task[],
  pending: AttentionItem | null,
): ChatAvailability {
  const target = chatTarget(task, subtasks);
  const live = target.status === 'running' || target.status === 'waiting-input';
  const base = { target, offered: isAgentAssigned(task), live };

  if (live) {
    // Blocked on approve/deny for one specific call: prose cannot answer it, and the
    // text would queue behind a decision that may never come.
    if (pending?.kind === 'permission' || pending?.kind === 'plan-approval') {
      return {
        ...base,
        can: false,
        hint: 'Answer the agent’s pending request above first — a message cannot approve a tool call.',
      };
    }
    return {
      ...base,
      can: true,
      hint: pending
        ? 'Sends your message as the answer to the agent’s question.'
        : 'Sends your message straight into the running session.',
    };
  }

  if (target.status === 'blocked-by-limit') {
    return { ...base, can: false, hint: REFUSAL_HINT.limit };
  }
  if (!target.sessionId) {
    return { ...base, can: false, hint: REFUSAL_HINT['never-ran'] };
  }
  // A card that handed over to an approved plan holds only its planner's session.
  if (!target.parentTaskId && chainInFlight(subtasks)) {
    return { ...base, can: false, hint: REFUSAL_HINT['chain-busy'] };
  }
  return {
    ...base,
    can: true,
    hint: 'Resumes the last session with your message — this starts a new run, so it is not instant.',
  };
}

/** A refusal from `task:chat`, as something to show under the composer. */
export const REFUSAL_HINT: Record<ChatRefusal, string> = {
  'awaiting-decision':
    'The agent is waiting on an approve/deny — answer the request above, then chat.',
  'not-running': 'The agent is not running and cannot be resumed right now.',
  'never-ran': 'This card has never run — assign it to an agent to start a conversation.',
  'chain-busy':
    'This card’s plan is still running — open the step that is working and talk to it there.',
  limit: 'A usage limit is holding all agent work; this card resumes when the limit resets.',
  'not-a-card': 'A step cannot be planned — re-plan the card it belongs to instead.',
  'chain-full': `This card already carries ${MAX_PLAN_STEPS} steps — the most one card can hold.`,
  'unknown-task': 'This card no longer exists.',
  'empty-message': 'Type a message first.',
};

/** Whether the "Plan more steps…" button is offered, and what its tooltip says. */
export interface ReplanAvailability {
  /** Whether to render the button at all (an undelegated card has no agent to plan). */
  offered: boolean;
  /** False when pressing it cannot work — `hint` says why. */
  can: boolean;
  /** The tooltip: why it is disabled, or what pressing it will do. */
  hint: string;
}

/**
 * What the "Plan more steps…" button should do for `task`, given its chain.
 *
 * The renderer's copy of `Scheduler.replanCard`'s guards, in the same spirit as
 * {@link chatAvailability}: it exists to disable the button and explain itself before the
 * round trip, never to decide anything. Anything it lets through that the scheduler then
 * refuses becomes a `REFUSAL_HINT` message, so the two cannot contradict each other.
 */
export function canReplan(task: Task, subtasks: Task[]): ReplanAvailability {
  const offered = isAgentAssigned(task) && !task.parentTaskId;
  const base = { offered };
  if (task.status === 'blocked-by-limit') return { ...base, can: false, hint: REFUSAL_HINT.limit };
  // A live turn on the card would be stopped to make room for the planner; better to let it
  // finish than to cut off an answer the human is still reading.
  if (task.status === 'running' || task.status === 'waiting-input') {
    return { ...base, can: false, hint: 'Wait for the current turn to finish, then plan again.' };
  }
  if (chainInFlight(subtasks)) return { ...base, can: false, hint: REFUSAL_HINT['chain-busy'] };
  if (subtasks.length >= MAX_PLAN_STEPS) {
    return { ...base, can: false, hint: REFUSAL_HINT['chain-full'] };
  }
  return {
    ...base,
    can: true,
    hint:
      subtasks.length > 0
        ? 'Asks the agent to plan the next round of steps — you approve them before any run.'
        : 'Asks the agent to plan this card into steps — you approve them before any run.',
  };
}
