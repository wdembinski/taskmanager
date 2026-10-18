/**
 * Screenshots of the board (My Tasks), in both themes, against a fixed fixture — so a later
 * step can diff "before" against "after" once F13.21–F13.25 rewrite `TaskCard` to the v9
 * anatomy (`docs/plan/feature-roadmap/F13-design-system-and-shell.md`'s Board bullet). Also
 * renders the two v9 board mockups to PNG at the same size, for a side-by-side.
 *
 * Built on `verify-theme-boot.mjs`'s own CDP-over-headless-Chrome machinery (build the
 * desktop renderer fresh, serve it statically, drive it over the Chrome DevTools Protocol
 * with a stubbed `window.api`) — the *verify-electron-app* memory's rule against ever
 * launching the real Electron app applies here just as much as it did there. Only the
 * desktop renderer is built: the board is `apps/client`'s own `MyTasks` screen, and the
 * fixture's channel names (`board:tasks`, `scheduler:activeRuns`, …) are `window.api`'s,
 * not the web host's relay transport.
 *
 *     node scripts/shots-board.mjs [outName]
 *
 * `outName` (default `board-before`) controls the output file names:
 * `docs/plan/feature-roadmap/shots/<outName>-{light,dark}.png`. F13.25 (this plan's step 6)
 * re-runs this script with `board-after` once the rewrite lands.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ACTIVE_RUNS,
  CHAIN_LINKS,
  MERGE_REQUESTS,
  PEOPLE,
  PROJECTS,
  SETTINGS_OVERRIDES,
  TASKS,
} from './fixtures/boardShotsFixture.mjs';
import {
  collectExceptions,
  connectCdp,
  evaluate,
  findBrowser,
  freshLoad,
  getFreePort,
  killBrowser,
  launchChrome,
  openTab,
  renderSvgToPng,
  screenshot,
  startStaticServer,
  waitFor,
} from './lib/cdp.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const requireFromClient = createRequire(join(root, 'apps', 'client', 'noop.cjs'));
const { DEFAULT_SETTINGS } = requireFromClient('@tm/shared/settings');

const shotsDir = join(root, 'docs', 'plan', 'feature-roadmap', 'shots');
mkdirSync(shotsDir, { recursive: true });

const outName = process.argv[2] ?? 'board-before';

const scratch = mkdtempSync(join(tmpdir(), 'tm-board-shots-'));
const clientOutDir = join(scratch, 'client-out');
const chromeProfileDir = join(scratch, 'chrome-profile');
mkdirSync(clientOutDir, { recursive: true });
mkdirSync(chromeProfileDir, { recursive: true });

// ── Build the desktop renderer fresh, against this step's own sources ──────────────────────

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

// ── A static file server over the built renderer, Chrome/Edge discovery and CDP driving —
// all shared with verify-theme-boot.mjs via scripts/lib/cdp.mjs ────────────────────────────

// ── The window.api stub, fed entirely from the one board-shots fixture ─────────────────────

/**
 * Every channel `MyTasks`'s initial load reaches for. The six the fixture actually drives are
 * listed in this step's plan; the rest fall back to the emptiest value their caller tolerates
 * (an array, or null), the same split `verify-theme-boot.mjs`'s own stub uses — see that
 * script's `clientInitScript` for why each bucket is shaped the way it is.
 */
function clientInitScript(settingsOverrides) {
  const settings = {
    ...DEFAULT_SETTINGS,
    ...SETTINGS_OVERRIDES,
    ...settingsOverrides,
    // See `boardShotsFixture.mjs`'s own comment on `SETTINGS_OVERRIDES`: explicit `[]` shows
    // every column (including Done), where "absent" would hide Done by the legacy rule.
    board: { ...DEFAULT_SETTINGS.board, hiddenColumns: [] },
  };
  const FIXTURE_CHANNELS = {
    'board:tasks': TASKS,
    'board:archived': [],
    'project:list': PROJECTS,
    'mr:mergeRequests': MERGE_REQUESTS,
    'chain:links': CHAIN_LINKS,
    'person:list': PEOPLE,
    'scheduler:activeRuns': ACTIVE_RUNS,
  };
  const LIST_CHANNELS = new Set([
    'attention:list',
    'attachment:list',
    'board:scopes',
    'milestone:list',
  ]);
  const NULL_CHANNELS = new Set([
    'auth:current',
    'update:get',
    'sync:state',
    'activity:getLastSeen',
    'usage:quotas',
    'limit:current',
  ]);
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
    const FIXTURE_CHANNELS = ${JSON.stringify(FIXTURE_CHANNELS)};
    const LIST_CHANNELS = new Set(${JSON.stringify([...LIST_CHANNELS])});
    const NULL_CHANNELS = new Set(${JSON.stringify([...NULL_CHANNELS])});
    window.api = {
      invoke(channel) {
        if (channel === 'settings:get') return Promise.resolve(SETTINGS);
        if (channel === 'app:getInfo') return Promise.resolve(APP_INFO);
        if (channel === 'claude:getStatus') return Promise.resolve(CLAUDE_STATUS);
        if (Object.prototype.hasOwnProperty.call(FIXTURE_CHANNELS, channel)) {
          return Promise.resolve(FIXTURE_CHANNELS[channel]);
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

/**
 * The board's own data arrives after an async `settings:get` → `board:tasks` round trip
 * (`MyTasks`'s initial load), so the first column header on screen is the honest "ready to
 * screenshot" signal, not just React's first (data-less) paint `freshLoad` itself waits for.
 */
async function waitForBoardData(cdp) {
  try {
    await waitFor(async () => (await evaluate(cdp, 'document.body.innerText')).includes('TO DO'), {
      timeoutMs: 15000,
      label: 'board data to render',
    });
  } catch (e) {
    const diag = await evaluate(cdp, 'document.body.innerText').catch((e2) => String(e2));
    throw new Error(`${e.message} — page text so far: ${diag.slice(0, 2000)}`);
  }
}

async function boardScheme(cdp, origin, appearance) {
  await freshLoad(
    cdp,
    origin,
    clientInitScript({ appearance, transparency: 'reduced', fontSizePx: 14 }),
  );
  await waitForBoardData(cdp);
  await screenshot(cdp, join(shotsDir, `${outName}-${appearance}.png`));
  console.log(`wrote ${outName}-${appearance}.png`);
}

// ── The two v9 board mockups, rendered to PNG at the same size for comparison ──────────────

function renderMockups(browserPath) {
  const mockupsDir = join(root, 'docs', 'plan', 'feature-roadmap', 'mockups');
  const pairs = [
    ['v9-7-board-light.svg', 'v9-board-light.png'],
    ['v9-7b-board-dark.svg', 'v9-board-dark.png'],
  ];
  for (const [svgName, pngName] of pairs) {
    const svgPath = join(mockupsDir, svgName);
    const outPath = join(shotsDir, pngName);
    renderSvgToPng(browserPath, svgPath, outPath, 1440, 900);
    console.log(`wrote ${pngName}`);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────────────────

let clientServerHandle;
let chromeProc;
let cdp;

async function main() {
  console.log('building @tm/client renderer ...');
  buildClientRenderer();

  const client = await startStaticServer(join(clientOutDir, 'renderer'));
  clientServerHandle = client.server;
  const clientOrigin = `http://127.0.0.1:${client.port}`;

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
  collectExceptions(cdp);

  await boardScheme(cdp, clientOrigin, 'light');
  await boardScheme(cdp, clientOrigin, 'dark');

  renderMockups(browserPath);

  console.log(`\nscreenshots: ${shotsDir}`);
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
    clientServerHandle?.close();
  });
