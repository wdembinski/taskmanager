/**
 * The browser's own caller for `AgentsController` (`apps/server/src/agents`) — agent
 * profiles and the durable assignment queue (cloud as central control for projects, step 5).
 * Plain `fetch`, not `HttpTransport.invoke`: there is no IPC channel for `/v1/assignments`
 * (see `packages/shared/src/ipc.ts`'s `IpcApi`), because an assignment has no desktop-side
 * row to relay through — it lives on the server only, for any desktop serving the project
 * to claim whenever it next polls (`apps/client/src/main/assignmentPoller.ts`). Agent
 * profiles DO have IPC channels now (desktop Settings writes them that way, step 7), but
 * this module still reads them over the same REST surface Fleet already used, rather than
 * `useTransport()`, so Fleet stays one self-contained polling module.
 */
import type {
  AgentProfile,
  Assignment,
  AssignmentStatus,
  CreateAssignmentInput,
} from '@tm/shared/agent';

/** What every call here sends itself over — the server's own base URL and a bearer token,
 *  not `HttpTransport.invoke` (see this file's own docstring for why). */
export interface AgentsApiDeps {
  /** The `@tm/server` root — no trailing slash. */
  apiBase: string;
  getAccessToken: () => Promise<string | null>;
  fetchImpl?: typeof fetch;
}

/** Every agent profile on the account — the Fleet view's "which agents are configured",
 *  and the assign picker's own list. Read-only here: creating/editing a profile is desktop
 *  Settings' job (a later step of this same plan), not the web's. */
export function listAgentProfiles(deps: AgentsApiDeps): Promise<AgentProfile[]> {
  return send(deps, 'GET', '/v1/agent-profiles');
}

export interface ListAssignmentsQuery {
  status?: AssignmentStatus;
  projectId?: string;
}

/** Assignments across the account, optionally narrowed to one status and/or project. No
 *  query narrows to one ticket — the server doesn't index on `ticketId` — so a caller that
 *  wants one ticket's history filters the `projectId` result itself. */
export function listAssignments(
  deps: AgentsApiDeps,
  query: ListAssignmentsQuery = {},
): Promise<Assignment[]> {
  const params = new URLSearchParams();
  if (query.status) params.set('status', query.status);
  if (query.projectId) params.set('projectId', query.projectId);
  const qs = params.toString();
  return send(deps, 'GET', `/v1/assignments${qs ? `?${qs}` : ''}`);
}

/** Queue a ticket against a profile — the "assign agent to this ticket" action. Lands as
 *  `status: 'queued'`; any desktop serving `input.projectId` picks it up on its next poll. */
export function createAssignment(
  deps: AgentsApiDeps,
  input: CreateAssignmentInput,
): Promise<Assignment> {
  return send(deps, 'POST', '/v1/assignments', input);
}

async function send<T>(
  deps: AgentsApiDeps,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const token = await deps.getAccessToken();
  if (!token) throw new Error('Not signed in to vipper.iam.');

  const fetchImpl = deps.fetchImpl ?? fetch;
  const res = await fetchImpl(`${deps.apiBase}${path}`, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) throw new Error(await errorMessage(res));
  return (await res.json()) as T;
}

/** Nest's default exception filter answers `{ message, statusCode, error }` — read the
 *  sentence a `BadRequestException` actually named rather than just the status code, and
 *  fall back to it when the body isn't that shape. */
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
