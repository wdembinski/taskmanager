/**
 * Turning a card's own title and description into the Conventional-Commits subject and
 * wrapped, trailer-ending body CONTRIBUTING.md §1/§2 require — the automated counterpart to
 * a hand-written commit, used when the app opens a pull request for a card
 * (`apps/client/src/main/forge/createPr.ts`'s `prTitle`/`prBody`) rather than a human typing
 * one. Kept pure and total — no git, no store — so it is unit-tested the same way
 * `branchName.ts` is, and reused for its inference instead of duplicating it: the branch
 * name and the PR subject should never disagree about what kind of work this is.
 */
import { inferBranchType, type BranchType, type BranchTypeInput } from './branchName';

/** CONTRIBUTING.md §1's whole-subject-line budget, `type:`/`type(scope):` included. */
const SUBJECT_MAX = 50;

/**
 * CONTRIBUTING.md's seven commit types have no row for `branchName.ts`'s `build`/`ci`/
 * `style` — all three land under `chore`, its own catch-all for "Build, tooling,
 * dependencies, release plumbing".
 */
const COMMIT_TYPE_FROM_BRANCH_TYPE: Record<BranchType, string> = {
  feat: 'feat',
  fix: 'fix',
  ref: 'refactor',
  tests: 'test',
  docs: 'docs',
  chore: 'chore',
  perf: 'perf',
  build: 'chore',
  ci: 'chore',
  style: 'chore',
};

/** The Conventional Commits `type`, reusing {@link inferBranchType} so a card's branch name
 *  and its pull request's subject are derived from the same read of it. */
export function commitType(input: BranchTypeInput): string {
  return COMMIT_TYPE_FROM_BRANCH_TYPE[inferBranchType(input)];
}

/** A leading ticket-key token ("TM-15: ", "ABC-123 — ") — dropped from the subject because
 *  the key already has its own `Ticket ID:` trailer in the body, so repeating it inside the
 *  50-character budget would only spend characters the summary needs more. */
function dropLeadingKey(title: string): string {
  return title.replace(/^[A-Za-z][A-Za-z0-9]*-\d+\s*[:\-–—]?\s*/, '');
}

/** Fit `text` into `maxLen`, cutting on a word boundary rather than mid-word — the same rule
 *  `slugify` (./branchName.ts) uses for a branch slug. */
function fit(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  const cut = text.slice(0, maxLen);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > maxLen * 0.5 ? cut.slice(0, lastSpace) : cut).trimEnd();
}

/**
 * The subject line: `type: summary`, 50 characters or fewer, lower case, no trailing full
 * stop — CONTRIBUTING.md §1. No `(scope)`: nothing on a `Task` names the area of the app a
 * card touches, and a guessed one would be worse than none, which is exactly why CONTRIBUTING
 * calls scope "optional".
 */
export function prSubject(input: BranchTypeInput): string {
  const prefix = `${commitType(input)}: `;
  const summary = fit(dropLeadingKey(input.title).trim(), SUBJECT_MAX - prefix.length)
    .replace(/[.!]+$/, '')
    .toLowerCase();
  return prefix + summary;
}

/** A line starting a bullet item: `-`, `*`, `•`, or `1.`, each followed by whitespace. */
const BULLET_RE = /^(?:[-*•]|\d+\.)\s+/;

/** Markdown decorations a card's description may carry, stripped on the way to plain text:
 *  bold/italic emphasis, inline code, and `[text](url)` links down to `text (url)`. */
function stripInlineMarkdown(text: string): string {
  return text
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/(\*|_)(.*?)\1/g, '$2')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)');
}

/**
 * Greedy word-wrap of one logical line of text to `width` columns, continuation lines
 * indented by `indent` spaces — CONTRIBUTING.md §2's alignment rule ("two spaces in" under a
 * bullet, "eight" under a trailer).
 */
export function wrapHanging(text: string, width: number, indent: number): string {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (candidate.length > width && line) {
      lines.push(line);
      line = word;
    } else {
      line = candidate;
    }
  }
  if (line) lines.push(line);
  const pad = ' '.repeat(indent);
  return lines.map((l, i) => (i === 0 ? l : pad + l)).join('\n');
}

/**
 * Reflow a card's markdown-ish description into CONTRIBUTING.md §2's plain-text, 72-column
 * shape: a blank line separates blocks, a block whose first line is a bullet stays a bullet
 * list (one `- ` item per bullet, wrapped with a 2-space hanging indent), and anything else
 * is a prose paragraph (its own line breaks collapsed, then rewrapped flat). Markdown
 * headers, emphasis, inline code and links are stripped rather than carried through, since a
 * commit body is read in a terminal.
 */
export function wrapPlainText(markdown: string, width = 72): string {
  const blocks = markdown
    .replace(/\r\n/g, '\n')
    .trim()
    .split(/\n\s*\n/)
    .map((b) => b.trim())
    .filter(Boolean);
  return blocks.map((block) => wrapBlock(block, width)).join('\n\n');
}

function wrapBlock(block: string, width: number): string {
  const lines = block
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) return '';

  if (BULLET_RE.test(lines[0])) {
    const items: string[] = [];
    for (const line of lines) {
      if (BULLET_RE.test(line)) {
        items.push(line.replace(BULLET_RE, ''));
      } else if (items.length > 0) {
        items[items.length - 1] += ` ${line}`;
      } else {
        items.push(line);
      }
    }
    return items.map((item) => wrapHanging(`- ${stripInlineMarkdown(item)}`, width, 2)).join('\n');
  }

  const paragraph = stripInlineMarkdown(lines.map((l) => l.replace(/^#{1,6}\s+/, '')).join(' '));
  return wrapHanging(paragraph, width, 0);
}
