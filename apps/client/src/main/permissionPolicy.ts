/**
 * The risk policy (Phase 4) — pure, unit-tested.
 *
 * As a task runs, Claude emits `tool-use` events ("I want to run Bash `git push`",
 * "I want to Edit `.env`"). This module classifies ONE such tool use into either:
 *
 *   - `allow` : safe enough to proceed without bothering a human (reads, ordinary
 *               edits, builds, tests), or
 *   - `ask`   : genuinely risky — route it to the Attention inbox for approval.
 *
 * The policy mirrors the rule stated in `docs/03-how-orchestration-works.md`:
 * hold anything that pushes to git, deletes, or touches secrets/`.env`. It is a
 * pure function of the tool name + its arguments so it can be tested exhaustively
 * without a session or a database (see permissionPolicy.test.ts).
 *
 * NOTE (monitor semantics): with the CLI running in `acceptEdits`, the CLI itself
 * is the hard pre-execution gate — this policy is the layer that decides what to
 * SURFACE to a human. A true in-app veto (blocking a tool before it runs via
 * `--permission-prompt-tool`) is a later hardening; see the Phase 4 notes.
 *
 * The review policy (F16.5) — `evaluateReviewToolUse` — is the second, stricter
 * classifier, for an unattended AI review of an untrusted PR. Nobody is watching
 * that session and there is no card to raise an Attention item on, so it never
 * returns `ask`: a tool use is either `allow` (a read, or one of a few read-only
 * git subcommands) or `deny`, and anything it does not recognise is denied — the
 * opposite of `evaluateToolUse`'s unknown → allow.
 */

import { isAskUserQuestionTool } from './askUserQuestion';

/**
 * The outcome of classifying one tool use. `reason` explains an `ask` to the human,
 * or a `deny` to the session (and the review it is recorded on).
 */
export type PermissionDecision =
  { action: 'allow' } | { action: 'ask'; reason: string } | { action: 'deny'; reason: string };

/** Tools whose whole purpose is to delete — always routed to a human. */
const DELETE_TOOLS = new Set(['delete', 'deletefile', 'remove', 'rm', 'trash']);

/**
 * The tool a plan-mode session calls to hand over its finished plan and ask to start
 * implementing (Phase 11). Always routed to a human: it is both the approval gate for
 * the plan itself and the only signal that a plan is complete — and it carries the
 * plan text as its input, which the orchestrator splits into subtasks.
 */
export const EXIT_PLAN_MODE_TOOL = 'ExitPlanMode';

/** Substrings that mark a path/command as touching secrets. Matched case-insensitively. */
const SECRET_HINTS = ['.env', 'secret', 'credential', 'id_rsa', '.pem', '.key', '.pfx', 'token'];

/** Shell fragments that are destructive or irreversible enough to always confirm. */
const RISKY_COMMAND_PATTERNS: Array<{ re: RegExp; reason: string }> = [
  { re: /\bgit\s+push\b/, reason: 'pushes to a git remote' },
  { re: /\bgit\s+reset\s+--hard\b/, reason: 'hard-resets the working tree' },
  { re: /\bgit\s+clean\b/, reason: 'deletes untracked files (git clean)' },
  { re: /\brm\s+-[a-z]*f/, reason: 'force-deletes files (rm -rf)' },
  { re: /\brm\s+-[a-z]*r/, reason: 'recursively deletes files (rm -r)' },
  { re: /\brmdir\b/, reason: 'removes a directory' },
  { re: /\bdel\s/, reason: 'deletes files (del)' },
  { re: /\bRemove-Item\b/i, reason: 'deletes items (Remove-Item)' },
  { re: /\bcurl\b[^|]*\|\s*(sh|bash)\b/, reason: 'pipes a download straight into a shell' },
];

/** Extract the first string field among `keys` from a tool-input object. */
function firstString(input: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === 'string') return value;
  }
  return null;
}

/** True if `text` mentions anything our secret hints flag (case-insensitive). */
function touchesSecret(text: string): boolean {
  const lower = text.toLowerCase();
  return SECRET_HINTS.some((hint) => lower.includes(hint));
}

/**
 * Classify one tool use as auto-approve (`allow`) or route-to-human (`ask`).
 * Unknown tools default to `allow` — the CLI's own permission mode is still the
 * backstop, so this policy only adds *extra* holds, it never loosens anything.
 */
export function evaluateToolUse(
  toolName: string,
  input: Record<string, unknown>,
): PermissionDecision {
  const name = toolName.toLowerCase();

  // A finished plan awaiting a human (Phase 11). Held before it takes effect, so the
  // agent cannot leave plan mode — and start editing — without approval.
  if (name === EXIT_PLAN_MODE_TOOL.toLowerCase()) {
    return { action: 'ask', reason: 'presents a plan for approval' };
  }

  // A question FOR THE HUMAN (Phase 17). It deletes nothing, pushes nothing and touches no
  // secret, so every rule below waved it through to the catch-all `allow` at the bottom —
  // and a CLI running headless then answered its own question by taking its recommended
  // option. Held here so the human is the one who answers.
  if (isAskUserQuestionTool(toolName)) {
    return { action: 'ask', reason: 'asks you a question' };
  }

  // Shell commands: inspect the actual command string for risky fragments.
  if (name === 'bash' || name === 'shell' || name === 'powershell') {
    const command = firstString(input, ['command', 'cmd', 'script']) ?? '';
    for (const { re, reason } of RISKY_COMMAND_PATTERNS) {
      if (re.test(command)) return { action: 'ask', reason };
    }
    if (touchesSecret(command)) return { action: 'ask', reason: 'reads or writes a secret file' };
    return { action: 'allow' };
  }

  // Dedicated delete/remove tools are always held.
  if (DELETE_TOOLS.has(name)) {
    return { action: 'ask', reason: 'deletes a file' };
  }

  // File-mutating tools: hold only when the target looks like a secret.
  if (name === 'write' || name === 'edit' || name === 'multiedit' || name === 'notebookedit') {
    const path = firstString(input, ['file_path', 'path', 'notebook_path']) ?? '';
    if (touchesSecret(path)) return { action: 'ask', reason: 'writes to a secret file' };
    return { action: 'allow' };
  }

  // Everything else (Read, Grep, Glob, WebFetch, …) is safe to auto-approve.
  return { action: 'allow' };
}

/** The only non-shell tools an AI review may use — the review's `allowedTools`. */
export const REVIEW_READ_TOOLS: readonly string[] = ['Read', 'Grep', 'Glob'];

/** The only git subcommands an AI review may run through the shell. */
export const REVIEW_GIT_SUBCOMMANDS: readonly string[] = ['log', 'show', 'diff', 'blame'];

/**
 * One tool use the review policy refused, as recorded on the review. `detail` is
 * the human-readable description of the attempt (`describeToolUse`); `at` is ISO.
 */
export interface ReviewToolDenial {
  toolName: string;
  reason: string;
  detail: string;
  at: string;
}

/**
 * Any character that lets one command become several, redirect, or substitute:
 * chains (`;` `&` `|`), redirection (`<` `>`), substitution (`` ` `` `$` `(` `)`),
 * grouping (`{` `}`) and line breaks.
 */
const SHELL_METACHARACTERS = /[;&|<>`$(){}\n\r]/;

const REVIEW_READ_TOOL_NAMES = new Set(REVIEW_READ_TOOLS.map((tool) => tool.toLowerCase()));
const REVIEW_GIT_SUBCOMMAND_NAMES = new Set(REVIEW_GIT_SUBCOMMANDS);

/** Classify one shell command for a review: a single read-only git command, or deny. */
function evaluateReviewCommand(command: string): PermissionDecision {
  const trimmed = command.trim();
  if (trimmed === '') return { action: 'deny', reason: 'empty shell command' };
  if (SHELL_METACHARACTERS.test(trimmed)) {
    return { action: 'deny', reason: 'shell pipelines and chains are not allowed' };
  }

  const tokens = trimmed.split(/\s+/);
  if (tokens[0] !== 'git') {
    return { action: 'deny', reason: `only git ${REVIEW_GIT_SUBCOMMANDS.join('/')} may run` };
  }
  // The subcommand must come straight after `git`: a global option in between
  // (`-c core.pager=…`, `-C dir`, `--exec-path`) can run arbitrary programs.
  const subcommand = tokens[1];
  if (subcommand === undefined) return { action: 'deny', reason: 'bare git is not allowed' };
  if (!REVIEW_GIT_SUBCOMMAND_NAMES.has(subcommand)) {
    return { action: 'deny', reason: `git ${subcommand} is not a read-only review command` };
  }
  for (const arg of tokens.slice(2)) {
    if (arg.startsWith('--output')) return { action: 'deny', reason: `${arg} writes a file` };
    if (arg === '--ext-diff')
      return { action: 'deny', reason: '--ext-diff runs an external program' };
  }
  return { action: 'allow' };
}

/**
 * Classify one tool use in an unattended AI review (F16.5): `allow` or `deny`,
 * never `ask`. Default-deny — only `REVIEW_READ_TOOLS` and a single shell command
 * running one of `REVIEW_GIT_SUBCOMMANDS` are allowed.
 */
export function evaluateReviewToolUse(
  toolName: string,
  input: Record<string, unknown>,
): PermissionDecision {
  const name = toolName.toLowerCase();
  if (REVIEW_READ_TOOL_NAMES.has(name)) return { action: 'allow' };

  if (name === 'bash' || name === 'shell' || name === 'powershell') {
    return evaluateReviewCommand(firstString(input, ['command', 'cmd', 'script']) ?? '');
  }

  return { action: 'deny', reason: `${toolName} is not available to a read-only review` };
}
