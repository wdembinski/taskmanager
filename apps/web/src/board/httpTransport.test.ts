import { describe, expect, it, vi } from 'vitest';
import type { IpcApi } from '@tm/shared/ipc';
import { CLOUD_BLOB_MAX_BYTES, type TaskAttachment } from '@tm/shared/attachments';
import type { Automation, AutomationRun } from '@tm/shared/automation';
import { hostOnlyMessage, isRelayable, oversizedAnswerMessage } from '@tm/shared/ipcRelay';
import type { Project } from '@tm/shared/model';
import { DEFAULT_SETTINGS } from '@tm/shared/settings';
import type { RepoSkillSummary, Skill } from '@tm/shared/skills';
import type { WorkflowApplyResult, WorkflowDoc } from '@tm/shared/workflow';
import type { CommandResult } from '@tm/protocol/wire';
import type { ArchiveResult } from '@tm/shared/trackerArchive';
import {
  EMPTY_REVIEW,
  fileFailed,
  fileLoadStarted,
  type ReviewState,
} from '@tm/ui/review/reviewState';
import { fileLoadNotice } from '@tm/ui/review/reviewView';
import { HttpTransport, RPC_TIMEOUT_MS, type HttpTransportDeps } from './httpTransport';

/** One project, for the `skill:listRepo` direct-tier tests. */
function project(overrides: Partial<Project> = {}): Project {
  return {
    id: 'p1',
    name: 'A project',
    path: '',
    planPath: '',
    ticketPrefix: '',
    color: '',
    ...overrides,
  } as Project;
}

/** One automation, for the direct-read and owner-targeted-relay tests below. */
const automation = (over: Partial<Automation> = {}): Automation => ({
  id: 'auto-1',
  revision: 1,
  name: 'Nightly triage',
  enabled: true,
  ownerClientId: null,
  timeZone: 'Europe/Warsaw',
  trigger: { kind: 'schedule', schedule: { type: 'daily', hour: 4, minute: 0 } },
  action: {
    agentProjectId: 'proj-1',
    titleTemplate: 'Nightly triage — {{date}}',
    briefTemplate: '',
    mode: 'acceptEdits',
  },
  enabledAt: 0,
  nextRunAt: null,
  consecutiveFailures: 0,
  createdAt: 0,
  updatedAt: 0,
  ...over,
});

/** One run row, for the `automation:runs` merge tests. */
const automationRun = (over: Partial<AutomationRun> = {}): AutomationRun => ({
  id: 'run-1',
  automationId: 'auto-1',
  revision: 1,
  occurrenceKey: 'manual:x',
  kind: 'manual',
  status: 'started',
  taskId: null,
  runId: null,
  refusal: null,
  skippedCount: 0,
  note: null,
  at: 1,
  ...over,
});

/**
 * A fake server for the owner-targeted relay tests: `GET /v1/automations` answers with
 * whatever the mirror is told to hold, and `POST /v1/commands` records the WHOLE request body
 * — unlike {@link makeServer} below, which only keeps the `command` half — because these tests
 * are about `targetClientId`, the other half of `CommandRequest`.
 */
function makeOwnerServer(automations: Automation[]) {
  const queued: Array<{
    targetClientId: string;
    command: { id: string; kind: string; payload: unknown };
  }> = [];
  const results: CommandResult[] = [];

  const fetchImpl = vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    if (url === 'https://api.example.com/v1/automations') {
      return { ok: true, status: 200, json: async () => ({ automations }) };
    }
    if (url.startsWith('https://api.example.com/v1/commands')) {
      const body = JSON.parse(init!.body!) as (typeof queued)[number];
      queued.push(body);
      return { ok: true, status: 202, json: async () => ({ ok: true }) };
    }
    if (url.startsWith('https://api.example.com/v1/results')) {
      const drained = results.splice(0, results.length);
      return { ok: true, status: 200, json: async () => ({ results: drained, cursor: 'r1' }) };
    }
    throw new Error(`unexpected fetch: ${url}`);
  });

  return {
    fetchImpl,
    queued,
    answer: (commandId: string, result: Omit<CommandResult, 'commandId'>) =>
      results.push({ commandId, ...result }),
  };
}

/** One attachment row, for the two questions this file asks about previewing one. */
const attachment = (over: Partial<TaskAttachment> = {}): TaskAttachment => ({
  id: 'a1',
  taskId: 't1',
  name: 'shot.png',
  fileName: 'shot.png',
  mimeType: 'image/png',
  size: 10,
  createdAt: 1,
  ...over,
});

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

describe('HttpTransport: the direct tier', () => {
  /**
   * `task:create`, `task:setStatus`, `task:move` and `task:setDescription` used to relay —
   * `task:setStatus` as the older, narrower `set-status` command kind that resolved as soon
   * as it was queued, `task:create` as a full `ipc-invoke` round trip. Both needed a desktop
   * Client to have synced at least once (`getTargetClientId`), which is exactly what an
   * account with no desktop yet does not have. They now post straight to the Step 3/4 write
   * endpoints instead, so none of the four ever touches `POST /v1/commands` or needs a
   * `targetClientId` at all.
   */
  it('posts task:create to POST /v1/tasks and resolves with the real row', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({ id: 'real-1', title: 'New card' }),
    });
    const { transport } = makeTransport({ fetchImpl: fetchImpl as unknown as typeof fetch });

    const call = transport.invoke('task:create', 'personal', {
      title: 'New card',
      phase: 'Phase 1',
      type: 'bug',
      description: 'what it is about',
      projectTagId: 'proj-1',
    });

    await expect(call).resolves.toEqual({ id: 'real-1', title: 'New card' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://api.example.com/v1/tasks');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({
      projectId: 'personal',
      title: 'New card',
      phase: 'Phase 1',
      type: 'bug',
      description: 'what it is about',
      projectTagId: 'proj-1',
    });
    expect(init.headers.authorization).toBe('Bearer token');
  });

  it('patches task:setStatus to PATCH /v1/tasks/:id', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ id: 't1', status: 'in-progress' }),
    });
    const { transport } = makeTransport({ fetchImpl: fetchImpl as unknown as typeof fetch });

    await expect(transport.invoke('task:setStatus', 't1', 'in-progress')).resolves.toEqual({
      id: 't1',
      status: 'in-progress',
    });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://api.example.com/v1/tasks/t1');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body)).toEqual({ status: 'in-progress' });
  });

  it('patches task:move to PATCH /v1/tasks/:id', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ id: 't1', status: 'done' }),
    });
    const { transport } = makeTransport({ fetchImpl: fetchImpl as unknown as typeof fetch });

    await expect(transport.invoke('task:move', 't1', 'done')).resolves.toEqual({
      id: 't1',
      status: 'done',
    });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://api.example.com/v1/tasks/t1');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body)).toEqual({ toColumn: 'done' });
  });

  it('patches task:setDescription to PATCH /v1/tasks/:id', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ id: 't1', externalDescription: 'new brief' }),
    });
    const { transport } = makeTransport({ fetchImpl: fetchImpl as unknown as typeof fetch });

    await expect(transport.invoke('task:setDescription', 't1', 'new brief')).resolves.toEqual({
      id: 't1',
      externalDescription: 'new brief',
    });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://api.example.com/v1/tasks/t1');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body)).toEqual({ description: 'new brief' });
  });

  it('posts project:add to POST /v1/projects and wraps the row as ProjectWithTasks', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({ id: 'proj-real', name: 'New project', path: '/repo' }),
    });
    const { transport } = makeTransport({ fetchImpl: fetchImpl as unknown as typeof fetch });

    const call = transport.invoke('project:add', { path: '/repo', name: 'New project' });

    await expect(call).resolves.toEqual({
      project: { id: 'proj-real', name: 'New project', path: '/repo' },
      tasks: [],
    });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://api.example.com/v1/projects');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ path: '/repo', name: 'New project' });
  });

  it('patches project:update to PATCH /v1/projects/:id', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ id: 'proj-1', name: 'Renamed' }),
    });
    const { transport } = makeTransport({ fetchImpl: fetchImpl as unknown as typeof fetch });

    await expect(
      transport.invoke('project:update', 'proj-1', { name: 'Renamed' }),
    ).resolves.toEqual({ id: 'proj-1', name: 'Renamed' });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://api.example.com/v1/projects/proj-1');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body)).toEqual({ name: 'Renamed' });
  });

  it('deletes project:remove at DELETE /v1/projects/:id with no body', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 204 });
    const { transport } = makeTransport({ fetchImpl: fetchImpl as unknown as typeof fetch });

    await expect(transport.invoke('project:remove', 'proj-1')).resolves.toBeUndefined();
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://api.example.com/v1/projects/proj-1');
    expect(init.method).toBe('DELETE');
    expect(init.body).toBeUndefined();
  });

  it('reads settings:get from GET /v1/settings and unwraps the blob', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ settings: DEFAULT_SETTINGS }),
    });
    const { transport } = makeTransport({ fetchImpl: fetchImpl as unknown as typeof fetch });

    await expect(transport.invoke('settings:get')).resolves.toEqual(DEFAULT_SETTINGS);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://api.example.com/v1/settings');
    expect(init.method).toBeUndefined(); // a GET
    expect(init.headers.authorization).toBe('Bearer token');
  });

  it('writes settings:save to PUT /v1/settings with the whole blob', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
    const { transport } = makeTransport({ fetchImpl: fetchImpl as unknown as typeof fetch });

    await expect(
      transport.invoke('settings:save', { ...DEFAULT_SETTINGS, branchPrefix: 'wd' }),
    ).resolves.toBeUndefined();
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://api.example.com/v1/settings');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body)).toEqual({ ...DEFAULT_SETTINGS, branchPrefix: 'wd' });
  });

  it('reads and writes settings with no desktop Client ever synced', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ settings: DEFAULT_SETTINGS }),
    });
    const { transport } = makeTransport({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      getTargetClientId: () => null,
    });

    await expect(transport.invoke('settings:get')).resolves.toEqual(DEFAULT_SETTINGS);
  });

  it('works with no desktop Client ever synced, unlike the relayed tier', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ id: 't1', status: 'done' }),
    });
    const { transport } = makeTransport({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      getTargetClientId: () => null,
    });

    await expect(transport.invoke('task:setStatus', 't1', 'done')).resolves.toEqual({
      id: 't1',
      status: 'done',
    });
  });

  it('rejects when the write endpoint itself fails', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 500, statusText: 'err' });
    const { transport } = makeTransport({ fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(transport.invoke('task:setStatus', 't1', 'done')).rejects.toThrow(
      /request failed/,
    );
  });

  it('refuses to send when signed out', async () => {
    const fetchImpl = vi.fn();
    const { transport } = makeTransport({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      getAccessToken: async () => null,
    });
    await expect(transport.invoke('task:setStatus', 't1', 'done')).rejects.toThrow(
      /not signed in/i,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('reads skill:list from GET /v1/skills with no desktop on record', async () => {
    const skill: Skill = {
      id: 's1',
      name: 'release-notes',
      description: 'Draft release notes',
      body: '# body',
      createdAt: 1,
      updatedAt: 1,
    };
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ skills: [skill], deletedSkillIds: [] }),
    });
    const { transport } = makeTransport({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      getTargetClientId: () => null,
    });

    await expect(transport.invoke('skill:list')).resolves.toEqual([skill]);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://api.example.com/v1/skills');
    expect(init.method).toBeUndefined(); // a GET
    expect(init.headers.authorization).toBe('Bearer token');
  });

  it("reads skill:listRepo from the mirrored project's own repoSkills, with no network call", async () => {
    const summary: RepoSkillSummary = {
      projectId: 'p1',
      name: 'deploy',
      description: 'How to deploy this repo',
      path: '.claude/skills/deploy/SKILL.md',
    };
    const fetchImpl = vi.fn();
    const { transport } = makeTransport({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      getProject: (id) => (id === 'p1' ? project({ id: 'p1', repoSkills: [summary] }) : undefined),
    });

    await expect(transport.invoke('skill:listRepo', 'p1')).resolves.toEqual([summary]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('answers [] for skill:listRepo on a project the mirror has never heard of', async () => {
    const fetchImpl = vi.fn();
    const { transport } = makeTransport({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      getProject: () => undefined,
    });

    await expect(transport.invoke('skill:listRepo', 'unknown')).resolves.toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('reads workflow:list from GET /v1/workflows with no desktop on record', async () => {
    const workflow: WorkflowDoc = {
      version: 1,
      id: 'w1',
      name: 'Release checklist',
      steps: [],
    };
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ workflows: [workflow], deletedWorkflowIds: [] }),
    });
    const { transport } = makeTransport({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      getTargetClientId: () => null,
    });

    await expect(transport.invoke('workflow:list')).resolves.toEqual([workflow]);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://api.example.com/v1/workflows');
    expect(init.method).toBeUndefined(); // a GET
    expect(init.headers.authorization).toBe('Bearer token');
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
   * The acceptance test for F7.12 step 1: attaching a skill from the web is a relayed
   * `ipc-invoke` the DESKTOP's own `task:setSkillRefs` handler answers, same as any other
   * card edit this app has no local truth for — it lands on the target Client's card, not
   * on some cloud-side stand-in for one.
   */
  it('relays task:setSkillRefs and resolves with the desktop’s updated task', async () => {
    const server = makeServer();
    const { transport } = makeTransport({
      fetchImpl: server.fetchImpl as unknown as typeof fetch,
      newCommandId: () => 'cmd-9',
    });

    const call = transport.invoke('task:setSkillRefs', 't1', ['lib:a', 'repo:b']);
    server.answer('cmd-9', {
      ok: true,
      value: { id: 't1', skillRefs: ['lib:a', 'repo:b'] },
    });

    await expect(call).resolves.toEqual({ id: 't1', skillRefs: ['lib:a', 'repo:b'] });
    expect(server.queued).toHaveLength(1);
    expect(server.queued[0]).toMatchObject({
      id: 'cmd-9',
      kind: 'ipc-invoke',
      payload: { channel: 'task:setSkillRefs', args: ['t1', ['lib:a', 'repo:b']] },
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

  /**
   * `workflow:apply` always relays — see the docstring's "Three tiers now": only the
   * desktop that owns the store can turn a workflow into the card's own steps.
   */
  it('relays workflow:apply and resolves with the desktop’s result', async () => {
    const server = makeServer();
    const { transport } = makeTransport({
      fetchImpl: server.fetchImpl as unknown as typeof fetch,
      newCommandId: () => 'cmd-11',
    });

    const call = transport.invoke('workflow:apply', 't1', 'w1');
    const result: WorkflowApplyResult = { ok: true, steps: [] };
    server.answer('cmd-11', { ok: true, value: result });

    await expect(call).resolves.toEqual(result);
    expect(server.queued).toHaveLength(1);
    expect(server.queued[0]).toMatchObject({
      id: 'cmd-11',
      kind: 'ipc-invoke',
      payload: { channel: 'workflow:apply', args: ['t1', 'w1'] },
    });
  });

  it('rejects with the desktop’s own message when the handler failed', async () => {
    const server = makeServer();
    const { transport } = makeTransport({
      fetchImpl: server.fetchImpl as unknown as typeof fetch,
      newCommandId: () => 'cmd-1',
    });

    // A wall the human still has to clear, deliberately. A usage limit no longer REJECTS
    // `task:run` — it parks the card and resolves with a `{ refused }` outcome — so wearing
    // one here would illustrate an answer the desktop cannot send.
    const call = transport.invoke('task:run', 't1');
    server.answer('cmd-1', { ok: false, error: 'An agent is already working on this card.' });

    await expect(call).rejects.toThrow('An agent is already working on this card.');
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

describe('HttpTransport: onPendingChange', () => {
  it('counts up to 1 the moment a relayed call is queued', async () => {
    const server = makeServer();
    const { transport } = makeTransport({
      fetchImpl: server.fetchImpl as unknown as typeof fetch,
      newCommandId: () => 'cmd-1',
    });
    const seen: number[] = [];
    transport.onPendingChange((n) => seen.push(n));

    const call = transport.invoke('board:tasks');
    expect(seen).toEqual([1]);

    server.answer('cmd-1', { ok: true, value: [] });
    await call;
    expect(seen).toEqual([1, 0]);
  });

  it('drops back to 0 when the send itself fails, before any result could land', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 500, statusText: 'err' });
    const { transport } = makeTransport({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const seen: number[] = [];
    transport.onPendingChange((n) => seen.push(n));

    await expect(transport.invoke('board:tasks')).rejects.toThrow();
    expect(seen).toEqual([1, 0]);
  });

  it('reports 0 on dispose, before clearing its own listeners', async () => {
    const server = makeServer();
    const { transport } = makeTransport({
      fetchImpl: server.fetchImpl as unknown as typeof fetch,
    });
    const seen: number[] = [];
    transport.onPendingChange((n) => seen.push(n));

    const call = transport.invoke('board:tasks');
    const settled = call.catch(() => undefined);
    transport.dispose();
    await settled;
    expect(seen).toEqual([1, 0]);
  });

  it('stops notifying once unsubscribed', async () => {
    const server = makeServer();
    const { transport } = makeTransport({
      fetchImpl: server.fetchImpl as unknown as typeof fetch,
      newCommandId: () => 'cmd-1',
    });
    const seen: number[] = [];
    const unsubscribe = transport.onPendingChange((n) => seen.push(n));
    unsubscribe();

    const call = transport.invoke('board:tasks');
    server.answer('cmd-1', { ok: true, value: [] });
    await call;

    expect(seen).toEqual([]);
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
    {
      channel: 'skill:import',
      call: () => t().invoke('skill:import', { source: 'text', text: '' }),
      says: /file picker/,
    },
    {
      channel: 'skill:export',
      call: () => t().invoke('skill:export', ['s1']),
      says: /file picker/,
    },
    {
      channel: 'workflow:import',
      call: () => t().invoke('workflow:import', { source: 'text', text: '' }),
      says: /file picker/,
    },
    {
      channel: 'workflow:export',
      call: () => t().invoke('workflow:export', 'w1'),
      says: /file picker/,
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
    { channel: 'project:hasReleaseDoc', call: (x) => x.invoke('project:hasReleaseDoc', 'p1') },
    { channel: 'jira:priorities', call: (x) => x.invoke('jira:priorities') },
    { channel: 'jira:fetchComments', call: (x) => x.invoke('jira:fetchComments', 't1') },
    { channel: 'jira:markRead', call: (x) => x.invoke('jira:markRead', 't1') },
    { channel: 'task:setPriority', call: (x) => x.invoke('task:setPriority', 't1', 'High') },
    { channel: 'task:chat', call: (x) => x.invoke('task:chat', 't1', 'hello') },
    { channel: 'task:run', call: (x) => x.invoke('task:run', 't1') },
    {
      channel: 'skill:save',
      call: (x) =>
        x.invoke('skill:save', { name: 'deploy', description: 'How to deploy', body: '# body' }),
    },
    { channel: 'skill:delete', call: (x) => x.invoke('skill:delete', 's1') },
    { channel: 'skill:getRepo', call: (x) => x.invoke('skill:getRepo', 'p1', 'deploy') },
    { channel: 'attachment:add', call: (x) => x.invoke('attachment:add', 't1', ['/tmp/a']) },
    {
      channel: 'workflow:save',
      call: (x) => x.invoke('workflow:save', { version: 1, name: 'Release checklist', steps: [] }),
    },
    { channel: 'workflow:delete', call: (x) => x.invoke('workflow:delete', 'w1') },
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

describe("HttpTransport: the review pane's channels", () => {
  /**
   * F6.13: the review pane's eight channels — the diff reads and the comment CRUD/send —
   * relay to the desktop the same as any other `ipc-invoke` channel. Pinned down here,
   * channel by channel, rather than trusted to follow from `ipcRelay.ts`'s own exhaustiveness
   * check, because this table is what a reviewer actually reads to confirm the pane works
   * over the relay at all.
   */
  const REVIEW: Array<{
    channel: keyof IpcApi;
    args: readonly unknown[];
    call: (x: HttpTransport) => Promise<unknown>;
  }> = [
    {
      channel: 'task:diffSummary',
      args: ['t1'],
      call: (x) => x.invoke('task:diffSummary', 't1'),
    },
    {
      channel: 'task:diffFile',
      args: ['t1', 'd1', 'a.ts'],
      call: (x) => x.invoke('task:diffFile', 't1', 'd1', 'a.ts'),
    },
    {
      channel: 'task:diffImage',
      args: ['t1', 'd1', 'a.png'],
      call: (x) => x.invoke('task:diffImage', 't1', 'd1', 'a.png'),
    },
    { channel: 'review:list', args: ['t1'], call: (x) => x.invoke('review:list', 't1') },
    {
      channel: 'review:add',
      args: [{ taskId: 't1', diffId: 'd1', path: 'a.ts', side: 'new', line: 3, body: 'lgtm' }],
      call: (x) =>
        x.invoke('review:add', {
          taskId: 't1',
          diffId: 'd1',
          path: 'a.ts',
          side: 'new',
          line: 3,
          body: 'lgtm',
        }),
    },
    {
      channel: 'review:update',
      args: ['t1', 'c1', { body: 'edited' }],
      call: (x) => x.invoke('review:update', 't1', 'c1', { body: 'edited' }),
    },
    {
      channel: 'review:delete',
      args: ['t1', 'c1'],
      call: (x) => x.invoke('review:delete', 't1', 'c1'),
    },
    {
      channel: 'review:send',
      args: ['t1', 'looks good'],
      call: (x) => x.invoke('review:send', 't1', 'looks good'),
    },
  ];

  for (const { channel, args, call } of REVIEW) {
    it(`relays ${channel} over the wire`, async () => {
      expect(isRelayable(channel)).toBe(true);

      const server = makeServer();
      const { transport } = makeTransport({
        fetchImpl: server.fetchImpl as unknown as typeof fetch,
        newCommandId: () => 'cmd-1',
      });

      let rejection: Error | undefined;
      const pending = call(transport).catch((e: Error) => {
        rejection = e;
      });
      server.answer('cmd-1', { ok: true, value: null });
      await pending;

      expect(rejection?.message).not.toBe(hostOnlyMessage(channel));
      expect(server.queued).toHaveLength(1);
      expect(server.queued[0]).toMatchObject({
        kind: 'ipc-invoke',
        payload: { channel, args },
      });
    });
  }

  /**
   * The acceptance test F6.13 asks for: a relayed `task:diffFile` answer the server refused
   * as too large to ever send becomes the pane's own `tooLargeForBrowser` state, not a plain
   * `idle` error the pane would otherwise offer to retry forever.
   */
  it('classifies an oversized task:diffFile answer as tooLargeForBrowser', async () => {
    const server = makeServer();
    const { transport } = makeTransport({
      fetchImpl: server.fetchImpl as unknown as typeof fetch,
      newCommandId: () => 'cmd-1',
    });

    const pending = transport.invoke('task:diffFile', 't1', 'd1', 'a.ts');
    server.answer('cmd-1', { ok: false, error: oversizedAnswerMessage(2_000_000) });

    const error = await pending.then(
      () => {
        throw new Error('expected task:diffFile to reject');
      },
      (e: unknown) => e as Error,
    );

    let state: ReviewState = {
      ...EMPTY_REVIEW,
      taskId: 'a',
      diffId: 'd1',
      summary: {
        status: 'ok',
        summary: {
          diffId: 'd1',
          baseRef: 'main',
          baseSha: 'base-sha',
          headSha: 'head-sha',
          includesWorkingTree: false,
          files: [
            {
              path: 'a.ts',
              status: 'modified',
              additions: 1,
              deletions: 1,
              binary: false,
              image: false,
              bytes: 10,
            },
          ],
          truncated: false,
        },
      },
    };
    state = fileLoadStarted(state, 'a', 'd1', 'a.ts', 1);
    state = fileFailed(state, 'a', 'd1', 'a.ts', 1, error.message);

    expect(state.files['a.ts']).toEqual({ status: 'tooLargeForBrowser', bytes: 2_000_000 });
    expect(fileLoadNotice(state.files['a.ts'])).toContain('too large to send to the browser');
  });
});

describe('HttpTransport: the archive channels', () => {
  /**
   * F14.4: the three archive channels relay to the desktop the same as any other
   * `ipc-invoke` channel, shaped like the review pane's table above.
   */
  const ARCHIVE: Array<{
    channel: keyof IpcApi;
    args: readonly unknown[];
    call: (x: HttpTransport) => Promise<unknown>;
  }> = [
    {
      channel: 'archive:apply',
      args: [{ kind: 'milestone', id: 'm1' }, { kind: 'backlog' }],
      call: (x) => x.invoke('archive:apply', { kind: 'milestone', id: 'm1' }, { kind: 'backlog' }),
    },
    {
      channel: 'archive:restore',
      args: [{ kind: 'milestone', id: 'm1' }],
      call: (x) => x.invoke('archive:restore', { kind: 'milestone', id: 'm1' }),
    },
    {
      channel: 'archive:list',
      args: ['p1'],
      call: (x) => x.invoke('archive:list', 'p1'),
    },
  ];

  for (const { channel, args, call } of ARCHIVE) {
    it(`relays ${channel} over the wire`, async () => {
      expect(isRelayable(channel)).toBe(true);

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
        payload: { channel, args },
      });
    });
  }

  /**
   * `archive:apply`'s refusals come back as data (`ArchiveResult`), not a rejected
   * promise — the relay just carries that value through unchanged.
   */
  it('resolves (not rejects) when the desktop answers with an already-archived refusal', async () => {
    const server = makeServer();
    const { transport } = makeTransport({
      fetchImpl: server.fetchImpl as unknown as typeof fetch,
      newCommandId: () => 'cmd-1',
    });

    const pending = transport.invoke('archive:apply', { kind: 'milestone', id: 'm1' });
    const refusal: ArchiveResult = {
      ok: false,
      reason: 'already-archived',
      message: 'M2 · Review is archived',
    };
    server.answer('cmd-1', { ok: true, value: refusal });

    await expect(pending).resolves.toEqual(refusal);
  });
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
  it('refuses to send a relayed call when no desktop Client has ever synced this account', async () => {
    const { transport, fetchImpl } = makeTransport({ getTargetClientId: () => null });
    await expect(transport.invoke('board:tasks')).rejects.toThrow(/no desktop client/i);
    const commandCalls = fetchImpl.mock.calls.filter(([url]) =>
      String(url).includes('/v1/commands'),
    );
    expect(commandCalls).toHaveLength(0);
  });

  it('refuses to send a relayed call when signed out', async () => {
    const { transport, fetchImpl } = makeTransport({ getAccessToken: async () => null });
    await expect(transport.invoke('board:tasks')).rejects.toThrow(/not signed in/i);
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

  it('says it cannot serve bytes the cloud does not hold, rather than naming a route that 404s', () => {
    // `''` makes the shared strip show the chip and skip the thumbnail. A plausible URL for
    // bytes nobody pushed would look identical on screen and be a claim that was not true —
    // which is the entire reason the desktop's `vipper-attachment://` answer was not copied.
    const { transport } = makeTransport();
    expect(transport.attachmentUrl(attachment({ cloudBlobAt: null }))).toBe('');
    expect(transport.attachmentUrl(attachment({ cloudBlobAt: undefined }))).toBe('');
  });

  it('answers a media-token URL once the cloud holds the bytes and a token has landed', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes('/v1/media-tokens')) {
        return { ok: true, status: 200, json: async () => ({ token: 'mt-1', expiresAt: 601_000 }) };
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    const { transport } = makeTransport({ fetchImpl: fetchImpl as unknown as typeof fetch });

    // The first read has no token yet — one request's worth of `''`, then the picture.
    expect(transport.attachmentUrl(attachment({ cloudBlobAt: 5 }))).toBe('');
    for (let i = 0; i < 10; i += 1) await Promise.resolve();

    expect(transport.attachmentUrl(attachment({ cloudBlobAt: 5 }))).toBe(
      'https://api.example.com/v1/attachments/a1?mt=mt-1',
    );
  });

  it('uploads each picked file, then relays attachment:addUploaded naming the tickets', async () => {
    // The two hops differ in kind on purpose: the BYTES go straight to the server over their
    // own raw route, and only the ticket ids travel on the relay — base64 in a `commands` row
    // would park a picture in what is meant to be an audit trail.
    const server = makeServer();
    let ticket = 0;
    const fetchImpl = vi.fn(async (url: string, init?: { method?: string; body?: unknown }) => {
      if (url.startsWith('https://api.example.com/v1/uploads')) {
        // Captured per request: `json()` is awaited later, so a closure over the counter
        // itself would hand both files whichever id was minted last.
        const id = `up-${(ticket += 1)}`;
        return { ok: true, status: 201, json: async () => ({ id, size: 4, expiresAt: 9 }) };
      }
      return server.fetchImpl(url, init as { method?: string; body?: string });
    });
    const { transport } = makeTransport({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      newCommandId: () => 'cmd-up',
    });

    const files = [
      new File(['abcd'], 'Shot 1.png', { type: 'image/png' }),
      new File(['efgh'], 'notes.txt', { type: '' }),
    ];
    const call = transport.attachFiles('t1', files);

    // Let both uploads and the command post settle before the desktop answers.
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
    server.answer('cmd-up', { ok: true, value: [{ id: 'a1', taskId: 't1', name: 'Shot-1.png' }] });

    await expect(call).resolves.toEqual([{ id: 'a1', taskId: 't1', name: 'Shot-1.png' }]);

    const uploadCalls = fetchImpl.mock.calls.filter(([url]) => String(url).includes('/v1/uploads'));
    expect(uploadCalls).toHaveLength(2);
    expect(String(uploadCalls[0][0])).toContain('name=Shot+1.png');
    expect(String(uploadCalls[0][0])).toContain('type=image%2Fpng');
    // No `type=` for a file the browser could not name — `mimeForExtension` on the desktop is
    // what fills that in, off the name the file arrived with.
    expect(String(uploadCalls[1][0])).not.toContain('type=');
    expect((uploadCalls[0][1] as RequestInit).method).toBe('POST');
    expect(
      ((uploadCalls[0][1] as RequestInit).headers as Record<string, string>)['content-type'],
    ).toBe('application/octet-stream');

    expect(server.queued).toEqual([
      {
        id: 'cmd-up',
        issuedAt: 1000,
        issuedBy: 'web-1',
        kind: 'ipc-invoke',
        payload: {
          channel: 'attachment:addUploaded',
          args: [
            't1',
            [
              { id: 'up-1', fileName: 'Shot 1.png', mimeType: 'image/png' },
              { id: 'up-2', fileName: 'notes.txt', mimeType: null },
            ],
          ],
        },
      },
    ]);
  });

  it('refuses a file over the cloud cap before spending the upload on it', async () => {
    const { transport, fetchImpl } = makeTransport();
    const huge = new File(['x'], 'video.mp4', { type: 'video/mp4' });
    // `File` has no writable size, so this stands in for one the server would 413 anyway.
    Object.defineProperty(huge, 'size', { value: CLOUD_BLOB_MAX_BYTES + 1 });

    await expect(transport.attachFiles('t1', [huge])).rejects.toThrow(/larger than/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('attaches nothing for an empty pick', async () => {
    const { transport, fetchImpl } = makeTransport();
    await expect(transport.attachFiles('t1', [])).resolves.toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('HttpTransport: automation reads (direct tier)', () => {
  it('reads automation:list from GET /v1/automations, never posting a command', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url === 'https://api.example.com/v1/automations') {
        return { ok: true, status: 200, json: async () => ({ automations: [automation()] }) };
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    // No desktop has ever synced this account — the direct tier must still answer.
    const { transport } = makeTransport({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      getTargetClientId: () => null,
    });

    await expect(transport.invoke('automation:list')).resolves.toEqual([automation()]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(String(fetchImpl.mock.calls[0][0])).not.toContain('/v1/commands');
  });

  it('reads automation:runs(id) from GET /v1/automations/:id/runs?limit=', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url === 'https://api.example.com/v1/automations/auto-1/runs?limit=10') {
        return { ok: true, status: 200, json: async () => ({ runs: [automationRun()] }) };
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    const { transport } = makeTransport({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      getTargetClientId: () => null,
    });

    await expect(transport.invoke('automation:runs', 'auto-1', 10)).resolves.toEqual([
      automationRun(),
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(String(fetchImpl.mock.calls[0][0])).not.toContain('/v1/commands');
  });

  it('merges runs(null, limit) newest-first across every automation and honours the cap', async () => {
    const a1 = automation({ id: 'auto-1' });
    const a2 = automation({ id: 'auto-2' });
    const fetchImpl = vi.fn(async (url: string) => {
      if (url === 'https://api.example.com/v1/automations') {
        return { ok: true, status: 200, json: async () => ({ automations: [a1, a2] }) };
      }
      if (url === 'https://api.example.com/v1/automations/auto-1/runs?limit=2') {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            runs: [
              automationRun({ id: 'r1', automationId: 'auto-1', at: 10 }),
              automationRun({ id: 'r2', automationId: 'auto-1', at: 1 }),
            ],
          }),
        };
      }
      if (url === 'https://api.example.com/v1/automations/auto-2/runs?limit=2') {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            runs: [automationRun({ id: 'r3', automationId: 'auto-2', at: 20 })],
          }),
        };
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    const { transport } = makeTransport({ fetchImpl: fetchImpl as unknown as typeof fetch });

    const result = await transport.invoke('automation:runs', null, 2);
    expect(result.map((r) => r.id)).toEqual(['r3', 'r1']);
  });
});

describe('HttpTransport: automation edits relay to the owner', () => {
  it('relays automation:delete to the automation’s owner, not the default target', async () => {
    const server = makeOwnerServer([automation({ id: 'auto-1', ownerClientId: 'desktop-owner' })]);
    const { transport } = makeTransport({
      fetchImpl: server.fetchImpl as unknown as typeof fetch,
      getTargetClientId: () => 'desktop-1',
      newCommandId: () => 'cmd-1',
    });

    const call = transport.invoke('automation:delete', 'auto-1');
    server.answer('cmd-1', { ok: true, value: null });
    await call;

    expect(server.queued).toHaveLength(1);
    expect(server.queued[0].targetClientId).toBe('desktop-owner');
    expect(server.queued[0].targetClientId).not.toBe('desktop-1');
    expect(server.queued[0].command).toMatchObject({
      kind: 'ipc-invoke',
      payload: { channel: 'automation:delete', args: ['auto-1'] },
    });
  });

  it('relays automation:setEnabled to the automation’s owner', async () => {
    const server = makeOwnerServer([automation({ id: 'auto-1', ownerClientId: 'desktop-owner' })]);
    const { transport } = makeTransport({
      fetchImpl: server.fetchImpl as unknown as typeof fetch,
      getTargetClientId: () => 'desktop-1',
      newCommandId: () => 'cmd-1',
    });

    const call = transport.invoke('automation:setEnabled', 'auto-1', false);
    server.answer('cmd-1', { ok: true, value: automation({ id: 'auto-1', enabled: false }) });
    await call;

    expect(server.queued[0].targetClientId).toBe('desktop-owner');
    expect(server.queued[0].command).toMatchObject({
      payload: { channel: 'automation:setEnabled', args: ['auto-1', false] },
    });
  });

  it('relays automation:runNow to the automation’s owner', async () => {
    const server = makeOwnerServer([automation({ id: 'auto-1', ownerClientId: 'desktop-owner' })]);
    const { transport } = makeTransport({
      fetchImpl: server.fetchImpl as unknown as typeof fetch,
      getTargetClientId: () => 'desktop-1',
      newCommandId: () => 'cmd-1',
    });

    const call = transport.invoke('automation:runNow', 'auto-1');
    server.answer('cmd-1', { ok: true, value: automationRun() });
    await call;

    expect(server.queued[0].targetClientId).toBe('desktop-owner');
  });

  it('relays automation:save to the owner recorded in the mirror, not the draft’s own field', async () => {
    const mirrorCopy = automation({ id: 'auto-1', ownerClientId: 'desktop-owner' });
    const draft = automation({ id: 'auto-1', ownerClientId: 'desktop-1', name: 'Edited name' });
    const server = makeOwnerServer([mirrorCopy]);
    const { transport } = makeTransport({
      fetchImpl: server.fetchImpl as unknown as typeof fetch,
      getTargetClientId: () => 'desktop-1',
      newCommandId: () => 'cmd-1',
    });

    const call = transport.invoke('automation:save', draft);
    server.answer('cmd-1', { ok: true, value: draft });
    await call;

    expect(server.queued[0].targetClientId).toBe('desktop-owner');
    expect(server.queued[0].command).toMatchObject({
      payload: { channel: 'automation:save', args: [draft] },
    });
  });

  it('falls back to the default target when the owner is null', async () => {
    const server = makeOwnerServer([automation({ id: 'auto-1', ownerClientId: null })]);
    const { transport } = makeTransport({
      fetchImpl: server.fetchImpl as unknown as typeof fetch,
      getTargetClientId: () => 'desktop-1',
      newCommandId: () => 'cmd-1',
    });

    const call = transport.invoke('automation:setEnabled', 'auto-1', false);
    server.answer('cmd-1', { ok: true, value: automation({ id: 'auto-1', enabled: false }) });
    await call;

    expect(server.queued[0].targetClientId).toBe('desktop-1');
  });

  it('falls back to the default target when save creates a new automation', async () => {
    const server = makeOwnerServer([]); // the mirror has never heard of this id — it's a create.
    const { transport } = makeTransport({
      fetchImpl: server.fetchImpl as unknown as typeof fetch,
      getTargetClientId: () => 'desktop-1',
      newCommandId: () => 'cmd-1',
    });

    const draft = automation({ id: '' });
    const call = transport.invoke('automation:save', draft);
    server.answer('cmd-1', { ok: true, value: automation({ id: 'auto-new' }) });
    await call;

    expect(server.queued[0].targetClientId).toBe('desktop-1');
  });

  it('rejects automation:delete for an id the mirror has never heard of, without posting a command', async () => {
    const server = makeOwnerServer([]);
    const { transport } = makeTransport({ fetchImpl: server.fetchImpl as unknown as typeof fetch });

    await expect(transport.invoke('automation:delete', 'auto-missing')).rejects.toThrow(
      /no longer exists/,
    );
    expect(server.queued).toHaveLength(0);
  });

  it('rejects automation:setEnabled for an id the mirror has never heard of, without posting a command', async () => {
    const server = makeOwnerServer([]);
    const { transport } = makeTransport({ fetchImpl: server.fetchImpl as unknown as typeof fetch });

    await expect(transport.invoke('automation:setEnabled', 'auto-missing', true)).rejects.toThrow(
      /no longer exists/,
    );
    expect(server.queued).toHaveLength(0);
  });

  it('rejects automation:runNow for an id the mirror has never heard of, without posting a command', async () => {
    const server = makeOwnerServer([]);
    const { transport } = makeTransport({ fetchImpl: server.fetchImpl as unknown as typeof fetch });

    await expect(transport.invoke('automation:runNow', 'auto-missing')).rejects.toThrow(
      /no longer exists/,
    );
    expect(server.queued).toHaveLength(0);
  });
});
