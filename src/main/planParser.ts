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
  /** The checkbox label, with wrapped continuation lines folded in. */
  title: string;
  /** True when the source checkbox was already ticked (`[x]`). */
  done: boolean;
}

const HEADING = /^(#{1,6})\s+(.*\S)\s*$/;
const CHECKBOX = /^(\s*)[-*+]\s+\[([ xX])\]\s+(.*\S)\s*$/;

/**
 * Parse plan markdown into an ordered list of tasks.
 *
 * Order is document order, which is exactly the order the scheduler should run
 * them in (phase by phase, top to bottom).
 */
export function parsePlan(markdown: string): ParsedTask[] {
  const tasks: ParsedTask[] = [];
  let phase = '';
  // The task most recently opened by a checkbox line; continuation lines append
  // to it until a blank line, heading, or new checkbox closes it.
  let open: ParsedTask | null = null;

  for (const rawLine of markdown.split(/\r?\n/)) {
    const heading = HEADING.exec(rawLine);
    if (heading) {
      phase = heading[2].trim();
      open = null;
      continue;
    }

    const checkbox = CHECKBOX.exec(rawLine);
    if (checkbox) {
      open = { phase, title: checkbox[3].trim(), done: checkbox[2].toLowerCase() === 'x' };
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

  return tasks;
}
