/**
 * JIRA base-URL handling, shared by the main process (which builds requests) and the
 * Settings UI (which warns about a Cloud site configured as Server/DC). Pure string
 * work with no Electron or Node dependency, so it crosses the boundary and is
 * unit-testable — same arrangement as `@shared/board`.
 */

/**
 * Tidy whatever the user pasted into a base URL we can actually build requests from.
 *
 * People paste what's in their address bar, which is a deep link
 * (`https://acme.atlassian.net/jira/your-work`), and they leave off the scheme
 * (`acme.atlassian.net`) — the first appends REST paths onto the wrong prefix and 404s,
 * the second makes `new URL()` throw a bare `Failed to parse URL`. Taking the origin
 * fixes both, and drops any trailing slash for free. Returns the trimmed input
 * unchanged if it still can't be parsed, so the caller's own validation produces the
 * error message rather than this helper inventing one.
 */
export function normalizeBaseUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  // A scheme-less host is by far the most common paste; assume https, never http.
  // Tested before any trimming of slashes, so a bare "https://" stays recognizable
  // as a (useless) scheme rather than being turned into a hostname.
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    return new URL(withScheme).origin;
  } catch {
    return trimmed;
  }
}

/**
 * Normalize a REST base URL that is allowed to carry a PATH.
 *
 * {@link normalizeBaseUrl} takes the ORIGIN, which is right for a site root and fatal
 * here: Atlassian's API gateway is `https://api.atlassian.com/ex/jira/<cloudId>`, and the
 * path IS the tenant — take the origin and every request goes to nobody's JIRA. So this
 * one only trims, supplies a scheme, and drops trailing slashes.
 */
export function normalizeApiBaseUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const url = new URL(withScheme);
    return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
  } catch {
    return trimmed.replace(/\/+$/, '');
  }
}

/**
 * Does this URL point at an Atlassian Cloud site? Cloud rejects the `Bearer` PATs that
 * Server/Data Center issues, so getting the deployment wrong is a guaranteed 401 — and
 * `*.atlassian.net` is the one case we can recognize without asking the user.
 *
 * Deliberately host-suffix only: Cloud sites behind a vanity domain are indistinguishable
 * from a self-hosted instance, so those still need the dropdown set by hand.
 */
export function isCloudHost(baseUrl: string): boolean {
  try {
    const host = new URL(normalizeBaseUrl(baseUrl)).hostname.toLowerCase();
    return host === 'atlassian.net' || host.endsWith('.atlassian.net');
  } catch {
    return false;
  }
}
