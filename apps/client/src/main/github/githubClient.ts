/**
 * Minimal GitHub REST client, shaped after `gitlab/gitlabClient.ts`.
 *
 * Node global `fetch`, no HTTP dependency, and deliberately free of Electron and the store
 * so it can be unit-tested against a mocked `fetch`. One auth mode: a personal access
 * token as `Authorization: Bearer`, which works on github.com and GitHub Enterprise Server
 * alike, for both classic and fine-grained tokens.
 *
 * Two things differ from GitLab and are the reason this is a separate file rather than a
 * flag on that one:
 *
 *  - **The base URL.** github.com's API lives on its own host (`https://api.github.com`),
 *    while an Enterprise instance serves it from `<host>/api/v3`. The user should not have
 *    to know which shape their instance wants, so {@link apiRoot} decides from what they
 *    typed and this is the only place that rule exists.
 *  - **Pagination.** GitLab hands you the next page number in `x-next-page`; GitHub sends
 *    an RFC 5988 `Link` header and expects you to follow `rel="next"` as a whole URL. The
 *    URL is followed verbatim rather than re-derived, because the search endpoints attach
 *    their own opaque parameters to it.
 */
import type { MergeRequestState } from '@shared/mergeRequest';
import { sanitizeToken } from '@shared/secretToken';

export interface GitHubClientConfig {
  /**
   * `https://api.github.com`, or an Enterprise instance root. Either the instance root
   * (`https://github.acme.internal`) or its API root (`.../api/v3`) is accepted — see
   * {@link apiRoot}.
   */
  baseUrl: string;
  token: string;
}

export class GitHubError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'GitHubError';
  }
}

/** `GET /user` — who the token belongs to. Also one row of the assignable-user list. */
export interface GitHubUser {
  id: number;
  login: string;
  name?: string | null;
  /** Only on the list endpoints; the @mention picker shows it when there is one. */
  avatar_url?: string | null;
}

/**
 * One row of `GET /search/issues` — an issue *or* a pull request, since GitHub keeps both
 * in one index and `pull_request` is the only thing that tells them apart.
 *
 * Deliberately thin, and that is the fact `describePullRequest` is built around: search
 * results carry no branches, no head SHA, no `mergeable_state` and no repository **id**.
 * Everything attention depends on needs the detail endpoints, which is why the list alone
 * can never fill a row in.
 */
export interface GitHubSearchIssueItem {
  /** The GLOBAL issue id — not the repo, and not what `#12` means to a human. */
  id: number;
  /**
   * The GraphQL global node id (`I_kwDO…`). GitHub's own opaque, permanent handle for this
   * issue, and what a mirrored card stores as `externalId` — the numeric `id` above is
   * equally stable, but it is the one identifier GitHub has been steadily moving away from.
   * Optional because an Enterprise Server old enough not to send it must still sync.
   */
  node_id?: string;
  /** The per-repo number, which is what `#12` means. */
  number: number;
  title: string;
  body?: string | null;
  /** `open` or `closed`. Merged-ness lives in `pull_request.merged_at`. */
  state: string;
  draft?: boolean;
  html_url: string;
  /**
   * `https://api.github.com/repos/{owner}/{repo}` — the ONLY thing on a search row that
   * says which repository this is. The owner and repo every detail call needs are parsed
   * back out of it; see `describePullRequest.ts`.
   */
  repository_url: string;
  updated_at: string;
  /** Present iff this row is a pull request. `merged_at` is set once it lands. */
  pull_request?: { url?: string; html_url?: string; merged_at?: string | null } | null;
  user?: { id?: number; login?: string } | null;
  labels?: Array<{ name?: string }> | null;
  /** Who the issue is assigned to, when it has an assignee. */
  assignee?: { login?: string } | null;
}

/** One row of `GET /repos/{owner}/{repo}/labels` — the repository's own label taxonomy. */
export interface GitHubLabel {
  name?: string | null;
}

/** One page of `GET /search/issues`, paged explicitly by the caller rather than followed. */
export interface GitHubSearchIssuePage {
  items: GitHubSearchIssueItem[];
  /** Whether the `Link` header carried a `rel="next"` — there is another page past this one. */
  hasNext: boolean;
}

/**
 * One comment on an issue — `GET /repos/{owner}/{repo}/issues/{number}/comments`.
 *
 * Issue comments and pull-request *conversation* comments are the same endpoint on GitHub
 * (a PR is an issue), which is why this type is not called an issue-only thing. Comments on
 * a diff come from a second endpoint — see {@link GitHubReviewComment}.
 */
export interface GitHubIssueComment {
  id: number;
  body?: string | null;
  created_at: string;
  updated_at?: string;
  html_url?: string;
  user?: { id?: number; login?: string } | null;
}

/**
 * One INLINE review comment — `GET /repos/{owner}/{repo}/pulls/{number}/comments`.
 *
 * The third place a human can say something on a pull request, and on a reviewed repository
 * it is where nearly all of it is said: a reviewer who leaves six remarks on six lines leaves
 * *nothing* on the conversation tab, so a sync reading only `/issues/{n}/comments` would call
 * that PR silent. Same wire shape as an issue comment plus where in the diff it hangs, which
 * is why it extends rather than repeats it.
 */
export interface GitHubReviewComment extends GitHubIssueComment {
  /** The file the remark is attached to. Carried for provenance; nothing reads it yet. */
  path?: string;
  /** The line in that file, or null once the diff has moved out from under the comment. */
  line?: number | null;
}

/** What one `GET /search/issues` question came back with, plus how much to trust it. */
export interface GitHubSearchResult {
  items: GitHubSearchIssueItem[];
  /**
   * GitHub's own admission that it gave up early — the search index timed out and the
   * result set is a partial one it will not vouch for.
   */
  incompleteResults: boolean;
  /**
   * Whether this answer stopped short of the end of the query, for ANY reason:
   * `incompleteResults`, or {@link GitHubClient.paged}'s page cap still having a
   * `rel="next"` to follow when it ran out.
   *
   * The single fact a reconciler needs, and the reason the two are folded into one flag:
   * a short answer is indistinguishable from a shrunken board, so a sync that got one must
   * remove nothing at all — and which *kind* of short does not change that.
   */
  truncated: boolean;
}

/** `GET /repos/{owner}/{repo}/pulls/{number}` — the half a search row cannot answer. */
export interface GitHubPullRequest {
  id: number;
  number: number;
  title: string;
  body?: string | null;
  state: string;
  draft?: boolean;
  merged?: boolean;
  merged_at?: string | null;
  /**
   * The commit landed on the base branch, once merged — absent until then. This is the SHA
   * an after-merge workflow run (a push to the target branch) actually attaches its checks
   * to; `head.sha` is the PR's own branch tip and never moves again after merging, so it
   * only ever carries the checks that ran BEFORE the merge. See `describePullRequest`'s
   * `readCi` call for where the two are told apart.
   */
  merge_commit_sha?: string | null;
  html_url: string;
  updated_at?: string;
  /**
   * GitHub's verdict on whether this can merge, and the counterpart of GitLab's
   * `detailed_merge_status`. Carried by the DETAIL endpoint only — search rows omit it.
   */
  mergeable_state?: string | null;
  /**
   * Whether the merge is clean. **Tri-state on purpose:** `null` means GitHub has not
   * finished computing it, which is "checking", not "clean" — treating it as a boolean is
   * how a conflicted branch comes to wear a green tick.
   */
  mergeable?: boolean | null;
  /** The source branch and, crucially, the head SHA the check runs hang off. */
  head?: { ref?: string; sha?: string; repo?: GitHubRepoRef | null } | null;
  /**
   * `sha` here is the base BRANCH's current tip, not a merge base GitHub computed for this
   * pull request — there is no such field. F15.8's `forge-api` diff source uses it as an
   * approximation of one, since the alternative is cloning the repository just to compute a
   * real merge base, which is exactly what reading through the API avoids.
   */
  base?: { ref?: string; sha?: string; repo?: GitHubRepoRef | null } | null;
  /**
   * The GraphQL global node id — what {@link GitHubClient.enableAutoMerge} and
   * {@link GitHubClient.disableAutoMerge} must send as `pullRequestId`, since neither
   * mutation accepts the REST `number`.
   */
  node_id?: string;
  /**
   * Set once auto-merge is armed on this pull request, null otherwise. Tri-state the same
   * way `mergeable` is: its mere PRESENCE (not its contents) is what
   * {@link GitHubClient.enableAutoMerge} reads to decide the call is already a no-op.
   */
  auto_merge?: { merge_method: string } | null;
}

/**
 * The repository object GitHub embeds in `head`/`base`, which is the FULL repository
 * representation and not just an id — including the three merge-method toggles
 * {@link GitHubClient.mergePullRequest} reads to decide `merge_method`.
 */
export interface GitHubRepoRef {
  id?: number;
  full_name?: string;
  allow_merge_commit?: boolean | null;
  allow_squash_merge?: boolean | null;
  allow_rebase_merge?: boolean | null;
}

/** `PUT /repos/{owner}/{repo}/pulls/{number}/merge` — what GitHub hands back, not a PR. */
export interface GitHubMergeResult {
  sha?: string;
  merged?: boolean;
  message?: string;
}

/**
 * One review on a pull request. `state` is `APPROVED`, `CHANGES_REQUESTED`, `COMMENTED`,
 * `DISMISSED` or `PENDING`; the fold that turns a list of these into an approval count
 * lives in `describePullRequest.ts`.
 */
export interface GitHubReview {
  id: number;
  state?: string;
  /**
   * The summary the reviewer typed above their line comments — usually empty on a bare
   * approval, and the entire message on a review that had something to say. It is carried
   * because it appears in neither comments endpoint; see `describePullRequest.foldNotes`.
   */
  body?: string | null;
  /** When it was submitted. Absent on a PENDING draft, which nobody else can see yet. */
  submitted_at?: string | null;
  user?: { id?: number; login?: string } | null;
}

/**
 * One check run on a commit — GitHub's unit of CI, and the equivalent of a GitLab job.
 *
 * Two fields where GitLab has one: a run is `queued`/`in_progress`/`completed`, and only a
 * completed one has a `conclusion`. Both are needed to say what a dot should look like —
 * see `checkRuns.ts`.
 */
export interface GitHubCheckRun {
  id?: number;
  name?: string;
  status?: string;
  conclusion?: string | null;
  html_url?: string | null;
  details_url?: string | null;
  started_at?: string | null;
  completed_at?: string | null;
}

/** One legacy commit status — what CI reported before check runs existed. */
export interface GitHubStatusContext {
  context?: string;
  state?: string;
  target_url?: string | null;
}

/** `GET /repos/{owner}/{repo}/commits/{sha}/status`, for repos still on commit statuses. */
export interface GitHubCombinedStatus {
  state?: string;
  total_count?: number;
  sha?: string;
  statuses?: GitHubStatusContext[] | null;
}

/**
 * `GET /repos/{owner}/{repo}/branches/{branch}/protection`.
 *
 * Admin-gated: on a repository you merely contribute to this 403s, which is the normal
 * case and not an error worth showing. See `describePullRequest.ts` for what is done
 * instead — nothing, deliberately.
 */
export interface GitHubBranchProtection {
  required_pull_request_reviews?: {
    required_approving_review_count?: number | null;
    dismiss_stale_reviews?: boolean;
    require_code_owner_reviews?: boolean;
  } | null;
  /**
   * The classic (pre-ruleset) way a branch names its required checks. `contexts` is the
   * deprecated plain-string list; `checks` is what replaced it, one object per check with
   * room for an `app_id` nothing here reads. {@link GitHubClient.getAutoMergeFacts} reads
   * both, since an instance can carry either depending on when the rule was last edited.
   */
  required_status_checks?: {
    contexts?: string[];
    checks?: Array<{ context?: string }>;
  } | null;
}

/**
 * One rule of `GET /repos/{owner}/{repo}/rules/branches/{branch}` — the modern repository
 * RULESET a branch inherits, as opposed to the classic branch-protection rule above. The two
 * can disagree, and a repository that migrated to rulesets may carry its required checks
 * only here. {@link GitHubClient.getAutoMergeFacts} is the only reader.
 */
interface GitHubBranchRule {
  type?: string;
  parameters?: { required_status_checks?: Array<{ context?: string }> };
}

/** `GET /repos/{owner}/{repo}` — just enough to resolve a search row's owner/repo to an id. */
export interface GitHubRepository {
  id: number;
  full_name: string;
  /**
   * Whether the repository permits auto-merge to be armed at all — a repository-wide
   * setting the owner toggles independently of any individual pull request. `null`/absent
   * on an instance old enough not to report it.
   */
  allow_auto_merge?: boolean | null;
}

/** What {@link GitHubClient.enableAutoMerge} reports back about what it actually did. */
export type GitHubAutoMergeOutcome = 'already' | 'enabled' | 'merged';

/** What {@link GitHubClient.getAutoMergeFacts} answers about a repository and its base branch. */
export interface GitHubAutoMergeFacts {
  allowAutoMerge: boolean | null;
  /** `null` means unreadable (see `protectionReadable`), never "no checks are required". */
  requiredChecks: string[] | null;
  /** False when the classic branch-protection read came back 403 — gated to repo admins. */
  protectionReadable: boolean;
}

/**
 * One row of `GET /repos/{owner}/{repo}/pulls/{number}/files` — one changed file on a pull
 * request.
 */
export interface GitHubPullRequestFile {
  sha: string;
  filename: string;
  /**
   * One of `added`, `removed`, `modified`, `renamed`, `copied`, `changed`, `unchanged` —
   * typed as a plain `string` rather than that union, since GitHub documents it the same way
   * and reserves the right to add a value we have not seen yet.
   */
  status: string;
  additions?: number;
  deletions?: number;
  changes?: number;
  /**
   * Absent for binary and oversized files — F15.8 reads that absence as `tooLarge` rather
   * than as a file with no changes.
   */
  patch?: string;
  /** Present only when `status` is `renamed`. */
  previous_filename?: string;
}

/** Every changed file `GET /pulls/{number}/files` returned, and how far that answer reached. */
export interface GitHubPullRequestFileList {
  files: GitHubPullRequestFile[];
  /** Whether the page cap stopped us with a `rel="next"` still left to follow. */
  truncated: boolean;
}

/** What {@link GitHubClient.createPullRequest} is asked to open. */
export interface CreatePullRequestInput {
  /**
   * The source branch. A bare name for a branch in this repository, or `owner:branch` for
   * a fork — passed through verbatim, since GitHub accepts both and we have no business
   * deciding which one the caller meant.
   */
  head: string;
  base: string;
  title: string;
  body?: string;
  draft?: boolean;
}

/**
 * A pull request that now exists, and whether **we** are the ones who made it.
 *
 * `existed` is the whole point of the type. Pressing "Create PR" twice is normal — the
 * human forgets, the scheduler and the button race, a step re-runs — and the second press
 * must report the pull request that is already open rather than paint an error over a
 * perfectly healthy branch. So the second answer is a success carrying a flag, not a
 * failure carrying an explanation.
 */
export interface CreatedPullRequest {
  pullRequest: GitHubPullRequest;
  existed: boolean;
}

/**
 * GitHub's way of saying "there is already one of these": **422**, with the sentence
 * `A pull request already exists for owner:branch.` in the `errors` array.
 *
 * Matched on the text and not on the status alone, because 422 is GitHub's answer to every
 * unprocessable create — a base branch that does not exist, a head with no commits on it,
 * a repository with pull requests disabled — and reading all of those as "already open"
 * would send the caller looking for a PR that was never made and report the absence as its
 * own confusing failure.
 */
function isAlreadyExists(err: unknown): boolean {
  return (
    err instanceof GitHubError &&
    err.status === 422 &&
    /pull request already exists/i.test(err.message)
  );
}

/**
 * Narrow a pull request's state to ours.
 *
 * GitHub has no `merged` state: a landed PR is `closed` with `merged_at` set, and reading
 * that as "closed" would put every shipped branch in the same bucket as an abandoned one —
 * on a card, the difference between "this shipped" and "this was thrown away".
 *
 * `locked` has no analogue here: GitHub's `locked` flag freezes the *conversation*, while
 * GitLab's `locked` state means a merge is in progress. Mapping one onto the other would
 * claim a PR was mid-merge because somebody muted an argument on it.
 */
export function toPullRequestState(pr: {
  state?: string;
  merged?: boolean | null;
  merged_at?: string | null;
  pull_request?: { merged_at?: string | null } | null;
}): MergeRequestState {
  if (pr.merged === true || pr.merged_at || pr.pull_request?.merged_at) return 'merged';
  return pr.state === 'open' ? 'opened' : 'closed';
}

/**
 * Which `merge_method` to send, given a repository's three merge-method toggles.
 *
 * A plain merge commit first, then squash, then rebase — each skipped only when the
 * repository explicitly disabled it (`false`; a toggle GitHub omitted, which old Enterprise
 * Server versions do, is read as allowed). If somehow all three are off GitHub would refuse
 * the merge outright, so `merge` is sent anyway and let the 405 explain why.
 */
export function pickMergeMethod(repo: {
  allow_merge_commit?: boolean | null;
  allow_squash_merge?: boolean | null;
  allow_rebase_merge?: boolean | null;
}): 'merge' | 'squash' | 'rebase' {
  if (repo.allow_merge_commit !== false) return 'merge';
  if (repo.allow_squash_merge !== false) return 'squash';
  if (repo.allow_rebase_merge !== false) return 'rebase';
  return 'merge';
}

/**
 * Where REST calls go, given what the user typed.
 *
 * github.com is the special case, not the general one: its API is a different HOST, so a
 * `https://api.github.com` in the settings is already the API root and gets no suffix.
 * Everything else is an Enterprise Server instance, whose API hangs off `/api/v3` — and an
 * instance root is what people paste, so the suffix is added if it isn't already there.
 */
export function apiRoot(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '');
  if (/^https?:\/\/api\.github\.com$/i.test(trimmed)) return trimmed;
  if (/\/api\/v3$/i.test(trimmed)) return trimmed;
  return `${trimmed}/api/v3`;
}

/**
 * Where GraphQL calls go, given what the user typed — the counterpart of {@link apiRoot}.
 *
 * github.com's GraphQL endpoint hangs off its API host directly (`api.github.com/graphql`),
 * while an Enterprise Server exposes it at `/api/graphql` on the INSTANCE root, not under
 * `/api/v3` the way REST is — so the `/api/v3` suffix `apiRoot` would have added is stripped
 * first rather than reused.
 */
export function graphqlRoot(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '');
  if (/^https?:\/\/api\.github\.com$/i.test(trimmed)) return `${trimmed}/graphql`;
  return `${trimmed.replace(/\/api\/v3$/i, '')}/api/graphql`;
}

/** The commit title (first line) and body (the rest) `git commit` would split a message into. */
function splitCommitMessage(message: string): { title: string; body: string } {
  const lines = message.split('\n');
  const title = (lines[0] ?? '').trim();
  const body = lines.slice(1).join('\n').replace(/^\n+/, '').trimEnd();
  return { title, body };
}

/**
 * The `rel="next"` URL from a `Link` header, or null when this was the last page.
 *
 * Exported because it is the one piece of GitHub's pagination worth testing on its own:
 * the header is a comma-separated list of `<url>; rel="name"` and the next link is not
 * reliably first — a middle page carries `prev`, `next`, `last` and `first` together.
 */
export function nextPageUrl(link: string | null | undefined): string | null {
  if (!link) return null;
  for (const part of link.split(',')) {
    const match = /<([^>]+)>\s*;\s*rel="?next"?/i.exec(part.trim());
    if (match) return match[1];
  }
  return null;
}

/**
 * `/repos/{owner}/{repo}`, with both parts escaped.
 *
 * Escaped rather than interpolated raw because these come back off a search row's
 * `repository_url` and go straight into a path: an owner or repo containing anything
 * URL-significant would otherwise change which endpoint we called.
 */
function repoPath(owner: string, repo: string): string {
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
}

/**
 * `/repos/{owner}/{repo}/contents/{path}?ref=<ref>`, with `path` encoded per segment
 * (`path.split('/').map(encodeURIComponent).join('/')`) so a literal `/` still reaches the
 * endpoint as a directory separator while a `#`, `?` or space inside a segment does not change
 * which endpoint gets called. Shared by {@link GitHubClient.getRawFile} and
 * {@link GitHubClient.getRawFileBytes}, which differ only in how they read the response body.
 */
function contentsPath(owner: string, repo: string, path: string, ref: string): string {
  const encodedPath = path
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
  return `${repoPath(owner, repo)}/contents/${encodedPath}?ref=${encodeURIComponent(ref)}`;
}

export class GitHubClient {
  constructor(private readonly config: GitHubClientConfig) {}

  private url(path: string): string {
    return `${apiRoot(this.config.baseUrl)}${path}`;
  }

  /**
   * The header set every call wears.
   *
   * `X-GitHub-Api-Version` is not optional politeness: GitHub pins response shapes to it,
   * and omitting it means the app silently follows whatever the newest default becomes.
   * The token is cleaned at the point of USE, not just where it was saved — a token stored
   * with a pasted newline on it is already in the store and nothing about it looks wrong.
   */
  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${sanitizeToken(this.config.token)}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    };
  }

  /** One request against an absolute URL. Returns the body and the response, for `Link`. */
  private async rawUrl(url: string): Promise<{ body: unknown; res: Response }> {
    const res = await fetch(url, { headers: this.headers() });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new GitHubError(
        `GitHub ${res.status} ${res.statusText}${text ? `: ${text.slice(0, 300)}` : ''}`,
        res.status,
      );
    }
    if (res.status === 204) return { body: undefined, res };
    return { body: await res.json(), res };
  }

  /** One request against a path below the API root. */
  private raw(path: string): Promise<{ body: unknown; res: Response }> {
    return this.rawUrl(this.url(path));
  }

  /**
   * One GET with a caller-chosen `Accept` — the shape {@link getRawFile} and
   * {@link getRawFileBytes} need and every other read on this client does not. Shares
   * {@link rawUrl}'s failure path exactly, so a 404 here is the same `GitHubError` a caller
   * already knows how to tell apart from every other status. Returns the `Response` itself
   * rather than an already-consumed body, so a caller can read it as text or as bytes.
   */
  private async rawResponse(path: string, accept: string): Promise<Response> {
    const res = await fetch(this.url(path), { headers: { ...this.headers(), Accept: accept } });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new GitHubError(
        `GitHub ${res.status} ${res.statusText}${text ? `: ${text.slice(0, 300)}` : ''}`,
        res.status,
      );
    }
    return res;
  }

  /** {@link rawResponse}, read as text — the shape {@link getRawFile} needs. */
  private async rawText(path: string, accept: string): Promise<string> {
    return (await this.rawResponse(path, accept)).text();
  }

  private async request<T>(path: string): Promise<T> {
    return (await this.raw(path)).body as T;
  }

  /**
   * One WRITE — the only calls in this client that change anything on github.com.
   *
   * Separate from {@link rawUrl} rather than a parameter on it, so that every read stays a
   * read by construction: a method argument that defaults to GET is one careless call away
   * from a PATCH. The error path is deliberately identical, because the caller
   * (`ipc.ts task:move`) turns any failure into a REFUSED move — a card must never claim a
   * move the forge did not make, so what matters is that a failure is impossible to miss.
   */
  private async write<T>(
    path: string,
    method: 'PATCH' | 'POST' | 'PUT' | 'DELETE',
    body?: unknown,
  ): Promise<T> {
    const res = await fetch(this.url(path), {
      method,
      headers:
        body === undefined
          ? this.headers()
          : { ...this.headers(), 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new GitHubError(
        `GitHub ${res.status} ${res.statusText}${text ? `: ${text.slice(0, 300)}` : ''}`,
        res.status,
      );
    }
    if (res.status === 204) return undefined as T;
    return (await res.json().catch(() => undefined)) as T;
  }

  /**
   * One GraphQL call — the only route to the merge commit message GitHub itself would
   * propose, which the REST API has no field for.
   *
   * Mirrors {@link write}'s error handling rather than {@link raw}'s, because a POST to
   * `/graphql` is indistinguishable from a mutation at the transport level even though every
   * query this client sends is a read. GraphQL's own failure mode is folded in on top: a
   * malformed query or an object GitHub refuses to resolve (a PR the token cannot see) comes
   * back as HTTP 200 with an `errors` array instead of a 4xx, and leaving that unchecked
   * would hand the caller a `data` full of nulls that looks like a proposal with no message
   * rather than a call that never answered the question.
   */
  private async graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const res = await fetch(graphqlRoot(this.config.baseUrl), {
      method: 'POST',
      headers: { ...this.headers(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new GitHubError(
        `GitHub ${res.status} ${res.statusText}${text ? `: ${text.slice(0, 300)}` : ''}`,
        res.status,
      );
    }
    const body = (await res.json().catch(() => undefined)) as
      { data?: T; errors?: Array<{ message?: string }> } | undefined;
    if (body?.errors?.length) {
      throw new GitHubError(
        `GitHub GraphQL error: ${body.errors.map((e) => e.message).join('; ')}`,
        res.status,
      );
    }
    return body?.data as T;
  }

  /**
   * Every page of a list endpoint, following `Link: rel="next"` up to `maxPages`.
   *
   * Capped rather than trusting the header forever: a paginated endpoint that keeps
   * advertising a next page (a misconfigured proxy, a search that never narrows) would
   * otherwise spin until the process is killed.
   */
  async paged<T>(path: string, maxPages = 5): Promise<T[]> {
    const all: T[] = [];
    let url: string | null = this.url(path);
    for (let i = 0; i < maxPages && url; i++) {
      const { body, res }: { body: unknown; res: Response } = await this.rawUrl(url);
      if (Array.isArray(body)) all.push(...(body as T[]));
      url = nextPageUrl(res.headers?.get('link'));
    }
    return all;
  }

  /** GET /user — the "Test connection" call, and the identity every comment is compared to. */
  getMe(): Promise<GitHubUser> {
    return this.request<GitHubUser>('/user');
  }

  /**
   * Your open pull requests, newest activity first.
   *
   * `author:@me` only — the same decision GitLab's `scope=created_by_me` makes, and for the
   * same reason: this is the set *you* are responsible for landing. PRs you were merely
   * asked to review are someone else's to push, and folding them in would double the noise
   * on a board whose whole point is "what is mine and what is it waiting on".
   *
   * `advanced_search=true` is not optional politeness either. GitHub deprecated the legacy
   * search syntax on 4 Sep 2025; a query sent without the flag comes back with a
   * deprecation warning and is scheduled to stop working. Our query means the same thing
   * under both syntaxes — the difference is only how a space between several `repo:`/`org:`
   * qualifiers is read, and there is one qualifier of each here.
   *
   * Search is the only endpoint that answers "across every repository" in one call, which
   * is why it is used despite being the thinnest payload GitHub has: see
   * {@link GitHubSearchIssueItem} for what it will not tell you.
   */
  async listMyPullRequests(maxPages = 5): Promise<GitHubSearchIssueItem[]> {
    return (await this.searchIssues('is:pr is:open author:@me', maxPages)).items;
  }

  /**
   * One search query, followed to the end, with **how short the answer was** attached.
   *
   * `advanced_search=true` is not optional politeness: GitHub deprecated the legacy search
   * syntax on 4 Sep 2025, and a query sent without the flag comes back with a deprecation
   * warning and is scheduled to stop working. It matters more here than for the fixed PR
   * query above, because this one is a string the USER wrote and may well contain several
   * `repo:`/`org:` qualifiers — the one place the two syntaxes read a space differently.
   *
   * The two truncation signals are folded into one `truncated` here rather than left for
   * every caller to combine, because forgetting either has the same consequence and it is
   * the expensive one: a board that reads a short answer as a shrunken board and archives
   * the difference. See {@link GitHubSearchResult}.
   */
  async searchIssues(query: string, maxPages = 5): Promise<GitHubSearchResult> {
    const q = encodeURIComponent(query.trim());
    const items: GitHubSearchIssueItem[] = [];
    let incompleteResults = false;
    let url: string | null = this.url(
      `/search/issues?q=${q}&advanced_search=true&sort=updated&order=desc&per_page=100`,
    );
    let i = 0;
    for (; i < maxPages && url; i++) {
      const { body, res }: { body: unknown; res: Response } = await this.rawUrl(url);
      const page = body as { items?: unknown; incomplete_results?: unknown } | null;
      if (Array.isArray(page?.items)) items.push(...(page.items as GitHubSearchIssueItem[]));
      if (page?.incomplete_results === true) incompleteResults = true;
      // The `Link` header, not a page counter: search hangs its own opaque parameters off
      // the next URL, and re-deriving it drops them.
      url = nextPageUrl(res.headers?.get('link'));
    }
    // `url` still being set means the cap stopped us, not GitHub — there is another page
    // out there we chose not to read, which is exactly as short an answer as a timed-out
    // index and has to be reported as one.
    return { items, incompleteResults, truncated: incompleteResults || url !== null };
  }

  /**
   * One EXPLICIT page of `GET /search/issues` — the issue browser's own pager, which asks
   * for page `N` again rather than following an opaque cursor the way {@link searchIssues}
   * does for the PR dashboard. `hasNext` is read off the same `Link: rel="next"` header; the
   * caller decides whether to ask for `page + 1` at all (see `githubIssues.ts`'s page-20 cap).
   */
  async searchIssuesPage(q: string, page: number, perPage: number): Promise<GitHubSearchIssuePage> {
    const query = encodeURIComponent(q.trim());
    const url = this.url(
      `/search/issues?q=${query}&advanced_search=true&sort=updated&order=desc` +
        `&per_page=${perPage}&page=${page}`,
    );
    const { body, res } = await this.rawUrl(url);
    const items = (body as { items?: unknown } | null)?.items;
    return {
      items: Array.isArray(items) ? (items as GitHubSearchIssueItem[]) : [],
      hasNext: nextPageUrl(res.headers?.get('link')) !== null,
    };
  }

  /**
   * A repository's own labels — the first 100 — for the issue browser's facet list.
   *
   * Unlike JIRA's instance-wide `/label`, GitHub has no such thing: a label belongs to one
   * repository, so this is only ever asked when the issue query is scoped to one.
   */
  listRepoLabels(owner: string, repo: string): Promise<GitHubLabel[]> {
    return this.request<GitHubLabel[]>(`${repoPath(owner, repo)}/labels?per_page=100`);
  }

  /**
   * One issue by number — the re-read that lets a card leave the board.
   *
   * The counterpart of `getPullRequest`, and it exists for the same reason: absence from a
   * search is a hint, never a verdict. Asking for an issue by its number has an answer that
   * can be trusted in the negative (a 404 is `GitHubError` with `status: 404`), and it is
   * bounded by the size of the BOARD rather than the size of the repository.
   *
   * Returns the search-row shape because that is what {@link GitHubSearchIssueItem} is —
   * the fields both endpoints agree on — so the reconciler has one mapping rather than two.
   */
  getIssue(owner: string, repo: string, number: number): Promise<GitHubSearchIssueItem> {
    return this.request<GitHubSearchIssueItem>(`${repoPath(owner, repo)}/issues/${number}`);
  }

  /**
   * Open or close an issue — `PATCH /repos/{owner}/{repo}/issues/{number}`.
   *
   * The board's half of DONE: closing is the only thing GitHub itself understands as
   * "finished", and any move out of DONE reopens. `state` is the ONLY field sent, so a PATCH
   * cannot quietly rewrite a title or a body it merely happened to have read.
   *
   * `state_reason` is deliberately left out: GitHub defaults a close to `completed`, and the
   * board has no way to tell "done" from "not planned" — a card dragged into DONE is the human
   * saying the work is finished, which is exactly the default.
   */
  setIssueState(
    owner: string,
    repo: string,
    number: number,
    state: 'open' | 'closed',
  ): Promise<GitHubSearchIssueItem> {
    return this.write<GitHubSearchIssueItem>(`${repoPath(owner, repo)}/issues/${number}`, 'PATCH', {
      state,
    });
  }

  /**
   * Add labels to an issue — `POST /repos/{owner}/{repo}/issues/{number}/labels`.
   *
   * Additive by definition: this endpoint appends, it does not replace, which is why removing
   * the label a card is leaving behind is a separate call rather than a PUT of the whole set.
   * A PUT would silently delete every label the app knows nothing about — the repository's own
   * taxonomy — on every drag.
   */
  addLabels(owner: string, repo: string, number: number, labels: string[]): Promise<unknown> {
    return this.write(`${repoPath(owner, repo)}/issues/${number}/labels`, 'POST', { labels });
  }

  /**
   * Remove ONE label from an issue — `DELETE .../issues/{number}/labels/{name}`.
   *
   * **404 means the label was not on the issue**, which is the ordinary outcome of two drags
   * racing or of somebody removing it in the browser first, and the caller treats it as
   * success. The name is escaped: labels routinely contain spaces, slashes and colons.
   */
  removeLabel(owner: string, repo: string, number: number, label: string): Promise<unknown> {
    return this.write(
      `${repoPath(owner, repo)}/issues/${number}/labels/${encodeURIComponent(label)}`,
      'DELETE',
    );
  }

  /**
   * An issue's comments, oldest first.
   *
   * Two pages by default. The unread border only needs the NEWEST foreign comment, and a
   * thread longer than two hundred comments is one where the newest is certain to be past
   * the cap anyway — `sort=created&direction=desc` would be the fix if this ever bites, at
   * the cost of the oldest-first order every caller currently expects.
   */
  listIssueComments(
    owner: string,
    repo: string,
    number: number,
    maxPages = 2,
  ): Promise<GitHubIssueComment[]> {
    return this.paged<GitHubIssueComment>(
      `${repoPath(owner, repo)}/issues/${number}/comments?per_page=100`,
      maxPages,
    );
  }

  /**
   * Post a comment on an issue — `POST /repos/{owner}/{repo}/issues/{number}/comments`.
   *
   * The board's only *write* to a thread, and the counterpart of `jiraClient.addComment`. The
   * body is **Markdown**, which is the whole difference between the two: JIRA needs a document
   * built for it (ADF, or wiki markup on an older instance), while here the string the human
   * typed is already the wire format — mentions included, since `@login` is Markdown's own
   * spelling of one. See `githubComment.ts` for the one substitution main still makes.
   *
   * Returns the created comment, so the caller can move the read markers to the time GitHub
   * actually recorded rather than to the time we pressed send.
   */
  addIssueComment(
    owner: string,
    repo: string,
    number: number,
    body: string,
  ): Promise<GitHubIssueComment> {
    return this.write<GitHubIssueComment>(
      `${repoPath(owner, repo)}/issues/${number}/comments`,
      'POST',
      { body },
    );
  }

  /**
   * The people who can be @mentioned on this repository's issues — the picker's source list.
   *
   * `/assignees` rather than `/collaborators`, deliberately: they return the same set of humans
   * for any ordinary repository, but listing collaborators **requires push access**, so on the
   * project you merely file issues against the picker would come back empty for a reason no
   * error could explain. Read access is enough for this one.
   *
   * The whole list, filtered in main: GitHub offers no query parameter here, and a repository's
   * collaborator list is small enough that two pages is the entire answer nearly always.
   */
  listAssignableUsers(owner: string, repo: string, maxPages = 2): Promise<GitHubUser[]> {
    return this.paged<GitHubUser>(`${repoPath(owner, repo)}/assignees?per_page=100`, maxPages);
  }

  /**
   * One pull request in full — the head SHA, the branches, `mergeable` and
   * `mergeable_state`. None of those are on a search row, so this is the only route to
   * knowing whether CI is green or whether the branch conflicts.
   */
  getPullRequest(owner: string, repo: string, number: number): Promise<GitHubPullRequest> {
    return this.request<GitHubPullRequest>(`${repoPath(owner, repo)}/pulls/${number}`);
  }

  /**
   * Update a pull request's own fields — `PATCH /repos/{owner}/{repo}/pulls/{number}`.
   *
   * Only `body` is ever sent, and it is the only field `createPr.ts`'s refresh-on-push ever
   * asks for: the description needs to stay in step with the branch's own commits every time
   * it is pushed, but the title is left alone, because a human may have retitled the pull
   * request and nothing here should undo that.
   */
  updatePullRequest(
    owner: string,
    repo: string,
    number: number,
    input: { body: string },
  ): Promise<GitHubPullRequest> {
    return this.write<GitHubPullRequest>(`${repoPath(owner, repo)}/pulls/${number}`, 'PATCH', {
      body: input.body,
    });
  }

  /**
   * Update the branch — `PUT /repos/{owner}/{repo}/pulls/{number}/update-branch`.
   *
   * GitHub's counterpart of GitLab's rebase button, though it merges the base INTO the head
   * rather than replaying commits on top of it — the distinction GitHub itself draws between
   * "update branch" and a true rebase. Queued rather than done inline, so the response carries
   * no new `mergeable_state`: the caller re-syncs afterwards the same way a poll would.
   */
  async updateBranch(owner: string, repo: string, number: number): Promise<void> {
    await this.write<unknown>(`${repoPath(owner, repo)}/pulls/${number}/update-branch`, 'PUT');
  }

  /**
   * Merge it — `PUT /repos/{owner}/{repo}/pulls/{number}/merge`.
   *
   * `merge_method` is never left for GitHub to default: the repository's own
   * `allow_merge_commit`/`allow_squash_merge`/`allow_rebase_merge` toggles are read off a
   * fresh {@link getPullRequest} (`base.repo` carries the full repository, not just its id —
   * see {@link GitHubRepoRef}) and resolved with {@link pickMergeMethod}, so a repository that
   * disabled plain merge commits gets squash instead of a refusal.
   *
   * `sha`, when given, is GitHub's own guard against merging a branch that moved out from
   * under the human after they looked at it — a mismatch answers with a 409. That refusal,
   * same as "not mergeable" (405) or a merge GitHub itself blocks (406/422), goes through the
   * same {@link write} every other mutation does, so it surfaces as a {@link GitHubError}
   * carrying GitHub's own message.
   *
   * `message`, when given and not blank, becomes `commit_title` (its first line) and
   * `commit_message` (the rest) — never sent for `rebase`, which replays the branch's own
   * commits and has no commit message of its own to set.
   */
  async mergePullRequest(
    owner: string,
    repo: string,
    number: number,
    sha?: string,
    message?: string,
  ): Promise<GitHubMergeResult> {
    const pr = await this.getPullRequest(owner, repo, number);
    const merge_method = pickMergeMethod(pr.base?.repo ?? {});
    const split =
      merge_method !== 'rebase' && message && message.trim() ? splitCommitMessage(message) : null;
    return this.write<GitHubMergeResult>(`${repoPath(owner, repo)}/pulls/${number}/merge`, 'PUT', {
      ...(sha ? { sha } : {}),
      merge_method,
      ...(split
        ? { commit_title: split.title, ...(split.body ? { commit_message: split.body } : {}) }
        : {}),
    });
  }

  /**
   * The commit message GitHub itself would propose for merging this pull request, and the
   * method it would use — read with GraphQL's `viewerMergeHeadlineText`/`viewerMergeBodyText`,
   * which the REST API has no equivalent for, because every forge renders its own default
   * commit-message templates and re-implementing them here would drift the moment either
   * side changes its template syntax.
   *
   * `method` is {@link pickMergeMethod} read off the SAME `base.repo` toggles
   * {@link mergePullRequest} itself reads, so the proposal and the merge can never disagree
   * about which method applies. `rebase` creates no merge commit, so GitHub has no headline
   * or body to propose for it and the GraphQL call is skipped entirely.
   */
  async getMergeProposal(
    owner: string,
    repo: string,
    number: number,
  ): Promise<{ method: 'merge' | 'squash' | 'rebase'; message: string | null }> {
    const pr = await this.getPullRequest(owner, repo, number);
    const method = pickMergeMethod(pr.base?.repo ?? {});
    if (method === 'rebase') return { method, message: null };
    const mergeType = method === 'squash' ? 'SQUASH' : 'MERGE';
    const data = await this.graphql<{
      repository?: {
        pullRequest?: {
          viewerMergeHeadlineText?: string | null;
          viewerMergeBodyText?: string | null;
        } | null;
      } | null;
    }>(
      `query($owner: String!, $repo: String!, $number: Int!, $mergeType: PullRequestMergeMethod!) {
        repository(owner: $owner, name: $repo) {
          pullRequest(number: $number) {
            viewerMergeHeadlineText(mergeType: $mergeType)
            viewerMergeBodyText(mergeType: $mergeType)
          }
        }
      }`,
      { owner, repo, number, mergeType },
    );
    const headline = data.repository?.pullRequest?.viewerMergeHeadlineText ?? null;
    const body = data.repository?.pullRequest?.viewerMergeBodyText ?? null;
    if (!headline) return { method, message: null };
    const message = body && body.trim() ? `${headline}\n\n${body}` : headline;
    return { method, message };
  }

  /**
   * Open a pull request — `POST /repos/{owner}/{repo}/pulls`.
   *
   * The one call in this client that creates something on github.com, and it goes through
   * the same private {@link write} every other mutation does, so it inherits the "a read
   * cannot become a write by accident" separation rather than restating it.
   *
   * **An existing pull request is a SUCCESS.** GitHub refuses a duplicate with a 422, and
   * that refusal is exactly the outcome to expect from pressing the button twice or from a
   * step re-running — so it is caught, the open PR for that head is fetched, and the caller
   * gets it back with `existed: true`. The only thing it must not do is invent one: if the
   * lookup comes back empty (somebody closed it in the half second in between, a fork whose
   * head we spelled differently from GitHub's own listing) the original 422 is re-thrown,
   * because a refusal we cannot explain is better than a silent nothing.
   */
  async createPullRequest(
    owner: string,
    repo: string,
    input: CreatePullRequestInput,
  ): Promise<CreatedPullRequest> {
    try {
      const pullRequest = await this.write<GitHubPullRequest>(
        `${repoPath(owner, repo)}/pulls`,
        'POST',
        {
          head: input.head,
          base: input.base,
          title: input.title,
          // Sent even when empty, so a card with no description clears rather than inherits.
          body: input.body ?? '',
          draft: input.draft ?? false,
        },
      );
      return { pullRequest, existed: false };
    } catch (err) {
      if (!isAlreadyExists(err)) throw err;
      const open = await this.findOpenPullRequest(owner, repo, input.head);
      if (!open) throw err;
      return { pullRequest: open, existed: true };
    }
  }

  /**
   * The open pull request whose head is `head`, or null when there is none.
   *
   * `head` is qualified with the owner when the caller did not already do so, because that
   * is what the LIST endpoint requires — `?head=branch` silently matches nothing, which
   * would read as "there is no such pull request" for one that is plainly there.
   */
  async findOpenPullRequest(
    owner: string,
    repo: string,
    head: string,
  ): Promise<GitHubPullRequest | null> {
    const qualified = head.includes(':') ? head : `${owner}:${head}`;
    const body = await this.request<unknown>(
      `${repoPath(owner, repo)}/pulls?state=open&head=${encodeURIComponent(qualified)}&per_page=1`,
    );
    const list = Array.isArray(body) ? (body as GitHubPullRequest[]) : [];
    return list[0] ?? null;
  }

  /**
   * A pull request's INLINE review comments, oldest first.
   *
   * `/pulls/{n}/comments`, which is a different endpoint from `/issues/{n}/comments` despite a
   * PR being an issue: the conversation tab is the issue's, the diff remarks are the pull
   * request's, and a PR reviewed line-by-line has all of its discussion in the second one.
   * Both are needed before "has anybody said anything here" can be answered honestly.
   *
   * Two pages, the same cap and the same reasoning as {@link listIssueComments}: only the
   * newest foreign comment is ever read off the result.
   */
  listReviewComments(
    owner: string,
    repo: string,
    number: number,
    maxPages = 2,
  ): Promise<GitHubReviewComment[]> {
    return this.paged<GitHubReviewComment>(
      `${repoPath(owner, repo)}/pulls/${number}/comments?per_page=100`,
      maxPages,
    );
  }

  /** Every review, oldest first — GitHub returns the whole history, not the current state. */
  listReviews(owner: string, repo: string, number: number, maxPages = 3): Promise<GitHubReview[]> {
    return this.paged<GitHubReview>(
      `${repoPath(owner, repo)}/pulls/${number}/reviews?per_page=100`,
      maxPages,
    );
  }

  /**
   * The check runs on a commit — GitHub's answer to GitLab's pipeline jobs.
   *
   * `filter=latest` is the default and is sent anyway, because it is what makes a re-run
   * replace its failed predecessor rather than sit beside it. GitLab has no such filter and
   * `pipelineStages.ts` has to dedupe by hand; here the server does it, and being explicit
   * stops a future default change quietly reintroducing the stale-red-stage bug.
   *
   * Follows `Link: rel="next"` the same way {@link paged} does, and to the same `maxPages`
   * cap — but is not written as a call to `paged` itself, because a page here comes back as
   * `{ check_runs: [...] }` rather than the bare array `paged` expects. A repository whose
   * commit has more than 100 check runs (a large monorepo's matrix build, say) would
   * otherwise silently lose everything past the first page.
   */
  async listCheckRuns(
    owner: string,
    repo: string,
    sha: string,
    maxPages = 5,
  ): Promise<GitHubCheckRun[]> {
    const all: GitHubCheckRun[] = [];
    let url: string | null = this.url(
      `${repoPath(owner, repo)}/commits/${encodeURIComponent(sha)}/check-runs?per_page=100&filter=latest`,
    );
    for (let i = 0; i < maxPages && url; i++) {
      const { body, res }: { body: unknown; res: Response } = await this.rawUrl(url);
      const runs = (body as { check_runs?: unknown } | null)?.check_runs;
      if (Array.isArray(runs)) all.push(...(runs as GitHubCheckRun[]));
      url = nextPageUrl(res.headers?.get('link'));
    }
    return all;
  }

  /**
   * The legacy commit statuses on a commit, rolled up.
   *
   * Not a fallback for a failed call — a fallback for a different WORLD: plenty of repos
   * still report CI through the statuses API (Jenkins, Buildkite, CircleCI's older
   * integration), and those have no check runs at all. A PR there would otherwise read as
   * "no pipeline" while a wall of red sat on it in the browser.
   */
  getCombinedStatus(owner: string, repo: string, sha: string): Promise<GitHubCombinedStatus> {
    return this.request<GitHubCombinedStatus>(
      `${repoPath(owner, repo)}/commits/${encodeURIComponent(sha)}/status?per_page=100`,
    );
  }

  /**
   * A branch's protection rule — the only place the *required* approval count lives.
   *
   * **403s without admin on the repository**, which is the ordinary case for anyone
   * contributing to someone else's project, and a 404 means the branch simply is not
   * protected. The caller distinguishes the two by {@link GitHubError.status}; neither is
   * an error worth surfacing.
   */
  getBranchProtection(
    owner: string,
    repo: string,
    branch: string,
  ): Promise<GitHubBranchProtection> {
    return this.request<GitHubBranchProtection>(
      `${repoPath(owner, repo)}/branches/${encodeURIComponent(branch)}/protection`,
    );
  }

  /**
   * Every changed file on a pull request — `GET /repos/{owner}/{repo}/pulls/{number}/files`,
   * following `Link: rel="next"` the same way {@link searchIssues} does (same loop shape),
   * up to `maxPages`.
   *
   * 30 pages of 100 by default: GitHub documents 3,000 files as the most it will ever return
   * for one pull request, so that is the cap read in full rather than a smaller default built
   * for every other list endpoint here. `truncated` means the same thing it does on
   * {@link GitHubSearchResult} — the cap stopped us with a `rel="next"` still left to follow.
   */
  async listPullRequestFiles(
    owner: string,
    repo: string,
    number: number,
    maxPages = 30,
  ): Promise<GitHubPullRequestFileList> {
    const files: GitHubPullRequestFile[] = [];
    let url: string | null = this.url(
      `${repoPath(owner, repo)}/pulls/${number}/files?per_page=100`,
    );
    for (let i = 0; i < maxPages && url; i++) {
      const { body, res }: { body: unknown; res: Response } = await this.rawUrl(url);
      if (Array.isArray(body)) files.push(...(body as GitHubPullRequestFile[]));
      url = nextPageUrl(res.headers?.get('link'));
    }
    return { files, truncated: url !== null };
  }

  /**
   * A file's raw content at a ref — `GET /repos/{owner}/{repo}/contents/{path}?ref=<ref>`
   * with `Accept: application/vnd.github.raw+json`, which hands back the file's bytes
   * directly rather than the base64-wrapped JSON envelope the default media type gives.
   * See {@link contentsPath} for how `path` is encoded.
   *
   * No size cap here — F15.8's `DIFF_FILE_MAX_BYTES` is where that is enforced. A 404 means
   * the file does not exist at that ref, and is left for the caller to decide what that means.
   */
  getRawFile(owner: string, repo: string, path: string, ref: string): Promise<string> {
    return this.rawText(contentsPath(owner, repo, path, ref), 'application/vnd.github.raw+json');
  }

  /**
   * The same file, as raw BYTES rather than text — what a context read needs for a path that
   * may not be UTF-8 (an image blob, say). Reads the response's `arrayBuffer()` rather than
   * `.text()`, so bytes that are not valid UTF-8 survive the round trip unchanged; `.text()`
   * would replace them with the Unicode replacement character.
   */
  async getRawFileBytes(owner: string, repo: string, path: string, ref: string): Promise<Buffer> {
    const res = await this.rawResponse(
      contentsPath(owner, repo, path, ref),
      'application/vnd.github.raw+json',
    );
    return Buffer.from(await res.arrayBuffer());
  }

  /**
   * Pull requests where you were asked to review — `is:pr is:open review-requested:@me`.
   *
   * Returns the whole {@link GitHubSearchResult} rather than just `.items` the way
   * {@link listMyPullRequests} does, so `truncated` reaches the queue service: a review
   * queue that silently dropped half its rows would be a worse failure than one that tells
   * the human it could not finish reading them.
   */
  listReviewRequests(maxPages = 5): Promise<GitHubSearchResult> {
    return this.searchIssues('is:pr is:open review-requested:@me archived:false', maxPages);
  }

  /**
   * A repository's numeric id — `GET /repos/{owner}/{repo}`. A search row carries only
   * `repository_url` (owner/repo, no id), so the `requested` queue's repo-id map falls
   * back to this one call per still-unseen repository, the same shape as
   * {@link getBranchProtection}.
   */
  getRepository(owner: string, repo: string): Promise<GitHubRepository> {
    return this.request<GitHubRepository>(repoPath(owner, repo));
  }

  /**
   * Arm auto-merge — GraphQL's `enablePullRequestAutoMerge`, the only route to it, since
   * REST has no field for "merge this once checks pass" short of polling and merging by
   * hand the moment they do.
   *
   * **Idempotent.** A fresh {@link getPullRequest} decides first: a non-null `auto_merge`
   * means some earlier call (ours or a human's) already armed it, and `'already'` is
   * reported rather than re-sending a mutation GitHub would refuse anyway.
   *
   * **The "clean status" fallback.** GitHub refuses `enablePullRequestAutoMerge` outright
   * when the pull request is already mergeable right now — its own wording calls this
   * "clean status" — because auto-merge exists for a PR that is still waiting on something.
   * That refusal is not a failure to report, it is the signal to do the merge directly, so
   * the plain {@link mergePullRequest} PUT is sent instead and `'merged'` is reported.
   *
   * Any other refusal (insufficient permissions, branch protection GitHub itself will not
   * let auto-merge skip) propagates as the {@link GitHubError} {@link graphql} already
   * throws, carrying GitHub's own message.
   */
  async enableAutoMerge(
    owner: string,
    repo: string,
    number: number,
    method: 'merge' | 'squash' | 'rebase',
  ): Promise<GitHubAutoMergeOutcome> {
    const pr = await this.getPullRequest(owner, repo, number);
    if (pr.auto_merge) return 'already';
    const mergeMethod = method === 'squash' ? 'SQUASH' : method === 'rebase' ? 'REBASE' : 'MERGE';
    try {
      await this.graphql<{ enablePullRequestAutoMerge?: { pullRequest?: { number?: number } } }>(
        `mutation($id: ID!, $m: PullRequestMergeMethod!) {
          enablePullRequestAutoMerge(input: {pullRequestId: $id, mergeMethod: $m}) {
            pullRequest { number }
          }
        }`,
        { id: pr.node_id, m: mergeMethod },
      );
      return 'enabled';
    } catch (err) {
      if (!(err instanceof GitHubError) || !/clean status/i.test(err.message)) throw err;
      await this.write<GitHubMergeResult>(`${repoPath(owner, repo)}/pulls/${number}/merge`, 'PUT', {
        merge_method: method,
      });
      return 'merged';
    }
  }

  /**
   * Disarm auto-merge — GraphQL's `disablePullRequestAutoMerge`. A no-op when the pull
   * request has none armed, read off the same `auto_merge` field {@link enableAutoMerge}
   * checks, so a card that is merely withdrawing a hold it never actually placed does not
   * send a mutation GitHub would answer with nothing to disarm.
   */
  async disableAutoMerge(owner: string, repo: string, number: number): Promise<void> {
    const pr = await this.getPullRequest(owner, repo, number);
    if (!pr.auto_merge) return;
    await this.graphql<{ disablePullRequestAutoMerge?: { clientMutationId?: string | null } }>(
      `mutation($id: ID!) {
        disablePullRequestAutoMerge(input: {pullRequestId: $id}) {
          clientMutationId
        }
      }`,
      { id: pr.node_id },
    );
  }

  /**
   * Everything a caller needs to decide whether arming auto-merge even makes sense: whether
   * the repository allows it at all, and what checks `base` requires — read from TWO places,
   * because GitHub itself keeps required checks in two places that can disagree:
   *
   *  - the classic `required_status_checks` on {@link getBranchProtection} (`contexts`, the
   *    deprecated plain-string list, plus `checks[].context`, what replaced it) — **403**
   *    means this repository's rules are admin-only to read, which flips
   *    `protectionReadable` to false and makes `requiredChecks` an honest `null` rather than
   *    an empty list that would read as "nothing is required"; **404** means the branch
   *    carries no classic protection at all, which is read as zero classic checks, not as a
   *    failure;
   *  - `GET /rules/branches/{base}`, the modern repository RULESET a branch can inherit
   *    instead of or alongside classic protection — read only when the classic call did not
   *    403, since an instance that hides branch protection from us has no reason to show its
   *    rulesets either, and a ruleset found in spite of that would just be a different
   *    half-answer wearing a `protectionReadable: true` it has not earned.
   *
   * The two check lists are merged into one deduplicated set — a required check is required
   * however the repository happens to have recorded it.
   */
  async getAutoMergeFacts(
    owner: string,
    repo: string,
    base: string,
  ): Promise<GitHubAutoMergeFacts> {
    const repository = await this.getRepository(owner, repo);
    const allowAutoMerge = repository.allow_auto_merge ?? null;

    const checks = new Set<string>();
    let protectionReadable = true;
    try {
      const protection = await this.getBranchProtection(owner, repo, base);
      for (const context of protection.required_status_checks?.contexts ?? []) {
        checks.add(context);
      }
      for (const check of protection.required_status_checks?.checks ?? []) {
        if (check.context) checks.add(check.context);
      }
    } catch (err) {
      if (!(err instanceof GitHubError)) throw err;
      if (err.status === 403) protectionReadable = false;
      else if (err.status !== 404) throw err;
    }

    if (protectionReadable) {
      try {
        const rules = await this.request<GitHubBranchRule[]>(
          `${repoPath(owner, repo)}/rules/branches/${encodeURIComponent(base)}`,
        );
        for (const rule of Array.isArray(rules) ? rules : []) {
          if (rule?.type !== 'required_status_checks') continue;
          for (const check of rule.parameters?.required_status_checks ?? []) {
            if (check.context) checks.add(check.context);
          }
        }
      } catch (err) {
        if (!(err instanceof GitHubError) || (err.status !== 404 && err.status !== 403)) throw err;
      }
    }

    return {
      allowAutoMerge,
      requiredChecks: protectionReadable ? Array.from(checks) : null,
      protectionReadable,
    };
  }
}
