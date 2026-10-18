/**
 * Screenshots the real UI headlessly and attaches it next to the mockup, for every row in
 * `SCREENS` below — the driver "Screenshot the real UI headlessly and attach it next to the
 * mockup for every UI task" plan's step 4 adds on top of its first three steps: the CDP-over-
 * headless-Chrome helpers (`scripts/lib/cdp.mjs`), the one seeded fixture and `window.api`/
 * fake-relay stub both `app`s boot against (`scripts/fixtures/uiShotsFixture.mjs`,
 * `scripts/lib/apiStub.mjs`, `scripts/lib/fakeRelay.mjs`), and this map.
 *
 *     node scripts/ui-shots.mjs [--out dir] [--only name,…] [--attach]
 *
 * `--out` defaults to `.vipper/shots` (see `.gitignore`'s own comment on `.vipper/`) and holds,
 * per row: `<name>.png` (the real screenshot), `<name>-mockup.png` (the mockup rasterized at the
 * same size, when `mockup` is set), `<name>.html` (the two side by side), plus one `index.html`
 * contact sheet linking all of them. `--only` restricts the run to a comma-separated subset of
 * `SCREENS`' own `name`s — and skips building whichever `app` no selected row needs. `--attach`
 * additionally copies the whole `--out` directory into `<cwd>/.vipper/attach/` — the outbox the
 * plan's step 5 ingests once a run settles.
 *
 * Exits 1 if any row threw (a failed build, a setup step that never found its target, a timed-
 * out wait) or logged an uncaught page exception — never silently drops a row and calls the run
 * green.
 *
 * Adding a screen is adding a row to `SCREENS` — nothing else here should need to change for
 * that.
 *
 * ## Row shape
 *
 * - `name` — the output file stem (`<name>.png`, next to `<name>-mockup.png` once `mockup` is
 *   rasterized at the same `viewport`).
 * - `app` — `'client'` boots the Electron desktop renderer (`shots-board.mjs`'s approach);
 *   `'web'` boots `@tm/web` (`verify-mobile.mjs`'s approach). Both are served statically and
 *   driven over CDP — neither ever launches the real Electron app or a real cloud backend.
 * - `viewport` — `{ width, height }` in CSS px. 1440×900 matches every `v9-*`/`v10-*` SVG's own
 *   `viewBox` (verified against the mockup files themselves); 390×844 matches the phone frame
 *   drawn inside `v9-4-mobile-light.svg`/`v9-5-mobile-dark.svg`, not the SVG's own (wider) canvas.
 * - `scheme` — `'light'` or `'dark'`, fed to the same `appearance` setting
 *   `shots-board.mjs`'s `clientInitScript` already threads through.
 * - `setup` — `null` for a screen's resting state, otherwise an ordered list of steps the driver
 *   replays before the shot:
 *     - `{ click: text }` — click the first visible element whose accessible name (text content,
 *       `aria-label`, or `title` — the same three `verify-mobile.mjs`'s `namesOf` checks)
 *       includes `text`. One sentinel, `'issue-row:first'` (or `'issue-row:N'`), clicks the Nth
 *       `[role="option"]` row instead — `IssueRow.tsx`'s rows carry no stable accessible name of
 *       their own (just the fixture's own task title, which a screen map row should not have to
 *       know), so "click a row" is addressed by position, the same way a human would point at
 *       "the first one" without reading its title either. A second sentinel, `'board-card:ID'`,
 *       clicks `TaskCard.tsx`'s own `[data-task-id="ID"]` root directly — plain text matching
 *       would otherwise land on its hidden chain-link handle first (`aria-label="Chain from
 *       {title} — …"` also *contains* the card's title, and that handle renders before the
 *       card's own text in document order), so a card is addressed by its fixture id instead of
 *       its title, the same reasoning as `issue-row:N`'s own position-not-text sentinel.
 *     - `{ key: spec }` — dispatches a bubbling `keydown` on `document.activeElement` (or
 *       `document.body`), parsed the same `"mod+k"`/`"shift+mod+k"` way
 *       `packages/ui/src/palette/shortcut.ts`'s own spec is, plus the named keys `space`,
 *       `enter`, `escape`/`esc`, and `tab`. Exercises any `window`-level shortcut
 *       (`useGlobalShortcut`, e.g. `mod+k`) correctly regardless of focus; a handler scoped to
 *       one element's own React `onKeyDown` (e.g. `Projects.tsx`'s Space-for-peek) only fires if
 *       that element already has focus — true after a real click, not guaranteed after this
 *       driver's own synthetic `.click()`. No row below needs the latter yet.
 *     - `{ scroll: 'sidebar-bottom' }` — scrolls the sidebar's own scrollable region (the one
 *       `overflowY: auto` child of `nav[aria-label="Sidebar"]`) to its bottom, so a folded tail
 *       below the fold (a fully-done milestone sorted last) is actually in frame for the shot.
 * - `mockup` — a filename under `docs/plan/feature-roadmap/mockups/`, or `null` where no mockup
 *   draws this exact state (an approximate stand-in mockup is noted per row below instead).
 * - `clip` — `'sidebar'` crops the capture to `nav[aria-label="Sidebar"]`'s own bounding rect
 *   instead of the whole viewport, so the row shoots the tree on its own rather than whatever
 *   else happens to share the window. Omit it to capture the full viewport, same as before.
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
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApiStub } from './lib/apiStub.mjs';
import {
  collectExceptions,
  connectCdp,
  emulateScheme,
  evaluate,
  findBrowser,
  freshLoad,
  getFreePort,
  killBrowser,
  launchChrome,
  openTab,
  renderSvgToPng,
  screenshot,
  setViewport,
  startStaticServer,
  waitFor,
} from './lib/cdp.mjs';
import { startFakeRelay } from './lib/fakeRelay.mjs';
import * as uiShotsFixture from './fixtures/uiShotsFixture.mjs';

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
    // Frames the milestone/epic/ticket tree on its own (`clip: 'sidebar'`), scrolled to its
    // bottom so the folded-by-default tail (a fully-done milestone, an epic whose tickets are
    // all done, a milestone with no open work of its own) is actually in frame rather than
    // scrolled past — `board-light`/`-dark` happen to show the same sidebar unscrolled, which
    // is why these two used to come out byte-identical to them before this row had its own
    // `setup`/`clip`. No mockup draws the tree's folded/status-glyph states on their own, so
    // `board-light`'s own reference is the nearest available.
    name: 'sidebar-tree-light',
    app: 'client',
    viewport: { width: 1440, height: 900 },
    scheme: 'light',
    setup: [{ scroll: 'sidebar-bottom' }],
    clip: 'sidebar',
    mockup: 'v9-7-board-light.svg',
  },
  {
    name: 'sidebar-tree-dark',
    app: 'client',
    viewport: { width: 1440, height: 900 },
    scheme: 'dark',
    setup: [{ scroll: 'sidebar-bottom' }],
    clip: 'sidebar',
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
    // The desktop's own default tab is `'mytasks'` (the Board, `App.tsx`'s own
    // `useState<TabId>('mytasks')`) — every row below that wants the Tickets screen instead
    // (`shellNav.ts`'s `{ id: 'tickets', label: 'Tickets' }`) has to click there first; driving
    // this row with `setup: null` landed on the Board and found no issue rows to screenshot,
    // which is how this got caught.
    name: 'issue-list-light',
    app: 'client',
    viewport: { width: 1440, height: 900 },
    scheme: 'light',
    setup: [{ click: 'Tickets' }],
    mockup: 'v9-1-issues-list-light.svg',
  },
  {
    name: 'issue-list-dark',
    app: 'client',
    viewport: { width: 1440, height: 900 },
    scheme: 'dark',
    setup: [{ click: 'Tickets' }],
    mockup: 'v9-3-issues-list-dark.svg',
  },
  {
    // `IssueViewLayout` (packages/ui/src/issues/issueView.ts) opens 'closed' -> 'peek' on the
    // first click of an issue row — addressed by position (`'issue-row:first'`), not by the
    // fixture's own title text; see `SCREENS`' own doc comment on that sentinel.
    name: 'issue-peek',
    app: 'client',
    viewport: { width: 1440, height: 900 },
    scheme: 'light',
    setup: [{ click: 'Tickets' }, { click: 'issue-row:first' }],
    mockup: 'v9-2-issue-detail-light.svg',
  },
  {
    // From peek, "Open full screen" (IssueViewPanes.tsx) drives the same reducer to 'full'.
    name: 'issue-full-screen',
    app: 'client',
    viewport: { width: 1440, height: 900 },
    scheme: 'light',
    setup: [{ click: 'Tickets' }, { click: 'issue-row:first' }, { click: 'Open full screen' }],
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
  {
    // `useGlobalShortcut('mod+k', ...)` in App.tsx opens CommandPalette. Selecting a card first
    // (`board-card:1`, `boardShotsFixture.mjs`'s `plainBacklog` — the default board's first
    // Backlog card, ticketKey `FX-1`) sets `selectedTaskId`, so the palette's context chip ("on
    // FX-1") renders, matching the mockup.
    name: 'palette',
    app: 'client',
    viewport: { width: 1440, height: 900 },
    scheme: 'light',
    setup: [{ click: 'board-card:1' }, { key: 'mod+k' }],
    mockup: 'v10-20-palette-light.svg',
  },
  {
    // Sidebar's own "Archived" row (`Sidebar.tsx`) lands directly on the Archived view
    // (F14.8) from wherever the app was — `App.tsx`'s own `handleSidebarNavigate` sets both
    // the tab and `ticketsView` together, so this needs no separate "Tickets" click first,
    // unlike `issue-list-light`'s own `'Tickets'` setup.
    name: 'archived-light',
    app: 'client',
    viewport: { width: 1440, height: 900 },
    scheme: 'light',
    setup: [{ click: 'Archived' }],
    mockup: 'v10-21-archived-light.svg',
  },
  {
    // The ticket panel's own restore banner (F14.9) — opens one of the Archived view's own
    // seeded tickets (`uiShotsFixture.mjs`'s `ARCHIVED_MILESTONE_TICKETS`, filed under
    // `ARCHIVED_MILESTONES`) by expanding its milestone row and clicking the ticket, the
    // same two steps a human would take. No mockup draws this exact bar — `v10-21-archived
    // -light.svg` is the nearest (same screen, before the ticket is opened), needing human
    // visual sign-off rather than a pixel diff.
    name: 'ticket-archived-banner',
    app: 'client',
    viewport: { width: 1440, height: 900 },
    scheme: 'light',
    setup: [{ click: 'Archived' }, { click: 'Expand' }, { click: 'issue-row:first' }],
    mockup: 'v10-21-archived-light.svg',
  },
  {
    // The web mirrors the desktop's own Tickets screen (see `web-mirrors-the-desktop` plan
    // notes) — same mockup as `issue-list-light`, no separate "web board" mockup exists. Both
    // hosts default to the Board (`apps/web/src/App.tsx`'s `useState<Screen>('mytasks')`,
    // `apps/client`'s own `useState<TabId>('mytasks')`), so this needs the same "Tickets" click
    // `issue-list-light` does.
    name: 'web-desktop',
    app: 'web',
    viewport: { width: 1440, height: 900 },
    scheme: 'light',
    setup: [{ click: 'Tickets' }],
    mockup: 'v9-1-issues-list-light.svg',
  },
  {
    // The web shell wires the same sidebar "Archived" row onto the same `ArchivedPane`
    // (`apps/web/src/App.tsx`'s own `handleSidebarNavigate`'s `'archived'` case) — no separate
    // mockup of its own, reusing `archived-light`'s.
    name: 'web-archived',
    app: 'web',
    viewport: { width: 1440, height: 900 },
    scheme: 'light',
    setup: [{ click: 'Archived' }],
    mockup: 'v10-21-archived-light.svg',
  },
  {
    // Same Tickets screen as `web-desktop`, one issue row deeper — the Projects pane's web
    // notice (F12.10) lives on this peek, not on the bare list.
    name: 'web-issue-peek',
    app: 'web',
    viewport: { width: 1440, height: 900 },
    scheme: 'light',
    setup: [{ click: 'Tickets' }, { click: 'issue-row:first' }],
    mockup: 'v9-2-issue-detail-light.svg',
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

// ── CLI ───────────────────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const opts = { out: null, only: null, attach: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--out') opts.out = argv[++i];
    else if (arg === '--only') {
      opts.only = argv[++i]
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    } else if (arg === '--attach') opts.attach = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return opts;
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const mockupsDir = join(root, 'docs', 'plan', 'feature-roadmap', 'mockups');

// ── Page helpers injected into every row's init script ──────────────────────────────────────

/**
 * `window.__tm.clickText`/`findByText`, copied from `verify-mobile.mjs`'s own `PAGE_HELPERS_SRC`
 * rather than imported — that file keeps its copy private (it is a `*.mjs` script, not a
 * module either side imports), and the two have drifted apart before (`verify-mobile.mjs` also
 * tracks touch-target size, which this driver has no use for).
 */
const PAGE_HELPERS_SRC = `
window.__tm = {
  visible(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && !!el.offsetParent;
  },
  candidates() {
    return Array.from(document.querySelectorAll('button, [role="menuitem"], [role="tab"]'));
  },
  textOf(el) {
    const clone = el.cloneNode(true);
    clone.querySelectorAll('.fui-Tab__content--reserved-space').forEach((n) => n.remove());
    return (clone.textContent || '').trim();
  },
  namesOf(el) {
    return [this.textOf(el), el.getAttribute('aria-label') || '', el.getAttribute('title') || ''];
  },
  findByText(text, exact) {
    return this.candidates().find((el) => {
      if (!this.visible(el)) return false;
      return this.namesOf(el).some((t) => (exact ? t === text : t.includes(text)));
    });
  },
  clickText(text, exact) {
    const el = this.findByText(text, exact);
    if (!el) return false;
    el.scrollIntoView({ block: 'center' });
    el.click();
    return true;
  },
};
`;

/**
 * The `'client'` target's `window.api` stub, built from `uiShotsFixture.mjs`'s `BOOT_CHANNELS`
 * (`apiStub.mjs`'s own job) — `settingsOverrides.appearance` is `row.scheme` so the resolved
 * theme does not depend on `emulateScheme` racing React's first paint, same as
 * `shots-board.mjs`'s own `clientInitScript({ appearance, … })`.
 *
 * `row.channelOverrides` layers a few per-row answers over the shared fixture's own
 * `BOOT_CHANNELS` — for the one screen that needs to see a state the other rows must NOT
 * (e.g. the updater's `auto` mode, to show the private-feed token field), rather than mutating
 * the fixture module's exports for every row that happens to run afterward.
 */
function clientInitScript(defaultSettings, row) {
  const fixture = row.channelOverrides
    ? {
        ...uiShotsFixture,
        BOOT_CHANNELS: { ...uiShotsFixture.BOOT_CHANNELS, ...row.channelOverrides },
      }
    : uiShotsFixture;
  const stub = buildApiStub({
    defaultSettings,
    fixture,
    settingsOverrides: { appearance: row.scheme, transparency: 'reduced', fontSizePx: 14 },
  });
  return `${PAGE_HELPERS_SRC}\n${stub}`;
}

/**
 * The `'web'` target's init script — seeds the signed-in `localStorage` keys
 * `verify-mobile.mjs`'s own `buildInitScript` seeds (a bare refresh token alone models a
 * brand-new, never-synced browser; every `SCREENS` row wants a returning, already-paired one).
 * `appearance` is NOT threaded through here: `GET /v1/settings` answers from `relayState
 * .settings`, which the caller mutates per row (see `main`) since one relay process serves
 * every `'web'` row — `emulateScheme` is this target's only lever on light vs dark, so it is
 * not skippable here the way it is for `'client'`.
 */
function webInitScript(desktopClientId) {
  return `(function(){
    if (location.protocol === 'about:') return;
    ${PAGE_HELPERS_SRC}
    localStorage.setItem('tm.cloud.refreshToken', 'ui-shots-refresh-token');
    localStorage.setItem('tm.cloud.lastKnownDesktopClientId', ${JSON.stringify(desktopClientId)});
  })();`;
}

// ── Driving a row's `setup` ──────────────────────────────────────────────────────────────────

/** Maps a `{ key: spec }` row's `"mod+k"`-style spec onto the `KeyboardEvent` fields to
 *  dispatch — see `packages/ui/src/palette/shortcut.ts`'s own header for the `+`-joined
 *  modifier grammar this mirrors (`mod` means "Ctrl or Meta"; this driver always runs Chrome
 *  on a non-Mac CI/dev box, so `mod` dispatches as `ctrlKey`, never `metaKey`). */
function parseKeySpec(spec) {
  const KEY_NAMES = { space: ' ', enter: 'Enter', escape: 'Escape', esc: 'Escape', tab: 'Tab' };
  const parts = spec.toLowerCase().split('+');
  const keyToken = parts[parts.length - 1];
  const modifiers = new Set(parts.slice(0, -1));
  return {
    key: KEY_NAMES[keyToken] ?? keyToken,
    ctrlKey: modifiers.has('mod') || modifiers.has('ctrl'),
    metaKey: modifiers.has('meta'),
    shiftKey: modifiers.has('shift'),
    altKey: modifiers.has('alt'),
  };
}

/** `{ click: 'issue-row:first' }` (or `'issue-row:N'`) — see `SCREENS`' own doc comment on why
 *  a row is addressed by position instead of by text. Returns the `window.__tm.clickText`-style
 *  JS expression and the "has it appeared yet" check `runSetupStep` waits on before clicking. */
function issueRowClickExprs(index) {
  return {
    ready: `document.querySelectorAll('[role="option"]').length > ${index}`,
    click: `(() => {
      const el = document.querySelectorAll('[role="option"]')[${index}];
      if (!el) return false;
      el.scrollIntoView({ block: 'center' });
      el.click();
      return true;
    })()`,
  };
}

/** `{ click: 'board-card:ID' }` — see `SCREENS`' own doc comment on why a board card is
 *  addressed by `TaskCard.tsx`'s own `[data-task-id]`, not by its title text. */
function boardCardClickExprs(taskId) {
  const selector = JSON.stringify(`[data-task-id=${JSON.stringify(taskId)}]`);
  return {
    ready: `!!document.querySelector(${selector})`,
    click: `(() => {
      const el = document.querySelector(${selector});
      if (!el) return false;
      el.scrollIntoView({ block: 'center' });
      el.click();
      return true;
    })()`,
  };
}

async function runSetupStep(cdp, step) {
  if (step.click !== undefined) {
    const issueRow = /^issue-row:(first|\d+)$/.exec(step.click);
    const boardCard = /^board-card:(.+)$/.exec(step.click);
    const { ready, click } = issueRow
      ? issueRowClickExprs(issueRow[1] === 'first' ? 0 : Number(issueRow[1]))
      : boardCard
        ? boardCardClickExprs(boardCard[1])
        : {
            ready: `!!window.__tm.findByText(${JSON.stringify(step.click)}, false)`,
            click: `window.__tm.clickText(${JSON.stringify(step.click)}, false)`,
          };
    await waitFor(async () => (await evaluate(cdp, ready)) === true, {
      timeoutMs: 10000,
      label: `"${step.click}" to appear`,
    });
    const clicked = await evaluate(cdp, click);
    if (!clicked) throw new Error(`could not click "${step.click}"`);
    return;
  }
  if (step.key !== undefined) {
    const { key, ctrlKey, metaKey, shiftKey, altKey } = parseKeySpec(step.key);
    await evaluate(
      cdp,
      `(() => {
        const target = document.activeElement || document.body;
        target.dispatchEvent(new KeyboardEvent('keydown', {
          key: ${JSON.stringify(key)}, ctrlKey: ${ctrlKey}, metaKey: ${metaKey},
          shiftKey: ${shiftKey}, altKey: ${altKey}, bubbles: true, cancelable: true,
        }));
      })()`,
    );
    return;
  }
  if (step.scroll === 'sidebar-bottom') {
    // The sidebar (`Sidebar.tsx`) has no stable hook of its own for the one div that actually
    // scrolls (`styles.scroll` — Griffel hashes the class) — found instead by its own computed
    // style, the same way the tree's own scrollable region is the only `overflowY: auto` child
    // of `nav[aria-label="Sidebar"]`.
    const scrolled = await evaluate(
      cdp,
      `(() => {
        const nav = document.querySelector('nav[aria-label="Sidebar"]');
        if (!nav) return false;
        const scroller = Array.from(nav.children).find(
          (el) => getComputedStyle(el).overflowY === 'auto',
        );
        if (!scroller) return false;
        scroller.scrollTop = scroller.scrollHeight;
        return true;
      })()`,
    );
    if (!scrolled) throw new Error('could not find the sidebar\'s own scroll region');
    return;
  }
  throw new Error(`unknown setup step: ${JSON.stringify(step)}`);
}

/** `nav[aria-label="Sidebar"]`'s own bounding rect, in CSS px — `screenshot`'s `clip` crops to
 *  exactly this when a row's `clip` is `'sidebar'`, so the shot is the tree on its own rather
 *  than the whole viewport the sidebar happens to sit in. */
async function sidebarClipRect(cdp) {
  const rect = await evaluate(
    cdp,
    `(() => {
      const nav = document.querySelector('nav[aria-label="Sidebar"]');
      if (!nav) return null;
      const r = nav.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    })()`,
  );
  if (!rect) throw new Error('could not find nav[aria-label="Sidebar"] to clip the shot to');
  return rect;
}

/** Fluent's `Skeleton`/`Spinner` are the only loading affordance anything in `packages/ui/src`
 *  draws (see `PaneLoading.tsx`) — gone means the fixture's own promises (already resolved by
 *  the time this is first checked) have painted, not that some unrelated screen is still busy. */
async function waitForIdle(cdp) {
  await waitFor(
    async () =>
      (await evaluate(
        cdp,
        `document.querySelectorAll('[class*="fui-Skeleton"], [class*="fui-Spinner"]').length`,
      )) === 0,
    { timeoutMs: 15000, label: 'loading skeleton/spinner to clear' },
  );
  // A fixed settle beat on top of "no skeleton" — Fluent's own open/close transitions (the
  // palette's dialog, the peek pane) run past the frame where the content they animate in is
  // already in the DOM.
  await new Promise((r) => setTimeout(r, 250));
}

// ── Building each target fresh, against this step's own sources ────────────────────────────

/** `shots-board.mjs`'s own `buildClientRenderer`, generalized to a caller-supplied `outDir`. */
function buildClientRenderer(requireFromClient, outDir) {
  const electronViteBin = join(
    dirname(requireFromClient.resolve('electron-vite/package.json')),
    'bin',
    'electron-vite.js',
  );
  const res = spawnSync(process.execPath, [electronViteBin, 'build', '--outDir', outDir], {
    cwd: join(root, 'apps', 'client'),
    stdio: 'inherit',
  });
  if (res.status !== 0) throw new Error('electron-vite build failed for @tm/client');
}

/** `verify-mobile.mjs`'s own `buildWeb`, generalized to a caller-supplied `outDir`. */
function buildWeb(requireFromWeb, outDir, apiBase, iamIssuer) {
  const viteBin = join(dirname(requireFromWeb.resolve('vite/package.json')), 'bin', 'vite.js');
  const res = spawnSync(process.execPath, [viteBin, 'build', '--outDir', outDir, '--emptyOutDir'], {
    cwd: join(root, 'apps', 'web'),
    env: {
      ...process.env,
      VITE_CLOUD_API_BASE: apiBase,
      VITE_CLOUD_IAM_ISSUER: iamIssuer,
      VITE_CLOUD_IAM_CLIENT_ID: 'tm-ui-shots',
    },
    stdio: 'inherit',
  });
  if (res.status !== 0) throw new Error('vite build failed for @tm/web');
}

// ── Contact sheet ─────────────────────────────────────────────────────────────────────────

function escapeHtml(s) {
  return s.replace(
    /[&<>"']/g,
    (c) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      })[c],
  );
}

/**
 * The real screenshot and the mockup, side by side at their native pixel size. An HTML page
 * rather than an actually-composited image: no image-composition library is a dependency of
 * this repo, and two `<img>` tags laid out by CSS lets a human still open each half at full
 * resolution — the whole point of the comparison — which a single flattened PNG would not.
 */
function writeSideBySideHtml(outDir, row, mockupFile) {
  const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>${escapeHtml(row.name)}</title>
<style>
  body { margin: 0; background: #1e1e1e; display: flex; flex-wrap: wrap; }
  figure { margin: 0; flex: 1 0 ${row.viewport.width}px; color: #ddd; font: 12px sans-serif; }
  figcaption { padding: 6px 10px; }
  img { display: block; max-width: 100%; }
</style></head>
<body>
  <figure><figcaption>real — ${row.name}.png</figcaption><img src="${row.name}.png"></figure>
  <figure><figcaption>mockup — ${escapeHtml(row.mockup)}</figcaption><img src="${mockupFile}"></figure>
</body></html>
`;
  const htmlPath = join(outDir, `${row.name}.html`);
  writeFileSync(htmlPath, html);
  return htmlPath;
}

function writeContactSheet(outDir, results) {
  const rows = results
    .map(({ row, ok, exceptionCount, error, sideBySidePath, shotPath }) => {
      const thumbHref = sideBySidePath ? basename(sideBySidePath) : basename(shotPath ?? '');
      const thumbImg = shotPath
        ? `<a href="${thumbHref}"><img src="${basename(shotPath)}" style="max-width:220px;display:block"></a>`
        : '(no screenshot — the row failed before one was taken)';
      const status =
        ok && exceptionCount === 0
          ? 'ok'
          : `FAILED${exceptionCount > 0 ? ` — ${exceptionCount} page exception(s)` : ''}${error ? `: ${escapeHtml(String(error.message ?? error))}` : ''}`;
      return `<tr>
        <td>${thumbImg}</td>
        <td>${escapeHtml(row.name)}</td>
        <td>${row.mockup ? escapeHtml(row.mockup) : '(none)'}</td>
        <td>${status}</td>
      </tr>`;
    })
    .join('\n');
  const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>ui-shots</title>
<style>
  body { font: 14px sans-serif; background: #1e1e1e; color: #ddd; padding: 16px; }
  table { border-collapse: collapse; width: 100%; }
  td { border-bottom: 1px solid #444; padding: 8px; vertical-align: top; }
  a { color: #8ab4f8; }
</style></head>
<body>
  <h1>ui-shots</h1>
  <table>
    <tr><th>shot</th><th>name</th><th>mockup</th><th>status</th></tr>
    ${rows}
  </table>
</body></html>
`;
  const sheetPath = join(outDir, 'index.html');
  writeFileSync(sheetPath, html);
  return sheetPath;
}

// ── Main ──────────────────────────────────────────────────────────────────────────────────

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const outDir = opts.out ? resolve(process.cwd(), opts.out) : join(root, '.vipper', 'shots');
  mkdirSync(outDir, { recursive: true });

  const rows = opts.only ? SCREENS.filter((r) => opts.only.includes(r.name)) : SCREENS;
  if (rows.length === 0) throw new Error(`--only matched no row in SCREENS: ${opts.only}`);
  if (opts.only) {
    const missing = opts.only.filter((n) => !SCREENS.some((r) => r.name === n));
    if (missing.length > 0) throw new Error(`--only named rows not in SCREENS: ${missing}`);
  }

  const needsClient = rows.some((r) => r.app === 'client');
  const needsWeb = rows.some((r) => r.app === 'web');

  const scratch = mkdtempSync(join(tmpdir(), 'tm-ui-shots-'));
  const chromeProfileDir = join(scratch, 'chrome-profile');
  mkdirSync(chromeProfileDir, { recursive: true });

  let clientServerHandle;
  let clientOrigin;
  let clientDefaultSettings;
  let relayHandle;
  let relayOrigin;
  let chromeProc;
  let cdp;

  try {
    if (needsClient) {
      console.log('building @tm/client renderer ...');
      const requireFromClient = createRequire(join(root, 'apps', 'client', 'noop.cjs'));
      clientDefaultSettings = requireFromClient('@tm/shared/settings').DEFAULT_SETTINGS;
      const clientOutDir = join(scratch, 'client-out');
      mkdirSync(clientOutDir, { recursive: true });
      buildClientRenderer(requireFromClient, clientOutDir);
      const client = await startStaticServer(join(clientOutDir, 'renderer'));
      clientServerHandle = client.server;
      clientOrigin = `http://127.0.0.1:${client.port}`;
    }

    if (needsWeb) {
      const requireFromWeb = createRequire(join(root, 'apps', 'web', 'noop.cjs'));
      const { DEFAULT_SETTINGS: webDefaultSettings } = requireFromWeb('@tm/shared/settings');
      const webOutDir = join(scratch, 'web-out');
      mkdirSync(webOutDir, { recursive: true });
      // Starts before the build: `startFakeRelay` only needs `webOutDir` to exist (it reads
      // from it lazily, per request) and the build itself needs the relay's port first, to
      // bake `VITE_CLOUD_API_BASE`/`VITE_CLOUD_IAM_ISSUER` into the bundle.
      relayHandle = await startFakeRelay({
        fixture: uiShotsFixture,
        webOutDir,
        defaultSettings: webDefaultSettings,
      });
      relayOrigin = `http://127.0.0.1:${relayHandle.port}`;
      console.log(`building @tm/web against ${relayOrigin} ...`);
      buildWeb(requireFromWeb, webOutDir, relayOrigin, `${relayOrigin}/oidc`);
    }

    const browserPath = findBrowser();
    console.log(`using browser: ${browserPath}`);
    const rdpPort = await getFreePort();
    chromeProc = launchChrome(browserPath, rdpPort, {
      profileDir: chromeProfileDir,
      windowSize: { width: 1440, height: 900 },
    });
    await waitFor(
      async () => {
        const res = await fetch(`http://127.0.0.1:${rdpPort}/json/version`);
        return res.ok;
      },
      { timeoutMs: 20000, intervalMs: 300, label: 'Chrome DevTools endpoint' },
    );
    const tabInfo = await openTab(rdpPort, 'about:blank');
    cdp = await connectCdp(tabInfo.webSocketDebuggerUrl);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    const exceptions = collectExceptions(cdp);

    // The desktop client id `'web'` rows' seeded refresh token claims to be paired with — the
    // fake relay's own board/presence responses always name this same id (`fakeRelay.mjs`'s
    // `DESKTOP_CLIENT_ID`), so a seeded, already-known pairing never shows the "no desktop has
    // ever synced this account" empty state.
    const DESKTOP_CLIENT_ID = 'fake-desktop-1';

    const results = [];
    for (const row of rows) {
      console.log(`shooting ${row.name} ...`);
      const result = {
        row,
        ok: false,
        exceptionCount: 0,
        error: null,
        shotPath: null,
        mockupPath: null,
        sideBySidePath: null,
      };
      try {
        exceptions.count = 0;
        await setViewport(cdp, row.viewport.width, row.viewport.height);
        await emulateScheme(cdp, row.scheme);

        let initScript;
        if (row.app === 'client') {
          initScript = clientInitScript(clientDefaultSettings, row);
          await freshLoad(cdp, clientOrigin, initScript);
        } else {
          relayHandle.state.settings.appearance = row.scheme;
          initScript = webInitScript(DESKTOP_CLIENT_ID);
          await freshLoad(cdp, relayOrigin, initScript);
        }

        await waitForIdle(cdp);
        for (const step of row.setup ?? []) {
          await runSetupStep(cdp, step);
        }
        await waitForIdle(cdp);

        const shotPath = join(outDir, `${row.name}.png`);
        const clip = row.clip === 'sidebar' ? await sidebarClipRect(cdp) : undefined;
        await screenshot(cdp, shotPath, clip);
        result.shotPath = shotPath;

        if (row.mockup) {
          const mockupPath = join(outDir, `${row.name}-mockup.png`);
          renderSvgToPng(
            browserPath,
            join(mockupsDir, row.mockup),
            mockupPath,
            row.viewport.width,
            row.viewport.height,
          );
          result.mockupPath = mockupPath;
          result.sideBySidePath = writeSideBySideHtml(outDir, row, basename(mockupPath));
        }

        result.exceptionCount = exceptions.count;
        result.ok = exceptions.count === 0;
        if (!result.ok) console.error(`${row.name}: ${exceptions.count} page exception(s)`);
      } catch (e) {
        result.error = e;
        result.exceptionCount = exceptions.count;
        console.error(`${row.name} failed:`, e);
      }
      results.push(result);
    }

    const sheetPath = writeContactSheet(outDir, results);
    console.log(`\ncontact sheet: ${sheetPath}`);

    if (opts.attach) {
      const attachDir = join(process.cwd(), '.vipper', 'attach');
      rmSync(attachDir, { recursive: true, force: true });
      mkdirSync(dirname(attachDir), { recursive: true });
      cpSync(outDir, attachDir, { recursive: true });
      console.log(`attached: ${attachDir}`);
    }

    const failed = results.filter((r) => !r.ok);
    if (failed.length > 0) {
      console.error(`\n${failed.length}/${results.length} shot(s) failed`);
      process.exitCode = 1;
    } else {
      console.log(`\n${results.length}/${results.length} shots OK`);
    }
  } finally {
    try {
      cdp?.close();
    } catch {
      // already closed
    }
    killBrowser(chromeProc);
    clientServerHandle?.close();
    relayHandle?.server.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
