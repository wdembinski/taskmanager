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
}

/** A parsed task plus the 0-based index of the line its checkbox started on. */
interface LocatedTask extends ParsedTask {
  line: number;
}

const HEADING = /^(#{1,6})\s+(.*\S)\s*$/;
const CHECKBOX = /^(\s*)[-*+]\s+\[([ xX])\]\s+(.*\S)\s*$/;
/** A trailing `@needs: A, B` dependency clause on a (folded) task title. */
const NEEDS = /\s*@needs:\s*(.*)$/i;

/**
 * Split a folded task title into its display title and its declared dependency
 * titles. `@needs:` is matched only as a trailing clause, so a title without it
 * is returned unchanged with no dependencies.
 */
function splitNeeds(title: string): { title: string; needs: string[] } {
  const m = NEEDS.exec(title);
  if (!m) return { title, needs: [] };
  const needs = m[1]
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return { title: title.slice(0, m.index).trim(), needs };
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

  // Titles are now fully folded, so split off any trailing `@needs:` clause. Done
  // here (not per-line) so `@needs:` on a wrapped continuation line is honored, and
  // so `tickPlanCheckbox` and `parsePlan` share the exact same stripped identity.
  for (const task of tasks) {
    const { title, needs } = splitNeeds(task.title);
    task.title = title;
    task.needs = needs;
  }

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
