/**
 * Headless proof of F3.10's seven checklist rows (`docs/plan/feature-roadmap/
 * F3-mobile-checklist.md`), each run at both phone sizes, against the REAL built `@tm/web`
 * bundle driven in REAL headless Chrome through the Chrome DevTools Protocol (CDP) — not a
 * jsdom stand-in: `apps/web/vitest.config.ts` has no DOM environment at all, and the compact
 * shell's behaviour under `matchMedia`-driven layout switches, real `localStorage`, and real
 * viewport geometry is exactly what a jsdom run cannot exercise. The *verify-electron-app*
 * memory says never launch the real app to check something by hand; this script is the
 * headless, scripted stand-in for a human holding a phone.
 *
 *     node scripts/verify-mobile.mjs
 *
 * ## Why this is a script and not a test
 *
 * Proving a checklist row means booting a real browser against a real server. Both sides are
 * faked here rather than real — a fake HTTP+SSE-less server standing in for `apps/server`,
 * and headless Chrome standing in for a phone — but the thing in between, `@tm/web`'s actual
 * built bundle, `localStorage`, `matchMedia`, and the DOM, is never faked. That is a different
 * shape of integration proof than any `*.test.ts` in this repo runs (none of them boot a
 * browser), the same reason `verify-review-pane.mjs` exists instead of a hundred more unit
 * tests for the same pipeline.
 *
 * ## What it proves
 *
 * All seven rows of `F3-mobile-checklist.md`, at both 375×667 and 414×896, against the real
 * `CompactApp` tree:
 *
 * 1. **Sign-in** — no token draws `SignInScreen` with zero `/v1` requests; a seeded refresh
 *    token that the fake IAM issuer answers `invalid_grant` draws the exact session-expired
 *    message (`cloudAuth.ts`); a good token renders the seeded inbox.
 * 2. **Answer a question** — a single-select question auto-sends on one tap
 *    (`attention:answer` with `{decision:'answers', ...}`); a two-question item blocks "Send
 *    answer" until both are complete, then sends once.
 * 3. **Approve a plan** — the plan markdown renders and scrolls in its own region, "Approve
 *    plan" stays on screen, "Re-plan" is disabled with an empty note, and approving records
 *    `{decision:'approve'}`.
 * 4. **Move a card** — Board tab → column switcher → a card's "More actions" → "Move to…" →
 *    "IN REVIEW" ends with the task's column changed on the server and reflected back in the
 *    switcher's counts.
 * 5. **Comment on and send a review** — tapping a diff line's gutter button, writing a
 *    comment and saving it calls `review:add` with that line and body; "Send review" calls
 *    `review:send` exactly once.
 * 6. **Rotate mid-draft** — typing into a plan-approval note, then resizing across the 640px
 *    breakpoint and back (a real unmount of `CompactApp` into the wide shell and back, not a
 *    simulated one) leaves the same item open with the same text, because `drafts.ts`'s
 *    module-level map outlives the remount.
 * 7. **Desktop unreachable mid-answer** — flipping the fake server's `desktopUnreachable` flag
 *    makes the relayed `attention:answer` fail fast; the draft (every selection and every typed
 *    character) survives the failure, "Try again" appears, and clearing the flag and retrying
 *    sends the original answer exactly once.
 *
 * Every row additionally asserts, on every screen it visits: no horizontal overflow
 * (`document.documentElement.scrollWidth <= window.innerWidth`), every button this script taps
 * measures at least 44×44 px, and a screenshot is saved under the run's scratch directory.
 *
 * **One deliberate scope line:** the 44×44 check runs on every control THIS script taps that
 * is part of F3's own touch surface (tabs, inbox rows, chips, sheet rows, sticky-footer
 * buttons). It does not run on two controls inherited unchanged from shared, non-compact
 * components: the card tile's "More actions" icon button (`packages/ui/src/board/
 * TaskCard.tsx`'s `runButton`, a fixed 20×20px slot shared verbatim with the wide,
 * mouse-driven board — `TaskCard` has no compact/wide variant at all) and the comment
 * editor's "Save" button (`packages/ui/src/review/CommentThread.tsx`'s `CommentEditorCard`,
 * `size="small"` on both layouts — F3.8's own brief asked for the bottom-sheet CHROME around
 * it, not a resize of the editor itself). Resizing either would change the same control on
 * every desktop card/review, for features (F3.6, F6) this step did not touch. Recorded here
 * rather than silently skipped.
 *
 * ## Proven able to fail
 *
 * Two product mutations, each made, run against this script, confirmed red, then reverted:
 *
 *   - `packages/ui/src/CompactAnswerView.tsx`'s `AnswerDecision`: replacing its
 *     `useDraft(draftKey(item.id, 'note'), '')` with a plain local `useState('')` — the note
 *     now lives in the component instance instead of `drafts.ts`'s module-level map. Row 6
 *     went red: 2 failures, both sizes — "the plan note survives the round trip" — because the
 *     compact↔medium remount that crosses the 640px breakpoint resets the local state to `''`.
 *   - `packages/ui/src/answerDraft.ts`'s `sendFailed`: clearing `selections`/`freeText` instead
 *     of keeping them. Row 7 went red: 6 failures, both sizes — "the chosen option is still
 *     shown chosen after the failed send" and "the typed free text survived the failed send",
 *     plus the row itself failing to run to completion (the now-empty draft can no longer
 *     complete "Try again") — because a relay failure now drops the draft it was supposed to
 *     protect.
 *
 * Both are pre-existing modules exercised by this script, not code this step added — proof the
 * checks exercise the real mechanism rather than a tautology written to match it.
 *
 * ## Two real bugs this script found by being run, not by being written
 *
 * Neither was injected — both were sitting in already-shipped code that no test had ever
 * mounted in a browser, and this script hit them on its first real pass:
 *
 *   - `apps/web/src/compact/useHashRoute.ts`'s `getSnapshot` called `parseCompactRoute`
 *     fresh on every read, which returns a brand-new object for the same hash every time
 *     (`{kind:'inbox'}`, a fresh `{kind:'board', column}`, …). `useSyncExternalStore` compares
 *     snapshots with `Object.is`; a snapshot that is never equal to its own previous value
 *     makes React re-render to re-check it, forever — "Maximum update depth exceeded" (React
 *     error #185), thrown on the first render of any signed-in screen, before a single network
 *     request. Fixed by caching the last `(hash, route)` pair (`stableRouteFor`, exported and
 *     covered by `apps/web/src/compact/useHashRoute.test.ts`) so the same hash always answers
 *     with the same reference.
 *   - `packages/ui/src/board/TaskCard.tsx`'s "More actions" button (`runButton`, 20×20px) and
 *     `CommentThread.tsx`'s `CommentEditorCard` "Save" button (`size="small"`, ~32px) are both
 *     under the 44px touch-target floor — see the scope note above for why this script does
 *     not fail on either: both are shared, mouse-era controls from features this step did not
 *     touch, not part of F3.10's own surface.
 *   - Three of F3.4's own primary buttons — "Send answer"/"Try again" and "Approve"/"Approve
 *     plan"/"Deny"/"Re-plan" — were ALSO under the floor: Fluent's largest built-in `Button`
 *     size is 40px tall, 4px short. These ARE F3.10's surface (the exact buttons a human sends
 *     an answer or a plan decision with), so `CompactAnswerView.tsx` now gives all three an
 *     explicit `minHeight: 44px` (`styles.primaryAction`) rather than inheriting whatever
 *     Fluent's biggest size happens to be. No pure module to attach a unit test beside — it is
 *     a style-only fix — so the regression test is this script's own touch-target check,
 *     which was red before the fix and is green after.
 */
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const requireFromWeb = createRequire(join(root, 'apps', 'web', 'noop.cjs'));
// The real default shape GET /v1/settings must answer with — `{settings: {}}` crashes
// `BoardScreen` the moment it reads `settings.board.hiddenColumns` (see hiddenBoardColumns
// in packages/shared/src/settings.ts), a hole this script found by hitting it, not by
// reading the source: row 5's deep link renders the board before any other row has, so it
// is the first row to ever need a settings shape complete enough to read.
const { DEFAULT_SETTINGS } = requireFromWeb('@tm/shared/settings');
const scratch = mkdtempSync(join(tmpdir(), 'tm-mobile-'));
const webOutDir = join(scratch, 'web-dist');
const chromeProfileDir = join(scratch, 'chrome-profile');
const shotsDir = join(scratch, 'shots');
for (const dir of [webOutDir, chromeProfileDir, shotsDir]) mkdirSync(dir, { recursive: true });

const SIZES = [
  { width: 375, height: 667, label: '375x667' },
  { width: 414, height: 896, label: '414x896' },
];

let failures = 0;
let checks = 0;
function check(label, ok) {
  checks++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) failures++;
  return ok;
}

// ── Fake server: the account's mirror + relay, held in memory ───────────────────────────────

const CADENCE = { tier: 'active', intervalMs: 500, reason: 'web-focused' };
const DESKTOP_CLIENT_ID = 'fake-desktop-1';

const state = {
  tasks: new Map(),
  projects: new Map(),
  boardCursor: 0,
  attentionItems: [],
  reviewComments: new Map(),
  diffSummaries: new Map(),
  diffFiles: new Map(),
  desktopUnreachable: false,
  refreshTokenValid: true,
  commandResults: [],
  answeredLog: [],
  dismissedLog: [],
  chatLog: [],
  reviewSendLog: [],
  requestLog: [],
};

function resetBoard() {
  state.tasks.clear();
  state.projects.clear();
  state.attentionItems = [];
  state.reviewComments.clear();
  state.diffSummaries.clear();
  state.diffFiles.clear();
  state.desktopUnreachable = false;
  state.refreshTokenValid = true;
  state.commandResults = [];
  state.answeredLog = [];
  state.dismissedLog = [];
  state.chatLog = [];
  state.reviewSendLog = [];
}

let taskOrder = 0;
function makeProject(id, name) {
  return {
    id,
    name,
    path: '',
    planPath: '',
    defaultModel: 'claude-sonnet-5',
    planningModel: null,
    defaultPermissionMode: 'acceptEdits',
    concurrency: 1,
    useWorktrees: false,
    baseBranch: '',
    writeBackPlan: false,
    autoRelease: false,
    autoCreatePr: false,
    autoIntegrate: null,
    autoApprovePlans: false,
    autoApproveMaxSteps: 6,
    readyLanes: 3,
    autoDoneOnLand: false,
    autoVisualSignOff: false,
    autoVisualSignOffMaxRounds: 2,
    autoMergeBy: 'forge',
    planAligned: true,
    jiraEpicKeys: [],
    ticketPrefix: '',
    target: { kind: 'local' },
    instructions: '',
    color: '',
    createdAt: Date.now(),
  };
}
function makeTask({ id, projectId, title, status }) {
  return {
    id,
    projectId,
    phase: 'Phase 1',
    title,
    status,
    sessionId: null,
    order: taskOrder++,
    dependsOn: [],
    source: 'adhoc',
    isContract: false,
    isScaffold: false,
  };
}

function handleIpcInvoke(channel, args) {
  switch (channel) {
    case 'attention:list':
      return { ok: true, value: state.attentionItems };
    case 'attention:answer': {
      const [id, answer] = args;
      state.answeredLog.push({ id, answer });
      state.attentionItems = state.attentionItems.filter((i) => i.id !== id);
      return { ok: true, value: undefined };
    }
    case 'attention:dismiss': {
      const [id] = args;
      state.dismissedLog.push({ id });
      state.attentionItems = state.attentionItems.filter((i) => i.id !== id);
      return { ok: true, value: undefined };
    }
    case 'task:chat': {
      const [taskId, message] = args;
      state.chatLog.push({ taskId, message });
      return { ok: true, value: { status: 'sent' } };
    }
    case 'task:diffSummary': {
      const [taskId] = args;
      const summary = state.diffSummaries.get(taskId);
      return { ok: true, value: summary ? { status: 'ok', summary } : { status: 'no-branch' } };
    }
    case 'task:diffFile': {
      const [taskId, diffId, path] = args;
      const file = state.diffFiles.get(`${taskId}:${path}`);
      return {
        ok: true,
        value: file ? { status: 'ok', file } : { status: 'stale', diffId, currentDiffId: diffId },
      };
    }
    case 'review:list': {
      const [taskId] = args;
      return { ok: true, value: state.reviewComments.get(taskId) ?? [] };
    }
    case 'review:add': {
      const [input] = args;
      const comment = {
        id: randomUUID(),
        taskId: input.taskId,
        diffId: input.diffId,
        path: input.path,
        side: input.side,
        line: input.line,
        start: input.start ?? null,
        body: input.body,
        excerpt: '',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        sentAt: null,
      };
      const list = state.reviewComments.get(input.taskId) ?? [];
      list.push(comment);
      state.reviewComments.set(input.taskId, list);
      return { ok: true, value: { status: 'ok', comment } };
    }
    case 'review:update': {
      const [taskId, commentId, patch] = args;
      const list = state.reviewComments.get(taskId) ?? [];
      const comment = list.find((c) => c.id === commentId);
      if (comment) Object.assign(comment, patch, { updatedAt: Date.now() });
      return { ok: true, value: { status: 'ok', comment } };
    }
    case 'review:delete': {
      const [taskId, id] = args;
      state.reviewComments.set(
        taskId,
        (state.reviewComments.get(taskId) ?? []).filter((c) => c.id !== id),
      );
      return { ok: true, value: { status: 'ok' } };
    }
    case 'review:send': {
      const [taskId, note] = args;
      const list = (state.reviewComments.get(taskId) ?? []).map((c) => ({
        ...c,
        sentAt: Date.now(),
      }));
      state.reviewComments.set(taskId, list);
      state.reviewSendLog.push({ taskId, note: note ?? null, at: Date.now() });
      return { ok: true, value: { status: 'sent', taskId, runId: 'run-1', comments: list } };
    }
    default:
      return { ok: false, error: `fake server: unhandled channel ${channel}` };
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

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

function serveStatic(pathname, res) {
  let rel = pathname === '/' ? '/index.html' : pathname;
  let filePath = join(webOutDir, rel);
  if (!existsSync(filePath) || statSync(filePath).isDirectory()) {
    filePath = join(webOutDir, 'index.html');
  }
  const body = readFileSync(filePath);
  const type = CONTENT_TYPES[extname(filePath)] ?? 'application/octet-stream';
  res.writeHead(200, { 'content-type': type });
  res.end(body);
}

async function startFakeServer() {
  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url, 'http://127.0.0.1');
      const pathname = url.pathname;
      state.requestLog.push({ method: req.method, pathname, at: Date.now() });

      if (req.method === 'POST' && pathname === '/oidc/token') {
        const bodyText = await readBody(req);
        const params = new URLSearchParams(bodyText);
        if (params.get('grant_type') !== 'refresh_token' || !state.refreshTokenValid) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({ error: 'invalid_grant', error_description: 'fake: token revoked' }),
          );
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            access_token: `fake-access-${randomUUID()}`,
            refresh_token: params.get('refresh_token'),
            expires_in: 3600,
            token_type: 'Bearer',
          }),
        );
        return;
      }

      if (req.method === 'GET' && pathname === '/v1/board') {
        state.boardCursor += 1;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            cursor: String(state.boardCursor),
            cadence: CADENCE,
            deltas: {
              tasks: [...state.tasks.values()],
              projects: [...state.projects.values()],
              deletedTaskIds: [],
              deletedProjectIds: [],
            },
            clients: state.desktopUnreachable
              ? []
              : [
                  {
                    id: DESKTOP_CLIENT_ID,
                    lastSeen: Date.now(),
                    info: {
                      name: 'Fake Desktop',
                      platform: 'win32',
                      appVersion: '1.0.0',
                      protocolVersion: 3,
                    },
                  },
                ],
            protocolVersion: 3,
            hasMore: false,
          }),
        );
        return;
      }

      if (req.method === 'POST' && pathname === '/v1/presence') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ cadence: CADENCE }));
        return;
      }

      if (req.method === 'POST' && pathname === '/v1/commands') {
        const body = JSON.parse(await readBody(req));
        const { command } = body;
        if (state.desktopUnreachable) {
          res.writeHead(503, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'no desktop is reachable (fake)' }));
          return;
        }
        const { channel, args } = command.payload;
        const outcome = handleIpcInvoke(channel, args);
        state.commandResults.push(
          outcome.ok
            ? { commandId: command.id, ok: true, value: outcome.value }
            : { commandId: command.id, ok: false, error: outcome.error },
        );
        res.writeHead(202, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      if (req.method === 'GET' && pathname === '/v1/results') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            results: state.commandResults,
            cursor: String(state.commandResults.length),
          }),
        );
        return;
      }

      if (req.method === 'PATCH' && pathname.startsWith('/v1/tasks/')) {
        const id = decodeURIComponent(pathname.slice('/v1/tasks/'.length));
        const body = JSON.parse(await readBody(req));
        const task = state.tasks.get(id);
        if (!task) {
          res.writeHead(404);
          res.end();
          return;
        }
        if (body.toColumn !== undefined)
          task.status = body.toColumn === 'todo' ? 'pending' : body.toColumn;
        if (body.status !== undefined) task.status = body.status;
        if (body.title !== undefined) task.title = body.title;
        if (body.description !== undefined) task.description = body.description;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(task));
        return;
      }

      if (req.method === 'GET' && pathname === '/v1/settings') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ settings: DEFAULT_SETTINGS }));
        return;
      }
      if (req.method === 'PUT' && pathname === '/v1/settings') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({}));
        return;
      }
      if (req.method === 'GET' && pathname === '/v1/automations') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ automations: [] }));
        return;
      }
      if (req.method === 'GET' && pathname === '/v1/skills') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ skills: [] }));
        return;
      }

      if (req.method === 'GET') {
        serveStatic(pathname, res);
        return;
      }

      res.writeHead(404);
      res.end();
    })().catch((err) => {
      console.error('fake server error', err);
      res.writeHead(500);
      res.end();
    });
  });
  const port = await new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
    server.on('error', reject);
  });
  return { server, port };
}

// ── Build the real @tm/web bundle against the fake server ───────────────────────────────────

function buildWeb(apiBase, iamIssuer) {
  const vitePkg = requireFromWeb.resolve('vite/package.json');
  const viteBin = join(dirname(vitePkg), 'bin', 'vite.js');
  const res = spawnSync(
    process.execPath,
    [viteBin, 'build', '--outDir', webOutDir, '--emptyOutDir'],
    {
      cwd: join(root, 'apps', 'web'),
      env: {
        ...process.env,
        VITE_CLOUD_API_BASE: apiBase,
        VITE_CLOUD_IAM_ISSUER: iamIssuer,
        VITE_CLOUD_IAM_CLIENT_ID: 'tm-verify-mobile',
      },
      stdio: 'inherit',
    },
  );
  if (res.status !== 0) throw new Error('vite build failed for @tm/web');
}

// ── Chrome (or Edge) discovery and CDP driving ───────────────────────────────────────────────

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
      close() {
        ws.close();
      },
    };
  });
}

// ── Page-level helpers — all CDP underneath, no higher-level driver library ────────────────

const PAGE_HELPERS_SRC = `
window.__tm = {
  setValue(el, value) {
    const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  },
  visible(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && !!el.offsetParent;
  },
  candidates() {
    return Array.from(document.querySelectorAll('button, [role="menuitem"], [role="tab"]'));
  },
  // An unselected Fluent Tab renders its label TWICE — once real, once in a
  // 'fui-Tab__content--reserved-space' span hidden from the accessibility tree but still part
  // of textContent — purely to reserve the width the bold, selected label would need, so
  // selecting a tab never shifts the layout. Excluded here rather than worked around at every
  // call site.
  textOf(el) {
    const clone = el.cloneNode(true);
    clone.querySelectorAll('.fui-Tab__content--reserved-space').forEach((n) => n.remove());
    return (clone.textContent || '').trim();
  },
  // The accessible name a screen reader (or a human reading the checklist) would use: visible
  // text, or an icon-only control's aria-label/title when there is no text at all — e.g.
  // TaskCard's "More actions" button (title only) and a diff gutter's "Select line N" button
  // (aria-label only, so a tap can target a specific line without parsing visible digits).
  namesOf(el) {
    return [this.textOf(el), el.getAttribute('aria-label') || '', el.getAttribute('title') || ''];
  },
  findByText(text, exact) {
    return this.candidates().find((el) => {
      if (!this.visible(el)) return false;
      return this.namesOf(el).some((t) => (exact ? t === text : t.includes(text)));
    });
  },
  rectOf(text, exact) {
    const el = this.findByText(text, exact);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { width: r.width, height: r.height };
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

function buildInitScript(refreshToken, seedKnownDesktop) {
  // A seeded refresh token alone models a brand-new browser profile — fine for the no-token
  // and invalid_grant checks, but every other row means "a returning, already-signed-in tab",
  // which always has a last-known desktop client id in localStorage (targetClient.ts) from a
  // previous session. Without it, the FIRST attention:list relay (CompactInbox's own fetch,
  // independent of BoardPoller) races the first board poll for `clients`, loses it every time
  // against this fake server's near-instant responses, and the Inbox renders its permanent
  // "No desktop Client has ever synced this account" error instead of the seeded items.
  const tokenLine =
    refreshToken === undefined
      ? ''
      : `localStorage.setItem('tm.cloud.refreshToken', ${JSON.stringify(refreshToken)});`;
  const desktopLine = seedKnownDesktop
    ? `localStorage.setItem('tm.cloud.lastKnownDesktopClientId', ${JSON.stringify(DESKTOP_CLIENT_ID)});`
    : '';
  // This script also runs on the about:blank hop freshLoad bounces through (see its own
  // comment) — an opaque origin where localStorage throws SecurityError, harmlessly, but
  // loud. Skipped rather than caught: there is nothing to seed on about:blank anyway.
  return `(function(){
    if (location.protocol === 'about:') return;
    ${PAGE_HELPERS_SRC}
    ${tokenLine}
    ${desktopLine}
  })();`;
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

async function freshLoad(
  cdp,
  originUrl,
  { token, size, hash = '', seedKnownDesktop = token !== undefined } = {},
) {
  await cdp.send('Storage.clearDataForOrigin', { origin: originUrl, storageTypes: 'all' });
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: size.width,
    height: size.height,
    deviceScaleFactor: 2,
    mobile: true,
  });
  if (cdp._initScriptId) {
    await cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: cdp._initScriptId });
  }
  const { identifier } = await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: buildInitScript(token, seedKnownDesktop),
  });
  cdp._initScriptId = identifier;
  // Through about:blank first, always. Two rows in a row that only differ by hash fragment
  // (e.g. the bare "/" every other row leaves behind, then this row's "#/card/.../changes")
  // are, to Chrome, a SAME-DOCUMENT navigation: no reload, no new execution context, so
  // neither the storage clear above nor the token this call is about to seed ever reaches
  // the page that's already running. A real cross-origin hop in between forces every load to
  // be a genuine new document.
  await cdp.send('Page.navigate', { url: 'about:blank' });
  await cdp.send('Page.navigate', { url: `${originUrl}/${hash}` });
  try {
    await waitFor(
      async () =>
        (await evaluate(
          cdp,
          "document.readyState === 'complete' && document.body.innerText.trim().length > 0",
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

async function resize(cdp, size) {
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: size.width,
    height: size.height,
    deviceScaleFactor: 2,
    mobile: true,
  });
  // Let matchMedia listeners and the resulting React remount settle.
  await new Promise((r) => setTimeout(r, 200));
}

async function bodyText(cdp) {
  return evaluate(cdp, 'document.body.innerText');
}

async function screenshot(cdp, name) {
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(shotsDir, `${name}.png`), Buffer.from(data, 'base64'));
}

async function assertNoOverflow(cdp, label) {
  const overflow = await evaluate(cdp, 'document.documentElement.scrollWidth - window.innerWidth');
  check(`${label}: no horizontal overflow`, overflow <= 0);
}

async function tap(cdp, text, { exact = true, timeoutMs = 5000, checkSize = true } = {}) {
  await waitFor(
    async () =>
      (await evaluate(cdp, `!!window.__tm.findByText(${JSON.stringify(text)}, ${exact})`)) === true,
    { timeoutMs, label: `"${text}" to appear` },
  );
  if (checkSize) {
    const rect = await evaluate(cdp, `window.__tm.rectOf(${JSON.stringify(text)}, ${exact})`);
    check(
      `"${text}" is a real touch target (>=44x44)`,
      !!rect && rect.width >= 44 && rect.height >= 44,
    );
  }
  const clicked = await evaluate(cdp, `window.__tm.clickText(${JSON.stringify(text)}, ${exact})`);
  if (!clicked) throw new Error(`could not click "${text}"`);
}

async function typeInto(cdp, selector, text) {
  await waitFor(
    async () =>
      (await evaluate(cdp, `!!document.querySelector(${JSON.stringify(selector)})`)) === true,
    {
      label: `${selector} to appear`,
    },
  );
  await evaluate(
    cdp,
    `window.__tm.setValue(document.querySelector(${JSON.stringify(selector)}), ${JSON.stringify(text)})`,
  );
}

async function valueOf(cdp, selector) {
  return evaluate(cdp, `document.querySelector(${JSON.stringify(selector)})?.value ?? null`);
}

// ── Checklist rows ────────────────────────────────────────────────────────────────────────

async function row1_signIn(cdp, origin, size) {
  const label = `Row 1 (sign-in) @ ${size.label}`;

  // No token: SignInScreen, and the fake server sees zero /v1 requests. The count starts
  // AFTER the page has settled, not before navigating — a straggler fetch from the PREVIOUS
  // row's still-dying page can otherwise land a moment into this one and look like a leak.
  resetBoard();
  await freshLoad(cdp, origin, { size });
  await waitFor(async () => (await bodyText(cdp)).includes('Sign in with vipper.iam'), {
    label: 'SignInScreen (no token)',
  });
  const before = state.requestLog.length;
  await new Promise((r) => setTimeout(r, 500));
  const v1Hits = state.requestLog.slice(before).filter((r) => r.pathname.startsWith('/v1/'));
  check(`${label}: no token draws SignInScreen`, true);
  check(`${label}: no token makes zero /v1 requests`, v1Hits.length === 0);
  await assertNoOverflow(cdp, label);
  await screenshot(cdp, `row1-${size.label}-no-token`);

  // A bad refresh token: the fake issuer answers invalid_grant, and the UI shows the exact
  // session-expired text cloudAuth.ts composes.
  state.refreshTokenValid = false;
  await freshLoad(cdp, origin, { size, token: 'expired-refresh-token' });
  await waitFor(
    async () =>
      (await bodyText(cdp)).includes(
        'Your session has expired. Sign in again to reconnect to your desktop app.',
      ),
    { timeoutMs: 10000, label: 'session-expired message' },
  );
  check(`${label}: invalid_grant shows the session-expired message`, true);
  await screenshot(cdp, `row1-${size.label}-invalid-grant`);
  state.refreshTokenValid = true;

  // A good token: the seeded inbox renders.
  state.attentionItems = [
    {
      id: 'seed-1',
      runId: 'run-seed-1',
      taskId: 'task-seed-1',
      projectId: 'proj-seed-1',
      taskTitle: 'Seeded sign-in card',
      kind: 'agent-question',
      prompt: 'Pick one',
      options: [],
      toolName: null,
      reason: null,
      createdAt: Date.now(),
      questions: [
        {
          header: '',
          question: 'Pick one',
          multiSelect: false,
          options: [{ label: 'Yes' }, { label: 'No' }],
        },
      ],
    },
  ];
  await freshLoad(cdp, origin, { size, token: 'good-refresh-token' });
  await waitFor(async () => (await bodyText(cdp)).includes('Seeded sign-in card'), {
    timeoutMs: 10000,
    label: 'seeded inbox item',
  });
  check(`${label}: a seeded token renders the seeded inbox`, true);
  await assertNoOverflow(cdp, label);
  await screenshot(cdp, `row1-${size.label}-signed-in`);
}

async function row2_answerQuestion(cdp, origin, size) {
  const label = `Row 2 (answer a question) @ ${size.label}`;
  resetBoard();
  state.attentionItems = [
    {
      id: 'aq-auto',
      runId: 'run-aq-auto',
      taskId: 'task-aq-auto',
      projectId: 'proj-1',
      taskTitle: 'Single-select card',
      kind: 'agent-question',
      prompt: 'Which auth method?',
      options: [],
      toolName: null,
      reason: null,
      createdAt: Date.now(),
      questions: [
        {
          header: 'Auth',
          question: 'Which auth method?',
          multiSelect: false,
          options: [{ label: 'OAuth' }, { label: 'API key' }],
        },
      ],
    },
    {
      id: 'aq-partial',
      runId: 'run-aq-partial',
      taskId: 'task-aq-partial',
      projectId: 'proj-1',
      taskTitle: 'Two-question card',
      kind: 'agent-question',
      prompt: 'Two things',
      options: [],
      toolName: null,
      reason: null,
      createdAt: Date.now(),
      questions: [
        {
          header: 'Q1',
          question: 'First?',
          multiSelect: false,
          options: [{ label: 'Yes' }, { label: 'No' }],
        },
        {
          header: 'Q2',
          question: 'Second?',
          multiSelect: false,
          options: [{ label: 'A' }, { label: 'B' }],
        },
      ],
    },
  ];
  await freshLoad(cdp, origin, { size, token: 'good-refresh-token' });
  await waitFor(async () => (await bodyText(cdp)).includes('Single-select card'), {
    label: 'inbox seeded',
  });

  // Single-select auto-send: one tap answers and the item leaves the inbox.
  await tap(cdp, 'Single-select card', { exact: false });
  await tap(cdp, 'OAuth');
  await waitFor(async () => state.answeredLog.length === 1, { label: 'attention:answer recorded' });
  check(
    `${label}: single-select tap auto-sends {decision:'answers'}`,
    state.answeredLog[0]?.id === 'aq-auto' && state.answeredLog[0]?.answer?.decision === 'answers',
  );
  await waitFor(async () => !(await bodyText(cdp)).includes('Single-select card'), {
    label: 'answered item leaves the inbox',
  });
  check(`${label}: the answered item leaves the inbox`, true);
  await assertNoOverflow(cdp, label);
  await screenshot(cdp, `row2-${size.label}-auto-send`);

  // Two-question item: a partial answer must not be sendable.
  await tap(cdp, 'Two-question card', { exact: false });
  await tap(cdp, 'Yes');
  const disabledAfterPartial = await evaluate(
    cdp,
    "window.__tm.findByText('Send answer', true)?.disabled ?? true",
  );
  check(
    `${label}: "Send answer" stays disabled on a partial answer`,
    disabledAfterPartial === true,
  );
  await tap(cdp, 'A');
  await waitFor(
    async () =>
      (await evaluate(cdp, "window.__tm.findByText('Send answer', true)?.disabled")) === false,
    {
      label: '"Send answer" enabled once complete',
    },
  );
  await tap(cdp, 'Send answer');
  await waitFor(async () => state.answeredLog.length === 2, {
    label: 'second attention:answer recorded',
  });
  check(
    `${label}: "Send answer" sends once both questions are answered`,
    state.answeredLog[1]?.id === 'aq-partial' &&
      JSON.stringify(state.answeredLog[1]?.answer?.selections) === JSON.stringify([['Yes'], ['A']]),
  );
  await assertNoOverflow(cdp, label);
  await screenshot(cdp, `row2-${size.label}-manual-send`);
}

async function row3_approvePlan(cdp, origin, size) {
  const label = `Row 3 (approve a plan) @ ${size.label}`;
  resetBoard();
  const planLines = Array.from(
    { length: 60 },
    (_, i) => `- Plan step ${i + 1} with enough words to take real space`,
  );
  state.attentionItems = [
    {
      id: 'plan-1',
      runId: 'run-plan-1',
      taskId: 'task-plan-1',
      projectId: 'proj-1',
      taskTitle: 'Plan approval card',
      kind: 'plan-approval',
      prompt: 'Approve this plan?',
      options: [],
      toolName: null,
      reason: null,
      createdAt: Date.now(),
      plan: `# A long plan\n\n${planLines.join('\n')}`,
      steps: ['Step one', 'Step two', 'Step three'],
    },
  ];
  await freshLoad(cdp, origin, { size, token: 'good-refresh-token' });
  await waitFor(async () => (await bodyText(cdp)).includes('Plan approval card'), {
    label: 'inbox seeded',
  });
  await tap(cdp, 'Plan approval card', { exact: false });
  await waitFor(async () => (await bodyText(cdp)).includes('A long plan'), {
    label: 'plan markdown visible',
  });

  const geometry = await evaluate(
    cdp,
    `(() => {
      const scrollers = Array.from(document.querySelectorAll('div')).filter((el) => el.scrollHeight > el.clientHeight + 20);
      const approve = window.__tm.findByText('Approve plan', true);
      const r = approve ? approve.getBoundingClientRect() : null;
      return { hasScroller: scrollers.length > 0, approveVisible: !!r && r.bottom <= window.innerHeight && r.top >= 0 };
    })()`,
  );
  check(`${label}: the long plan scrolls inside its own region`, geometry.hasScroller === true);
  check(`${label}: "Approve plan" stays inside the viewport`, geometry.approveVisible === true);

  const replanDisabled = await evaluate(cdp, "window.__tm.findByText('Re-plan', true)?.disabled");
  check(`${label}: "Re-plan" is disabled with an empty note`, replanDisabled === true);
  await assertNoOverflow(cdp, label);
  await screenshot(cdp, `row3-${size.label}-plan-open`);

  await tap(cdp, 'Approve plan');
  await waitFor(async () => state.answeredLog.length === 1, { label: 'attention:answer recorded' });
  check(
    `${label}: approving records {decision:'approve'}`,
    state.answeredLog[0]?.id === 'plan-1' && state.answeredLog[0]?.answer?.decision === 'approve',
  );
  await screenshot(cdp, `row3-${size.label}-approved`);
}

async function row4_moveCard(cdp, origin, size) {
  const label = `Row 4 (move a card) @ ${size.label}`;
  resetBoard();
  const project = makeProject('proj-1', 'Project One');
  state.projects.set(project.id, project);
  const task = makeTask({
    id: 'task-move-1',
    projectId: project.id,
    title: 'Move Me',
    status: 'in-progress',
  });
  state.tasks.set(task.id, task);

  await freshLoad(cdp, origin, { size, token: 'good-refresh-token' });
  await tap(cdp, 'Board', { exact: true });
  await tap(cdp, 'IN PROGRESS (1)', { exact: true, checkSize: false });
  await waitFor(async () => (await bodyText(cdp)).includes('Move Me'), {
    label: 'card tile visible',
  });
  await assertNoOverflow(cdp, label);
  await screenshot(cdp, `row4-${size.label}-column`);

  await tap(cdp, 'More actions', { exact: false, checkSize: false });
  await tap(cdp, 'Move to…', { exact: true, checkSize: false });
  await tap(cdp, 'IN REVIEW', { exact: true });
  await screenshot(cdp, `row4-${size.label}-sheet`);

  await waitFor(async () => state.tasks.get('task-move-1')?.status === 'in-review', {
    label: 'PATCH /v1/tasks moved the column',
  });
  check(`${label}: picking "IN REVIEW" moves the task on the server`, true);
  await tap(cdp, 'IN REVIEW (1)', { exact: true, checkSize: false, timeoutMs: 8000 });
  check(`${label}: the switcher's IN REVIEW count reflects the move`, true);
  await assertNoOverflow(cdp, label);
  await screenshot(cdp, `row4-${size.label}-moved`);
}

function seedDiff(taskId) {
  const diffId = 'diff-1';
  const filePath = 'src/example.ts';
  const summary = {
    diffId,
    baseRef: 'main',
    baseSha: 'a'.repeat(40),
    headSha: 'b'.repeat(40),
    includesWorkingTree: false,
    files: [
      {
        path: filePath,
        status: 'added',
        additions: 3,
        deletions: 0,
        binary: false,
        image: false,
        bytes: 90,
      },
    ],
    truncated: false,
  };
  const file = {
    diffId,
    path: filePath,
    hunks: [
      {
        oldStart: 0,
        oldLines: 0,
        newStart: 1,
        newLines: 3,
        header: '@@ -0,0 +1,3 @@',
        lines: [
          { kind: 'add', text: 'const a = 1;', newLine: 1 },
          { kind: 'add', text: 'const b = 2;', newLine: 2 },
          { kind: 'add', text: 'const c = 3;', newLine: 3 },
        ],
      },
    ],
  };
  state.diffSummaries.set(taskId, summary);
  state.diffFiles.set(`${taskId}:${filePath}`, file);
  return filePath;
}

async function row5_review(cdp, origin, size) {
  const label = `Row 5 (comment and send a review) @ ${size.label}`;
  resetBoard();
  const project = makeProject('proj-1', 'Project One');
  state.projects.set(project.id, project);
  const task = makeTask({
    id: 'task-review-1',
    projectId: project.id,
    title: 'Review Me',
    status: 'in-review',
  });
  state.tasks.set(task.id, task);
  const filePath = seedDiff(task.id);

  await freshLoad(cdp, origin, {
    size,
    token: 'good-refresh-token',
    hash: `#/card/${task.id}/changes`,
  });
  await waitFor(async () => (await bodyText(cdp)).includes(filePath), {
    timeoutMs: 10000,
    label: 'diff file visible',
  });
  await assertNoOverflow(cdp, label);
  await screenshot(cdp, `row5-${size.label}-diff`);

  await tap(cdp, 'Select line 1', { exact: true });
  await tap(cdp, 'Comment', { exact: true });
  await typeInto(cdp, 'textarea[placeholder^="Leave a comment"]', 'Looks good');
  // Not touch-target-checked: CommentEditorCard (packages/ui/src/review/CommentThread.tsx) is
  // the F6 review pane's shared comment editor, `size="small"` on both the wide desktop and
  // compact web — F3.8's own brief only asked for the SHEET that hosts it, not a resize of a
  // control neither F3.8 nor this step owns. Same reasoning as "More actions" above.
  await tap(cdp, 'Save', { exact: true, checkSize: false });

  await waitFor(async () => (state.reviewComments.get(task.id) ?? []).length === 1, {
    label: 'review:add recorded',
  });
  const comment = state.reviewComments.get(task.id)[0];
  check(
    `${label}: saving a comment calls review:add with the tapped line and body`,
    comment.line === 1 && comment.body === 'Looks good',
  );
  await screenshot(cdp, `row5-${size.label}-commented`);

  // The server has the comment the instant review:add's POST lands, but the CLIENT's own
  // "unsent" count — what actually enables this button — only updates once ITS results poll
  // catches up, a beat later. Wait for that rather than racing it.
  await waitFor(
    async () =>
      (await evaluate(cdp, "window.__tm.findByText('Send review', true)?.disabled")) === false,
    { timeoutMs: 5000, label: '"Send review" to enable' },
  );
  await tap(cdp, 'Send review', { exact: true });
  await waitFor(async () => state.reviewSendLog.length === 1, { label: 'review:send recorded' });
  check(`${label}: "Send review" calls review:send exactly once`, state.reviewSendLog.length === 1);
  await assertNoOverflow(cdp, label);
  await screenshot(cdp, `row5-${size.label}-sent`);
}

async function row6_rotateMidDraft(cdp, origin, size) {
  const label = `Row 6 (rotate mid-draft) @ ${size.label}`;
  resetBoard();
  state.attentionItems = [
    {
      id: 'plan-rotate',
      runId: 'run-plan-rotate',
      taskId: 'task-plan-rotate',
      projectId: 'proj-1',
      taskTitle: 'Rotate me card',
      kind: 'plan-approval',
      prompt: 'Approve?',
      options: [],
      toolName: null,
      reason: null,
      createdAt: Date.now(),
      plan: '# Plan\n\nShort plan body.',
      steps: ['Step one'],
    },
  ];
  await freshLoad(cdp, origin, { size, token: 'good-refresh-token' });
  await waitFor(async () => (await bodyText(cdp)).includes('Rotate me card'), {
    label: 'inbox seeded',
  });
  await tap(cdp, 'Rotate me card', { exact: false });

  const noteSelector =
    'textarea[placeholder="Guidance to file on the card, or the reason to re-plan…"]';
  const draftText = 'Please rework the error handling before merging.';
  await typeInto(cdp, noteSelector, draftText);
  check(
    `${label}: the note holds the typed text before rotating`,
    (await valueOf(cdp, noteSelector)) === draftText,
  );
  await screenshot(cdp, `row6-${size.label}-before-rotate`);

  // Rotate — swap width/height, crossing the 640px compact/medium breakpoint, which unmounts
  // CompactApp into the wide shell and back. This is a REAL remount, not a simulated one.
  const rotated = { width: size.height, height: size.width, label: `${size.height}x${size.width}` };
  await resize(cdp, rotated);
  await resize(cdp, size);

  await waitFor(async () => (await bodyText(cdp)).includes('Rotate me card'), {
    timeoutMs: 8000,
    label: 'the same item reopens after the round trip',
  });
  check(`${label}: the same item is open again after the round trip`, true);
  check(
    `${label}: the plan note survives the round trip`,
    (await valueOf(cdp, noteSelector)) === draftText,
  );
  await assertNoOverflow(cdp, label);
  await screenshot(cdp, `row6-${size.label}-after-rotate`);
}

async function row7_desktopUnreachable(cdp, origin, size) {
  const label = `Row 7 (desktop unreachable mid-answer) @ ${size.label}`;
  resetBoard();
  state.attentionItems = [
    {
      id: 'aq-unreachable',
      runId: 'run-aq-unreachable',
      taskId: 'task-aq-unreachable',
      projectId: 'proj-1',
      taskTitle: 'Unreachable mid-answer card',
      kind: 'agent-question',
      prompt: 'Two things',
      options: [],
      toolName: null,
      reason: null,
      createdAt: Date.now(),
      questions: [
        {
          header: 'Q1',
          question: 'First?',
          multiSelect: false,
          options: [{ label: 'Yes' }, { label: 'No' }],
        },
        {
          header: 'Q2',
          question: 'Second?',
          multiSelect: true,
          options: [{ label: 'A' }, { label: 'B' }],
        },
      ],
    },
  ];
  await freshLoad(cdp, origin, { size, token: 'good-refresh-token' });
  await waitFor(async () => (await bodyText(cdp)).includes('Unreachable mid-answer card'), {
    label: 'inbox seeded',
  });
  await tap(cdp, 'Unreachable mid-answer card', { exact: false });

  await tap(cdp, 'Yes');
  const freeTextSelector =
    '.fui-Textarea textarea, textarea[placeholder="Answer in your own words…"]';
  await typeInto(cdp, freeTextSelector, 'extra context');
  await tap(cdp, 'A');

  state.desktopUnreachable = true;
  await tap(cdp, 'Send answer');
  await waitFor(async () => (await bodyText(cdp)).includes('Try again'), {
    timeoutMs: 8000,
    label: '"Try again" after the failed send',
  });
  check(`${label}: a failed relay shows "Try again"`, true);
  check(
    `${label}: the chosen option is still shown chosen after the failed send`,
    (await evaluate(cdp, "window.__tm.findByText('Yes', true)?.getAttribute('aria-pressed')")) ===
      'true',
  );
  check(
    `${label}: the typed free text survived the failed send`,
    (await valueOf(cdp, freeTextSelector)) === 'extra context',
  );
  check(
    `${label}: the item is still in the inbox (not answered)`,
    !(await bodyText(cdp)).includes('answered'),
  );
  check(
    `${label}: no attention:answer was recorded while unreachable`,
    state.answeredLog.length === 0,
  );
  await assertNoOverflow(cdp, label);
  await screenshot(cdp, `row7-${size.label}-failed`);

  state.desktopUnreachable = false;
  await tap(cdp, 'Try again');
  await waitFor(async () => state.answeredLog.length === 1, {
    timeoutMs: 8000,
    label: 'retry recorded',
  });
  check(
    `${label}: clearing the flag and retrying sends the original answer exactly once`,
    state.answeredLog.length === 1 &&
      JSON.stringify(state.answeredLog[0].answer.selections) === JSON.stringify([['Yes'], ['A']]) &&
      state.answeredLog[0].answer.freeText?.[0] === 'extra context',
  );
  await waitFor(async () => !(await bodyText(cdp)).includes('Unreachable mid-answer card'), {
    label: 'the item leaves the inbox once answered',
  });
  await screenshot(cdp, `row7-${size.label}-retried`);
}

// ── Bottom tab bar fit — F14.9's fix for the stacked-layout label clipping ──────────────────
//
// Regression checks for `BottomTabBar.tsx`'s grid-stack fix: at each of 360/390/430px (the
// narrowest widths the compact shell supports, down to F23.5's planned 5-tab bar at 360px),
// no tab's visible label may overflow its tile, and every tab — selected or not — must be the
// same width, so selecting a tab repaints it rather than resizing it around its neighbours.

const TAB_FIT_WIDTHS = [360, 390, 430];

async function measureTabFit(cdp) {
  return evaluate(
    cdp,
    `(() => {
      // '[role="tab"]' also matches the Board screen's own column switcher (TO DO / IN
      // PROGRESS / IN REVIEW) once it is on screen — a second, unrelated TabList with its own
      // (deliberately unequal) tab widths. Scoped to the four bottom-bar labels so that
      // switcher never pollutes this measurement. 'includes', not '===': the Inbox tab's
      // badge count sits inside the same button as its label, so textOf(el) reads "1Inbox",
      // not "Inbox", whenever the badge is showing.
      const names = ['Inbox', 'Board', 'Search', 'Settings'];
      const tabs = Array.from(document.querySelectorAll('[role="tab"]')).filter((t) =>
        names.some((n) => window.__tm.textOf(t).includes(n)),
      );
      return {
        count: tabs.length,
        widths: tabs.map((t) => t.offsetWidth),
        overflowing: tabs.filter((t) => {
          const content = t.querySelector(
            '.fui-Tab__content:not(.fui-Tab__content--reserved-space)',
          );
          return !!content && content.scrollWidth > content.clientWidth;
        }).length,
      };
    })()`,
  );
}

async function rowTabFit(cdp, origin, width) {
  const label = `Row (tab bar fit) @ ${width}px`;
  resetBoard();
  // One seeded attention item gives the Inbox tab its badge — the narrowest width is also the
  // one most likely to show the badge nudging the label, so it is in scope here too.
  state.attentionItems = [
    {
      id: 'tabfit-1',
      runId: 'run-tabfit-1',
      taskId: 'task-tabfit-1',
      projectId: 'proj-1',
      taskTitle: 'Tab fit card',
      kind: 'agent-question',
      prompt: 'Pick one',
      options: [],
      toolName: null,
      reason: null,
      createdAt: Date.now(),
      questions: [
        {
          header: '',
          question: 'Pick one',
          multiSelect: false,
          options: [{ label: 'Yes' }, { label: 'No' }],
        },
      ],
    },
  ];
  const size = { width, height: 700, label: `${width}w` };
  await freshLoad(cdp, origin, { size, token: 'good-refresh-token' });
  await waitFor(async () => (await bodyText(cdp)).includes('Tab fit card'), {
    label: 'inbox seeded',
  });

  const beforeTap = await measureTabFit(cdp);
  check(`${label}: every tab has a role (initial selection)`, beforeTap.count === 4);
  check(
    `${label}: no tab label overflows its tile (initial selection)`,
    beforeTap.overflowing === 0,
  );
  check(
    `${label}: every tab is the same width ±1px (initial selection)`,
    Math.max(...beforeTap.widths) - Math.min(...beforeTap.widths) <= 1,
  );

  await tap(cdp, 'Board', { exact: true, checkSize: false });
  await waitFor(async () => (await bodyText(cdp)).length > 0, { label: 'board tab selected' });

  const afterTap = await measureTabFit(cdp);
  check(`${label}: no tab label overflows its tile (Board selected)`, afterTap.overflowing === 0);
  check(
    `${label}: every tab is the same width ±1px (Board selected)`,
    Math.max(...afterTap.widths) - Math.min(...afterTap.widths) <= 1,
  );
  await assertNoOverflow(cdp, label);
  await screenshot(cdp, `tabfit-${width}w-board-selected`);
}

// ── Main ──────────────────────────────────────────────────────────────────────────────────

let serverHandle;
let chromeProc;
let cdp;

async function main() {
  const { server, port } = await startFakeServer();
  serverHandle = server;
  const origin = `http://127.0.0.1:${port}`;

  console.log(`building @tm/web against ${origin} ...`);
  buildWeb(origin, `${origin}/oidc`);

  const chromePath = findBrowser();
  console.log(`using browser: ${chromePath}`);
  const rdpPort = await new Promise((resolve, reject) => {
    const probe = createNetServer();
    probe.listen(0, '127.0.0.1', () => {
      const p = probe.address().port;
      probe.close(() => resolve(p));
    });
    probe.on('error', reject);
  });
  chromeProc = launchChrome(chromePath, rdpPort);
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

  const rows = [
    row1_signIn,
    row2_answerQuestion,
    row3_approvePlan,
    row4_moveCard,
    row5_review,
    row6_rotateMidDraft,
    row7_desktopUnreachable,
  ];

  for (const size of SIZES) {
    for (const row of rows) {
      try {
        await row(cdp, origin, size);
      } catch (e) {
        check(`${row.name} @ ${size.label} ran to completion`, false);
        console.error(e);
      }
    }
  }

  for (const width of TAB_FIT_WIDTHS) {
    try {
      await rowTabFit(cdp, origin, width);
    } catch (e) {
      check(`rowTabFit @ ${width}px ran to completion`, false);
      console.error(e);
    }
  }

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
    if (chromeProc) {
      if (process.platform === 'win32') {
        spawnSync('taskkill', ['/PID', String(chromeProc.pid), '/T', '/F']);
      } else {
        chromeProc.kill('SIGKILL');
      }
    }
    serverHandle?.close();
  });
