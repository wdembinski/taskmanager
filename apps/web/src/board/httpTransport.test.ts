import { describe, expect, it, vi } from 'vitest';
import { HttpTransport, type HttpTransportDeps } from './httpTransport';

function makeTransport(overrides: Partial<HttpTransportDeps> = {}): {
  transport: HttpTransport;
  fetchImpl: ReturnType<typeof vi.fn>;
} {
  const fetchImpl = (overrides.fetchImpl as ReturnType<typeof vi.fn>) ?? vi.fn().mockResolvedValue({ ok: true, status: 202 });
  const deps: HttpTransportDeps = {
    apiBase: 'https://api.example.com',
    clientId: 'web-1',
    getAccessToken: async () => 'token',
    getTargetClientId: () => 'desktop-1',
    fetchImpl: fetchImpl as unknown as typeof fetch,
    newCommandId: () => 'cmd-1',
    now: () => 1000,
    ...overrides,
  };
  return { transport: new HttpTransport(deps), fetchImpl };
}

describe('HttpTransport', () => {
  it('posts a set-status command to /v1/commands', async () => {
    const { transport, fetchImpl } = makeTransport();
    await transport.invoke('task:setStatus', 't1', 'in-progress');

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://api.example.com/v1/commands');
    const body = JSON.parse(init.body);
    expect(body).toEqual({
      targetClientId: 'desktop-1',
      command: {
        id: 'cmd-1',
        issuedAt: 1000,
        issuedBy: 'web-1',
        kind: 'set-status',
        payload: { taskId: 't1', status: 'in-progress' },
      },
    });
    expect(init.headers.authorization).toBe('Bearer token');
  });

  it('posts a create-task command to /v1/commands', async () => {
    const { transport, fetchImpl } = makeTransport();
    await transport.invoke('task:create', 'p1', { title: 'New card', phase: 'Phase 1' });

    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.command.kind).toBe('create-task');
    expect(body.command.payload).toEqual({
      projectId: 'p1',
      title: 'New card',
      phase: 'Phase 1',
      description: undefined,
    });
  });

  it('refuses a channel it does not support, without calling fetch', async () => {
    const { transport, fetchImpl } = makeTransport();
    await expect(transport.invoke('task:setPriority', 't1', 'high')).rejects.toThrow(
      /isn't available from the web client/,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses to send when no desktop Client has ever synced this account', async () => {
    const { transport, fetchImpl } = makeTransport({ getTargetClientId: () => null });
    await expect(transport.invoke('task:setStatus', 't1', 'done')).rejects.toThrow(
      /no desktop client/i,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses to send when signed out', async () => {
    const { transport, fetchImpl } = makeTransport({ getAccessToken: async () => null });
    await expect(transport.invoke('task:setStatus', 't1', 'done')).rejects.toThrow(/not signed in/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('surfaces a non-ok response as a rejection', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 500, statusText: 'err' });
    const { transport } = makeTransport({ fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(transport.invoke('task:setStatus', 't1', 'done')).rejects.toThrow(/command failed/);
  });

  it('on() returns a no-op unsubscribe and never calls back', () => {
    const { transport } = makeTransport();
    const cb = vi.fn();
    const unsubscribe = transport.on('task:changed', cb);
    unsubscribe();
    expect(cb).not.toHaveBeenCalled();
  });

  it('pathForFile always answers empty', () => {
    const { transport } = makeTransport();
    expect(transport.pathForFile({} as File)).toBe('');
  });
});
