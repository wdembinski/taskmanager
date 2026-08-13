/**
 * The account's REAL usage, straight from the CLI's own `/usage` command.
 *
 * `usageRollup.ts` measures spend against a budget the human typed in — the honest
 * thing to build when the only signal the CLI streams during a session is "a window
 * is under pressure" and "when it resets" (see docs/08, `rate_limit_event`). But the
 * CLI is not actually limited to that signal: `/usage` is a **local** meta-command —
 * answered by the CLI itself, zero tokens, zero turns — that prints the exact
 * percentages the human sees when they type it themselves. That is the number this
 * app's bars should show, so this module asks for it the same way.
 *
 * `claude -p "/usage" --output-format json` returns instantly with `total_cost_usd: 0`
 * and `num_turns: 0` — it never reaches the model. The reply text looks like:
 *
 *   Current session: 19% used · resets Aug 7, 2:39pm (Europe/Warsaw)
 *   Current week (all models): 3% used · resets Aug 13, 7:59pm (Europe/Warsaw)
 *
 * which `parseClaudeUsageText` turns into two numbers. Everything else in that text
 * (per-skill/subagent breakdowns, the Fable-specific week line) is not something the
 * app's two bars represent, so it is read and discarded.
 */
import { localHost, type ExecHost } from './exec';

/** The two percentages `/usage` reports, or null for one the text didn't contain. */
export interface CliUsageReading {
  sessionPct: number | null;
  weeklyPct: number | null;
}

const SESSION_LINE = /Current session:\s*(\d+)%\s*used/i;
const WEEKLY_LINE = /Current week \(all models\):\s*(\d+)%\s*used/i;

/** Pure text parse, split out so it is unit-testable without spawning anything. */
export function parseClaudeUsageText(text: string): CliUsageReading {
  const session = text.match(SESSION_LINE);
  const weekly = text.match(WEEKLY_LINE);
  return {
    sessionPct: session ? Number(session[1]) : null,
    weeklyPct: weekly ? Number(weekly[1]) : null,
  };
}

/**
 * Run `/usage` and read the two percentages back. Never throws — a CLI that is
 * missing, logged out, offline, or mid-upgrade just means "no reading yet", the same
 * shape `getClaudeStatus` uses for the same reasons.
 *
 * `timeoutMs` is a parameter because the background poller and the scheduler want
 * different answers to "how long is too long". The poller can afford to wait — nothing
 * is blocked on it, and a slow reading still refreshes a bar. The limit classifier
 * cannot: it asks with the queue held, so it passes a few seconds and treats a slower
 * CLI as no reading at all (see `Scheduler.probeUsage`).
 */
export async function readClaudeUsage(
  host: ExecHost = localHost(),
  timeoutMs = 30_000,
): Promise<CliUsageReading | null> {
  const { code, stdout } = await host.exec(
    process.cwd(),
    'claude',
    ['-p', '/usage', '--output-format', 'json'],
    { resolveViaShell: true, timeoutMs },
  );
  if (code !== 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  const result = (parsed as { result?: unknown } | null)?.result;
  if (typeof result !== 'string') return null;
  const reading = parseClaudeUsageText(result);
  return reading.sessionPct === null && reading.weeklyPct === null ? null : reading;
}

/**
 * How often the background poll re-asks the CLI. The windows are hours/days wide, so
 * there is nothing to gain from asking more often than this — and each ask is a new
 * `claude` process (free, but not free to spawn), so this stays well above "instant".
 */
const POLL_MS = 10 * 60 * 1000;

/**
 * Keeps one fresh `CliUsageReading` around so `usage:quotas` never blocks an IPC call
 * on a multi-second subprocess. Polls on its own clock rather than per-request — the
 * same reasoning as `SyncPoller`, minus the settings-driven cadence, since this isn't
 * something a human configures.
 */
export class ClaudeUsagePoller {
  private reading: CliUsageReading | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly host: ExecHost = localHost()) {}

  /** Read once immediately, then keep refreshing on `POLL_MS`. */
  start(): void {
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), POLL_MS);
  }

  private async refresh(): Promise<void> {
    const next = await readClaudeUsage(this.host);
    // A failed probe (offline, CLI busy) keeps the last good reading rather than
    // blanking the bar back to the budget estimate for one missed tick.
    if (next) this.reading = next;
  }

  /** The last successful reading, or null before the first one has landed. */
  current(): CliUsageReading | null {
    return this.reading;
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
