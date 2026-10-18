/**
 * Which feed `electron-updater` reads, and what a feed failure means.
 *
 * Pure on purpose, same reasoning as `updateSupport.ts`: the feed talks to GitHub and
 * can't be unit-tested, but the decisions around it — which config to hand it, which
 * token wins when several are available, what a status code means, and keeping a token
 * out of the log — are exactly the parts worth pinning down.
 */
import type { UpdateState } from '@shared/update';

export const UPDATE_OWNER = 'wdembinski';
export const UPDATE_REPO = 'taskmanager';

export interface UpdateFeedConfig {
  provider: 'github';
  owner: string;
  repo: string;
  token?: string;
}

/**
 * The electron-updater feed config for this install.
 *
 * Deliberately never sets `private: true`: a token already proves access, and marking
 * the feed private on top of that only gives electron-updater a second way to refuse a
 * request the token would otherwise have satisfied (Decision 1).
 */
export function updateFeedConfig(token: string | null): UpdateFeedConfig {
  if (token) return { provider: 'github', owner: UPDATE_OWNER, repo: UPDATE_REPO, token };
  return { provider: 'github', owner: UPDATE_OWNER, repo: UPDATE_REPO };
}

export interface PickUpdateTokenInput {
  stored: string | null;
  ghCli: string | null;
  useGhCli: boolean;
}

export type UpdateTokenSource = 'stored' | 'gh' | 'none';

export interface PickedUpdateToken {
  token: string | null;
  source: UpdateTokenSource;
}

/** A token saved in Settings always wins; `gh`'s own token is only a fallback, and only
 * when the user has opted into using it. */
export function pickUpdateToken({
  stored,
  ghCli,
  useGhCli,
}: PickUpdateTokenInput): PickedUpdateToken {
  if (stored) return { token: stored, source: 'stored' };
  if (useGhCli && ghCli) return { token: ghCli, source: 'gh' };
  return { token: null, source: 'none' };
}

export type UpdateErrorReason = NonNullable<UpdateState['reason']>;

const HTTP_ERROR_PATTERN = /HttpError: (\d{3})/;
const BARE_STATUS_PATTERN = /\b(401|403|404)\b/;

function statusCodeOf(err: unknown): number | null {
  if (err && typeof err === 'object') {
    const statusCode = (err as { statusCode?: unknown }).statusCode;
    if (typeof statusCode === 'number') return statusCode;
  }
  const text = `${err instanceof Error ? err.message : String(err)}\n${
    err instanceof Error ? (err.stack ?? '') : ''
  }`;
  const httpError = HTTP_ERROR_PATTERN.exec(text);
  if (httpError) return Number(httpError[1]);
  const bare = BARE_STATUS_PATTERN.exec(text);
  return bare ? Number(bare[1]) : null;
}

/**
 * What a feed failure means for the UI, given whether a token was in play.
 *
 * GitHub's API answers a private repo with 404 to an unauthenticated request rather than
 * 401/403, so it can't tell "wrong repo" from "no access" apart from "right token,
 * no access" — hence the token-aware split below rather than a bare status table.
 */
export function classifyUpdateError(err: unknown, hadToken: boolean): UpdateErrorReason | null {
  const statusCode = statusCodeOf(err);
  if (statusCode === 401 || statusCode === 403) return hadToken ? 'token-rejected' : null;
  if (statusCode === 404) return hadToken ? 'token-blind' : 'needs-token';
  return null;
}

const PAT_SHAPED_PATTERN = /github_pat_[A-Za-z0-9_]+|gh[pousr]_[A-Za-z0-9]+/g;

/** Strip a known secret, and anything shaped like a GitHub PAT, out of log/error/notice text. */
export function redactSecret(text: string, secret: string | null): string {
  const withoutSecret = secret ? text.split(secret).join('***') : text;
  return withoutSecret.replace(PAT_SHAPED_PATTERN, '***');
}
