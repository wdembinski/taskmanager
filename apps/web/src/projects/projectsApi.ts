/**
 * The browser's own caller for `TicketsController` (`apps/server/src/tickets`) — the
 * server's authoritative Project/Task writes, as opposed to the mirror's read-only
 * `GET /v1/board`. Plain `fetch`, not `HttpTransport.invoke`: these are synchronous REST
 * writes straight to the server's own store, not commands relayed to a desktop Client, so
 * there is nothing to poll a result for and no desktop needs to be online.
 *
 * Scoped to what a browser may create: only `kind: 'ticket'` projects (the server itself
 * refuses any other kind — `TicketsService.createProject` — since a `plan`/`agent` project
 * is a directory on some machine, and there is no machine on the other end of an HTTP
 * request to put one on). See `test/shell-parity.test.ts` for the guard that keeps AGENT
 * project writes off the web; this file is the other half of that boundary, the half that
 * is allowed.
 *
 * A write here bumps the same `rowVersion` a desktop-pushed sync delta does, so the next
 * `GET /v1/board` poll picks it up unprompted — `cloudBoardStore.mergeProject` is only the
 * optimistic head start.
 */
import type { AddProjectInput, Project, ProjectPatch } from '@tm/shared/model';

export interface ProjectsApiDeps {
  /** The `@tm/server` root — no trailing slash. */
  apiBase: string;
  getAccessToken: () => Promise<string | null>;
  fetchImpl?: typeof fetch;
}

export function createProject(deps: ProjectsApiDeps, input: AddProjectInput): Promise<Project> {
  return send(deps, 'POST', '/v1/projects', input);
}

export function updateProject(
  deps: ProjectsApiDeps,
  id: string,
  patch: ProjectPatch,
): Promise<Project> {
  return send(deps, 'PATCH', `/v1/projects/${encodeURIComponent(id)}`, patch);
}

async function send<T>(
  deps: ProjectsApiDeps,
  method: string,
  path: string,
  body: unknown,
): Promise<T> {
  const token = await deps.getAccessToken();
  if (!token) throw new Error('Not signed in to vipper.iam.');

  const fetchImpl = deps.fetchImpl ?? fetch;
  const res = await fetchImpl(`${deps.apiBase}${path}`, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await errorMessage(res));
  return (await res.json()) as T;
}

/** Nest's default exception filter answers `{ message, statusCode, error }` — read the
 *  sentence a `BadRequestException` actually named (e.g. "title is required.") rather than
 *  just the status code, and fall back to it when the body isn't that shape. */
async function errorMessage(res: Response): Promise<string> {
  try {
    const body: unknown = await res.clone().json();
    if (body && typeof body === 'object' && 'message' in body) {
      const message = (body as { message: unknown }).message;
      if (typeof message === 'string') return message;
      if (Array.isArray(message) && message.every((m) => typeof m === 'string')) {
        return message.join(' ');
      }
    }
  } catch {
    // Not a JSON body — fall through to the status line below.
  }
  return `${res.status} ${res.statusText}`;
}
