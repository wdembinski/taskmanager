/**
 * The prompt for the AI-assisted "Align plan" run (Phase C).
 *
 * Kept pure and separate so it reads clearly and can be unit-tested. It instructs
 * Claude to annotate an existing plan with `@needs:` dependency clauses AND, for
 * milestones that fan out into parallel work, a `@contract` task plus a scaffolded
 * `CONTRACT.md` — all in the exact grammar the parser understands (`planParser.ts`),
 * editing the user's files in place for them to review.
 */

/**
 * Build the align prompt. `planPath` is absolute; `projectPath` is the session's
 * working directory, so we hand Claude the relative path it should edit.
 */
export function buildAlignPrompt(planPath: string, projectPath: string): string {
  // Computed by the caller side normally; kept here so the prompt is self-contained.
  const rel = relativePath(projectPath, planPath);
  return [
    `Edit the plan file "${rel}" in place to prepare it for an orchestrator that runs`,
    `tasks in parallel, in isolated git worktrees, as a coordinated team.`,
    ``,
    `The plan uses Markdown headings as phases/milestones and "- [ ] ..." checkboxes as`,
    `tasks. Do two things:`,
    ``,
    `1) DECLARE DEPENDENCIES.`,
    `- Add a dependency by appending "@needs: <Task title>, <Task title>" to the END`,
    `  of a task's checkbox line, naming the EXACT titles of tasks it depends on.`,
    `  Example: "- [ ] Build the API @needs: Set up the database".`,
    `- Only add a dependency when a task genuinely cannot start until another is done`,
    `  (e.g. it uses something the other creates). When in doubt, leave tasks`,
    `  independent so they can run in parallel.`,
    `- Reference titles EXACTLY as written (so they resolve); never introduce a cycle.`,
    ``,
    `2) ADD A SHARED CONTRACT to each milestone whose tasks fan out into parallel work`,
    `   touching shared interfaces, types, or files (skip milestones that are a single`,
    `   task or a strictly sequential chain):`,
    `- Insert, as the FIRST task under that milestone's heading, a new line exactly:`,
    `      - [ ] Define shared contract in CONTRACT.md @contract`,
    `- Make the milestone's other tasks depend on it by appending`,
    `  "@needs: Define shared contract in CONTRACT.md" to each (merging with any`,
    `  existing @needs: on the same line — one @needs: clause per line, comma-separated).`,
    `- Create a "CONTRACT.md" file at the repository root (next to the plan) if one does`,
    `  not already exist, scaffolding the shared interfaces/types/decisions and a`,
    `  "## File ownership" section mapping files or areas to the milestone's tasks. Keep`,
    `  it concise; the contract task will flesh it out when it runs.`,
    ``,
    `Otherwise do NOT add, remove, reorder, rename, or re-check existing tasks or any`,
    `other text. Only append "@needs:" clauses, insert the "@contract" task lines, and`,
    `create CONTRACT.md. Preserve formatting and line endings.`,
    ``,
    `When finished, briefly summarize the dependencies and contract tasks you added.`,
  ].join('\n');
}

/**
 * Minimal POSIX-ish relative path (avoids importing node:path into a pure module,
 * and the plan file is normally inside the project dir).
 */
function relativePath(from: string, to: string): string {
  const norm = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '');
  const base = `${norm(from)}/`;
  const full = norm(to);
  return full.startsWith(base) ? full.slice(base.length) : full;
}
