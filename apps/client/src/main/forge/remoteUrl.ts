/**
 * Reading a git remote, and deciding which forge it belongs to.
 *
 * Pure: no `fetch`, no store, no Electron. Everything here is a function of a string the
 * repository already carries and the settings blob the user already filled in, which is
 * what makes "which forge is this branch going to?" answerable in a unit test rather than
 * against somebody's real GitHub.
 *
 * There are three spellings of the same remote and git treats them as interchangeable, so
 * anything that reads one has to handle all three:
 *
 *   git@github.com:owner/repo.git            — SCP-like, and NOT a URL: `new URL()` parses
 *                                              it as a `git:` scheme with the whole thing
 *                                              as a path, which is why it is matched first.
 *   https://gitlab.ex.com/group/sub/proj.git — ordinary, and note the nesting: GitLab
 *                                              subgroups mean the path is not `owner/repo`.
 *   ssh://git@host:22/o/r                    — a real URL with a port to drop.
 */
import type { ForgeProvider } from '@shared/mergeRequest';
import type { AppSettings } from '@shared/settings';

/** A remote broken into the two things anything downstream ever needs. */
export interface RemoteRef {
  /** The host, lower-cased and without a port or credentials — `github.com`. */
  host: string;
  /** The project path, with no leading slash and no `.git` — `group/sub/proj`. */
  path: string;
}

/** `git@host:path` — matched before anything tries to treat this as a URL. */
const SCP_LIKE = /^(?:([^@/]+)@)?([^:/]+):(.+)$/;

/**
 * Break a remote URL into its host and project path, or **null** when it is not one we can
 * read — a local path (`/srv/repos/x.git`, `C:\repos\x`), an empty string, anything without
 * both parts.
 *
 * Null is the honest answer and the caller must treat it as "this repo has no forge remote",
 * never as a reason to guess: a bare filesystem remote is a perfectly ordinary thing for a
 * repository to have, and inventing a host for it would send a pull request somewhere
 * nobody asked for one.
 */
export function parseRemoteUrl(url: string): RemoteRef | null {
  const raw = url.trim();
  if (!raw) return null;

  // A Windows drive letter (`C:\repos\x`) matches the SCP-like shape exactly, and is not a
  // remote host — so it is ruled out before the pattern is tried rather than after.
  if (/^[A-Za-z]:[\\/]/.test(raw)) return null;

  if (!raw.includes('://')) {
    const scp = SCP_LIKE.exec(raw);
    if (!scp) return null;
    return ref(scp[2], scp[3]);
  }

  try {
    const parsed = new URL(raw);
    // `file:` and `ssh:` share this branch on purpose: the scheme does not decide anything,
    // the presence of a host does. A `file:///srv/x.git` has an empty hostname and drops out.
    return ref(parsed.hostname, parsed.pathname);
  } catch {
    return null;
  }
}

/** Normalize the two halves, or null when either is missing once cleaned. */
function ref(host: string, path: string): RemoteRef | null {
  const cleanHost = host.trim().toLowerCase().replace(/:\d+$/, '');
  const cleanPath = path
    .trim()
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .replace(/\.git$/i, '');
  if (!cleanHost || !cleanPath || !cleanPath.includes('/')) return null;
  return { host: cleanHost, path: cleanPath };
}

/**
 * Which forge a host belongs to, or **null** when nothing here can say.
 *
 * Three questions, in order, and the order is the whole design:
 *
 *  1. **Does it match a configured instance?** A self-hosted GitLab and a GitHub Enterprise
 *     Server have hostnames nobody could guess, so the user's own `baseUrl` is the only
 *     thing that knows them — and it is the answer they would expect, since it is the
 *     instance they typed in.
 *  2. **Is it github.com / gitlab.com?** The two hosts that need no configuring.
 *  3. **Is exactly one provider switched on?** The last resort, and only when it is
 *     unambiguous. A person with GitHub enabled and nothing else, pushing to a host this
 *     file has never heard of, means GitHub — there is nothing else they could mean. With
 *     both enabled there IS something else they could mean, so this answers null and the
 *     caller refuses with a sentence naming the host it could not place.
 *
 * A disabled provider never wins any of the three: its settings are stale by definition, and
 * opening a pull request through an integration the human switched off is not a service.
 */
export function pickForge(host: string, settings: AppSettings): ForgeProvider | null {
  const target = host.trim().toLowerCase();
  if (!target) return null;

  const github = settings.github?.enabled ? settings.github : null;
  const gitlab = settings.gitlab?.enabled ? settings.gitlab : null;

  // 1 — the instance the user configured. `api.github.com` is deliberately allowed to match
  // `github.com`: the setting holds an API root, and the remote never will.
  if (github && hostMatches(target, hostOf(github.baseUrl))) return 'github';
  if (gitlab && hostMatches(target, hostOf(gitlab.baseUrl))) return 'gitlab';

  // 2 — the two public hosts, and their `www.`/`ssh.` spellings. Still only for a provider
  // that is switched on: a disabled integration has no token behind it, so answering
  // "github" here would only move the refusal one step later and name a vaguer wall.
  if (github && hostMatches(target, 'github.com')) return 'github';
  if (gitlab && hostMatches(target, 'gitlab.com')) return 'gitlab';

  // 3 — only one integration is on, so there is only one thing this could be.
  if (github && !gitlab) return 'github';
  if (gitlab && !github) return 'gitlab';
  return null;
}

/** The hostname inside a configured base URL, or '' when it is blank or unparseable. */
function hostOf(baseUrl: string | undefined): string {
  const raw = (baseUrl ?? '').trim();
  if (!raw) return '';
  try {
    return new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`).hostname.toLowerCase();
  } catch {
    return '';
  }
}

/**
 * Whether two hostnames name the same forge.
 *
 * Not string equality, because the host a remote is written with and the host an API is
 * served from routinely differ by one label: `api.github.com` against `github.com`,
 * `ssh.github.com` against `github.com`, `www.gitlab.com` against `gitlab.com`. Only the
 * three prefixes a forge actually uses are stripped — a blanket "ignore the first label"
 * would make `github.com.evil.example` match `com.evil.example`.
 */
function hostMatches(a: string, b: string): boolean {
  if (!a || !b) return false;
  const strip = (h: string): string => h.replace(/^(?:api|www|ssh)\./, '');
  return strip(a) === strip(b);
}
