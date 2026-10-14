/**
 * Real end-to-end check of two things `scheduler.test.ts` can only ever see through a
 * mocked `SessionManager`: that the global session cap (`maxParallelSessions`) actually
 * throttles REAL spawned processes across two projects, and that
 * `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` / `CLAUDE_CODE_SUBAGENT_MODEL` actually land in the
 * CLI's OS environment.
 *
 * `claude` itself is a tiny stub script dropped onto PATH for the duration of this file —
 * the same technique `git.test.ts` uses for `git`: a system binary with no Electron ABI
 * split, so the real `LocalExecHost.spawn` runs fine under plain vitest, with no worktree
 * manager and no Electron involved. Never launched: the Electron app itself.
 *
 * The stub never exits on its own — like the real CLI, which keeps stdin open — so each
 * test drives it by dropping a `release-<pid>` file it polls for, then reads whatever the
 * stub recorded about its own process (did it run, what env did it see) before it exited.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { Scheduler } from './scheduler';
import { SessionManager } from './sessionManager';
import type { Project, Task } from '@shared/model';
import type { Store } from './store';

const INERT_ATTENTION_STORE = {
  saveAttention: () => undefined,
  deleteAttention: () => undefined,
  listAttention: () => [],
  getTaskHistory: () => [],
};

/**
 * The stub's own logic, written out as plain Node source and materialized onto disk by
 * each launcher below. Deliberately uses `+` string concatenation rather than template
 * interpolation for its own file names — it is itself embedded in a TS template literal,
 * and `${}` there would interpolate against THIS file's scope, not the stub's.
 */
const STUB_BODY = `
const fs = require('fs');
const path = require('path');
const pid = process.pid;
const controlDir = process.env.ORCH_TEST_CONTROL_DIR;
fs.writeFileSync(
  path.join(process.cwd(), 'env-' + pid + '.json'),
  JSON.stringify({
    autoCompact: process.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE ?? null,
    subagentModel: process.env.CLAUDE_CODE_SUBAGENT_MODEL ?? null,
  }),
);
fs.writeFileSync(path.join(controlDir, 'spawned-' + pid), '');
process.stdout.write(
  JSON.stringify({
    type: 'system',
    subtype: 'init',
    session_id: String(pid),
    model: 'stub',
    cwd: process.cwd(),
    permissionMode: 'default',
  }) + '\\n',
);
// Never self-exits on a timer the way a real CLI wouldn't either — it waits to be told,
// via a release file the test drops once it has observed what it needed to. The 20s
// deadline is only a safety valve so a broken test cannot leak a process forever.
const releaseFile = path.join(controlDir, 'release-' + pid);
const deadline = Date.now() + 20000;
(function poll() {
  if (fs.existsSync(releaseFile)) {
    process.exit(0);
  }
  if (Date.now() > deadline) {
    process.exit(1);
  }
  setTimeout(poll, 50);
})();
`;

let binDir = '';
let originalPath: string | undefined;

beforeAll(() => {
  binDir = mkdtempSync(join(tmpdir(), 'orch-claude-stub-'));
  writeFileSync(join(binDir, 'claude-stub.cjs'), STUB_BODY, 'utf8');
  if (process.platform === 'win32') {
    // cmd.exe resolves `claude` via PATHEXT; it never reads a POSIX shebang line.
    writeFileSync(
      join(binDir, 'claude.cmd'),
      '@echo off\r\nnode "%~dp0claude-stub.cjs" %*\r\n',
      'utf8',
    );
  } else {
    // sh resolves `claude` by name and executable bit; it never looks at PATHEXT.
    const launcher = join(binDir, 'claude');
    writeFileSync(
      launcher,
      '#!/usr/bin/env node\nrequire(__dirname + "/claude-stub.cjs");\n',
      'utf8',
    );
    chmodSync(launcher, 0o755);
  }
  originalPath = process.env.PATH;
  process.env.PATH = `${binDir}${delimiter}${originalPath ?? ''}`;
});

afterAll(() => {
  if (originalPath !== undefined) process.env.PATH = originalPath;
  rmSync(binDir, { recursive: true, force: true });
});

function spawnedPids(controlDir: string): string[] {
  return readdirSync(controlDir)
    .filter((f) => f.startsWith('spawned-'))
    .map((f) => f.slice('spawned-'.length));
}

async function waitFor(check: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * A released stub's OWN exit is not the whole story: it runs under the `claude.cmd` /
 * `claude` launcher this file put on PATH, which is itself a layer the real OS process
 * table has to unwind before the directory it ran in (its cwd) is truly free. Wait for
 * every pid this test observed to leave the process table before ever touching that
 * directory, rather than racing `rmSync` against however long that unwind takes.
 */
async function waitForPidsGone(pids: string[], timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (const pid of pids) {
    while (isPidAlive(Number(pid))) {
      if (Date.now() > deadline) return; // best-effort — rmSyncRetrying below still guards
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}

/**
 * Even once its process is confirmed gone, Windows can hold a just-freed cwd handle
 * open a little past that — so a plain `rmSync` can still race it with `EBUSY`. Retry
 * instead of padding every test with a blind sleep.
 */
async function rmSyncRetrying(path: string): Promise<void> {
  const deadline = Date.now() + 10000;
  for (;;) {
    try {
      rmSync(path, { recursive: true, force: true });
      return;
    } catch (err) {
      if (Date.now() > deadline) throw err;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

/** The dumped env file lives in whichever project directory that pid's stub ran in. */
function readEnvDump(
  projectDirs: string[],
  pid: string,
): { autoCompact: unknown; subagentModel: unknown } {
  for (const dir of projectDirs) {
    try {
      return JSON.parse(readFileSync(join(dir, `env-${pid}.json`), 'utf8'));
    } catch {
      // Not this one — try the next project directory.
    }
  }
  throw new Error(`no env dump for pid ${pid} in any of ${projectDirs.join(', ')}`);
}

const makeTask = (id: string, projectId: string, order: number): Task =>
  ({
    id,
    projectId,
    phase: '',
    title: id,
    status: 'pending',
    sessionId: null,
    order,
    source: 'plan',
    dependsOn: [],
    isContract: false,
    isScaffold: false,
  }) as Task;

describe('Scheduler against a real spawned `claude` process', () => {
  it('throttles real sessions at maxParallelSessions across two projects, a settle starts the next queued card, and unset CLI overrides reach the process as absent', async () => {
    const controlDir = mkdtempSync(join(tmpdir(), 'orch-control-'));
    const p1Dir = mkdtempSync(join(tmpdir(), 'orch-proj1-'));
    const p2Dir = mkdtempSync(join(tmpdir(), 'orch-proj2-'));
    const priorControlDir = process.env.ORCH_TEST_CONTROL_DIR;
    process.env.ORCH_TEST_CONTROL_DIR = controlDir;

    const p1 = {
      id: 'p1',
      path: p1Dir,
      planPath: join(p1Dir, 'plan.md'),
      concurrency: 2,
      defaultModel: 'sonnet',
      defaultPermissionMode: 'acceptEdits',
    } as Project;
    const p2 = {
      id: 'p2',
      path: p2Dir,
      planPath: join(p2Dir, 'plan.md'),
      concurrency: 2,
      defaultModel: 'sonnet',
      defaultPermissionMode: 'acceptEdits',
    } as Project;
    const tasks: Task[] = [
      makeTask('p1-a', 'p1', 0),
      makeTask('p1-b', 'p1', 1),
      makeTask('p2-a', 'p2', 0),
      makeTask('p2-b', 'p2', 1),
    ];
    const store = {
      getTasks: (projectId: string) => tasks.filter((t) => t.projectId === projectId),
      getProject: (id: string) => (id === 'p1' ? p1 : id === 'p2' ? p2 : undefined),
      getTask: (id: string) => tasks.find((t) => t.id === id),
      getSubtasks: () => [],
      updateTask: (id: string, patch: Partial<Task>) => {
        const found = tasks.find((x) => x.id === id);
        if (found) Object.assign(found, patch);
        return found;
      },
      getSettings: () => ({
        limitJitterMs: 0,
        concurrency: 2,
        maxParallelSessions: 2,
        autoCompactPercent: null,
        subagentModel: null,
      }),
      appendTaskEvent: () => undefined,
      listTaskLinks: () => [],
      addComment: () => undefined,
      ...INERT_ATTENTION_STORE,
    } as unknown as Store;

    const sessions = new SessionManager(() => undefined);
    const scheduler = new Scheduler(store, sessions, vi.fn(), vi.fn(), vi.fn(), vi.fn(), vi.fn());

    try {
      scheduler.start('p1');
      scheduler.start('p2');

      // p1 alone spends the whole cap (its own concurrency is 2) — p2 is held entirely,
      // exactly as the mocked unit test proves, but here across two REAL child processes.
      await waitFor(() => spawnedPids(controlDir).length >= 2, 10000);
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(spawnedPids(controlDir).length).toBe(2);

      // Neither process was launched with either CLI override — the project's settings
      // set both to null — so the stub must see them as genuinely absent, not `"null"`.
      for (const pid of spawnedPids(controlDir)) {
        const dump = readEnvDump([p1Dir, p2Dir], pid);
        expect(dump.autoCompact).toBeNull();
        expect(dump.subagentModel).toBeNull();
      }

      // Settle one of the two running processes — a settle, not a crash, the same way
      // `stopTask` + the process's own `exited` event does for the real CLI.
      const [releasedPid] = spawnedPids(controlDir);
      writeFileSync(join(controlDir, `release-${releasedPid}`), '');

      // The freed cap slot goes to p2's queued card — a third process appears, and no
      // more than one does (the other original process is still blocked, untouched).
      await waitFor(() => spawnedPids(controlDir).length >= 3, 10000);
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(spawnedPids(controlDir).length).toBe(3);
    } finally {
      const everSpawned = spawnedPids(controlDir);
      for (const pid of everSpawned) {
        writeFileSync(join(controlDir, `release-${pid}`), '');
      }
      await waitForPidsGone(everSpawned, 10000);
      scheduler.dispose();
      if (priorControlDir === undefined) delete process.env.ORCH_TEST_CONTROL_DIR;
      else process.env.ORCH_TEST_CONTROL_DIR = priorControlDir;
      await rmSyncRetrying(controlDir);
      await rmSyncRetrying(p1Dir);
      await rmSyncRetrying(p2Dir);
    }
  }, 45000);

  it('passes autoCompactPercent and subagentModel through to the real process environment when set', async () => {
    const controlDir = mkdtempSync(join(tmpdir(), 'orch-control-'));
    const projectDir = mkdtempSync(join(tmpdir(), 'orch-proj-'));
    const priorControlDir = process.env.ORCH_TEST_CONTROL_DIR;
    process.env.ORCH_TEST_CONTROL_DIR = controlDir;

    const project = {
      id: 'p1',
      path: projectDir,
      planPath: join(projectDir, 'plan.md'),
      concurrency: 1,
      defaultModel: 'sonnet',
      defaultPermissionMode: 'acceptEdits',
    } as Project;
    const tasks: Task[] = [makeTask('p1-a', 'p1', 0)];
    const store = {
      getTasks: (projectId: string) => tasks.filter((t) => t.projectId === projectId),
      getProject: (id: string) => (id === 'p1' ? project : undefined),
      getTask: (id: string) => tasks.find((t) => t.id === id),
      getSubtasks: () => [],
      updateTask: (id: string, patch: Partial<Task>) => {
        const found = tasks.find((x) => x.id === id);
        if (found) Object.assign(found, patch);
        return found;
      },
      getSettings: () => ({
        limitJitterMs: 0,
        concurrency: 1,
        maxParallelSessions: 0,
        autoCompactPercent: 42,
        subagentModel: 'haiku-test',
      }),
      appendTaskEvent: () => undefined,
      listTaskLinks: () => [],
      addComment: () => undefined,
      ...INERT_ATTENTION_STORE,
    } as unknown as Store;

    const sessions = new SessionManager(() => undefined);
    const scheduler = new Scheduler(store, sessions, vi.fn(), vi.fn(), vi.fn(), vi.fn(), vi.fn());

    try {
      scheduler.start('p1');

      await waitFor(() => spawnedPids(controlDir).length >= 1, 10000);
      const [pid] = spawnedPids(controlDir);
      const dump = readEnvDump([projectDir], pid);
      expect(dump.autoCompact).toBe('42');
      expect(dump.subagentModel).toBe('haiku-test');
    } finally {
      const everSpawned = spawnedPids(controlDir);
      for (const pid of everSpawned) {
        writeFileSync(join(controlDir, `release-${pid}`), '');
      }
      await waitForPidsGone(everSpawned, 10000);
      scheduler.dispose();
      if (priorControlDir === undefined) delete process.env.ORCH_TEST_CONTROL_DIR;
      else process.env.ORCH_TEST_CONTROL_DIR = priorControlDir;
      await rmSyncRetrying(controlDir);
      await rmSyncRetrying(projectDir);
    }
  }, 20000);
});
