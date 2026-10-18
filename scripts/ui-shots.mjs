/**
 * The mockup → real-UI screen map for "Screenshot the real UI headlessly and attach it next to
 * the mockup for every UI task" (step 1 of 7). This file is ONLY the map for now — later steps
 * in the same plan add the machinery that reads it:
 *
 *   2. extracts the CDP-over-headless-Chrome helpers `scripts/shots-board.mjs` and
 *      `scripts/verify-mobile.mjs` each grew their own copy of into `scripts/lib/cdp.mjs`;
 *   3. builds one seeded fixture and `window.api`/fake-server stub both `app`s can boot against;
 *   4. writes the driver that walks `SCREENS`, runs each row's `setup`, and screenshots it next
 *      to its `mockup` rendered at the same size.
 *
 * Adding a screen later is adding a row here — nothing else should need to change for that.
 *
 * ## Row shape
 *
 * - `name` — the output file stem (`<name>.png`, next to `<name>-mockup.png` once step 4 also
 *   rasterizes `mockup` at the same `viewport`).
 * - `app` — `'client'` boots the Electron desktop renderer (`shots-board.mjs`'s approach);
 *   `'web'` boots `@tm/web` (`verify-mobile.mjs`'s approach). Both are served statically and
 *   driven over CDP — neither ever launches the real Electron app or a real cloud backend.
 * - `viewport` — `{ width, height }` in CSS px. 1440×900 matches every `v9-*`/`v10-*` SVG's own
 *   `viewBox` (verified against the mockup files themselves); 390×844 matches the phone frame
 *   drawn inside `v9-4-mobile-light.svg`/`v9-5-mobile-dark.svg`, not the SVG's own (wider) canvas.
 * - `scheme` — `'light'` or `'dark'`, fed to the same `appearance` setting
 *   `shots-board.mjs`'s `clientInitScript` already threads through.
 * - `setup` — `null` for a screen's resting state, otherwise an ordered list of steps a CDP
 *   driver replays before the shot:
 *     - `{ click: text }` — click the first visible element whose accessible name (text content,
 *       `aria-label`, or `title` — the same three `verify-mobile.mjs`'s `namesOf` checks)
 *       includes `text`.
 *     - `{ key: spec }` — a global shortcut, in `packages/ui/src/palette/shortcut.ts`'s own
 *       `"mod+k"`-style spec.
 * - `mockup` — a filename under `docs/plan/feature-roadmap/mockups/`, or `null` where no mockup
 *   draws this exact state (an approximate stand-in mockup is noted per row below instead).
 *
 * ## Known gap
 *
 * The two `board-sidebar-folded-*` rows below assume the left project-tree `Sidebar`
 * (`packages/ui/src/shell/Sidebar.tsx`) can be collapsed independently of `NavRail`. As of this
 * step, no such toggle exists anywhere in `packages/ui/src/shell` — grepped for `fold`,
 * `collapse`, and `sidebarVisible`/`sidebarOpen` and found none. Their `setup` is left `null`
 * rather than inventing a click target that does not exist; step 4 (or whichever step first
 * wires a real fold control) fills it in once there is something to click.
 */

export const SCREENS = [
  {
    name: 'board-light',
    app: 'client',
    viewport: { width: 1440, height: 900 },
    scheme: 'light',
    setup: null,
    mockup: 'v9-7-board-light.svg',
  },
  {
    name: 'board-dark',
    app: 'client',
    viewport: { width: 1440, height: 900 },
    scheme: 'dark',
    setup: null,
    mockup: 'v9-7b-board-dark.svg',
  },
  {
    // No mockup draws a folded sidebar with the detail panel open — v9-7-board-light.svg is the
    // nearest available (sidebar open, no detail panel), kept only as an orientation reference.
    name: 'board-sidebar-folded-detail-open',
    app: 'client',
    viewport: { width: 1440, height: 900 },
    scheme: 'light',
    setup: null,
    mockup: 'v9-7-board-light.svg',
  },
  {
    // Same state as above, narrowed to check it still holds together at a smaller viewport — no
    // mockup was ever drawn at this size, so there is nothing to compare against.
    name: 'board-sidebar-folded-detail-open-1100x800',
    app: 'client',
    viewport: { width: 1100, height: 800 },
    scheme: 'light',
    setup: null,
    mockup: null,
  },
  {
    name: 'issue-list-light',
    app: 'client',
    viewport: { width: 1440, height: 900 },
    scheme: 'light',
    setup: null,
    mockup: 'v9-1-issues-list-light.svg',
  },
  {
    name: 'issue-list-dark',
    app: 'client',
    viewport: { width: 1440, height: 900 },
    scheme: 'dark',
    setup: null,
    mockup: 'v9-3-issues-list-dark.svg',
  },
  {
    // `IssueViewLayout` (packages/ui/src/issues/issueView.ts) opens 'closed' -> 'peek' on the
    // first click of an issue row; which row is fixture-specific, so step 3/4 resolve the exact
    // text once the shared fixture exists rather than guessing a title here.
    name: 'issue-peek',
    app: 'client',
    viewport: { width: 1440, height: 900 },
    scheme: 'light',
    setup: [{ click: 'issue-row:first' }],
    mockup: 'v9-2-issue-detail-light.svg',
  },
  {
    // From peek, "Open full screen" (IssueViewPanes.tsx) drives the same reducer to 'full'.
    name: 'issue-full-screen',
    app: 'client',
    viewport: { width: 1440, height: 900 },
    scheme: 'light',
    setup: [{ click: 'issue-row:first' }, { click: 'Open full screen' }],
    mockup: 'v9-2-issue-detail-light.svg',
  },
  {
    // The "Settings" tab is NavRail's foot group (apps/client/src/renderer/src/App.tsx).
    name: 'settings',
    app: 'client',
    viewport: { width: 1440, height: 900 },
    scheme: 'light',
    setup: [{ click: 'Settings' }],
    mockup: 'v10-19-settings-light.svg',
  },
  {
    // `useGlobalShortcut('mod+k', ...)` in App.tsx opens CommandPalette.
    name: 'palette',
    app: 'client',
    viewport: { width: 1440, height: 900 },
    scheme: 'light',
    setup: [{ key: 'mod+k' }],
    mockup: 'v10-20-palette-light.svg',
  },
  {
    // The web mirrors the desktop's own Tickets screen (see `web-mirrors-the-desktop` plan
    // notes) — same mockup as `issue-list-light`, no separate "web board" mockup exists.
    name: 'web-desktop',
    app: 'web',
    viewport: { width: 1440, height: 900 },
    scheme: 'light',
    setup: null,
    mockup: 'v9-1-issues-list-light.svg',
  },
  {
    // 390x844 matches the phone frame drawn inside v9-4-mobile-light.svg/v9-5-mobile-dark.svg,
    // not that SVG's own 1330x940 canvas — see verify-mobile.mjs's own SIZES for the closest
    // real device sizes this repo already drives (375x667, 414x896); 390x844 is the mockup's.
    name: 'web-phone-light',
    app: 'web',
    viewport: { width: 390, height: 844 },
    scheme: 'light',
    setup: null,
    mockup: 'v9-4-mobile-light.svg',
  },
  {
    name: 'web-phone-dark',
    app: 'web',
    viewport: { width: 390, height: 844 },
    scheme: 'dark',
    setup: null,
    mockup: 'v9-5-mobile-dark.svg',
  },
];
