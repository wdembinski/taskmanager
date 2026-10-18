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

/**
 * Serializes `BOOT_CHANNELS` (see `uiShotsFixture.mjs`'s own doc) into the three buckets the
 * in-page script actually switches on: a fixed value per channel, a `{ byArgTable, fallback }`
 * pair for the per-task channels, or membership in the `'list'`/`'null'` fallback buckets.
 */
function partitionChannels(bootChannels) {
  const fixed = {};
  const byArg = {};
  const listChannels = [];
  const nullChannels = [];
  for (const [channel, spec] of Object.entries(bootChannels)) {
    if (spec === 'list') listChannels.push(channel);
    else if (spec === 'null') nullChannels.push(channel);
    else if (spec && typeof spec === 'object' && spec.byArgTable !== undefined) {
      byArg[channel] = { table: spec.byArgTable, fallback: spec.fallback };
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
 */
export function buildApiStub({ defaultSettings, fixture, settingsOverrides = {} }) {
  const settings = {
    ...defaultSettings,
    ...fixture.SETTINGS_OVERRIDES,
    ...settingsOverrides,
    board: { ...defaultSettings.board, hiddenColumns: [], ...(settingsOverrides.board ?? {}) },
  };

  const { fixed, byArg, listChannels, nullChannels } = partitionChannels(fixture.BOOT_CHANNELS);

  return `(function(){
    const SETTINGS = ${JSON.stringify(settings)};
    const FIXED_CHANNELS = ${JSON.stringify(fixed)};
    const BY_ARG_CHANNELS = ${JSON.stringify(byArg)};
    const LIST_CHANNELS = new Set(${JSON.stringify(listChannels)});
    const NULL_CHANNELS = new Set(${JSON.stringify(nullChannels)});
    window.api = {
      invoke(channel, ...args) {
        if (channel === 'settings:get') return Promise.resolve(SETTINGS);
        if (channel === 'settings:save') return Promise.resolve(undefined);
        if (Object.prototype.hasOwnProperty.call(FIXED_CHANNELS, channel)) {
          return Promise.resolve(FIXED_CHANNELS[channel]);
        }
        if (Object.prototype.hasOwnProperty.call(BY_ARG_CHANNELS, channel)) {
          const { table, fallback } = BY_ARG_CHANNELS[channel];
          const key = args[0];
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
      pathForFile() {
        return '';
      },
    };
  })();`;
}
