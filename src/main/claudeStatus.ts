/**
 * Detects whether the local Claude CLI is ready to be orchestrated.
 *
 * The whole app depends on one external thing: the `claude` command-line tool,
 * logged in with the user's subscription. Before we try to run any tasks we
 * check three things and report them to the UI so problems are obvious:
 *
 *   1. Is `claude` installed?  (run `claude --version`)
 *   2. Is it logged in?        (does ~/.claude/.credentials.json exist?)
 *   3. Is an API key set?      (ANTHROPIC_API_KEY — we WARN, because that would
 *                               bill the paid API instead of the subscription.)
 *
 * This runs in the main (Node) process, which is allowed to touch the filesystem
 * and spawn processes. The renderer asks for the result via IPC.
 */
import { existsSync } from 'node:fs';
import type { ClaudeStatus } from '@shared/ipc';
import { hostJoin, localHost, type ExecHost } from './exec';

/**
 * Run `claude --version` and return the version string, or null if the binary
 * is missing / not runnable. `resolveViaShell` lets Windows resolve `claude.cmd`
 * from PATH the same way a terminal would.
 */
async function readClaudeVersion(host: ExecHost): Promise<string | null> {
  const { code, stdout } = await host.exec(process.cwd(), 'claude', ['--version'], {
    resolveViaShell: true,
    timeoutMs: 10_000,
  });
  if (code !== 0) return null;
  // Output looks like: "2.1.200 (Claude Code)" — grab the leading semver.
  const match = stdout.match(/\d+\.\d+\.\d+/);
  return match ? match[0] : stdout.trim();
}

/** The raw facts gathered from the machine, before we phrase them for the UI. */
export interface ClaudeStatusInputs {
  /** Version string from `claude --version`, or null if not installed. */
  version: string | null;
  /** Whether ~/.claude/.credentials.json exists (subscription login present). */
  authenticated: boolean;
  /** Whether ANTHROPIC_API_KEY is set in the environment. */
  apiKeyDetected: boolean;
}

/**
 * Pure function that turns raw facts into the UI-facing status (flags + a
 * human-readable message). Kept separate from the side-effecting gathering
 * below so it can be unit-tested without touching the filesystem or spawning
 * processes. The order of checks matters: we report the most important problem
 * first (missing > wrong billing > not logged in > all good).
 */
export function summarizeClaudeStatus(inputs: ClaudeStatusInputs): ClaudeStatus {
  const { version, authenticated, apiKeyDetected } = inputs;
  const installed = version !== null;

  let message: string;
  if (!installed) {
    message =
      'The `claude` CLI was not found on your PATH. Install Claude Code, then restart this app.';
  } else if (apiKeyDetected) {
    message =
      'ANTHROPIC_API_KEY is set — Claude would bill the paid API. Unset it to use your subscription for free.';
  } else if (!authenticated) {
    message = 'Claude is installed but not logged in. Run `claude` once and sign in, then retry.';
  } else {
    message = `Claude ${version} is installed and logged in with your subscription.`;
  }

  return { installed, version: version ?? undefined, authenticated, apiKeyDetected, message };
}

/**
 * Produce a full status report for the UI. Never throws — any failure is folded
 * into the returned object so the dashboard can always render something useful.
 */
export async function getClaudeStatus(host: ExecHost = localHost()): Promise<ClaudeStatus> {
  const version = await readClaudeVersion(host);
  // The subscription login is stored here by `claude` after you log in — on the host
  // that runs it, which is not necessarily the machine showing this window.
  const credentialsPath = host.toApp(
    hostJoin(await host.homeDir(), '.claude', '.credentials.json'),
  );

  return summarizeClaudeStatus({
    version,
    authenticated: existsSync(credentialsPath),
    // If this is set, the CLI/SDK would use the PAID API instead of the
    // subscription — we surface it prominently so the user can unset it.
    apiKeyDetected: Boolean(process.env.ANTHROPIC_API_KEY),
  });
}
