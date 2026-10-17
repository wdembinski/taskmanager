/**
 * Headless proof of the archive-column migration (F14.1) — `projects.archivedAt`,
 * `milestones.archivedAt` and `tasks.trackerArchivedAt`.
 *
 *     node scripts/verify-archive-migration.mjs
 *
 * Cloned from `scripts/verify-resume-migration.mjs` — see its header for why this has to be
 * a script rather than a `store.test.ts`: `better-sqlite3`'s addon is compiled for ELECTRON's
 * ABI, so nothing that calls `createStore` can run under the Node that runs vitest, and this
 * is the only thing that exercises the store's schema and migrations at all. Same way past
 * the ABI split: run the Electron binary as plain Node (`ELECTRON_RUN_AS_NODE=1`), no window,
 * a scratch database in the OS temp directory.
 *
 * ## What it proves
 *
 * A fresh database already has all three columns. Seeded through the real store — a ticket
 * project, a milestone, a ticket filed under it, and a plain personal task — then the three
 * columns are DROPPED with raw SQL to simulate a pre-upgrade database and the rows are
 * confirmed to survive that. Re-opening with the real store brings all three columns back,
 * the row counts and seeded field values are unchanged, and every dropped column reads back
 * `null` — not a backfilled guess, since nothing could have archived anything before the
 * columns existed. The trigger set is unchanged (still exactly the three `trg_tasks_*`
 * triggers, nothing on `milestones`), and a single `updateTask` still logs exactly one
 * `cloud_outbox` row. Finally, a value written to each column with raw SQL is read back
 * through the store's own mappers as a number — proof the column is actually READ, not just
 * present.
 *
 * It fails loudly if a migration entry is removed: the store cannot even open on the
 * upgraded database, because an INSERT or UPDATE names a column the table lacks. Prove that
 * yourself by deleting one of the `['trackerArchivedAt', 'INTEGER']` / `projects.archivedAt`
 * / `milestones.archivedAt` ALTER entries from `store.ts` and re-running — each one fails a
 * different check below (the column missing on reopen, or the store refusing to open at all).
 *
 * A second, fresh database then exercises F14.3's own archive/restore surface end to end
 * through the real store: `archiveMilestone`/`restoreMilestone` and each of its three
 * `OpenTicketsChoice`s, `archiveEpic`/`restoreEpic`, `archiveTicketProject`/
 * `restoreTicketProject`, `listArchived` scoped and unscoped, every refusal reason as
 * `{ ok: false, reason }` rather than a throw, the `cloud_outbox` row an `archive` choice
 * logs per changed ticket, and the retention sweep's guard that a ticket the TRACKER
 * archived (`trackerArchivedAt`) is never pruned by the BOARD's own clock (`archivedAt`) —
 * only a board-archived control row goes.
 *
 * Prove the guard itself can fail: drop the `trackerArchivedAt = @at` match from
 * `restoreMilestone`'s `selectCoArchivedTickets` and the "stays archived" / "is still
 * there" checks below fail; make `selectArchivedBefore` also read `trackerArchivedAt` and
 * the prune-guard section fails instead. Revert both and every check passes again.
 *
 * A third, fresh database then exercises F14.10's own two store reads —
 * `listMilestoneTickets` and `ticketDoneTimes` — the sweep's only way of seeing the world.
 * `ticketDoneTimes` is proven to pick the NEWEST `status-moved` row that lands on
 * `done`/`cancelled` (a ticket closed, reopened, and closed again), to ignore a
 * `status-moved` row that lands anywhere else, and to say nothing at all for a ticket
 * with no such row. `listMilestoneTickets` is proven to carry a ticket's `updatedAt`
 * through as `null` when the column genuinely is (raw SQL stands in for a pre-Phase-25
 * row, same trick the migration section above uses), to exclude a ticket the BOARD has
 * removed (`Task.archivedAt`, not `trackerArchivedAt` — the sweep's own milestone tickets
 * read never looks at the tracker's archive column at all), and to exclude a ticket with
 * no milestone.
 *
 * Prove this section can fail too: change `listMilestoneTickets`'s SQL to drop the
 * `archivedAt IS NULL` guard and the "excludes a board-removed ticket" check below fails;
 * change `ticketDoneTimes`'s SQL from `MAX(at)` to `MIN(at)` and the "newest close wins"
 * check fails instead. Revert both and every check passes again.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const clientModules = join(root, 'apps', 'client', 'node_modules');
const scratch = mkdtempSync(join(tmpdir(), 'tm-archive-migration-'));

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
  const esbuild = findEsbuild();
  // `store.ts` imports nothing from Electron (only node:*, better-sqlite3 and @shared/*),
  // which is what lets it be pulled out of the app and run on its own like this.
  spawnSync(
    esbuild,
    [
      join(root, 'apps/client/src/main/store.ts'),
      '--bundle',
      '--platform=node',
      '--format=cjs',
      `--alias:@shared=${join(root, 'packages', 'shared', 'src')}`,
      `--alias:@protocol=${join(root, 'packages', 'protocol', 'src')}`,
      '--external:better-sqlite3',
      `--outfile=${join(scratch, 'store.cjs')}`,
      '--log-level=error',
    ],
    { stdio: 'inherit' },
  );

  const electron = join(
    clientModules,
    'electron',
    'dist',
    process.platform === 'win32' ? 'electron.exe' : 'electron',
  );
  if (!existsSync(electron)) throw new Error(`electron not installed at ${electron}`);

  const run = spawnSync(electron, [fileURLToPath(import.meta.url), scratch], {
    stdio: 'inherit',
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      // The bundle lives in temp, outside any node_modules tree, so the external
      // `require('better-sqlite3')` inside it needs somewhere to resolve from.
      NODE_PATH: clientModules,
    },
  });
  process.exit(run.status ?? 1);
}

// ── Phase 2: under Electron-as-Node — the actual checks ──────────────────────────────
const require = createRequire(import.meta.url);
const work = process.argv[2];
const { createStore } = require(join(work, 'store.cjs'));
const Database = require('better-sqlite3');

let failures = 0;
const check = (label, ok) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) failures++;
};

/** `cloud_outbox` rows logged against one task id — a delta across a write is the robust
 *  signal, since unrelated activity earlier in the run already seeded the table. */
function outboxCountFor(dbPath, taskId) {
  const raw = new Database(dbPath);
  try {
    return raw
      .prepare(`SELECT COUNT(*) n FROM cloud_outbox WHERE entity = 'task' AND entityId = ?`)
      .get(taskId).n;
  } finally {
    raw.close();
  }
}

function tableColumns(dbPath, table) {
  const raw = new Database(dbPath);
  try {
    return raw
      .prepare(`PRAGMA table_info(${table})`)
      .all()
      .map((c) => c.name);
  } finally {
    raw.close();
  }
}

const dbPath = join(work, 'orchestrator.db');

// ───────────────────────────── Fresh DB ─────────────────────────────
const fresh = createStore(dbPath);
check(
  'fresh DB: projects has an archivedAt column',
  tableColumns(dbPath, 'projects').includes('archivedAt'),
);
check(
  'fresh DB: tasks has a trackerArchivedAt column',
  tableColumns(dbPath, 'tasks').includes('trackerArchivedAt'),
);
check(
  'fresh DB: milestones has an archivedAt column',
  tableColumns(dbPath, 'milestones').includes('archivedAt'),
);
fresh.close();

// ───────────────────────────── Seed through the real store ─────────────────────────────
const before = createStore(dbPath);
const project = before.addProject({ name: 'Archive test', ticketPrefix: 'AR' });
const milestone = before.addMilestone(project.id, { name: 'Beta' });
const ticket = before.createTicket(project.id, {
  title: 'A seeded ticket',
  milestoneId: milestone.id,
});
const plainTask = before.createTask('personal', { title: 'A plain personal task' });
check('seed: the ticket project was created', project != null);
check('seed: the milestone was created', milestone != null);
check(
  'seed: the ticket was created and filed under the milestone',
  ticket?.milestoneId === milestone.id,
);
check('seed: the plain personal task was created', plainTask != null);

const rawCounts = new Database(dbPath);
const countsBefore = {
  projects: rawCounts.prepare('SELECT COUNT(*) n FROM projects').get().n,
  tasks: rawCounts.prepare('SELECT COUNT(*) n FROM tasks').get().n,
  milestones: rawCounts.prepare('SELECT COUNT(*) n FROM milestones').get().n,
};
rawCounts.close();
before.close();

// ───────────────────────────── Drop the columns (the pre-upgrade shape) ─────────────────
const raw = new Database(dbPath);
raw.exec('ALTER TABLE milestones DROP COLUMN archivedAt');
raw.exec('ALTER TABLE projects DROP COLUMN archivedAt');
raw.exec('ALTER TABLE tasks DROP COLUMN trackerArchivedAt');
check(
  'dropped: milestones really lacks archivedAt',
  !tableColumns(dbPath, 'milestones').includes('archivedAt'),
);
check(
  'dropped: projects really lacks archivedAt',
  !tableColumns(dbPath, 'projects').includes('archivedAt'),
);
check(
  'dropped: tasks really lacks trackerArchivedAt',
  !tableColumns(dbPath, 'tasks').includes('trackerArchivedAt'),
);
check(
  'dropped: every seeded row survived the DROP COLUMN',
  raw.prepare('SELECT COUNT(*) n FROM projects').get().n === countsBefore.projects &&
    raw.prepare('SELECT COUNT(*) n FROM tasks').get().n === countsBefore.tasks &&
    raw.prepare('SELECT COUNT(*) n FROM milestones').get().n === countsBefore.milestones,
);
raw.close();

// ───────────────────────────── Reopen with the real store ─────────────────────────────
const after = createStore(dbPath);
check(
  'reopened: the ALTER added projects.archivedAt back',
  tableColumns(dbPath, 'projects').includes('archivedAt'),
);
check(
  'reopened: the ALTER added tasks.trackerArchivedAt back',
  tableColumns(dbPath, 'tasks').includes('trackerArchivedAt'),
);
check(
  'reopened: the ALTER added milestones.archivedAt back',
  tableColumns(dbPath, 'milestones').includes('archivedAt'),
);

const rawCountsAfter = new Database(dbPath);
check(
  'reopened: row counts are unchanged',
  rawCountsAfter.prepare('SELECT COUNT(*) n FROM projects').get().n === countsBefore.projects &&
    rawCountsAfter.prepare('SELECT COUNT(*) n FROM tasks').get().n === countsBefore.tasks &&
    rawCountsAfter.prepare('SELECT COUNT(*) n FROM milestones').get().n === countsBefore.milestones,
);
rawCountsAfter.close();

const reopenedProject = after.getProject(project.id);
const reopenedTicket = after.getTask(ticket.id);
const reopenedPlainTask = after.getTask(plainTask.id);
const reopenedMilestones = after.listMilestones(project.id);
check(
  'reopened: the project row survived with its name intact',
  reopenedProject?.name === 'Archive test',
);
check(
  'reopened: the ticket row survived with its milestone link intact',
  reopenedTicket?.milestoneId === milestone.id,
);
check(
  'reopened: the plain task row survived with its title intact',
  reopenedPlainTask?.title === 'A plain personal task',
);
check(
  'reopened: the milestone row survived',
  reopenedMilestones.length === 1 && reopenedMilestones[0].id === milestone.id,
);

// Not backfilled: nothing could have archived any of these before the columns existed.
check(
  'reopened: getTask(...).trackerArchivedAt is null — not backfilled',
  reopenedTicket?.trackerArchivedAt === null,
);
check(
  'reopened: getProject(...).archivedAt is null — not backfilled',
  reopenedProject?.archivedAt === null,
);
check(
  'reopened: listMilestones(...)[0].archivedAt is null — not backfilled',
  reopenedMilestones[0]?.archivedAt === null,
);

// ───────────────────────────── Triggers are unchanged ─────────────────────────────
const rawTriggers = new Database(dbPath);
const taskTriggers = rawTriggers
  .prepare(`SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'trg_tasks_%'`)
  .all()
  .map((r) => r.name)
  .sort();
const milestoneTriggers = rawTriggers
  .prepare(`SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'milestones'`)
  .all();
rawTriggers.close();
check(
  'triggers: exactly the three trg_tasks_* triggers exist',
  JSON.stringify(taskTriggers) ===
    JSON.stringify(['trg_tasks_after_delete', 'trg_tasks_after_insert', 'trg_tasks_after_update']),
);
check('triggers: milestones has no trigger of its own', milestoneTriggers.length === 0);

const outboxBefore = outboxCountFor(dbPath, ticket.id);
after.updateTask(ticket.id, { title: 'A seeded ticket, renamed' });
const outboxAfter = outboxCountFor(dbPath, ticket.id);
check(
  'triggers: one updateTask adds exactly one cloud_outbox row for that task',
  outboxAfter - outboxBefore === 1,
);

// ───────────────────────────── The columns are READ, not just present ─────────────────
const stamp = Date.now();
const rawWrite = new Database(dbPath);
rawWrite.prepare('UPDATE projects SET archivedAt = ? WHERE id = ?').run(stamp, project.id);
rawWrite.prepare('UPDATE tasks SET trackerArchivedAt = ? WHERE id = ?').run(stamp, ticket.id);
rawWrite.prepare('UPDATE milestones SET archivedAt = ? WHERE id = ?').run(stamp, milestone.id);
rawWrite.close();

check(
  'read-back: Project.archivedAt comes back as a number',
  typeof after.getProject(project.id)?.archivedAt === 'number',
);
check(
  'read-back: Task.trackerArchivedAt comes back as a number',
  typeof after.getTask(ticket.id)?.trackerArchivedAt === 'number',
);
check(
  'read-back: Milestone.archivedAt comes back as a number',
  typeof after.listMilestones(project.id).find((m) => m.id === milestone.id)?.archivedAt ===
    'number',
);

after.close();

// ═════════════════════════ F14.3: archive/restore store methods ═════════════════════════
// A fresh store/db, seeded through the real store API — the migration checks above only
// prove the COLUMNS exist; everything below proves archiveMilestone/restoreMilestone,
// archiveEpic/restoreEpic, archiveTicketProject/restoreTicketProject and listArchived
// actually do what `Store`'s docstrings promise, including every refusal path and the
// retention sweep's guard against the tracker's own archive column.
const archiveDbPath = join(work, 'archive-ops.db');
const store = createStore(archiveDbPath);

let clock = Date.now();
const nextAt = () => ++clock;

// ───────────────────────────── Seed ─────────────────────────────
const projectA = store.addProject({ name: 'Archive flows', ticketPrefix: 'AF' });
const projectB = store.addProject({ name: 'Second tracker', ticketPrefix: 'BF' });
// `personal: true` is the one way to decline the guaranteed-prefix rule (`buildProject` in
// `@shared/projectBuilders`) — otherwise a plan-less, non-Personal project is handed a
// prefix whether the caller asked for one or not, and would not be an agent project at all.
const agentProject = store.addProject({
  name: 'Agent project',
  path: 'C:/fake/agent-project',
  personal: true,
});

const m1 = store.addMilestone(projectA.id, { name: 'M1 - backlog choice' });
const m2 = store.addMilestone(projectA.id, { name: 'M2 - milestone choice (source)' });
const m3 = store.addMilestone(projectA.id, { name: 'M3 - milestone choice (target)' });
const m4 = store.addMilestone(projectA.id, { name: 'M4 - archive choice' });
const m5 = store.addMilestone(projectA.id, { name: 'M5 - target refusals' });
const mAgent = store.addMilestone(agentProject.id, { name: 'On a non-ticket project' });
const mb1 = store.addMilestone(projectB.id, { name: 'MB1 - archived for listArchived' });
const mb2 = store.addMilestone(projectB.id, { name: 'MB2 - active, other project' });

const o1 = store.createTicket(projectA.id, { title: 'O1', milestoneId: m1.id });
const o2 = store.createTicket(projectA.id, { title: 'O2', milestoneId: m1.id });
const d1 = store.createTicket(projectA.id, { title: 'D1', milestoneId: m1.id });
store.updateTask(d1.id, { status: 'done' });

const o3 = store.createTicket(projectA.id, { title: 'O3', milestoneId: m2.id });
const o4 = store.createTicket(projectA.id, { title: 'O4', milestoneId: m2.id });
const d2 = store.createTicket(projectA.id, { title: 'D2', milestoneId: m2.id });
store.updateTask(d2.id, { status: 'done' });

const o5 = store.createTicket(projectA.id, { title: 'O5', milestoneId: m4.id });
const o6 = store.createTicket(projectA.id, { title: 'O6', milestoneId: m4.id });
const o7 = store.createTicket(projectA.id, { title: 'O7', milestoneId: m4.id });
const d3 = store.createTicket(projectA.id, { title: 'D3', milestoneId: m4.id });
store.updateTask(d3.id, { status: 'done' });
// Someone archived O7 on its own, earlier, a different way — raw SQL stands in for
// `archiveEpic`/a direct archive. A different `at` than `m4` will ever use is the whole
// point: it is what proves the milestone's own archive/restore never touches it.
const earlierAt = nextAt();
{
  const rawPreArchive = new Database(archiveDbPath);
  rawPreArchive
    .prepare(`UPDATE tasks SET trackerArchivedAt = ? WHERE id = ?`)
    .run(earlierAt, o7.id);
  rawPreArchive.close();
}

const ot1 = store.createTicket(projectA.id, { title: 'OT1', milestoneId: m5.id });

const e1 = store.createTicket(projectA.id, { title: 'Epic One', issueType: 'epic' });
const e2 = store.createTicket(projectB.id, { title: 'Epic Two', issueType: 'epic' });
const e3 = store.createTicket(projectA.id, {
  title: 'Epic Three (never archived)',
  issueType: 'epic',
});

const controlTask = store.createTask('personal', { title: 'Prune control (board-archived)' });

check(
  'seed: every archive-flow entity was created',
  [
    projectA,
    projectB,
    agentProject,
    m1,
    m2,
    m3,
    m4,
    m5,
    mAgent,
    mb1,
    mb2,
    o1,
    o2,
    d1,
    o3,
    o4,
    d2,
    o5,
    o6,
    o7,
    d3,
    ot1,
    e1,
    e2,
    e3,
    controlTask,
  ].every((x) => x != null),
);
check('seed: the agent project owns no ticket prefix', agentProject.ticketPrefix === '');

// MB1 has nothing to act on — archived immediately, purely to give `listArchived` a
// second project's milestone to filter around.
const atMb1 = nextAt();
check(
  'seed: MB1 archives with no open tickets to move',
  store.archiveMilestone(mb1.id, { kind: 'backlog' }, atMb1).ok,
);

// ───────────────────────────── 1. Choice: backlog ─────────────────────────────
const at1 = nextAt();
const backlogResult = store.archiveMilestone(m1.id, { kind: 'backlog' }, at1);
check('backlog: archiveMilestone succeeds', backlogResult.ok === true);
check(
  'backlog: changedTaskIds is exactly the two open tickets',
  backlogResult.ok &&
    [...backlogResult.changedTaskIds].sort().join(',') === [o1.id, o2.id].sort().join(','),
);
check('backlog: O1 lost its milestone', store.getTask(o1.id)?.milestoneId === null);
check('backlog: O2 lost its milestone', store.getTask(o2.id)?.milestoneId === null);
check('backlog: the done ticket D1 stays on M1', store.getTask(d1.id)?.milestoneId === m1.id);
check(
  'backlog: M1.archivedAt === at',
  store.listMilestones(projectA.id).find((m) => m.id === m1.id)?.archivedAt === at1,
);

// ───────────────────────────── 2. Choice: milestone ─────────────────────────────
const at2 = nextAt();
const milestoneResult = store.archiveMilestone(
  m2.id,
  { kind: 'milestone', milestoneId: m3.id },
  at2,
);
check('milestone: archiveMilestone succeeds', milestoneResult.ok === true);
check('milestone: O3 moved onto M3', store.getTask(o3.id)?.milestoneId === m3.id);
check('milestone: O4 moved onto M3', store.getTask(o4.id)?.milestoneId === m3.id);
check('milestone: the done ticket D2 stays on M2', store.getTask(d2.id)?.milestoneId === m2.id);
check(
  'milestone: M3 (the target) was never archived',
  store.listMilestones(projectA.id).find((m) => m.id === m3.id)?.archivedAt == null,
);

// ───────────────────────────── 3. Choice: archive (and its outbox rows) ─────────────────
const at4 = nextAt();
const outboxBeforeArchive = {
  o5: outboxCountFor(archiveDbPath, o5.id),
  o6: outboxCountFor(archiveDbPath, o6.id),
  o7: outboxCountFor(archiveDbPath, o7.id),
  d3: outboxCountFor(archiveDbPath, d3.id),
};
const archiveResult = store.archiveMilestone(m4.id, { kind: 'archive' }, at4);
check('archive: archiveMilestone succeeds', archiveResult.ok === true);
check(
  'archive: O5 got trackerArchivedAt === at and kept its milestone',
  store.getTask(o5.id)?.trackerArchivedAt === at4 && store.getTask(o5.id)?.milestoneId === m4.id,
);
check(
  'archive: O6 got trackerArchivedAt === at and kept its milestone',
  store.getTask(o6.id)?.trackerArchivedAt === at4 && store.getTask(o6.id)?.milestoneId === m4.id,
);
check(
  'archive: O7 (archived separately, earlier) keeps its OWN timestamp, not at',
  store.getTask(o7.id)?.trackerArchivedAt === earlierAt,
);
check(
  'archive: the done ticket D3 is never touched',
  store.getTask(d3.id)?.trackerArchivedAt == null,
);

// This ONE UPDATE statement touches exactly O5 and O6 (O7 is already tracker-archived,
// D3 is done): one `cloud_outbox` row apiece, none for the other two.
check(
  'archive: outbox — exactly one row added for O5',
  outboxCountFor(archiveDbPath, o5.id) - outboxBeforeArchive.o5 === 1,
);
check(
  'archive: outbox — exactly one row added for O6',
  outboxCountFor(archiveDbPath, o6.id) - outboxBeforeArchive.o6 === 1,
);
check(
  'archive: outbox — no row added for the already-archived O7',
  outboxCountFor(archiveDbPath, o7.id) - outboxBeforeArchive.o7 === 0,
);
check(
  'archive: outbox — no row added for the done D3',
  outboxCountFor(archiveDbPath, d3.id) - outboxBeforeArchive.d3 === 0,
);

// Move O6 off the milestone BEFORE restoring — it was co-archived, but restore only looks
// at tickets still ON the milestone, so this one should stay archived forever.
store.updateTask(o6.id, { milestoneId: null });

const restoreResult = store.restoreMilestone(m4.id);
check('archive/restore: restoreMilestone succeeds', restoreResult.ok === true);
check(
  'archive/restore: changedTaskIds is exactly the one ticket still on M4',
  restoreResult.ok && [...restoreResult.changedTaskIds].join(',') === o5.id,
);
check(
  'archive/restore: O5 (stayed on M4) is active again',
  store.getTask(o5.id)?.trackerArchivedAt == null,
);
check(
  'archive/restore: O6 (moved off M4 first) stays archived',
  store.getTask(o6.id)?.trackerArchivedAt === at4,
);
check(
  'archive/restore: O7 (archived separately) is still there, still archived at its own timestamp',
  store.getTask(o7.id)?.trackerArchivedAt === earlierAt,
);
check(
  'archive/restore: D3 is unaffected throughout',
  store.getTask(d3.id)?.trackerArchivedAt == null && store.getTask(d3.id)?.status === 'done',
);

// ───────────────────────────── 4. Epic and project round trips + listArchived ───────────
const atE1 = nextAt();
check('epic: archiveEpic succeeds', store.archiveEpic(e1.id, atE1).ok === true);
check(
  'epic: getTask round-trips trackerArchivedAt === at',
  store.getTask(e1.id)?.trackerArchivedAt === atE1,
);
check(
  'epic: archiving an already-archived epic refuses',
  store.archiveEpic(e1.id, nextAt()).reason === 'already-archived',
);
check('epic: that refusal left E1 unchanged', store.getTask(e1.id)?.trackerArchivedAt === atE1);

const atE2 = nextAt();
check(
  'epic: a second epic in the second project archives too',
  store.archiveEpic(e2.id, atE2).ok === true,
);

{
  const all = store.listArchived();
  const onlyA = store.listArchived(projectA.id);
  const onlyB = store.listArchived(projectB.id);
  check(
    'listArchived: E1 and E2 are both listed, each exactly once',
    all.epics.filter((e) => e.id === e1.id).length === 1 &&
      all.epics.filter((e) => e.id === e2.id).length === 1,
  );
  check('listArchived: the never-archived E3 is absent', !all.epics.some((e) => e.id === e3.id));
  check(
    'listArchived(projectA): has E1, not E2',
    onlyA.epics.some((e) => e.id === e1.id) && !onlyA.epics.some((e) => e.id === e2.id),
  );
  check(
    'listArchived(projectB): has E2, not E1',
    onlyB.epics.some((e) => e.id === e2.id) && !onlyB.epics.some((e) => e.id === e1.id),
  );
  check(
    'listArchived: M1 and M2 (project A) are listed',
    all.milestones.some((m) => m.id === m1.id) && all.milestones.some((m) => m.id === m2.id),
  );
  check(
    'listArchived(projectA): has M1, not MB1',
    onlyA.milestones.some((m) => m.id === m1.id) && !onlyA.milestones.some((m) => m.id === mb1.id),
  );
  check(
    'listArchived(projectB): has MB1, not M1',
    onlyB.milestones.some((m) => m.id === mb1.id) && !onlyB.milestones.some((m) => m.id === m1.id),
  );
}

check('epic: restoreEpic succeeds', store.restoreEpic(e1.id).ok === true);
check('epic: getTask round-trips back to active', store.getTask(e1.id)?.trackerArchivedAt == null);
check(
  'listArchived: E1 is gone after restore, E2 stays',
  !store.listArchived().epics.some((e) => e.id === e1.id) &&
    store.listArchived().epics.some((e) => e.id === e2.id),
);

const atB = nextAt();
check(
  'project: archiveTicketProject succeeds',
  store.archiveTicketProject(projectB.id, atB).ok === true,
);
check(
  'project: getProject round-trips archivedAt === at',
  store.getProject(projectB.id)?.archivedAt === atB,
);
check(
  'project: archiving an already-archived project refuses',
  store.archiveTicketProject(projectB.id, nextAt()).reason === 'already-archived',
);
check('project: that refusal left B unchanged', store.getProject(projectB.id)?.archivedAt === atB);

{
  const all = store.listArchived();
  const onlyA = store.listArchived(projectA.id);
  const onlyB = store.listArchived(projectB.id);
  check(
    'listArchived: project B is listed exactly once',
    all.projects.filter((p) => p.id === projectB.id).length === 1,
  );
  check(
    'listArchived(projectA): does not include project B',
    !onlyA.projects.some((p) => p.id === projectB.id),
  );
  check(
    'listArchived(projectB): includes project B',
    onlyB.projects.some((p) => p.id === projectB.id),
  );
}

check(
  'project: restoreTicketProject succeeds',
  store.restoreTicketProject(projectB.id).ok === true,
);
check(
  'project: getProject round-trips back to active',
  store.getProject(projectB.id)?.archivedAt == null,
);
check(
  'listArchived: project B is gone after restore',
  !store.listArchived().projects.some((p) => p.id === projectB.id),
);

// ───────────────────────────── 5. Every refusal ─────────────────────────────
check(
  'refuse: archiveMilestone(unknown)',
  store.archiveMilestone('nope', { kind: 'backlog' }, nextAt()).reason === 'not-found',
);
check('refuse: restoreMilestone(unknown)', store.restoreMilestone('nope').reason === 'not-found');
check('refuse: archiveEpic(unknown)', store.archiveEpic('nope', nextAt()).reason === 'not-found');
check('refuse: restoreEpic(unknown)', store.restoreEpic('nope').reason === 'not-found');
check(
  'refuse: archiveTicketProject(unknown)',
  store.archiveTicketProject('nope', nextAt()).reason === 'not-found',
);
check(
  'refuse: restoreTicketProject(unknown)',
  store.restoreTicketProject('nope').reason === 'not-found',
);

check(
  'refuse: archiveMilestone(already-archived M1)',
  store.archiveMilestone(m1.id, { kind: 'backlog' }, nextAt()).reason === 'already-archived',
);
check(
  'refuse: that refusal left M1.archivedAt unchanged',
  store.listMilestones(projectA.id).find((m) => m.id === m1.id)?.archivedAt === at1,
);
check(
  'refuse: restoreMilestone(active M3)',
  store.restoreMilestone(m3.id).reason === 'not-archived',
);
check('refuse: restoreEpic(active E3)', store.restoreEpic(e3.id).reason === 'not-archived');
check(
  'refuse: restoreTicketProject(active A)',
  store.restoreTicketProject(projectA.id).reason === 'not-archived',
);

check(
  'refuse: archiveTicketProject(agent project)',
  store.archiveTicketProject(agentProject.id, nextAt()).reason === 'not-a-ticket-project',
);
check(
  'refuse: restoreTicketProject(agent project)',
  store.restoreTicketProject(agentProject.id).reason === 'not-a-ticket-project',
);
check(
  'refuse: archiveMilestone(milestone on an agent project)',
  store.archiveMilestone(mAgent.id, { kind: 'backlog' }, nextAt()).reason ===
    'not-a-ticket-project',
);
check(
  'refuse: that refusal left mAgent unarchived',
  store.listMilestones(agentProject.id).find((m) => m.id === mAgent.id)?.archivedAt == null,
);

check(
  'refuse: archiveEpic(a non-epic ticket)',
  store.archiveEpic(o1.id, nextAt()).reason === 'not-an-epic',
);
check('refuse: that refusal left O1 unchanged', store.getTask(o1.id)?.trackerArchivedAt == null);

// Target refusals only validate when the milestone has open tickets to move — M5/OT1
// exist for exactly that; each attempt below must leave both completely untouched.
check(
  'refuse: target-not-found',
  store.archiveMilestone(m5.id, { kind: 'milestone', milestoneId: 'nope' }, nextAt()).reason ===
    'target-not-found',
);
check(
  'refuse: target-is-self',
  store.archiveMilestone(m5.id, { kind: 'milestone', milestoneId: m5.id }, nextAt()).reason ===
    'target-is-self',
);
check(
  'refuse: target-archived (M1, already archived, same project)',
  store.archiveMilestone(m5.id, { kind: 'milestone', milestoneId: m1.id }, nextAt()).reason ===
    'target-archived',
);
check(
  'refuse: target-other-project (MB2, active, different project)',
  store.archiveMilestone(m5.id, { kind: 'milestone', milestoneId: mb2.id }, nextAt()).reason ===
    'target-other-project',
);
check(
  'refuse: all four target refusals left M5 and OT1 untouched',
  store.listMilestones(projectA.id).find((m) => m.id === m5.id)?.archivedAt == null &&
    store.getTask(ot1.id)?.milestoneId === m5.id &&
    store.getTask(ot1.id)?.trackerArchivedAt == null,
);

// M5 still has OT1 open and still has no choice applied, so it is exactly the case a
// missing `choice` must refuse rather than guess at.
check(
  'refuse: archiveMilestone(M5, no choice) is choice-required',
  store.archiveMilestone(m5.id, undefined, nextAt()).reason === 'choice-required',
);
check(
  'refuse: that refusal left M5 and OT1 untouched',
  store.listMilestones(projectA.id).find((m) => m.id === m5.id)?.archivedAt == null &&
    store.getTask(ot1.id)?.milestoneId === m5.id &&
    store.getTask(ot1.id)?.trackerArchivedAt == null,
);

// MB2 has no open tickets at all, so omitting `choice` is fine — there is nothing for it
// to decide.
const atMb2 = nextAt();
const mb2Result = store.archiveMilestone(mb2.id, undefined, atMb2);
check('archive: archiveMilestone(MB2, no choice) succeeds', mb2Result.ok === true);
check(
  'archive: MB2 is archived',
  store.listMilestones(projectB.id).find((m) => m.id === mb2.id)?.archivedAt === atMb2,
);

// ───────────────────────────── 6. Prune guard ─────────────────────────────
store.archiveTask(controlTask.id, Date.now() - 10000);
check(
  'prune guard: the control task is board-archived before pruning',
  store.getTask(controlTask.id)?.archivedAt != null,
);
check(
  'prune guard: O6 carries trackerArchivedAt but no board archivedAt',
  store.getTask(o6.id)?.trackerArchivedAt === at4 && store.getTask(o6.id)?.archivedAt == null,
);
const prunedCount = store.pruneArchivedBefore(Date.now() + 1);
check(
  'prune guard: pruneArchivedBefore removed exactly the board-archived control task',
  prunedCount === 1,
);
check('prune guard: the control task is gone', store.getTask(controlTask.id) === undefined);
check(
  'prune guard: the tracker-archived ticket survives pruning',
  store.getTask(o6.id)?.trackerArchivedAt === at4,
);

store.close();

// ═══════════════ F14.10: listMilestoneTickets / ticketDoneTimes (the sweep's reads) ═══════
const sweepDbPath = join(work, 'sweep.db');
const sweepStore = createStore(sweepDbPath);

const sweepProject = sweepStore.addProject({ name: 'Sweep reads', ticketPrefix: 'SW' });
const sweepMilestone = sweepStore.addMilestone(sweepProject.id, { name: 'Sweep M1' });

function statusMoved(taskId, at, to) {
  sweepStore.appendActivity({
    at,
    projectId: sweepProject.id,
    taskId,
    runId: null,
    kind: 'status-moved',
    outcome: null,
    origin: 'human',
    title: 'moved',
    costUsd: null,
    detail: { from: 'in-progress', to },
  });
}

// ST1: closed, reopened, closed again — ticketDoneTimes must pick the NEWER close, not
// the first one.
const st1 = sweepStore.createTicket(sweepProject.id, { title: 'ST1', milestoneId: sweepMilestone.id });
statusMoved(st1.id, 1000, 'done');
statusMoved(st1.id, 2000, 'in-progress');
statusMoved(st1.id, 3000, 'cancelled');

// ST2: moved, but never to done/cancelled — ticketDoneTimes must ignore it entirely.
const st2 = sweepStore.createTicket(sweepProject.id, { title: 'ST2', milestoneId: sweepMilestone.id });
statusMoved(st2.id, 1500, 'in-review');

// ST3: no activity-log row at all, AND its own `updatedAt` forced to NULL by raw SQL — the
// "undatable" ticket `dueForAutoArchive` has to block a milestone on.
const st3 = sweepStore.createTicket(sweepProject.id, { title: 'ST3', milestoneId: sweepMilestone.id });
{
  const rawNull = new Database(sweepDbPath);
  rawNull.prepare('UPDATE tasks SET updatedAt = NULL WHERE id = ?').run(st3.id);
  rawNull.close();
}

// ST4: a native ticket with a milestone, but taken off the BOARD — listMilestoneTickets
// must exclude it even though `trackerArchivedAt` was never touched.
const st4 = sweepStore.createTicket(sweepProject.id, { title: 'ST4', milestoneId: sweepMilestone.id });
sweepStore.archiveTask(st4.id, Date.now());

// ST5: a native ticket with NO milestone — never a candidate either.
const st5 = sweepStore.createTicket(sweepProject.id, { title: 'ST5' });

check(
  'sweep seed: every ticket was created',
  [st1, st2, st3, st4, st5].every((x) => x != null),
);

const milestoneTickets = sweepStore.listMilestoneTickets();
const byId = new Map(milestoneTickets.map((t) => [t.id, t]));
check(
  'listMilestoneTickets: carries exactly ST1, ST2 and ST3',
  milestoneTickets.length === 3 && byId.has(st1.id) && byId.has(st2.id) && byId.has(st3.id),
);
check('listMilestoneTickets: excludes the board-removed ST4', !byId.has(st4.id));
check('listMilestoneTickets: excludes the milestone-less ST5', !byId.has(st5.id));
check(
  'listMilestoneTickets: ST1 carries its own projectId/milestoneId/status',
  byId.get(st1.id)?.projectId === sweepProject.id &&
    byId.get(st1.id)?.milestoneId === sweepMilestone.id &&
    byId.get(st1.id)?.status === 'pending',
);
check(
  'listMilestoneTickets: ST1 (an ordinary insert) has a non-null updatedAt',
  typeof byId.get(st1.id)?.updatedAt === 'number',
);
check(
  'listMilestoneTickets: ST3 reads back updatedAt as null, not backfilled to a number',
  byId.get(st3.id)?.updatedAt === null,
);

const doneTimes = sweepStore.ticketDoneTimes();
check(
  'ticketDoneTimes: ST1 resolves to its NEWEST close (3000), not its first (1000)',
  doneTimes.get(st1.id) === 3000,
);
check('ticketDoneTimes: ST2 (moved, never closed) is absent', !doneTimes.has(st2.id));
check('ticketDoneTimes: ST3 (no activity row at all) is absent', !doneTimes.has(st3.id));

sweepStore.close();

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
