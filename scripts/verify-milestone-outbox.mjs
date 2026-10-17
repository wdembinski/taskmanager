/**
 * Headless proof of the F14.11 milestone outbox: `store.ts`'s `trg_milestones_after_*`
 * triggers, `cloudOutboxBackfill.ts`'s `backfillMilestoneCloudOutbox`, and `cloudDelta.ts`'s
 * `buildMirrorDelta` resolving a `milestone` row through `store.getMilestone`.
 *
 *     node scripts/verify-milestone-outbox.mjs
 *
 * ## Why this is a script and not a test
 *
 * Same reason as `verify-automation-outbox.mjs`, which this one is copied from:
 * `createStore` loads `better-sqlite3`'s native addon, compiled for Electron's ABI, so
 * nothing that calls it can run under the Node that runs vitest. The pure trigger-shape
 * and `buildMirrorDelta` assumptions already have fast coverage in `cloudOutboxBackfill.test.ts`
 * / `cloudDelta.test.ts`; this is the one proof that the real triggers and the real
 * `app_state` backfill guard behind them do what those suites assume.
 *
 * `store.getCloudDelta` already runs `shapeCloudDelta` internally, which collapses every
 * entity down to its LAST row — exactly right for a sync batch, but it means it can never
 * show two separate `update` rows for the same milestone, only the newest one. Counting
 * distinct trigger firings below therefore goes around it with a raw `better-sqlite3` read of
 * `cloud_outbox` (`rawOutboxRows`); `getCloudDelta` itself is only exercised where the shaped,
 * collapsed view is the actual point — the `buildMirrorDelta` and backfill-reopen checks.
 *
 * ## What it proves
 *
 * Against a real database: `addMilestone` queues exactly one `milestone`/`insert` row;
 * `updateMilestone` queues exactly one `milestone`/`update` row; a raw
 * `UPDATE milestones SET archivedAt` — reaching the database the same way
 * `verify-archive-migration.mjs` does, with a bare `better-sqlite3` handle rather than the
 * store API — queues exactly one more `milestone`/`update` row, since the trigger fires on
 * ANY write to the row, not just ones that go through `Store`; `deleteMilestone` on a
 * milestone with a ticket still filed under it queues exactly one `milestone`/`delete` row,
 * and the cascaded `UPDATE tasks SET milestoneId = NULL` that clears the ticket's pointer
 * queues its own `task`/`update` row — a different entity, so it never inflates the
 * milestone count. Feeding the real `getCloudDelta` rows through the real `shapeCloudDelta`
 * and `buildMirrorDelta` resolves the archived milestone back into `delta.milestones` with
 * `archivedAt` set, exactly as `cloudPoller.ts` does for a live sync.
 *
 * A second database proves the one-shot catch-up: three milestones are created, the outbox
 * is drained (simulating a server that has already acked everything), and the
 * `migration.cloudOutboxMilestoneBackfill` key `cloudOutboxBackfill.ts` exports is deleted
 * from `app_state` with raw SQL — simulating a database saved by a build that predates the
 * milestone triggers entirely, where `NOT EXISTS` has nothing to rule out and the guard row
 * was never written. Reopening with the real store then queues exactly one `insert` row per
 * pre-existing milestone, and reopening it again afterwards (the guard now set) queues
 * nothing further.
 *
 * It fails loudly if the trigger loop drops `milestones`: proved once by removing the
 * `{ table: 'milestones', entity: 'milestone', touch: false }` entry from
 * `OUTBOX_TOUCH_TABLES` in `store.ts` and rerunning — every check above that counts a
 * `milestone` row fails, since `addMilestone`/`updateMilestone`/`deleteMilestone`/the raw
 * `UPDATE` then queue nothing at all. Reverting the entry brings every check back to green.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const clientModules = join(root, 'apps', 'client', 'node_modules');
const scratch = mkdtempSync(join(tmpdir(), 'tm-milestone-outbox-'));

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
  const bundle = (entry, outfile, external) =>
    spawnSync(
      esbuild,
      [
        entry,
        '--bundle',
        '--platform=node',
        '--format=cjs',
        `--alias:@shared=${join(root, 'packages', 'shared', 'src')}`,
        `--alias:@protocol=${join(root, 'packages', 'protocol', 'src')}`,
        ...(external ? [`--external:${external}`] : []),
        `--outfile=${outfile}`,
        '--log-level=error',
      ],
      { stdio: 'inherit' },
    );

  bundle(join(root, 'apps/client/src/main/store.ts'), join(scratch, 'store.cjs'), 'better-sqlite3');
  bundle(join(root, 'apps/client/src/main/cloudDelta.ts'), join(scratch, 'cloudDelta.cjs'));
  bundle(
    join(root, 'apps/client/src/main/cloudOutboxBackfill.ts'),
    join(scratch, 'cloudOutboxBackfill.cjs'),
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
      NODE_PATH: clientModules,
    },
  });
  process.exit(run.status ?? 1);
}

// ── Phase 2: under Electron-as-Node — the actual checks ──────────────────────────────
const require = createRequire(import.meta.url);
const work = process.argv[2];
const { createStore } = require(join(work, 'store.cjs'));
const { shapeCloudDelta, buildMirrorDelta } = require(join(work, 'cloudDelta.cjs'));
const { CLOUD_OUTBOX_MILESTONE_BACKFILL_KEY } = require(join(work, 'cloudOutboxBackfill.cjs'));
const Database = require('better-sqlite3');

let failures = 0;
const check = (label, ok) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) failures++;
};

/** The five lookups `buildMirrorDelta` resolves a shaped row through, bound to one store. */
function lookupsFor(s) {
  return {
    getTask: s.getTask,
    getProject: s.getProject,
    getAutomation: s.getAutomation,
    getAutomationRun: s.getAutomationRun,
    getMilestone: s.getMilestone,
  };
}

const rowsForIn = (s, entity, entityId) =>
  s.getCloudDelta(0, 1000).filter((r) => r.entity === entity && r.entityId === entityId);

/**
 * Every raw `cloud_outbox` row for one entity, oldest first — unlike `store.getCloudDelta`,
 * which runs `shapeCloudDelta` and therefore collapses each entity down to its LAST row.
 * Counting distinct trigger firings (one `addMilestone` plus a later raw `UPDATE`, say) needs
 * the unshaped table, the same reason `verify-archive-migration.mjs`'s `outboxCountFor` opens
 * its own `better-sqlite3` handle instead of asking the store.
 */
function rawOutboxRows(path, entity, entityId) {
  const raw = new Database(path);
  try {
    return raw
      .prepare(`SELECT * FROM cloud_outbox WHERE entity = ? AND entityId = ? ORDER BY seq`)
      .all(entity, entityId);
  } finally {
    raw.close();
  }
}

// ═══════════════════════════ Database 1: the four writes + buildMirrorDelta ═══════════════
const dbPath = join(work, 'orchestrator.db');
const store = createStore(dbPath);

// The backfill sweeps that run on every fresh open (there is nothing to backfill in a
// brand-new database) already queued/cleared themselves; drain them so the checks below
// start from a clean outbox.
store.pruneCloudOutbox(Number.MAX_SAFE_INTEGER);

const project = store.addProject({ name: 'Milestone outbox test', ticketPrefix: 'MO' });

// ── addMilestone ───────────────────────────────────────────────────────────────────────
const m = store.addMilestone(project.id, { name: 'M1' });
check(
  'addMilestone queues one milestone/insert row',
  rawOutboxRows(dbPath, 'milestone', m.id).length === 1 &&
    rawOutboxRows(dbPath, 'milestone', m.id)[0].op === 'insert',
);

// ── updateMilestone ──────────────────────────────────────────────────────────────────────
store.updateMilestone(m.id, { name: 'M1 renamed' });
check(
  'updateMilestone queues exactly one milestone/update row',
  rawOutboxRows(dbPath, 'milestone', m.id).filter((r) => r.op === 'update').length === 1,
);

// ── a raw UPDATE also fires the trigger, not just the store's own statements ─────────────
const rawArchive = new Database(dbPath);
const archivedAt = Date.now();
rawArchive.prepare('UPDATE milestones SET archivedAt = ? WHERE id = ?').run(archivedAt, m.id);
rawArchive.close();
check(
  'a raw UPDATE milestones SET archivedAt queues exactly one more milestone/update row',
  rawOutboxRows(dbPath, 'milestone', m.id).filter((r) => r.op === 'update').length === 2,
);
check(
  "the store's own getMilestone reads the raw write back as a number",
  store.getMilestone(m.id)?.archivedAt === archivedAt,
);

// ── buildMirrorDelta resolves the live outbox into the archived milestone ────────────────
const shaped = shapeCloudDelta(store.getCloudDelta(0, 1000), 1000);
const delta = buildMirrorDelta(shaped, lookupsFor(store));
const mirroredMilestone = delta.milestones.find((ms) => ms.id === m.id);
check(
  'buildMirrorDelta resolves the milestone row, archivedAt included',
  mirroredMilestone !== undefined && mirroredMilestone.archivedAt === archivedAt,
);

// ── deleteMilestone: one milestone/delete row; the cascaded task update is a different
// entity, so it never shows up when counting milestone rows ──────────────────────────────
const m2 = store.addMilestone(project.id, { name: 'M2' });
const ticket = store.createTicket(project.id, { title: 'A ticket on M2', milestoneId: m2.id });
check('seed: the ticket was filed under M2', ticket?.milestoneId === m2.id);

store.deleteMilestone(m2.id);
check(
  'deleteMilestone queues exactly one milestone/delete row',
  rawOutboxRows(dbPath, 'milestone', m2.id).filter((r) => r.op === 'delete').length === 1,
);
check(
  'deleteMilestone queues no OTHER milestone row beyond its own insert and delete',
  rawOutboxRows(dbPath, 'milestone', m2.id).length === 2,
);
check(
  "clearing the ticket's milestoneId queues a task/update row, not a milestone row",
  rawOutboxRows(dbPath, 'task', ticket.id).some((r) => r.op === 'update'),
);
check("the ticket's milestoneId was actually cleared", store.getTask(ticket.id)?.milestoneId === null);

store.close();

// ═══════════════════════════ Database 2: the one-shot backfill catch-up ═══════════════════
const backfillDbPath = join(work, 'milestone-backfill.db');
const s1 = createStore(backfillDbPath);
const backfillProject = s1.addProject({ name: 'Backfill test', ticketPrefix: 'BF' });
const seeded = [
  s1.addMilestone(backfillProject.id, { name: 'A' }),
  s1.addMilestone(backfillProject.id, { name: 'B' }),
  s1.addMilestone(backfillProject.id, { name: 'C' }),
];
check(
  'seed: three milestones were created for the backfill scenario',
  seeded.every((x) => x != null),
);

// Simulate a database saved before the milestone triggers existed: everything the server
// has already acked is drained, so NOT EXISTS has nothing left to rule these milestones out
// with, same as a trigger that was never there to queue them in the first place.
s1.pruneCloudOutbox(Number.MAX_SAFE_INTEGER);
check(
  'seed: the outbox is empty before simulating the pre-trigger database',
  s1.getCloudDelta(0, 1000).length === 0,
);

// And delete the guard row itself, simulating a database that predates even the backfill's
// own one-shot key — the scenario `cloudOutboxBackfill.ts`'s docstring calls out as the one
// the `app_state` guard, not `NOT EXISTS` alone, has to survive.
const rawGuard = new Database(backfillDbPath);
rawGuard.prepare('DELETE FROM app_state WHERE key = ?').run(CLOUD_OUTBOX_MILESTONE_BACKFILL_KEY);
rawGuard.close();
s1.close();

const s2 = createStore(backfillDbPath);
for (const ms of seeded) {
  const rows = rowsForIn(s2, 'milestone', ms.id);
  check(
    `reopen after the guard key is cleared queues exactly one insert row for ${ms.name}`,
    rows.length === 1 && rows[0].op === 'insert',
  );
}
check(
  'reopen queued exactly one row per pre-existing milestone, nothing more',
  s2.getCloudDelta(0, 1000).filter((r) => r.entity === 'milestone').length === seeded.length,
);
s2.close();

// The guard is now set again — a further reopen must queue nothing further.
const s3 = createStore(backfillDbPath);
check(
  'reopening again (guard now set) queues no further milestone rows',
  s3.getCloudDelta(0, 1000).filter((r) => r.entity === 'milestone').length === seeded.length,
);
s3.close();

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
