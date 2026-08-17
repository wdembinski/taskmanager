/**
 * Repository-level invariants — the facts about the repo's SHAPE that no other test owns.
 *
 * There are two, and both are about the version: WHERE it lives, and — added afterwards —
 * which one the web client DISPLAYS.
 *
 * The first. The monorepo split (v0.78.7) made
 * the root `package.json` the workspace manifest — renamed `taskmanager`, pinned at `0.0.0` —
 * and moved the version of record to `apps/client/package.json` (CONTRIBUTING.md §4). Nothing
 * in the repo asserted that. `check:abi` and `check:feed` are the only `check:*` scripts and
 * neither reads a version, there is no git hook, and a `--noEmit` typecheck cannot see a
 * number in a JSON file. So a branch cut before the split kept bumping the root manifest and
 * the mistake only surfaced as a rebase conflict at integration time, one commit at a time.
 *
 * This file lives at the repo root because the root `vitest.config.ts` sets no `include`, so
 * vitest's default glob collects it — which puts the guard inside `pnpm test`, and `pnpm test`
 * is on every gate anyone actually runs (CONTRIBUTING.md §5, RELEASE.md §1). A `check:version`
 * script would have needed someone to remember to call it.
 *
 * Deliberately silent about what the other workspaces' manifests SAY. `packages/protocol`,
 * `packages/shared`, `packages/ui` and `apps/server` were frozen at their split-time versions
 * and are NOT the version of record; asserting anything about them would turn an intentional
 * non-decision into a rule.
 *
 * The second invariant is the cost of that non-decision, found the hard way. A frozen version
 * is harmless right up until something DISPLAYS it, and apps/web did: its Vite config baked
 * its own `package.json` version into the bundle for the status bar, under a comment claiming
 * that manifest was "the same package.json the release bumps". So the browser client said
 * v0.78.2 for eight releases while the desktop shipped v0.86.0. Freezing a version and
 * showing it are each defensible; together they are a number that cannot ever be right.
 *
 * Hence the group below, which asserts the wiring end to end — it reads what the config
 * actually bakes rather than what its comment says — and hence apps/web's own manifest now
 * reading `0.0.0`, the same placeholder the root uses for the same reason: a version nobody
 * maintains should not look like one. What reaches a browser is a separate question, owned
 * by `.github/workflows/deploy.yml`'s web filter and asserted in workflow-invariants.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The repo root, derived from this file rather than from cwd, so the run directory is free. */
const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

function manifest(...segments: string[]): { name?: string; version?: string } {
  return JSON.parse(readFileSync(join(repoRoot, ...segments), 'utf8'));
}

describe('the version of record (CONTRIBUTING.md §4)', () => {
  it('keeps the root package.json a workspace manifest, never a released version', () => {
    const root = manifest('package.json');

    expect(
      root.name,
      'The root package.json is the workspace manifest and is named "taskmanager". If this ' +
        'says "claude-orchestrator", a commit written before the monorepo split has been ' +
        'replayed over the root manifest — see CONTRIBUTING.md §4.',
    ).toBe('taskmanager');

    expect(
      root.version,
      'The root package.json stays at 0.0.0 and is NEVER bumped (CONTRIBUTING.md §4). A ' +
        'version here means a bump landed on the wrong file: move it to ' +
        'apps/client/package.json.',
    ).toBe('0.0.0');
  });

  it('keeps the version of record in apps/client/package.json', () => {
    const client = manifest('apps', 'client', 'package.json');

    expect(
      client.name,
      'apps/client is the Electron app and is named "claude-orchestrator" — the installer, ' +
        'the update feed and the release tag all derive from this manifest.',
    ).toBe('claude-orchestrator');

    expect(
      client.version,
      'apps/client/package.json version IS the release (CONTRIBUTING.md §4) and must be a ' +
        'bare X.Y.Z — no "v" prefix, no pre-release suffix, since the tag name is derived ' +
        `from it. Found: ${String(client.version)}`,
    ).toMatch(/^\d+\.\d+\.\d+$/);

    expect(
      client.version,
      'apps/client/package.json version is 0.0.0, which is the workspace-manifest placeholder. ' +
        'The version of record cannot be a placeholder — see CONTRIBUTING.md §4.',
    ).not.toBe('0.0.0');
  });
});

describe('the version the web client displays', () => {
  /**
   * The web's Vite config, imported rather than read as text: `defineConfig` hands an object
   * config straight back, so `define` here is exactly the substitution the bundle gets. A
   * regex over the file would pass on a config whose comment says the right thing and whose
   * `readFileSync` points at the wrong manifest, which is the bug this group is about.
   */
  async function webDefines(): Promise<Record<string, string>> {
    const config = (await import('../apps/web/vite.config')).default as {
      define?: Record<string, string>;
    };

    expect(
      config.define?.__APP_VERSION__,
      "apps/web/vite.config.ts no longer defines __APP_VERSION__. The status bar reads it " +
        '(apps/web/src/App.tsx) and an undefined global there is a bundle that fails to ' +
        'build — if the version moved somewhere else, move this group with it.',
    ).toBeDefined();

    return config.define as Record<string, string>;
  }

  it('bakes the version of record, not apps/web own manifest version', async () => {
    const client = manifest('apps', 'client', 'package.json');

    expect(
      (await webDefines()).__APP_VERSION__,
      'The web bundle bakes a version that is not apps/client/package.json\'s. That manifest ' +
        'is the only version anything releases (CONTRIBUTING.md §4); every other one in this ' +
        'repo is frozen at its split-time value, so baking one of those ships a status bar ' +
        'that says the same wrong number for ever. It said v0.78.2 through v0.86.0 this way.',
    ).toBe(JSON.stringify(client.version));
  });

  it('keeps apps/web own version a placeholder, so nothing can display it', () => {
    expect(
      manifest('apps', 'web', 'package.json').version,
      'apps/web/package.json has a version that looks real again. Nothing bumps it — the ' +
        'release bumps apps/client alone — so a number here is one that drifts silently and ' +
        'invites exactly the wiring the test above forbids. It stays 0.0.0, like the root ' +
        'workspace manifest.',
    ).toBe('0.0.0');
  });
});
