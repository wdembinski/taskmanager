import { describe, expect, it, vi } from 'vitest';
import { createIamClient } from './iam.client';

function response(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as unknown as Response;
}

/**
 * Routes by URL, because every guarded call now costs TWO requests: the client-credentials
 * grant that mints this server's own bearer, then the call itself. A stub that answered
 * everything identically would let a broken grant pass unnoticed.
 */
function fakeFetch(status: number, body: unknown, tokenStatus = 200): typeof fetch {
  return vi.fn(async (input: Parameters<typeof fetch>[0]) => {
    const url = typeof input === 'string' ? input : String(input);
    if (url.endsWith('/oauth/token')) {
      return response(
        tokenStatus,
        tokenStatus === 200
          ? { access_token: 'svc-bearer', token_type: 'Bearer', expires_in: 3600 }
          : { error: 'invalid_client' },
      );
    }
    return response(status, body);
  }) as unknown as typeof fetch;
}

describe('createIamClient', () => {
  describe('introspectToken', () => {
    it('authenticates itself with its OWN bearer, not Basic, and normalizes the response', async () => {
      const fetchImpl = fakeFetch(200, {
        active: true,
        sub: 'account-123',
        sub_type: 'user',
        scope: 'read write',
        aud: 'taskmanager',
      });
      const client = createIamClient({
        apiBase: 'https://auth.vipper.network/api/v1/',
        clientId: 'cid',
        clientSecret: 'csecret',
        fetch: fetchImpl,
      });

      const result = await client.introspectToken('vipr_abc');

      // The grant comes first, form-encoded, then the introspection presents what it returned.
      // vipper.iam's introspect route sits behind its OidcAuthGuard and rejects Basic with
      // `401 Missing bearer token` — which is what stopped every sync reaching the server.
      expect(fetchImpl).toHaveBeenNthCalledWith(
        1,
        'https://auth.vipper.network/api/v1/oauth/token',
        expect.objectContaining({
          method: 'POST',
          body: 'grant_type=client_credentials&client_id=cid&client_secret=csecret',
        }),
      );
      expect(fetchImpl).toHaveBeenNthCalledWith(
        2,
        'https://auth.vipper.network/api/v1/oauth/introspect',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({ Authorization: 'Bearer svc-bearer' }),
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
        apiBase: 'https://auth.vipper.network/api/v1',
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
        apiBase: 'https://auth.vipper.network/api/v1',
        clientId: 'cid',
        clientSecret: 'csecret',
        fetch: fakeFetch(500, { error: 'boom' }),
      });

      await expect(client.introspectToken('t')).rejects.toThrow(/introspection failed \(500/);
    });

    it('says the grant failed when the service-account credentials are wrong', async () => {
      // The commonest cause: a guessed client id. vipper.iam GENERATES it (`svc_…`).
      const client = createIamClient({
        apiBase: 'https://auth.vipper.network/api/v1',
        clientId: 'taskmanager-api',
        clientSecret: 'csecret',
        fetch: fakeFetch(200, { active: true }, 401),
      });

      await expect(client.introspectToken('t')).rejects.toThrow(
        /client-credentials grant failed \(401/,
      );
    });

    it('mints its bearer once and reuses it while it is still valid', async () => {
      const fetchImpl = fakeFetch(200, { active: true, sub: 'a' });
      const client = createIamClient({
        apiBase: 'https://auth.vipper.network/api/v1',
        clientId: 'cid',
        clientSecret: 'csecret',
        fetch: fetchImpl,
      });

      await client.introspectToken('one');
      await client.introspectToken('two');

      const grants = (fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock.calls.filter(
        (call) => String(call[0]).endsWith('/oauth/token'),
      );
      expect(grants).toHaveLength(1);
    });
  });

  describe('authorize', () => {
    it('presents the caller token as the bearer and forwards the decision request', async () => {
      const fetchImpl = fakeFetch(200, { allowed: true, scopes: ['read'] });
      const client = createIamClient({
        apiBase: 'https://auth.vipper.network/api/v1',
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
        'https://auth.vipper.network/api/v1/authorize',
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
        apiBase: 'https://auth.vipper.network/api/v1',
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
