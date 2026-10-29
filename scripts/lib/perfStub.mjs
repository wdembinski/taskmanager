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

/**
 * What each modelled channel emits after resolving, read from `apps/client/src/main/ipc.ts`
 * and `scheduler.ts` (2026-10-29). `tasksChanged` is a `tasks:changed` delta (F29.2, main's
 * `pushTaskDelta`), modelled for now as the WHOLE board upserted — what main sends for a board
 * it holds no snapshot of — until F29.2's measuring step narrows it to the cards that changed.
 *
 * - `attention:answer` → `scheduler.answerAttention`; approving a plan runs `approvePlan`,
 *   which calls the `setTasksChangedNotifier` callback (`ipc.ts:799`) → `tasksChanged`, and the
 *   resolved item goes out as `attention:resolved { id }` (`ipc.ts:758`).
 * - `task:move` → `task:changed { task, runId: null }` only (`ipc.ts:5410`), answering the
 *   moved task. No `tasksChanged`.
 * - `task:create`, `task:delete`, `task:addSubtask`, `task:updateSubtask`, `task:setBoard`,
 *   `task:startVariants`, `variants:pick`, `task:restore`, `ticket:create`, `jira:createTask`,
 *   `issues:import`, `archive:apply`, `archive:restore` → `tasksChanged`. None of the five
 *   interactions calls them; they are modelled so a later interaction that does is not
 *   silently measured without its event.
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

/** Same arguments as `buildApiStub`, plus the `projectId` every modelled event names. */
export function buildPerfStub({ projectId, ...stubOptions }) {
  const base = buildApiStub(stubOptions);
  return `${base}
(function(){
  const PROJECT_ID = ${JSON.stringify(projectId)};
  const TASKS_CHANGED = new Set(${JSON.stringify(TASKS_CHANGED_CHANNELS)});
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

  const allTasks = () => base.invoke('board:tasks');

  async function modelEmits(channel, args, result) {
    if (channel === 'attention:answer') emit('attention:resolved', { id: args[0] });
    if (TASKS_CHANGED.has(channel)) {
      emit('tasks:changed', { projectId: PROJECT_ID, upserted: await allTasks(), removed: [] });
    }
    if (channel === 'task:move' && result) emit('task:changed', { task: result, runId: null });
  }

  async function answer(channel, args) {
    if (channel === 'attention:answer') {
      resolvedItems.add(args[0]);
      return undefined;
    }
    if (channel === 'task:move') {
      const [taskId, toColumn] = args;
      const task = (await allTasks()).find((t) => t.id === taskId);
      if (!task) throw new Error('Task not found.');
      // A column is named after its resting status, except To Do's (\`pending\`). Where the
      // card RESTS moves; a live run keeps the status it borrowed.
      const status = toColumn === 'todo' ? 'pending' : toColumn;
      return task.preRunStatus ? { ...task, preRunStatus: status } : { ...task, status };
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
