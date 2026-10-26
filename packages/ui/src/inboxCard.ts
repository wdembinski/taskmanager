/**
 * The pure half of the phone Inbox's rich card (`InboxCard.tsx`, v9-4/v9-5): the kind word on
 * the dotted kind line, the card's own title (the question, or a plan's summary), and which
 * inline actions sit at its foot.
 *
 * An inline action either answers the item outright — the same `AttentionAnswer` the full
 * detail view would send for the same tap — or opens that detail view. Only the unambiguous
 * cases answer inline:
 *
 * - a single, single-select `agent-question` (one tap is a whole answer, exactly as
 *   `answerDraft.ts`'s `tapOption` auto-sends it), plus "Other…" for anything else;
 * - a sentinel `question` that offered discrete options;
 * - a `plan-approval`'s Approve, beside "Read plan";
 * - a `task-failed` item's plain "Retry", beside "Open".
 *
 * An expired question never answers inline: past its deadline the detail view turns the answer
 * into a chat message (`submission`'s `chat` arm), and a one-tap answer here would skip that.
 */
import type { AttentionAnswer, AttentionItem } from '@tm/shared/attention';

/** The word on a card's kind line — sentence case, never a pill. */
export function inboxKindWord(kind: AttentionItem['kind']): string {
  switch (kind) {
    case 'agent-question':
    case 'question':
      return 'Question';
    case 'plan-approval':
      return 'Plan to approve';
    case 'permission':
      return 'Permission';
    case 'task-failed':
      return 'Task failed';
    case 'merge-conflict':
      return 'Merge conflict';
    case 'proposal':
      return 'Proposal';
  }
}

/** Which colour the kind line's dot takes: a failure reads as danger, every other ask as attention. */
export function inboxKindTone(kind: AttentionItem['kind']): 'attention' | 'danger' {
  return kind === 'task-failed' || kind === 'merge-conflict' ? 'danger' : 'attention';
}

/** `count` steps, singular when it is one. */
function stepsPhrase(count: number): string {
  return `${count} ${count === 1 ? 'step' : 'steps'}`;
}

/**
 * The card's own title, under the key + task title: the question an `agent-question` asks
 * (its first, when it asks several), a plan's step count, otherwise the item's `prompt`.
 */
export function inboxCardTitle(item: AttentionItem): string {
  if (item.kind === 'agent-question') {
    const first = item.questions?.[0]?.question.trim();
    if (first) return first;
  }
  if (item.kind === 'plan-approval' && item.steps && item.steps.length > 0) {
    return stepsPhrase(item.steps.length);
  }
  return item.prompt;
}

/** The literal action label the engine offers a failed task for a plain retry (`FAILURE_ACTION.retry`). */
export const RETRY_ACTION = 'Retry';

export type InboxCardAction =
  | {
      kind: 'answer';
      label: string;
      answer: AttentionAnswer;
      /** The filled, brand-coloured button — at most one per card. */
      primary: boolean;
    }
  /** Opens the full-screen detail view; `link` draws it as a text link rather than a button. */
  | { kind: 'open'; label: string; link: boolean };

/** The inline actions at a card's foot, left to right. Never empty: "Open" is the fallback. */
export function inboxCardActions(item: AttentionItem, expired: boolean): InboxCardAction[] {
  switch (item.kind) {
    case 'agent-question': {
      const qs = item.questions ?? [];
      const only = qs.length === 1 ? qs[0] : undefined;
      if (expired || !only || only.multiSelect || only.options.length === 0) {
        return [{ kind: 'open', label: 'Answer', link: false }];
      }
      return [
        ...only.options.map((o, i): InboxCardAction => ({
          kind: 'answer',
          label: o.label,
          answer: { decision: 'answers', selections: [[o.label]], freeText: [null] },
          primary: i === 0,
        })),
        { kind: 'open', label: 'Other…', link: true },
      ];
    }
    case 'question': {
      if (expired || item.options.length === 0) {
        return [{ kind: 'open', label: 'Reply', link: false }];
      }
      return [
        ...item.options.map((text, i): InboxCardAction => ({
          kind: 'answer',
          label: text,
          answer: { decision: 'reply', text },
          primary: i === 0,
        })),
        { kind: 'open', label: 'Other…', link: true },
      ];
    }
    case 'plan-approval':
      return [
        { kind: 'answer', label: 'Approve', answer: { decision: 'approve' }, primary: true },
        { kind: 'open', label: 'Read plan', link: true },
      ];
    case 'task-failed':
      return item.options.includes(RETRY_ACTION)
        ? [
            {
              kind: 'answer',
              label: RETRY_ACTION,
              answer: { decision: 'reply', text: RETRY_ACTION },
              primary: true,
            },
            { kind: 'open', label: 'Open', link: true },
          ]
        : [{ kind: 'open', label: 'Open', link: false }];
    case 'permission':
      return [{ kind: 'open', label: 'Review', link: false }];
    case 'merge-conflict':
    case 'proposal':
      return [{ kind: 'open', label: 'Open', link: false }];
  }
}

/** A task's display key, the same `ticketKey ?? externalKey` the board and issue rows print. */
export function taskDisplayKey(task: {
  ticketKey?: string | null;
  externalKey?: string | null;
}): string | null {
  return task.ticketKey ?? task.externalKey ?? null;
}

/**
 * Runs a tapped action through the host's own two paths — the same `answer` the detail view
 * uses, and the same "open this item" the card's header does — so a card never grows a third.
 */
export function runInboxCardAction(
  item: AttentionItem,
  action: InboxCardAction,
  host: { answer: (id: string, a: AttentionAnswer) => Promise<void>; open: (id: string) => void },
): Promise<void> {
  if (action.kind === 'open') {
    host.open(item.id);
    return Promise.resolve();
  }
  return host.answer(item.id, action.answer);
}
