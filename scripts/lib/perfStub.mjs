/**
 * `perf-board.mjs`'s `window.api` (F29.1): `apiStub.mjs`'s stub, wrapped so the real renderer
 * can be timed against a modelled main process. `buildApiStub` itself is left alone, so
 * `ui-shots.mjs` boots exactly as before.
 *
 * On top of the plain stub, the wrapper:
 *
 * - turns `boot.perfLog` on, so `main.tsx` installs the app's own long-task observer, and
 *   gives it `logPerf(entry)`, which pushes into `window.__perf.longtasks` — the path
 *   `perfObserver.ts` → `window.api.logPerf` runs end to end, just ending in the page instead
 *   of `main.log`;
 * - keeps `on(channel, cb)` listeners (the plain stub drops them) and returns an unsubscriber;
 * - answers every `invoke` with a `structuredClone` of the stub's answer — Electron hands the
 *   renderer a freshly deserialised copy too, and a shared reference would let React bail out
 *   of a re-render the real app pays for — and records `{ channel, value }` into
 *   `window.__perf.ipc`, sized only when read (`window.__perf.read`), so measuring adds no
 *   `JSON.stringify` to the interaction it measures;
 * - after a modelled channel resolves, emits what main's handler `send`s today (below), each a
 *   fresh clone, recorded into `window.__perf.events`;
 * - runs a `requestAnimationFrame` sampler that, while armed, keeps the longest frame gap and
 *   the time of the last slow one (`waitForSettled` in `perf-board.mjs` waits on it).
 *
 * Every byte count is the UTF-8 length of the value's JSON, the same measure `perfLog.ts`'s
 * `payloadBytes` logs from main.
 */
import { buildApiStub } from './apiStub.mjs';
import { task as taskRow } from '../fixtures/boardShotsFixture.mjs';

/**
 * What each modelled channel answers and emits, read from `apps/client/src/main/ipc.ts` and
 * `scheduler.ts` (F29.2, 2026-10-29). Main answers `board:tasks` with card summaries
 * (`toTaskSummary`) and one card in full through `task:get` (`{ task, parent, steps }`). After
 * an action it pushes a `tasks:changed` delta (`pushTaskDelta`) holding only the cards that
 * changed, as summaries, and `send()` maps every `task:changed` to its summary.
 *
 * - `attention:answer` → `scheduler.answerAttention`; approving a plan runs `approvePlan`,
 *   which adds the plan's steps, moves the card to In Progress and calls `tasksChanged` — a
 *   delta upserting the card and its new steps. The resolved item goes out as
 *   `attention:resolved { id }`. Modelled for the fixture's approval item on `approveTaskId`,
 *   one step per entry of its `steps`.
 * - `task:move` → `task:changed { task, runId: null }` only, the moved card as a summary; the
 *   invoke answers the moved card in full. No delta.
 * - `task:create`, `task:delete`, `task:addSubtask`, `task:updateSubtask`, `task:setBoard`,
 *   `task:startVariants`, `variants:pick`, `task:restore`, `ticket:create`, `jira:createTask`,
 *   `issues:import`, `archive:apply`, `archive:restore` → a delta. None of the six
 *   interactions calls them; they are modelled — the returned card upserted, a deleted card
 *   and its steps removed — so a later interaction that does is not silently measured
 *   without its event.
 */
export const TASKS_CHANGED_CHANNELS = [
  'attention:answer',
  'task:create',
  'task:delete',
  'task:addSubtask',
  'task:updateSubtask',
  'task:setBoard',
  'task:startVariants',
  'variants:pick',
  'task:restore',
  'ticket:create',
  'jira:createTask',
  'issues:import',
  'archive:apply',
  'archive:restore',
];

/**
 * A frame gap longer than this counts as a dropped frame: the 16 ms budget plus vsync
 * jitter, since one frame at 60 Hz is already 16.7 ms and an idle page never paints faster.
 */
export const SLOW_FRAME_MS = 20;

/**
 * What approving `approveTaskId`'s plan leaves behind, in full rows: the card, moved to In
 * Progress with its borrowed status given back, and one pending step per planned step.
 */
function approvedRows(fixture, approveTaskId) {
  const card = fixture.TASKS_BY_ID[approveTaskId];
  const item = (fixture.BOOT_CHANNELS['attention:list'] ?? []).find(
    (i) => i.taskId === approveTaskId && i.kind === 'plan-approval',
  );
  if (!card || !item) return null;
  const steps = (item.steps ?? []).map((title, i) =>
    taskRow({
      id: `${approveTaskId}-p${i + 1}`,
      projectId: card.projectId,
      parentTaskId: card.id,
      title,
      order: i,
      planRound: 1,
    }),
  );
  return { itemId: item.id, card: { ...card, status: 'in-progress', preRunStatus: null }, steps };
}

/**
 * Same arguments as `buildApiStub`, plus the `projectId` every modelled event names, the card
 * whose plan Approve approves, and `@tm/shared/taskSummary`'s `toTaskSummary` and
 * `TASK_SUMMARY_KEYS` — passed in the way `defaultSettings` is, so the stub summarises exactly
 * as main does. `board:tasks` answers the fixture's rows as summaries; the full rows back
 * `task:get` and `task:move`.
 */
export function buildPerfStub({
  projectId,
  approveTaskId,
  toTaskSummary,
  summaryKeys,
  fixture,
  ...stubOptions
}) {
  const base = buildApiStub({
    ...stubOptions,
    fixture: {
      ...fixture,
      BOOT_CHANNELS: {
        ...fixture.BOOT_CHANNELS,
        'board:tasks': fixture.BOOT_CHANNELS['board:tasks'].map(toTaskSummary),
      },
    },
  });
  return `${base}
(function(){
  const PROJECT_ID = ${JSON.stringify(projectId)};
  const TASKS_CHANGED = new Set(${JSON.stringify(TASKS_CHANGED_CHANNELS)});
  const SUMMARY_KEYS = ${JSON.stringify(summaryKeys)};
  const TASKS_BY_ID = ${JSON.stringify(fixture.TASKS_BY_ID)};
  const APPROVED = ${JSON.stringify(approvedRows(fixture, approveTaskId))};
  const SLOW_FRAME_MS = ${SLOW_FRAME_MS};
  const base = window.api;
  const listeners = new Map();
  const resolvedItems = new Set();

  const perf = {
    armed: false,
    armedAt: 0,
    lastActivityAt: 0,
    maxGap: 0,
    lastFrame: 0,
    ipc: [],
    events: [],
    longtasks: [],
    arm() {
      perf.ipc = [];
      perf.events = [];
      perf.maxGap = 0;
      perf.armedAt = performance.now();
      perf.lastActivityAt = perf.armedAt;
      perf.lastFrame = 0;
      perf.armed = true;
    },
    /** Milliseconds since the last slow frame, IPC call or event (or since arming). */
    quietFor() {
      return performance.now() - perf.lastActivityAt;
    },
    read() {
      const enc = new TextEncoder();
      const bytes = (v) => (v === undefined ? 0 : enc.encode(JSON.stringify(v)).length);
      const tasks = perf.longtasks.filter((t) => t.at >= perf.armedAt);
      const out = {
        maxGap: perf.maxGap,
        longtasks: tasks.map((t) => ({ screen: t.screen, ms: t.ms })),
        ipc: perf.ipc.map((r) => ({ channel: r.channel, bytes: bytes(r.value) })),
        events: perf.events.map((r) => ({ channel: r.channel, bytes: bytes(r.payload) })),
      };
      perf.armed = false;
      return out;
    },
  };
  window.__perf = perf;

  const touch = () => {
    if (perf.armed) perf.lastActivityAt = performance.now();
  };

  const frame = (now) => {
    if (perf.armed) {
      if (perf.lastFrame > 0) {
        const gap = now - perf.lastFrame;
        if (gap > perf.maxGap) perf.maxGap = gap;
        if (gap > SLOW_FRAME_MS) perf.lastActivityAt = performance.now();
      }
      perf.lastFrame = now;
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);

  const emit = (channel, payload) => {
    if (perf.armed) perf.events.push({ channel, payload });
    touch();
    for (const cb of Array.from(listeners.get(channel) ?? [])) {
      try {
        cb(structuredClone(payload));
      } catch (e) {
        console.error('perf stub listener for ' + channel + ' threw', e);
      }
    }
  };

  // \`toTaskSummary\` over the shared key list: the summary keys only, \`undefined\` omitted.
  const summarize = (task) => {
    const out = {};
    for (const key of SUMMARY_KEYS) if (task[key] !== undefined) out[key] = task[key];
    return out;
  };
  const isTask = (v) =>
    !!v && typeof v === 'object' && typeof v.id === 'string' && 'projectId' in v;

  // The board as main holds it: the fixture's summaries with every modelled change applied,
  // so a re-read after Approve sees its new steps, as \`board:tasks\` from main would.
  let boardSummaries = null;
  const board = async () => (boardSummaries ??= await base.invoke('board:tasks'));
  const upsert = async (rows) => {
    const list = await board();
    for (const row of rows) {
      TASKS_BY_ID[row.id] = row;
      const summary = summarize(row);
      const at = list.findIndex((t) => t.id === row.id);
      if (at >= 0) list[at] = summary;
      else list.push(summary);
    }
  };
  const delta = (upserted, removed) =>
    emit('tasks:changed', { projectId: PROJECT_ID, upserted: upserted.map(summarize), removed });

  async function modelEmits(channel, args, result) {
    if (channel === 'attention:answer') {
      emit('attention:resolved', { id: args[0] });
      if (APPROVED && args[0] === APPROVED.itemId) {
        const rows = [APPROVED.card, ...APPROVED.steps];
        await upsert(rows);
        delta(rows, []);
      }
      return;
    }
    if (channel === 'task:delete') {
      const id = args[0];
      const gone = Object.values(TASKS_BY_ID).filter((t) => t.id === id || t.parentTaskId === id);
      if (gone.length > 0) delta([], gone.map((t) => t.id));
      return;
    }
    if (TASKS_CHANGED.has(channel)) {
      const rows = (Array.isArray(result) ? result : [result]).filter(isTask);
      if (rows.length > 0) {
        await upsert(rows);
        delta(rows, []);
      }
      return;
    }
    if (channel === 'task:move' && result) {
      emit('task:changed', { task: summarize(result), runId: null });
    }
  }

  async function answer(channel, args) {
    if (channel === 'attention:answer') {
      resolvedItems.add(args[0]);
      return undefined;
    }
    if (channel === 'board:tasks') return board();
    if (channel === 'task:get') {
      const task = TASKS_BY_ID[args[0]];
      if (!task) return null;
      const parent = task.parentTaskId ? (TASKS_BY_ID[task.parentTaskId] ?? null) : null;
      const steps = Object.values(TASKS_BY_ID)
        .filter((t) => t.parentTaskId === task.id)
        .sort((a, b) => a.order - b.order);
      return { task, parent, steps };
    }
    if (channel === 'task:move') {
      const [taskId, toColumn] = args;
      const task = TASKS_BY_ID[taskId];
      if (!task) throw new Error('Task not found.');
      // A column is named after its resting status, except To Do's (\`pending\`). Where the
      // card RESTS moves; a live run keeps the status it borrowed.
      const status = toColumn === 'todo' ? 'pending' : toColumn;
      const moved = task.preRunStatus ? { ...task, preRunStatus: status } : { ...task, status };
      await upsert([moved]);
      return moved;
    }
    const value = await base.invoke(channel, ...args);
    if (channel === 'attention:list' && Array.isArray(value)) {
      return value.filter((i) => !resolvedItems.has(i.id));
    }
    return value;
  }

  window.api = {
    ...base,
    boot: { ...base.boot, perfLog: true },
    async invoke(channel, ...args) {
      touch();
      const value = structuredClone(await answer(channel, args));
      if (perf.armed) perf.ipc.push({ channel, value });
      touch();
      // After the caller's own continuation, the way an event from main arrives on a later
      // task than the invoke's reply.
      setTimeout(() => void modelEmits(channel, args, value), 0);
      return value;
    },
    on(channel, cb) {
      if (!listeners.has(channel)) listeners.set(channel, new Set());
      listeners.get(channel).add(cb);
      return () => listeners.get(channel)?.delete(cb);
    },
    logPerf(entry) {
      perf.longtasks.push(entry);
      touch();
    },
  };
})();`;
}
