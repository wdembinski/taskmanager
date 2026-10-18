/**
 * Proves the "waiting for you" band shows the files the parked run already produced —
 * `TaskDetail`'s own `waitingTaskId`/`waitingAttachments`, read off whichever task (the card
 * itself, or one of its steps) is actually `waiting-input`.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PERSONAL_PROJECT_ID, type Task } from '@tm/shared/model';
import type { TaskAttachment } from '@tm/shared/attachments';
import { TransportProvider, type Transport } from './transport';
import { TaskDetail } from './TaskDetail';

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
    size: 0,
    createdAt: 0,
    ...over,
  };
}

describe('TaskDetail, the waiting-for-you band', () => {
  it("shows the card's own files when the card itself is waiting-input", () => {
    const card = task({ id: 'card-1', status: 'waiting-input', agentProjectId: 'proj' });

    const html = render(
      <TaskDetail task={card} attachments={[attachment({ id: 'a1', name: 'shot.png' })]} />,
    );

    expect(html).toContain('Waiting for you');
    expect(html).toContain('data-attachment-gallery');
  });

  it("shows the PARKED STEP's own files, not the card's, when a step is waiting", () => {
    const card = task({ id: 'card-1', agentProjectId: 'proj' });
    const step = task({
      id: 'step-1',
      parentTaskId: 'card-1',
      status: 'waiting-input',
      agentProjectId: 'proj',
    });

    const html = render(
      <TaskDetail
        task={card}
        subtasks={[step]}
        attachments={[attachment({ id: 'a1', name: 'card-only.png' })]}
        subtaskAttachments={[attachment({ id: 'a2', name: 'step-shot.png', taskId: 'step-1' })]}
      />,
    );

    expect(html).toContain('data-attachment-gallery');
    expect(html).toContain('step-shot.png');
    // `card-only.png` still appears elsewhere on the page (the description's own attachment
    // strip) — what this proves is that the WAITING BAND's own gallery is the step's, which
    // the fixture above is built so only `step-shot.png` could satisfy.
  });

  it('shows no gallery when the waiting task has no files', () => {
    const card = task({ id: 'card-1', status: 'waiting-input', agentProjectId: 'proj' });

    const html = render(<TaskDetail task={card} attachments={[]} />);

    expect(html).toContain('Waiting for you');
    expect(html).not.toContain('data-attachment-gallery');
  });
});
