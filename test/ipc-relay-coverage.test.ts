/**
 * Every channel the engine answers has been classified for relay, and every channel it
 * PUSHES has been classified for fanout — both checked as source text, which is the only way
 * this repo can check either.
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
 *
 * THE SECOND DIRECTION, ADDED BY THE MIRROR ROUND
 * ----------------------------------------------
 * `EVENT_FANOUT` (`packages/shared/src/ipcEventFanout.ts`) is the same shape of table for
 * events travelling the other way, and it has the same strong half and the same weak half.
 * `satisfies { [K in keyof IpcEvents]: … }` makes `pnpm typecheck` refuse an event added to
 * the CONTRACT and left unclassified; nothing typed can see the `send('…')` calls that
 * actually push one, because `send<K extends keyof IpcEvents>` proves the name is in the
 * contract and says nothing about the fanout table.
 *
 * That gap is not hypothetical here in the way it is for invokes. `send` in `ipc.ts` is a
 * SINGLE choke point that hands every event to `CloudEventForwarder.publish`, which asks
 * `isForwarded(channel)` — and `isForwarded` answers `false` for a name it does not know.
 * So a channel missing from the table is not a loud failure: it is an event that silently
 * never reaches a browser, on a wire whose whole purpose is that events reach browsers.
 * The orphan direction matters too, and for the opposite reason — a classification for a
 * channel nothing emits is a decision about nothing, and reads in review as coverage.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RELAY_POLICY } from '@shared/ipcRelay';
import { EVENT_FANOUT, isForwarded } from '@shared/ipcEventFanout';

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

/**
 * The channel of every `send('…')` push in a source file — the event counterpart of
 * {@link registeredChannels}, and the same regex argument.
 *
 * The same leading `(?<![.\w])` does the load-bearing work here: it keeps this off
 * `mainWindow.webContents.send(` (which takes a variable anyway), off a `res.send(` and off
 * the `webContents.send('session:event', …)` written inside `sessionManager.ts`'s header
 * comment. What is left is the local `send` helper, which is the choke point itself.
 */
function pushedChannels(source: string): string[] {
  return [...source.matchAll(/(?<![.\w])send\('([^']+)'/g)].map((m) => m[1]);
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

describe('the event fanout policy', () => {
  const IPC = 'apps/client/src/main/ipc.ts';
  const pushed = pushedChannels(read(IPC));

  /**
   * The one classified channel the desktop is not expected to push, named here rather than
   * excused by a `.filter()` nobody would question.
   *
   * `session:gap` is emitted by the mirrored path only — `CloudEventForwarder` mints it when
   * it sheds, and the browser's receiver mints it from `GapFrame`. An Electron IPC push does
   * not drop events, so there is nothing for `ipc.ts` to say it about, which is exactly what
   * `ipc.ts` says about it. Adding a second name to this list should mean writing a sentence
   * like this one, not deleting a red line.
   */
  const CLASSIFIED_BUT_NEVER_PUSHED = ['session:gap'];

  it('found the pushes to check', () => {
    // Same guard as the handler side, for the same reason: `send` is a local helper and a
    // rename would leave this file passing over an empty list.
    expect(
      pushed.length,
      `found no send('…') pushes in ${IPC} — has the event choke point been renamed?`,
    ).toBeGreaterThan(15);
  });

  it('classifies every event the engine actually pushes', () => {
    const unclassified = [...new Set(pushed)].filter((channel) => !(channel in EVENT_FANOUT));
    expect(
      unclassified,
      `${IPC} pushes ${unclassified.join(', ')}, which packages/shared/src/ipcEventFanout.ts ` +
        'does not classify. `isForwarded` answers false for a name it does not know, so an ' +
        'unclassified channel is not a loud failure — it is an event that silently never ' +
        'reaches a browser, on the wire built so that events reach browsers.',
    ).toEqual([]);
  });

  it('pushes every event it claims to classify, or names the exception', () => {
    const emitted = new Set(pushed);
    const orphans = Object.keys(EVENT_FANOUT).filter(
      (channel) => !emitted.has(channel) && !CLASSIFIED_BUT_NEVER_PUSHED.includes(channel),
    );
    expect(
      orphans,
      `packages/shared/src/ipcEventFanout.ts classifies ${orphans.join(', ')}, which ${IPC} ` +
        'never pushes. Either the channel was renamed on one side only, or the entry outlived ' +
        'the event — and a policy for an event nobody emits reads in review as coverage.',
    ).toEqual([]);
  });

  it('keeps the two tables about two different things', () => {
    // A name in both would mean something is an invoke AND a push, which nothing is. Worth a
    // line because the two records are near-identical in shape and easy to paste between.
    const both = Object.keys(EVENT_FANOUT).filter((channel) => channel in RELAY_POLICY);
    expect(
      both,
      `${both.join(', ')} is classified as BOTH an invoke (ipcRelay.ts) and an event ` +
        '(ipcEventFanout.ts). IpcApi and IpcEvents are disjoint surfaces; a name in both ' +
        'means one of the two tables was filled in by pattern-matching the other.',
    ).toEqual([]);
  });

  it('forwards the pushes that carry something a poll cannot find again', () => {
    // The classification's whole justification, asserted rather than left to the docstring:
    // these three have no read behind them, so a dropped one is gone. `polledEvents.ts` says
    // the same thing about `board:notice` from the other side.
    for (const channel of ['session:event', 'attention:new', 'board:notice']) {
      expect(
        isForwarded(channel),
        `${channel} must be forwarded: nothing a browser can poll reproduces it, so dropping ` +
          'it loses the event itself rather than delaying it.',
      ).toBe(true);
    }
  });
});
