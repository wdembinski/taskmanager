import { describe, expect, it, vi } from 'vitest';
import type { IpcApi } from '@tm/shared/ipc';
import { DEFAULT_SETTINGS } from '@tm/shared/settings';
import type { CommandResult } from '@tm/protocol/wire';
import { HttpTransport, RPC_TIMEOUT_MS, type HttpTransportDeps } from './httpTransport';

/**
 * A fake server: `POST /v1/commands` records what was queued, `GET /v1/results` serves
 * whatever the test has told it the desktop answered.
 *
 * `setTimeoutImpl` runs the callback on a microtask rather than a real timer, so the poll
 * loop advances as fast as the test awaits — no fake timers, no five-second waits, and the
 * ORDER of poll passes is still real.
 */
function makeServer() {
  const queued: Array<{ id: string; kind: string; payload: unknown }> = [];
  const results: CommandResult[] = [];
  let resultReads = 0;

  const fetchImpl = vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    if (url.startsWith('https://api.example.com/v1/commands')) {
      const body = JSON.parse(init!.body!) as {
        command: { id: string; kind: string; payload: unknown };
      };
      queued.push(body.command);
      return { ok: true, status: 202, json: async () => ({ ok: true }) };
    }
    if (url.startsWith('https://api.example.com/v1/results')) {
      resultReads++;
      const drained = results.splice(0, results.length);
      return { ok: true, status: 200, json: async () => ({ results: drained, cursor: 'r1' }) };
    }
    throw new Error(`unexpected fetch: ${url}`);
  });

  return {
    fetchImpl,
    queued,
    /** Tell the fake desktop to answer the command it was last handed. */
    answer: (commandId: string, result: Omit<CommandResult, 'commandId'>) =>
      results.push({ commandId, ...result }),
    resultReads: () => resultReads,
  };
}

let nextId = 0;

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
    newCommandId: () => `cmd-${++nextId}`,
    now: () => 1000,
    // Microtask, not a timer — see makeServer's docstring.
    setTimeoutImpl: ((cb: () => void) => {
      void Promise.resolve().then(cb);
      return 0;
    }) as unknown as typeof setTimeout,
    ...overrides,
  };
  return { transport: new HttpTransport(deps), fetchImpl };
}

/** A transport on its own, for the table-driven cases that only care about the answer. */
function t(): HttpTransport {
  return makeTransport().transport;
}

describe('HttpTransport: the one mirror-observed kind', () => {
  it('posts a set-status command and resolves without waiting for a result', async () => {
    nextId = 0;
    const { transport, fetchImpl } = makeTransport({ newCommandId: () => 'cmd-1' });
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

  /**
   * The inverse of what this file asserted before, because the answer changed. `task:create`
   * used to be the second mirror-observed kind: it posted a `create-task` command, which can
   * carry a project, a title, a phase and a description, and answered a fabricated
   * `pending:<uuid>` row.
   *
   * Both halves were wrong once the shared dialog started making cards here. The kind drops
   * every other field the dialog collects (type, filing, parent), and its caller does not
   * throw the answer away the way a status change's caller does — it adopts a JIRA ticket
   * onto the returned id, draws a chain link to it and copies files onto it, none of which a
   * made-up id can be the subject of. So it relays, and the row that comes back is real.
   */
  it('relays task:create, so the created card comes back whole', async () => {
    const server = makeServer();
    const { transport } = makeTransport({
      fetchImpl: server.fetchImpl as unknown as typeof fetch,
      newCommandId: () => 'cmd-9',
    });

    const call = transport.invoke('task:create', 'personal', {
      title: 'New card',
      phase: 'Phase 1',
      type: 'bug',
      description: 'what it is about',
      projectTagId: 'proj-1',
    });
    server.answer('cmd-9', { ok: true, value: { id: 'real-1', title: 'New card' } });

    await expect(call).resolves.toMatchObject({ id: 'real-1' });
    expect(server.queued[0]).toMatchObject({
      kind: 'ipc-invoke',
      payload: {
        channel: 'task:create',
        args: [
          'personal',
          {
            title: 'New card',
            phase: 'Phase 1',
            type: 'bug',
            description: 'what it is about',
            projectTagId: 'proj-1',
          },
        ],
      },
    });
  });
});

describe('HttpTransport: a relayed invoke is a real round trip', () => {
  it('queues an ipc-invoke carrying the channel and its arguments', async () => {
    const server = makeServer();
    const { transport } = makeTransport({
      fetchImpl: server.fetchImpl as unknown as typeof fetch,
      newCommandId: () => 'cmd-42',
    });

    const call = transport.invoke('task:activity', 't1');
    server.answer('cmd-42', { ok: true, value: [{ kind: 'comment', body: 'hi' }] });

    await expect(call).resolves.toEqual([{ kind: 'comment', body: 'hi' }]);
    expect(server.queued).toHaveLength(1);
    expect(server.queued[0]).toMatchObject({
      id: 'cmd-42',
      issuedBy: 'web-1',
      kind: 'ipc-invoke',
      payload: { channel: 'task:activity', args: ['t1'] },
    });
  });

  /**
   * `development` asserted the exact opposite of this while the branch was in flight: a
   * browser had no engine to resume into, so the transport refused `task:resumeAgent`
   * outright. That tier is gone — `RELAY_POLICY` decides what may cross now, and it classes
   * this channel with the card-level twins it was always shaped like, `task:run` and
   * `task:stopAgent`. Same assertion, kept by name, inverted because the answer changed.
   */
  it('relays task:resumeAgent, because the resume happens on the desktop', async () => {
    const server = makeServer();
    const { transport } = makeTransport({
      fetchImpl: server.fetchImpl as unknown as typeof fetch,
      newCommandId: () => 'cmd-7',
    });

    const call = transport.invoke('task:resumeAgent', 't1');
    server.answer('cmd-7', { ok: true, value: { id: 't1', status: 'in-progress' } });

    await expect(call).resolves.toMatchObject({ id: 't1', status: 'in-progress' });
    expect(server.queued[0]).toMatchObject({
      kind: 'ipc-invoke',
      payload: { channel: 'task:resumeAgent', args: ['t1'] },
    });
  });

  it('rejects with the desktop’s own message when the handler failed', async () => {
    const server = makeServer();
    const { transport } = makeTransport({
      fetchImpl: server.fetchImpl as unknown as typeof fetch,
      newCommandId: () => 'cmd-1',
    });

    const call = transport.invoke('task:run', 't1');
    server.answer('cmd-1', { ok: false, error: 'A usage limit is holding all work.' });

    await expect(call).rejects.toThrow('A usage limit is holding all work.');
  });

  it('keeps two calls apart, resolving each with its own answer', async () => {
    const server = makeServer();
    let n = 0;
    const { transport } = makeTransport({
      fetchImpl: server.fetchImpl as unknown as typeof fetch,
      newCommandId: () => `c${++n}`,
    });

    const a = transport.invoke('chain:links');
    const b = transport.invoke('attachment:list');
    server.answer('c2', { ok: true, value: ['attachment'] });
    server.answer('c1', { ok: true, value: ['link'] });

    await expect(a).resolves.toEqual(['link']);
    await expect(b).resolves.toEqual(['attachment']);
  });

  it('stops polling for results once nothing is pending', async () => {
    const server = makeServer();
    const { transport } = makeTransport({
      fetchImpl: server.fetchImpl as unknown as typeof fetch,
      newCommandId: () => 'cmd-1',
    });

    const call = transport.invoke('board:tasks');
    server.answer('cmd-1', { ok: true, value: [] });
    await call;

    const settled = server.resultReads();
    // Let a generous number of microtask turns pass; nothing is pending, so nothing polls.
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(server.resultReads()).toBe(settled);
  });

  it('does not poll for results at all until something is pending', async () => {
    const server = makeServer();
    const { transport } = makeTransport({
      fetchImpl: server.fetchImpl as unknown as typeof fetch,
    });
    await transport.invoke('task:setStatus', 't1', 'done');
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(server.resultReads()).toBe(0);
  });

  it('survives a failed results poll and resolves on the next one', async () => {
    let reads = 0;
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.startsWith('https://api.example.com/v1/commands')) return { ok: true, status: 202 };
      reads++;
      if (reads === 1) return { ok: false, status: 502, statusText: 'Bad Gateway' };
      return {
        ok: true,
        status: 200,
        json: async () => ({ results: [{ commandId: 'cmd-1', ok: true, value: 7 }], cursor: 'r1' }),
      };
    });
    const { transport } = makeTransport({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      newCommandId: () => 'cmd-1',
    });

    await expect(transport.invoke('usage:quotas')).resolves.toBe(7);
    expect(reads).toBeGreaterThanOrEqual(2);
  });

  it('fails the call when the command could not be queued at all', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 500, statusText: 'err' });
    const { transport } = makeTransport({ fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(transport.invoke('board:tasks')).rejects.toThrow(/command failed/);
  });
});

describe('HttpTransport: host-only channels', () => {
  /** One per group in `@tm/shared/ipcRelay` — the refusal must name the reason, not "no". */
  const CASES: Array<{ channel: keyof IpcApi; call: () => Promise<unknown>; says: RegExp }> = [
    { channel: 'attachment:pick', call: () => t().invoke('attachment:pick'), says: /file picker/ },
    {
      channel: 'project:pickDirectory',
      call: () => t().invoke('project:pickDirectory'),
      says: /file picker/,
    },
    { channel: 'window:close', call: () => t().invoke('window:close'), says: /desktop app itself/ },
    {
      channel: 'jira:setCredentials',
      call: () => t().invoke('jira:setCredentials', 'pat'),
      says: /credential store/,
    },
    {
      channel: 'session:stop',
      call: () => t().invoke('session:stop', 'run-1'),
      says: /live Claude process/,
    },
  ];

  for (const { channel, call, says } of CASES) {
    it(`refuses ${channel}, saying why`, async () => {
      await expect(call()).rejects.toThrow(says);
    });
  }

  it('refuses without touching the network', async () => {
    const { transport, fetchImpl } = makeTransport();
    await expect(transport.invoke('attachment:open', 'a1')).rejects.toThrow(/desktop app/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('HttpTransport: channels that used to be stubbed', () => {
  /**
   * Every one of these answered a fabricated empty value before. The point of the rewrite is
   * that they are real calls now, so the assertion is that they reach the wire — an empty
   * answer that came from the desktop is a fact, and one this app invented was not.
   */
  const RELAYED: Array<{ channel: keyof IpcApi; call: (x: HttpTransport) => Promise<unknown> }> = [
    { channel: 'task:activity', call: (x) => x.invoke('task:activity', 't1') },
    { channel: 'scheduler:activeRuns', call: (x) => x.invoke('scheduler:activeRuns') },
    { channel: 'settings:get', call: (x) => x.invoke('settings:get') },
    { channel: 'project:hasReleaseDoc', call: (x) => x.invoke('project:hasReleaseDoc', 'p1') },
    { channel: 'jira:priorities', call: (x) => x.invoke('jira:priorities') },
    { channel: 'jira:fetchComments', call: (x) => x.invoke('jira:fetchComments', 't1') },
    { channel: 'jira:markRead', call: (x) => x.invoke('jira:markRead', 't1') },
    { channel: 'settings:save', call: (x) => x.invoke('settings:save', DEFAULT_SETTINGS) },
    { channel: 'task:setPriority', call: (x) => x.invoke('task:setPriority', 't1', 'High') },
    { channel: 'task:chat', call: (x) => x.invoke('task:chat', 't1', 'hello') },
    { channel: 'task:run', call: (x) => x.invoke('task:run', 't1') },
    { channel: 'attachment:add', call: (x) => x.invoke('attachment:add', 't1', ['/tmp/a']) },
  ];

  for (const { channel, call } of RELAYED) {
    it(`relays ${channel} instead of answering for the desktop`, async () => {
      const server = makeServer();
      const { transport } = makeTransport({
        fetchImpl: server.fetchImpl as unknown as typeof fetch,
        newCommandId: () => 'cmd-1',
      });
      const pending = call(transport);
      server.answer('cmd-1', { ok: true, value: null });
      await pending;

      expect(server.queued).toHaveLength(1);
      expect(server.queued[0]).toMatchObject({
        kind: 'ipc-invoke',
        payload: { channel },
      });
    });
  }
});

describe('HttpTransport: the two silences it tells apart', () => {
  it('names "no desktop app is polling" when none is', async () => {
    const server = makeServer();
    const { transport } = makeTransport({
      fetchImpl: server.fetchImpl as unknown as typeof fetch,
      newCommandId: () => 'cmd-1',
      hasLiveClient: () => false,
      // Jump the clock past the timeout on the second read, so the expiry sweep fires.
      now: (() => {
        let calls = 0;
        return () => (++calls > 1 ? 1000 + RPC_TIMEOUT_MS + 1 : 1000);
      })(),
    });

    await expect(transport.invoke('board:tasks')).rejects.toThrow(/No desktop app is polling/);
  });

  it('names "has not answered yet" when one is polling but silent', async () => {
    const server = makeServer();
    const { transport } = makeTransport({
      fetchImpl: server.fetchImpl as unknown as typeof fetch,
      newCommandId: () => 'cmd-1',
      hasLiveClient: () => true,
      now: (() => {
        let calls = 0;
        return () => (++calls > 1 ? 1000 + RPC_TIMEOUT_MS + 1 : 1000);
      })(),
    });

    await expect(transport.invoke('board:tasks')).rejects.toThrow(/has not answered/);
  });
});

describe('HttpTransport: preconditions', () => {
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

  it('fails everything still pending when the page closes', async () => {
    const server = makeServer();
    const { transport } = makeTransport({
      fetchImpl: server.fetchImpl as unknown as typeof fetch,
    });
    const call = transport.invoke('board:tasks');
    const settled = call.catch((e: Error) => e.message);
    transport.dispose();
    await expect(settled).resolves.toMatch(/page is closing/);
  });

  it('pathForFile always answers empty', () => {
    const { transport } = makeTransport();
    expect(transport.pathForFile({} as File)).toBe('');
  });

  it('says it cannot serve attachment bytes, rather than naming a route that 404s', () => {
    // The desktop answers `vipper-attachment://a/<id>`, a scheme only Electron registers,
    // and the bytes are not on the server yet (docs/plan/README.md Phase 26, "what this
    // leaves owed"). `''` makes the shared strip show the chip and skip the thumbnail; a
    // plausible URL would look the same on screen and be a claim that was not true.
    const { transport } = makeTransport();
    expect(transport.attachmentUrl()).toBe('');
  });
});
