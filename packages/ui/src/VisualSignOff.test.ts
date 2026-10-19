/**
 * `submitVisualSignOff` — the one call both the Approve and Needs-changes buttons make.
 * Rendering `VisualSignOff` itself needs a browser (`VisualSignOff.render.test.tsx`); this is
 * the one piece worth proving without one — that each verdict reaches `task:visualSignOff`
 * with the right status, and that `needs-changes` carries the flagged screens.
 */
import { describe, expect, it, vi } from 'vitest';
import type { TaskAttachment } from '@tm/shared/attachments';
import { openComparisonOnDesktop, submitVisualSignOff } from './VisualSignOff';
import type { Transport } from './transport';

function fakeTransport(): { transport: Transport; invoke: ReturnType<typeof vi.fn> } {
  const invoke = vi.fn().mockResolvedValue({ id: 1 });
  return { transport: { invoke } as unknown as Transport, invoke };
}

describe('submitVisualSignOff', () => {
  it('invokes task:visualSignOff with "approved"', async () => {
    const { transport, invoke } = fakeTransport();
    await submitVisualSignOff(transport, 'task-1', 'approved');
    expect(invoke).toHaveBeenCalledWith('task:visualSignOff', 'task-1', 'approved', undefined);
  });

  it('invokes task:visualSignOff with "needs-changes" and the flagged screens', async () => {
    const { transport, invoke } = fakeTransport();
    await submitVisualSignOff(transport, 'task-1', 'needs-changes', ['board-light', 'settings']);
    expect(invoke).toHaveBeenCalledWith('task:visualSignOff', 'task-1', 'needs-changes', [
      'board-light',
      'settings',
    ]);
  });
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

/**
 * `openComparisonOnDesktop` — what a row's "Open comparison" opens on the desktop. A card
 * shot by `ui-shots.mjs` usually has the contact sheet attached too, and opening THAT for
 * every row landed the owner on 32 unrelated screens; the row's own page must win.
 */
describe('openComparisonOnDesktop', () => {
  const real = attachment({ id: 'a-real', name: 'inbox-decisions.png' });
  const html = attachment({ id: 'a-html', name: 'inbox-decisions.html', mimeType: 'text/html' });
  const index = attachment({ id: 'a-index', name: 'index.html', mimeType: 'text/html' });

  it("opens the row's own side-by-side page, even when the contact sheet is attached", () => {
    const { transport, invoke } = fakeTransport();
    openComparisonOnDesktop(transport, { name: 'inbox-decisions', real, html }, index);
    expect(invoke).toHaveBeenCalledWith('attachment:open', 'a-html');
  });

  it('falls back to the contact sheet when the row has no page of its own', () => {
    const { transport, invoke } = fakeTransport();
    openComparisonOnDesktop(transport, { name: 'inbox-decisions', real }, index);
    expect(invoke).toHaveBeenCalledWith('attachment:open', 'a-index');
  });

  it('falls back to the real shot itself when there is neither', () => {
    const { transport, invoke } = fakeTransport();
    openComparisonOnDesktop(transport, { name: 'inbox-decisions', real });
    expect(invoke).toHaveBeenCalledWith('attachment:open', 'a-real');
  });
});
