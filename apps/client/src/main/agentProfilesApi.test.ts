import { describe, expect, it, vi } from 'vitest';
import {
  addAgentProfile,
  listAgentProfiles,
  removeAgentProfile,
  updateAgentProfile,
} from './agentProfilesApi';

const BASE = 'https://tasks-api.vipper.network';

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: '',
    json: async () => body,
    clone() {
      return this;
    },
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

describe('agentProfilesApi', () => {
  it('lists profiles from the cloud server', async () => {
    const profiles = [{ id: 'p1', name: 'Reviewer' }];
    const fetchImpl = vi.fn(async (_input: Parameters<typeof fetch>[0], _init?: RequestInit) =>
      jsonResponse(200, profiles),
    );

    const result = await listAgentProfiles({ baseUrl: BASE, token: 't', fetchImpl });

    expect(result).toEqual(profiles);
    expect(fetchImpl).toHaveBeenCalledWith(
      `${BASE}/v1/agent-profiles`,
      expect.objectContaining({ method: 'GET' }),
    );
    const [, init] = fetchImpl.mock.calls[0];
    expect((init!.headers as Record<string, string>).authorization).toBe('Bearer t');
  });

  it('creates a profile with the body serialized as JSON', async () => {
    const created = { id: 'p1', name: 'Reviewer' };
    const fetchImpl = vi.fn(async (_input: Parameters<typeof fetch>[0], _init?: RequestInit) =>
      jsonResponse(201, created),
    );
    const input = {
      name: 'Reviewer',
      model: 'sonnet' as const,
      permissionMode: 'acceptEdits' as const,
    };

    const result = await addAgentProfile({ baseUrl: BASE, token: 't', fetchImpl }, input);

    expect(result).toEqual(created);
    const [, init] = fetchImpl.mock.calls[0];
    expect(init!.method).toBe('POST');
    expect(JSON.parse(init!.body as string)).toEqual(input);
  });

  it('patches a profile against its own url', async () => {
    const patched = { id: 'p1', name: 'Renamed' };
    const fetchImpl = vi.fn(async () => jsonResponse(200, patched));

    const result = await updateAgentProfile({ baseUrl: BASE, token: 't', fetchImpl }, 'p1', {
      name: 'Renamed',
    });

    expect(result).toEqual(patched);
    expect(fetchImpl).toHaveBeenCalledWith(
      `${BASE}/v1/agent-profiles/p1`,
      expect.objectContaining({ method: 'PATCH' }),
    );
  });

  it('removes a profile', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, undefined));

    await removeAgentProfile({ baseUrl: BASE, token: 't', fetchImpl }, 'p1');

    expect(fetchImpl).toHaveBeenCalledWith(
      `${BASE}/v1/agent-profiles/p1`,
      expect.objectContaining({ method: 'DELETE' }),
    );
  });

  it('surfaces the server’s own message on a rejected write', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(400, { message: 'Cannot remove: 1 assignment(s)…' }),
    );

    await expect(
      removeAgentProfile({ baseUrl: BASE, token: 't', fetchImpl }, 'p1'),
    ).rejects.toThrow(/Cannot remove/);
  });
});
