/**
 * The prompt for the AI-assisted "Align plan" run (Phase C).
 *
 * Kept pure and separate so it reads clearly and can be unit-tested. It instructs
 * Claude to annotate an existing plan with `@needs:` dependency clauses in the
 * exact grammar the parser understands (`planParser.ts`), editing the user's plan
 * file in place for them to review.
 */

/**
 * Build the align prompt. `planPath` is absolute; `projectPath` is the session's
 * working directory, so we hand Claude the relative path it should edit.
 */
export function buildAlignPrompt(planPath: string, projectPath: string): string {
  // Computed by the caller side normally; kept here so the prompt is self-contained.
  const rel = relativePath(projectPath, planPath);
  return [
    `Edit the plan file "${rel}" in place to declare task dependencies for an`,
    `orchestrator that runs tasks in parallel.`,
    ``,
    `Rules:`,
    `- The plan uses Markdown headings as phases and "- [ ] ..." checkboxes as tasks.`,
    `- Add a dependency by appending "@needs: <Task title>, <Task title>" to the END`,
    `  of a task's checkbox line, naming the EXACT titles of tasks it depends on.`,
    `  Example: "- [ ] Build the API @needs: Set up the database".`,
    `- Only add a dependency when a task genuinely cannot start until another is done`,
    `  (e.g. it uses something the other creates). When in doubt, leave tasks`,
    `  independent so they can run in parallel.`,
    `- Reference titles EXACTLY as written (so they resolve); never introduce a cycle.`,
    `- Do NOT add, remove, reorder, rename, re-check, or otherwise change tasks or any`,
    `  other text. Only append "@needs:" clauses to existing lines. Preserve formatting`,
    `  and line endings.`,
    ``,
    `When finished, briefly summarize the dependencies you added.`,
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
