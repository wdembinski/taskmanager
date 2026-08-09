/**
 * The plan parser — turns a project's `plan.md` into an ordered list of tasks.
 *
 * The grammar is deliberately tiny and matches what `docs/03-how-orchestration-works.md`
 * promises users:
 *
 *   - An ATX heading (`#` … `######`) sets the current **phase**. Its full text
 *     (e.g. "Phase 2 — Persistence") labels every task beneath it.
 *   - A checkbox list item (`- [ ]`, `* [x]`, `+ [X]`, at any indent) becomes a
 *     **task**. `[x]`/`[X]` means already done.
 *   - Plain bullets and prose are ignored — only checkboxes are tasks. This lets a
 *     plan mix explanation with the actual work items (our own roadmap does).
 *   - A wrapped task (continuation lines indented under a checkbox, no marker of
 *     their own) is folded back into that task's title, so multi-line items read
 *     as one task instead of being truncated.
 *
 * The function is pure (string in, array out) so it is unit-tested with no files.
 */

/** One task as parsed from a plan file, before it is assigned an id/status. */
export interface ParsedTask {
  /** The heading this task lives under, or '' if it appears before any heading. */
  phase: string;
  /** The checkbox label, with wrapped continuation lines folded in and any
   *  trailing `@needs:` clause stripped off (that lives in `needs`). */
  title: string;
  /** True when the source checkbox was already ticked (`[x]`). */
  done: boolean;
  /**
   * Titles of tasks this one depends on, declared with a trailing
   * `@needs: TitleA, TitleB` on the checkbox line. Empty when none are declared.
   * The scheduler holds this task until every named prerequisite is `done`.
   */
  needs: string[];
  /**
   * True when the checkbox carried a trailing `@contract` marker (team
   * orchestration, Phase C). A contract task authors the shared `CONTRACT.md`
   * before its milestone's parallel siblings start, and becomes an implicit
   * prerequisite of every other task under the same heading.
   */
  isContract: boolean;
  /**
   * True when the checkbox carried a trailing `@scaffold` marker (team orchestration,
   * Phase D). A scaffold task creates and commits the shared monorepo root before its
   * milestone's parallel siblings start, and — like a contract task — is an implicit
   * prerequisite of every other task under the same heading.
   */
  isScaffold: boolean;
}

/** A parsed task plus the 0-based index of the line its checkbox started on. */
export interface LocatedTask extends ParsedTask {
  line: number;
}

const HEADING = /^(#{1,6})\s+(.*\S)\s*$/;
const CHECKBOX = /^(\s*)[-*+]\s+\[([ xX])\]\s+(.*\S)\s*$/;
/** A trailing `@needs: A, B` dependency clause on a (folded) task title. */
const NEEDS = /\s*@needs:\s*(.*)$/i;
/** A bare `@contract` marker anywhere in a (folded) task title. */
const CONTRACT = /\s*@contract\b/i;
/** A bare `@scaffold` marker anywhere in a (folded) task title. */
const SCAFFOLD = /\s*@scaffold\b/i;

/**
 * Strip a bare marker (e.g. `@contract`, `@scaffold`) from a folded title, reporting
 * whether one was present. Removed *before* `splitNeeds` so the marker can sit on either
 * side of a `@needs:` clause (e.g. "Foo @needs: Bar @contract") without being swallowed
 * into the dependency list.
 */
function splitMarker(title: string, marker: RegExp): { title: string; present: boolean } {
  const m = marker.exec(title);
  if (!m) return { title, present: false };
  const stripped = (title.slice(0, m.index) + title.slice(m.index + m[0].length))
    .replace(/\s+/g, ' ')
    .trim();
  return { title: stripped, present: true };
}

/**
 * Resolve a raw `@needs:` clause into dependency titles.
 *
 * The clause is comma-separated, but task titles themselves routinely contain
 * commas (e.g. "Create packages (`apps/*`, `packages/*`, `tools/*`)"), so a naive
 * comma-split shatters such a title into fragments that match no task and block the
 * dependent FOREVER. Instead we resolve against the set of ACTUAL task titles,
 * greedily consuming the LONGEST run of comma-fragments that reconstitutes a real
 * title. A fragment that matches nothing is kept as-is (surfaced as an unmet dep,
 * not silently dropped) — same as the old behavior for genuinely-unknown refs.
 *
 * Matching is whitespace-INSENSITIVE around commas: splitting on `,` and re-joining
 * discards the original inter-comma spacing, so a title that used commas without a
 * following space (e.g. "(`passwordHash?`,`emailVerified`)" or "{Unit,Module,Path}")
 * would never string-equal a naive `", "`-joined candidate and would be shredded.
 * We normalize `\s*,\s*` → `, ` on both sides to compare, and push the CANONICAL
 * actual title so the scheduler's exact-title dependency check still matches.
 */
function resolveNeeds(raw: string, titles: ReadonlySet<string>): string[] {
  const norm = (s: string): string => s.replace(/\s*,\s*/g, ', ').trim();
  const byNorm = new Map<string, string>(); // normalized title -> actual title
  for (const t of titles) byNorm.set(norm(t), t);

  const parts = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const needs: string[] = [];
  for (let i = 0; i < parts.length;) {
    let end = -1;
    let matched: string | null = null;
    let candidate = '';
    for (let j = i; j < parts.length; j++) {
      candidate = j === i ? parts[j] : `${candidate}, ${parts[j]}`;
      const hit = byNorm.get(norm(candidate));
      if (hit) {
        end = j; // keep scanning: prefer the longest match
        matched = hit;
      }
    }
    if (end >= 0 && matched) {
      needs.push(matched);
      i = end + 1;
    } else {
      needs.push(parts[i]);
      i += 1;
    }
  }
  return needs;
}

/**
 * Core scan: parse the plan into tasks while remembering which source line each
 * checkbox began on. Both `parsePlan` (which drops the line) and the write-back
 * (which needs it) build on this so they share one grammar.
 */
function locate(markdown: string): LocatedTask[] {
  const tasks: LocatedTask[] = [];
  let phase = '';
  // The task most recently opened by a checkbox line; continuation lines append
  // to it until a blank line, heading, or new checkbox closes it.
  let open: LocatedTask | null = null;

  const lines = markdown.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const heading = HEADING.exec(rawLine);
    if (heading) {
      phase = heading[2].trim();
      open = null;
      continue;
    }

    const checkbox = CHECKBOX.exec(rawLine);
    if (checkbox) {
      // `needs` is computed after folding (see below) so a `@needs:` clause on a
      // wrapped continuation line is still recognized.
      open = {
        phase,
        title: checkbox[3].trim(),
        done: checkbox[2].toLowerCase() === 'x',
        needs: [],
        isContract: false,
        isScaffold: false,
        line: i,
      };
      tasks.push(open);
      continue;
    }

    // Not a heading or checkbox. A blank line ends any open task's continuation;
    // an indented non-empty line continues the open task's title; a flush-left
    // line is unrelated prose and also ends continuation.
    if (rawLine.trim() === '' || !/^\s/.test(rawLine)) {
      open = null;
      continue;
    }
    if (open) open.title = `${open.title} ${rawLine.trim()}`.replace(/\s+/g, ' ');
  }

  // Titles are now fully folded, so peel off the trailing annotations. Done here
  // (not per-line) so a marker on a wrapped continuation line is honored, and so
  // `tickPlanCheckbox` and `parsePlan` share the exact same stripped identity. The
  // `@contract` marker is removed first so it can precede or follow a `@needs:`
  // clause without corrupting the parsed dependency list.
  // Peel the `@contract` marker and the trailing `@needs:` clause off each folded
  // title. Dependency RESOLUTION is a SECOND pass because it must match against the
  // set of ALL task titles (titles contain commas, so a clause can't be split on
  // commas alone — see resolveNeeds).
  const rawNeeds: (string | null)[] = tasks.map((task) => {
    // Peel the bare markers (`@contract`, `@scaffold`) before the `@needs:` clause so a
    // marker on either side of the clause is honored and never enters the dependency list.
    const contract = splitMarker(task.title, CONTRACT);
    task.isContract = contract.present;
    const scaffold = splitMarker(contract.title, SCAFFOLD);
    task.isScaffold = scaffold.present;
    const m = NEEDS.exec(scaffold.title);
    if (!m) {
      task.title = scaffold.title;
      return null;
    }
    task.title = scaffold.title.slice(0, m.index).trim();
    return m[1];
  });
  const titles = new Set(tasks.map((t) => t.title));
  tasks.forEach((task, i) => {
    const raw = rawNeeds[i];
    task.needs = raw === null ? [] : resolveNeeds(raw, titles);
  });

  return tasks;
}

/**
 * Parse plan markdown into an ordered list of tasks.
 *
 * Order is document order, which is exactly the order the scheduler should run
 * them in (phase by phase, top to bottom).
 */
export function parsePlan(markdown: string): ParsedTask[] {
  return locate(markdown).map(({ line: _line, ...task }) => task);
}

/**
 * The same parse, but keeping the source line each task's checkbox started on — for edits
 * that have to put a new line in the right place (`planAlign.ts` inserts a milestone's
 * `@contract` task above its first task). Exported so such an edit reuses THIS grammar
 * instead of re-implementing the scan and drifting from it.
 */
export function locatePlanTasks(markdown: string): LocatedTask[] {
  return locate(markdown);
}

/**
 * Tick the `[ ]` checkbox for a specific (phase, title) task to `[x]`, returning
 * the updated markdown — or `null` if no matching *unchecked* task was found (so
 * the caller can skip writing the file).
 *
 * Only the single matching checkbox line is altered; every other byte is left as
 * it was, so unrelated hand edits to the plan are never clobbered. The dominant
 * line ending is preserved. Matching uses the same folded (phase, title) identity
 * the reconciler keys on, so it lines up with the task the scheduler completed.
 */
export function tickPlanCheckbox(markdown: string, phase: string, title: string): string | null {
  const target = locate(markdown).find((t) => t.phase === phase && t.title === title && !t.done);
  if (!target) return null;

  const eol = markdown.includes('\r\n') ? '\r\n' : '\n';
  const lines = markdown.split(/\r?\n/);
  // Flip only the checkbox marker on the target line; leave its label untouched.
  lines[target.line] = lines[target.line].replace(/\[[ ]\]/, '[x]');
  return lines.join(eol);
}
