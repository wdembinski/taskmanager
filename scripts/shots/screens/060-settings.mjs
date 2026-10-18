/**
 * The Settings tab and its Updates block — see `ui-shots.mjs`'s header doc for the row shape
 * and `scripts/lib/shotModules.mjs` for how this file is merged with its siblings.
 */
export default [
  {
    // The "Settings" tab is NavRail's foot group (apps/client/src/renderer/src/App.tsx).
    name: 'settings',
    app: 'client',
    viewport: { width: 1440, height: 900 },
    scheme: 'light',
    setup: [{ click: 'Settings' }],
    expect: '[aria-label="Settings sections"]',
    mockup: 'v10-19-settings-light.svg',
  },
  {
    // The General pane's Updates block, scrolled to the private-feed token field added on top
    // of it — no mockup draws this state yet, so this reuses the General mockup only for size
    // and chrome, same as the `board-sidebar-folded-*` rows above do with theirs. The fixture's
    // shared `UPDATE_STATE` is `mode: 'off'` (no other row wants an updater to look live), so
    // this row overrides it to `auto` on its own via `channelOverrides` instead. "Clear token"
    // is a disabled button once the token field renders, but `clickText` still scrolls it into
    // view before the (no-op) click, which is all this row needs from it.
    name: 'settings-updates-token',
    app: 'client',
    viewport: { width: 1440, height: 900 },
    scheme: 'light',
    setup: [{ click: 'Settings' }, { click: 'Clear token' }],
    mockup: 'v10-19-settings-light.svg',
    channelOverrides: {
      'update:get': { status: 'idle', mode: 'auto', version: '1.40.0' },
      'update:getTokenStatus': {
        hasToken: false,
        encryptionAvailable: true,
        plainTextStorage: false,
        source: 'none',
      },
    },
  },
];
