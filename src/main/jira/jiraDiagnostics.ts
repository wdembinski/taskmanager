/**
 * Turns a failed JIRA call into a message that names the likely fix.
 *
 * The raw errors are dead ends. A Cloud site handed a Server-style `Bearer` PAT answers
 * `401 Unauthorized` with an empty body — which reads as "bad token" and sends people off
 * to regenerate a perfectly good one, when the actual problem is the Deployment dropdown.
 * And a network failure surfaces from undici as the literal string "fetch failed", with
 * the real reason (DNS, refused, TLS) buried in `err.cause`.
 *
 * Kept Electron-free and pure so it can be unit-tested.
 */
import type { JiraSettings } from '@shared/settings';
import { isCloudHost } from '@shared/jiraUrl';
import { JiraError } from './jiraClient';

/** Node attaches the real socket/TLS failure to `cause` on a rejected `fetch`. */
function causeCode(err: unknown): string | undefined {
  const cause: unknown = err instanceof Error ? err.cause : undefined;
  if (cause && typeof cause === 'object' && 'code' in cause) {
    const code = (cause as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return undefined;
}

/** Plain-English rendering of the transport failures we can actually name. */
function describeNetworkFailure(code: string, baseUrl: string): string | null {
  switch (code) {
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return `Can't resolve ${baseUrl} — check the base URL, and your DNS/VPN if it's an internal host.`;
    case 'ECONNREFUSED':
      return `${baseUrl} refused the connection — check the URL and port.`;
    case 'ETIMEDOUT':
    case 'UND_ERR_CONNECT_TIMEOUT':
      return `Timed out reaching ${baseUrl} — check your network, VPN, or proxy.`;
    case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
    case 'SELF_SIGNED_CERT_IN_CHAIN':
    case 'DEPTH_ZERO_SELF_SIGNED_CERT':
      return (
        `The TLS certificate for ${baseUrl} isn't trusted. This usually means a corporate ` +
        `proxy re-signs traffic; its root certificate needs to be trusted by the app.`
      );
    default:
      return null;
  }
}

/**
 * Build the user-facing message for a failed JIRA request.
 *
 * @param err     whatever was thrown — a `JiraError`, a `fetch` rejection, or anything else
 * @param jira    the settings the call was made with, so the advice can reference them
 */
export function explainJiraFailure(err: unknown, jira: JiraSettings): string {
  const baseUrl = jira.baseUrl.trim() || 'the JIRA server';

  const code = causeCode(err);
  if (code) {
    const described = describeNetworkFailure(code, baseUrl);
    return described ?? `Couldn't reach ${baseUrl} (${code}).`;
  }

  if (err instanceof JiraError) {
    const hint = statusHint(err, jira);
    return hint ? `${err.message}\n\n${hint}` : err.message;
  }

  return err instanceof Error ? err.message : String(err);
}

/** The "what to change" half of the message, or null when we have nothing useful to add. */
function statusHint(err: JiraError, jira: JiraSettings): string | null {
  if (err.status === 401) {
    // The big one: a Cloud API token sent as a Server PAT. Nothing about the raw 401
    // points at the Deployment dropdown, so say it outright.
    if (jira.deployment === 'server' && isCloudHost(jira.baseUrl)) {
      return (
        `${jira.baseUrl} is an Atlassian Cloud site, but Deployment is set to ` +
        `"Server / Data Center". Cloud does not accept Bearer tokens — switch Deployment ` +
        `to "Cloud", enter the email address of your Atlassian account, and save.`
      );
    }
    if (jira.deployment === 'cloud') {
      return (
        `Cloud signs in with your account email plus an API token, and both must belong ` +
        `to the same account. Check the email, and that the token was created at ` +
        `id.atlassian.com/manage-profile/security/api-tokens for this site.`
      );
    }
    return (
      `The Personal Access Token was rejected. Check it hasn't expired, and that this is ` +
      `a Server/Data Center instance — if the URL ends in atlassian.net, set Deployment ` +
      `to "Cloud" instead.`
    );
  }

  if (err.status === 403) {
    // Jira DC locks an account after repeated failures and answers 403 with this header;
    // the body says nothing, so without surfacing it the message is baffling.
    if (err.deniedReason) {
      return (
        `JIRA denied the request (${err.deniedReason}). If this mentions CAPTCHA, sign in ` +
        `to JIRA in a browser, complete the CAPTCHA, then try again.`
      );
    }
    return `Authentication worked but this account lacks permission for that request.`;
  }

  if (err.status === 404) {
    return (
      `Check the base URL — it should be the site root (e.g. https://acme.atlassian.net), ` +
      `not a link to a board or an issue.`
    );
  }

  return null;
}
