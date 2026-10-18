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
});
