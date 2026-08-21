import type { CloudConfigStatus } from '@shared/ipc';

/**
 * The Cloud pane's "Personal access token" field hint — state-driven, so "a token is stored
 * but has not synced yet" and "the cloud rejected it" no longer read the same way. Used to be
 * `iamHint`, over a sign-in; rewritten for a pasted token, which is why every sentence below
 * says what to paste and where to get it rather than where to click to sign in.
 *
 * Its own module because there is no DOM test harness in this workspace (no jsdom, no
 * `@testing-library` — see `test/shell-parity.test.ts`), so anything worth asserting here has
 * to be a pure exported function rather than something rendered.
 */
export function cloudAuthHint(status: CloudConfigStatus | null): string {
  if (status?.encryptionAvailable === false) {
    return 'The OS secure store is unavailable, so a token cannot be saved on this machine.';
  }
  if (status?.legacySignInRetired) {
    return (
      'Cloud sign-in has been replaced by personal access tokens — create one in the web ' +
      'app and paste it below.'
    );
  }
  if (status?.authState === 'rejected') {
    return (
      'The cloud rejected this token. It has been revoked or has expired — create a new ' +
      'one in the web app and paste it here.'
    );
  }
  if (status?.authState === 'active') {
    const secondsAgo =
      status.lastAcceptedAt === null
        ? null
        : Math.max(0, Math.round((Date.now() - status.lastAcceptedAt) / 1000));
    return secondsAgo === null
      ? 'Token confirmed working.'
      : `Token confirmed working — last synced ${secondsAgo}s ago.`;
  }
  if (status?.authState === 'stored') {
    return 'A token is stored, but it has not synced yet.';
  }
  return 'Paste a token from the web app’s Personal access tokens page.';
}

/** The token field's placeholder — a stored token is never redisplayed, so this is all it says. */
export function cloudTokenPlaceholder(status: CloudConfigStatus | null): string {
  return status?.hasToken ? '•••••••• (stored)' : 'tmpat_…';
}
