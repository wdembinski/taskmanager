/**
 * Which card a GitHub pull request belongs to.
 *
 * GitLab's answer is one rule — find something key-shaped in the branch, title or
 * description and intersect it with the board (`forge/issueKeys.ts`). GitHub needs **two**,
 * because a pull request names its issue in two genuinely different ways and both are in
 * daily use:
 *
 *  - **A closing reference.** `Closes #123`, `Fixes owner/repo#45`, `Resolves` the issue URL.
 *    This is not a convention somebody adopted — it is a GitHub *feature*: the reference
 *    closes the issue when the PR lands, and the two are linked in GitHub's own UI. When a
 *    PR carries one, that is the issue it is for, and nothing else it mentions competes.
 *  - **A tracker key**, exactly as on GitLab: a branch called `feature/ENG-431`, a title
 *    starting `ENG-431:`. This is how a team using JIRA for tickets and GitHub for code
 *    links the two, and GitHub knows nothing about it.
 *
 * A bare `#123` is the case worth being careful about: it means issue 123 **of the pull
 * request's own repository**, and issue 123 exists in every repository there has ever been.
 * So the candidate is `owner/repo#123` — the repo-scoped spelling a GitHub issue is filed
 * under on the board — and never the bare number, which would file a PR under whichever
 * repository's issue 123 happened to be on screen.
 *
 * The safety net is the same one and just as load-bearing: every candidate, of either kind,
 * is intersected with the keys the board ACTUALLY holds. A key nothing on the board carries
 * is not a key.
 *
 * Pure: no fetch, no DB.
 */
import { discoverIssueKeys, type MergeRequestText } from '../forge/issueKeys';

/**
 * A closing keyword followed by an issue reference.
 *
 * The keyword set is GitHub's whole documented list — `close`/`closes`/`closed`,
 * `fix`/`fixes`/`fixed`, `resolve`/`resolves`/`resolved` — because a PR saying "Resolved
 * #12" is linked by GitHub exactly as one saying "Closes #12" is, and recognising only the
 * popular three would leave those PRs unfiled for no reason a user could see.
 *
 * Three reference forms, in one alternation:
 *
 *  - the full issue URL (groups 1–3), which is what a paste from the browser produces;
 *  - `owner/repo#123` (groups 4–5 plus 6), a cross-repository reference;
 *  - a bare `#123` (group 6 alone), which means the PR's own repository.
 *
 * `\b` in front of the keyword matters: without it "prefixes #3" reads as "fixes #3".
 */
const CLOSING_REFERENCE =
  /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b\s*:?\s*(?:https?:\/\/[^\s/]+\/([\w.-]+)\/([\w.-]+)\/issues\/(\d+)|(?:([\w.-]+)\/([\w.-]+))?#(\d+))/gi;

/**
 * Every issue this text closes, written `owner/repo#123`.
 *
 * `projectPath` is the pull request's own repository and is what a bare `#123` resolves
 * against; a reference that names its own repository ignores it. A bare number with no
 * `projectPath` to resolve against is dropped rather than guessed at — see the header.
 */
export function closingReferences(text: string, projectPath: string): string[] {
  const out: string[] = [];
  for (const match of text.matchAll(CLOSING_REFERENCE)) {
    const owner = match[1] ?? match[4];
    const repo = match[2] ?? match[5];
    const number = match[3] ?? match[6];
    const path = owner && repo ? `${owner}/${repo}` : projectPath;
    if (!path || !number) continue;
    const key = `${path}#${number}`;
    if (!out.includes(key)) out.push(key);
  }
  return out;
}

/** The text of a pull request, plus the repository a bare `#123` in it refers to. */
export interface PullRequestText extends MergeRequestText {
  /** `owner/repo` — what a bare `#123` in this pull request means. */
  projectPath?: string | null;
}

/**
 * The board keys this pull request names, best first.
 *
 * **Closing references win**, and that is the one ordering decision here: a PR that says
 * "Closes #123" and is on a branch called `wd/ENG-9` is doing two different things — it is
 * *for* issue 123, and it happens to mention a JIRA ticket — and GitHub itself will close
 * 123 when it lands. Within each kind the existing order stands: title before body for a
 * closing reference, and branch before title before body for a tracker key, which is
 * `discoverIssueKeys`'s own ordering.
 *
 * Matching is case-insensitive and the returned keys are the board's own spelling, so
 * callers can look them up directly. `pickTaskKey` takes the first, exactly as on GitLab.
 */
export function discoverPullRequestKeys(
  pr: PullRequestText,
  knownKeys: readonly string[],
): string[] {
  const known = new Map(knownKeys.map((k) => [k.trim().toUpperCase(), k]));
  if (known.size === 0) return [];

  const found: string[] = [];
  const add = (candidate: string): void => {
    const real = known.get(candidate.toUpperCase());
    if (real && !found.includes(real)) found.push(real);
  };

  const projectPath = pr.projectPath?.trim() ?? '';
  for (const source of [pr.title, pr.description]) {
    if (!source) continue;
    for (const ref of closingReferences(source, projectPath)) add(ref);
  }
  for (const key of discoverIssueKeys(pr, knownKeys)) add(key);
  return found;
}

/**
 * Whether a key is the repo-scoped kind — i.e. one that can only have come from a closing
 * reference (or a bare `#123` resolved against the PR's repo).
 *
 * Used by re-matching, which sees the fields we STORE and the description is not one of
 * them: a closing reference written in the body is a key the app can only remember, and
 * without this it would lose to a tracker key in the title on every board change — so the
 * sync and a re-match would file the same PR under two different cards.
 */
export function isRepoScopedKey(key: string): boolean {
  return key.includes('#');
}
