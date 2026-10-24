import { describe, expect, it } from 'vitest';
import type { ExecTarget } from '@shared/execTarget';
import { LOCAL_TARGET, type ExecHost, type ExecResult } from './exec';
import {
  missingReviewSandboxFlags,
  parseClaudeHelpCapabilities,
  probeClaudeCapabilities,
  type ClaudeCliCapabilities,
} from './claudeCapabilities';

/** An excerpt of `claude --help` from a current CLI: all four flags, with the
 *  `--long, --alias <value>` form the newer help text uses. */
const CURRENT_HELP = `Usage: claude [options] [command] [prompt]

Options:
  -d, --debug [filter]                              Enable debug mode
  --mcp-config <configs...>                         Load MCP servers from JSON files or strings
  --strict-mcp-config                               Only use MCP servers from --mcp-config
  --allowedTools, --allowed-tools <tools...>        Comma or space-separated list of tool names to allow
  --disallowedTools, --disallowed-tools <tools...>  Comma or space-separated list of tool names to deny
  --setting-sources <sources>                       Comma-separated list of setting sources to load
  -h, --help                                        Display help for command
`;

/** An older CLI: it can fence tools but cannot ignore a repo's settings or MCP config. */
const OLDER_HELP = `Usage: claude [options] [command] [prompt]

Options:
  --mcp-config <file or string>   Load MCP servers from a JSON file or string
  --allowedTools <tools...>       A list of tool names to allow
  --disallowedTools <tools...>    A list of tool names to deny
  -h, --help                      Display help for command
`;

describe('parseClaudeHelpCapabilities', () => {
  it('finds all four flags in a current CLI, alias form included', () => {
    expect(parseClaudeHelpCapabilities(CURRENT_HELP)).toEqual({
      allowedTools: true,
      disallowedTools: true,
      settingSources: true,
      strictMcpConfig: true,
    });
  });

  it('reports what an older CLI lacks, and missingReviewSandboxFlags names it', () => {
    const caps = parseClaudeHelpCapabilities(OLDER_HELP);
    expect(caps).toEqual({
      allowedTools: true,
      disallowedTools: true,
      settingSources: false,
      strictMcpConfig: false,
    });
    expect(missingReviewSandboxFlags(caps)).toEqual(['--setting-sources', '--strict-mcp-config']);
  });

  it('does not read --disallowedTools as --allowedTools', () => {
    const caps = parseClaudeHelpCapabilities('  --disallowedTools <tools...>  deny\n');
    expect(caps.allowedTools).toBe(false);
    expect(caps.disallowedTools).toBe(true);
  });

  it('does not read a longer flag as a prefix match', () => {
    expect(parseClaudeHelpCapabilities('  --strict-mcp-config-x  nope\n').strictMcpConfig).toBe(
      false,
    );
  });

  it('is all false for empty text, and every flag is missing', () => {
    const caps = parseClaudeHelpCapabilities('');
    expect(caps).toEqual({
      allowedTools: false,
      disallowedTools: false,
      settingSources: false,
      strictMcpConfig: false,
    });
    expect(missingReviewSandboxFlags(caps)).toEqual([
      '--allowedTools',
      '--disallowedTools',
      '--setting-sources',
      '--strict-mcp-config',
    ]);
  });

  it('names nothing missing for a current CLI', () => {
    expect(missingReviewSandboxFlags(parseClaudeHelpCapabilities(CURRENT_HELP))).toEqual([]);
  });
});

/** A fake host answering `--version` and `--help`, counting how often each runs. A null
 *  result stands for a failing command (non-zero exit). */
function fakeHost(opts: {
  target?: ExecTarget;
  version: () => string | null;
  help?: () => ExecResult;
}) {
  const calls = { version: 0, help: 0 };
  const host: ExecHost = {
    target: opts.target ?? LOCAL_TARGET,
    exec: async (_cwd, _file, args) => {
      if (args[0] === '--version') {
        calls.version++;
        const v = opts.version();
        return v === null
          ? { code: 1, stdout: '', stderr: 'not found' }
          : { code: 0, stdout: `${v} (Claude Code)\n`, stderr: '' };
      }
      if (args[0] === '--help') {
        calls.help++;
        return opts.help ? opts.help() : { code: 0, stdout: CURRENT_HELP, stderr: '' };
      }
      throw new Error(`fakeHost: unexpected args ${args.join(' ')}`);
    },
    spawn: () => {
      throw new Error('not used');
    },
    toNative: (p) => p,
    toApp: (p) => p,
    relaySpec: () => {
      throw new Error('not used');
    },
    homeDir: async () => '',
  };
  return { host, calls };
}

describe('probeClaudeCapabilities', () => {
  it('parses --help and tags the answer with the version', async () => {
    const { host } = fakeHost({ version: () => '2.1.300' });
    expect(await probeClaudeCapabilities(host, new Map())).toEqual({
      allowedTools: true,
      disallowedTools: true,
      settingSources: true,
      strictMcpConfig: true,
      version: '2.1.300',
    });
  });

  it('does not re-run --help for the same version', async () => {
    const cache = new Map<string, ClaudeCliCapabilities>();
    const { host, calls } = fakeHost({ version: () => '2.1.300' });
    const first = await probeClaudeCapabilities(host, cache);
    const second = await probeClaudeCapabilities(host, cache);
    expect(second).toEqual(first);
    expect(calls.help).toBe(1);
    expect(calls.version).toBe(2);
  });

  it('re-runs --help when the version changes', async () => {
    const cache = new Map<string, ClaudeCliCapabilities>();
    let version = '2.1.200';
    const { host, calls } = fakeHost({
      version: () => version,
      help: () => ({
        code: 0,
        stdout: version === '2.1.200' ? OLDER_HELP : CURRENT_HELP,
        stderr: '',
      }),
    });
    expect((await probeClaudeCapabilities(host, cache))?.settingSources).toBe(false);
    version = '2.1.300';
    expect((await probeClaudeCapabilities(host, cache))?.settingSources).toBe(true);
    expect(calls.help).toBe(2);
  });

  it('re-runs --help for a different target at the same version', async () => {
    const cache = new Map<string, ClaudeCliCapabilities>();
    const local = fakeHost({ version: () => '2.1.300' });
    const wsl = fakeHost({
      target: { kind: 'wsl', distro: 'Ubuntu' },
      version: () => '2.1.300',
      help: () => ({ code: 0, stdout: OLDER_HELP, stderr: '' }),
    });
    expect((await probeClaudeCapabilities(local.host, cache))?.strictMcpConfig).toBe(true);
    expect((await probeClaudeCapabilities(wsl.host, cache))?.strictMcpConfig).toBe(false);
    expect(local.calls.help).toBe(1);
    expect(wsl.calls.help).toBe(1);
  });

  it('is null for a missing CLI, without running --help or caching', async () => {
    const cache = new Map<string, ClaudeCliCapabilities>();
    const { host, calls } = fakeHost({ version: () => null });
    expect(await probeClaudeCapabilities(host, cache)).toBeNull();
    expect(calls.help).toBe(0);
    expect(cache.size).toBe(0);
  });

  it('is null for a failing --help, and is not cached', async () => {
    const cache = new Map<string, ClaudeCliCapabilities>();
    let fail = true;
    const { host, calls } = fakeHost({
      version: () => '2.1.300',
      help: () =>
        fail
          ? { code: 1, stdout: '', stderr: 'boom' }
          : { code: 0, stdout: CURRENT_HELP, stderr: '' },
    });
    expect(await probeClaudeCapabilities(host, cache)).toBeNull();
    expect(cache.size).toBe(0);
    fail = false;
    expect((await probeClaudeCapabilities(host, cache))?.allowedTools).toBe(true);
    expect(calls.help).toBe(2);
  });

  it('is null rather than throwing when the host throws', async () => {
    const { host } = fakeHost({
      version: () => {
        throw new Error('spawn failed');
      },
    });
    expect(await probeClaudeCapabilities(host, new Map())).toBeNull();
  });
});
