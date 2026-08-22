import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_CLOUD_SETTINGS } from '@shared/settings';
import { testCloudConnection } from './cloudTestConnection';

const BASE = 'https://tasks-api.vipper.network';
const CLIENT_ID = 'desktop-1';

interface Route {
  status: number;
  statusText?: string;
  body?: unknown;
}

/** Routes by path, so each rung of the chain can be failed independently. */
function routedFetch(routes: {
  health?: Route | 'throw';
  sync?: Route | 'throw';
  board?: Route | 'throw';
}): typeof fetch {
  return vi.fn(async (input: Parameters<typeof fetch>[0]) => {
    const url = String(input);
    const route = url.includes('/health')
      ? routes.health
      : url.includes('/v1/sync')
        ? routes.sync
        : routes.board;
    if (route === 'throw') throw new Error('getaddrinfo ENOTFOUND');
    const status = route?.status ?? 200;
    // Every rung past /health reads a body, so the default has to be a plausible one: a sync
    // answers a cursor and no commands, a board lists this machine as connected.
    const body =
      route?.body ??
      (url.includes('/v1/sync')
        ? { cursor: 'AAAAAAAAB9E=', cadence: {}, commands: [] }
        : { clients: [{ id: CLIENT_ID, lastSeen: 1 }] });
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: route?.statusText ?? '',
      json: async () => body,
    } as Response;
  }) as unknown as typeof fetch;
}

const settings = (baseUrl: string, enabled = true) => ({
  ...DEFAULT_CLOUD_SETTINGS,
  enabled,
  baseUrl,
});
const signedIn = async () => 'a-token';
const signedOut = async () => null;

/** The deps every rung past the address needs, so a test only states what it is about. */
const probe = (overrides: Partial<Parameters<typeof testCloudConnection>[0]>) =>
  testCloudConnection({
    settings: settings(BASE),
    getAccessToken: signedIn,
    clientId: CLIENT_ID,
    fetchImpl: routedFetch({}),
    ...overrides,
  });

describe('testCloudConnection', () => {
  it('says the address is missing before trying anything', async () => {
    const result = await probe({ settings: settings('   ') });

    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/No server address/i);
  });

  it('names the address when it cannot be reached', async () => {
    // The real failure: taskmanager-api.vipper.network was set instead of tasks-api, and the
    // poller reported nothing at all.
    const result = await probe({
      settings: settings('https://taskmanager-api.vipper.network'),
      fetchImpl: routedFetch({ health: 'throw' }),
    });

    expect(result.ok).toBe(false);
    expect(result.message).toContain('taskmanager-api.vipper.network');
    expect(result.message).toMatch(/could not reach/i);
  });

  it('separates "reachable but not a Task Manager server" from unreachable', async () => {
    const result = await probe({ fetchImpl: routedFetch({ health: { status: 404 } }) });

    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/not a Task Manager server/i);
  });

  it('stops at the sign-in when there is no token, without blaming the server', async () => {
    const result = await probe({ getAccessToken: signedOut });

    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/not signed in/i);
  });

  it('names the master switch, and writes nothing while it is off', async () => {
    // The failure this whole ticket is about: every other rung passes and no browser can see
    // the machine. It must be caught BEFORE the sync below, because that sync would register
    // presence — a browser would then list a desktop that is never going to poll for the
    // commands it queues.
    const fetchImpl = routedFetch({});
    const result = await testCloudConnection({
      settings: settings(BASE, false),
      getAccessToken: signedIn,
      clientId: CLIENT_ID,
      fetchImpl,
    });

    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/switched off/i);
    expect(result.message).toMatch(/Enable cloud sync/i);
    expect(fetchImpl).toHaveBeenCalledTimes(1); // /health only
  });

  it('routes a 401 through describeRejection — the PAT sentence, not the vipper.iam-server one', async () => {
    // Under PATs this app mints nothing — a 401 is a fact about the token the user pasted,
    // never about the server's own vipper.iam credentials, so the message must come from
    // whatever `cloudToken.explain()` says, not a hard-coded "server configuration" sentence.
    const describeRejection = () => 'The cloud rejected this token. It has been revoked.';
    const result = await probe({
      fetchImpl: routedFetch({ sync: { status: 401 } }),
      describeRejection,
    });

    expect(result.ok).toBe(false);
    expect(result.message).toBe(describeRejection());
    expect(result.message).not.toMatch(/server configuration/i);
  });

  it('also routes a 401 on the board read through describeRejection', async () => {
    const describeRejection = () => 'The cloud rejected this token. It has expired.';
    const result = await probe({
      fetchImpl: routedFetch({ board: { status: 401 } }),
      describeRejection,
    });

    expect(result.ok).toBe(false);
    expect(result.message).toBe(describeRejection());
  });

  it('calls a 403 on the sync a missing WRITE grant, and says what it costs', async () => {
    // The guard authorizes per method — a grant of `read` alone lets both clients fetch a
    // board and refuses every sync, so the desktop is invisible while nothing looks broken.
    const result = await probe({ fetchImpl: routedFetch({ sync: { status: 403 } }) });

    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/may not write/i);
    expect(result.message).toMatch(/read AND write/);
  });

  it('calls a 403 on the board a missing READ grant, and blames neither the other way round', async () => {
    const result = await probe({ fetchImpl: routedFetch({ board: { status: 403 } }) });

    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/may not read/i);
  });

  it('reports a sync the server took but did not turn into a connected client', async () => {
    // Presence is per server process, so a second replica answers the board read from a map
    // that never saw this machine's sync. Everything is configured correctly and the browser
    // still says no desktop app is polling.
    const result = await probe({
      fetchImpl: routedFetch({ board: { status: 200, body: { clients: [] } } }),
    });

    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/does not list it as connected/i);
    expect(result.message).toMatch(/more than one copy of the server/i);
  });

  it('confirms the chain by naming the machine a browser would see', async () => {
    const result = await probe({ clientInfo: { name: 'WORKSTATION' } });

    expect(result.ok).toBe(true);
    expect(result.message).toMatch(/Connected/);
    expect(result.message).toContain('WORKSTATION');
    expect(result.displayName).toBe('WORKSTATION');
  });

  it('syncs as this machine, with an empty delta and nothing acked', async () => {
    const fetchImpl = routedFetch({});
    await probe({ fetchImpl, clientInfo: { name: 'WORKSTATION' } });

    const sync = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls.find((call) =>
      String(call[0]).includes('/v1/sync'),
    );
    expect(sync).toBeDefined();
    const body = JSON.parse(String((sync![1] as RequestInit).body)) as Record<string, unknown>;
    expect(body.clientId).toBe(CLIENT_ID);
    expect(body.deltas).toEqual({
      tasks: [],
      projects: [],
      deletedTaskIds: [],
      deletedProjectIds: [],
    });
    expect(body.ackedCommandIds).toEqual([]);
    expect(body.results).toEqual([]);
    expect(body.focused).toBe(false);
    expect(body.info).toEqual({ name: 'WORKSTATION' });
  });

  it('hands the commands its own sync leased to the drain', async () => {
    // The server leases what it delivers, so a probe that swallowed a batch would delay a
    // browser's click by a full lease.
    const commands = [{ id: 'c1', kind: 'ipc-invoke' }];
    const onCommands = vi.fn();
    await probe({
      fetchImpl: routedFetch({ sync: { status: 200, body: { cursor: 'c', commands } } }),
      onCommands,
    });

    expect(onCommands).toHaveBeenCalledWith(commands);
  });

  it('asks the board only for what changed since its own sync', async () => {
    // A yes/no question about presence must not drag a mature board's first page down with it.
    const fetchImpl = routedFetch({});
    await probe({ fetchImpl });

    const board = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls.find((call) =>
      String(call[0]).includes('/v1/board'),
    );
    expect(String(board![0])).toContain('since=');
  });

  it('tolerates a trailing slash on the address', async () => {
    const fetchImpl = routedFetch({});
    await probe({ settings: settings(`${BASE}/`), fetchImpl });

    expect(fetchImpl).toHaveBeenCalledWith(`${BASE}/health`);
  });
});
