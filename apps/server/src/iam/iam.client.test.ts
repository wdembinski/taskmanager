import { describe, expect, it, vi } from 'vitest';
import { createIamClient } from './iam.client';

function fakeFetch(status: number, body: unknown): typeof fetch {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  }) as unknown as typeof fetch;
}

describe('createIamClient', () => {
  describe('introspectToken', () => {
    it('authenticates itself with Basic auth and normalizes the response', async () => {
      const fetchImpl = fakeFetch(200, {
        active: true,
        sub: 'account-123',
        sub_type: 'user',
        scope: 'read write',
        aud: 'taskmanager',
      });
      const client = createIamClient({
        apiBase: 'https://iam.vipper.network/api/v1/',
        clientId: 'cid',
        clientSecret: 'csecret',
        fetch: fetchImpl,
      });

      const result = await client.introspectToken('vipr_abc');

      expect(fetchImpl).toHaveBeenCalledWith(
        'https://iam.vipper.network/api/v1/oauth/introspect',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            Authorization: `Basic ${Buffer.from('cid:csecret').toString('base64')}`,
          }),
          body: JSON.stringify({ token: 'vipr_abc' }),
        }),
      );
      expect(result).toEqual({
        active: true,
        subject: 'account-123',
        subjectType: 'user',
        scopes: ['read', 'write'],
        audience: 'taskmanager',
      });
    });

    it('defaults missing optional fields to null/empty', async () => {
      const client = createIamClient({
        apiBase: 'https://iam.vipper.network/api/v1',
        clientId: 'cid',
        clientSecret: 'csecret',
        fetch: fakeFetch(200, { active: false }),
      });

      const result = await client.introspectToken('expired');

      expect(result).toEqual({
        active: false,
        subject: null,
        subjectType: null,
        scopes: [],
        audience: null,
      });
    });

    it('throws on a non-2xx response', async () => {
      const client = createIamClient({
        apiBase: 'https://iam.vipper.network/api/v1',
        clientId: 'cid',
        clientSecret: 'csecret',
        fetch: fakeFetch(500, { error: 'boom' }),
      });

      await expect(client.introspectToken('t')).rejects.toThrow(/introspection failed \(500/);
    });
  });

  describe('authorize', () => {
    it('presents the caller token as the bearer and forwards the decision request', async () => {
      const fetchImpl = fakeFetch(200, { allowed: true, scopes: ['read'] });
      const client = createIamClient({
        apiBase: 'https://iam.vipper.network/api/v1',
        clientId: 'cid',
        clientSecret: 'csecret',
        fetch: fetchImpl,
      });

      const result = await client.authorize({
        token: 'vipr_abc',
        resourceType: 'taskmanager',
        identifier: 'account-123',
        action: 'write',
      });

      expect(fetchImpl).toHaveBeenCalledWith(
        'https://iam.vipper.network/api/v1/authorize',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({ Authorization: 'Bearer vipr_abc' }),
          body: JSON.stringify({
            resourceType: 'taskmanager',
            identifier: 'account-123',
            action: 'write',
          }),
        }),
      );
      expect(result).toEqual({ allowed: true, scopes: ['read'] });
    });

    it('throws on a non-2xx response', async () => {
      const client = createIamClient({
        apiBase: 'https://iam.vipper.network/api/v1',
        clientId: 'cid',
        clientSecret: 'csecret',
        fetch: fakeFetch(403, { error: 'denied' }),
      });

      await expect(
        client.authorize({
          token: 't',
          resourceType: 'taskmanager',
          identifier: 'a',
          action: 'read',
        }),
      ).rejects.toThrow(/authorize failed \(403/);
    });
  });
});
