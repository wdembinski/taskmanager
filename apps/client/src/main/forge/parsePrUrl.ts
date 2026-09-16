/**
 * Parsing a pasted merge-request/pull-request URL into forge coordinates.
 *
 * The one thing a "Link existing MR/PR" button has that `createPr.ts` never needed: a human
 * typed or copy-pasted a URL, and it has to become the (owner, repo, number) or (projectPath,
 * iid) a client call wants.
 *
 * Distinguished by PATH SEGMENT, never by host. Both forges are routinely self-hosted, so
 * `gitlab.example.com` and `git.mycompany.com` are both plausible hostnames for either one —
 * a host-based guess would be wrong for exactly the installs this feature exists to support.
 * GitLab's own URLs always carry `/-/merge_requests/{n}`; GitHub's always carry `/pull/{n}`.
 * Neither forge's URL shape uses the other's marker, so the path alone is enough, and it is
 * also the one part of the URL a self-hosted instance cannot rename.
 */

export type ParsedPrUrl =
  | { provider: 'gitlab'; projectPath: string; number: number }
  | { provider: 'github'; owner: string; repo: string; number: number };

/**
 * `/-/merge_requests/{n}`, with everything before `/-/` kept as the project path — including
 * every subgroup a nested GitLab group adds, since `(.+)` does not stop at the first `/`.
 */
const GITLAB_MR = /^\/(.+)\/-\/merge_requests\/(\d+)(?:\/.*)?$/;
/** `/{owner}/{repo}/pull/{n}` — GitHub repos never nest, so two segments is the whole path. */
const GITHUB_PR = /^\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:\/.*)?$/;
/** An explicit scheme (`https://…`), as opposed to a bare `gitlab.example.com/…`. */
const HAS_SCHEME = /^[a-zA-Z][a-zA-Z\d+.-]*:\/\//;

/**
 * `url` if it names one GitLab merge request or one GitHub pull request, or null for
 * anything else — including a GitHub issue (`/issues/{n}`) or a GitLab issue
 * (`/-/issues/{n}`), neither of which this app can open a merge/pull request client against.
 *
 * A trailing `/diffs`, a query string, a `#note-…`/`#note_…` anchor and a missing scheme are
 * all tolerated: the query and the fragment are never part of `URL#pathname` to begin with,
 * and the two path regexes above allow anything after the number.
 */
export function parsePrUrl(url: string): ParsedPrUrl | null {
  const trimmed = url.trim();
  if (!trimmed) return null;

  let parsed: URL;
  try {
    parsed = new URL(HAS_SCHEME.test(trimmed) ? trimmed : `https://${trimmed}`);
  } catch {
    return null;
  }

  const gitlab = GITLAB_MR.exec(parsed.pathname);
  if (gitlab) {
    const number = Number(gitlab[2]);
    if (Number.isFinite(number)) return { provider: 'gitlab', projectPath: gitlab[1], number };
  }

  const github = GITHUB_PR.exec(parsed.pathname);
  if (github) {
    const number = Number(github[3]);
    if (Number.isFinite(number)) {
      return { provider: 'github', owner: github[1], repo: github[2], number };
    }
  }

  return null;
}
