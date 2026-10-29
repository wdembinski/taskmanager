/**
 * The fake account mirror + relay `verify-mobile.mjs` built for F3.10's checklist, pulled out
 * so `ui-shots.mjs` (step 4) can boot `@tm/web` against the SAME `uiShotsFixture.mjs` the
 * desktop target screenshots from, instead of `verify-mobile.mjs`'s own per-row literals.
 *
 * Stands in for `apps/server`: a real `@tm/web` build talks to it over real HTTP, and
 * `HttpTransport` (`apps/web/src/board/httpTransport.ts`) relays every `invoke()` through
 * `POST /v1/commands` + `GET /v1/results`, exactly as it would a real desktop Client — see
 * `verify-mobile.mjs`'s own header for why both sides of this boundary are faked but
 * `@tm/web`'s bundle, `localStorage` and the DOM in between never are.
 *
 * `/v1/board`'s `deltas` is the one path that does NOT go through `handleIpcInvoke`: it reads
 * `state.tasks`/`state.projects` directly, the same two Maps `board:tasks`/`project:list`
 * answer from on the desktop side (`apiStub.mjs`) — both targets end up looking at one fixture,
 * just reached by a different door.
 */
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { serveStatic } from './cdp.mjs';
import { taskBundle } from './taskBundle.mjs';

const CADENCE = { tier: 'active', intervalMs: 500, reason: 'ui-shots' };
const DESKTOP_CLIENT_ID = 'fake-desktop-1';

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * `uiShotsFixture.mjs`'s `BOOT_CHANNELS` bucket scheme, read the same way `apiStub.mjs` reads
 * it for `window.api` — a fixed value, a `{ byArgTable, fallback }` lookup, or the
 * `'list'`/`'null'` fallback. Channels with real mutation behaviour (`attention:answer`,
 * `task:chat`, the review pipeline) are handled explicitly in `handleIpcInvoke` below, before
 * this is ever consulted — unless a row's `channelOverrides` names the channel (see there).
 *
 * A per-arg spec may name `argIndex`, the position of the argument it keys on (`0` when
 * omitted) — the same spec shape `apiStub.mjs`'s `partitionChannels` reads, so one row's
 * overrides mean the same thing on either target.
 */
export function answerFromBootChannels(bootChannels, channel, args) {
  const spec = bootChannels[channel];
  if (spec === undefined) return undefined;
  if (spec === 'list') return [];
  if (spec === 'null') return null;
  if (spec && typeof spec === 'object' && spec.byArgTable !== undefined) {
    const key = args[spec.argIndex ?? 0];
    return Object.prototype.hasOwnProperty.call(spec.byArgTable, key)
      ? spec.byArgTable[key]
      : spec.fallback;
  }
  return spec;
}

/**
 * `state` is this relay's whole seeded mirror — `tasks`/`projects` as `Map`s (what `/v1/board`
 * streams as deltas), plus the mutation logs `verify-mobile.mjs`'s own checklist rows asserted
 * against (`answeredLog`, `reviewSendLog`, …), kept here so a caller that wants to assert on a
 * mutation still can.
 */
function buildState(fixture) {
  // The merged `board:tasks` the desktop target answers from (board + sidebar + archived
  // tickets), not `boardShotsFixture.mjs`'s `TASKS` alone — or the web's mirror misses every
  // task another `shots/*.mjs` file contributes, and its status bar counts fewer running.
  const boardTasks = fixture.BOOT_CHANNELS?.['board:tasks'];
  const seed = Array.isArray(boardTasks) ? boardTasks : fixture.TASKS;
  const tasks = new Map(seed.map((t) => [t.id, { ...t }]));
  const projects = new Map(fixture.PROJECTS.map(({ project }) => [project.id, { ...project }]));
  return {
    tasks,
    projects,
    boardCursor: 0,
    attentionItems: [],
    reviewComments: new Map(),
    diffSummaries: new Map(),
    diffFiles: new Map(),
    // A `'web'` row's own `channelOverrides` (`ui-shots.mjs`), reset per row by the caller.
    channelOverrides: {},
    desktopUnreachable: false,
    refreshTokenValid: true,
    commandResults: [],
    answeredLog: [],
    dismissedLog: [],
    chatLog: [],
    reviewSendLog: [],
    requestLog: [],
  };
}

/**
 * A row's `state.channelOverrides` win over everything, the explicit cases below included — a
 * row that seeds `task:diffSummary` means its own answer, not the empty mutation map's.
 */
export function handleIpcInvoke(state, fixture, channel, args) {
  const overridden = answerFromBootChannels(state.channelOverrides ?? {}, channel, args);
  if (overridden !== undefined) return { ok: true, value: overridden };
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
      if (comment) {
        const { decision, ...rest } = patch;
        Object.assign(comment, rest, decisionStamps(comment, patch, Date.now()), {
          updatedAt: Date.now(),
        });
      }
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
      // Only what `ReviewService.send` would send: unsent, not dismissed, human or accepted.
      const at = Date.now();
      const stamped = [];
      const list = (state.reviewComments.get(taskId) ?? []).map((c) => {
        if (!isSendableDraft(c)) return c;
        const sent = { ...c, sentAt: at };
        stamped.push(sent);
        return sent;
      });
      state.reviewComments.set(taskId, list);
      state.reviewSendLog.push({ taskId, note: note ?? null, at });
      return { ok: true, value: { status: 'sent', taskId, runId: 'run-1', comments: stamped } };
    }
    case 'task:move': {
      const [taskId, toColumn] = args;
      const task = state.tasks.get(taskId);
      if (!task) return { ok: false, error: `fake relay: unknown task ${taskId}` };
      task.status = toColumn === 'todo' ? 'pending' : toColumn;
      return { ok: true, value: task };
    }
    case 'task:get': {
      const rows = state.channelOverrides?.['board:tasks'];
      return {
        ok: true,
        value: taskBundle(Array.isArray(rows) ? rows : [...state.tasks.values()], args[0]),
      };
    }
    default: {
      const fromFixture = answerFromBootChannels(fixture.BOOT_CHANNELS, channel, args);
      if (fromFixture !== undefined) return { ok: true, value: fromFixture };
      return { ok: false, error: `fake relay: unhandled channel ${channel}` };
    }
  }
}

/** `isSendableDraft` from `@tm/shared`'s review.ts, restated: plain .mjs cannot import the TS source. */
function isSendableDraft(c) {
  return c.sentAt === null && c.dismissedAt == null && (c.origin !== 'ai' || c.acceptedAt != null);
}

/** The stamps `ReviewService.update` writes for an AI draft's patch; none on a human draft. */
function decisionStamps(comment, patch, now) {
  if (comment.origin !== 'ai') return {};
  const stamps = {};
  if (patch.body !== undefined) Object.assign(stamps, { acceptedAt: now, dismissedAt: null });
  if (patch.decision === 'accept') Object.assign(stamps, { acceptedAt: now, dismissedAt: null });
  if (patch.decision === 'dismiss') Object.assign(stamps, { acceptedAt: null, dismissedAt: now });
  if (patch.decision === 'restore') stamps.dismissedAt = null;
  return stamps;
}

/**
 * Starts the relay. `webOutDir` is the built `@tm/web` bundle's output directory — every GET
 * that isn't one of the routes below falls through to `serveStatic` against it, same as
 * `verify-mobile.mjs`. `settingsOverrides` merges over `fixture`'s own `SETTINGS_OVERRIDES` for
 * `GET /v1/settings`'s answer, mirroring `apiStub.mjs`'s merge for the desktop target.
 */
export async function startFakeRelay({
  fixture,
  webOutDir,
  defaultSettings,
  settingsOverrides = {},
}) {
  const state = buildState(fixture);
  // Kept on `state` (read by `GET /v1/settings` below) rather than closed over as a local
  // const — this relay stays up across every `'web'` row `ui-shots.mjs` drives, and `appearance`
  // is the one field that differs row to row (light vs dark); `state.settings.appearance = …`
  // lets the caller flip it between rows without restarting the relay or rebuilding `@tm/web`.
  state.settings = {
    ...defaultSettings,
    ...fixture.SETTINGS_OVERRIDES,
    ...settingsOverrides,
    board: { ...defaultSettings.board, hiddenColumns: [], ...(settingsOverrides.board ?? {}) },
  };

  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url, 'http://127.0.0.1');
      const pathname = url.pathname;
      state.requestLog.push({ method: req.method, pathname, at: Date.now() });

      if (req.method === 'POST' && pathname === '/oidc/token') {
        const params = new URLSearchParams(await readBody(req));
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
        const outcome = handleIpcInvoke(state, fixture, channel, args);
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
        res.end(JSON.stringify({ settings: state.settings }));
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
        serveStatic(webOutDir, pathname, res);
        return;
      }

      res.writeHead(404);
      res.end();
    })().catch((err) => {
      console.error('fake relay error', err);
      res.writeHead(500);
      res.end();
    });
  });

  const port = await new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
    server.on('error', reject);
  });
  return { server, port, state };
}
