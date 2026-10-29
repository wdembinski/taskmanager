/**
 * Screenshots the real UI headlessly and attaches it next to the mockup, for every row in
 * `SCREENS` below — the driver "Screenshot the real UI headlessly and attach it next to the
 * mockup for every UI task" plan's step 4 adds on top of its first three steps: the CDP-over-
 * headless-Chrome helpers (`scripts/lib/cdp.mjs`), the one seeded fixture and `window.api`/
 * fake-relay stub both `app`s boot against (`scripts/fixtures/uiShotsFixture.mjs`,
 * `scripts/lib/apiStub.mjs`, `scripts/lib/fakeRelay.mjs`), and this map — merged at import time
 * from one file per feature under `scripts/shots/screens/` (`scripts/lib/shotModules.mjs`'s
 * `loadScreens`), so a new UI card adds a file there instead of editing a shared list every
 * other UI card also touches.
 *
 *     node scripts/ui-shots.mjs [--out dir] [--only name,…] [--attach] [--fixture scale]
 *
 * `--out` defaults to `.vipper/shots` (see `.gitignore`'s own comment on `.vipper/`) and holds,
 * per row: `<name>.png` (the real screenshot), `<name>-mockup.png` (the mockup rasterized at the
 * same size, when `mockup` is set), `<name>.html` (the two side by side), one `shots.json`
 * (every row's status plus whatever `shotChecks.mjs`'s `shotProblems` found), and one
 * `index.html` contact sheet linking all of them. `--only` restricts the run to a comma-
 * separated subset of `SCREENS`' own `name`s — and skips building whichever `app` no selected
 * row needs. `--attach` additionally copies the whole `--out` directory into
 * `<cwd>/.vipper/attach/` — the outbox the plan's step 5 ingests once a run settles.
 * `--fixture scale` boots every `'client'` row against `scripts/fixtures/scaleFixture.mjs`'s
 * seeded 5,000-card board (F29.1) instead of `uiShotsFixture.mjs` — to see the board at the
 * owner's scale, not to compare with a mockup; a row whose `setup` names a small-fixture card
 * will miss. `'web'` rows keep the small fixture.
 *
 * Exits 1 if any row threw (a failed build, a setup step that never found its target, a timed-
 * out wait) or logged an uncaught page exception — never silently drops a row and calls the run
 * green. A row may also carry `expect`, a CSS selector proving its `setup` actually landed
 * where it claims (a click that silently missed leaves the previous screen's shot behind under
 * a new name); unlike a `setup` step itself, a missed `expect` does not throw — it is recorded
 * as `selectorMissed` so the sheet still renders, and surfaces as a problem below. Every shot
 * is also hashed (`node:crypto`'s `createHash('sha256')`) once the loop ends, and any two
 * differently-named shots sharing a hash are flagged as duplicates — almost always the same
 * "the click silently missed" bug, caught after the fact instead of by a selector nobody wrote.
 * `--attach` refuses to copy anything, and exits 1, if `shotProblems` found a single problem —
 * a run with a duplicate, a missed selector or a failed `layoutCheck` is not safe to hand to a
 * human as "the real UI". Every problem is printed at the end of a run, attaching or not.
 *
 * Adding a screen is adding a file under `scripts/shots/screens/` — nothing here should need
 * to change for that. Each file's name decides where its rows land in `SCREENS`: a plain `<`
 * comparison on the file name, file order then row order within a file (today's row order
 * is not alphabetical, which is why every file carries a numeric prefix —
 * `010-board.mjs`, `020-sidebar-tree.mjs`, … — a new card picks any free prefix, and if two
 * cards pick the same one, the rest of the name breaks the tie). `loadScreens` throws if two
 * rows — in the same file or across two files — share a `name`, naming both files, and if any
 * row has no `name` at all.
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
 * - `path` — `'client'` rows only: appended to the renderer's origin for the navigation (e.g.
 *   `'/?q=1'`). No row sets it today: every screen is reached through the real shell.
 *   Omit it to load the bare origin — the app itself. Storage is still cleared for the bare
 *   origin either way.
 * - `scheme` — `'light'` or `'dark'`, fed to the same `appearance` setting
 *   `shots-board.mjs`'s `clientInitScript` already threads through.
 * - `osScheme` — `'light'` or `'dark'`, the OS `prefers-color-scheme` the page is emulated
 *   with. Omit it to follow `scheme`; set it to the other one to shoot the app's own Theme over
 *   an OS that disagrees (`015-theme-glass.mjs`). `scheme` alone still feeds `appearance`.
 * - `transparency` — the `transparency` setting the row boots with. Omit it for `'reduced'`
 *   (opaque panes, so every other row's pixels stay deterministic); `'full'` turns the CSS glass
 *   on (`resolveAppearance` picks `css` wherever `backdrop-filter` is supported, which headless
 *   Chrome is), proving the translucent panes actually render.
 * - `setup` — `null` for a screen's resting state, otherwise an ordered list of steps the driver
 *   replays before the shot:
 *     - `{ click: text }` — click the first visible element whose accessible name (text content,
 *       `aria-label`, or `title` — the same three `verify-mobile.mjs`'s `namesOf` checks)
 *       includes `text`. One sentinel, `'issue-row:first'` (or `'issue-row:N'`), clicks the Nth
 *       `[role="option"]` row instead — `IssueRow.tsx`'s rows carry no stable accessible name of
 *       their own (just the fixture's own task title, which a screen map row should not have to
 *       know), so "click a row" is addressed by position, the same way a human would point at
 *       "the first one" without reading its title either. `'issue-row:has:TEXT'` clicks the
 *       first row whose text includes `TEXT` (a ticket key) — for a row whose overrides move
 *       its card to a different place in the list. A second sentinel, `'board-card:ID'`,
 *       clicks `TaskCard.tsx`'s own `[data-task-id="ID"]` root directly — plain text matching
 *       would otherwise land on its hidden chain-link handle first (`aria-label="Chain from
 *       {title} — …"` also *contains* the card's title, and that handle renders before the
 *       card's own text in document order), so a card is addressed by its fixture id instead of
 *       its title, the same reasoning as `issue-row:N`'s own position-not-text sentinel.
 *       `'treeitem:N'` clicks the Nth (0-based) visible `[role="treeitem"]` of the sidebar tree
 *       (`Sidebar.tsx`), for the same reason: a tree ticket's title also renders on the board,
 *       which comes first for plain text matching. A folded milestone's or epic's children are
 *       not rendered, so they do not count. A
 *       third, `'tab:NAME'`, clicks the visible `[role="tab"]` whose text is exactly `NAME` —
 *       for a tab sharing its name with an earlier button (Settings' "Projects" tab). And
 *       `'option:NAME'` / `'title:NAME'` click the visible `[role="option"]` whose text, or
 *       the button whose `title`, is exactly `NAME` — to open a Fluent `Dropdown` named only
 *       by its title and pick one of its options (the detail pane's State control).
 *       `'menuitemradio:NAME'` clicks the visible `[role="menuitemradio"]` whose text is
 *       exactly `NAME` — a Fluent `MenuItemRadio` is not in `candidates()` either, and a plain
 *       text click on "Epic" could land on a row whose title contains it (the Backlog's
 *       "Group by" modes in its "…", opened first with `'title:More options'`).
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
 *     - `{ scrollToSelector: selector }` — waits for `selector` to appear, then
 *       `scrollIntoView({ block: 'start' })`s it — for a section proven to render (by its own
 *       `expect`) but not necessarily in frame at the top of a long, scrollable detail pane.
 *     - `{ hover: selector }` — waits for `selector`, then moves the real (CDP) pointer over
 *       its centre, so a Fluent `Tooltip` opens for the shot (the waiting chip's reasons).
 * - `mockup` — a filename under `docs/plan/feature-roadmap/mockups/`, or `null` where no mockup
 *   draws this exact state (an approximate stand-in mockup is noted per row below instead).
 * - `clip` — `'sidebar'` crops the capture to `nav[aria-label="Sidebar"]`'s own bounding rect
 *   instead of the whole viewport, so the row shoots the tree on its own rather than whatever
 *   else happens to share the window. `{ x, y, width, height }` (CSS px, inside `viewport`)
 *   crops both the shot **and** the rasterized mockup to that one rect, so a zoomed detail (the
 *   canvas haze, `016-haze.mjs`) is compared like for like. `{ selector, mockup: { x, y, width,
 *   height } }` crops the shot to the first `selector` match's own bounding rect and the mockup
 *   to the fixed `mockup` rect — for a block the mockup draws in a different place than the
 *   app puts it (the Start dialog's roles table, reused in the project drawer). Omit it to
 *   capture the full viewport, same as before.
 * - `allowPersistentSpinner` — `true` for a row whose `setup` lands on a screen that means to
 *   show a Fluent `Spinner` forever, not just until some promise resolves (`waitForIdle`'s own
 *   doc comment explains the one screen that does, and why this flag exists rather than just
 *   lengthening the wait). Omit it (same as `false`) everywhere else.
 * - `attention` — `'web'` rows only: the `AttentionItem[]` the fake relay answers
 *   `attention:list` with for this row (default none), so a phone shot can show Inbox rows and
 *   the tab bar's attention count. Reset for every row.
 * - `channelOverrides` — `{ [channel]: spec }` layered over the shared fixture's own
 *   `BOOT_CHANNELS` for this row only: a fixed value, `'list'`/`'null'`, or
 *   `{ byArgTable, fallback, argIndex? }` keyed on the argument at `argIndex` (default `0`).
 *   `'client'` rows feed it to `apiStub.mjs`'s `window.api`; `'web'` rows to the fake relay
 *   (`fakeRelay.mjs`'s `state.channelOverrides`), where it wins over the relay's own explicit
 *   channel cases too. Reset for every row on both targets.
 * - `clock` — an epoch in ms the page's clock starts at (default none: the real clock). Set,
 *   it prepends `scripts/lib/clockShim.mjs`'s `Date` replacement to the row's init script on
 *   both targets, so `Date.now()` and a no-arg `new Date()` read `clock` plus however long the
 *   page has been up — for a screen that compares a fixture timestamp against "now" (the
 *   review workspace's "Queues as of …" caption). Explicit dates are untouched.
 * - `layoutCheck` — `{ visible: selector, clear: [selector, …] }`, measured after `expect`: the
 *   first `visible` match must sit fully inside every overflow-clipping ancestor and the
 *   viewport, and must not overlap the first match of any `clear` selector (sharing an edge is
 *   fine). Like a missed `expect`, a failure does not throw — `shotChecks.mjs`'s
 *   `layoutProblems` reasons are recorded as `layoutProblem` and surface as a `layout`
 *   problem; a `visible` target that never rendered is one too. Proves a heading is laid out
 *   in full, which a selector that merely matches (a half-clipped heading still matches) and a
 *   render test (no layout engine) cannot.
 *
 * ## The sidebar is always open
 *
 * No whole-sidebar fold control exists anywhere in `packages/ui/src/shell` — grepped for
 * `fold`, `collapse`, and `sidebarVisible`/`sidebarOpen` and found none; `Sidebar.tsx`'s own
 * `folds` are per-project-tree-node, not a toggle for the pane as a whole. Every `'client'`
 * row below therefore already shows the sidebar open — there is no "folded" state to add a
 * row for. The `board-sidebar-open-*` rows exist instead to check the column width
 * (`BOARD_COLUMN_WIDTH`, `packages/ui/src/board/boardLayout.ts`) and the header-cluster
 * split (`TaskCard.tsx`) at both 1440 and 1100, with the detail pane closed and open.
 * `board-light` above already covers 1440/closed, so it is not repeated among them.
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildApiStub } from './lib/apiStub.mjs';
import { clockShimSource } from './lib/clockShim.mjs';
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
import { buildScaleFixture } from './fixtures/scaleFixture.mjs';
import { layoutProblems, shotProblems } from './lib/shotChecks.mjs';
import { loadScreens } from './lib/shotModules.mjs';
import {
  PAGE_HELPERS_SRC,
  boardCardClickExprs,
  buildClientRenderer,
  treeItemClickExprs,
} from './lib/uiDriver.mjs';

export const SCREENS = await loadScreens();

// ── CLI ───────────────────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const opts = { out: null, only: null, attach: false, fixture: 'default' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--out') opts.out = argv[++i];
    else if (arg === '--only') {
      opts.only = argv[++i]
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    } else if (arg === '--attach') opts.attach = true;
    else if (arg === '--fixture') {
      opts.fixture = argv[++i];
      if (opts.fixture !== 'default' && opts.fixture !== 'scale') {
        throw new Error(`--fixture must be 'default' or 'scale', got: ${opts.fixture}`);
      }
    } else throw new Error(`unknown argument: ${arg}`);
  }
  return opts;
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const mockupsDir = join(root, 'docs', 'plan', 'feature-roadmap', 'mockups');

// ── Page helpers injected into every row's init script ──────────────────────────────────────
// (`PAGE_HELPERS_SRC` itself lives in `lib/uiDriver.mjs`, shared with `perf-board.mjs`.)

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
 *
 * `attachmentUrls` is `buildFixtureAttachmentUrls`'s own table (`main`, below) — real, fetchable
 * URLs for the handful of fixture attachment ids a row actually draws as `<img>`, threaded
 * straight through to `buildApiStub`.
 *
 * `baseFixture` is `uiShotsFixture.mjs` unless `--fixture scale` swapped in
 * `buildScaleFixture()`'s board.
 */
function clientInitScript(defaultSettings, row, attachmentUrls, baseFixture = uiShotsFixture) {
  const fixture = row.channelOverrides
    ? {
        ...baseFixture,
        BOOT_CHANNELS: { ...baseFixture.BOOT_CHANNELS, ...row.channelOverrides },
      }
    : baseFixture;
  const stub = buildApiStub({
    defaultSettings,
    fixture,
    settingsOverrides: {
      appearance: row.scheme,
      transparency: row.transparency ?? 'reduced',
      fontSizePx: 14,
    },
    attachmentUrls,
    nativeMaterial: row.nativeMaterial ?? null,
  });
  return `${clockShimSource(row.clock)}\n${PAGE_HELPERS_SRC}\n${stub}`;
}

/**
 * The `'web'` target's init script — seeds the signed-in `localStorage` keys
 * `verify-mobile.mjs`'s own `buildInitScript` seeds (a bare refresh token alone models a
 * brand-new, never-synced browser; every `SCREENS` row wants a returning, already-paired one).
 * `appearance` is NOT threaded through here: `GET /v1/settings` answers from `relayState
 * .settings`, which the caller mutates per row (see `main`) since one relay process serves
 * every `'web'` row — `emulateScheme` is this target's only lever on light vs dark, so it is
 * not skippable here the way it is for `'client'`. `clock` is the row's own (see the row
 * shape), which is why this is rebuilt per row rather than once per run.
 */
function webInitScript(desktopClientId, clock) {
  return `${clockShimSource(clock)}
  (function(){
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

/** `{ click: 'issue-row:has:TEXT' }` — the first `[role="option"]` row whose text includes
 *  `TEXT` (a ticket key). For a row whose override moves its card to another status group,
 *  where its position in the list is no longer the one `issue-row:N` would name. */
function issueRowHasClickExprs(text) {
  const find = `Array.from(document.querySelectorAll('[role="option"]')).find((el) => window.__tm.visible(el) && window.__tm.textOf(el).includes(${JSON.stringify(text)}))`;
  return {
    ready: `!!${find}`,
    click: `(() => {
      const el = ${find};
      if (!el) return false;
      el.scrollIntoView({ block: 'center' });
      el.click();
      return true;
    })()`,
  };
}

/** `{ click: 'option:NAME' }` / `{ click: 'menuitemradio:NAME' }` / `{ click: 'title:NAME' }` —
 *  the first visible element matching `selector` whose text (option, menuitemradio) or `title`
 *  attribute (title) is exactly `name`. An open Fluent `Dropdown`'s `[role="option"]` rows (and
 *  a `Menu`'s `[role="menuitemradio"]` ones) are not in `candidates()`, and a plain text click
 *  on "Done" lands on the board's own DONE column header first; a dropdown button is named
 *  only by its `title` ("Status"), which other buttons' text may also contain. */
function exactClickExprs(selector, name, by) {
  const read = by === 'title' ? `el.getAttribute('title')` : 'window.__tm.textOf(el)';
  const find = `Array.from(document.querySelectorAll(${JSON.stringify(selector)})).find((el) => window.__tm.visible(el) && ${read} === ${JSON.stringify(name)})`;
  return {
    ready: `!!${find}`,
    click: `(() => {
      const el = ${find};
      if (!el) return false;
      el.scrollIntoView({ block: 'center' });
      el.click();
      return true;
    })()`,
  };
}

/** `{ click: 'tab:NAME' }` — the visible `[role="tab"]` whose text is exactly `NAME`. A plain
 *  text click on "Projects" lands on the sidebar's own Projects link, which comes first in
 *  document order, never on the Settings tab of the same name. */
function tabClickExprs(name) {
  const find = `Array.from(document.querySelectorAll('[role="tab"]')).find((el) => window.__tm.visible(el) && window.__tm.textOf(el) === ${JSON.stringify(name)})`;
  return {
    ready: `!!${find}`,
    click: `(() => {
      const el = ${find};
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
    const issueRowHas = /^issue-row:has:(.+)$/.exec(step.click);
    const boardCard = /^board-card:(.+)$/.exec(step.click);
    const treeItem = /^treeitem:(\d+)$/.exec(step.click);
    const tab = /^tab:(.+)$/.exec(step.click);
    const option = /^option:(.+)$/.exec(step.click);
    const titled = /^title:(.+)$/.exec(step.click);
    const radio = /^menuitemradio:(.+)$/.exec(step.click);
    const { ready, click } = option
      ? exactClickExprs('[role="option"]', option[1], 'text')
      : radio
        ? exactClickExprs('[role="menuitemradio"]', radio[1], 'text')
        : titled
          ? exactClickExprs('button, [role="combobox"]', titled[1], 'title')
          : issueRowHas
            ? issueRowHasClickExprs(issueRowHas[1])
            : issueRow
              ? issueRowClickExprs(issueRow[1] === 'first' ? 0 : Number(issueRow[1]))
              : boardCard
                ? boardCardClickExprs(boardCard[1])
                : treeItem
                  ? treeItemClickExprs(Number(treeItem[1]))
                  : tab
                    ? tabClickExprs(tab[1])
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
    if (!scrolled) throw new Error("could not find the sidebar's own scroll region");
    return;
  }
  if (step.scrollToSelector !== undefined) {
    // Unlike `{ scroll: 'sidebar-bottom' }`'s one fixed region, this brings an arbitrary
    // element into frame — for a row proving a section renders at all, not just that it is
    // somewhere in a scrollable pane past the viewport's own height.
    const selector = JSON.stringify(step.scrollToSelector);
    await waitFor(
      async () => (await evaluate(cdp, `!!document.querySelector(${selector})`)) === true,
      { timeoutMs: 10000, label: `"${step.scrollToSelector}" to appear before scrolling to it` },
    );
    await evaluate(cdp, `document.querySelector(${selector}).scrollIntoView({ block: 'start' })`);
    return;
  }
  if (step.hover !== undefined) {
    // A REAL pointer move over the element's centre, through CDP's own input domain — Fluent's
    // `Tooltip` opens on pointer-enter, which React derives from `pointerover` and which a
    // synthetic `dispatchEvent` reaches only half the time. The tooltip's own show delay is
    // the row's `expect` to wait out.
    const selector = JSON.stringify(step.hover);
    await waitFor(
      async () => (await evaluate(cdp, `!!document.querySelector(${selector})`)) === true,
      { timeoutMs: 10000, label: `"${step.hover}" to appear before hovering it` },
    );
    const point = await evaluate(
      cdp,
      `(() => {
        const el = document.querySelector(${selector});
        el.scrollIntoView({ block: 'center' });
        const r = el.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      })()`,
    );
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y });
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

/**
 * The first `selector` match's own bounding rect, in CSS px — a `{ selector }` clip's shot.
 * Measured until two reads 100ms apart agree: a drawer still sliding in moves its contents
 * after `expect` already matched, and a rect read mid-slide crops the wrong strip.
 */
async function selectorClipRect(cdp, selector) {
  const measure = () =>
    evaluate(
      cdp,
      `(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height };
      })()`,
    );
  let rect = await measure();
  for (let i = 0; i < 30 && rect; i++) {
    await new Promise((r) => setTimeout(r, 100));
    const next = await measure();
    if (next && JSON.stringify(next) === JSON.stringify(rect)) break;
    rect = next;
  }
  if (!rect) throw new Error(`could not find ${selector} to clip the shot to`);
  return rect;
}

/** `rect` checked as a fixed `{ x, y, width, height }`, naming `label` in the error. */
function checkedRect(row, rect, label) {
  for (const k of ['x', 'y', 'width', 'height']) {
    if (typeof rect?.[k] !== 'number')
      throw new Error(`${row.name}: ${label}.${k} must be a number`);
  }
  return rect;
}

/** A row's `clip` as a fixed `{ x, y, width, height }` rect, or `null` for `'sidebar'`,
 *  a `{ selector }` clip (measured in the page) or none. */
function rectClipOf(row) {
  const c = row.clip;
  if (!c || typeof c !== 'object' || 'selector' in c) return null;
  return checkedRect(row, c, 'clip');
}

/** The rect the mockup is cropped to: a fixed clip's own, or a `{ selector }` clip's `mockup`. */
function mockupClipOf(row) {
  const c = row.clip;
  if (c && typeof c === 'object' && 'selector' in c) {
    return c.mockup ? checkedRect(row, c.mockup, 'clip.mockup') : null;
  }
  return rectClipOf(row);
}

/**
 * Rasterizes `row.mockup` to `mockupPath` — at the full `viewport`, or, for a rect `clip`, just
 * that rect: a one-off HTML page the size of the crop shows the SVG at its `viewport` size,
 * shifted by `-x, -y`, so the mockup's crop lines up pixel for pixel with the shot's.
 */
function rasterizeMockup(browserPath, row, mockupPath) {
  const svgPath = join(mockupsDir, row.mockup);
  const rect = mockupClipOf(row);
  if (!rect) {
    renderSvgToPng(browserPath, svgPath, mockupPath, row.viewport.width, row.viewport.height);
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), 'tm-mockup-crop-'));
  try {
    const htmlPath = join(dir, 'crop.html');
    writeFileSync(
      htmlPath,
      `<!doctype html><html><body style="margin:0;overflow:hidden">` +
        `<img src="${pathToFileURL(svgPath).href}" style="position:absolute;` +
        `left:${-rect.x}px;top:${-rect.y}px;width:${row.viewport.width}px;` +
        `height:${row.viewport.height}px"></body></html>`,
    );
    renderSvgToPng(browserPath, htmlPath, mockupPath, rect.width, rect.height);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * A row's `layoutCheck`, measured in the page: the `visible` target's own rect, the rect of
 * every ancestor whose computed `overflow-x`/`overflow-y` is not `visible` (each one cuts off
 * whatever of the target falls outside it), the viewport, and the first match of every `clear`
 * selector — handed to `shotChecks.mjs`'s pure `layoutProblems`. A target that never rendered
 * is a problem of its own; a `clear` selector that matches nothing has nothing to overlap.
 */
async function measureLayout(cdp, { visible, clear = [] }) {
  const measured = await evaluate(
    cdp,
    `(() => {
      const rectOf = (el, label) => {
        const r = el.getBoundingClientRect();
        return { top: r.top, left: r.left, bottom: r.bottom, right: r.right, label };
      };
      const nameOf = (el) => {
        const tag = el.tagName.toLowerCase();
        const role = el.getAttribute('role');
        const aria = el.getAttribute('aria-label');
        if (aria) return tag + '[aria-label="' + aria + '"]';
        if (role) return tag + '[role="' + role + '"]';
        return el.className && typeof el.className === 'string'
          ? tag + '.' + el.className.trim().split(/\\s+/)[0]
          : tag;
      };
      const target = document.querySelector(${JSON.stringify(visible)});
      if (!target) return null;
      const clips = [];
      for (let el = target.parentElement; el; el = el.parentElement) {
        const style = getComputedStyle(el);
        if (style.overflowX !== 'visible' || style.overflowY !== 'visible') {
          clips.push(rectOf(el, nameOf(el)));
        }
      }
      clips.push({
        top: 0, left: 0, bottom: window.innerHeight, right: window.innerWidth,
        label: 'the viewport',
      });
      const avoid = ${JSON.stringify(clear)}
        .map((selector) => [selector, document.querySelector(selector)])
        .filter(([, el]) => el && el !== target && !el.contains(target))
        .map(([selector, el]) => rectOf(el, selector));
      return { target: rectOf(target, ${JSON.stringify(visible)}), clips, avoid };
    })()`,
  );
  if (!measured) return [`"${visible}" never rendered`];
  return layoutProblems(measured);
}

/** Fluent's `Skeleton`/`Spinner` are the only loading affordance most of `packages/ui/src`
 *  draws (see `PaneLoading.tsx`) — gone means the fixture's own promises (already resolved by
 *  the time this is first checked) have painted, not that some unrelated screen is still busy.
 *
 *  One screen breaks that assumption on purpose: `TaskDetail.tsx`'s own running band spins for
 *  as long as `managedByAI` work is in flight (`run.spinner`), which for a fixture card frozen
 *  mid-run (`agentRunningParent`, the target of `'board-card:3'`) is forever — that `Spinner`
 *  is the point of the screenshot, not a sign it never finished loading. `allowSpinner` skips
 *  only the `Spinner` half of the check for a row that clicks into that state on purpose;
 *  `Skeleton` is still awaited, since nothing in this codebase means to leave one on screen. */
async function waitForIdle(cdp, { allowSpinner = false } = {}) {
  const selector = allowSpinner
    ? '[class*="fui-Skeleton"]'
    : '[class*="fui-Skeleton"], [class*="fui-Spinner"]';
  await waitFor(
    async () =>
      (await evaluate(cdp, `document.querySelectorAll(${JSON.stringify(selector)}).length`)) === 0,
    { timeoutMs: 15000, label: 'loading skeleton/spinner to clear' },
  );
  // A fixed settle beat on top of "no skeleton" — Fluent's own open/close transitions (the
  // palette's dialog, the peek pane) run past the frame where the content they animate in is
  // already in the DOM.
  await new Promise((r) => setTimeout(r, 250));
}

// ── Building each target fresh, against this step's own sources ────────────────────────────

/**
 * Real, decodable PNGs for the handful of `VISUAL_SIGNOFF_*` fixture attachment ids the
 * `visual-signoff-dark`/`inbox-item-attachments`/`files-section-grouped` rows draw as `<img>` —
 * rasterized with `renderSvgToPng`, the same headless-Chrome-screenshots-an-SVG-file approach
 * every mockup row already uses, rather than hand-rolling a PNG encoder. A real Electron main
 * process would answer these through `vipper-attachment://` (`registerAttachmentProtocol`),
 * which this harness's plain Chrome tab can never resolve (see `apiStub.mjs`'s own doc on
 * `attachmentUrls`) — these are what `window.api.attachmentUrl` points at instead.
 *
 * Written under the client renderer's own served output directory so `startStaticServer`
 * answers them for free; the scratch SVGs are removed immediately, since only the PNGs are
 * ever fetched.
 */
function buildFixtureAttachmentUrls(browserPath, clientRendererOutDir, clientOrigin) {
  const dir = join(clientRendererOutDir, 'fixture-attachments');
  mkdirSync(dir, { recursive: true });
  const swatches = {
    'vso-real': { color: '#0F6CBD', label: 'REAL' },
    'vso-mockup': { color: '#616161', label: 'MOCKUP' },
    'vso-step-shot': { color: '#107C10', label: 'STEP' },
  };
  const urls = {};
  for (const [id, { color, label }] of Object.entries(swatches)) {
    const svgPath = join(dir, `${id}.svg`);
    const pngPath = join(dir, `${id}.png`);
    writeFileSync(
      svgPath,
      `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="200">` +
        `<rect width="320" height="200" fill="${color}"/>` +
        `<text x="160" y="104" font-family="sans-serif" font-size="22" fill="white" ` +
        `text-anchor="middle">${label}</text></svg>`,
    );
    renderSvgToPng(browserPath, svgPath, pngPath, 320, 200);
    rmSync(svgPath);
    urls[id] = `${clientOrigin}/fixture-attachments/${id}.png`;
  }
  return urls;
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

/** One clear sentence per `shotProblems` entry — used both for `writeContactSheet`'s status
 *  column and for `--attach`'s refusal-to-copy console output. */
function describeProblem(problem) {
  switch (problem.kind) {
    case 'failed':
      return `${problem.name} failed: ${problem.message}`;
    case 'selectorMissed':
      return `${problem.name}: selector "${problem.selector}" never matched`;
    case 'layout':
      return `${problem.name}: layout — ${problem.message}`;
    case 'duplicate':
      return `${problem.name} is a DUPLICATE of ${problem.otherName} (identical bytes)`;
    default:
      return JSON.stringify(problem);
  }
}

function writeContactSheet(outDir, results, problems) {
  const duplicateOf = new Map(
    problems.filter((p) => p.kind === 'duplicate').map((p) => [p.name, p.otherName]),
  );
  const rows = results
    .map(
      ({
        row,
        ok,
        exceptionCount,
        error,
        sideBySidePath,
        shotPath,
        selectorMissed,
        layoutProblem,
      }) => {
        const thumbHref = sideBySidePath ? basename(sideBySidePath) : basename(shotPath ?? '');
        const thumbImg = shotPath
          ? `<a href="${thumbHref}"><img src="${basename(shotPath)}" style="max-width:220px;display:block"></a>`
          : '(no screenshot — the row failed before one was taken)';
        const statusParts = [
          ok && exceptionCount === 0
            ? 'ok'
            : `FAILED${exceptionCount > 0 ? ` — ${exceptionCount} page exception(s)` : ''}${error ? `: ${escapeHtml(String(error.message ?? error))}` : ''}`,
        ];
        if (selectorMissed)
          statusParts.push(`selector "${escapeHtml(selectorMissed)}" never matched`);
        if (layoutProblem) statusParts.push(`LAYOUT: ${escapeHtml(layoutProblem.join('; '))}`);
        if (duplicateOf.has(row.name)) {
          statusParts.push(`DUPLICATE of ${escapeHtml(duplicateOf.get(row.name))}`);
        }
        return `<tr>
        <td>${thumbImg}</td>
        <td>${escapeHtml(row.name)}</td>
        <td>${row.mockup ? escapeHtml(row.mockup) : '(none)'}</td>
        <td>${statusParts.join(' — ')}</td>
      </tr>`;
      },
    )
    .join('\n');
  const banner =
    problems.length > 0
      ? `<p style="background:#5a2d2d;padding:8px 12px;border-radius:4px">${problems.length} problem(s) found — see the status column.</p>`
      : '';
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
  ${banner}
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
  const clientFixture = opts.fixture === 'scale' ? buildScaleFixture() : uiShotsFixture;
  const needsWeb = rows.some((r) => r.app === 'web');

  const scratch = mkdtempSync(join(tmpdir(), 'tm-ui-shots-'));
  const chromeProfileDir = join(scratch, 'chrome-profile');
  mkdirSync(chromeProfileDir, { recursive: true });

  let clientServerHandle;
  let clientOrigin;
  let clientRendererOutDir;
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
      clientRendererOutDir = join(clientOutDir, 'renderer');
      const client = await startStaticServer(clientRendererOutDir);
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

    // Real bytes for the `VISUAL_SIGNOFF_*` fixture's attachment ids — see
    // `buildFixtureAttachmentUrls`'s own doc for why a plain Chrome tab needs this at all.
    const attachmentUrls = needsClient
      ? buildFixtureAttachmentUrls(browserPath, clientRendererOutDir, clientOrigin)
      : {};

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
        selectorMissed: null,
        layoutProblem: null,
        hash: null,
      };
      try {
        exceptions.count = 0;
        await setViewport(cdp, row.viewport.width, row.viewport.height);
        await emulateScheme(cdp, row.osScheme ?? row.scheme);

        let initScript;
        if (row.app === 'client') {
          initScript = clientInitScript(clientDefaultSettings, row, attachmentUrls, clientFixture);
          await freshLoad(cdp, clientOrigin, initScript, row.path ?? '');
        } else {
          relayHandle.state.settings.appearance = row.scheme;
          // Reset per row, like `appearance`: one relay serves every web row, so a row that
          // seeds the Inbox must not leak its items (and the tab bar's count) into the next.
          relayHandle.state.attentionItems = structuredClone(row.attention ?? []);
          relayHandle.state.channelOverrides = row.channelOverrides ?? {};
          initScript = webInitScript(DESKTOP_CLIENT_ID, row.clock);
          await freshLoad(cdp, relayOrigin, initScript);
        }

        await waitForIdle(cdp);
        for (const step of row.setup ?? []) {
          await runSetupStep(cdp, step);
        }
        await waitForIdle(cdp, { allowSpinner: row.allowPersistentSpinner === true });

        if (row.expect) {
          try {
            await waitFor(
              async () =>
                (await evaluate(
                  cdp,
                  `document.querySelector(${JSON.stringify(row.expect)}) !== null`,
                )) === true,
              { timeoutMs: 5000, label: `"${row.expect}" to appear` },
            );
          } catch {
            result.selectorMissed = row.expect;
          }
        }

        if (row.layoutCheck) {
          const reasons = await measureLayout(cdp, row.layoutCheck);
          if (reasons.length > 0) result.layoutProblem = reasons;
        }

        const shotPath = join(outDir, `${row.name}.png`);
        const clip =
          row.clip === 'sidebar'
            ? await sidebarClipRect(cdp)
            : row.clip?.selector
              ? await selectorClipRect(cdp, row.clip.selector)
              : (rectClipOf(row) ?? undefined);
        await screenshot(cdp, shotPath, clip);
        result.shotPath = shotPath;

        if (row.mockup) {
          const mockupPath = join(outDir, `${row.name}-mockup.png`);
          rasterizeMockup(browserPath, row, mockupPath);
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

    for (const result of results) {
      if (result.shotPath) {
        result.hash = createHash('sha256').update(readFileSync(result.shotPath)).digest('hex');
      }
    }

    const problems = shotProblems(results);
    const sheetPath = writeContactSheet(outDir, results, problems);
    console.log(`\ncontact sheet: ${sheetPath}`);
    if (problems.length > 0) {
      console.error(`\n${problems.length} problem(s) found:`);
      for (const problem of problems) console.error(`  - ${describeProblem(problem)}`);
    }

    // `[{ name, mockup, ok, problems[] }]` — the manifest `attachOutbox.ts`'s ingest reads
    // (see the plan's own Decisions on "replace, don't pile up") to know exactly which files
    // this run owns, so it is ingested like any other outbox file, not skipped the way
    // `verdicts.txt` is.
    writeFileSync(
      join(outDir, 'shots.json'),
      JSON.stringify(
        results.map((r) => ({
          name: r.row.name,
          mockup: r.row.mockup ?? null,
          ok: r.ok,
          problems: problems
            .filter((p) => p.name === r.row.name)
            .map(({ name: _name, ...rest }) => rest),
        })),
        null,
        2,
      ),
    );

    if (opts.attach) {
      if (problems.length > 0) {
        console.error(`\nrefusing to attach — ${problems.length} problem(s) listed above`);
        process.exitCode = 1;
      } else {
        const attachDir = join(process.cwd(), '.vipper', 'attach');
        rmSync(attachDir, { recursive: true, force: true });
        mkdirSync(dirname(attachDir), { recursive: true });
        cpSync(outDir, attachDir, { recursive: true });
        console.log(`attached: ${attachDir}`);
      }
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
