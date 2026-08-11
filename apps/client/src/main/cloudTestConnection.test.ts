import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_CLOUD_SETTINGS } from '@shared/settings';
import { testCloudConnection } from './cloudTestConnection';

const BASE = 'https://tasks-api.vipper.network';

/** Routes by path, so each rung of the chain can be failed independently. */
function routedFetch(routes: {
  health?: { status: number } | 'throw';
  board?: { status: number; statusText?: string } | 'throw';
}): typeof fetch {
  return vi.fn(async (input: Parameters<typeof fetch>[0]) => {
    const url = String(input);
    const route = url.includes('/health') ? routes.health : routes.board;
    if (route === 'throw') throw new Error('getaddrinfo ENOTFOUND');
    const status = route?.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: (route as { statusText?: string })?.statusText ?? '',
    } as Response;
  }) as unknown as typeof fetch;
}

const settings = (baseUrl: string) => ({ ...DEFAULT_CLOUD_SETTINGS, enabled: true, baseUrl });
const signedIn = async () => 'a-token';
const signedOut = async () => null;

describe('testCloudConnection', () => {
  it('says the address is missing before trying anything', async () => {
    const result = await testCloudConnection({
      settings: settings('   '),
      getAccessToken: signedIn,
      fetchImpl: routedFetch({}),
    });

    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/No server address/i);
  });

  it('names the address when it cannot be reached', async () => {
    // The real failure: taskmanager-api.vipper.network was set instead of tasks-api, and the
    // poller reported nothing at all.
    const result = await testCloudConnection({
      settings: settings('https://taskmanager-api.vipper.network'),
      getAccessToken: signedIn,
      fetchImpl: routedFetch({ health: 'throw' }),
    });

    expect(result.ok).toBe(false);
    expect(result.message).toContain('taskmanager-api.vipper.network');
    expect(result.message).toMatch(/could not reach/i);
  });

  it('separates "reachable but not a Task Manager server" from unreachable', async () => {
    const result = await testCloudConnection({
      settings: settings(BASE),
      getAccessToken: signedIn,
      fetchImpl: routedFetch({ health: { status: 404 } }),
    });

    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/not a Task Manager server/i);
  });

  it('stops at the sign-in when there is no token, without blaming the server', async () => {
    const result = await testCloudConnection({
      settings: settings(BASE),
      getAccessToken: signedOut,
      fetchImpl: routedFetch({}),
    });

    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/not signed in/i);
  });

  it('calls a 401 a server-side credential problem, not the user’s', async () => {
    // This is what a wrong CLOUD_IAM_CLIENT_ID looks like from the app, and it is emphatically
    // not something the person reading the message can fix in this dialog.
    const result = await testCloudConnection({
      settings: settings(BASE),
      getAccessToken: signedIn,
      fetchImpl: routedFetch({ board: { status: 401 } }),
    });

    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/server configuration/i);
  });

  it('calls a 403 a missing grant, and says who can fix it', async () => {
    const result = await testCloudConnection({
      settings: settings(BASE),
      getAccessToken: signedIn,
      fetchImpl: routedFetch({ board: { status: 403 } }),
    });

    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/no access to a board/i);
    expect(result.message).toMatch(/read and write/i);
  });

  it('confirms a working chain', async () => {
    const result = await testCloudConnection({
      settings: settings(BASE),
      getAccessToken: signedIn,
      fetchImpl: routedFetch({}),
    });

    expect(result).toEqual({ ok: true, message: 'Connected. The server recognises this account.' });
  });

  it('tolerates a trailing slash on the address', async () => {
    const fetchImpl = routedFetch({});
    await testCloudConnection({
      settings: settings(`${BASE}/`),
      getAccessToken: signedIn,
      fetchImpl,
    });

    expect(fetchImpl).toHaveBeenCalledWith(`${BASE}/health`);
  });
});
