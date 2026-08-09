import { describe, expect, it } from 'vitest';
import { toCommandEnvelope } from './commandMapping';

describe('toCommandEnvelope', () => {
  it('converts the stored bigint issuedAt back to a number', () => {
    const envelope = toCommandEnvelope({
      id: 'cmd-1',
      issuedAt: '1717000000000',
      issuedBy: 'client-a',
      kind: 'set-status',
      payload: { taskId: 'task-1', status: 'done' },
    });

    expect(envelope.issuedAt).toBe(1717000000000);
    expect(typeof envelope.issuedAt).toBe('number');
  });

  it('carries id, issuedBy, kind and payload through unchanged', () => {
    const envelope = toCommandEnvelope({
      id: 'cmd-2',
      issuedAt: '1717000000001',
      issuedBy: 'client-b',
      kind: 'add-comment',
      payload: { taskId: 'task-2', body: 'looks good' },
    });

    expect(envelope).toEqual({
      id: 'cmd-2',
      issuedAt: 1717000000001,
      issuedBy: 'client-b',
      kind: 'add-comment',
      payload: { taskId: 'task-2', body: 'looks good' },
    });
  });
});
