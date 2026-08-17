/**
 * Headless verification for Phase 24's native tickets — the half `vitest` cannot reach.
 *
 * There is currently ZERO test coverage of `store.ts`. Every schema and store test the repo
 * has ever had needs a REAL `better-sqlite3`, which only loads inside Electron's own ABI — so
 * nothing here can run under the Node that runs `vitest`. This drives `createStore` directly
 * under `ELECTRON_RUN_AS_NODE`, against scratch databases in the system temp layout used by
 * every other `verify-*.mjs`, and never opens, reads or writes the real profile (RELEASE.md
 * rule 6 — the app itself is never launched).
 *
 * Modelled on `verify-attachments.mjs`: each scenario file is bundled with Vite first
 * (`@shared` aliased to the shared workspace package, `electron` aliased to a throwing stub,
 * `better-sqlite3` kept external so its native addon is still a real `require` at run time),
 * then run under Electron-as-Node so the addon's ABI matches the binary loading it.
 *
 * The v0.72.0 leg is a real downgrade, not a hand-cut schema: the tagged tree is extracted
 * with `git archive` and ITS OWN `createStore` writes the old database, which the current one
 * then opens. A schema built by trimming today's twelve ticket columns off would prove nothing
 * about the migration — only the real absence of `people`/`milestones`/`ticket_labels`/
 * `ticket_links` and a real `ALTER TABLE` closes that gap. v0.72.0 predates the pnpm-workspace
 * split (`apps/client` did not exist yet — the tree was `src/main`, `src/shared` at the repo
 * root), so unlike `verify-attachments.mjs` the `git archive` here runs from the repo's TOP
 * level, not from this package: a pathspec resolved from a directory that is not part of the
 * old tree is a `fatal: current working directory is untracked`, not a silent wrong answer.
 *
 *   pnpm exec node scripts/verify-tickets.mjs
 *
 * Exits non-zero on the first failed assertion, naming it.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const require = createRequire(import.meta.url);
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/** `@shared` for TODAY's code — the packages/shared workspace package. */
const sharedSrc = join(repo, '..', '..', 'packages', 'shared', 'src');
/** The repo's own top level, one above `apps/`. Only the `git archive` call needs this. */
const worktreeRoot = resolve(repo, '..', '..');

/**
 * Everything this script writes lives here, INSIDE the app package rather than in the temp
 * dir, for one reason: the bundles keep `better-sqlite3` external, so they must sit somewhere
 * Node's resolution can still walk up to `node_modules`. Removed on the way out, and on the
 * way in — a crashed previous run must not leak into this one.
 */
const work = join(repo, '.verify-tickets');

/** The version whose database the current schema has to open without losing anything. */
const OLD_TAG = 'v0.72.0';

const electronBin = join(repo, 'node_modules', 'electron', 'dist', 'electron.exe');
const electronBinPosix = join(repo, 'node_modules', 'electron', 'dist', 'electron');

function log(message) {
  process.stdout.write(`${message}\n`);
}

/**
 * `protocol` and `app` are imported transitively by nothing on this path — `store.ts` itself
 * never touches Electron — but the stub is kept anyway, exactly as `verify-attachments.mjs`
 * keeps it, so a future import that DOES reach one of these fails loudly here instead of
 * quietly verifying a stub.
 */
const ELECTRON_STUB = `
const unavailable = (name) => () => {
  throw new Error(\`Electron's \${name} is not available in headless verification\`);
};
export const app = { getPath: unavailable('app.getPath'), on: unavailable('app.on') };
export const protocol = { handle: unavailable('protocol.handle') };
export const ipcMain = { handle: unavailable('ipcMain.handle') };
export const shell = { openPath: unavailable('shell.openPath') };
export const safeStorage = { isEncryptionAvailable: () => false };
export const BrowserWindow = class {};
export default { app, protocol, ipcMain, shell, safeStorage, BrowserWindow };
`;

/** Bundle one scenario file to a runnable ESM module. `sharedDir` is what `@shared` means. */
async function bundle(entry, outDir, sharedDir) {
  const stub = join(work, 'electron-stub.mjs');
  writeFileSync(stub, ELECTRON_STUB, 'utf8');
  await build({
    configFile: false,
    logLevel: 'error',
    resolve: { alias: { '@shared': sharedDir, electron: stub } },
    build: {
      ssr: entry,
      outDir,
      emptyOutDir: true,
      target: 'node20',
      minify: false,
      // The native addon must stay a real `import` resolved at run time — bundling a
      // `.node` file is exactly the mistake this whole ABI dance exists to avoid.
      rollupOptions: {
        external: ['better-sqlite3'],
        output: { format: 'es', entryFileNames: 'bundle.mjs' },
      },
    },
  });
  return join(outDir, 'bundle.mjs');
}

/** Run a bundle under Electron-as-Node, so `better_sqlite3.node` loads against its own ABI. */
function runUnderElectron(bundlePath) {
  const bin = existsSync(electronBin) ? electronBin : electronBinPosix;
  if (!existsSync(bin)) throw new Error(`No Electron binary at ${bin}`);
  const result = spawnSync(bin, [bundlePath], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    encoding: 'utf8',
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status !== 0) {
    throw new Error(`${bundlePath} exited ${result.status ?? `on ${result.signal}`}`);
  }
}

// ---------------------------------------------------------------------------

async function main() {
rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });

try {
  // The ABI the whole exercise depends on. Checked first and by itself, exactly as
  // `verify-attachments.mjs` checks it — every scenario below fails identically and
  // unhelpfully when this is wrong.
  const abi = require('./native-abi.mjs');
  const addon = join(
    dirname(require.resolve('better-sqlite3/package.json')),
    abi.ADDON_RELATIVE_PATH,
  );
  const expected = abi.readElectronAbi(require('electron'));
  const actual = abi.readModuleAbi(readFileSync(addon));
  if (expected !== actual) {
    throw new Error(
      `better_sqlite3.node targets ABI ${actual} but Electron is ABI ${expected} — ` +
        `run \`pnpm ensure:abi\` first`,
    );
  }
  log(`ABI ok: addon and Electron both ${actual}`);

  // The old tree, extracted whole. `git archive` rather than a checkout: this worktree is
  // shared by every step of the plan and must not move off its branch.
  //
  // Run from `worktreeRoot`, NOT from this package: `OLD_TAG` predates the pnpm-workspace
  // split, so at that revision the tree is `src/main`, `src/shared` at the repo ROOT and
  // `apps/client` does not exist. A `cwd` that is not part of the old tree makes `git
  // archive` refuse the pathspec outright (`fatal: current working directory is
  // untracked`) rather than silently archiving the wrong thing.
  const oldRoot = join(work, 'old');
  mkdirSync(oldRoot, { recursive: true });
  const tar = execFileSync('git', ['archive', '--format=tar', OLD_TAG, 'src'], {
    cwd: worktreeRoot,
    maxBuffer: 256 * 1024 * 1024,
    encoding: 'buffer',
  });
  // Both the archive and the extraction are RELATIVE, run from `oldRoot`: tar reads a
  // leading `C:\` as a remote host ("Cannot connect to C: resolve failed"), so no absolute
  // Windows path can be handed to it.
  writeFileSync(join(oldRoot, 'old.tar'), tar);
  execFileSync('tar', ['-xf', 'old.tar'], { cwd: oldRoot });
  if (!existsSync(join(oldRoot, 'src', 'main', 'store.ts'))) {
    throw new Error(`Could not extract ${OLD_TAG}'s src tree`);
  }
  log(`Extracted ${OLD_TAG} for the migration leg`);

  const scratch = join(work, 'scratch').replace(/\\/g, '/');
  const oldDb = `${scratch}/old-profile/orchestrator.db`;

  // Leg 1 — the OLD code writes a database with the pre-ticket schema.
  const oldEntry = join(work, 'entry-old.ts');
  writeFileSync(
    oldEntry,
    `
import { mkdirSync } from 'node:fs';
import { createStore } from '${join(oldRoot, 'src/main/store').replace(/\\/g, '/')}';
mkdirSync('${scratch}/old-profile', { recursive: true });
const store = createStore('${oldDb}');
const project = store.addProject({ path: 'C:/repo/legacy', name: 'legacy' });
const task = store.createTask(project.id, { title: 'a card from before tickets' });
if (!task) throw new Error('${OLD_TAG} store refused the task');
store.close();
console.log('  wrote a ${OLD_TAG} database: project ' + project.id + ', task ' + task.id);
`,
    'utf8',
  );
  log(`\nWriting a ${OLD_TAG} database with ${OLD_TAG}'s own code...`);
  runUnderElectron(
    await bundle(oldEntry, join(work, 'out-old'), join(oldRoot, 'src', 'shared')),
  );

  // Leg 2 — the CURRENT code, against a fresh profile and against that old database.
  const newEntry = join(work, 'entry-new.ts');
  writeFileSync(
    newEntry,
    SCENARIOS.replaceAll('__SCRATCH__', scratch)
      .replaceAll('__OLD_DB__', oldDb)
      .replaceAll('__REPO__', repo.replace(/\\/g, '/'))
      .replaceAll('__OLD_TAG__', OLD_TAG),
    'utf8',
  );
  log('\nRunning the scenarios against the current code...');
  runUnderElectron(await bundle(newEntry, join(work, 'out-new'), sharedSrc));

  log('\nAll scenarios passed.');
} finally {
  // `--keep` leaves the bundles and the scratch databases behind, which is the only way
  // to open one afterwards and see what a failing scenario actually wrote.
  if (process.argv.includes('--keep')) log(`\nLeft ${work} in place (--keep).`);
  else rmSync(work, { recursive: true, force: true });
}
}

/**
 * The scenarios themselves, as a template so the paths are baked in rather than passed —
 * a bundle takes no argv worth threading, and every path in it is scratch.
 */
const SCENARIOS = String.raw`
import { rmSync, mkdirSync } from 'node:fs';
import Database from 'better-sqlite3';
import { createStore } from '__REPO__/src/main/store';
import { PERSONAL_PROJECT_ID } from '@shared/model';
import { isNativeTicket } from '@shared/tickets';

let failures = 0;
function check(label, condition, detail) {
  if (condition) {
    console.log('  PASS  ' + label);
  } else {
    failures += 1;
    console.log('  FAIL  ' + label + (detail === undefined ? '' : ' \u2014 ' + detail));
  }
}
function section(name) {
  console.log('\n' + name);
}

const scratch = '__SCRATCH__';
rmSync(scratch + '/fresh', { recursive: true, force: true });
mkdirSync(scratch + '/fresh', { recursive: true });

const freshDb = scratch + '/fresh/orchestrator.db';
const store = createStore(freshDb);
const raw = new Database(freshDb);
raw.pragma('foreign_keys = ON');

function columnsOf(table) {
  return raw.prepare('PRAGMA table_info(' + table + ')').all();
}
function fksOf(table) {
  return raw.prepare('PRAGMA foreign_key_list(' + table + ')').all();
}
function uniqueIndexesOf(table) {
  return raw
    .prepare('PRAGMA index_list(' + table + ')')
    .all()
    .filter((i) => i.unique === 1)
    .map((i) => ({
      name: i.name,
      cols: raw
        .prepare('PRAGMA index_info(' + JSON.stringify(i.name) + ')')
        .all()
        .map((c) => c.name)
        .join(','),
    }));
}

// ---------------------------------------------------------------------------
section('1. A fresh database gets the four native-ticket tables');

for (const table of ['people', 'milestones', 'ticket_labels', 'ticket_links']) {
  const ddl = raw
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?")
    .get(table);
  check(table + ' exists', Boolean(ddl));
}

const peopleCols = columnsOf('people').map((c) => c.name);
check(
  'people has its seven columns, in order',
  peopleCols.join(',') === 'id,name,email,initials,color,isMe,createdAt',
  peopleCols.join(','),
);
check(
  'people carries no foreign key \u2014 it is app-wide, not per project',
  fksOf('people').length === 0,
);
check(
  'isMe is uniquely indexed',
  uniqueIndexesOf('people').some((i) => i.cols === 'isMe'),
  JSON.stringify(uniqueIndexesOf('people')),
);

const milestoneCols = columnsOf('milestones').map((c) => c.name);
check(
  'milestones has its eight columns, in order',
  milestoneCols.join(',') === 'id,projectId,name,description,dueAt,color,closed,createdAt',
  milestoneCols.join(','),
);
const milestoneFks = fksOf('milestones');
check(
  'milestones.projectId cascades from projects',
  milestoneFks.length === 1 &&
    milestoneFks[0].table === 'projects' &&
    milestoneFks[0].from === 'projectId' &&
    milestoneFks[0].on_delete === 'CASCADE',
  JSON.stringify(milestoneFks),
);

const labelCols = columnsOf('ticket_labels').map((c) => c.name);
check(
  'ticket_labels has its five columns, in order',
  labelCols.join(',') === 'id,projectId,name,color,createdAt',
  labelCols.join(','),
);
const labelFks = fksOf('ticket_labels');
check(
  'ticket_labels.projectId cascades from projects',
  labelFks.length === 1 &&
    labelFks[0].table === 'projects' &&
    labelFks[0].from === 'projectId' &&
    labelFks[0].on_delete === 'CASCADE',
  JSON.stringify(labelFks),
);
const labelDdl = raw
  .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='ticket_labels'")
  .get();
check(
  'ticket_labels.name is COLLATE NOCASE',
  /name\s+TEXT\s+NOT NULL\s+COLLATE NOCASE/i.test(labelDdl.sql),
);
check(
  'a label name is unique per project, leftmost projectId',
  uniqueIndexesOf('ticket_labels').some((i) => i.cols === 'projectId,name'),
  JSON.stringify(uniqueIndexesOf('ticket_labels')),
);

const linkCols = columnsOf('ticket_links').map((c) => c.name);
check(
  'ticket_links has its five columns, in order',
  linkCols.join(',') === 'id,fromTaskId,toTaskId,type,createdAt',
  linkCols.join(','),
);
const linkFks = fksOf('ticket_links');
check(
  'ticket_links cascades from tasks on BOTH ends',
  linkFks.length === 2 &&
    linkFks.every((f) => f.table === 'tasks' && f.on_delete === 'CASCADE') &&
    linkFks.some((f) => f.from === 'fromTaskId') &&
    linkFks.some((f) => f.from === 'toTaskId'),
  JSON.stringify(linkFks),
);
check(
  'the same directed link cannot be drawn twice with the same type',
  uniqueIndexesOf('ticket_links').some((i) => i.cols === 'fromTaskId,toTaskId,type'),
  JSON.stringify(uniqueIndexesOf('ticket_links')),
);

// The other two partial unique indexes live on tasks/projects, not on a table of their own.
check(
  'projects.ticketPrefix is uniquely indexed',
  uniqueIndexesOf('projects').some((i) => i.cols === 'ticketPrefix'),
  JSON.stringify(uniqueIndexesOf('projects')),
);
check(
  'tasks.ticketKey is uniquely indexed',
  uniqueIndexesOf('tasks').some((i) => i.cols === 'ticketKey'),
  JSON.stringify(uniqueIndexesOf('tasks')),
);
check('the connection enforces foreign keys', raw.pragma('foreign_keys', { simple: true }) === 1);

// ---------------------------------------------------------------------------
section('2. All three are genuinely PARTIAL \u2014 the NULL rows never collide with each other');

const plainA = store.addProject({ path: 'C:/repo/plainA', name: 'plainA' });
const plainB = store.addProject({ path: 'C:/repo/plainB', name: 'plainB' });
check(
  'two projects with no ticket prefix coexist',
  Boolean(plainA) && Boolean(plainB) && plainA.ticketPrefix === '' && plainB.ticketPrefix === '',
);

const bareA = store.createTask(plainA.id, { title: 'bare A' });
const bareB = store.createTask(plainA.id, { title: 'bare B' });
// createTask (adhoc) hands back the literal it built rather than a re-read row, and that
// literal never mentions ticketKey at all — read the ROW back to see what the partial
// index actually sees.
const bareARow = store.getTask(bareA.id);
const bareBRow = store.getTask(bareB.id);
check(
  'two tasks with no ticketKey coexist',
  Boolean(bareARow) &&
    Boolean(bareBRow) &&
    bareARow.ticketKey === null &&
    bareBRow.ticketKey === null,
);

const notMeA = store.addPerson({ name: 'Not Me A' });
const notMeB = store.addPerson({ name: 'Not Me B' });
check(
  'two people with isMe = false coexist',
  Boolean(notMeA) && Boolean(notMeB) && notMeA.isMe === false && notMeB.isMe === false,
);

// ---------------------------------------------------------------------------
section('3. Key allocation: sequential, gapless, never reused, never burned on a refusal');

const seqProj = store.addProject({ path: '', kind: 'ticket', ticketPrefix: 'TM', name: 'seq' });
const created = [];
for (let i = 1; i <= 500; i++) {
  created.push(store.createTicket(seqProj.id, { title: 'ticket ' + i }));
}
check('500 creates all succeeded', created.every(Boolean));
check(
  'keys run TM-1..TM-500 with no gaps',
  created.every((t, i) => t.ticketKey === 'TM-' + (i + 1) && t.ticketNumber === i + 1),
  created
    .map((t) => t && t.ticketKey)
    .slice(0, 5)
    .join(','),
);

const last = created[created.length - 1];
store.deleteTask(last.id);
const reissued = store.createTicket(seqProj.id, { title: 'after deleting TM-500' });
check(
  'deleting TM-500 and creating again yields TM-501, never TM-500 again',
  reissued.ticketKey === 'TM-501',
  reissued.ticketKey,
);

const seqAfter501 = raw.prepare('SELECT ticketSeq FROM projects WHERE id = ?').get(seqProj.id);
check('the allocator sits at 501 after 501 real issues', seqAfter501.ticketSeq === 501);

const plainKindProject = store.addProject({ path: 'C:/repo/plainkind', name: 'plainkind' });
const refusedBlank = store.createTicket(seqProj.id, { title: '   ' });
const refusedUnknownProject = store.createTicket('does-not-exist', { title: 'x' });
const refusedWrongKind = store.createTicket(plainKindProject.id, { title: 'x' });
check(
  'a blank title, an unknown project, and a non-ticket project are all refused',
  refusedBlank === undefined &&
    refusedUnknownProject === undefined &&
    refusedWrongKind === undefined,
);

const seqAfterRefusals = raw.prepare('SELECT ticketSeq FROM projects WHERE id = ?').get(seqProj.id);
check('none of those refusals advanced the counter', seqAfterRefusals.ticketSeq === 501);

const next = store.createTicket(seqProj.id, { title: 'the next real one' });
check(
  'the next real create picks up exactly where the counter left off',
  next.ticketKey === 'TM-502',
);

// ---------------------------------------------------------------------------
section('4. The partial unique index on ticketKey holds even outside the allocator');

const bystanderA = store.createTask(seqProj.id, { title: 'bystander A' });
const bystanderB = store.createTask(seqProj.id, { title: 'bystander B' });
raw.prepare('UPDATE tasks SET ticketKey = ? WHERE id = ?').run('TM-RAW', bystanderA.id);
let rawDupeThrew = false;
try {
  raw.prepare('UPDATE tasks SET ticketKey = ? WHERE id = ?').run('TM-RAW', bystanderB.id);
} catch {
  rawDupeThrew = true;
}
check('a raw SQL write cannot give two rows the same ticketKey', rawDupeThrew);

// ---------------------------------------------------------------------------
section('5. Independent per-project counters');

const altProj = store.addProject({ path: '', kind: 'ticket', ticketPrefix: 'ALT', name: 'alt' });
const alt1 = store.createTicket(altProj.id, { title: 'alt one' });
const alt2 = store.createTicket(altProj.id, { title: 'alt two' });
check(
  'a brand new project starts its own count at 1',
  alt1.ticketKey === 'ALT-1' && alt2.ticketKey === 'ALT-2',
);
const seqUntouched = raw.prepare('SELECT ticketSeq FROM projects WHERE id = ?').get(seqProj.id);
check("creating tickets in ALT never touched TM's counter", seqUntouched.ticketSeq === 502);

// ---------------------------------------------------------------------------
section('6. Prefix rules: case-blind uniqueness, a rekeying rename, a refused clear');

const dup1 = store.addProject({ path: '', kind: 'ticket', ticketPrefix: 'DUP', name: 'dup1' });
check('the first project takes the prefix', dup1.ticketPrefix === 'DUP');
let dupThrew = false;
try {
  store.addProject({ path: '', kind: 'ticket', ticketPrefix: 'dup', name: 'dup2' });
} catch {
  dupThrew = true;
}
check('a second project cannot take the same prefix, case-blind', dupThrew);

const renProj = store.addProject({ path: '', kind: 'ticket', ticketPrefix: 'REN', name: 'ren' });
const rt1 = store.createTicket(renProj.id, { title: 'one' });
const rt2 = store.createTicket(renProj.id, { title: 'two' });
const numbersBefore = [rt1.ticketNumber, rt2.ticketNumber];
const renamed = store.updateProject(renProj.id, { ticketPrefix: 'NEWPFX' });
const rt1After = store.getTask(rt1.id);
const rt2After = store.getTask(rt2.id);
check('the renamed project reads back the new prefix', renamed.ticketPrefix === 'NEWPFX');
check(
  'both tickets carry the new key',
  rt1After.ticketKey === 'NEWPFX-' + rt1.ticketNumber &&
    rt2After.ticketKey === 'NEWPFX-' + rt2.ticketNumber,
  rt1After.ticketKey + ',' + rt2After.ticketKey,
);
check(
  "the ticket numbers themselves never moved \u2014 only the key's text did",
  rt1After.ticketNumber === numbersBefore[0] && rt2After.ticketNumber === numbersBefore[1],
);

const clearAttempt = store.updateProject(renProj.id, { ticketPrefix: '' });
check(
  'clearing a prefix is refused once the project has issued tickets',
  clearAttempt.ticketPrefix === 'NEWPFX',
  clearAttempt.ticketPrefix,
);

// ---------------------------------------------------------------------------
section('7. Cascades vs explicit nulling');

const epicProj = store.addProject({
  path: '',
  kind: 'ticket',
  ticketPrefix: 'EP',
  name: 'epics',
});
const epic = store.createTicket(epicProj.id, { title: 'the epic', issueType: 'epic' });
const child = store.createTicket(epicProj.id, { title: 'a child', epicTaskId: epic.id });
check('the child is filed under the epic', store.getTask(child.id).epicTaskId === epic.id);
store.deleteTask(epic.id);
const childAfterEpicDelete = store.getTask(child.id);
check("the child survives its epic's delete", Boolean(childAfterEpicDelete));
check(
  'and its epicTaskId is nulled rather than left dangling',
  childAfterEpicDelete.epicTaskId === null,
  String(childAfterEpicDelete.epicTaskId),
);

const milestone = store.addMilestone(epicProj.id, { name: 'Beta' });
const milestoned = store.createTicket(epicProj.id, {
  title: 'against Beta',
  milestoneId: milestone.id,
});
store.deleteMilestone(milestone.id);
const milestonedAfter = store.getTask(milestoned.id);
check(
  "the ticket survives its milestone's delete, milestoneId nulled",
  Boolean(milestonedAfter) && milestonedAfter.milestoneId === null,
);

const person = store.addPerson({ name: 'Ada' });
const assigned = store.createTicket(epicProj.id, {
  title: 'for Ada',
  assigneeId: person.id,
  reporterId: person.id,
});
store.deletePerson(person.id);
const assignedAfter = store.getTask(assigned.id);
check(
  "the ticket survives its assignee's delete, both pointers nulled",
  Boolean(assignedAfter) && assignedAfter.assigneeId === null && assignedAfter.reporterId === null,
);

const linkFrom = store.createTicket(epicProj.id, { title: 'blocker' });
const linkTo = store.createTicket(epicProj.id, { title: 'blocked' });
const link = store.addTicketLink(linkFrom.id, linkTo.id, 'blocks');
check(
  'the link exists before the delete',
  store.listTicketLinks().some((l) => l.id === link.id),
);
store.deleteTask(linkFrom.id);
check(
  'deleting a ticket takes its links with it',
  !store.listTicketLinks().some((l) => l.id === link.id),
);

const doomedProj = store.addProject({
  path: '',
  kind: 'ticket',
  ticketPrefix: 'DOOM',
  name: 'doomed',
});
const doomedTicket = store.createTicket(doomedProj.id, { title: 'going down' });
store.addTicketLabel(doomedProj.id, { name: 'urgent' });
store.addMilestone(doomedProj.id, { name: 'v1' });
const survivor = store.addPerson({ name: 'Grace' });
store.removeProject(doomedProj.id);
check("the project's tickets go with it", store.getTask(doomedTicket.id) === undefined);
check('its labels go with it', store.listTicketLabels(doomedProj.id).length === 0);
check('its milestones go with it', store.listMilestones(doomedProj.id).length === 0);
check(
  'but people are app-wide and outlive any one project',
  store.listPeople().some((p) => p.id === survivor.id),
);

// ---------------------------------------------------------------------------
section('8. isMe is singular across two setMe calls, by addPerson and by updatePerson alike');

const meA = store.addPerson({ name: 'First', isMe: true });
const meB = store.addPerson({ name: 'Second', isMe: true });
const peopleNow = store.listPeople();
const meAAfter = peopleNow.find((p) => p.id === meA.id);
const meBAfter = peopleNow.find((p) => p.id === meB.id);
check(
  'the second setMe steals it from the first, in the same transaction',
  meAAfter.isMe === false && meBAfter.isMe === true,
);
check('at most one person is ever isMe at once', peopleNow.filter((p) => p.isMe).length === 1);

const meC = store.addPerson({ name: 'Third' });
store.updatePerson(meC.id, { isMe: true });
const peopleAfterUpdate = store.listPeople();
check(
  'updatePerson steals isMe the same way addPerson does',
  peopleAfterUpdate.find((p) => p.id === meB.id).isMe === false &&
    peopleAfterUpdate.find((p) => p.id === meC.id).isMe === true,
);

// ---------------------------------------------------------------------------
section('9. Tracker isolation: a look-alike key never merges a ticket into either forge');

const trackerProj = store.addProject({
  path: '',
  kind: 'ticket',
  ticketPrefix: 'IZO',
  name: 'isolation',
});
const nativeTicket = store.createTicket(trackerProj.id, { title: 'ours alone' });
check('the native ticket carries source: ticket', nativeTicket.source === 'ticket');

const jiraLookalike = store.upsertJiraTask({
  id: 'jira-lookalike-id',
  projectId: PERSONAL_PROJECT_ID,
  phase: '',
  title: 'a JIRA issue wearing the same key text',
  status: 'pending',
  sessionId: null,
  order: 0,
  source: 'jira',
  dependsOn: [],
  isContract: false,
  isScaffold: false,
  externalKey: nativeTicket.ticketKey,
});
const nativeAfterJira = store.getTask(nativeTicket.id);
check(
  "a JIRA row can wear the ticket's key text as its externalKey and still be its own row",
  jiraLookalike.id !== nativeTicket.id && jiraLookalike.externalKey === nativeTicket.ticketKey,
);
check(
  'the native ticket itself is untouched by it',
  nativeAfterJira.source === 'ticket' && nativeAfterJira.ticketKey === nativeTicket.ticketKey,
);

const githubLookalike = store.upsertJiraTask({
  id: 'github-lookalike-id',
  projectId: PERSONAL_PROJECT_ID,
  phase: '',
  title: 'a GitHub issue wearing the same key text',
  status: 'pending',
  sessionId: null,
  order: 1,
  source: 'github',
  dependsOn: [],
  isContract: false,
  isScaffold: false,
  externalKey: nativeTicket.ticketKey,
});
const nativeAfterGithub = store.getTask(nativeTicket.id);
check(
  'same for a GitHub row wearing the same key text',
  githubLookalike.id !== nativeTicket.id &&
    nativeAfterGithub.source === 'ticket' &&
    nativeAfterGithub.ticketKey === nativeTicket.ticketKey,
);
check(
  'isNativeTicket tells the three rows apart correctly',
  isNativeTicket(nativeAfterGithub) &&
    !isNativeTicket(jiraLookalike) &&
    !isNativeTicket(githubLookalike),
);

// ---------------------------------------------------------------------------
section("10. A __OLD_TAG__ database picks up native tickets on open, losing nothing");

const oldRawBefore = new Database('__OLD_DB__', { readonly: true });
const hadPeopleTable = oldRawBefore
  .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='people'")
  .get();
const oldProjectRow = oldRawBefore
  .prepare("SELECT * FROM projects WHERE name = 'legacy'")
  .get();
const oldTaskCount = oldRawBefore.prepare('SELECT COUNT(*) AS n FROM tasks').get().n;
oldRawBefore.close();
check('the __OLD_TAG__ database genuinely predates native tickets', !hadPeopleTable);
check('it has the project and task we put in it', oldTaskCount === 1 && Boolean(oldProjectRow));

const migrated = createStore('__OLD_DB__');
const oldRawAfter = new Database('__OLD_DB__', { readonly: true });
for (const table of ['people', 'milestones', 'ticket_labels', 'ticket_links']) {
  check(
    'opening it with the current code creates ' + table,
    Boolean(
      oldRawAfter
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
        .get(table),
    ),
  );
}
const migratedProjectRow = oldRawAfter
  .prepare("SELECT * FROM projects WHERE name = 'legacy'")
  .get();
check(
  'the project survived, with a NULL prefix rather than a manufactured collision',
  Boolean(migratedProjectRow) &&
    migratedProjectRow.ticketPrefix === null &&
    migratedProjectRow.ticketSeq === 0,
);
const migratedTaskRow = oldRawAfter.prepare('SELECT * FROM tasks').get();
check(
  "the task survived, with its twelve ticket columns all NULL",
  Boolean(migratedTaskRow) &&
    migratedTaskRow.ticketKey === null &&
    migratedTaskRow.epicTaskId === null &&
    migratedTaskRow.milestoneId === null &&
    migratedTaskRow.assigneeId === null,
);

const freshFkList = raw.prepare('PRAGMA foreign_key_list(tasks)').all();
const migratedFkList = oldRawAfter.prepare('PRAGMA foreign_key_list(tasks)').all();
check(
  "tasks' own foreign keys are unchanged by the migration \u2014 " +
    'none of the twelve new columns is one',
  JSON.stringify(freshFkList) === JSON.stringify(migratedFkList),
  JSON.stringify({ fresh: freshFkList, migrated: migratedFkList }),
);

const migratedProject = migrated.listProjects().find((p) => p.name === 'legacy');
const migratedTask = migrated.getTasks(migratedProject.id)[0];
check(
  'the old card reads back through the current store',
  Boolean(migratedTask) && migratedTask.title === 'a card from before tickets',
);
// The old project's kind survived the migration too — it is (and stays) 'plan', and
// kind is immutable (absent from ProjectPatch), so it can take a prefix at the schema
// level yet never actually allocate with it: createTicket refuses anything that is not a
// ticket project, migrated database or not.
const updatedWithPrefix = migrated.updateProject(migratedProject.id, { ticketPrefix: 'MIG' });
const refusedOnOldPlanProject = migrated.createTicket(migratedProject.id, { title: 'x' });
check(
  "a migrated plan project can take a prefix but its kind never changes, so it still " +
    "can't allocate",
  updatedWithPrefix.ticketPrefix === 'MIG' && refusedOnOldPlanProject === undefined,
);

// What DOES work after the upgrade is a brand-new ticket project in the SAME database.
const freshTicketProject = migrated.addProject({
  path: '',
  kind: 'ticket',
  ticketPrefix: 'POST',
  name: 'post-upgrade',
});
const firstTicketAfterMigration = migrated.createTicket(freshTicketProject.id, {
  title: 'first ticket post-upgrade',
});
check(
  'a brand-new ticket project in the migrated database allocates keys starting at 1',
  Boolean(firstTicketAfterMigration) && firstTicketAfterMigration.ticketKey === 'POST-1',
);

oldRawAfter.close();
migrated.close();

// ---------------------------------------------------------------------------
section('11. A full round trip: epics, milestones, labels, links and dated tickets');

const fullProj = store.addProject({
  path: '',
  kind: 'ticket',
  ticketPrefix: 'FULL',
  name: 'full round trip',
});
const fullMilestone = store.addMilestone(fullProj.id, { name: 'Beta', dueAt: 1700000000000 });
store.addTicketLabel(fullProj.id, { name: 'backend', color: '#336699' });
store.addTicketLabel(fullProj.id, { name: 'urgent', color: '#cc0000' });
const fullEpic = store.createTicket(fullProj.id, { title: 'the epic', issueType: 'epic' });
const fullReporter = store.addPerson({ name: 'Reporter Rae' });
const fullAssignee = store.addPerson({ name: 'Assignee Amir' });

const fullTicket = store.createTicket(fullProj.id, {
  title: 'a fully-dressed ticket',
  issueType: 'story',
  epicTaskId: fullEpic.id,
  milestoneId: fullMilestone.id,
  labels: ['backend', 'urgent'],
  storyPoints: 2.5,
  estimateDays: 0.5,
  startAt: 1690000000000,
  dueAt: 1695000000000,
  assigneeId: fullAssignee.id,
  reporterId: fullReporter.id,
  description: 'the brief',
  priority: 'High',
});
check('the fully-dressed ticket was created', Boolean(fullTicket));

const fullLink = store.addTicketLink(fullTicket.id, fullEpic.id, 'implements');
check('the link was drawn', Boolean(fullLink));

const fullReadBack = store.getTask(fullTicket.id);
check('epicTaskId round-trips', fullReadBack.epicTaskId === fullEpic.id);
check('milestoneId round-trips', fullReadBack.milestoneId === fullMilestone.id);
check(
  'labels round-trip through parseStringArray, in the order they were given',
  JSON.stringify(fullReadBack.labels) === JSON.stringify(['backend', 'urgent']),
  JSON.stringify(fullReadBack.labels),
);
check(
  'storyPoints survives as a REAL 2.5, not rounded to 2',
  fullReadBack.storyPoints === 2.5,
  String(fullReadBack.storyPoints),
);
check(
  'estimateDays survives as a REAL 0.5, not rounded to 0 or 1',
  fullReadBack.estimateDays === 0.5,
  String(fullReadBack.estimateDays),
);
check('startAt round-trips', fullReadBack.startAt === 1690000000000);
check('dueAt round-trips', fullReadBack.dueAt === 1695000000000);
check('assigneeId round-trips', fullReadBack.assigneeId === fullAssignee.id);
check('reporterId round-trips', fullReadBack.reporterId === fullReporter.id);
check('issueType round-trips', fullReadBack.issueType === 'story');
check(
  "the ticket's own brief round-trips as externalDescription",
  fullReadBack.externalDescription === 'the brief',
);
check('priority round-trips as externalPriority', fullReadBack.externalPriority === 'High');
check(
  'the ticket appears on its own board',
  store.getBoardTasks(fullProj.id).some((t) => t.id === fullTicket.id),
);
check(
  'the link reads back from both ends via listTicketLinks',
  store
    .listTicketLinks()
    .some(
      (l) =>
        l.id === fullLink.id &&
        l.fromTaskId === fullTicket.id &&
        l.toTaskId === fullEpic.id &&
        l.type === 'implements',
    ),
);

// ---------------------------------------------------------------------------
section('12. A prefix rename is one transaction: a mid-rename collision leaves nothing rewritten');

const bulkProj = store.addProject({
  path: '',
  kind: 'ticket',
  ticketPrefix: 'BULK',
  name: 'bulk rename',
});
const bulkTickets = [];
for (let i = 1; i <= 500; i++) {
  bulkTickets.push(store.createTicket(bulkProj.id, { title: 'bulk ' + i }));
}
check('500 tickets were created under BULK', bulkTickets.every(Boolean));

// Plant a raw-SQL collision at exactly the key the rekey would write for ticket #250 — a
// bystander row, wearing no ticketNumber of its own (so the rekey's own WHERE clause never
// touches it), sitting on the key the rename is about to try to hand to someone else. The
// partial unique index on tasks(ticketKey) does not care whose row got there first.
const plantedCollision = store.createTask(bulkProj.id, {
  title: 'a bystander wearing the target key',
});
raw.prepare('UPDATE tasks SET ticketKey = ? WHERE id = ?').run('COLLIDE-250', plantedCollision.id);

let renameThrew = false;
try {
  store.updateProject(bulkProj.id, { ticketPrefix: 'COLLIDE' });
} catch {
  renameThrew = true;
}
check('the rename throws rather than silently partially applying', renameThrew);

const bulkProjRow = raw.prepare('SELECT ticketPrefix FROM projects WHERE id = ?').get(bulkProj.id);
check(
  "the project's own prefix is unchanged — the write that set it rolled back too",
  bulkProjRow.ticketPrefix === 'BULK',
  String(bulkProjRow.ticketPrefix),
);

const bulkFirstAfter = store.getTask(bulkTickets[0].id);
const bulkMiddleAfter = store.getTask(bulkTickets[249].id);
const bulkLastAfter = store.getTask(bulkTickets[499].id);
check(
  'not one of the 500 tickets was rekeyed — first, middle and last all still wear BULK',
  bulkFirstAfter.ticketKey === 'BULK-1' &&
    bulkMiddleAfter.ticketKey === 'BULK-250' &&
    bulkLastAfter.ticketKey === 'BULK-500',
  [bulkFirstAfter.ticketKey, bulkMiddleAfter.ticketKey, bulkLastAfter.ticketKey].join(','),
);

const plantedAfter = store.getTask(plantedCollision.id);
check(
  'the planted bystander still wears the key that caused the collision',
  plantedAfter.ticketKey === 'COLLIDE-250',
);

// ---------------------------------------------------------------------------
section('13. Deleting an epic leaves a Gantt-visible child alone but for its epicTaskId');

const ganttEpicProj = store.addProject({
  path: '',
  kind: 'ticket',
  ticketPrefix: 'GANTT',
  name: 'gantt epic',
});
const ganttEpic = store.createTicket(ganttEpicProj.id, { title: 'the epic', issueType: 'epic' });
const ganttChild = store.createTicket(ganttEpicProj.id, {
  title: 'a dated child',
  epicTaskId: ganttEpic.id,
  startAt: 1700000000000,
  dueAt: 1701000000000,
});
store.deleteTask(ganttEpic.id);
const ganttChildAfter = store.getTask(ganttChild.id);
check("the child survives its epic's delete", Boolean(ganttChildAfter));
check('its epicTaskId is nulled rather than left dangling', ganttChildAfter.epicTaskId === null);
check(
  "its Gantt dates are untouched by the epic's delete",
  ganttChildAfter.startAt === 1700000000000 && ganttChildAfter.dueAt === 1701000000000,
  ganttChildAfter.startAt + ',' + ganttChildAfter.dueAt,
);
check(
  'the child still reads back on the board, dates intact',
  store
    .getBoardTasks(ganttEpicProj.id)
    .some(
      (t) => t.id === ganttChild.id && t.startAt === 1700000000000 && t.dueAt === 1701000000000,
    ),
);

// ---------------------------------------------------------------------------
section('14. Removing a person nulls every pointer to them, across every project they touch');

const crossProjA = store.addProject({
  path: '',
  kind: 'ticket',
  ticketPrefix: 'XA',
  name: 'cross project A',
});
const crossProjB = store.addProject({
  path: '',
  kind: 'ticket',
  ticketPrefix: 'XB',
  name: 'cross project B',
});
const crossPerson = store.addPerson({ name: 'Cross-Project Cara' });
const crossTicketA = store.createTicket(crossProjA.id, {
  title: 'assigned in A',
  assigneeId: crossPerson.id,
});
const crossTicketB = store.createTicket(crossProjB.id, {
  title: 'reported in B',
  reporterId: crossPerson.id,
});
store.deletePerson(crossPerson.id);
const crossTicketAAfter = store.getTask(crossTicketA.id);
const crossTicketBAfter = store.getTask(crossTicketB.id);
check(
  "project A's ticket survives, its assigneeId nulled",
  Boolean(crossTicketAAfter) && crossTicketAAfter.assigneeId === null,
);
check(
  "project B's ticket survives, its reporterId nulled",
  Boolean(crossTicketBAfter) && crossTicketBAfter.reporterId === null,
);
check(
  'the deleted person is gone from the app-wide roster',
  !store.listPeople().some((p) => p.id === crossPerson.id),
);

// ---------------------------------------------------------------------------
section('15. A board query for an unknown project degrades to empty, never throws');

let goneBoardThrew = false;
let goneBoardTasks;
try {
  goneBoardTasks = store.getBoardTasks('gone');
} catch {
  goneBoardThrew = true;
}
check('getBoardTasks for an unknown project id does not throw', !goneBoardThrew);
check(
  'it answers with an empty array rather than undefined or null',
  Array.isArray(goneBoardTasks) && goneBoardTasks.length === 0,
  JSON.stringify(goneBoardTasks),
);

let goneArchivedThrew = false;
let goneArchivedTasks;
try {
  goneArchivedTasks = store.getArchivedTasksFor('gone');
} catch {
  goneArchivedThrew = true;
}
check('getArchivedTasksFor for an unknown project id does not throw either', !goneArchivedThrew);
check(
  'and it too answers with an empty array',
  Array.isArray(goneArchivedTasks) && goneArchivedTasks.length === 0,
);

raw.close();
store.close();

console.log('');
if (failures > 0) {
  console.error(failures + ' check(s) failed.');
  process.exit(1);
}
`;

await main();
