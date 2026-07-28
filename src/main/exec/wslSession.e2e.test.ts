/**
 * End-to-end: a real Claude session running INSIDE WSL, with the permission gate
 * crossing the Windows↔Linux boundary.
 *
 * This is the integration the whole feature rests on, and the one that cannot be
 * proven by unit tests: the CLI runs in Linux, but the relay it spawns must be the
 * WINDOWS binary (reached through interop) so it can reach the broker on Windows
 * loopback — which, under WSL's default NAT networking, Linux cannot do.
 *
 * It runs a real `claude`, so it costs tokens and needs a logged-in CLI in the
 * distro. It is therefore OFF by default and opt-in:
 *
 *     ORCH_E2E=1 pnpm vitest run src/main/exec/wslSession.e2e.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runClaudeSession } from '../claudeSession';
import { PermissionBroker, type PermissionRequest } from '../permissionBroker';
import { writePermissionServer } from '../permissionServerSource';
import type { SessionEvent } from '@shared/session';
import { localHost } from './index';
import { listWslDistros } from './wsl';
import { WslExecHost } from './wslHost';

const ENABLED = process.env.ORCH_E2E === '1' && process.platform === 'win32';

let distro = '';
let mcpDir = '';
/** Where the local control writes its probe file — never the repo. */
let scratchDir = '';

beforeAll(async () => {
  if (!ENABLED) return;
  const all = await listWslDistros();
  distro = all.find((d) => !d.startsWith('docker-desktop')) ?? '';
  mcpDir = mkdtempSync(join(tmpdir(), 'orch-e2e-mcp-'));
  scratchDir = mkdtempSync(join(tmpdir(), 'orch-e2e-cwd-'));
}, 60_000);

afterAll(() => {
  for (const dir of [mcpDir, scratchDir]) {
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
  // The WSL case writes into the distro's /tmp, which is outside those directories.
  if (distro) {
    try {
      execFileSync('wsl.exe', ['-d', distro, '-e', 'bash', '-lc', 'rm -f /tmp/orch-gate-*.txt'], {
        windowsHide: true,
        timeout: 20_000,
      });
    } catch {
      // Leftover probe files in /tmp are harmless; never fail teardown over them.
    }
  }
});

describe.runIf(ENABLED)('Claude session inside WSL', () => {
  it.each([
    // The local run is the CONTROL: it exercises the identical gate wiring on the
    // machine where it is already known to work, so a failure in both means the test
    // setup is wrong, while a failure in only one localizes the bug to that host.
    { name: 'local (control)', makeHost: () => localHost(), makeCwd: () => scratchDir },
    { name: 'wsl', makeHost: () => new WslExecHost(distro), makeCwd: () => '/tmp' },
  ])('$name: runs the tool and routes it through the gate', async ({ makeHost, makeCwd }) => {
    expect(distro).not.toBe('');
    const host = makeHost();
    const cwd = makeCwd();

    // A real broker on Windows loopback — the address Linux cannot reach directly,
    // which is precisely why the relay has to be a Windows process.
    const seen: PermissionRequest[] = [];
    const broker = new PermissionBroker(async (request) => {
      seen.push(request);
      return { behavior: 'allow', updatedInput: request.input };
    });
    const address = await broker.start();

    const events: SessionEvent[] = [];
    // Unique per case: the run id names the throwaway MCP config file, which a
    // finishing session deletes. Sharing one would let the first case's cleanup
    // unlink the second case's config while its CLI was still starting.
    const runId = `e2e-${randomUUID()}`;
    const probeFile = `orch-gate-${runId.slice(4, 12)}.txt`;
    const handle = runClaudeSession(
      {
        // Force exactly one tool use whose output proves which kernel ran it.
        // A MUTATING tool: read-only commands like `uname` are auto-approved by the
        // CLI and never reach the permission tool, so they cannot prove the gate.
        // The name is unique per run — against an existing file the agent reads it,
        // sees the work is already done, and answers without ever calling a tool.
        prompt: `Use the Write tool to create a file named ${probeFile} containing the single word ok. Then reply "done".`,
        cwd,
        model: 'haiku',
        // With a gate present this becomes the CLI's `default` mode (see
        // `buildClaudeArgs`), which is what routes tool use through the relay.
        permissionMode: 'manual',
      },
      (event) => events.push(event),
      {
        runId,
        host,
        permission: {
          brokerUrl: address.url,
          token: address.token,
          serverScriptPath: writePermissionServer(mcpDir),
          configDir: mcpDir,
        },
      },
    );

    // Wait for the session to produce its result.
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('session timed out')), 180_000);
      const done = (): void => {
        clearTimeout(timer);
        resolve();
      };
      const poll = setInterval(() => {
        if (events.some((e) => e.kind === 'result' || e.kind === 'exited')) {
          clearInterval(poll);
          done();
        }
      }, 500);
    });
    handle.stop();
    broker.close();

    const stderr = events
      .filter((e): e is Extract<SessionEvent, { kind: 'stderr' }> => e.kind === 'stderr')
      .map((e) => e.text)
      .join('');

    const transcript = JSON.stringify(events, null, 2);
    const diagnostics = `stderr:\n${stderr}\n\nevents:\n${transcript}`;

    // 1. The gate was actually consulted — the relay crossed the boundary.
    expect(seen.length, `no permission request reached the broker.\n${diagnostics}`).toBeGreaterThan(
      0,
    );

    // 2. The tool really ran.
    expect(transcript, diagnostics).toContain('tool-use');
  }, 240_000);
});
