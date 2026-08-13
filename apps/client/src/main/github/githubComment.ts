/**
 * The Markdown body of a comment the human composed — `jira/adf.ts`'s job, one tracker over
 * and very nearly nothing.
 *
 * That "nearly nothing" is the point worth writing down. A JIRA comment needs a document built
 * for it, because JIRA does not accept the text a human typed: mentions are structured nodes
 * carrying an account id, so `buildAdf` has to rebuild the whole paragraph around them. GitHub
 * accepts Markdown, and a mention in Markdown is spelled `@login` — the same characters the
 * composer already put in the text. So the body is the text, and the only thing this module
 * does is make the ONE substitution that could still be needed.
 *
 * **Why any substitution at all.** The composer inserts `@{displayName}` and records the range
 * it occupies (`ui/chat/mentions.ts`). `github:searchUsers` hands it the login as the display
 * name precisely so that what lands in the text is already resolvable — but the id is what the
 * human *picked*, and the text is what they can then edit. When the two disagree (a person
 * picked from a list that offered a real name, a label typed over by hand), the pick wins: a
 * mention that does not resolve is a message the person named will never see.
 *
 * Pure: no fetch, no Electron, no DB.
 */

/** A person the composer resolved, with the range of `text` their label occupies. */
export interface GitHubMention {
  /** Inclusive start offset into the plain text. */
  start: number;
  /** Exclusive end offset into the plain text. */
  end: number;
  /** The GitHub login. Null means "never resolved" — left as the plain text it already is. */
  login: string | null;
}

/**
 * Mentions that are in range and non-overlapping, earliest first.
 *
 * `adf.usableMentions` verbatim in behaviour, and copied rather than shared for the reason
 * `githubIssueSync.repoRefFrom` gives about its own four lines: the two modules are different
 * trackers' writers and share nothing else, and importing the JIRA one here would make this
 * file depend on a document format it deliberately has no use for.
 */
function usableMentions(text: string, mentions: readonly GitHubMention[]): GitHubMention[] {
  const sorted = [...mentions]
    .filter((m) => m.start >= 0 && m.end <= text.length && m.end > m.start)
    .sort((a, b) => a.start - b.start);
  const out: GitHubMention[] = [];
  let cursor = 0;
  for (const m of sorted) {
    if (m.start < cursor) continue; // overlaps one we already took — drop it
    out.push(m);
    cursor = m.end;
  }
  return out;
}

/**
 * The comment body to POST: the human's text, with every resolved mention spelled the way
 * GitHub resolves one.
 *
 * A range that already reads `@login` is rewritten to the identical string — the ordinary case,
 * and the reason this function is usually the identity.
 */
export function buildCommentBody(text: string, mentions: readonly GitHubMention[] = []): string {
  const usable = usableMentions(text, mentions);
  if (!usable.length) return text;
  let out = '';
  let at = 0;
  for (const m of usable) {
    const login = m.login?.trim();
    if (!login) continue; // unresolved: whatever the human typed is the whole of it
    out += text.slice(at, m.start);
    out += `@${login}`;
    at = m.end;
  }
  return out + text.slice(at);
}
