/**
 * The desktop main process's own caller for `AgentsController`'s profile routes
 * (`apps/server/src/agents`) — cloud as central control for projects, step 7: desktop
 * Settings manages the same `AgentProfile` rows the web Fleet view (step 6) reads.
 *
 * Plain `fetch` against the cloud server, not the local SQLite `store`: a profile has no
 * desktop-side row (`agentProfile.entity.ts`'s own docstring — "there is no desktop-side
 * row it mirrors"), so there is nothing local to read or write. Same shape as
 * `assignmentPoller.ts`'s own calls, and the web's `agentsApi.ts` (whose `errorMessage`
 * helper this duplicates rather than imports, for the same reason that file gives for
 * duplicating `projectsApi.ts`'s: it's a private helper, not a shared module).
 */
import type { AddAgentProfileInput, AgentProfile, AgentProfilePatch } from '@shared/agent';

export interface AgentProfilesApiDeps {
  baseUrl: string;
  token: string;
  fetchImpl?: typeof fetch;
}

export function listAgentProfiles(deps: AgentProfilesApiDeps): Promise<AgentProfile[]> {
  return send(deps, 'GET', '/v1/agent-profiles');
}

export function addAgentProfile(
  deps: AgentProfilesApiDeps,
  input: AddAgentProfileInput,
): Promise<AgentProfile> {
  return send(deps, 'POST', '/v1/agent-profiles', input);
}

export function updateAgentProfile(
  deps: AgentProfilesApiDeps,
  id: string,
  patch: AgentProfilePatch,
): Promise<AgentProfile> {
  return send(deps, 'PATCH', `/v1/agent-profiles/${id}`, patch);
}

export function removeAgentProfile(deps: AgentProfilesApiDeps, id: string): Promise<void> {
  return send(deps, 'DELETE', `/v1/agent-profiles/${id}`);
}

async function send<T>(
  deps: AgentProfilesApiDeps,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const url = new URL(path, deps.baseUrl);
  const res = await fetchImpl(url.toString(), {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${deps.token}` },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) throw new Error(await errorMessage(res));
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

/** Nest's default exception filter answers `{ message, statusCode, error }` — read the
 *  sentence a `BadRequestException` actually named rather than just the status code. */
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
