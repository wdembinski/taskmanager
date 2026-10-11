/**
 * Turning a card's own title and description into the Conventional-Commits subject and
 * wrapped, trailer-ending body CONTRIBUTING.md §1/§2 require — the automated counterpart to
 * a hand-written commit, used when the app opens a pull request for a card
 * (`apps/client/src/main/forge/createPr.ts`'s `prTitle`/`prBody`) rather than a human typing
 * one. Kept pure and total — no git, no store — so it is unit-tested the same way
 * `branchName.ts` is, and reused for its inference instead of duplicating it: the branch
 * name and the PR subject should never disagree about what kind of work this is.
 *
 * The other half of the file reads the OTHER direction: `parseCommitMessage` takes a
 * commit's own raw text apart into its subject, body and trailers, and
 * `branchChangesBody`/`aggregateTested` fold a whole branch's worth of those back into the
 * body and `Tested:` trailer of the pull request `prBody` builds. That is what lets the
 * automated description summarise every commit on the branch rather than just echoing the
 * card's own, possibly stale, description.
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

/** One commit message, taken apart. See {@link parseCommitMessage}. */
export interface ParsedCommit {
  subject: string;
  /** Everything between the subject and the trailer block (empty when there was none). */
  body: string;
  /** The trailer block's keys and values, continuation lines unfolded. `{}` when the
   *  message carried no trailer block at all. */
  trailers: Record<string, string>;
}

/** A line that opens a trailer: `Key: value`, the key bare (no leading whitespace). */
const TRAILER_LINE_RE = /^([A-Za-z][A-Za-z0-9 _-]*):\s+(.*)$/;

/** A continuation line: indented, so it folds into the trailer above it rather than starting
 *  one of its own — CONTRIBUTING.md §2's "continuation lines align under the first line". */
const CONTINUATION_LINE_RE = /^\s+\S/;

/**
 * Take a raw commit message apart into its subject, body and trailers — the reverse of
 * writing one by `prSubject`/`wrapPlainText`. Pure and total: any string in, including an
 * empty one, produces a shape rather than throwing.
 *
 * The **last** blank-line-separated paragraph is read as the trailer block only when EVERY
 * line in it either opens a trailer or continues the one above it; a prose paragraph that
 * merely happens to contain a colon (`"Note: see below."`) fails that all-or-nothing test
 * and stays part of the body. A continuation line is unfolded into its trailer's value with
 * a single space, the same join {@link wrapHanging} undoes on the way out.
 */
export function parseCommitMessage(raw: string): ParsedCommit {
  const normalized = raw.replace(/\r\n/g, '\n').trimEnd();
  const [firstLine = '', ...restLines] = normalized.split('\n');
  const subject = firstLine.trim();
  const rest = restLines.join('\n').trim();
  if (!rest) return { subject, body: '', trailers: {} };

  const blocks = rest
    .split(/\n\s*\n/)
    .map((b) => b.trim())
    .filter(Boolean);
  const trailers = parseTrailerBlock(blocks[blocks.length - 1] ?? '');
  const body = trailers ? blocks.slice(0, -1).join('\n\n') : blocks.join('\n\n');
  return { subject, body, trailers: trailers ?? {} };
}

/** `block`'s trailers, or `null` when any line in it is neither a trailer nor a continuation. */
function parseTrailerBlock(block: string): Record<string, string> | null {
  const lines = block.split('\n');
  if (lines.length === 0 || !TRAILER_LINE_RE.test(lines[0])) return null;
  const trailers: Record<string, string> = {};
  let key = '';
  for (const line of lines) {
    const match = TRAILER_LINE_RE.exec(line);
    if (match) {
      key = match[1].trim();
      trailers[key] = match[2].trim();
    } else if (CONTINUATION_LINE_RE.test(line)) {
      trailers[key] = `${trailers[key]} ${line.trim()}`;
    } else {
      return null;
    }
  }
  return trailers;
}

/**
 * Lines that must never reach a pull request's description regardless of where they came
 * from — CLAUDE.md's "no AI attribution" rule, applied to text pulled out of commits rather
 * than written fresh. A `Co-Authored-By:` trailer is already excluded by construction
 * (`parseCommitMessage` files it under `trailers`, which `branchChangesBody` never reads),
 * but a "Generated with" line or a 🤖 marker is ordinary body prose as far as parsing is
 * concerned, so it has to be stripped explicitly here.
 */
const ATTRIBUTION_LINE_RE = /^\s*(co-authored-by\s*:|generated with|🤖)/i;

function stripAttributionLines(text: string): string {
  return text
    .split('\n')
    .filter((line) => !ATTRIBUTION_LINE_RE.test(line))
    .join('\n')
    .trim();
}

/** How many commits {@link branchChangesBody} will describe by name before it stops and
 *  says how many more there were — the size guard a long-lived branch needs so a pull
 *  request's body stays something a human can actually read. */
const MAX_LISTED_COMMITS = 20;

/**
 * The body of an automated pull request: every commit on the branch, summarised.
 *
 * A single commit's own body (its subject's explanation, trailers already stripped out by
 * {@link parseCommitMessage}) IS the pull request's body — there is nothing to list, since
 * there is only one entry. More than one commit becomes a bullet list of subjects instead,
 * because listing every commit's full body would repeat CONTRIBUTING.md's own "why" prose
 * once per commit and bury the branch's actual shape.
 *
 * `''` on an empty branch — the caller falls back to the card's own description, the same
 * contract `branchCommitMessages` in `apps/client/src/main/git.ts` documents for its `[]`.
 */
export function branchChangesBody(commits: readonly string[]): string {
  const parsed = commits.map(parseCommitMessage).filter((c) => c.subject);
  if (parsed.length === 0) return '';
  if (parsed.length === 1) {
    const body = stripAttributionLines(parsed[0].body);
    return body ? wrapPlainText(body) : wrapHanging(parsed[0].subject, 72, 0);
  }

  const shown = parsed.slice(0, MAX_LISTED_COMMITS);
  const lines = shown.map((c) => wrapHanging(`- ${c.subject}`, 72, 2));
  if (parsed.length > MAX_LISTED_COMMITS) {
    const more = parsed.length - MAX_LISTED_COMMITS;
    lines.push(wrapHanging(`- …and ${more} more commit${more === 1 ? '' : 's'}.`, 72, 2));
  }
  return lines.join('\n');
}

/** CONTRIBUTING.md §2's trailer for how a change was actually tested. */
const TESTED_KEY = 'Tested';

/** How many distinct `Tested:` values {@link aggregateTested} will quote before it stops and
 *  says how many more there were — the same size guard {@link branchChangesBody} applies,
 *  for the same reason: a branch of a hundred commits must not produce an unreadable trailer. */
const MAX_TESTED_VALUES = 8;

/**
 * The value for an automated pull request's `Tested:` trailer, built from the `Tested:`
 * trailer every commit on the branch already carries honestly, line by line
 * (CONTRIBUTING.md §2) — rather than inventing a new one that cannot say what was actually
 * run. Identical values collapse to one (a branch of fixups that all ran `pnpm test` should
 * not repeat the sentence five times); distinct ones are joined so the trailer stays one
 * logical value `wrapHanging` can still wrap at the usual 8-space hang.
 *
 * `''` when no commit on the branch carries a `Tested:` trailer at all — the caller supplies
 * its own fallback sentence rather than writing an empty trailer.
 */
export function aggregateTested(commits: readonly string[]): string {
  const seen = new Set<string>();
  const values: string[] = [];
  for (const raw of commits) {
    const tested = parseCommitMessage(raw).trailers[TESTED_KEY]?.trim();
    if (!tested || seen.has(tested)) continue;
    seen.add(tested);
    values.push(tested);
  }
  if (values.length === 0) return '';
  if (values.length <= MAX_TESTED_VALUES) return values.join('; ');

  const shown = values.slice(0, MAX_TESTED_VALUES);
  const more = values.length - MAX_TESTED_VALUES;
  return `${shown.join('; ')}; and ${more} more commit${more === 1 ? '' : 's'} tested — see the branch's own history.`;
}
