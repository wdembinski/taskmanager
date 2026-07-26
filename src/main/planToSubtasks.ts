/**
 * Splitting an approved plan into the subtasks that will implement it (Phase 11).
 *
 * A card delegated in `plan` mode ends its research by calling `ExitPlanMode` with
 * the plan attached. The orchestrator holds that call for a human (see
 * `Scheduler.decidePermission`); on approval the plan is split HERE — one subtask
 * per phase/milestone, each carrying that section's own text as its brief.
 *
 * Why split at all: each subtask then runs in its OWN Claude session, so a phase
 * pays only for its own context instead of one session dragging the whole plan (and
 * every file it read) through every later step. That is the token saving the feature
 * exists for.
 *
 * The grammar is deliberately forgiving — a plan is prose written by a model, not a
 * format we control:
 *   - Split on the SHALLOWEST heading level that yields at least two sections. For a
 *     typical plan (`# Title` / `## Phase 1` / `## Phase 2`) that is the phase level,
 *     and deeper headings stay inside their phase's brief, where they belong.
 *   - Failing that, split on top-level list items (`- [ ] x`, `- x`, `1. x`), folding
 *     each item's indented continuation lines into its brief.
 *   - Failing that, the whole plan becomes one step. Never zero: an approved plan must
 *     always produce something to run.
 *
 * Pure (string in, array out) so it is unit-tested with no CLI and no database.
 */

/** One step of an approved plan: the subtask's title plus that section's own text. */
export interface PlanStep {
  /** The heading/item text, used as the subtask title. */
  title: string;
  /** The section body — handed to the agent as this step's brief. May be empty. */
  description: string;
}

/** Upper bound on generated subtasks; a runaway plan shouldn't create 200 rows. */
export const MAX_PLAN_STEPS = 20;

/** `## Heading` → level + text. */
const HEADING = /^(#{1,6})\s+(.*\S)\s*$/;
/** A top-level list item (no indent): `- [ ] x`, `- x`, `* x`, `+ x`, `1. x`, `2) x`. */
const TOP_ITEM = /^(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?(.*\S)\s*$/;
/** Ordinal prefixes stripped from a title: `Phase 2 — `, `Milestone B: `, `3. `. */
const ORDINAL_PREFIX = /^(?:phase|milestone|step|stage|part)\s+[0-9a-z]+\s*[—:.)-]\s*|^\d+[.)]\s*/i;

/**
 * Headings that frame a plan rather than name a step of it. Splitting on them would
 * spend a whole session re-reading context every other step already carries. Kept
 * short and literal — anything that could name real work (tests, docs, cleanup,
 * migration) is deliberately absent.
 */
const NON_WORK_HEADINGS = new Set([
  'overview',
  'context',
  'background',
  'summary',
  'goal',
  'goals',
  'objective',
  'objectives',
  'problem',
  'problem statement',
  'current state',
  'rationale',
  'approach',
  'assumptions',
  'constraints',
  'risks',
  'risks and mitigations',
  'open questions',
  'out of scope',
  'non-goals',
  'notes',
  'appendix',
  'references',
]);

/** True when a heading names framing rather than work. Case/punctuation tolerant. */
function isNonWorkHeading(title: string): boolean {
  const key = title
    .toLowerCase()
    .replace(/[*_`#]/g, '')
    .replace(/[.:;,!?]+$/, '')
    .trim();
  return NON_WORK_HEADINGS.has(key);
}

/**
 * The plan markdown carried by an `ExitPlanMode` tool call. The CLI puts it in
 * `plan`; we accept a couple of near-misses rather than lose a plan to a key rename.
 * Returns null when there is no usable text, so callers can fall soft.
 */
export function extractPlanMarkdown(input: unknown): string | null {
  if (typeof input === 'string') return input.trim() || null;
  if (typeof input !== 'object' || input === null) return null;
  const record = input as Record<string, unknown>;
  for (const key of ['plan', 'markdown', 'content', 'text']) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

/** Strip an ordinal prefix and markdown emphasis from a heading, for the card title. */
function toTitle(raw: string): string {
  const cleaned = raw
    .replace(/^\*\*(.*)\*\*$/, '$1')
    .replace(ORDINAL_PREFIX, '')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned || raw.trim();
}

/** Trim leading/trailing blank lines without touching interior indentation. */
function trimBlankLines(lines: string[]): string {
  let start = 0;
  let end = lines.length;
  while (start < end && !lines[start].trim()) start++;
  while (end > start && !lines[end - 1].trim()) end--;
  return lines.slice(start, end).join('\n');
}

/** Sections at one heading level: everything up to the next heading of that level. */
function sectionsAtLevel(lines: string[], level: number): PlanStep[] {
  const steps: PlanStep[] = [];
  let current: { title: string; body: string[] } | null = null;
  for (const line of lines) {
    const match = HEADING.exec(line);
    if (match && match[1].length === level) {
      if (current) steps.push({ title: current.title, description: trimBlankLines(current.body) });
      current = { title: match[2], body: [] };
      continue;
    }
    if (current) current.body.push(line);
  }
  if (current) steps.push({ title: current.title, description: trimBlankLines(current.body) });
  return steps;
}

/** Split on top-level list items, folding indented continuation lines into the brief. */
function itemsAsSteps(lines: string[]): PlanStep[] {
  const steps: PlanStep[] = [];
  let current: { title: string; body: string[] } | null = null;
  for (const line of lines) {
    // Only an unindented item starts a new step; indented ones are sub-points of it.
    const match = /^\S/.test(line) ? TOP_ITEM.exec(line) : null;
    if (match) {
      if (current) steps.push({ title: current.title, description: trimBlankLines(current.body) });
      current = { title: match[1], body: [] };
      continue;
    }
    if (current) current.body.push(line);
  }
  if (current) steps.push({ title: current.title, description: trimBlankLines(current.body) });
  return steps;
}

/**
 * Split an approved plan into ordered steps. Always returns at least one step for a
 * non-empty plan — an approved plan that produced nothing to run would strand the
 * ticket with no way forward.
 */
export function splitPlanIntoSteps(markdown: string): PlanStep[] {
  const text = markdown.trim();
  if (!text) return [];
  const lines = text.split(/\r?\n/);

  // Prefer headings: the shallowest level that yields >= 2 sections is the phase level.
  const levels = new Set<number>();
  for (const line of lines) {
    const match = HEADING.exec(line);
    if (match) levels.add(match[1].length);
  }
  for (const level of [...levels].sort((a, b) => a - b)) {
    const sections = sectionsAtLevel(lines, level);
    const work = sections.filter((s) => !isNonWorkHeading(s.title));
    // A single section at this level means the level is the plan's title, not its
    // phases — keep descending. Two or more work sections is a real breakdown.
    if (work.length >= 2) return finalize(work);
  }

  // No usable headings — try a top-level list.
  const items = itemsAsSteps(lines);
  if (items.length >= 2) return finalize(items);

  // Unstructured plan: one step carrying the whole thing.
  return finalize([{ title: firstLineTitle(text), description: text }]);
}

/** A title for an unstructured plan: its first non-empty line, trimmed of markup. */
function firstLineTitle(text: string): string {
  const first = text.split(/\r?\n/).find((l) => l.trim()) ?? 'Implement the plan';
  const bare = first.replace(HEADING, '$2').replace(TOP_ITEM, '$1');
  return toTitle(bare).slice(0, 120) || 'Implement the plan';
}

/** Clean titles, drop empties, and cap the count. */
function finalize(steps: PlanStep[]): PlanStep[] {
  return steps
    .map((s) => ({ title: toTitle(s.title).slice(0, 200), description: s.description }))
    .filter((s) => s.title.length > 0)
    .slice(0, MAX_PLAN_STEPS);
}
