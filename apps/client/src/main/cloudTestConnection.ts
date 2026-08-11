import type { CloudSettings } from '@shared/settings';
import type { JiraTestResult } from '@shared/ipc';

/**
 * "Test connection" for the cloud mirror — the same affordance the JIRA and GitLab panes
 * have, and for a better reason than symmetry.
 *
 * `cloudPoller` is deliberately silent: a failed tick is counted, backed off and retried,
 * never surfaced, because a poll loop that raises a dialog every 2.5s is unusable. The cost
 * is that EVERY misconfiguration looks identical from the app — nothing happens, and nothing
 * says why. Standing this service up hit four of them in a row (a server address that did
 * not resolve, a sign-in that stored no refresh token, an authentication scheme the identity
 * server rejects, and an account with no access) and not one produced a single visible
 * symptom beyond a board that stayed empty.
 *
 * So this walks the same chain the poller walks and reports the FIRST rung that fails, in
 * the user's terms. The stages are ordered so that each one only runs when the one before it
 * proved something, which is what makes the message specific enough to act on rather than
 * "connection failed".
 */
export interface CloudProbeDeps {
  settings: CloudSettings;
  /** The same accessor the poller uses; null when there is nothing to mint a token from. */
  getAccessToken: () => Promise<string | null>;
  fetchImpl?: typeof fetch;
}

export async function testCloudConnection(deps: CloudProbeDeps): Promise<JiraTestResult> {
  const doFetch = deps.fetchImpl ?? fetch;
  const baseUrl = deps.settings.baseUrl.trim().replace(/\/+$/, '');

  if (!baseUrl) {
    return { ok: false, message: 'No server address set. Enter one, then test again.' };
  }

  // 1. Is anything there at all? /health is unauthenticated precisely so this can be asked
  //    without a token — a wrong or unreachable address stops here rather than looking like
  //    an authentication problem three rungs later.
  try {
    const health = await doFetch(`${baseUrl}/health`);
    if (!health.ok) {
      return {
        ok: false,
        message: `${baseUrl} answered ${health.status} — that address is reachable but is not a Task Manager server.`,
      };
    }
  } catch (e) {
    return {
      ok: false,
      message: `Could not reach ${baseUrl} — check the address. (${errorText(e)})`,
    };
  }

  // 2. Have we got a token? Distinguishes "never signed in" from "signed in and refused",
  //    which look the same from the board.
  const token = await deps.getAccessToken();
  if (!token) {
    return {
      ok: false,
      message: 'The server is reachable, but you are not signed in. Use Sign in above.',
    };
  }

  // 3. Does the server accept it, for this account? The two failures here are genuinely
  //    different problems belonging to different people, so they must not share a message.
  try {
    const board = await doFetch(`${baseUrl}/v1/board`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (board.ok) {
      return { ok: true, message: 'Connected. The server recognises this account.' };
    }
    if (board.status === 401) {
      return {
        ok: false,
        message:
          'Signed in, but the server rejected the token. Its own vipper.iam credentials are ' +
          'wrong or expired — that is a server configuration problem, not something to fix here.',
      };
    }
    if (board.status === 403) {
      return {
        ok: false,
        message:
          'Signed in, but this account has no access to a board. Someone with vipper.iam ' +
          'access needs to grant you read and write on your taskmanager resource.',
      };
    }
    return { ok: false, message: `The server answered ${board.status} ${board.statusText}.` };
  } catch (e) {
    return { ok: false, message: `The board request failed. (${errorText(e)})` };
  }
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
