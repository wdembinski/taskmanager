/**
 * Screenshots of the sidebar's `team` tree (F13.17) — proving `resolveSidebarProject` picks
 * the ticket project with the most open tickets (TM), not the oldest one that merely owns a
 * ticket prefix (Travelbook, with zero), and that a device's remembered choice can still pin
 * an empty project on purpose.
 *
 * Built on `shots-board.mjs`'s own CDP-over-headless-Chrome machinery (build the desktop
 * renderer fresh, serve it statically, drive it over the Chrome DevTools Protocol with a
 * stubbed `window.api`) — the *verify-electron-app* memory's rule against ever launching the
 * real Electron app applies here just as much as it did there.
 *
 *     node scripts/shots-sidebar.mjs
 *
 * Writes `docs/plan/feature-roadmap/shots/sidebar-tm-{light,dark}.png` (localStorage empty,
 * the most-open-tickets fallback picks TM) and `sidebar-travelbook-empty-light.png`
 * (localStorage pre-seeded with Travelbook as the remembered `sidebar-project`, showing the
 * "has no tickets yet" empty state).
 */
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MILESTONES_BY_PROJECT,
  PROJECTS,
  SETTINGS_OVERRIDES,
  TASKS_BY_PROJECT,
  TRAVELBOOK_ID,
} from './fixtures/sidebarShotsFixture.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const requireFromClient = createRequire(join(root, 'apps', 'client', 'noop.cjs'));
const { DEFAULT_SETTINGS } = requireFromClient('@tm/shared/settings');

const shotsDir = join(root, 'docs', 'plan', 'feature-roadmap', 'shots');
mkdirSync(shotsDir, { recursive: true });

const scratch = mkdtempSync(join(tmpdir(), 'tm-sidebar-shots-'));
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

// ── A static file server over the built renderer ────────────────────────────────────────────

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.map': 'application/json',
};

function serveStatic(outDir, pathname, res) {
  let rel = pathname === '/' ? '/index.html' : pathname;
  let filePath = join(outDir, rel);
  if (!existsSync(filePath) || statSync(filePath).isDirectory()) {
    filePath = join(outDir, 'index.html');
  }
  const body = readFileSync(filePath);
  const type = CONTENT_TYPES[extname(filePath)] ?? 'application/octet-stream';
  res.writeHead(200, { 'content-type': type });
  res.end(body);
}

async function startStaticServer(outDir) {
  const server = createServer((req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      serveStatic(outDir, url.pathname, res);
    } catch (e) {
      res.writeHead(500);
      res.end(String(e));
    }
  });
  const port = await new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
    server.on('error', reject);
  });
  return { server, port };
}

// ── Chrome/Edge discovery and CDP driving — same mechanism as shots-board.mjs ─────────────

function findBrowser() {
  const envPath = process.env.CHROME_PATH;
  if (envPath && existsSync(envPath)) return envPath;

  const candidates =
    process.platform === 'win32'
      ? [
          'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
          'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
          join(process.env.LOCALAPPDATA ?? '', 'Google\\Chrome\\Application\\chrome.exe'),
          'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
          'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
        ]
      : process.platform === 'darwin'
        ? [
            '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
            '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
          ]
        : [
            '/usr/bin/google-chrome',
            '/usr/bin/google-chrome-stable',
            '/usr/bin/chromium-browser',
            '/usr/bin/chromium',
            '/usr/bin/microsoft-edge',
          ];
  const found = candidates.find((p) => p && existsSync(p));
  if (!found) {
    throw new Error(
      'no Chrome or Edge found — set CHROME_PATH, or install Chrome/Edge at a standard location',
    );
  }
  return found;
}

async function waitFor(
  conditionFn,
  { timeoutMs = 5000, intervalMs = 150, label = 'condition' } = {},
) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  for (;;) {
    try {
      if (await conditionFn()) return true;
    } catch (e) {
      lastErr = e;
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${label}${lastErr ? `: ${lastErr.message}` : ''}`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

function launchChrome(execPath, rdpPort) {
  const args = [
    '--headless=new',
    `--remote-debugging-port=${rdpPort}`,
    `--user-data-dir=${chromeProfileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-component-update',
    '--disable-background-networking',
    '--hide-scrollbars',
    '--window-size=1440,900',
    'about:blank',
  ];
  return spawn(execPath, args, { stdio: ['ignore', 'ignore', 'ignore'] });
}

async function openTab(rdpPort, url) {
  let res = await fetch(`http://127.0.0.1:${rdpPort}/json/new?${encodeURIComponent(url)}`, {
    method: 'PUT',
  });
  if (!res.ok) {
    res = await fetch(`http://127.0.0.1:${rdpPort}/json/new?${encodeURIComponent(url)}`);
  }
  if (!res.ok) throw new Error(`could not open a tab (${res.status} ${res.statusText})`);
  return res.json();
}

function connectCdp(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const pending = new Map();
    const eventListeners = new Map();
    let nextId = 1;
    const timer = setTimeout(() => reject(new Error('CDP connect timed out')), 10000);
    ws.addEventListener('open', () => {
      clearTimeout(timer);
      resolve(cdp);
    });
    ws.addEventListener('error', () => {
      clearTimeout(timer);
      reject(new Error('CDP websocket error'));
    });
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id !== undefined && pending.has(msg.id)) {
        const { resolve: res, reject: rej } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) rej(new Error(msg.error.message));
        else res(msg.result);
        return;
      }
      if (msg.method && eventListeners.has(msg.method)) {
        for (const listener of eventListeners.get(msg.method)) listener(msg.params);
      }
    });
    const cdp = {
      send(method, params = {}) {
        return new Promise((res, rej) => {
          const id = nextId++;
          pending.set(id, { resolve: res, reject: rej });
          ws.send(JSON.stringify({ id, method, params }));
        });
      },
      on(method, listener) {
        if (!eventListeners.has(method)) eventListeners.set(method, []);
        eventListeners.get(method).push(listener);
      },
      close() {
        ws.close();
      },
    };
  });
}

async function evaluate(cdp, expression) {
  const result = await cdp.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (result.exceptionDetails) {
    const desc =
      result.exceptionDetails.exception?.description ?? JSON.stringify(result.exceptionDetails);
    throw new Error(`evaluate failed: ${desc}`);
  }
  return result.result.value;
}

async function screenshot(cdp, filePath) {
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(filePath, Buffer.from(data, 'base64'));
}

// ── The window.api stub, fed entirely from the one sidebar-shots fixture ──────────────────

/**
 * Every channel the shell's boot effect (`App.tsx`) and `useSidebarData`/`useTrackerProject`
 * reach for. `board:tasks` and `milestone:list` are the two that take a `projectId` — the
 * sidebar's own tree is scoped to whichever project `resolveSidebarProject` resolves, so
 * (unlike `shots-board.mjs`'s single-project fixture) the stub has to answer per project
 * rather than returning one fixed value regardless of the argument.
 *
 * `localStorageSeed` is written to `localStorage` by this same script, before any renderer
 * code runs — see `freshLoad`'s own comment on why that ordering is guaranteed.
 */
function clientInitScript(settingsOverrides, localStorageSeed) {
  const settings = {
    ...DEFAULT_SETTINGS,
    ...SETTINGS_OVERRIDES,
    ...settingsOverrides,
    board: { ...DEFAULT_SETTINGS.board, hiddenColumns: [] },
  };
  const LIST_CHANNELS = new Set([
    'attention:list',
    'attachment:list',
    'board:scopes',
    'mr:mergeRequests',
    'chain:links',
    'person:list',
    'scheduler:activeRuns',
    'board:archived',
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
    if (location.protocol !== 'about:') {
      try {
        const seed = ${JSON.stringify(localStorageSeed ?? {})};
        for (const key of Object.keys(seed)) localStorage.setItem(key, seed[key]);
      } catch {
        // No localStorage — the shot just proves the un-seeded fallback instead.
      }
    }
    const SETTINGS = ${JSON.stringify(settings)};
    const APP_INFO = ${JSON.stringify(appInfo)};
    const CLAUDE_STATUS = ${JSON.stringify(claudeStatus)};
    const PROJECTS = ${JSON.stringify(PROJECTS)};
    const TASKS_BY_PROJECT = ${JSON.stringify(TASKS_BY_PROJECT)};
    const MILESTONES_BY_PROJECT = ${JSON.stringify(MILESTONES_BY_PROJECT)};
    const LIST_CHANNELS = new Set(${JSON.stringify([...LIST_CHANNELS])});
    const NULL_CHANNELS = new Set(${JSON.stringify([...NULL_CHANNELS])});
    window.api = {
      invoke(channel, ...args) {
        if (channel === 'settings:get') return Promise.resolve(SETTINGS);
        if (channel === 'app:getInfo') return Promise.resolve(APP_INFO);
        if (channel === 'claude:getStatus') return Promise.resolve(CLAUDE_STATUS);
        if (channel === 'project:list') return Promise.resolve(PROJECTS);
        if (channel === 'board:tasks') {
          const scope = args[0];
          if (!scope || scope === 'all') {
            return Promise.resolve(Object.values(TASKS_BY_PROJECT).flat());
          }
          return Promise.resolve(TASKS_BY_PROJECT[scope] ?? []);
        }
        if (channel === 'milestone:list') {
          const projectId = args[0];
          if (!projectId) return Promise.resolve(Object.values(MILESTONES_BY_PROJECT).flat());
          return Promise.resolve(MILESTONES_BY_PROJECT[projectId] ?? []);
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

async function freshLoad(cdp, originUrl, initScript, readyMarker) {
  await cdp.send('Storage.clearDataForOrigin', { origin: originUrl, storageTypes: 'all' });
  if (cdp._initScriptId) {
    await cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: cdp._initScriptId });
  }
  const { identifier } = await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: initScript,
  });
  cdp._initScriptId = identifier;
  // Same reasoning as shots-board.mjs's own freshLoad: route every load through about:blank
  // first, so a same-document navigation never reuses a stale execution context.
  await cdp.send('Page.navigate', { url: 'about:blank' });
  await cdp.send('Page.navigate', { url: originUrl });
  await waitFor(
    async () =>
      (await evaluate(
        cdp,
        "document.readyState === 'complete' && document.getElementById('root') !== null && document.getElementById('root').children.length > 0",
      )) === true,
    { timeoutMs: 15000, label: 'page load' },
  );
  // The sidebar's own tree arrives after the shell's boot effect resolves `project:list`,
  // then `useTrackerProject`'s resolved id round-trips through `milestone:list`/`board:tasks`
  // — `readyMarker` is the honest "ready to screenshot" signal, not just React's first paint.
  try {
    await waitFor(
      async () => (await evaluate(cdp, 'document.body.innerText')).includes(readyMarker),
      { timeoutMs: 15000, label: `sidebar to render "${readyMarker}"` },
    );
  } catch (e) {
    const diag = await evaluate(cdp, 'document.body.innerText').catch((e2) => String(e2));
    throw new Error(`${e.message} — page text so far: ${diag.slice(0, 2000)}`);
  }
}

async function sidebarShot(cdp, origin, outName, appearance, { localStorageSeed, readyMarker }) {
  await freshLoad(
    cdp,
    origin,
    clientInitScript({ appearance, transparency: 'reduced', fontSizePx: 14 }, localStorageSeed),
    readyMarker,
  );
  await screenshot(cdp, join(shotsDir, `${outName}-${appearance}.png`));
  console.log(`wrote ${outName}-${appearance}.png`);
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

  const rdpPort = await new Promise((resolve, reject) => {
    const probe = createNetServer();
    probe.listen(0, '127.0.0.1', () => {
      const p = probe.address().port;
      probe.close(() => resolve(p));
    });
    probe.on('error', reject);
  });
  chromeProc = launchChrome(browserPath, rdpPort);
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
  cdp.on('Runtime.exceptionThrown', (params) => {
    console.error(
      'uncaught page exception:',
      params.exceptionDetails?.text,
      params.exceptionDetails?.exception?.description,
    );
  });

  // localStorage empty: `resolveSidebarProject`'s most-open-tickets fallback picks TM, not
  // Travelbook (the oldest ticket project, with zero) — the regression this plan fixes.
  await sidebarShot(cdp, clientOrigin, 'sidebar-tm', 'light', {
    localStorageSeed: {},
    readyMarker: 'M5',
  });
  await sidebarShot(cdp, clientOrigin, 'sidebar-tm', 'dark', {
    localStorageSeed: {},
    readyMarker: 'M5',
  });

  // localStorage pre-seeded with Travelbook as this device's remembered choice: it still wins
  // outright even though it owns zero tickets, and the sidebar shows the empty state rather
  // than rendering a tree with nothing in it.
  await sidebarShot(cdp, clientOrigin, 'sidebar-travelbook-empty', 'light', {
    localStorageSeed: { 'sidebar-project': JSON.stringify(TRAVELBOOK_ID) },
    readyMarker: 'has no tickets yet',
  });

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
    if (chromeProc) {
      if (process.platform === 'win32') {
        spawnSync('taskkill', ['/PID', String(chromeProc.pid), '/T', '/F']);
      } else {
        chromeProc.kill('SIGKILL');
      }
    }
    clientServerHandle?.close();
  });
