/**
 * Every channel the engine answers has been classified for relay — checked as source text,
 * which is the only way this repo can check it.
 *
 * `RELAY_POLICY` (`packages/shared/src/ipcRelay.ts`) is exhaustive over `keyof IpcApi`, so
 * `pnpm typecheck` already refuses a channel added to the CONTRACT and left unclassified.
 * That is the strong half of the gate and this file does not repeat it.
 *
 * The half a type cannot cover is the other direction: `ipc.ts` registering a `handle()`
 * for a channel, since `handle<K extends keyof IpcApi>` proves the name is in the contract
 * but says nothing about the policy table. In practice the two drift the same way every
 * enumeration drifts — a channel is added to `IpcApi`, `RELAY_POLICY` is filled in with the
 * default `'relay'` to make tsc quiet, and nobody looks at whether it opens a dialog.
 * Listing the handlers here does not decide that either, but it does put every one of them
 * in front of a reviewer in a file whose entire subject is that decision.
 *
 * It lives at the repo root beside `shell-parity.test.ts` for the reason that file gives:
 * the root `vitest.config.ts` sets no `include`, so the default glob collects it, and it
 * reads across two packages that no single package's own vitest run has in scope.
 *
 * Written red-first: confirmed to fail with a `handle()` line deleted from the policy table
 * and with a channel's entry removed, before it was relied on.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RELAY_POLICY } from '@shared/ipcRelay';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

function read(path: string): string {
  return readFileSync(join(repoRoot, ...path.split('/')), 'utf8');
}

/**
 * The channel of every `handle('…')` call in a source file.
 *
 * A regex rather than a parse, exactly as `shell-parity.test.ts` argues: the repo is
 * prettier-formatted, so a registration is `handle('channel', …)` on one line with single
 * quotes, and a real parser would be a dependency bought for one shape of one line. The
 * leading `\b` keeps it off `ipcMain.handle(` inside the helper's own body.
 */
function registeredChannels(source: string): string[] {
  return [...source.matchAll(/(?<![.\w])handle\('([^']+)'/g)].map((m) => m[1]);
}

describe('the relay policy', () => {
  const IPC = 'apps/client/src/main/ipc.ts';
  const channels = registeredChannels(read(IPC));

  it('found the handler registrations to check', () => {
    // A guard over an empty list passes for the wrong reason — if `handle()` is ever
    // renamed or the file moved, that must read as a broken test, not a clean board.
    expect(
      channels.length,
      `found no handle('…') registrations in ${IPC} — has the helper been renamed?`,
    ).toBeGreaterThan(80);
  });

  it('classifies every channel the engine actually answers', () => {
    const unclassified = channels.filter((channel) => !(channel in RELAY_POLICY));
    expect(
      unclassified,
      `${IPC} answers ${unclassified.join(', ')}, which packages/shared/src/ipcRelay.ts does ` +
        'not classify. Every channel is either relayable to a browser or host-only, and an ' +
        'unclassified one relays by omission — which is how a native file dialog ends up ' +
        'opening on a machine nobody is sitting at.',
    ).toEqual([]);
  });

  it('registers a handler for every channel it claims to classify', () => {
    // The other direction: a policy entry for a channel nothing answers is dead weight, and
    // usually the fossil of a channel that was renamed on one side only.
    const answered = new Set(channels);
    const orphans = Object.keys(RELAY_POLICY).filter((channel) => !answered.has(channel));
    expect(
      orphans,
      `packages/shared/src/ipcRelay.ts classifies ${orphans.join(', ')}, which ${IPC} never ` +
        'registers a handler for. Either the channel was renamed on one side only, or the ' +
        'entry outlived the handler.',
    ).toEqual([]);
  });

  it('registers each channel exactly once', () => {
    // Two `handle()` calls for one name is not an error in Electron — the second wins
    // silently — so it is worth one line here.
    const seen = new Set<string>();
    const duplicates = channels.filter((c) => (seen.has(c) ? true : (seen.add(c), false)));
    expect(duplicates, `${IPC} registers ${duplicates.join(', ')} more than once.`).toEqual([]);
  });
});
