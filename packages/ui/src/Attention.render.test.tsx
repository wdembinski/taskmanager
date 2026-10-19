/**
 * Proves `InboxItem` shows the files its own run produced alongside the question — not just
 * that `AttachmentGallery` renders in isolation. `renderToStaticMarkup`, same stub-transport
 * pattern as `TaskSteps.render.test.tsx`.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { AttentionItem } from '@tm/shared/attention';
import type { TaskAttachment } from '@tm/shared/attachments';
import { TransportProvider, type Transport } from './transport';
import { InboxItem } from './Attention';
import { MAKE_DECISION_LABEL } from './attentionAnswer';

const stubTransport: Transport = {
  invoke: () => new Promise(() => {}) as never,
  on: () => () => {},
  pathForFile: () => '',
};

function render(node: Parameters<typeof renderToStaticMarkup>[0]): string {
  return renderToStaticMarkup(
    <TransportProvider transport={stubTransport}>{node}</TransportProvider>,
  );
}

const item = (over: Partial<AttentionItem> & { id: string; taskId: string }): AttentionItem => ({
  runId: 'run-1',
  projectId: 'proj-1',
  taskTitle: 'A card',
  kind: 'question',
  prompt: 'what next?',
  options: [],
  toolName: null,
  reason: null,
  createdAt: 0,
  ...over,
});

function attachment(over: Partial<TaskAttachment> & { id: string; name: string }): TaskAttachment {
  return {
    taskId: 'task-1',
    fileName: over.name,
    mimeType: 'image/png',
    size: 0,
    createdAt: 0,
    ...over,
  };
}

describe('InboxItem', () => {
  it("shows the run's own files, with the question", () => {
    const html = render(
      <InboxItem
        item={item({ id: 'item-1', taskId: 'task-1' })}
        attachments={[
          attachment({ id: 'a1', name: 'board-light.png' }),
          attachment({ id: 'a2', name: 'board-light-mockup.png' }),
        ]}
        onAnswer={async () => {}}
        onDismiss={async () => {}}
      />,
    );

    expect(html).toContain('data-attachment-gallery');
    expect(html.match(/<img\b/g) ?? []).toHaveLength(2);
  });

  it('shows nothing extra for a question with no files', () => {
    const html = render(
      <InboxItem
        item={item({ id: 'item-1', taskId: 'task-1' })}
        onAnswer={async () => {}}
        onDismiss={async () => {}}
      />,
    );

    expect(html).not.toContain('data-attachment-gallery');
  });

  it('shows a passing plan-check verdict for a plan-approval item', () => {
    const html = render(
      <InboxItem
        item={item({
          id: 'item-1',
          taskId: 'task-1',
          kind: 'plan-approval',
          planCheck: {
            pass: true,
            checks: [
              {
                id: 'open-questions',
                label: 'No open question',
                pass: true,
                detail: 'no open questions',
              },
              {
                id: 'critical-files',
                label: 'Critical files listed, no overlap',
                pass: true,
                detail: '2 files listed, no overlap',
              },
              { id: 'step-count', label: 'At most 6 steps', pass: true, detail: '1 step' },
              {
                id: 'spec-read',
                label: 'Spec read',
                pass: true,
                detail: 'the ticket names no spec',
              },
              {
                id: 'acceptance',
                label: 'Every step has agent-checkable acceptance',
                pass: true,
                detail: '1 step checked',
              },
            ],
          },
        })}
        onAnswer={async () => {}}
        onDismiss={async () => {}}
      />,
    );

    expect(html).toContain('data-plan-check-pass="true"');
    expect(html).toContain('No open question');
    expect(html).toContain('Critical files listed, no overlap');
    expect(html).toContain('At most 6 steps');
    expect(html).toContain('Spec read');
    expect(html).toContain('Every step has agent-checkable acceptance');
  });

  it('shows the failing detail for a failing plan-check verdict', () => {
    const html = render(
      <InboxItem
        item={item({
          id: 'item-1',
          taskId: 'task-1',
          kind: 'plan-approval',
          planCheck: {
            pass: false,
            checks: [
              {
                id: 'open-questions',
                label: 'No open question',
                pass: true,
                detail: 'no open questions',
              },
              {
                id: 'critical-files',
                label: 'Critical files listed, no overlap',
                pass: false,
                detail: 'no Critical files section',
              },
              { id: 'step-count', label: 'At most 6 steps', pass: true, detail: '1 step' },
              {
                id: 'spec-read',
                label: 'Spec read',
                pass: true,
                detail: 'the ticket names no spec',
              },
              {
                id: 'acceptance',
                label: 'Every step has agent-checkable acceptance',
                pass: true,
                detail: '1 step checked',
              },
            ],
          },
        })}
        onAnswer={async () => {}}
        onDismiss={async () => {}}
      />,
    );

    expect(html).toContain('data-plan-check-pass="false"');
    expect(html).toContain('no Critical files section');
  });

  it('shows no plan-check block for an item without one', () => {
    const html = render(
      <InboxItem
        item={item({ id: 'item-1', taskId: 'task-1', kind: 'plan-approval' })}
        onAnswer={async () => {}}
        onDismiss={async () => {}}
      />,
    );

    expect(html).not.toContain('data-plan-check');
  });
});

describe('InboxItem — "Make this a decision on the card"', () => {
  const renderItem = (over: Partial<AttentionItem>): string =>
    render(
      <InboxItem
        item={item({ id: 'item-1', taskId: 'task-1', options: ['Monthly', 'Yearly'], ...over })}
        onAnswer={async () => {}}
        onDismiss={async () => {}}
      />,
    );

  it('offers it next to Send for a question raised while planning', () => {
    const html = renderItem({ duringPlanning: true });
    expect(html).toContain('Send');
    expect(html).toContain(MAKE_DECISION_LABEL);
    // Next to Send, after it in the same answer row.
    expect(html.indexOf(MAKE_DECISION_LABEL)).toBeGreaterThan(html.indexOf('Send'));
  });

  it('does not offer it for a question a working run asked', () => {
    expect(renderItem({})).not.toContain(MAKE_DECISION_LABEL);
    expect(renderItem({ duringPlanning: false })).not.toContain(MAKE_DECISION_LABEL);
  });

  it('does not offer it for any other kind, even one raised while planning', () => {
    expect(renderItem({ kind: 'plan-approval', duringPlanning: true, options: [] })).not.toContain(
      MAKE_DECISION_LABEL,
    );
    expect(renderItem({ kind: 'permission', duringPlanning: true, options: [] })).not.toContain(
      MAKE_DECISION_LABEL,
    );
  });
});
