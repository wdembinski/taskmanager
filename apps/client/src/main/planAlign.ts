/**
 * The mechanical half of "Align plan" — done in code instead of by an agent.
 *
 * Aligning a plan for parallel work is two jobs, and only one of them needs a model:
 *
 *   1. deciding which task genuinely cannot start until another is done — judgement;
 *   2. giving every milestone that fans out a `@contract` task, and scaffolding the
 *      `CONTRACT.md` it will author — a LITERAL line, into phases `planValidate`
 *      has already picked out (`phasesNeedingContract`).
 *
 * Job 2 used to cost a whole session (see `docs/08-token-usage-audit.md`, S6). It lives
 * here now: pure, deterministic, and — because it inserts the same string the parser
 * looks for — never reworded. The existing validator checks the result, which is the
 * point: the app writes the grammar and the app checks it.
 *
 * String in, string out — no files, no DB — so it tests cleanly.
 */
import { locatePlanTasks, type LocatedTask } from './planParser';
import { phasesNeedingContract } from './planValidate';

/** The contract file every milestone's `@contract` task authors, at the repo root. */
export const CONTRACT_DOC = 'CONTRACT.md';

/**
 * The task line inserted under a fanning-out milestone, minus its bullet and checkbox.
 * `planParser` reads the trailing `@contract` marker; the scheduler then runs this task
 * first and alone, ahead of its milestone's siblings.
 */
export const CONTRACT_TASK_TITLE = `Define shared contract in ${CONTRACT_DOC} @contract`;

/** What `insertContractTasks` did. */
export interface PlanAlignment {
  /** The plan after the edit — the input unchanged when there was nothing to insert. */
  markdown: string;
  /** The phases (heading text) that gained a contract task, in document order. */
  phases: string[];
}

/** A checkbox line's indent and bullet character, so an inserted sibling matches it. */
const BULLET = /^(\s*)([-*+])\s+\[/;

/**
 * Insert `- [ ] Define shared contract in CONTRACT.md @contract` as the FIRST task under
 * every milestone that fans out into parallel work, and report which milestones those were.
 *
 * Idempotent: a phase that already has a `@contract` task is not a phase that needs one,
 * so running this twice inserts nothing the second time. Nothing else is touched — no task
 * is added, removed, reordered, re-checked, or reworded — and the plan's dominant line
 * ending is preserved, because a plan is a file the human owns and keeps reading.
 */
export function insertContractTasks(markdown: string): PlanAlignment {
  const tasks = locatePlanTasks(markdown);
  const needy = phasesNeedingContract(tasks);
  if (needy.length === 0) return { markdown, phases: [] };

  const lines = markdown.split(/\r?\n/);
  // One insert per phase, above that phase's first task: `phasesNeedingContract` only ever
  // names a phase that has ≥2 tasks, so the `find` cannot miss (the filter is for the type).
  const inserts = needy
    .map((phase) => ({ phase, at: tasks.find((t) => t.phase === phase) }))
    .filter((i): i is { phase: string; at: LocatedTask } => i.at !== undefined);

  // Splice from the bottom up: an earlier insert would shift every later line number.
  for (const { at } of [...inserts].sort((a, b) => b.at.line - a.at.line)) {
    const bullet = BULLET.exec(lines[at.line]);
    const indent = bullet?.[1] ?? '';
    const marker = bullet?.[2] ?? '-';
    lines.splice(at.line, 0, `${indent}${marker} [ ] ${CONTRACT_TASK_TITLE}`);
  }

  const eol = markdown.includes('\r\n') ? '\r\n' : '\n';
  return { markdown: lines.join(eol), phases: inserts.map((i) => i.phase) };
}

/**
 * A first `CONTRACT.md` for the milestones that just got a contract task — a skeleton, not
 * a contract: the `@contract` task fills it in and commits it before its siblings start.
 *
 * The "File ownership" section is deliberately prose with NO bullet rows. `parseFileOwnership`
 * (`attention.ts`) reads bullets under that heading as owner→files rows, and a placeholder row
 * would be parsed as a real claim and mis-route the proposal votes; no rows means "unparseable",
 * which that code already degrades safely on.
 */
export function buildContractScaffold(phases: string[]): string {
  const named = phases.filter((p) => p.trim().length > 0);
  return [
    '# Shared contract',
    '',
    'These milestones run their tasks in parallel, so anything the tasks share — interfaces,',
    'types, formats, and which files each of them may touch — is agreed here BEFORE any of',
    'them starts:',
    '',
    ...(named.length > 0
      ? named.map((phase) => `- ${phase}`)
      : ['- (the tasks at the top of the plan, before the first heading)']),
    '',
    'Scaffolded by "Align plan". The `@contract` task under each milestone above fills this',
    'file in and commits it; its sibling tasks read it first and build against it, and may not',
    'change it unilaterally.',
    '',
    '## Interfaces and types',
    '',
    'Not written yet — the contract task defines the shared signatures, types, and formats here.',
    '',
    '## Key decisions',
    '',
    'Not written yet — the choices the parallel tasks must not each make differently.',
    '',
    '## File ownership',
    '',
    'Not written yet. The contract task maps each file or area to exactly ONE task, one row per',
    'line in the form `<path or glob> — <exact task title>`, so two parallel tasks never own',
    'the same file.',
    '',
  ].join('\n');
}
