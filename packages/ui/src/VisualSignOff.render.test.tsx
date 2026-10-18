/**
 * Proves `VisualSignOff` actually reaches the screen through `TaskDetail` — not just that
 * the component renders in isolation — the same way `TaskDetailHostView.render.test.tsx`
 * proves `TaskDetailHost`'s own wiring by going at `TaskDetail` directly.
 * `renderToStaticMarkup` rather than a DOM testing library, which this package has none of:
 * no effects run, so `TaskDetail`'s own `loadActivity` never fires and the `activity` this
 * section sees is whatever `timeline` starts as — empty, which is enough to prove the section
 * appears (or does not) off `attachments` alone.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PERSONAL_PROJECT_ID, type Task } from '@tm/shared/model';
import type { TaskAttachment } from '@tm/shared/attachments';
import { TransportProvider, type Transport } from './transport';
import { TaskDetail } from './TaskDetail';

const desktopTransport: Transport = {
  invoke: () => new Promise(() => {}) as never,
  on: () => () => {},
  pathForFile: () => '',
};

const webTransport: Transport = {
  ...desktopTransport,
  host: 'web',
  attachmentUrl: () => 'https://cloud.example/a/1',
};

function render(
  node: Parameters<typeof renderToStaticMarkup>[0],
  transport = desktopTransport,
): string {
  return renderToStaticMarkup(<TransportProvider transport={transport}>{node}</TransportProvider>);
}

const task = (over: Partial<Task> & { id: string }): Task => ({
  projectId: PERSONAL_PROJECT_ID,
  phase: '',
  title: over.id,
  status: 'pending',
  sessionId: null,
  order: 0,
  dependsOn: [],
  source: 'adhoc',
  isContract: false,
  isScaffold: false,
  ...over,
});

function attachment(over: Partial<TaskAttachment> & { id: string; name: string }): TaskAttachment {
  return {
    taskId: 'card-1',
    fileName: over.name,
    mimeType: 'image/png',
    size: 1024,
    createdAt: 0,
    ...over,
  };
}

const shotPairAttachments: TaskAttachment[] = [
  attachment({ id: 'a-real', name: 'board-light.png' }),
  attachment({ id: 'a-mockup', name: 'board-light-mockup.png' }),
  attachment({ id: 'a-html', name: 'board-light.html', mimeType: 'text/html' }),
];

describe('VisualSignOff, rendered inside TaskDetail', () => {
  it('shows the section with both thumbnails for a card with a shot pair', () => {
    const card = task({ id: 'card-1' });

    const html = render(<TaskDetail task={card} attachments={shotPairAttachments} />);

    expect(html).toContain('Visual sign-off');
    expect(html).toContain('data-visual-signoff');
    // The card's Files section (`FilesSection.tsx`) legitimately shows the same pair again
    // further down the page — the count check below is scoped to this section's own slice
    // of the markup, not the whole page, so it isn't thrown off by that.
    const section = html.slice(
      html.indexOf('data-visual-signoff'),
      html.indexOf('data-files-section'),
    );
    expect(section.match(/<img\b/g) ?? []).toHaveLength(2);
    expect(section).toContain('a-real');
    expect(section).toContain('a-mockup');
  });

  it('renders nothing for a card with no shot pairs', () => {
    const card = task({ id: 'card-1' });

    const html = render(<TaskDetail task={card} attachments={[]} />);

    expect(html).not.toContain('Visual sign-off');
    expect(html).not.toContain('data-visual-signoff');
  });

  it('is absent for a STEP, even one whose parent card has shot pairs', () => {
    const step = task({ id: 'step-1', parentTaskId: 'card-1' });

    const html = render(<TaskDetail task={step} parentAttachments={shotPairAttachments} />);

    expect(html).not.toContain('Visual sign-off');
  });

  it('on the web host, Open comparison is a dialog trigger, not an attachment:open button', () => {
    const card = task({ id: 'card-1' });

    const webHtml = render(
      <TaskDetail task={card} attachments={shotPairAttachments} />,
      webTransport,
    );
    const desktopHtml = render(
      <TaskDetail task={card} attachments={shotPairAttachments} />,
      desktopTransport,
    );

    expect(webHtml).toContain('aria-haspopup="dialog"');
    expect(desktopHtml).not.toContain('aria-haspopup="dialog"');
  });
});
