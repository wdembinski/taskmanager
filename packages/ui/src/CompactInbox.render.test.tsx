/**
 * The phone Inbox's rich cards (v9-4/v9-5): what `CompactInbox` renders for each item. Static
 * markup for the card itself, and a "tap" that finds a rendered action's own `onClick` in the
 * hook-free `InboxCardBody` tree and calls it, routed through the same `runInboxCardAction` +
 * `invokeAttentionAnswer` path `CompactInbox` wires — no DOM needed.
 */
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { AttentionItem } from '@tm/shared/attention';
import { invokeAttentionAnswer } from './attentionAnswer';
import { runInboxCardAction } from './inboxCard';
import { InboxCard, InboxCardBody, type InboxCardClasses } from './InboxCardView';
import type { Transport } from './transport';

const NOW = new Date(2026, 9, 26, 12, 0, 0).getTime();
const minutesAgo = (m: number): number => NOW - m * 60_000;

const BASE = {
  runId: 'r',
  projectId: 'p',
  options: [] as string[],
  toolName: null,
  reason: null,
};

const QUESTION: AttentionItem = {
  ...BASE,
  id: 'q',
  taskId: 't-q',
  taskTitle: 'In-app code review',
  kind: 'agent-question',
  prompt: 'Which base branch should the review compare against?',
  createdAt: minutesAgo(2),
  questions: [
    {
      header: 'Base',
      question: 'Which base branch should the review compare against?',
      multiSelect: false,
      options: [{ label: 'development' }, { label: 'main' }],
    },
  ],
};

const PLAN: AttentionItem = {
  ...BASE,
  id: 'plan',
  taskId: 't-plan',
  taskTitle: 'Desktop replica',
  kind: 'plan-approval',
  prompt: 'Approve the plan?',
  createdAt: minutesAgo(14),
  plan: '# Plan\n\n1. One',
  steps: ['One', 'Two', 'Three', 'Four'],
};

const FAILED: AttentionItem = {
  ...BASE,
  id: 'failed',
  taskId: 't-failed',
  taskTitle: 'Flaky upload test',
  kind: 'task-failed',
  prompt: 'The run failed.',
  options: ['Retry', 'Retry fresh (discard branch)', 'AI fix & retry'],
  createdAt: minutesAgo(60),
};

function markup(item: AttentionItem, taskKey: string | null = null): string {
  return renderToStaticMarkup(
    <InboxCard
      item={item}
      taskKey={taskKey}
      now={NOW}
      busy={false}
      onOpen={() => {}}
      onAction={() => Promise.resolve()}
    />,
  );
}

/** Every element in `node`'s tree, children first-to-last — no component is rendered. */
function elements(node: ReactNode): ReactElement[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement(node)) return [];
  const props = node.props as { children?: ReactNode };
  return [node, ...elements(props.children)];
}

/** The rendered action button labelled `label`, tapped. */
function tap(tree: ReactNode, label: string): void {
  const button = elements(tree).find(
    (el) =>
      (el.props as { children?: ReactNode }).children === label &&
      typeof (el.props as { onClick?: unknown }).onClick === 'function',
  );
  if (!button) throw new Error(`no "${label}" action`);
  (button.props as { onClick: () => void }).onClick();
}

const CLASSES = new Proxy({}, { get: (_, k) => String(k) }) as InboxCardClasses;

describe('InboxCard', () => {
  it('draws no KindBadge pill — the kind is a word on a dotted line', () => {
    for (const item of [QUESTION, PLAN, FAILED]) {
      const html = markup(item);
      expect(html).not.toContain('fui-Badge');
      for (const pill of ['>choose<', '>plan<', '>task failed<', '>question<']) {
        expect(html).not.toContain(pill);
      }
    }
    expect(markup(QUESTION)).toContain('>Question<');
    expect(markup(PLAN)).toContain('>Plan to approve<');
    expect(markup(FAILED)).toContain('>Task failed<');
  });

  it('shows the age, the mono key + task title, and the question as the title', () => {
    const html = markup(QUESTION, 'TM-87');
    expect(html).toContain('>2m<');
    expect(html).toContain('>TM-87<');
    expect(html).toContain('>In-app code review<');
    expect(html).toContain('>Which base branch should the review compare against?<');
    expect(html.indexOf('>Question<')).toBeLessThan(html.indexOf('>TM-87<'));
    expect(html.indexOf('>TM-87<')).toBeLessThan(html.indexOf('>Which base branch'));
  });

  it('prints the title alone when the board has no key for the task', () => {
    expect(markup(QUESTION)).not.toContain('TM-');
  });

  it('offers a question card its options as buttons, and Other…', () => {
    const html = markup(QUESTION);
    expect(html).toMatch(/<button[^>]*>development<\/button>/);
    expect(html).toMatch(/<button[^>]*>main<\/button>/);
    expect(html).toMatch(/<button[^>]*>Other…<\/button>/);
  });

  it('tapping an option invokes attention:answer with that option', async () => {
    const invoke = vi.fn((..._args: unknown[]) => Promise.resolve(undefined));
    const transport = { invoke } as unknown as Transport;
    const open = vi.fn();
    const done: Promise<void>[] = [];
    const tree = InboxCardBody({
      item: QUESTION,
      taskKey: 'TM-87',
      now: NOW,
      busy: false,
      error: null,
      onOpen: () => open(QUESTION.id),
      onAction: (action) => {
        done.push(
          runInboxCardAction(QUESTION, action, {
            answer: (id, a) => invokeAttentionAnswer(transport, id, a),
            open,
          }),
        );
      },
      classes: CLASSES,
    });
    tap(tree, 'main');
    await Promise.all(done);
    expect(invoke).toHaveBeenCalledWith('attention:answer', 'q', {
      decision: 'answers',
      selections: [['main']],
      freeText: [null],
    });
    expect(open).not.toHaveBeenCalled();

    tap(tree, 'Other…');
    expect(open).toHaveBeenCalledWith('q');
  });

  it('offers a plan card Approve and Read plan, under its step summary', () => {
    const html = markup(PLAN, 'TM-192');
    expect(html).toContain('>4 steps<');
    expect(html).toMatch(/<button[^>]*>Approve<\/button>/);
    expect(html).toMatch(/<button[^>]*>Read plan<\/button>/);
  });

  it('offers a failed card Retry and Open', () => {
    const html = markup(FAILED);
    expect(html).toMatch(/<button[^>]*>Retry<\/button>/);
    expect(html).toMatch(/<button[^>]*>Open<\/button>/);
    expect(html).not.toContain('Retry fresh');
  });

  it('disables every action while its answer is in flight', () => {
    const html = renderToStaticMarkup(
      <InboxCard
        item={PLAN}
        taskKey={null}
        now={NOW}
        busy
        onOpen={() => {}}
        onAction={() => Promise.resolve()}
      />,
    );
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Approve<\/button>/);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Read plan<\/button>/);
  });
});
