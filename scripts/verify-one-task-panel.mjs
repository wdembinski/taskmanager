/**
 * Headless proof of F12's one panel: an edit made the way `TaskDetail` makes it reads back
 * the same from the Backlog row and from the board card. It drives the REAL per-field patch
 * (`ticketFields.ts`'s `ticketPatchFor`), the REAL `ticket:update` and plain `ticketLink:add`
 * bodies (`apps/client/src/main/ticketIpc.ts`), and the REAL read-side helpers the panel
 * renders through (`linkedTickets.ts`'s `linkedTicketRows`/`linkAddRefusal`,
 * `ticketSummary.ts`'s `ticketSummaryLine`) against a temp database.
 *
 *     node scripts/verify-one-task-panel.mjs
 *
 * ## Why this is a script and not a test
 *
 * Same reason as `verify-milestone-outbox.mjs`, whose two-phase shape this copies:
 * `createStore` loads `better-sqlite3`'s native addon, compiled for Electron's ABI, so
 * nothing that calls it can run under the Node that runs vitest. Phase 1 bundles the
 * sources with esbuild under plain Node; phase 2 re-execs this file under Electron with
 * `ELECTRON_RUN_AS_NODE=1`. `ticketIpc.test.ts` already covers the handler bodies against a
 * fake store; this is the one proof that a real store, the real events those bodies send,
 * and the renderer's two caches agree.
 *
 * The `packages/ui` helpers are reached through a small entry generated into the scratch
 * directory, bundled with `@tm/shared` aliased to `packages/shared/src` the way
 * `verify-projects-panel.mjs` bundles its harness. The entry's import paths are written as
 * JSON strings, never inside a template literal (memory: headless-scenario-harness-traps).
 *
 * ## What it proves
 *
 * The two renderer caches are modelled the way the hooks hold them (F29.2): `backlog` is
 * `useProjectTickets`'s (`board:tasks(projectId)` summaries, then every `tasks:changed` for
 * that project merged in with `applyTaskDelta`); `board` is `MyTasks`'s All scope
 * (`board:tasks('all')`, the same deltas merged on the `'all'` scope); `panelLinks` is
 * `useTicketRegistries`'s (replaced by every `ticketLink:changed`). The deltas come from the
 * real `createTaskDeltaPusher` (`taskDelta.ts`), seeded by those two loads the way
 * `board:tasks` seeds it. Every event `createTicketIpc` sends is drained into the caches.
 *
 * Milestone: `ticketPatchFor('milestoneId', …)` produces exactly `{ milestoneId }` (and `{}`
 * for an unchanged value, which sends nothing); after `updateTicket`, the Backlog row and
 * the board card both carry the new `milestoneId`, keep their title and points, and render
 * the same `ticketSummaryLine` naming the milestone. Clearing it sends `{ milestoneId: null }`
 * and both reads drop the name.
 *
 * Links: `addPlainTicketLink` for `A relates B` is not refused, its `links` are exactly what
 * `ticketLink:changed` handed the panel, and `linkedTicketRows` gives the identical groups
 * from the Backlog's tickets and the board's — B "relates to" from A's end, A from B's.
 * `C duplicates A` reads as "is duplicated by" C from A's end, from both. The symmetric
 * mirror (`B relates A`) is refused and sends no event.
 *
 * ## Proved able to fail (2026-10-24)
 *
 * As written: 22 checks, `ALL PASS`.
 *
 * - Mutation 1, the per-field patch: `ticketPatchFor`'s `milestoneId` case returning `{}`
 *   gives `6 FAILED` — the `{ milestoneId }` and `{ milestoneId: null }` patches, both reads
 *   of M1, the summary line naming M1, and setting M1 back. Nothing is sent, so nothing moves.
 * - Mutation 2, the link refresh: `addPlainTicketLink` answering
 *   `{ status: 'ok', links: store.listTicketLinks() }` without `pushTicketLinks()` gives
 *   `6 FAILED` — both `panelLinks` checks and all four `linkedTicketRows` checks, since the
 *   panel never hears about the new rows.
 *
 * Restoring either file brings every check back to green.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const clientModules = join(root, 'apps', 'client', 'node_modules');

/** Remove the scratch directory; on failure print where it is rather than mask the error. */
function removeScratch(dir) {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  } catch (err) {
    console.error(`could not remove scratch directory ${dir}: ${err.message}`);
  }
}

/**
 * esbuild ships as a per-platform binary under a versioned `.pnpm` directory, so it is found
 * by pattern rather than by path: a dependency bump renames the directory, and hard-coding
 * one version would rot this script at the next `pnpm up`.
 */
function findEsbuild() {
  const pnpm = join(root, 'node_modules', '.pnpm');
  const target = `${process.platform}-${process.arch}`;
  const dir = readdirSync(pnpm).find((d) => d.startsWith(`@esbuild+${target}@`));
  if (!dir) throw new Error(`no esbuild binary for ${target} under ${pnpm}`);
  const exe = process.platform === 'win32' ? 'esbuild.exe' : 'bin/esbuild';
  return join(pnpm, dir, 'node_modules', '@esbuild', target, exe);
}

// ── Phase 1: plain Node — bundle the sources, then hand over to Electron ──────────────
if (!process.versions.electron) {
  const scratch = mkdtempSync(join(tmpdir(), 'tm-one-panel-'));
  const esbuild = findEsbuild();
  const bundle = (entry, outfile, external) => {
    const res = spawnSync(
      esbuild,
      [
        entry,
        '--bundle',
        '--platform=node',
        '--format=cjs',
        `--alias:@shared=${join(root, 'packages', 'shared', 'src')}`,
        `--alias:@protocol=${join(root, 'packages', 'protocol', 'src')}`,
        `--alias:@tm/shared=${join(root, 'packages', 'shared', 'src')}`,
        `--alias:@tm/protocol=${join(root, 'packages', 'protocol', 'src')}`,
        ...(external ? [`--external:${external}`] : []),
        `--outfile=${outfile}`,
        '--log-level=error',
      ],
      { stdio: 'inherit' },
    );
    if (res.status !== 0) {
      removeScratch(scratch);
      throw new Error(`esbuild failed bundling ${entry}`);
    }
  };

  // The panel's pure helpers, re-exported from one generated entry. Paths go in as JSON
  // strings with forward slashes — never a template literal, whose backslashes and
  // backticks a Windows path would break.
  const projects = join(root, 'packages', 'ui', 'src', 'projects');
  const spec = (file) => JSON.stringify(join(projects, file).replace(/\\/g, '/'));
  const srcSpec = (...parts) => JSON.stringify(join(root, ...parts).replace(/\\/g, '/'));
  const uiEntry = join(scratch, 'ui-entry.ts');
  writeFileSync(
    uiEntry,
    [
      'export { ticketPatchFor } from ' + spec('ticketFields.ts') + ';',
      'export { linkedTicketRows, linkAddRefusal } from ' + spec('linkedTickets.ts') + ';',
      'export { ticketSummaryLine } from ' + spec('ticketSummary.ts') + ';',
      'export { applyTaskDelta } from ' +
        srcSpec('packages', 'ui', 'src', 'taskSummaryStore.ts') +
        ';',
      'export { toTaskSummary } from ' +
        srcSpec('packages', 'shared', 'src', 'taskSummary.ts') +
        ';',
      '',
    ].join('\n'),
  );

  bundle(join(root, 'apps/client/src/main/store.ts'), join(scratch, 'store.cjs'), 'better-sqlite3');
  bundle(join(root, 'apps/client/src/main/ticketIpc.ts'), join(scratch, 'ticketIpc.cjs'));
  bundle(join(root, 'apps/client/src/main/taskDelta.ts'), join(scratch, 'taskDelta.cjs'));
  bundle(uiEntry, join(scratch, 'ui.cjs'));

  const electron = join(
    clientModules,
    'electron',
    'dist',
    process.platform === 'win32' ? 'electron.exe' : 'electron',
  );
  if (!existsSync(electron)) {
    removeScratch(scratch);
    throw new Error(`electron not installed at ${electron}`);
  }

  const run = spawnSync(electron, [fileURLToPath(import.meta.url), scratch], {
    stdio: 'inherit',
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      NODE_PATH: clientModules,
    },
  });
  process.exit(run.status ?? 1);
}

// ── Phase 2: under Electron-as-Node — the actual checks ──────────────────────────────
const require = createRequire(import.meta.url);
const scratch = process.argv[2];

let failures = 0;
const check = (label, ok) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) failures++;
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

let store;
try {
  const { createStore } = require(join(scratch, 'store.cjs'));
  const { createTicketIpc } = require(join(scratch, 'ticketIpc.cjs'));
  const { createTaskDeltaPusher } = require(join(scratch, 'taskDelta.cjs'));
  const {
    ticketPatchFor,
    linkedTicketRows,
    linkAddRefusal,
    ticketSummaryLine,
    applyTaskDelta,
    toTaskSummary,
  } = require(join(scratch, 'ui.cjs'));

  store = createStore(join(scratch, 'one-panel.db'));
  const project = store.addProject({ path: '', ticketPrefix: 'OP', name: 'one-panel' });
  const A = store.createTicket(project.id, {
    title: 'Ticket A',
    issueType: 'story',
    storyPoints: 3,
  });
  const B = store.createTicket(project.id, { title: 'Ticket B' });
  const C = store.createTicket(project.id, { title: 'Ticket C' });
  const M1 = store.addMilestone(project.id, { name: 'Milestone One' });
  check('seed: three tickets and a milestone were created', !!A && !!B && !!C && !!M1);

  const sent = [];
  const taskDeltas = createTaskDeltaPusher({
    readBoard: (projectId) => store.getBoardTasks(projectId),
    send: (delta) => sent.push(['tasks:changed', delta]),
  });
  const ipc = createTicketIpc({
    store,
    send: (ch, p) => sent.push([ch, p]),
    pushTasks: (projectId) => taskDeltas.push(projectId),
  });

  // ── The renderer's caches, seeded the way the hooks seed them ─────────────────────────
  // `board:tasks` answers summaries and seeds the pusher's snapshot with them.
  let backlog = store.getBoardTasks(project.id).map(toTaskSummary); // useProjectTickets
  taskDeltas.seed(project.id, backlog);
  let board = store.getAllBoardTasks().map(toTaskSummary); // MyTasks, All scope
  let panelLinks = store.listTicketLinks(); // useTicketRegistries
  check(
    'seed: the Backlog and the board both hold A, B and C',
    [A, B, C].every((t) => backlog.some((r) => r.id === t.id) && board.some((r) => r.id === t.id)),
  );

  /** Drain `sent` into the caches, the way each hook's `transport.on` handler does. */
  function applyEvents() {
    for (const [channel, payload] of sent.splice(0)) {
      if (channel === 'tasks:changed') {
        backlog = applyTaskDelta(backlog, payload, project.id);
        board = applyTaskDelta(board, payload, 'all');
      } else if (channel === 'ticketLink:changed') {
        panelLinks = payload;
      }
    }
  }

  /** `useTicketFieldSave`: diff one field, send `ticket:update` only when it changed. */
  function saveField(field, value, ticket) {
    const patch = ticketPatchFor(field, value, ticket);
    if (Object.keys(patch).length > 0) ipc.updateTicket(ticket.id, patch);
    applyEvents();
    return patch;
  }

  const rowIn = (list, id) => list.find((t) => t.id === id);
  const milestones = () => store.listMilestones(project.id);

  // ═══════════════════════════ Milestone edit, the way the panel does it ═════════════════
  const patch = ticketPatchFor('milestoneId', M1.id, A);
  check(
    "ticketPatchFor('milestoneId', M1) is exactly { milestoneId }",
    same(Object.keys(patch), ['milestoneId']) && patch.milestoneId === M1.id,
  );
  check(
    'an unchanged milestone sends nothing',
    same(ticketPatchFor('milestoneId', A.milestoneId ?? '', A), {}),
  );

  saveField('milestoneId', M1.id, A);
  {
    const row = rowIn(backlog, A.id);
    const card = rowIn(board, A.id);
    check("the Backlog row's milestoneId is M1", row?.milestoneId === M1.id);
    check("the board card's milestoneId is M1", card?.milestoneId === M1.id);
    check(
      'title and storyPoints are unchanged on both',
      row?.title === A.title &&
        card?.title === A.title &&
        row?.storyPoints === 3 &&
        card?.storyPoints === 3,
    );
    const rowLine = row && ticketSummaryLine(row, { milestones: milestones() });
    const cardLine = card && ticketSummaryLine(card, { milestones: milestones() });
    check(
      `both render the same summary line naming M1 (${rowLine})`,
      !!rowLine && rowLine === cardLine && rowLine.includes(M1.name),
    );
  }

  {
    const updatedA = rowIn(backlog, A.id);
    const clear = ticketPatchFor('milestoneId', '', updatedA);
    check(
      'clearing the milestone patches { milestoneId: null }',
      same(clear, { milestoneId: null }),
    );
    saveField('milestoneId', '', updatedA);
    const row = rowIn(backlog, A.id);
    const card = rowIn(board, A.id);
    check(
      'after the clear, both reads return a null milestoneId',
      row?.milestoneId === null && card?.milestoneId === null,
    );
    const rowLine = ticketSummaryLine(row, { milestones: milestones() });
    const cardLine = ticketSummaryLine(card, { milestones: milestones() });
    check(
      `after the clear, both summary lines drop M1 (${rowLine})`,
      rowLine === cardLine && !rowLine.includes(M1.name),
    );
    saveField('milestoneId', M1.id, row);
    check(
      'setting M1 back reaches both reads',
      rowIn(backlog, A.id)?.milestoneId === M1.id && rowIn(board, A.id)?.milestoneId === M1.id,
    );
  }

  // ═══════════════════════════ Link add, the way the panel does it ═══════════════════════
  const tasksByIdOf = (list) => new Map(list.map((t) => [t.id, t]));
  const groupsOf = (ticketId, list) =>
    linkedTicketRows(rowIn(list, ticketId), panelLinks, tasksByIdOf(list));
  const keysUnder = (section, phrase) =>
    section?.groups.find((g) => g.phrase === phrase)?.rows.map((r) => r.key) ?? [];

  const result = ipc.addPlainTicketLink(A.id, B.id, 'relates');
  check('A relates B is not refused', linkAddRefusal(result) === null);
  applyEvents();
  check(
    "the panel's links are exactly the ones the add answered with",
    result.status === 'ok' && same(panelLinks, result.links),
  );
  check(
    "the panel's links hold the new A relates B row",
    panelLinks.some((l) => l.fromTaskId === A.id && l.toTaskId === B.id && l.type === 'relates'),
  );

  {
    const fromBacklog = groupsOf(A.id, backlog);
    const fromBoard = groupsOf(A.id, board);
    check(
      'A: the Backlog and the board give identical link groups',
      !!fromBacklog && same(fromBacklog, fromBoard),
    );
    check(
      'A: B is listed under "relates to" from both',
      same(keysUnder(fromBacklog, 'relates to'), [B.ticketKey]) &&
        same(keysUnder(fromBoard, 'relates to'), [B.ticketKey]),
    );
  }
  {
    const fromBacklog = groupsOf(B.id, backlog);
    const fromBoard = groupsOf(B.id, board);
    check(
      'B: A is listed under "relates to" from both',
      !!fromBacklog &&
        same(fromBacklog, fromBoard) &&
        same(keysUnder(fromBacklog, 'relates to'), [A.ticketKey]),
    );
  }

  const dup = ipc.addPlainTicketLink(C.id, A.id, 'duplicates');
  check('C duplicates A is not refused', linkAddRefusal(dup) === null);
  applyEvents();
  {
    const fromBacklog = groupsOf(A.id, backlog);
    const fromBoard = groupsOf(A.id, board);
    check(
      'A: C is listed under "is duplicated by" from both',
      !!fromBacklog &&
        same(fromBacklog, fromBoard) &&
        same(keysUnder(fromBacklog, 'is duplicated by'), [C.ticketKey]),
    );
  }

  const mirror = ipc.addPlainTicketLink(B.id, A.id, 'relates');
  check('the mirror B relates A is refused', linkAddRefusal(mirror) !== null);
  check('the refused mirror sends no event', sent.length === 0);
} catch (err) {
  console.error(err);
  failures++;
} finally {
  try {
    store?.close();
  } finally {
    removeScratch(scratch);
  }
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
