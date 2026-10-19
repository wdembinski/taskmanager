/**
 * Plan-check rules for auto-approving a card's plan.
 *
 * Every card starts in plan mode and parks its plan in the Inbox as a
 * `plan-approval` item. A project can switch on "Approve clean plans
 * automatically" — when it does, an `ExitPlanMode` plan is approved without a
 * human only if every check here passes. The verdict is computed (and stored)
 * for every `plan-approval` item regardless of the switch, so the Inbox can
 * show the same checks next to a plan a human approves by hand.
 *
 * Pure (data in, verdict out) so it is unit-tested with no CLI and no database.
 */

/** One of the five checks a plan must pass. Always run, always reported, in this order. */
export type PlanCheckId =
  'open-questions' | 'critical-files' | 'step-count' | 'spec-read' | 'acceptance';

/** The outcome of a single check. */
export interface PlanCheckResult {
  id: PlanCheckId;
  label: string;
  pass: boolean;
  detail: string;
}

/** The outcome of all five checks. `pass` is true only when every check passes. */
export interface PlanVerdict {
  pass: boolean;
  checks: PlanCheckResult[];
}

/** A sibling card the critical-files check must not overlap with. */
export interface ActivePlanCard {
  title: string;
  why: 'running' | 'planning' | 'unmerged PR';
  /** This card's critical files, already normalized by {@link parseCriticalFiles}. */
  files: string[];
}

export interface PlanCheckInput {
  plan: string;
  /** `splitPlanIntoSteps(plan)` output. */
  steps: { title: string; description: string }[];
  maxSteps: number;
  /** The card's `externalDescription ?? description`. */
  ticketText?: string | null;
  /** TM-466, not wired yet — the scheduler passes `undefined` until it exists. */
  needsDecision?: boolean;
  activeCards: ActivePlanCard[];
}

/** The marker Claude is told to put at the start of a line to ask for input. */
export const NEEDS_INPUT_SENTINEL = '@@NEEDS_INPUT@@';

/** The literal line `withSharedContext` inserts before a step's framing sections. */
export const SHARED_CONTEXT_MARKER =
  "Shared plan context — the approved plan's framing sections, given to every step:";

/** `## Heading` → level + text. */
const HEADING = /^(#{1,6})\s+(.*\S)\s*$/;
/** Ordinal prefixes stripped from a heading before comparing it: `Phase 2 — `, `3. `. */
const ORDINAL_PREFIX = /^(?:phase|milestone|step|stage|part)\s+[0-9a-z]+\s*[—:.)-]\s*|^\d+[.)]\s*/i;

/**
 * Normalize a heading's text for comparison — case, punctuation, a parenthetical
 * and an ordinal prefix all stripped. Mirrors `isNonWorkHeading`'s normalisation
 * in `planToSubtasks.ts`; duplicated here because `shared` cannot depend on
 * `apps/client`.
 */
function normalizeHeading(title: string): string {
  return title
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[*_`#]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(ORDINAL_PREFIX, '')
    .toLowerCase()
    .replace(/[.:;,!?]+$/, '')
    .trim();
}

/**
 * The body of the first heading (any level) whose normalized text starts with
 * `prefix`, up to the next heading at the same or a shallower level. `null`
 * when no such heading exists.
 */
function findSectionBody(markdown: string, prefix: string): string | null {
  const lines = markdown.split(/\r?\n/);
  let bodyStart = -1;
  let level = 0;
  for (let i = 0; i < lines.length; i++) {
    const match = HEADING.exec(lines[i]);
    if (match && normalizeHeading(match[2]).startsWith(prefix)) {
      bodyStart = i + 1;
      level = match[1].length;
      break;
    }
  }
  if (bodyStart === -1) return null;

  const body: string[] = [];
  for (let i = bodyStart; i < lines.length; i++) {
    const match = HEADING.exec(lines[i]);
    if (match && match[1].length <= level) break;
    body.push(lines[i]);
  }
  return body.join('\n');
}

/** A top-level bullet or numbered-list marker: `- `, `* `, `+ `, `1. `. */
const LIST_MARKER = /^\s*(?:[-*+]|\d+\.)\s+/;

/**
 * One line of a Critical files section reduced to its path token — markers,
 * backticks and bold stripped, cut at the first explanatory separator, then
 * the first whitespace-free token of what remains. `null` when the line has
 * nothing left.
 */
function extractPathToken(line: string): string | null {
  let text = line.replace(LIST_MARKER, '').replace(/`/g, '').replace(/\*\*/g, '');

  const separators = [' — ', ' - ', ' (', ':'];
  let cutAt = text.length;
  for (const sep of separators) {
    const idx = text.indexOf(sep);
    if (idx !== -1 && idx < cutAt) cutAt = idx;
  }
  text = text.slice(0, cutAt).trim();

  const token = text.split(/\s+/)[0];
  return token || null;
}

/** A token counts as a path when it has a separator, or ends in a `.ext`. */
function isPathLike(token: string): boolean {
  return token.includes('/') || token.includes('\\') || /\.[A-Za-z0-9]+$/.test(token);
}

/** `\` → `/`, a leading `./` dropped, lowercased. */
function normalizePath(token: string): string {
  const slashed = token.replace(/\\/g, '/');
  const stripped = slashed.startsWith('./') ? slashed.slice(2) : slashed;
  return stripped.toLowerCase();
}

/**
 * Parse a plan's "Critical files" section into normalized, deduplicated paths.
 * `null` when the plan has no such section at all — distinct from a section
 * that lists no files, which returns `[]`.
 */
export function parseCriticalFiles(plan: string): string[] | null {
  const body = findSectionBody(plan, 'critical files');
  if (body === null) return null;

  const paths = new Set<string>();
  for (const line of body.split(/\r?\n/)) {
    const token = extractPathToken(line);
    if (token && isPathLike(token)) paths.add(normalizePath(token));
  }
  return [...paths];
}

/** Lines whose content, once bullets/punctuation are stripped, mean "no open questions". */
const EMPTY_OPEN_QUESTIONS = new Set(['none', 'n/a', '-', '—', 'nothing']);

/** Strip a bullet marker and inline emphasis/trailing punctuation, lowercased. */
function normalizeListLine(line: string): string {
  return line
    .replace(LIST_MARKER, '')
    .replace(/[`*_]/g, '')
    .trim()
    .replace(/[.:;,!?]+$/, '')
    .toLowerCase();
}

function checkOpenQuestions(input: PlanCheckInput): PlanCheckResult {
  const id: PlanCheckId = 'open-questions';
  const label = 'No open question';
  const reasons: string[] = [];

  if (input.plan.split(/\r?\n/).some((line) => line.trimStart().startsWith(NEEDS_INPUT_SENTINEL))) {
    reasons.push(`the plan contains ${NEEDS_INPUT_SENTINEL}`);
  }

  const body = findSectionBody(input.plan, 'open questions');
  if (body !== null) {
    const leftover = body
      .split(/\r?\n/)
      .map(normalizeListLine)
      .find((line) => line.length > 0 && !EMPTY_OPEN_QUESTIONS.has(line));
    if (leftover) reasons.push(`the Open questions section lists "${leftover}"`);
  }

  if (input.needsDecision === true) {
    reasons.push('needsDecision is set');
  }

  return {
    id,
    label,
    pass: reasons.length === 0,
    detail: reasons.length > 0 ? reasons.join('; ') : 'no open questions',
  };
}

function checkCriticalFiles(input: PlanCheckInput): PlanCheckResult {
  const id: PlanCheckId = 'critical-files';
  const label = 'Critical files listed, no overlap';
  const files = parseCriticalFiles(input.plan);

  if (files === null) {
    return { id, label, pass: false, detail: 'no Critical files section' };
  }
  if (files.length === 0) {
    return { id, label, pass: false, detail: 'the Critical files section lists no files' };
  }

  const fileSet = new Set(files);
  for (const card of input.activeCards) {
    const overlap = card.files.filter((f) => fileSet.has(f));
    if (overlap.length > 0) {
      return {
        id,
        label,
        pass: false,
        detail: `overlaps "${card.title}" (${card.why}): ${overlap.slice(0, 3).join(', ')}`,
      };
    }
  }

  return {
    id,
    label,
    pass: true,
    detail: `${files.length} file${files.length === 1 ? '' : 's'} listed, no overlap`,
  };
}

function checkStepCount(input: PlanCheckInput): PlanCheckResult {
  const id: PlanCheckId = 'step-count';
  const label = `At most ${input.maxSteps} steps`;
  const n = input.steps.length;
  const pass = n <= input.maxSteps;
  return {
    id,
    label,
    pass,
    detail: pass ? `${n} step${n === 1 ? '' : 's'}` : `${n} steps, the limit is ${input.maxSteps}`,
  };
}

/** `foo/bar.md`, `foo/bar.md#some-anchor` — an optional anchor, capturing both parts. */
const MD_REFERENCE = /^([\w./-]+)\.md(?:#([\w-]+))?$/;
/** `§ 3`, `§3.2.1`. */
const SECTION_REFERENCE = /^§\s*\d+(?:\.\d+)*$/;

/** Every spec reference a ticket's text names: `*.md` paths, `§` tokens, a `Plan:` line. */
function extractSpecReferences(ticketText: string): string[] {
  const refs: string[] = [];
  for (const m of ticketText.matchAll(/[\w./-]+\.md(?:#[\w-]+)?/g)) refs.push(m[0]);
  for (const m of ticketText.matchAll(/§\s*\d+(?:\.\d+)*/g)) refs.push(m[0]);
  const planLine = /^Plan:\s*(.+)$/m.exec(ticketText);
  if (planLine) refs.push(planLine[1].trim());
  return refs;
}

/** Whether the plan mentions a reference by its basename, its anchor-as-words, or its `§` token. */
function referenceMentioned(ref: string, planLower: string): boolean {
  const md = MD_REFERENCE.exec(ref);
  if (md) {
    const base = (md[1].split(/[/\\]/).pop() ?? md[1]).toLowerCase();
    if (base && planLower.includes(base)) return true;
    if (md[2]) {
      const words = md[2].replace(/[-_]/g, ' ').toLowerCase();
      if (planLower.includes(words)) return true;
    }
    return false;
  }

  if (SECTION_REFERENCE.test(ref)) {
    return (
      planLower.includes(ref.replace(/\s+/g, '').toLowerCase()) ||
      planLower.includes(ref.replace(/\s+/g, ' ').toLowerCase())
    );
  }

  return planLower.includes(ref.toLowerCase());
}

function checkSpecRead(input: PlanCheckInput): PlanCheckResult {
  const id: PlanCheckId = 'spec-read';
  const label = 'Spec read';
  const refs = extractSpecReferences(input.ticketText ?? '');

  if (refs.length === 0) {
    return { id, label, pass: true, detail: 'the ticket names no spec' };
  }
  if (/^\s*>/m.test(input.plan)) {
    return { id, label, pass: true, detail: 'the plan quotes the spec' };
  }

  const planLower = input.plan.toLowerCase();
  const unmentioned = refs.find((ref) => !referenceMentioned(ref, planLower));
  if (unmentioned) {
    return { id, label, pass: false, detail: `the plan never mentions "${unmentioned}"` };
  }

  return {
    id,
    label,
    pass: true,
    detail: `mentions ${refs.length} spec reference${refs.length === 1 ? '' : 's'}`,
  };
}

const ACCEPTANCE_PREFIXES = [
  'acceptance',
  'accept when',
  'verification',
  'verify',
  'verified by',
  'done when',
  'proof',
  'proven by',
  'tested by',
  'test:',
  'tests:',
];

/**
 * A human doing the checking, not an agent — unless the phrase sits inside a
 * quoted span, where a step is plausibly just discussing the convention.
 */
const HUMAN_CHECK =
  /\b(the\s+)?(human|owner|user|reviewer)s?\s+(checks?|verif(?:y|ies)|confirms?|eyeballs?|looks?\s+at)\b|\bmanual(?:ly)?\s+(check|verif|test)/gi;

/** A step's own text: its description, cut before the shared framing every step carries. */
function stepOwnText(description: string): string {
  const idx = description.indexOf(SHARED_CONTEXT_MARKER);
  return idx === -1 ? description : description.slice(0, idx);
}

/** Start/end offsets of every `"…"`, `'…'` and `` `…` `` span on a line. */
function quotedRanges(line: string): [number, number][] {
  const ranges: [number, number][] = [];
  const re = /"[^"]*"|'[^']*'|`[^`]*`/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line))) ranges.push([m.index, m.index + m[0].length]);
  return ranges;
}

function hasUnquotedHumanCheck(line: string): boolean {
  const ranges = quotedRanges(line);
  const re = new RegExp(HUMAN_CHECK.source, 'gi');
  let m: RegExpExecArray | null;
  while ((m = re.exec(line))) {
    if (!ranges.some(([start, end]) => m!.index >= start && m!.index < end)) return true;
  }
  return false;
}

function hasAcceptanceLine(lines: string[]): boolean {
  return lines.some((line) => {
    const stripped = normalizeListLine(line);
    return ACCEPTANCE_PREFIXES.some((prefix) => stripped.startsWith(prefix));
  });
}

function checkAcceptance(input: PlanCheckInput): PlanCheckResult {
  const id: PlanCheckId = 'acceptance';
  const label = 'Every step has agent-checkable acceptance';

  for (const step of input.steps) {
    const lines = stepOwnText(step.description).split(/\r?\n/);

    const humanCheckLine = lines.find(hasUnquotedHumanCheck);
    if (humanCheckLine) {
      return {
        id,
        label,
        pass: false,
        detail: `"${step.title}" relies on a human check: ${humanCheckLine.trim()}`,
      };
    }

    if (!hasAcceptanceLine(lines)) {
      return { id, label, pass: false, detail: `"${step.title}" has no acceptance line` };
    }
  }

  return {
    id,
    label,
    pass: true,
    detail: `${input.steps.length} step${input.steps.length === 1 ? '' : 's'} checked`,
  };
}

/** Run all five plan checks, in the order they are reported. */
export function checkPlan(input: PlanCheckInput): PlanVerdict {
  const checks = [
    checkOpenQuestions(input),
    checkCriticalFiles(input),
    checkStepCount(input),
    checkSpecRead(input),
    checkAcceptance(input),
  ];
  return { pass: checks.every((c) => c.pass), checks };
}
