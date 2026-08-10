/**
 * What to do when a JIRA 401 is not about the token.
 *
 * `explainJiraFailure` can only reason from what is on screen, so its 401 advice is a
 * ranked guess — and a guess is exactly what the person reading it already has. They know
 * the token is good; they pasted it into a browser five minutes ago. What they need is
 * the one configuration difference between "works" and "401", and there are only a few
 * candidates, each of which can simply be TRIED:
 *
 *  - the Deployment dropdown is on the wrong setting, so a Bearer PAT is going to a Cloud
 *    site (or an email/token pair to a Server one). Same credential, other protocol.
 *  - the token is one of Atlassian's **scoped** API tokens — the kind
 *    id.atlassian.com issues by default now. Those are refused, with a bare 401 and no
 *    body, by `https://<site>.atlassian.net/rest/...` and accepted only through the
 *    tenant gateway `https://api.atlassian.com/ex/jira/<cloudId>`. Nothing in the error
 *    hints at this, and no amount of regenerating the token fixes it.
 *
 * A probe answers with proof rather than a hunch: it does not report a fix it has not
 * seen return 200. That is what makes applying the answer automatically defensible, where
 * overriding the Deployment dropdown on a *guess* would not be.
 *
 * Electron-free and store-free, like the rest of `jira/`, so it is testable against a
 * mocked `fetch`.
 */
import type { JiraSettings } from '@shared/settings';
import { normalizeBaseUrl } from '@shared/jiraUrl';
import { JiraClient, JiraError } from './jiraClient';
import { buildClientConfig } from './jiraConfig';

/** Atlassian's per-tenant API gateway; the cloudId is appended to this. */
const CLOUD_GATEWAY = 'https://api.atlassian.com/ex/jira';

export interface JiraAuthProbeResult {
  /** The settings change that made the same token work. Never empty. */
  patch: Partial<JiraSettings>;
  /** Whether the alternative actually authenticated, or merely got past authentication. */
  outcome: 'connected' | 'scoped-too-narrowly';
  /** The account behind the token, when the probe got far enough to be told. */
  displayName?: string;
  /** What to show the user: what was wrong, and what has changed as a result. */
  message: string;
}

/**
 * The site's `cloudId`, or null. Unauthenticated and undocumented-but-stable; it is the
 * only way to build a gateway URL, and asking costs one request against a site we are
 * already talking to.
 */
export async function fetchCloudId(baseUrl: string): Promise<string | null> {
  const site = normalizeBaseUrl(baseUrl);
  if (!site) return null;
  try {
    const res = await fetch(`${site}/_edge/tenant_info`, {
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { cloudId?: unknown };
    return typeof data?.cloudId === 'string' && data.cloudId.trim() ? data.cloudId.trim() : null;
  } catch {
    return null;
  }
}

/** One thing worth trying, and how to describe it if it works. */
interface Candidate {
  patch: Partial<JiraSettings>;
  /** Message on a clean 200. `who` is the display name JIRA answered with. */
  connected: (who: string) => string;
  /**
   * Message when the request got a 403 instead. On the gateway that is a meaningful
   * answer — 401 is "who are you", 403 is "I know you, and no" — so the credential is
   * right and the token's scopes are not.
   */
  forbidden?: string;
}

/** Try one alternative. `null` unless the server actually accepted the credential. */
async function attempt(
  jira: JiraSettings,
  token: string,
  candidate: Candidate,
): Promise<JiraAuthProbeResult | null> {
  const settings = { ...jira, ...candidate.patch };
  try {
    const me = await new JiraClient(buildClientConfig(settings, token)).testConnection();
    return {
      patch: candidate.patch,
      outcome: 'connected',
      displayName: me.displayName,
      message: candidate.connected(me.displayName),
    };
  } catch (e) {
    if (candidate.forbidden && e instanceof JiraError && e.status === 403) {
      return {
        patch: candidate.patch,
        outcome: 'scoped-too-narrowly',
        message: candidate.forbidden,
      };
    }
    return null;
  }
}

/**
 * Find the configuration this token DOES work with, or null if none of them does (in
 * which case the token really is the problem and `explainJiraFailure` has the last word).
 *
 * Ordered cheapest-first: the two protocol swaps need no extra round trip, the gateway
 * needs a `cloudId` lookup before it can even be addressed.
 */
export async function probeJiraAuth(
  jira: JiraSettings,
  token: string,
): Promise<JiraAuthProbeResult | null> {
  if (!token.trim() || !jira.baseUrl.trim()) return null;
  const email = jira.cloudEmail.trim();
  const site = normalizeBaseUrl(jira.baseUrl);

  const candidates: Candidate[] = [];

  // Same token, other protocol. A Cloud site never accepts `Bearer`, and a Server/DC one
  // never accepts an email; whichever way round it is, the dropdown is the whole bug.
  if (jira.deployment === 'server' && email) {
    candidates.push({
      patch: { deployment: 'cloud', apiBaseUrl: '' },
      connected: (who) =>
        `Connected as ${who}. Your token is fine — ${site} is an Atlassian Cloud site, and ` +
        `Deployment was set to "Server / Data Center", which sends the token as a Bearer ` +
        `credential that Cloud always refuses with a 401. Deployment is now set to "Cloud".`,
    });
  }
  if (jira.deployment === 'cloud') {
    candidates.push({
      patch: { deployment: 'server', apiBaseUrl: '' },
      connected: (who) =>
        `Connected as ${who}. Your token is fine — ${site} is a Server / Data Center ` +
        `instance, and Deployment was set to "Cloud", which sends your email and token as ` +
        `a Basic credential it does not recognize. Deployment is now set to ` +
        `"Server / Data Center".`,
    });
  }

  for (const candidate of candidates) {
    const result = await attempt(jira, token, candidate);
    if (result) return result;
  }

  // The scoped-token trap. Needs an email either way, since the gateway speaks Basic.
  if (!email) return null;
  const cloudId = await fetchCloudId(site);
  if (!cloudId) return null;
  const apiBaseUrl = `${CLOUD_GATEWAY}/${cloudId}`;
  return attempt(jira, token, {
    patch: { deployment: 'cloud', apiBaseUrl },
    connected: (who) =>
      `Connected as ${who}. Your token is fine — it is a SCOPED Atlassian API token, and ` +
      `those are refused by ${site} itself with a bare 401. They are only accepted through ` +
      `Atlassian's tenant gateway, so this connection now goes to ${apiBaseUrl}. Issue ` +
      `links still point at ${site}; nothing else changes.`,
    forbidden:
      `Your token is a SCOPED Atlassian API token — ${site} refuses those with a 401, and ` +
      `Atlassian's gateway at ${apiBaseUrl} accepted it but says it lacks the scopes to ` +
      `read your account. Either grant it the JIRA read/write scopes, or create a ` +
      `classic (unscoped) API token at id.atlassian.com/manage-profile/security/api-tokens.`,
  });
}
