/**
 * Headless proof that F13.4's resolved-scheme wiring actually boots, in both hosts, against
 * REAL headless Chrome driven over the Chrome DevTools Protocol (CDP) — not a jsdom stand-in.
 * Neither host's own test suite mounts a real document: `apps/web/vitest.config.ts` has no
 * DOM environment, and `shell-parity.test.ts` reads SOURCE text, never a rendered page. The
 * *verify-electron-app* memory says never launch the real Electron app to check something by
 * hand, so this is the scripted stand-in — the same shape of proof `verify-mobile.mjs` and
 * `verify-review-pane.mjs` already run for their own slice of the UI.
 *
 *     node scripts/verify-theme-boot.mjs
 *
 * ## What it proves
 *
 * **Web** (`apps/web`, built fresh against a static file server): under an emulated
 * `prefers-color-scheme: light` OS and then `dark`, with no stored preference, the document
 * ends up with the resolved scheme on `html[data-scheme]`, the matching computed CSS
 * `color-scheme`, `body`'s painted background equal to that scheme's canvas colour
 * (`SEMANTIC[scheme].canvas`), and `--tm-canvas` stamped on the `FluentProvider` root with the
 * same value. Then, with the OS still emulated light, writing `{appearance:'dark'}` into
 * `tm.appearancePrefs` (the same localStorage key and same-tab change event
 * `apps/web/src/appearancePrefs.ts` uses) and re-asserting shows the stored preference beats
 * the OS.
 *
 * **Desktop renderer** (`apps/client`, built fresh via `electron-vite build` and loaded
 * standalone — Chrome, not Electron, which is the whole point): a stub `window.api` is
 * injected via `Page.addScriptToEvaluateOnNewDocument` before the page's own script runs, so
 * `window.api.invoke('settings:get')` answers `{appearance, transparency: 'reduced',
 * fontSizePx: 14, ...DEFAULT_SETTINGS}` and every other channel this app's mount path reaches
 * for resolves to a harmless empty value (`on` is a no-op subscribe). `transparency: 'reduced'`
 * rather than `'system'` is deliberate: CDP has no emulation hook for
 * `prefers-reduced-transparency`, and `'reduced'` forces `data-glass="opaque"`
 * unconditionally (`resolveAppearance`, `packages/ui/src/appearance.ts`), which is the one
 * glass-mode fact this script can assert without that media query. Same four document/provider
 * facts as the web host, for both `appearance: 'light'` and `appearance: 'dark'`, plus
 * `data-glass="opaque"`.
 *
 * Every page load additionally asserts there was no uncaught page exception (`Runtime.
 * exceptionThrown` never fired) and saves a screenshot under the run's scratch directory —
 * **the visual look itself is not checked here.** This script proves the scheme/glass
 * mechanism wires up; it cannot judge whether the result matches the v9 mockups. That
 * judgement needs a human looking at a running copy of the app — see this step's own summary.
 *
 * ## Proven able to fail
 *
 * `apps/web/src/main.tsx`'s `...tokenCssVars(scheme)` was changed to
 * `...tokenCssVars('dark')` — a fixed scheme, ignoring the resolved one — and run against
 * this script once. The web-light checks for `--tm-canvas` went red (`#F7F8FA` expected,
 * `#202326` got), while `data-scheme`/`color-scheme`/body-background stayed green: those three
 * are driven by `useGlobalStyles`' CSS, keyed off the `data-scheme` attribute
 * `useResolvedAppearance` stamps independently of which theme object the provider happens to
 * be handed. Reverted immediately after.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
  screenshot,
  startStaticServer,
  waitFor,
} from './lib/cdp.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const requireFromWeb = createRequire(join(root, 'apps', 'web', 'noop.cjs'));
const requireFromClient = createRequire(join(root, 'apps', 'client', 'noop.cjs'));
const { SEMANTIC } = requireFromWeb('@tm/ui/tokens');
const { DEFAULT_SETTINGS } = requireFromClient('@tm/shared/settings');

const scratch = mkdtempSync(join(tmpdir(), 'tm-theme-boot-'));
const webOutDir = join(scratch, 'web-dist');
const clientOutDir = join(scratch, 'client-out');
const chromeProfileDir = join(scratch, 'chrome-profile');
const shotsDir = join(scratch, 'shots');
for (const dir of [webOutDir, clientOutDir, chromeProfileDir, shotsDir])
  mkdirSync(dir, { recursive: true });

let failures = 0;
let checks = 0;
function check(label, ok, extra = '') {
  checks++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? ` (${extra})` : ''}`);
  if (!ok) failures++;
  return ok;
}

/** `"#F7F8FA"` → `"rgb(247, 248, 250)"`, the form `getComputedStyle(...).backgroundColor` uses. */
function hexToRgb(hex) {
  const n = Number.parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return `rgb(${r}, ${g}, ${b})`;
}

// ── Build both hosts fresh, against this step's own sources ────────────────────────────────

function buildWeb() {
  const vitePkg = requireFromWeb.resolve('vite/package.json');
  const viteBin = join(dirname(vitePkg), 'bin', 'vite.js');
  const res = spawnSync(
    process.execPath,
    [viteBin, 'build', '--outDir', webOutDir, '--emptyOutDir'],
    { cwd: join(root, 'apps', 'web'), stdio: 'inherit' },
  );
  if (res.status !== 0) throw new Error('vite build failed for @tm/web');
}

function buildClientRenderer() {
  const electronViteBin = join(
    dirname(requireFromClient.resolve('electron-vite/package.json')),
    'bin',
    'electron-vite.js',
  );
  const res = spawnSync(process.execPath, [electronViteBin, 'build', '--outDir', clientOutDir], {
    cwd: join(root, 'apps', 'client'),
    stdio: 'inherit',
  });
  if (res.status !== 0) throw new Error('electron-vite build failed for @tm/client');
}

// ── Two static file servers, one per host's built output; Chrome discovery and CDP driving —
// all shared with shots-board.mjs via scripts/lib/cdp.mjs ──────────────────────────────────

async function takeScreenshot(cdp, name) {
  await screenshot(cdp, join(shotsDir, `${name}.png`));
}

/**
 * The window.api stub the desktop renderer boots against. `settings:get` answers with
 * `overrides` layered on `DEFAULT_SETTINGS` (the real default shape, so every nested field —
 * `jira.currentSprintOnly` and friends — is actually present); every other channel this app's
 * mount path reaches for resolves to the emptiest value its own caller tolerates (an array for
 * anything `.map`/`.length`ed, `null` for everything read with `?.`), so no mount-path call
 * throws somewhere a `useInitialLoad`/`Promise.all().catch()` isn't already waiting to turn it
 * into an on-screen error banner instead of an uncaught exception.
 */
function clientInitScript(settingsOverrides) {
  const settings = { ...DEFAULT_SETTINGS, ...settingsOverrides };
  const listResponses = [
    'attention:list',
    'project:list',
    'board:tasks',
    'board:archived',
    'mr:mergeRequests',
    'chain:links',
    'attachment:list',
    'board:scopes',
    'person:list',
  ];
  const nullResponses = [
    'auth:current',
    'update:get',
    'sync:state',
    'activity:getLastSeen',
    // `UsageQuotaStatus`/`UsageQuotaBars` (`@ui/UsageQuotaBars`) and `LimitBanner` (this app)
    // both gate on `=== null` meaning "nothing to show yet" and otherwise read object fields
    // straight off the result — the generic `[]` default below answers none of those fields,
    // which crashed `UsageQuotaStatus`'s `.filter` (reading `undefined.pctSource`) and
    // `LimitBanner`'s `.parkedTaskIds.length` in turn (both caught by `RootErrorBoundary`, so
    // neither was an uncaught page exception, but each blanked every screenshot behind an
    // error card instead of the themed shell).
    'usage:quotas',
    'limit:current',
  ];
  // A `claude:getStatus` of `{}` left `claudeOk` false (`claude?.installed` undefined) with
  // `claude.message` undefined, which rendered App.tsx's Claude warning `MessageBar` with an
  // icon and no text — not a crash, but it put a stray banner in front of the Fluent chrome
  // every screenshot exists to show the human. A believed-healthy status suppresses it.
  const appInfo = {
    version: '0.0.0',
    electron: 'headless',
    node: 'headless',
    chrome: 'headless',
    platform: 'win32',
  };
  const claudeStatus = {
    installed: true,
    version: '0.0.0',
    authenticated: true,
    apiKeyDetected: false,
    message: '',
  };
  return `(function(){
    const SETTINGS = ${JSON.stringify(settings)};
    const APP_INFO = ${JSON.stringify(appInfo)};
    const CLAUDE_STATUS = ${JSON.stringify(claudeStatus)};
    const LIST_CHANNELS = new Set(${JSON.stringify(listResponses)});
    const NULL_CHANNELS = new Set(${JSON.stringify(nullResponses)});
    window.api = {
      invoke(channel) {
        if (channel === 'settings:get') return Promise.resolve(SETTINGS);
        if (channel === 'app:getInfo') return Promise.resolve(APP_INFO);
        if (channel === 'claude:getStatus') return Promise.resolve(CLAUDE_STATUS);
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

/** The provider root Fluent mounts — `#root`'s one child, carrying the `style` both hosts'
 *  `main.tsx` hand `FluentProvider`, including every `tokenCssVars(scheme)` custom property. */
async function providerCustomProperty(cdp, name) {
  return evaluate(
    cdp,
    `getComputedStyle(document.getElementById('root').firstElementChild).getPropertyValue(${JSON.stringify(name)}).trim()`,
  );
}

/**
 * The resolved scheme lands on `document.documentElement` through an async round trip —
 * `settings:get`/`useEffect` for the desktop, `readAppearancePrefs`'s own `useEffect` for the
 * web — so the attribute isn't necessarily there yet the instant `freshLoad`'s "page loaded"
 * check is satisfied (that only waits for React's first, synchronous render, which paints
 * before either host's settings round trip resolves). Polls rather than reading once, so a
 * genuinely wrong scheme still fails the check below with the value it actually settled on,
 * not a timing artefact of reading too early.
 */
async function settleDataScheme(cdp, want, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  let value = await evaluate(cdp, 'document.documentElement.dataset.scheme');
  while (value !== want && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
    value = await evaluate(cdp, 'document.documentElement.dataset.scheme');
  }
  return value;
}

async function assertSchemeFacts(cdp, label, scheme) {
  const dataScheme = await settleDataScheme(cdp, scheme);
  check(`${label}: html[data-scheme] is "${scheme}"`, dataScheme === scheme, `got "${dataScheme}"`);

  const colorScheme = await evaluate(cdp, 'getComputedStyle(document.documentElement).colorScheme');
  check(
    `${label}: computed color-scheme is "${scheme}"`,
    colorScheme === scheme,
    `got "${colorScheme}"`,
  );

  const bodyBg = await evaluate(cdp, 'getComputedStyle(document.body).backgroundColor');
  const expectedBg = hexToRgb(SEMANTIC[scheme].canvas);
  check(
    `${label}: body background is the ${scheme} canvas`,
    bodyBg === expectedBg,
    `expected ${expectedBg}, got ${bodyBg}`,
  );

  const providerCanvas = await providerCustomProperty(cdp, '--tm-canvas');
  check(
    `${label}: provider's --tm-canvas is the ${scheme} canvas`,
    providerCanvas.toUpperCase() === SEMANTIC[scheme].canvas.toUpperCase(),
    `expected ${SEMANTIC[scheme].canvas}, got ${providerCanvas}`,
  );
}

// ── Web host ──────────────────────────────────────────────────────────────────────────────

async function webScheme(cdp, origin, osScheme) {
  const label = `Web (OS ${osScheme})`;
  await emulateScheme(cdp, osScheme);
  await freshLoad(cdp, origin);
  await assertSchemeFacts(cdp, label, osScheme);
  await takeScreenshot(cdp, `web-${osScheme}`);
}

async function webPrefOverridesOs(cdp, origin) {
  const label = 'Web (stored dark pref under OS light)';
  await emulateScheme(cdp, 'light');
  await freshLoad(cdp, origin);
  await evaluate(
    cdp,
    `(function(){
      localStorage.setItem('tm.appearancePrefs', JSON.stringify({appearance: 'dark', transparency: 'system'}));
      window.dispatchEvent(new Event('tm:appearancePrefs'));
    })();`,
  );
  await waitFor(
    async () => (await evaluate(cdp, 'document.documentElement.dataset.scheme')) === 'dark',
    { timeoutMs: 5000, label: 'stored dark pref to take effect' },
  );
  await assertSchemeFacts(cdp, label, 'dark');
  await takeScreenshot(cdp, 'web-pref-overrides-os');
}

// ── Desktop renderer ──────────────────────────────────────────────────────────────────────

async function desktopScheme(cdp, origin, appearance) {
  const label = `Desktop (appearance: ${appearance})`;
  await freshLoad(
    cdp,
    origin,
    clientInitScript({ appearance, transparency: 'reduced', fontSizePx: 14 }),
  );
  await assertSchemeFacts(cdp, label, appearance);
  const dataGlass = await evaluate(cdp, 'document.documentElement.dataset.glass');
  check(
    `${label}: html[data-glass] is "opaque" under transparency:'reduced'`,
    dataGlass === 'opaque',
    `got "${dataGlass}"`,
  );
  await takeScreenshot(cdp, `desktop-${appearance}`);
}

// ── Main ──────────────────────────────────────────────────────────────────────────────────

let webServerHandle;
let clientServerHandle;
let chromeProc;
let cdp;
let pageErrors;

async function main() {
  console.log('building @tm/web ...');
  buildWeb();
  console.log('building @tm/client renderer ...');
  buildClientRenderer();

  const web = await startStaticServer(webOutDir);
  webServerHandle = web.server;
  const webOrigin = `http://127.0.0.1:${web.port}`;

  const client = await startStaticServer(join(clientOutDir, 'renderer'));
  clientServerHandle = client.server;
  const clientOrigin = `http://127.0.0.1:${client.port}`;

  const chromePath = findBrowser();
  console.log(`using browser: ${chromePath}`);
  const rdpPort = await getFreePort();
  chromeProc = launchChrome(chromePath, rdpPort, { profileDir: chromeProfileDir });
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
  pageErrors = collectExceptions(cdp);

  await webScheme(cdp, webOrigin, 'light');
  await webScheme(cdp, webOrigin, 'dark');
  await webPrefOverridesOs(cdp, webOrigin);

  await desktopScheme(cdp, clientOrigin, 'light');
  await desktopScheme(cdp, clientOrigin, 'dark');

  check(
    'no uncaught page exceptions across every load',
    pageErrors.count === 0,
    `${pageErrors.count} thrown`,
  );

  console.log(`\n${checks} checks, ${failures === 0 ? 'ALL PASS' : `${failures} FAILED`}`);
  console.log(`screenshots: ${shotsDir}`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => {
    try {
      cdp?.close();
    } catch {
      // already closed
    }
    killBrowser(chromeProc);
    webServerHandle?.close();
    clientServerHandle?.close();
  });
