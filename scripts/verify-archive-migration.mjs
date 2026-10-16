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
    return raw.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  } finally {
    raw.close();
  }
}

const dbPath = join(work, 'orchestrator.db');

// ───────────────────────────── Fresh DB ─────────────────────────────
const fresh = createStore(dbPath);
check('fresh DB: projects has an archivedAt column', tableColumns(dbPath, 'projects').includes('archivedAt'));
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
const ticket = before.createTicket(project.id, { title: 'A seeded ticket', milestoneId: milestone.id });
const plainTask = before.createTask('personal', { title: 'A plain personal task' });
check('seed: the ticket project was created', project != null);
check('seed: the milestone was created', milestone != null);
check('seed: the ticket was created and filed under the milestone', ticket?.milestoneId === milestone.id);
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
check('dropped: milestones really lacks archivedAt', !tableColumns(dbPath, 'milestones').includes('archivedAt'));
check('dropped: projects really lacks archivedAt', !tableColumns(dbPath, 'projects').includes('archivedAt'));
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
check('reopened: the ALTER added projects.archivedAt back', tableColumns(dbPath, 'projects').includes('archivedAt'));
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
check('reopened: the project row survived with its name intact', reopenedProject?.name === 'Archive test');
check(
  'reopened: the ticket row survived with its milestone link intact',
  reopenedTicket?.milestoneId === milestone.id,
);
check('reopened: the plain task row survived with its title intact', reopenedPlainTask?.title === 'A plain personal task');
check('reopened: the milestone row survived', reopenedMilestones.length === 1 && reopenedMilestones[0].id === milestone.id);

// Not backfilled: nothing could have archived any of these before the columns existed.
check('reopened: getTask(...).trackerArchivedAt is null — not backfilled', reopenedTicket?.trackerArchivedAt === null);
check('reopened: getProject(...).archivedAt is null — not backfilled', reopenedProject?.archivedAt === null);
check(
  "reopened: listMilestones(...)[0].archivedAt is null — not backfilled",
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
check('triggers: one updateTask adds exactly one cloud_outbox row for that task', outboxAfter - outboxBefore === 1);

// ───────────────────────────── The columns are READ, not just present ─────────────────
const stamp = Date.now();
const rawWrite = new Database(dbPath);
rawWrite.prepare('UPDATE projects SET archivedAt = ? WHERE id = ?').run(stamp, project.id);
rawWrite.prepare('UPDATE tasks SET trackerArchivedAt = ? WHERE id = ?').run(stamp, ticket.id);
rawWrite.prepare('UPDATE milestones SET archivedAt = ? WHERE id = ?').run(stamp, milestone.id);
rawWrite.close();

check('read-back: Project.archivedAt comes back as a number', typeof after.getProject(project.id)?.archivedAt === 'number');
check(
  'read-back: Task.trackerArchivedAt comes back as a number',
  typeof after.getTask(ticket.id)?.trackerArchivedAt === 'number',
);
check(
  'read-back: Milestone.archivedAt comes back as a number',
  typeof after.listMilestones(project.id).find((m) => m.id === milestone.id)?.archivedAt === 'number',
);

after.close();

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
