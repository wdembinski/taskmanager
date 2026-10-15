/**
 * `CloudWorkflowPusher`, driven by a mocked `fetch` — the same shape
 * `cloudSkillPusher.test.ts` uses, and for the same reason: the module imports no Electron
 * and takes every dependency, so the whole thing runs here.
 *
 * What is worth pinning is the changed-only arithmetic — an edit resends, a no-op does not,
 * a restart's seed read makes an already-mirrored workflow quiet, a delete fires once, a 413
 * sticks until the doc changes — because every one of those is a decision a cache like this
 * lives or dies by. The acceptance test is the second one: scanning twice with nothing
 * changed must send no request at all.
 */
import { describe, expect, it, vi } from 'vitest';
import type { CloudSettings } from '@shared/settings';
import { WORKFLOW_DOC_MAX, type WorkflowDoc } from '@shared/workflow';
import { CloudWorkflowPusher, type CloudWorkflowPusherDeps } from './cloudWorkflowPusher';

const settings = (over: Partial<CloudSettings> = {}): CloudSettings =>
  ({ enabled: true, baseUrl: 'https://api.example.test', ...over }) as CloudSettings;

const workflow = (over: Partial<WorkflowDoc> = {}): WorkflowDoc => ({
  version: 1,
  id: 'w1',
  name: 'Ship it',
  steps: [],
  ...over,
});

const ok = (body: unknown): Response =>
  ({ ok: true, status: 200, statusText: 'OK', json: async () => body }) as Response;
const noContent = (): Response =>
  ({ ok: true, status: 204, statusText: 'No Content', json: async () => ({}) }) as Response;
const fail = (status: number, body: unknown = {}): Response =>
  ({ ok: false, status, statusText: 'nope', json: async () => body }) as Response;

interface Harness {
  pusher: CloudWorkflowPusher;
  fetchImpl: ReturnType<typeof vi.fn>;
  rows: WorkflowDoc[];
  /** Let the fire-and-forget pass run to completion. */
  settle: () => Promise<void>;
}

/**
 * A fetch mock that answers by method: GET (the seed read) returns `seedWorkflows` wrapped
 * in a `WorkflowsResponse`, PUT echoes the doc back (the server's own `put` returns the body
 * it was given), DELETE answers 204 — all overridable per call through `fetchImpl`.
 */
function makeFetch(
  seedWorkflows: WorkflowDoc[],
  fetchImpl?: ReturnType<typeof vi.fn>,
): ReturnType<typeof vi.fn> {
  return (
    fetchImpl ??
    vi.fn(async (_url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      if (method === 'GET') return ok({ workflows: seedWorkflows, deletedWorkflowIds: [] });
      if (method === 'DELETE') return noContent();
      // PUT
      const body = JSON.parse(String(init?.body)) as WorkflowDoc;
      return ok(body);
    })
  );
}

function makePusher(
  rows: WorkflowDoc[],
  over: {
    fetchImpl?: ReturnType<typeof vi.fn>;
    settings?: CloudSettings;
    seedWorkflows?: WorkflowDoc[];
    token?: string | null;
    onAuthRejected?: () => void;
    onIssuesChanged?: () => void;
  } = {},
): Harness {
  const fetchImpl = makeFetch(over.seedWorkflows ?? [], over.fetchImpl);
  const pusher = new CloudWorkflowPusher();
  const deps: CloudWorkflowPusherDeps = {
    getSettings: () => over.settings ?? settings(),
    getAccessToken: async () => (over.token === undefined ? 'token' : over.token),
    listWorkflows: () => rows,
    onAuthRejected: over.onAuthRejected,
    onIssuesChanged: over.onIssuesChanged,
    fetchImpl: fetchImpl as unknown as typeof fetch,
  };
  pusher.configure(deps);
  return {
    pusher,
    fetchImpl,
    rows,
    settle: async () => {
      // Several microtask turns: one pass is seed → token → fetch → json per action.
      for (let i = 0; i < 40; i += 1) await Promise.resolve();
    },
  };
}

describe('CloudWorkflowPusher', () => {
  it('pushes a workflow on the first scan, after seeding from the empty mirror', async () => {
    const h = makePusher([workflow()]);
    h.pusher.scan();
    await h.settle();

    const calls = h.fetchImpl.mock.calls as [string, RequestInit?][];
    expect(calls[0][1]?.method ?? 'GET').toBe('GET');
    expect(calls[0][0]).toContain('/v1/workflows');
    expect(calls[1][0]).toContain('/v1/workflows/w1');
    expect(calls[1][1]?.method).toBe('PUT');
    expect(JSON.parse(String(calls[1][1]?.body))).toEqual(workflow());
  });

  it('sends no request at all on a second scan with nothing changed', async () => {
    const h = makePusher([workflow()]);
    h.pusher.scan();
    await h.settle();
    const callsAfterFirst = h.fetchImpl.mock.calls.length;

    h.pusher.scan();
    await h.settle();

    expect(h.fetchImpl.mock.calls.length).toBe(callsAfterFirst);
  });

  it('re-PUTs only the workflow that was edited', async () => {
    const h = makePusher([workflow(), workflow({ id: 'w2', name: 'Other' })]);
    h.pusher.scan();
    await h.settle();
    const callsAfterFirst = h.fetchImpl.mock.calls.length;

    h.rows[0] = workflow({ name: 'Ship it faster' });
    h.pusher.scan();
    await h.settle();

    const newCalls = h.fetchImpl.mock.calls.slice(callsAfterFirst) as [string, RequestInit?][];
    expect(newCalls).toHaveLength(1);
    expect(newCalls[0][0]).toContain('/v1/workflows/w1');
    expect(newCalls[0][1]?.method).toBe('PUT');
    expect(JSON.parse(String(newCalls[0][1]?.body)).name).toBe('Ship it faster');
  });

  it('does not push a workflow the server already has identical, after a restart', async () => {
    // "Restart" = a fresh instance, which is what re-seeding is for: the cloud already has
    // this exact workflow, so the seed read alone should account for it.
    const h = makePusher([workflow()], { seedWorkflows: [workflow()] });
    h.pusher.scan();
    await h.settle();

    const puts = (h.fetchImpl.mock.calls as [string, RequestInit?][]).filter(
      ([, init]) => init?.method === 'PUT',
    );
    expect(puts).toHaveLength(0);
  });

  it('sends DELETE once for a workflow removed locally, and not again after', async () => {
    const h = makePusher([workflow()]);
    h.pusher.scan();
    await h.settle();

    h.rows.length = 0;
    h.pusher.scan();
    await h.settle();
    const deletesAfterFirstRemoval = (h.fetchImpl.mock.calls as [string, RequestInit?][]).filter(
      ([, init]) => init?.method === 'DELETE',
    );
    expect(deletesAfterFirstRemoval).toHaveLength(1);
    expect(deletesAfterFirstRemoval[0][0]).toContain('/v1/workflows/w1');

    h.pusher.scan();
    await h.settle();
    const deletesAfterSecondScan = (h.fetchImpl.mock.calls as [string, RequestInit?][]).filter(
      ([, init]) => init?.method === 'DELETE',
    );
    expect(deletesAfterSecondScan).toHaveLength(1);
  });

  it('records a 413 as an issue and does not retry it until the workflow changes', async () => {
    const onIssuesChanged = vi.fn();
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      if (method === 'GET') return ok({ workflows: [], deletedWorkflowIds: [] });
      const body = JSON.parse(String(init?.body)) as WorkflowDoc;
      // Only the original (large) name is refused — the edited one below is small.
      if (body.name === 'Small again') return ok(body);
      return fail(413, { message: 'too large to sync (65 KiB > 64 KiB)' });
    });
    const h = makePusher([workflow()], { fetchImpl, onIssuesChanged });

    h.pusher.scan();
    await h.settle();
    expect(onIssuesChanged).toHaveBeenCalledTimes(1);
    expect(h.pusher.listIssues()).toEqual([
      { id: 'w1', bytes: expect.any(Number), message: 'too large to sync (65 KiB > 64 KiB)' },
    ]);
    const putsAfterFirst = fetchImpl.mock.calls.filter(
      ([, init]) => (init as RequestInit | undefined)?.method === 'PUT',
    ).length;

    h.pusher.scan();
    await h.settle();
    const putsAfterSecond = fetchImpl.mock.calls.filter(
      ([, init]) => (init as RequestInit | undefined)?.method === 'PUT',
    ).length;
    expect(putsAfterSecond).toBe(putsAfterFirst);

    // Edited back under budget — retried, and the issue clears.
    h.rows[0] = workflow({ name: 'Small again' });
    h.pusher.scan();
    await h.settle();
    expect(h.pusher.listIssues()).toEqual([]);
    expect(onIssuesChanged).toHaveBeenCalledTimes(2);
  });

  it('falls back to workflowTooLargeMessage when the 413 body has no message', async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      if (method === 'GET') return ok({ workflows: [], deletedWorkflowIds: [] });
      return fail(413, {});
    });
    const big = workflow({ name: 'a'.repeat(WORKFLOW_DOC_MAX) });
    const h = makePusher([big], { fetchImpl });

    h.pusher.scan();
    await h.settle();

    const issues = h.pusher.listIssues();
    expect(issues).toHaveLength(1);
    expect(issues[0].id).toBe('w1');
    expect(issues[0].message).toMatch(/too large to sync \(\d+ KiB > 64 KiB\)/);
  });

  it('reports a 401 as an auth rejection', async () => {
    const onAuthRejected = vi.fn();
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      if (method === 'GET') return ok({ workflows: [], deletedWorkflowIds: [] });
      return fail(401);
    });
    const h = makePusher([workflow()], { fetchImpl, onAuthRejected });

    h.pusher.scan();
    await h.settle();

    expect(onAuthRejected).toHaveBeenCalledTimes(1);
  });

  it('makes no request at all while cloud sync is off', async () => {
    const h = makePusher([workflow()], { settings: settings({ enabled: false }) });
    h.pusher.scan();
    await h.settle();
    expect(h.fetchImpl).not.toHaveBeenCalled();
  });

  it('does nothing once disposed', async () => {
    const h = makePusher([workflow()]);
    h.pusher.dispose();
    h.pusher.scan();
    await h.settle();
    expect(h.fetchImpl).not.toHaveBeenCalled();
  });

  it('gives up on a pass after three failures in a row', async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      if (method === 'GET') return ok({ workflows: [], deletedWorkflowIds: [] });
      return fail(500);
    });
    const rows = Array.from({ length: 10 }, (_, i) => workflow({ id: `w${i}`, name: `wf-${i}` }));
    const h = makePusher(rows, { fetchImpl });

    h.pusher.scan();
    await h.settle();

    const puts = fetchImpl.mock.calls.filter(
      ([, init]) => (init as RequestInit | undefined)?.method === 'PUT',
    );
    expect(puts).toHaveLength(3);
  });
});
