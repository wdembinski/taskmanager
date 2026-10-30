/**
 * Builds the `window.api` init-script string for the desktop (`'client'`) target — the one
 * stub `ui-shots.mjs` (step 4) installs before every `'client'` row in its `SCREENS` map,
 * generalizing `shots-board.mjs`'s own `clientInitScript` (board-only) to the full channel set
 * `uiShotsFixture.mjs`'s `BOOT_CHANNELS` enumerates, so a screen that isn't the board — Settings,
 * a card's detail, the palette — boots against the same stub rather than each growing its own
 * copy.
 *
 * `window.api` is also the desktop's `Transport` (`packages/ui/src/transport.tsx`:
 * `<TransportProvider transport={window.api}>`), so this one stub covers both the renderer
 * code that still calls `window.api` directly (`App.tsx`, `MyTasks.tsx`, `Settings.tsx`) and
 * everything under `packages/ui/src` that goes through `useTransport()` instead.
 */

import { taskGetSpec } from './taskBundle.mjs';

/**
 * Serializes `BOOT_CHANNELS` (see `uiShotsFixture.mjs`'s own doc) into the three buckets the
 * in-page script actually switches on: a fixed value per channel, a `{ byArgTable, fallback }`
 * pair for the per-task channels, or membership in the `'list'`/`'null'` fallback buckets.
 *
 * A per-arg spec may also name `argIndex`, the position of the argument it keys on — `0` (the
 * first argument, a task id for every per-task channel) when omitted. `review:subjectFile`
 * (`subjectId, diffId, path`) keys on `path`, so its rows pass `argIndex: 2`.
 */
export function partitionChannels(bootChannels) {
  const fixed = {};
  const byArg = {};
  const listChannels = [];
  const nullChannels = [];
  for (const [channel, spec] of Object.entries(bootChannels)) {
    if (spec === 'list') listChannels.push(channel);
    else if (spec === 'null') nullChannels.push(channel);
    else if (spec && typeof spec === 'object' && spec.byArgTable !== undefined) {
      byArg[channel] = {
        table: spec.byArgTable,
        fallback: spec.fallback,
        argIndex: spec.argIndex ?? 0,
      };
    } else {
      fixed[channel] = spec;
    }
  }
  return { fixed, byArg, listChannels, nullChannels };
}

/**
 * `settings` merges `defaultSettings` (`@tm/shared/settings`'s `DEFAULT_SETTINGS`) under the
 * fixture's own `SETTINGS_OVERRIDES` and this call's `settingsOverrides` — the same three-way
 * merge `shots-board.mjs` already did, pulled out so every screen applies it identically. Board
 * columns are forced to `hiddenColumns: []` (every column visible, Done included — see
 * `boardShotsFixture.mjs`'s own comment on `SETTINGS_OVERRIDES`) unless `settingsOverrides.board`
 * says otherwise.
 *
 * `attachmentUrls` (`id -> url`) backs `window.api.attachmentUrl`, the desktop `Transport`'s
 * optional method (`packages/ui/src/transport.tsx`). A real Electron main process answers
 * every id through its own `vipper-attachment://` scheme (`registerAttachmentProtocol`), which
 * this headless-Chrome tab — never a real Electron process — cannot resolve at all; an id
 * missing from the table returns `undefined` so callers' own `transport.attachmentUrl?.(a) ??
 * attachmentUrl(a.id)` fallback still reaches for that scheme unchanged, the same broken image
 * every row that carries no real fixture bytes already rendered before this existed.
 *
 * `boot` mirrors the preload's synchronous `window.api.boot` (the renderer root seeds its first
 * render from it), built from the same merged `settings` plus `nativeMaterial` — so a shot boots
 * the way the app does, instead of from the root's no-hand-off fallback.
 */
export function buildApiStub({
  defaultSettings,
  fixture,
  settingsOverrides = {},
  attachmentUrls = {},
  nativeMaterial = null,
}) {
  const settings = {
    ...defaultSettings,
    ...fixture.SETTINGS_OVERRIDES,
    ...settingsOverrides,
    board: { ...defaultSettings.board, hiddenColumns: [], ...(settingsOverrides.board ?? {}) },
  };
  const boot = {
    appearance: settings.appearance,
    transparency: settings.transparency,
    fontSizePx: settings.fontSizePx,
    nativeMaterial,
  };

  // `task:get` answers from the same rows `board:tasks` does, unless a row names its own.
  const boardTasks = fixture.BOOT_CHANNELS['board:tasks'];
  const bootChannels =
    fixture.BOOT_CHANNELS['task:get'] === undefined && Array.isArray(boardTasks)
      ? { ...fixture.BOOT_CHANNELS, 'task:get': taskGetSpec(boardTasks) }
      : fixture.BOOT_CHANNELS;
  const { fixed, byArg, listChannels, nullChannels } = partitionChannels(bootChannels);

  return `(function(){
    const SETTINGS = ${JSON.stringify(settings)};
    const FIXED_CHANNELS = ${JSON.stringify(fixed)};
    const BY_ARG_CHANNELS = ${JSON.stringify(byArg)};
    const LIST_CHANNELS = new Set(${JSON.stringify(listChannels)});
    const NULL_CHANNELS = new Set(${JSON.stringify(nullChannels)});
    const ATTACHMENT_URLS = ${JSON.stringify(attachmentUrls)};
    window.api = {
      boot: ${JSON.stringify(boot)},
      invoke(channel, ...args) {
        if (channel === 'settings:get') return Promise.resolve(SETTINGS);
        if (channel === 'settings:save') return Promise.resolve(undefined);
        if (Object.prototype.hasOwnProperty.call(FIXED_CHANNELS, channel)) {
          return Promise.resolve(FIXED_CHANNELS[channel]);
        }
        if (Object.prototype.hasOwnProperty.call(BY_ARG_CHANNELS, channel)) {
          const { table, fallback, argIndex } = BY_ARG_CHANNELS[channel];
          const key = args[argIndex];
          const value = Object.prototype.hasOwnProperty.call(table, key) ? table[key] : fallback;
          return Promise.resolve(value);
        }
        if (LIST_CHANNELS.has(channel)) return Promise.resolve([]);
        if (NULL_CHANNELS.has(channel)) return Promise.resolve(null);
        return Promise.resolve([]);
      },
      on() {
        return () => undefined;
      },
      onNativeMaterialChanged() {
        return () => undefined;
      },
      pathForFile() {
        return '';
      },
      attachmentUrl(attachment) {
        return Object.prototype.hasOwnProperty.call(ATTACHMENT_URLS, attachment.id)
          ? ATTACHMENT_URLS[attachment.id]
          : undefined;
      },
    };
  })();`;
}
