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
 */

/** The outcome of classifying one tool use. `reason` explains an `ask` to the human. */
export type PermissionDecision = { action: 'allow' } | { action: 'ask'; reason: string };

/** Tools whose whole purpose is to delete — always routed to a human. */
const DELETE_TOOLS = new Set(['delete', 'deletefile', 'remove', 'rm', 'trash']);

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
