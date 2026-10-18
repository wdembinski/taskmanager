/**
 * CDP-over-headless-Chrome machinery shared by every `scripts/*.mjs` that boots `@tm/web` or
 * `@tm/client`'s renderer against a real browser and drives it over the Chrome DevTools
 * Protocol instead of a jsdom stand-in — `verify-theme-boot.mjs` and `shots-board.mjs` first,
 * this plan's `ui-shots.mjs` next. Every helper takes its profile dir, scratch paths, and ports
 * as parameters rather than reading module globals, so two callers can run the machinery
 * side by side without colliding.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

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

export function serveStatic(outDir, pathname, res) {
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

export async function startStaticServer(outDir) {
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

/** A free TCP port on 127.0.0.1, for the Chrome remote-debugging port. */
export async function getFreePort() {
  return new Promise((resolve, reject) => {
    const probe = createNetServer();
    probe.listen(0, '127.0.0.1', () => {
      const p = probe.address().port;
      probe.close(() => resolve(p));
    });
    probe.on('error', reject);
  });
}

export function findBrowser() {
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

export async function waitFor(
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

export function launchChrome(execPath, rdpPort, { profileDir, windowSize } = {}) {
  const args = [
    '--headless=new',
    `--remote-debugging-port=${rdpPort}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-component-update',
    '--disable-background-networking',
    '--hide-scrollbars',
  ];
  if (windowSize) args.push(`--window-size=${windowSize.width},${windowSize.height}`);
  args.push('about:blank');
  return spawn(execPath, args, { stdio: ['ignore', 'ignore', 'ignore'] });
}

export async function openTab(rdpPort, url) {
  let res = await fetch(`http://127.0.0.1:${rdpPort}/json/new?${encodeURIComponent(url)}`, {
    method: 'PUT',
  });
  if (!res.ok) {
    res = await fetch(`http://127.0.0.1:${rdpPort}/json/new?${encodeURIComponent(url)}`);
  }
  if (!res.ok) throw new Error(`could not open a tab (${res.status} ${res.statusText})`);
  return res.json();
}

export function connectCdp(wsUrl) {
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

export async function evaluate(cdp, expression) {
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

export async function screenshot(cdp, filePath) {
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(filePath, Buffer.from(data, 'base64'));
}

/**
 * Clears storage, installs `initScript` to run before the page's own script, then routes the
 * load through `about:blank` first — a same-document navigation (e.g. the bare "/" a prior load
 * left behind) would otherwise reuse the existing execution context, so neither the storage
 * clear nor the init script about to run would ever reach a fresh page. Resolves once React's
 * first (synchronous, data-less) render has painted; callers needing to wait for async data on
 * top of that run their own follow-up wait.
 */
export async function freshLoad(cdp, originUrl, initScript = '') {
  await cdp.send('Storage.clearDataForOrigin', { origin: originUrl, storageTypes: 'all' });
  if (cdp._initScriptId) {
    await cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: cdp._initScriptId });
  }
  const { identifier } = await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: initScript,
  });
  cdp._initScriptId = identifier;
  await cdp.send('Page.navigate', { url: 'about:blank' });
  await cdp.send('Page.navigate', { url: originUrl });
  try {
    await waitFor(
      async () =>
        (await evaluate(
          cdp,
          "document.readyState === 'complete' && document.getElementById('root') !== null && document.getElementById('root').children.length > 0",
        )) === true,
      { timeoutMs: 15000, label: 'page load' },
    );
  } catch (e) {
    const diag = await evaluate(
      cdp,
      'JSON.stringify({ready: document.readyState, href: location.href, bodyLen: document.body.innerText.length})',
    ).catch((e2) => `(diagnostics unavailable: ${e2.message})`);
    throw new Error(`${e.message} — ${diag}`);
  }
}

/**
 * Subscribes to `Runtime.exceptionThrown`, logging each one the same way every caller already
 * did, and returns a handle whose `count` a caller can assert against (0 uncaught exceptions)
 * without having to wire up its own listener and counter.
 *
 * Also subscribes to `Runtime.consoleAPICalled` for `console.error` — a React error boundary
 * (`RootErrorBoundary.tsx`'s `componentDidCatch`) catches a render-time throw and swaps in its
 * own fallback screen, which keeps the throw from ever reaching `window.onerror`/
 * `Runtime.exceptionThrown` at all. Left uncounted, a row whose real screen crashed into that
 * fallback still came back with `exceptions.count === 0` — a false "ok" a human eyeballing the
 * shot would catch but the exit code would not. The boundary's own `console.error('Renderer
 * crashed:', …)` is the one signal still available at that point, so it is treated the same as
 * an uncaught exception here.
 */
export function collectExceptions(cdp) {
  const state = { count: 0 };
  cdp.on('Runtime.exceptionThrown', (params) => {
    state.count++;
    console.error(
      'uncaught page exception:',
      params.exceptionDetails?.text,
      params.exceptionDetails?.exception?.description,
    );
  });
  cdp.on('Runtime.consoleAPICalled', (params) => {
    if (params.type !== 'error') return;
    state.count++;
    const text = (params.args ?? [])
      .map((a) => a.value ?? a.description ?? String(a))
      .join(' ');
    console.error('console.error on page:', text);
  });
  return state;
}

/** Overrides the emulated viewport size (CSS px) for `cdp`'s tab. */
export async function setViewport(cdp, width, height) {
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: false,
  });
}

/** Emulates the OS `prefers-color-scheme` media feature as `scheme` ('light' | 'dark'). */
export async function emulateScheme(cdp, scheme) {
  await cdp.send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-color-scheme', value: scheme }],
  });
}

/** Rasterizes an SVG file to a PNG at `width`x`height`, via a one-shot headless browser run. */
export function renderSvgToPng(browserPath, svgPath, pngPath, width, height) {
  const profileDir = mkdtempSync(join(tmpdir(), 'tm-cdp-svg-'));
  const res = spawnSync(browserPath, [
    '--headless=new',
    '--disable-gpu',
    `--window-size=${width},${height}`,
    `--screenshot=${pngPath}`,
    `--user-data-dir=${profileDir}`,
    pathToFileURL(svgPath).href,
  ]);
  if (res.status !== 0) {
    throw new Error(`${browserPath} screenshot failed for ${svgPath}: ${res.stderr}`);
  }
}

/** Kills a Chrome process tree started by `launchChrome`. On win32, kill by PID via `taskkill
 *  /T` rather than by name — killing by name would also take out any other Chrome the caller's
 *  machine happens to have open. */
export function killBrowser(proc) {
  if (!proc) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F']);
  } else {
    proc.kill('SIGKILL');
  }
}
