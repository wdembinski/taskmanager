/**
 * Headless proof of the `skillRefs` migration and the `skills` table (F7.4,
 * `@shared/skills`) — the library a card or step's playbook lives in.
 *
 *     node scripts/verify-skills-migration.mjs
 *
 * ## Why this is a script and not a test
 *
 * It would rather be `store.test.ts`. It cannot be: `better-sqlite3`'s addon is compiled for
 * ELECTRON's ABI, so `require`ing it under the Node that runs vitest dies with
 * `ERR_DLOPEN_FAILED`. That is why nothing in the suite calls `createStore` — the store's
 * schema and every migration in it have no automated coverage at all, and this script is the
 * only thing that exercises one. See `scripts/verify-pinned-import-migration.mjs`, which this
 * is cloned from.
 *
 * The way past the ABI split is the same one RELEASE.md §5's smoke test uses: run the
 * Electron binary as plain Node (`ELECTRON_RUN_AS_NODE=1`). No window is opened, and nothing
 * here touches the user's profile — the database is a scratch file in the OS temp directory.
 * See the `verify-electron-app` rule: never launch the app to check something.
 *
 * ## What it proves
 *
 * On a fresh database: the `skills` table and the `tasks.skillRefs` column both exist;
 * `saveSkill` round-trips through `getSkills`/`getSkill`, a re-save with a new body updates
 * the row but keeps the original `createdAt`; the three refusals (`invalid-name`,
 * `too-large`, `name-taken`) each fire on the input that should trip them; `setTaskSkillRefs`
 * normalises, de-duplicates and drops an unparseable ref, an empty list reads back `null`
 * rather than `[]`, and an unknown task id answers `undefined`; a plain `updateTask` and a
 * JIRA `upsertJiraTask` refresh both leave a card's refs alone, since neither lists
 * `skillRefs` in its SET clause; and `deleteSkill` removes the library row while leaving the
 * card's own dangling `lib:<id>` ref in place, exactly as documented.
 *
 * On a database written by a version WITHOUT either: that both the column and the table
 * come back on next open, that the pre-upgrade row survives, that it reads `skillRefs: null`
 * — not a backfilled guess — and that `setTaskSkillRefs` and `saveSkill` both work
 * immediately afterwards.
 *
 * It fails loudly if the migration entry is removed: the store cannot even open, because its
 * INSERT names a column the table lacks. Prove that yourself by deleting the
 * `['skillRefs', 'TEXT']` line from `store.ts` and re-running.
 */
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const clientModules = join(root, 'apps', 'client', 'node_modules');
const scratch = mkdtempSync(join(tmpdir(), 'tm-skills-migration-'));

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

  bundle(
    join(root, 'apps/client/src/main/store.ts'),
    join(scratch, 'store.cjs'),
    'better-sqlite3',
  );
  bundle(join(root, 'packages/shared/src/skills.ts'), join(scratch, 'skills.cjs'));

  const electron = join(clientModules, 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
  if (!existsSync(electron)) throw new Error(`electron not installed at ${electron}`);

  const run = spawnSync(electron, [fileURLToPath(import.meta.url), scratch], {
    stdio: 'inherit',
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      // The bundles live in temp, outside any node_modules tree, so the external
      // `require('better-sqlite3')` inside them needs somewhere to resolve from.
      NODE_PATH: clientModules,
    },
  });
  process.exit(run.status ?? 1);
}

// ── Phase 2: under Electron-as-Node — the actual checks ──────────────────────────────
const require = createRequire(import.meta.url);
const work = process.argv[2];
const { createStore } = require(join(work, 'store.cjs'));
const { SKILL_BODY_MAX } = require(join(work, 'skills.cjs'));
const Database = require('better-sqlite3');

let failures = 0;
const check = (label, ok) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) failures++;
};

const newSkill = (overrides) => ({
  id: randomUUID(),
  name: 'review',
  description: 'A reusable review playbook',
  body: 'Follow the usual review checklist.',
  createdAt: Date.now(),
  updatedAt: Date.now(),
  ...overrides,
});

// ───────────────────────────── Fresh DB ─────────────────────────────
const dbPath = join(work, 'orchestrator.db');
const store = createStore(dbPath);

const freshColumns = new Database(dbPath);
const taskColumns = freshColumns.prepare('PRAGMA table_info(tasks)').all().map((c) => c.name);
const tables = freshColumns
  .prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`)
  .all()
  .map((t) => t.name);
freshColumns.close();
check('fresh DB: the skills table exists', tables.includes('skills'));
check('fresh DB: tasks has a skillRefs column', taskColumns.includes('skillRefs'));

// saveSkill round-trips; getSkills lists it; re-save with a new body updates it and keeps
// createdAt.
const skill = newSkill();
const saved = store.saveSkill(skill);
check('saveSkill round-trips a new skill', saved.ok === true && saved.skill.id === skill.id);

const listed = store.getSkills();
check('getSkills lists the saved skill', listed.some((s) => s.id === skill.id && s.name === skill.name));

const resaved = store.saveSkill({ ...skill, body: 'An updated playbook body.', createdAt: 0, updatedAt: Date.now() });
check('re-saving updates the body', resaved.ok === true && resaved.skill.body === 'An updated playbook body.');
check(
  'and keeps the original createdAt, ignoring what the caller passed',
  resaved.ok === true && resaved.skill.createdAt === skill.createdAt,
);

// Refusals.
const badName = store.saveSkill(newSkill({ id: randomUUID(), name: 'Not A Valid Name!' }));
check('a bad name is refused as invalid-name', badName.ok === false && badName.reason === 'invalid-name');

const oversizedBody = 'x'.repeat(SKILL_BODY_MAX + 1);
const tooLarge = store.saveSkill(newSkill({ id: randomUUID(), name: 'oversized', body: oversizedBody }));
check(
  `a body of SKILL_BODY_MAX + 1 bytes is refused as too-large`,
  tooLarge.ok === false && tooLarge.reason === 'too-large',
);

const nameTaken = store.saveSkill(newSkill({ id: randomUUID(), name: skill.name }));
check(
  'a second id with the same name is refused as name-taken',
  nameTaken.ok === false && nameTaken.reason === 'name-taken',
);

// setTaskSkillRefs: normalise, de-duplicate, drop the unparseable one.
const card = store.createTask('personal', { title: 'A card to carry skill refs' });
const withRefs = store.setTaskSkillRefs(card.id, [
  `lib:${skill.id}`,
  'repo:review',
  'repo:review',
  'bogus',
]);
check(
  'setTaskSkillRefs normalises, de-dupes and drops the unparseable ref',
  JSON.stringify(withRefs?.skillRefs) === JSON.stringify([`lib:${skill.id}`, 'repo:review']),
);

const clearedRefs = store.setTaskSkillRefs(card.id, []);
check('setTaskSkillRefs([]) reads back null, not []', clearedRefs?.skillRefs === null);

check(
  'setTaskSkillRefs on an unknown task id is undefined',
  store.setTaskSkillRefs('no-such-task', ['repo:review']) === undefined,
);

// Put the refs back for the checks below.
store.setTaskSkillRefs(card.id, [`lib:${skill.id}`, 'repo:review']);

// updateTask does not clear refs.
const titleUpdated = store.updateTask(card.id, { title: 'Renamed, still carrying refs' });
check(
  'updateTask({ title }) leaves skillRefs alone',
  JSON.stringify(titleUpdated?.skillRefs) === JSON.stringify([`lib:${skill.id}`, 'repo:review']),
);

// upsertJiraTask of an existing JIRA card does not clear refs either.
const jiraTemplate = store.createTask('personal', { title: 'placeholder for a jira card' });
const jiraCard = store.upsertJiraTask({
  ...jiraTemplate,
  id: 'jira-task-1',
  source: 'jira',
  title: 'A JIRA card',
  externalSource: 'jira',
  externalKey: 'ABC-1',
});
store.setTaskSkillRefs(jiraCard.id, [`lib:${skill.id}`]);
const resynced = store.upsertJiraTask({
  ...store.getTask(jiraCard.id),
  title: 'The same JIRA card, refreshed by another sync pass',
});
check(
  'upsertJiraTask refresh leaves skillRefs alone',
  JSON.stringify(resynced.skillRefs) === JSON.stringify([`lib:${skill.id}`]),
);
check(
  'and did refresh the tracker field it owns',
  resynced.title === 'The same JIRA card, refreshed by another sync pass',
);

// deleteSkill removes the library row but never touches a card's dangling ref.
const deleted = store.deleteSkill(skill.id);
check('deleteSkill returns true for a row it removed', deleted === true);
check('getSkill now answers undefined', store.getSkill(skill.id) === undefined);
const cardAfterDelete = store.getTask(card.id);
check(
  "the card still carries the now-dangling lib ref — deleteSkill is not its job",
  cardAfterDelete?.skillRefs?.includes(`lib:${skill.id}`) === true,
);

store.close();

// ───────────────────────────── Upgraded DB (drop-column recipe) ─────────────────────────────
const upgradeDbPath = join(work, 'upgrade.db');
const before = createStore(upgradeDbPath);
const oldCard = before.createTask('personal', { title: 'A card from before the skills upgrade' });
before.close();

const raw = new Database(upgradeDbPath);
raw.exec('ALTER TABLE tasks DROP COLUMN skillRefs');
raw.exec('DROP TABLE skills');
const columnsBefore = raw.prepare('PRAGMA table_info(tasks)').all().map((c) => c.name);
const tablesBefore = raw.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all().map((t) => t.name);
check('upgraded DB: the pre-upgrade table really lacks skillRefs', !columnsBefore.includes('skillRefs'));
check('upgraded DB: the pre-upgrade database really lacks the skills table', !tablesBefore.includes('skills'));
check(
  'and still holds the old row',
  raw.prepare('SELECT COUNT(*) n FROM tasks WHERE id = ?').get(oldCard.id).n === 1,
);
raw.close();

// Re-open with the real store: both migration entries have to run here.
const after = createStore(upgradeDbPath);
const checkDb = new Database(upgradeDbPath);
const columnsAfter = checkDb.prepare('PRAGMA table_info(tasks)').all().map((c) => c.name);
const tablesAfter = checkDb.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all().map((t) => t.name);
checkDb.close();
check('upgraded DB: the ALTER added skillRefs back on open', columnsAfter.includes('skillRefs'));
check('upgraded DB: the CREATE TABLE added skills back on open', tablesAfter.includes('skills'));

const migratedCard = after.getTask(oldCard.id);
check('upgraded DB: the pre-upgrade row survived the migration', migratedCard != null);
// The same claim the pinned-import and resume migrations make: a guess here would attach
// skills to a card that never had the column to carry one.
check('and reads skillRefs: null — not backfilled', migratedCard?.skillRefs === null);

// …and both the column and the table are live, not merely present.
const migratedWithRefs = after.setTaskSkillRefs(oldCard.id, ['repo:review']);
check(
  'setTaskSkillRefs round-trips on the upgraded database',
  JSON.stringify(migratedWithRefs?.skillRefs) === JSON.stringify(['repo:review']),
);

const upgradeSkill = after.saveSkill(newSkill({ id: randomUUID(), name: 'post-upgrade' }));
check('saveSkill works on the upgraded database', upgradeSkill.ok === true);
after.close();

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
