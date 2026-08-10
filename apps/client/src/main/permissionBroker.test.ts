/**
 * Unit tests for the permission broker's HTTP contract: it must authenticate,
 * pass the request to the decider, and return the decision as JSON. We drive it
 * with a stub decider and a real `fetch` over the loopback port it binds.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { PermissionBroker, type PermissionDecisionResult } from './permissionBroker';

let broker: PermissionBroker | null = null;
afterEach(() => {
  broker?.close();
  broker = null;
});

async function post(
  url: string,
  body: unknown,
  headers: Record<string, string>,
): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`${url}/decide`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

describe('PermissionBroker', () => {
  it('rejects a request without the bearer token', async () => {
    broker = new PermissionBroker(async () => ({ behavior: 'allow', updatedInput: {} }));
    const { url } = await broker.start();
    const { status } = await post(url, { toolName: 'Bash', input: {} }, {});
    expect(status).toBe(401);
  });

  it('passes the decoded request to the decider and returns its decision', async () => {
    let seen: unknown = null;
    const decision: PermissionDecisionResult = { behavior: 'deny', message: 'nope' };
    broker = new PermissionBroker(async (req) => {
      seen = req;
      return decision;
    });
    const { url, token } = await broker.start();

    const { status, json } = await post(
      url,
      { toolName: 'Bash', input: { command: 'git push' } },
      { authorization: `Bearer ${token}`, 'x-run-id': 'run-42' },
    );

    expect(status).toBe(200);
    expect(json).toEqual(decision);
    expect(seen).toEqual({ runId: 'run-42', toolName: 'Bash', input: { command: 'git push' } });
  });

  it('fails safe (deny) when the decider throws', async () => {
    broker = new PermissionBroker(async () => {
      throw new Error('boom');
    });
    const { url, token } = await broker.start();
    const { json } = await post(
      url,
      { toolName: 'Bash', input: {} },
      { authorization: `Bearer ${token}` },
    );
    expect((json as { behavior: string }).behavior).toBe('deny');
  });
});
