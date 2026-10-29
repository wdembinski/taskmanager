/**
 * Measures the real desktop renderer on a big board (F29.1, `docs/plan/feature-roadmap/
 * F29-performance-at-scale.md` Phase 1) against a 16 ms (one frame) budget:
 *
 *     node scripts/perf-board.mjs [--cards 5000] [--runs 3] [--json out.json] [--enforce]
 *
 * Builds `@tm/client`'s renderer (`lib/uiDriver.mjs`'s `buildClientRenderer`), serves it
 * statically, and boots it in headless Chrome at 1440×900 over `scaleFixture.mjs`'s seeded
 * board of `--cards` task rows. Main is modelled, never launched: `lib/perfStub.mjs` wraps
 * `apiStub.mjs`'s `window.api` so every invoke is recorded, listeners are kept, and the
 * channels that change state emit what main's handlers `send` today:
 *
 * - `attention:answer` → `attention:resolved` + `project:tasksChanged` with the whole board;
 * - `task:move` → `task:changed` with the moved card;
 * - the other `project:tasksChanged` senders listed in `perfStub.mjs`'s
 *   `TASKS_CHANGED_CHANNELS` → `project:tasksChanged` with the whole board.
 *
 * Each run is one fresh load, then six interactions in order. Each is armed (buffers cleared),
 * acted, and then waited on until the page has been quiet for 500 ms — no frame gap over
 * `SLOW_FRAME_MS`, no IPC, no event — capped at 10 s:
 *
 * 1. `open-card` — clicks the approval card (`board-card:sc-1`); lands when "Approve plan" shows.
 * 2. `approve` — clicks "Approve plan"; lands when `attention:answer` was invoked.
 * 3. `drag-card` — a synthetic HTML5 drag (dragstart → dragover → drop → dragend, one shared
 *    `DataTransfer`) of the first To Do card into In Progress; lands when `task:move` was invoked.
 * 4. `scroll-column` — about 3,000 px of CDP `mouseWheel` over the To Do column, in 100 px
 *    steps. The columns do not scroll on their own: the wheel scrolls the board around them.
 * 5. `scroll-issues` — opens Tickets (not measured), then the same wheel over the issue list.
 * 6. `expand-group` — folds the sidebar group with the most tickets (not measured), then
 *    clicks it open; lands when it reads `aria-expanded="true"`.
 *
 * Reported per interaction, as the median over `--runs`:
 *
 * - longest task — the larger of the longest `longtask` entry (Chrome reports 50 ms and up)
 *   and the longest frame gap, which catches the 16–50 ms range;
 * - longest frame gap and the long-task count. Long tasks come from the APP's own observer
 *   (`perfObserver.ts`, through `window.api.logPerf`), not one this script installs;
 * - IPC in — bytes of every invoke result; events — bytes of every emitted event;
 * - verdict — `over` when a long task was seen or a frame gap passed `SLOW_FRAME_MS` (one
 *   frame plus vsync jitter: an idle page already shows 16.7 ms gaps at 60 Hz).
 *
 * Exits 0 even when over budget, unless `--enforce` is passed. Exits 1 on any harness
 * failure — a click that missed, a page exception, an interaction that never settled — since
 * a report built on a missed click is not a measurement.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
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
  setViewport,
  startStaticServer,
  waitFor,
} from './lib/cdp.mjs';
import { buildPerfStub, SLOW_FRAME_MS } from './lib/perfStub.mjs';
import { PAGE_HELPERS_SRC, boardCardClickExprs, buildClientRenderer } from './lib/uiDriver.mjs';
import {
  buildScaleFixture,
  SCALE_APPROVE_TASK_ID,
  SCALE_PROJECT_ID,
} from './fixtures/scaleFixture.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const BUDGET_MS = 16;
const QUIET_MS = 500;
const SETTLE_CAP_MS = 10_000;
const SCROLL_PX = 3000;
const WHEEL_STEP_PX = 100;
const VIEWPORT = { width: 1440, height: 900 };

function parseArgs(argv) {
  const opts = { cards: 5000, runs: 3, json: null, enforce: false };
  const positive = (flag, raw) => {
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1) throw new Error(`${flag} must be a positive integer`);
    return n;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--cards') opts.cards = positive(arg, argv[++i]);
    else if (arg === '--runs') opts.runs = positive(arg, argv[++i]);
    else if (arg === '--json') opts.json = argv[++i];
    else if (arg === '--enforce') opts.enforce = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return opts;
}

/** A failure of the harness itself, as opposed to a slow app. */
class HarnessError extends Error {}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitUntil(cdp, expr, label, timeoutMs = SETTLE_CAP_MS) {
  try {
    await waitFor(async () => (await evaluate(cdp, expr)) === true, { timeoutMs, label });
  } catch (e) {
    throw new HarnessError(e.message);
  }
}

/** Waits until the page has been quiet for `QUIET_MS` (see the header), capped. */
async function waitForSettled(cdp, label) {
  const deadline = Date.now() + SETTLE_CAP_MS;
  for (;;) {
    const quiet = await evaluate(cdp, 'window.__perf.quietFor()');
    if (quiet >= QUIET_MS) return;
    if (Date.now() > deadline) throw new HarnessError(`${label} never settled within 10 s`);
    await sleep(50);
  }
}

/** Unmeasured setup between interactions: wait for the page to calm down first. */
async function settleUnarmed(cdp, label) {
  await evaluate(cdp, 'window.__perf.arm()');
  await waitForSettled(cdp, label);
  await evaluate(cdp, 'window.__perf.read()');
}

async function clickOrFail(cdp, { ready, click }, label) {
  await waitUntil(cdp, ready, `${label} to appear`);
  if (!(await evaluate(cdp, click))) throw new HarnessError(`could not click ${label}`);
}

/** The scrollable element at or around `selector`'s first match: itself, its first scrollable
 *  descendant, or its nearest scrollable ancestor — tagged so the wheel and the check after it
 *  both find the same one. */
function tagScrollerExpr(selector) {
  return `(() => {
    const start = document.querySelector(${JSON.stringify(selector)});
    if (!start) return null;
    const scrolls = (el) => {
      const s = getComputedStyle(el).overflowY;
      return (s === 'auto' || s === 'scroll') && el.scrollHeight > el.clientHeight + 1;
    };
    let el = scrolls(start) ? start : Array.from(start.querySelectorAll('*')).find(scrolls);
    for (let a = start.parentElement; !el && a; a = a.parentElement) if (scrolls(a)) el = a;
    if (!el) return null;
    document.querySelectorAll('[data-perf-scroller]').forEach((n) => n.removeAttribute('data-perf-scroller'));
    el.setAttribute('data-perf-scroller', '');
    el.scrollTop = 0;
    // Over 'start' where it overlaps the scroller and the viewport, so the wheel lands on
    // the column it names even when the scroller is the whole board.
    const a = start.getBoundingClientRect();
    const b = el.getBoundingClientRect();
    const left = Math.max(a.left, b.left, 0);
    const right = Math.min(a.right, b.right, innerWidth);
    const top = Math.max(b.top, 0);
    const bottom = Math.min(b.bottom, innerHeight);
    if (right <= left || bottom <= top) return null;
    const x = (left + right) / 2;
    const y = (top + bottom) / 2;
    return { x, y, room: el.scrollHeight - el.clientHeight };
  })()`;
}

async function wheelScroll(cdp, point) {
  for (let moved = 0; moved < SCROLL_PX; moved += WHEEL_STEP_PX) {
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x: point.x,
      y: point.y,
      deltaX: 0,
      deltaY: WHEEL_STEP_PX,
    });
    await sleep(16);
  }
}

const SCROLLED_EXPR = `(document.querySelector('[data-perf-scroller]')?.scrollTop ?? 0)`;

const invoked = (m, channel) => m.ipc.some((r) => r.channel === channel);

/** Every interaction: `prepare` (unmeasured, optional), `act` (measured), and `check`, which
 *  throws a `HarnessError` when the act did not land. */
const INTERACTIONS = [
  {
    name: 'open-card',
    async act(cdp) {
      const exprs = boardCardClickExprs(SCALE_APPROVE_TASK_ID);
      await waitUntil(cdp, exprs.ready, `board-card:${SCALE_APPROVE_TASK_ID} to appear`);
      // Scrolled into view before arming, so the measured click is only the click.
      await evaluate(
        cdp,
        `document.querySelector('[data-task-id="${SCALE_APPROVE_TASK_ID}"]').scrollIntoView({ block: 'center' })`,
      );
      await settleUnarmed(cdp, 'open-card prepare');
      await evaluate(cdp, 'window.__perf.arm()');
      if (!(await evaluate(cdp, exprs.click))) {
        throw new HarnessError(`could not click board-card:${SCALE_APPROVE_TASK_ID}`);
      }
    },
    async check(cdp) {
      await waitUntil(cdp, `!!window.__tm.findByText('Approve plan', true)`, '"Approve plan"');
    },
  },
  {
    name: 'approve',
    async act(cdp) {
      await evaluate(cdp, 'window.__perf.arm()');
      if (!(await evaluate(cdp, `window.__tm.clickText('Approve plan', true)`))) {
        throw new HarnessError('could not click "Approve plan"');
      }
    },
    check(_cdp, m) {
      if (!invoked(m, 'attention:answer')) {
        throw new HarnessError('"Approve plan" never invoked attention:answer');
      }
    },
  },
  {
    name: 'drag-card',
    async act(cdp) {
      const dragged = await evaluate(
        cdp,
        `(async () => {
          const card = document.querySelector('[data-board-column="todo"] [data-task-id][draggable="true"]');
          const target = document.querySelector('[data-board-column="in-progress"]');
          if (!card || !target) return null;
          const frame = () => new Promise((r) => requestAnimationFrame(() => r()));
          window.__perf.arm();
          const dt = new DataTransfer();
          const fire = (el, type) =>
            el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
          fire(card, 'dragstart');
          await frame();
          fire(target, 'dragenter');
          fire(target, 'dragover');
          await frame();
          fire(target, 'drop');
          fire(card, 'dragend');
          return card.getAttribute('data-task-id');
        })()`,
      );
      if (!dragged) throw new HarnessError('no draggable To Do card or no In Progress column');
    },
    check(_cdp, m) {
      if (!invoked(m, 'task:move')) throw new HarnessError('the drop never invoked task:move');
    },
  },
  {
    name: 'scroll-column',
    async act(cdp) {
      const point = await evaluate(cdp, tagScrollerExpr('[data-board-column="todo"]'));
      if (!point || point.room < SCROLL_PX / 2) {
        throw new HarnessError('the To Do column has no scroll region to wheel');
      }
      await settleUnarmed(cdp, 'scroll-column prepare');
      await evaluate(cdp, 'window.__perf.arm()');
      await wheelScroll(cdp, point);
    },
    async check(cdp) {
      await waitUntil(cdp, `${SCROLLED_EXPR} > ${SCROLL_PX / 2}`, 'the To Do column to scroll');
    },
  },
  {
    name: 'scroll-issues',
    async act(cdp) {
      await clickOrFail(
        cdp,
        {
          ready: `!!window.__tm.findByText('Tickets', false)`,
          click: `window.__tm.clickText('Tickets', false)`,
        },
        '"Tickets"',
      );
      await waitUntil(
        cdp,
        `document.querySelectorAll('[role="option"]').length > 20`,
        'issue rows',
      );
      await settleUnarmed(cdp, 'scroll-issues prepare');
      const point = await evaluate(cdp, tagScrollerExpr('[role="option"]'));
      if (!point || point.room < SCROLL_PX / 2) {
        throw new HarnessError('the issue list has no scroll region to wheel');
      }
      await evaluate(cdp, 'window.__perf.arm()');
      await wheelScroll(cdp, point);
    },
    async check(cdp) {
      await waitUntil(cdp, `${SCROLLED_EXPR} > ${SCROLL_PX / 2}`, 'the issue list to scroll');
    },
  },
  {
    name: 'expand-group',
    async act(cdp) {
      // The group holding the most tickets: a milestone's count reads "open/total".
      const tag = `(() => {
        const rows = Array.from(document.querySelectorAll('[role="treeitem"][aria-expanded]'))
          .filter((el) => window.__tm.visible(el));
        let best = null;
        let bestCount = -1;
        for (const el of rows) {
          const caption = el.lastElementChild?.textContent ?? '';
          const count = Number(caption.split('/').pop());
          if (Number.isFinite(count) && count > bestCount) {
            best = el;
            bestCount = count;
          }
        }
        if (!best) return null;
        document.querySelectorAll('[data-perf-group]').forEach((n) => n.removeAttribute('data-perf-group'));
        best.setAttribute('data-perf-group', '');
        best.scrollIntoView({ block: 'start' });
        return bestCount;
      })()`;
      await waitUntil(
        cdp,
        `!!document.querySelector('[role="treeitem"][aria-expanded]')`,
        'a sidebar group',
      );
      const count = await evaluate(cdp, tag);
      if (count === null) throw new HarnessError('no sidebar group to expand');
      const group = `document.querySelector('[data-perf-group]')`;
      if ((await evaluate(cdp, `${group}.getAttribute('aria-expanded')`)) === 'true') {
        await evaluate(cdp, `${group}.click()`);
        await waitUntil(
          cdp,
          `${group}?.getAttribute('aria-expanded') === 'false'`,
          'the group to fold',
        );
      }
      await settleUnarmed(cdp, 'expand-group prepare');
      await evaluate(cdp, 'window.__perf.arm()');
      await evaluate(cdp, `${group}.click()`);
    },
    async check(cdp) {
      await waitUntil(
        cdp,
        `document.querySelector('[data-perf-group]')?.getAttribute('aria-expanded') === 'true'`,
        'the sidebar group to expand',
      );
    },
  },
];

function summarize(m) {
  const longestTask = m.longtasks.reduce((a, t) => Math.max(a, t.ms), 0);
  const sum = (rows) => rows.reduce((a, r) => a + Math.max(r.bytes, 0), 0);
  return {
    longestLongTaskMs: longestTask,
    longestFrameGapMs: m.maxGap,
    longestMs: Math.max(longestTask, m.maxGap),
    longTasks: m.longtasks.length,
    ipcKB: sum(m.ipc) / 1024,
    eventsKB: sum(m.events) / 1024,
    ipcChannels: [...new Set(m.ipc.map((r) => r.channel))],
    eventChannels: [...new Set(m.events.map((r) => r.channel))],
  };
}

function median(values) {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function verdictOf(m) {
  return m.longTasks > 0 || m.longestLongTaskMs > BUDGET_MS || m.longestFrameGapMs > SLOW_FRAME_MS
    ? 'over'
    : 'ok';
}

function table(rows) {
  const head = [
    'Interaction',
    'longest task (ms)',
    'longest frame gap (ms)',
    'long tasks (count)',
    'IPC in (KB)',
    'events (KB)',
    `budget ${BUDGET_MS} ms`,
    'verdict',
  ];
  const lines = [`| ${head.join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`];
  for (const r of rows) {
    const m = r.median;
    lines.push(
      `| ${[
        r.name,
        m.longestMs.toFixed(1),
        m.longestFrameGapMs.toFixed(1),
        String(m.longTasks),
        m.ipcKB.toFixed(1),
        m.eventsKB.toFixed(1),
        String(BUDGET_MS),
        r.verdict,
      ].join(' | ')} |`,
    );
  }
  return lines.join('\n');
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const fixture = buildScaleFixture({ cards: opts.cards });
  const taskListBytes = Buffer.byteLength(JSON.stringify(fixture.TASKS));

  const scratch = mkdtempSync(join(tmpdir(), 'tm-perf-board-'));
  const chromeProfileDir = join(scratch, 'chrome-profile');
  mkdirSync(chromeProfileDir, { recursive: true });

  let serverHandle;
  let chromeProc;
  let cdp;
  const failures = [];
  const perRun = new Map(INTERACTIONS.map((i) => [i.name, []]));
  let chromeVersion = '(unknown)';

  try {
    console.log('building @tm/client renderer ...');
    const requireFromClient = createRequire(join(root, 'apps', 'client', 'noop.cjs'));
    const defaultSettings = requireFromClient('@tm/shared/settings').DEFAULT_SETTINGS;
    const outDir = join(scratch, 'client-out');
    mkdirSync(outDir, { recursive: true });
    buildClientRenderer(requireFromClient, outDir);
    const served = await startStaticServer(join(outDir, 'renderer'));
    serverHandle = served.server;
    const origin = `http://127.0.0.1:${served.port}`;

    const browserPath = findBrowser();
    const rdpPort = await getFreePort();
    chromeProc = launchChrome(browserPath, rdpPort, {
      profileDir: chromeProfileDir,
      windowSize: VIEWPORT,
    });
    await waitFor(async () => (await fetch(`http://127.0.0.1:${rdpPort}/json/version`)).ok, {
      timeoutMs: 20000,
      intervalMs: 300,
      label: 'Chrome DevTools endpoint',
    });
    chromeVersion = (await (await fetch(`http://127.0.0.1:${rdpPort}/json/version`)).json())
      .Browser;
    const tabInfo = await openTab(rdpPort, 'about:blank');
    cdp = await connectCdp(tabInfo.webSocketDebuggerUrl);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    const exceptions = collectExceptions(cdp);
    await setViewport(cdp, VIEWPORT.width, VIEWPORT.height);

    const initScript = `${PAGE_HELPERS_SRC}\n${buildPerfStub({
      projectId: SCALE_PROJECT_ID,
      defaultSettings,
      fixture,
      settingsOverrides: { appearance: 'light', transparency: 'reduced', fontSizePx: 14 },
    })}`;

    for (let run = 1; run <= opts.runs; run++) {
      console.log(`run ${run}/${opts.runs}: loading ${opts.cards} cards ...`);
      exceptions.count = 0;
      try {
        await freshLoad(cdp, origin, initScript);
        await waitUntil(
          cdp,
          `!!document.querySelector('[data-board-column="todo"] [data-task-id]')`,
          'the board to render',
          60_000,
        );
        await settleUnarmed(cdp, 'boot');
        for (const interaction of INTERACTIONS) {
          await interaction.act(cdp);
          await waitForSettled(cdp, interaction.name);
          const measured = await evaluate(cdp, 'window.__perf.read()');
          await interaction.check(cdp, measured);
          if (exceptions.count > 0) {
            throw new HarnessError(
              `${exceptions.count} page exception(s) during ${interaction.name}`,
            );
          }
          const s = summarize(measured);
          perRun.get(interaction.name).push(s);
          console.log(
            `  ${interaction.name}: ${s.longestMs.toFixed(1)} ms, ${s.longTasks} long task(s), ` +
              `ipc [${s.ipcChannels.join(', ')}], events [${s.eventChannels.join(', ')}]`,
          );
        }
      } catch (e) {
        failures.push(`run ${run}: ${e.message}`);
        console.error(`run ${run} failed:`, e.message);
        break;
      }
    }
  } finally {
    try {
      cdp?.close();
    } catch {
      // already closed
    }
    killBrowser(chromeProc);
    serverHandle?.close();
  }

  const rows = INTERACTIONS.filter((i) => perRun.get(i.name).length > 0).map((i) => {
    const runs = perRun.get(i.name);
    const keys = [
      'longestLongTaskMs',
      'longestFrameGapMs',
      'longestMs',
      'longTasks',
      'ipcKB',
      'eventsKB',
    ];
    const med = Object.fromEntries(keys.map((k) => [k, median(runs.map((r) => r[k]))]));
    return { name: i.name, runs, median: med, verdict: verdictOf(med) };
  });

  const appLongTasks = rows.reduce((a, r) => a + r.runs.reduce((b, s) => b + s.longTasks, 0), 0);
  console.log('');
  console.log(
    `cards: ${opts.cards} · task list JSON: ${(taskListBytes / 1024 / 1024).toFixed(2)} MB · ` +
      `runs: ${opts.runs} (median) · Chrome: ${chromeVersion}`,
  );
  console.log(`long tasks reported by the app's own observer: ${appLongTasks}`);
  console.log('');
  console.log(table(rows));

  if (opts.json) {
    const jsonPath = resolve(process.cwd(), opts.json);
    writeFileSync(
      jsonPath,
      JSON.stringify(
        {
          cards: opts.cards,
          taskListBytes,
          runs: opts.runs,
          chrome: chromeVersion,
          budgetMs: BUDGET_MS,
          slowFrameMs: SLOW_FRAME_MS,
          interactions: rows,
          failures,
        },
        null,
        2,
      ),
    );
    console.log(`\nwrote ${jsonPath}`);
  }

  if (failures.length > 0) {
    console.error(`\nharness failure — no valid measurement:\n  ${failures.join('\n  ')}`);
    process.exitCode = 1;
  } else if (opts.enforce && rows.some((r) => r.verdict === 'over')) {
    console.error('\nover budget (--enforce)');
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
