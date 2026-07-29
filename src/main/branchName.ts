/**
 * The git branch an agent's worktree runs on.
 *
 * Runs used to happen on `orch/<uuid>`, which is fine for a branch nobody looks at and
 * useless for one you might want to push, review, or find three days later. The format
 * here is the one the user asked for:
 *
 *     <prefix>/<type>/<jira-key>/<slug>
 *
 * with two rules that make it more than a concatenation: an empty prefix yields **no
 * leading slash** (`/feat/…` is not a valid git ref), and a card with no ticket omits that
 * segment entirely rather than leaving `//` or inventing a placeholder.
 *
 * `<type>` is a Conventional Commits type, inferred from the ticket and the title but
 * always overridable — the human picks it in the assign dialog, and this module's job is
 * to propose something sensible, not to be right.
 *
 * Pure and total: the whole naming policy is unit-tested without git, a store, or a
 * session, which is why validation reimplements git-check-ref-format rather than shelling
 * out (the dialog also needs to validate on every keystroke).
 */

/** The Conventional Commits types offered, in the order the dialog lists them. */
export const BRANCH_TYPES = [
  'feat',
  'fix',
  'ref',
  'tests',
  'docs',
  'chore',
  'perf',
  'build',
  'ci',
  'style',
] as const;

export type BranchType = (typeof BRANCH_TYPES)[number];

export interface BranchNameInput {
  title: string;
  /** The JIRA issue type ("Bug", "Story", "Task"), when the card has one. */
  externalType?: string | null;
  /** The JIRA key ("ABC-123"); lower-cased into the branch. */
  externalKey?: string | null;
  /** `AppSettings.branchPrefix`. Empty means no prefix segment and no leading slash. */
  prefix?: string;
  /** Overrides inference when the human has picked a type. */
  type?: BranchType;
}

/**
 * JIRA issue types that decide the branch type on their own. `Task`, `Sub-task`,
 * `Improvement` and friends are deliberately absent: they say nothing about the KIND of
 * work, so those fall through to the title, which usually does.
 */
const TYPE_FROM_ISSUE: ReadonlyArray<[test: RegExp, type: BranchType]> = [
  [/^(bug|defect|incident|hotfix|problem)$/i, 'fix'],
  [/^(story|new feature|feature|epic|initiative)$/i, 'feat'],
];

/**
 * Leading verbs that name the kind of work. First match wins, so order matters.
 *
 * The trailing `\b` is what stops a verb-lookalike winning ("Fixture" is not `fix`), so
 * the alternatives are whole words — except the two written as STEMS, which carry their
 * own `\w*` because `migrat\b` can never match "Migrate": the boundary the `\b` wants
 * falls in the middle of a word.
 */
const TYPE_FROM_TITLE: ReadonlyArray<[test: RegExp, type: BranchType]> = [
  [/^(fix|repair|correct|resolve|patch|bug|debug|handle)\b/i, 'fix'],
  [
    /^(refactor|extract|rename|move|simplify|clean|tidy|restructur\w*|migrat\w*|split|inline)\b/i,
    'ref',
  ],
  [/^(test|cover|spec|e2e|unit)\b/i, 'tests'],
  [/^(document|docs?|readme|comment|annotate)\b/i, 'docs'],
  [/^(bump|upgrade|chore|configure|setup|pin|vendor)\b/i, 'chore'],
  [/^(optimi[sz]e|speed|perf|cache|memoi[sz]e)\b/i, 'perf'],
  [/^(package|bundle|build|compile)\b/i, 'build'],
  [/^(style|format|lint|prettify)\b/i, 'style'],
];

/**
 * Pick the Conventional Commits type.
 *
 * The JIRA issue type wins when it is decisive, because it is a human's own
 * classification of the work. Otherwise the title's leading verb decides. `feat` is the
 * fallback — the honest default for "some work whose kind nobody stated".
 */
export function inferBranchType(title: string, externalType?: string | null): BranchType {
  const issue = (externalType ?? '').trim();
  for (const [test, type] of TYPE_FROM_ISSUE) {
    if (test.test(issue)) return type;
  }
  const text = title.trim();
  for (const [test, type] of TYPE_FROM_TITLE) {
    if (test.test(text)) return type;
  }
  return 'feat';
}

/** How much of a title survives into the slug. Long enough to identify, short enough to type. */
const SLUG_MAX = 40;

/**
 * Lower-case, ASCII, hyphen-separated. Accents are folded rather than dropped so
 * "Émojis" becomes "emojis" and not "mojis"; everything else non-alphanumeric collapses.
 */
export function slugify(text: string, maxLen: number = SLUG_MAX): string {
  const ascii = text
    .normalize('NFKD')
    // Combining marks left behind by the decomposition above.
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (ascii.length <= maxLen) return ascii;
  // Cut on a hyphen so the slug ends on a whole word, unless that would leave almost
  // nothing (one very long token).
  const cut = ascii.slice(0, maxLen);
  const lastDash = cut.lastIndexOf('-');
  return (lastDash > maxLen * 0.5 ? cut.slice(0, lastDash) : cut).replace(/-+$/, '');
}

/** The slug used when a title yields nothing sluggable (emoji-only, CJK-only, blank). */
const FALLBACK_SLUG = 'work';

/**
 * Compose the branch name. Never emits `//`, a leading or trailing `/`, or a trailing `-`.
 */
export function buildBranchName(input: BranchNameInput): string {
  const type = input.type ?? inferBranchType(input.title, input.externalType);
  const segments: string[] = [];

  // A prefix may itself be a path (`team/wd`), so it is slugified per segment rather than
  // as a whole — otherwise its own slashes would collapse into hyphens.
  const prefix = (input.prefix ?? '').trim().replace(/^\/+|\/+$/g, '');
  if (prefix) {
    for (const part of prefix.split('/')) {
      const slug = slugify(part);
      if (slug) segments.push(slug);
    }
  }

  segments.push(type);

  const key = (input.externalKey ?? '').trim();
  if (key) segments.push(slugify(key));

  segments.push(slugify(input.title) || FALLBACK_SLUG);
  return segments.join('/');
}

/**
 * Whether git would accept this as a branch name.
 *
 * A restatement of git-check-ref-format's rules, so the assign dialog can validate as the
 * user types instead of discovering the problem when the worktree fails to be created.
 */
export function validateBranchName(name: string): { ok: true } | { ok: false; reason: string } {
  const value = name.trim();
  if (!value) return { ok: false, reason: 'it is empty' };
  if (value !== name) return { ok: false, reason: 'it starts or ends with a space' };
  if (value.startsWith('/') || value.endsWith('/')) {
    return { ok: false, reason: 'it starts or ends with a slash' };
  }
  if (value.includes('//')) return { ok: false, reason: 'it has an empty path segment (//)' };
  if (value.includes('..')) return { ok: false, reason: 'it contains ".."' };
  if (value.endsWith('.')) return { ok: false, reason: 'it ends with a dot' };
  if (value.endsWith('.lock')) return { ok: false, reason: 'it ends with ".lock"' };
  if (value.includes('@{')) return { ok: false, reason: 'it contains "@{"' };
  if (value === '@') return { ok: false, reason: '"@" on its own is reserved' };
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(value)) return { ok: false, reason: 'it contains a control character' };
  const bad = [' ', '~', '^', ':', '?', '*', '[', '\\'].find((c) => value.includes(c));
  if (bad) return { ok: false, reason: `it contains "${bad}"` };
  for (const segment of value.split('/')) {
    if (!segment) return { ok: false, reason: 'it has an empty path segment' };
    if (segment.startsWith('.')) return { ok: false, reason: 'a path segment starts with a dot' };
    if (segment.endsWith('.lock')) return { ok: false, reason: 'a path segment ends with ".lock"' };
  }
  return { ok: true };
}

/**
 * `name`, then `name-2`, `name-3`… until `taken` says no.
 *
 * Suffixed rather than prefixed so the interesting part of the name stays where the eye
 * lands, and so sorting keeps the variants of one branch together.
 */
export function dedupeBranchName(name: string, taken: (candidate: string) => boolean): string {
  if (!taken(name)) return name;
  for (let n = 2; n < 100; n += 1) {
    const candidate = `${name}-${n}`;
    if (!taken(candidate)) return candidate;
  }
  return name;
}
