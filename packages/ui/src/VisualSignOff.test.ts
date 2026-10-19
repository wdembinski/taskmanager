/**
 * `submitVisualSignOff` — the one call both the Approve and Needs-changes buttons make.
 * Rendering `VisualSignOff` itself needs a browser (`VisualSignOff.render.test.tsx`); this is
 * the one piece worth proving without one — that each verdict reaches `task:visualSignOff`
 * with the right status, and that `needs-changes` carries the flagged screens.
 */
import { describe, expect, it, vi } from 'vitest';
import { submitVisualSignOff } from './VisualSignOff';
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
