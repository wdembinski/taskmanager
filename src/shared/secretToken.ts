/**
 * Cleaning a credential that arrived through a clipboard. Shared by both trackers and by
 * the Settings UI, so it is pure string work with no Electron or Node dependency — same
 * arrangement as `@shared/jiraUrl`.
 *
 * "The token is valid and I still get a 401" is, more often than anything else, a token
 * that came with something invisible attached. Copying from Atlassian's token dialog, a
 * password manager, a terminal or an email picks up a trailing newline, a leading space,
 * a soft-wrapped line break, or a zero-width character — none of which are visible in a
 * password field, and all of which JIRA sees as part of the secret. `Bearer abc ` is not
 * `Bearer abc`, and `base64("me@x.com:abc\n")` is not the credential the user created.
 *
 * So the noise is stripped rather than trusted. No token either tracker issues contains
 * whitespace: an Atlassian API token, a JIRA Data Center PAT and a GitLab PAT are all
 * drawn from a URL-safe alphabet, which is what makes removing INTERIOR whitespace safe
 * as well as the ends — and interior is what a wrapped paste actually produces.
 */

/**
 * What no token contains and every clipboard adds. `\s` already covers the non-breaking
 * space and the BOM; the zero-width joiners it misses are added by hand, because those
 * are exactly the characters that survive a paste while looking like nothing at all.
 */
const NOISE = /[\s\u200B-\u200D\uFEFF]+/g;

/** The token as it should go on the wire. */
export function sanitizeToken(raw: string): string {
  return raw.replace(NOISE, '');
}

/**
 * Did cleaning actually change something? Lets the UI say what it repaired instead of
 * silently fixing a paste the user will make again next time.
 */
export function tokenHadNoise(raw: string): boolean {
  return sanitizeToken(raw) !== raw;
}
