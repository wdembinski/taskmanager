/**
 * Which sandboxing flags the installed CLI actually accepts. The AI reviewer (F16) runs
 * a headless session on a PR's head — untrusted input — and that run is only safe when
 * the CLI can be told to stay read-only: `--allowedTools`/`--disallowedTools` to fence
 * the tools, `--setting-sources` to ignore the PR's own `.claude/settings.json` (whose
 * hooks run shell commands), and `--strict-mcp-config` to ignore its `.mcp.json`. An
 * older CLI that lacks any of them must make the review REFUSE, never run unsandboxed —
 * this module only answers the question; ReviewRunner (F16.8) does the refusing.
 *
 * Modelled on `claudeModels.ts`: `claude --help` is answered by the CLI itself — zero
 * tokens, no network, no login needed — so the probe costs nothing but wall-clock time.
 * It reads nothing but the help text's flag list, matched as whole tokens, e.g.:
 *
 *   --allowedTools, --allowed-tools <tools...>   Comma or space-separated list of …
 *   --setting-sources <sources>                  Comma-separated list of setting …
 *   --strict-mcp-config                          Only use MCP servers from --mcp-config
 *
 * The answer only changes when the CLI does, so it is cached per (host target, CLI
 * version): every call still runs the cheap `claude --version`, and `--help` only runs
 * on a miss. Like the other probes it never throws — an unknown answer is `null`.
 */
import { localHost, type ExecHost } from './exec';
import { readClaudeVersion } from './claudeStatus';

/** What the installed CLI can do for a sandboxed run, as read from `claude --help`. */
export interface ClaudeCliCapabilities {
  allowedTools: boolean;
  disallowedTools: boolean;
  settingSources: boolean;
  strictMcpConfig: boolean;
  /** The `claude --version` this answer was read from. */
  version: string;
}

type CapabilityFlags = Omit<ClaudeCliCapabilities, 'version'>;

/**
 * One flag as a whole token: preceded by the start of a line or whitespace/a comma (the
 * `--a, --b` alias form), and NOT followed by another word character or hyphen — so
 * `--disallowedTools` never counts as `--allowedTools`, nor `--strict-mcp-config-x` as
 * `--strict-mcp-config`.
 */
const flagToken = (...names: string[]) =>
  new RegExp(`(?<=^|[\\s,])(?:${names.join('|')})(?![\\w-])`, 'm');

const FLAG_PATTERNS: Record<keyof CapabilityFlags, RegExp> = {
  allowedTools: flagToken('--allowedTools', '--allowed-tools'),
  disallowedTools: flagToken('--disallowedTools', '--disallowed-tools'),
  settingSources: flagToken('--setting-sources'),
  strictMcpConfig: flagToken('--strict-mcp-config'),
};

/** The flag name a missing capability is reported by, in the order the reviewer needs them. */
const FLAG_NAMES: Record<keyof CapabilityFlags, string> = {
  allowedTools: '--allowedTools',
  disallowedTools: '--disallowedTools',
  settingSources: '--setting-sources',
  strictMcpConfig: '--strict-mcp-config',
};

/** Pure text parse of `claude --help` into which sandboxing flags it lists. */
export function parseClaudeHelpCapabilities(helpText: string): CapabilityFlags {
  return {
    allowedTools: FLAG_PATTERNS.allowedTools.test(helpText),
    disallowedTools: FLAG_PATTERNS.disallowedTools.test(helpText),
    settingSources: FLAG_PATTERNS.settingSources.test(helpText),
    strictMcpConfig: FLAG_PATTERNS.strictMcpConfig.test(helpText),
  };
}

/**
 * The flag names the CLI lacks for the review sandbox — the raw material for an "update
 * Claude Code — this CLI lacks --setting-sources" message. Empty means supported.
 */
export function missingReviewSandboxFlags(caps: CapabilityFlags): string[] {
  return (Object.keys(FLAG_NAMES) as (keyof CapabilityFlags)[])
    .filter((key) => !caps[key])
    .map((key) => FLAG_NAMES[key]);
}

/** Process-wide cache, keyed by host target + CLI version. */
const defaultCache = new Map<string, ClaudeCliCapabilities>();

/**
 * Read the installed CLI's sandboxing capabilities, cached per (host target, CLI
 * version). Never throws: a missing CLI or a `--help` that fails is `null` ("unknown"),
 * and is NOT cached, so the next call tries again. `cache` is injectable for tests.
 */
export async function probeClaudeCapabilities(
  host: ExecHost = localHost(),
  cache: Map<string, ClaudeCliCapabilities> = defaultCache,
): Promise<ClaudeCliCapabilities | null> {
  try {
    const version = await readClaudeVersion(host);
    if (version === null) return null;
    const key = `${JSON.stringify(host.target)}|${version}`;
    const cached = cache.get(key);
    if (cached) return cached;

    const { code, stdout } = await host.exec(process.cwd(), 'claude', ['--help'], {
      resolveViaShell: true,
      timeoutMs: 10_000,
    });
    if (code !== 0) return null;
    const caps: ClaudeCliCapabilities = { ...parseClaudeHelpCapabilities(stdout), version };
    cache.set(key, caps);
    return caps;
  } catch {
    return null;
  }
}
