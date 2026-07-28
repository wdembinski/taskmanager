/**
 * The worktree lifecycle against a REAL git repository inside a WSL distro.
 *
 * This is the half of the feature that unit tests cannot reach: that worktrees are
 * created *inside the distro* (never on the Windows side of a 9p share, which a Linux
 * git cannot sanely own), that paths are built with Linux separators, and that a
 * branch still rebases and fast-forwards back into base when every git invocation is
 * crossing the boundary.
 *
 * Skips itself when WSL is unavailable, so the suite still passes without it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import type { Project, Task } from '@shared/model';
import { listWslDistros } from './exec/wsl';
import { WslExecHost } from './exec/wslHost';
import { commitAll, currentBranch } from './git';
import { WorktreeManager } from './worktreeManager';

let distro = '';
let host: WslExecHost | null = null;
let repo = '';
let base = '';

const ready = (): boolean => distro !== '' && host !== null;

beforeAll(async () => {
  if (process.platform !== 'win32') return;
  const all = await listWslDistros();
  distro = all.find((d) => !d.startsWith('docker-desktop')) ?? '';
  if (!distro) return;
  host = new WslExecHost(distro);

  // A throwaway repo on the distro's own filesystem — the case that matters.
  const home = await host.homeDir();
  repo = `${home}/orch-wt-test-${randomUUID().slice(0, 8)}`;
  const setup = [
    `mkdir -p ${repo}`,
    `cd ${repo}`,
    'git init -q',
    'git config user.email test@example.com',
    'git config user.name Test',
    'git config commit.gpgsign false',
    'echo hello > a.txt',
    'git add -A',
    'git commit -q --no-verify -m initial',
  ].join(' && ');
  const res = await host.exec('/', 'sh', ['-c', setup]);
  expect(res.code, `repo setup failed: ${res.stderr}`).toBe(0);
  base = await currentBranch(repo, host);
}, 120_000);

afterAll(async () => {
  if (host && repo) {
    // Remove the repo AND the worktrees the manager sited under the distro's home.
    await host.exec('/', 'sh', ['-c', `rm -rf ${repo} ~/.local/share/claude-orchestrator/worktrees`]);
  }
});

describe.runIf(process.platform === 'win32')('WorktreeManager against a WSL repo', () => {
  const project = (): Project =>
    ({
      id: 'p-wsl',
      path: repo,
      useWorktrees: true,
      target: { kind: 'wsl', distro },
    }) as unknown as Project;

  it('creates the worktree INSIDE the distro and integrates it back', async ({ skip }) => {
    if (!ready()) return skip();
    const manager = new WorktreeManager('C:\\unused-local-root');
    const task = { id: 't-wsl-1' } as unknown as Task;

    const prep = await manager.prepare(project(), task);
    expect(prep.mode, JSON.stringify(prep)).toBe('worktree');
    if (prep.mode !== 'worktree') return;

    // Sited in the distro's home, with Linux separators — not under Windows userData,
    // and not with a backslash in sight.
    expect(prep.cwd.startsWith('/')).toBe(true);
    expect(prep.cwd).toContain('.local/share/claude-orchestrator/worktrees');
    expect(prep.cwd).not.toContain('\\');
    expect(prep.branch).toBe('orch/t-wsl-1');

    // It really exists on disk — checked from Windows through the UNC view.
    expect(existsSync(host!.toApp(prep.cwd))).toBe(true);

    // Do some work on the branch, then integrate it back into base.
    const write = await host!.exec(prep.cwd, 'sh', ['-c', 'echo branch-work > b.txt']);
    expect(write.code).toBe(0);
    expect(await commitAll(prep.cwd, 'work from the branch', host!)).toBe(true);

    const result = await manager.integrate(
      project(),
      prep.branch,
      prep.base,
      prep.cwd,
      'integrate wsl task',
    );
    expect(result.status, JSON.stringify(result)).toBe('merged');

    // The file landed in the base tree, and the worktree was cleaned up.
    const merged = await host!.exec(repo, 'sh', ['-c', 'cat b.txt']);
    expect(merged.stdout.trim()).toBe('branch-work');
    expect(existsSync(host!.toApp(prep.cwd))).toBe(false);
    expect(base).not.toBe('');
  }, 180_000);

  it('reuses an existing worktree rather than recreating it', async ({ skip }) => {
    if (!ready()) return skip();
    const manager = new WorktreeManager('C:\\unused-local-root');
    const task = { id: 't-wsl-2' } as unknown as Task;

    const first = await manager.prepare(project(), task);
    const second = await manager.prepare(project(), task);
    expect(first.mode).toBe('worktree');
    expect(second.mode).toBe('worktree');
    if (first.mode !== 'worktree' || second.mode !== 'worktree') return;
    expect(second.cwd).toBe(first.cwd);

    await manager.cleanup(project(), task.id);
    expect(existsSync(host!.toApp(first.cwd))).toBe(false);
  }, 180_000);
});
