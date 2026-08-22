import { describe, expect, it, vi } from 'vitest';
import type { Project, Task } from '@tm/shared/model';
import {
  createProject,
  createTicket,
  updateProject,
  updateTicket,
  type ProjectsApiDeps,
} from './projectsApi';

function fakeResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    json: async () => body,
    clone() {
      return fakeResponse(status, body);
    },
  };
}

function deps(fetchImpl: typeof fetch, token: string | null = 'tok'): ProjectsApiDeps {
  return { apiBase: 'https://api.example.com', getAccessToken: async () => token, fetchImpl };
}

const project: Project = {
  id: 'p1',
  name: 'Widgets',
  path: '',
  planPath: '',
  kind: 'ticket',
  ticketPrefix: 'WID',
  createdAt: 0,
} as Project;

describe('createProject', () => {
  it('POSTs to /v1/projects with a bearer token and returns the created row', async () => {
    const fetchImpl = vi.fn(async () => fakeResponse(201, project));
    const result = await createProject(deps(fetchImpl as unknown as typeof fetch), {
      name: 'Widgets',
      path: '',
      kind: 'ticket',
      ticketPrefix: 'WID',
    });

    expect(result).toEqual(project);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.example.com/v1/projects');
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({ authorization: 'Bearer tok' });
    expect(JSON.parse(init.body as string)).toEqual({
      name: 'Widgets',
      path: '',
      kind: 'ticket',
      ticketPrefix: 'WID',
    });
  });

  it('rejects with the server’s own message on a refusal', async () => {
    const fetchImpl = vi.fn(async () =>
      fakeResponse(400, { statusCode: 400, message: 'title is required.' }),
    );
    await expect(
      createProject(deps(fetchImpl as unknown as typeof fetch), { name: '', path: '' }),
    ).rejects.toThrow('title is required.');
  });

  it('falls back to the status line when the error body is not the expected shape', async () => {
    const fetchImpl = vi.fn(async () => fakeResponse(500, 'oops'));
    await expect(
      createProject(deps(fetchImpl as unknown as typeof fetch), { name: 'x', path: '' }),
    ).rejects.toThrow('500 Error');
  });

  it('refuses before the network when nobody is signed in', async () => {
    const fetchImpl = vi.fn(async () => fakeResponse(200, project));
    await expect(
      createProject(deps(fetchImpl as unknown as typeof fetch, null), { name: 'x', path: '' }),
    ).rejects.toThrow('Not signed in');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('updateProject', () => {
  it('PATCHes /v1/projects/:id', async () => {
    const fetchImpl = vi.fn(async () => fakeResponse(200, { ...project, name: 'Gadgets' }));
    const result = await updateProject(deps(fetchImpl as unknown as typeof fetch), 'p1', {
      name: 'Gadgets',
    });

    expect(result.name).toBe('Gadgets');
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.example.com/v1/projects/p1');
    expect(init.method).toBe('PATCH');
  });
});

const ticket = {
  id: 't1',
  projectId: 'p1',
  phase: '',
  title: 'Fix the header',
  status: 'pending',
  sessionId: null,
  order: 0,
  source: 'ticket',
  ticketKey: 'WID-1',
  ticketNumber: 1,
  issueType: 'task',
} as Task;

describe('createTicket', () => {
  it('POSTs to /v1/projects/:projectId/tickets and returns the created row', async () => {
    const fetchImpl = vi.fn(async () => fakeResponse(201, ticket));
    const result = await createTicket(deps(fetchImpl as unknown as typeof fetch), 'p1', {
      title: 'Fix the header',
    });

    expect(result).toEqual(ticket);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.example.com/v1/projects/p1/tickets');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ title: 'Fix the header' });
  });

  it('rejects with the server’s own message on a refusal', async () => {
    const fetchImpl = vi.fn(async () =>
      fakeResponse(400, { statusCode: 400, message: 'title is required.' }),
    );
    await expect(
      createTicket(deps(fetchImpl as unknown as typeof fetch), 'p1', { title: '' }),
    ).rejects.toThrow('title is required.');
  });
});

describe('updateTicket', () => {
  it('PATCHes /v1/tickets/:id', async () => {
    const fetchImpl = vi.fn(async () => fakeResponse(200, { ...ticket, status: 'done' }));
    const result = await updateTicket(deps(fetchImpl as unknown as typeof fetch), 't1', {
      status: 'done',
    });

    expect(result.status).toBe('done');
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.example.com/v1/tickets/t1');
    expect(init.method).toBe('PATCH');
  });
});
