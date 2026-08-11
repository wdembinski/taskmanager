import { describe, expect, it, vi } from 'vitest';
import type { IpcApi } from '@tm/shared/ipc';
import { DEFAULT_SETTINGS } from '@tm/shared/settings';
import { HttpTransport, type HttpTransportDeps } from './httpTransport';

function makeTransport(overrides: Partial<HttpTransportDeps> = {}): {
  transport: HttpTransport;
  fetchImpl: ReturnType<typeof vi.fn>;
} {
  const fetchImpl =
    (overrides.fetchImpl as ReturnType<typeof vi.fn>) ??
    vi.fn().mockResolvedValue({ ok: true, status: 202 });
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

/** A transport on its own, for the table-driven cases that only care about the answer. */
function t(): HttpTransport {
  return makeTransport().transport;
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

  /**
   * Tier 2 — the reads the shared `TaskDetail` tree makes on mount, each answering the
   * empty truth rather than rejecting. The documented value is asserted per channel because
   * that value IS the contract with the caller: `task:activity` feeds a `.map`, `settings:get`
   * is destructured, and `project:hasReleaseDoc` decides whether a switch is offered.
   */
  describe('stubbed reads', () => {
    const CASES: Array<{
      call: () => Promise<unknown>;
      channel: keyof IpcApi;
      expected: unknown;
    }> = [
      { channel: 'task:activity', expected: [], call: () => t().invoke('task:activity', 't1') },
      {
        channel: 'scheduler:activeRuns',
        expected: [],
        call: () => t().invoke('scheduler:activeRuns'),
      },
      {
        channel: 'settings:get',
        expected: DEFAULT_SETTINGS,
        call: () => t().invoke('settings:get'),
      },
      {
        channel: 'project:hasReleaseDoc',
        expected: false,
        call: () => t().invoke('project:hasReleaseDoc', 'p1'),
      },
      { channel: 'jira:priorities', expected: [], call: () => t().invoke('jira:priorities') },
      {
        channel: 'jira:fetchComments',
        expected: [],
        call: () => t().invoke('jira:fetchComments', 't1'),
      },
      {
        channel: 'gitlab:markRead',
        expected: [],
        call: () => t().invoke('gitlab:markRead', 'mr1'),
      },
      {
        channel: 'gitlab:markEventsSeen',
        expected: [],
        call: () => t().invoke('gitlab:markEventsSeen', 'mr1'),
      },
    ];

    for (const { channel, expected, call } of CASES) {
      it(`answers ${channel} with its documented empty value`, async () => {
        await expect(call()).resolves.toEqual(expected);
      });
    }

    it('never posts a command for a read', async () => {
      const { transport, fetchImpl } = makeTransport();
      await transport.invoke('task:activity', 't1');
      await transport.invoke('settings:get');
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('hands out a fresh settings object, not the shared default', async () => {
      const settings = await t().invoke('settings:get');
      expect(settings).not.toBe(DEFAULT_SETTINGS);
    });
  });

  /**
   * Tier 3 — everything else, refused by name. One case per shape of caller: a write from
   * the details cell, a write from the agent panel, a step edit, a chat message, an
   * attachment, and the settings save behind the Display menu.
   */
  describe('refused channels', () => {
    const CASES: Array<{ channel: keyof IpcApi; call: () => Promise<unknown> }> = [
      { channel: 'task:setPriority', call: () => t().invoke('task:setPriority', 't1', 'high') },
      { channel: 'task:setDescription', call: () => t().invoke('task:setDescription', 't1', 'x') },
      { channel: 'task:addComment', call: () => t().invoke('task:addComment', 't1', 'hello') },
      { channel: 'task:chat', call: () => t().invoke('task:chat', 't1', 'hello') },
      { channel: 'task:run', call: () => t().invoke('task:run', 't1') },
      { channel: 'task:delete', call: () => t().invoke('task:delete', 't1') },
      { channel: 'task:integrate', call: () => t().invoke('task:integrate', 't1') },
      { channel: 'attachment:pick', call: () => t().invoke('attachment:pick') },
      { channel: 'settings:save', call: () => t().invoke('settings:save', DEFAULT_SETTINGS) },
    ];

    for (const { channel, call } of CASES) {
      it(`refuses ${channel}, naming the desktop app`, async () => {
        await expect(call()).rejects.toThrow(/desktop app/);
      });
    }

    // Deliberately not a stubbed read, though it only reads: its result goes straight into
    // `TaskDetail`'s `onStatusChanged`, so a fabricated Task would replace the real card on
    // the board with a two-field stub. The call site already catches, so this is invisible.
    it('refuses jira:markRead because its Task would clobber the real card', async () => {
      await expect(t().invoke('jira:markRead', 't1')).rejects.toThrow(/desktop app/);
    });
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
    await expect(transport.invoke('task:setStatus', 't1', 'done')).rejects.toThrow(
      /not signed in/i,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('surfaces a non-ok response as a rejection', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 500, statusText: 'err' });
    const { transport } = makeTransport({ fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(transport.invoke('task:setStatus', 't1', 'done')).rejects.toThrow(
      /command failed/,
    );
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
