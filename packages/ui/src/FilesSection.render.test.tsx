/**
 * Proves `FilesSection` actually reaches the screen through `TaskDetail` — every attachment
 * of the card AND of its steps, grouped by step — the same way `VisualSignOff.render.test.tsx`
 * proves its own section's wiring.
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
    mimeType: 'text/plain',
    size: 0,
    createdAt: 0,
    ...over,
  };
}

describe('FilesSection, rendered inside TaskDetail', () => {
  it('shows a group for the card and a group per step that owns a file', () => {
    const card = task({ id: 'card-1', title: 'Ship the thing' });
    const step1 = task({ id: 'step-1', parentTaskId: 'card-1', title: 'First step' });

    const html = render(
      <TaskDetail
        task={card}
        subtasks={[step1]}
        attachments={[attachment({ id: 'c1', name: 'card-notes.txt' })]}
        subtaskAttachments={[attachment({ id: 's1', name: 'step-log.txt', taskId: 'step-1' })]}
      />,
    );

    expect(html).toContain('data-files-section');
    expect(html).toContain('card-notes.txt');
    expect(html).toContain('step-log.txt');
    expect(html).toContain('First step');
  });

  it('renders nothing when neither the card nor any step has a file', () => {
    const card = task({ id: 'card-1' });

    const html = render(<TaskDetail task={card} attachments={[]} subtaskAttachments={[]} />);

    expect(html).not.toContain('data-files-section');
  });

  it('is absent for a STEP — the Files section belongs to the card, not its own detail view', () => {
    const step = task({ id: 'step-1', parentTaskId: 'card-1' });

    const html = render(
      <TaskDetail task={step} attachments={[attachment({ id: 'c1', name: 'notes.txt' })]} />,
    );

    expect(html).not.toContain('data-files-section');
  });
});
