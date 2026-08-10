/**
 * The prompt for the AI-assisted "Align plan" run (Phase C).
 *
 * Kept pure and separate so it reads clearly and can be unit-tested. It asks Claude for
 * ONE thing: the `@needs:` dependency clauses, in the exact grammar the parser understands
 * (`planParser.ts`), edited into the user's plan in place for them to review.
 *
 * It used to also ask for the `@contract` task and a scaffolded `CONTRACT.md`. Those are a
 * literal line and a skeleton file, into milestones the app itself picks out, so the app now
 * writes them before this run starts (`planAlign.ts`) — and when the plan needs no dependency
 * judgement either, this prompt is never built and no session is started at all.
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
    `tasks. Do one thing: DECLARE DEPENDENCIES.`,
    ``,
    `- Add a dependency by appending "@needs: <Task title>, <Task title>" to the END`,
    `  of a task's checkbox line, naming the EXACT titles of tasks it depends on.`,
    `  Example: "- [ ] Build the API @needs: Set up the database".`,
    `- Only add a dependency when a task genuinely cannot start until another is done`,
    `  (e.g. it uses something the other creates). When in doubt, leave tasks`,
    `  independent so they can run in parallel.`,
    `- Reference titles EXACTLY as written (so they resolve); never introduce a cycle.`,
    ``,
    `A task line ending in "@contract" is already there: the orchestrator treats it as a`,
    `prerequisite of every other task under the SAME heading, so never append`,
    `"@needs: Define shared contract…" to its siblings, and leave that line alone.`,
    ``,
    `Otherwise do NOT add, remove, reorder, rename, or re-check existing tasks or any`,
    `other text. Only append "@needs:" clauses. Preserve formatting and line endings.`,
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
