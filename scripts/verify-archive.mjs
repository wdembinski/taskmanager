/**
 * Headless end-to-end proof of milestone archiving (F14.13) — archive, hide, restore and the
 * auto-archive sweep, driven through the IPC layer the way a web call drives them.
 *
 *     node scripts/verify-archive.mjs
 *
 * Cloned in shape from `scripts/verify-archive-migration.mjs` — see its header (and
 * `scripts/verify-resume-migration.mjs` before it) for why this is a script and not a vitest
 * file: `better-sqlite3`'s addon is compiled for ELECTRON's ABI, so nothing that calls
 * `createStore` runs under the Node that runs vitest. Same way past the ABI split: plain Node
 * bundles the sources with esbuild into a scratch directory in the OS temp dir (never inside
 * the repo — a directory there IS a work tree), then re-runs this file under the Electron
 * binary as plain Node (`ELECTRON_RUN_AS_NODE=1`), no window.
 *
 * That script proves the STORE: the columns, the migrations and each store method on its own.
 * This one proves the WHOLE PATH, end to end, on one fresh database seeded through the real
 * store — a ticket project with milestones M1–M4 plus a target milestone T, an epic with a
 * child, open and done native tickets, and one JIRA-sourced row:
 *
 * - Every archive/restore/list goes through `registry.invoke('archive:…', args)` on a fresh
 *   `RelayRegistry` holding the three handlers `createArchiveHandlers` returns — the exact
 *   code `ipc.ts` wires, and the exact path a relayed web call takes, JSON round trip
 *   included. A refusal is proven to come back as DATA (`ok: true` from the registry,
 *   `value.ok === false`), never as a thrown error, and to fire no push; a success fires
 *   exactly the pushes its own result flags call for (counted by fakes).
 * - After every change the script reads back what the two hosts actually render from: the
 *   BOARD input (`bucketBoardCards` over `store.getTasks(projectId)` with an
 *   `archiveIndexOf(...)` index) and the BACKLOG input (`backlogRows(...)` with the same
 *   index), and asserts exactly which ids are present and absent — and that
 *   `includeArchived: true` brings every hidden one back, that the JIRA row is never hidden,
 *   and that `archivedBy` names the right `{ by, id }`.
 * - Each `OpenTicketsChoice` (`backlog`, `milestone` → T, `archive`), the epic and project
 *   targets, `archive:list`, every refusal the IPC layer can hand back (choice required,
 *   already archived, restore when not archived, move onto an archived milestone, unknown
 *   target kind), and each restore — the `archive`-choice milestone restoring exactly its
 *   co-archived tickets while a ticket archived separately stays archived.
 * - The F14.10 sweep with a faked clock: `runAutoArchiveSweep(deps, now)` with deps wired to
 *   the real store exactly as `ipc.ts` wires them, `now` passed explicitly, and `status-moved`
 *   activity rows seeded at a chosen `t0`. Off (`null` weeks) archives nothing; one
 *   millisecond short of the threshold archives nothing; at the threshold it archives only
 *   the milestone whose tickets all closed, writes one `milestone-archived` activity row, and
 *   the board/backlog inputs then hide its tickets.
 *
 * ## Proving it can fail
 *
 * Passing as written is half the acceptance; the other half is failing when what it checks
 * is broken. Two mutations, each applied on its own, then reverted:
 *
 * - **The predicate.** In `packages/shared/src/trackerArchive.ts`, make `archivedBy` skip
 *   its milestone step (e.g. `if (false && ticket.milestoneId)`). Every "hidden" check for a
 *   ticket hidden by its milestone fails — `archive choice: …`, `done tickets hide with
 *   their milestone`, the `archivedBy … milestone` checks and the sweep's `hides …` checks.
 * - **The restore.** In `apps/client/src/main/store.ts`, drop the `trackerArchivedAt = @at`
 *   match from `restoreMilestone`'s co-archived statements (`selectCoArchivedTickets` and
 *   `clearCoArchivedTickets`), so it restores every ticket on the milestone. The step-6
 *   checks fail: `changedTaskIds` is no longer exactly the co-archived pair, and the
 *   separately archived epic comes back when it must stay archived.
 *
 * Revert both and every check passes again.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const clientModules = join(root, 'apps', 'client', 'node_modules');

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
  const scratch = mkdtempSync(join(tmpdir(), 'tm-archive-e2e-'));
  const esbuild = findEsbuild();
  const src = (p) => join(root, p).replace(/\\/g, '/');

  // One small entry module re-exporting everything the scenario touches, so it bundles as one
  // CJS file. None of these imports Electron: `store.ts` only node:*, better-sqlite3 and
  // @shared/*; the handlers, the registry and the sweep were pulled out of `ipc.ts` for
  // exactly this; the two `packages/ui` view modules are pure (`boardColumns.ts`'s one Fluent
  // import is the `tokens` object, plain JS).
  const entry = join(scratch, 'entry.ts');
  writeFileSync(
    entry,
    [
      `export { createStore } from '${src('apps/client/src/main/store.ts')}';`,
      `export { createArchiveHandlers } from '${src('apps/client/src/main/archiveHandlers.ts')}';`,
      `export { RelayRegistry } from '${src('apps/client/src/main/ipcRegistry.ts')}';`,
      `export { runAutoArchiveSweep } from '${src('apps/client/src/main/autoArchiveSweep.ts')}';`,
      `export { archivedBy, archiveIndexOf } from '${src('packages/shared/src/trackerArchive.ts')}';`,
      `export { WEEK_MS } from '${src('packages/shared/src/autoArchive.ts')}';`,
      `export { ownsTickets } from '${src('packages/shared/src/model.ts')}';`,
      `export { backlogRows } from '${src('packages/ui/src/projects/backlogView.ts')}';`,
      `export { bucketBoardCards } from '${src('packages/ui/src/board/boardColumns.ts')}';`,
      '',
    ].join('\n'),
  );
  const built = spawnSync(
    esbuild,
    [
      entry,
      '--bundle',
      '--platform=node',
      '--format=cjs',
      `--alias:@shared=${join(root, 'packages', 'shared', 'src')}`,
      `--alias:@tm/shared=${join(root, 'packages', 'shared', 'src')}`,
      `--alias:@protocol=${join(root, 'packages', 'protocol', 'src')}`,
      '--external:better-sqlite3',
      `--outfile=${join(scratch, 'archive-e2e.cjs')}`,
      '--log-level=error',
    ],
    { stdio: 'inherit' },
  );
  if (built.status !== 0) {
    console.error('esbuild failed to bundle the archive scenario');
    process.exit(1);
  }

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

// ── Phase 2: under Electron-as-Node — the actual scenario ────────────────────────────
const require = createRequire(import.meta.url);
const work = process.argv[2];
const {
  createStore,
  createArchiveHandlers,
  RelayRegistry,
  runAutoArchiveSweep,
  archivedBy,
  archiveIndexOf,
  WEEK_MS,
  ownsTickets,
  backlogRows,
  bucketBoardCards,
} = require(join(work, 'archive-e2e.cjs'));
const Database = require('better-sqlite3');

let failures = 0;
const check = (label, ok) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) failures++;
};
const sameIds = (a, b) => [...a].sort().join(',') === [...b].sort().join(',');

const dbPath = join(work, 'archive-e2e.db');
const store = createStore(dbPath);

// ───────────────────────────── Seed through the real store ─────────────────────────────
const project = store.addProject({ name: 'Archive end to end', ticketPrefix: 'AE' });
const P = project.id;

const m1 = store.addMilestone(P, { name: 'M1 - backlog choice' });
const m2 = store.addMilestone(P, { name: 'M2 - milestone choice' });
const m3 = store.addMilestone(P, { name: 'M3 - archive choice' });
const m4 = store.addMilestone(P, { name: 'M4 - refusals' });
const mT = store.addMilestone(P, { name: 'T - target' });

const ticket = (title, extra = {}) => store.createTicket(P, { title, ...extra });
const done = (t) => {
  store.updateTask(t.id, { status: 'done' });
  return t;
};

const a1 = ticket('A1 open on M1', { milestoneId: m1.id });
const a2 = ticket('A2 open on M1', { milestoneId: m1.id });
const ad = done(ticket('AD done on M1', { milestoneId: m1.id }));

const b1 = ticket('B1 open on M2', { milestoneId: m2.id });
const bd = done(ticket('BD done on M2', { milestoneId: m2.id }));

const c1 = ticket('C1 open on M3', { milestoneId: m3.id });
const c2 = ticket('C2 open on M3', { milestoneId: m3.id });
const cd = done(ticket('CD done on M3', { milestoneId: m3.id }));
// An epic filed on M3 and archived on its own BEFORE M3 is — the "ticket separately
// archived" the restore must leave alone (its own `trackerArchivedAt`, not M3's).
const cSep = ticket('CSEP epic on M3, archived separately', {
  milestoneId: m3.id,
  issueType: 'epic',
});
// One JIRA-sourced row on M3. Closed, so the archive choice never touches it — what is
// proven is that a non-native row on an archived milestone is never hidden. Raw SQL stands
// in for the JIRA reconciler: only `source` decides `isNativeTicket`.
const jira = done(ticket('J1 JIRA row on M3', { milestoneId: m3.id }));
{
  const raw = new Database(dbPath);
  raw
    .prepare(
      `UPDATE tasks SET source = 'jira', externalSource = 'jira', externalKey = 'JIRA-1' WHERE id = ?`,
    )
    .run(jira.id);
  raw.close();
}

const d1 = ticket('D1 open on M4', { milestoneId: m4.id });

const epic = ticket('E epic', { issueType: 'epic' });
const ec = ticket('EC child of E', { epicTaskId: epic.id });
const free = ticket('F no milestone, no epic');

const ALL = [a1, a2, ad, b1, bd, c1, c2, cd, cSep, jira, d1, epic, ec, free].map((t) => t.id);
check(
  'seed: every ticket and milestone was created',
  [project, m1, m2, m3, m4, mT].every((x) => x != null) && ALL.every((id) => id != null),
);
check('seed: the JIRA row is no longer native', store.getTask(jira.id)?.source === 'jira');

// ───────────────────────────── 1. The IPC layer ─────────────────────────────
const pushes = { milestones: 0, tasks: [] };
const registry = new RelayRegistry();
let clock = Date.now();
const handlers = createArchiveHandlers({
  store,
  pushMilestones: () => {
    pushes.milestones++;
    return store.listMilestones(P);
  },
  pushTasks: (projectId) => pushes.tasks.push(projectId),
  now: () => ++clock,
});
for (const channel of ['archive:apply', 'archive:restore', 'archive:list']) {
  registry.register(channel, handlers[channel]);
}
check(
  'registry: all three archive channels are relayable',
  ['archive:apply', 'archive:restore', 'archive:list'].every((c) => registry.canInvoke(c)),
);

/** One relayed call: asserts the REGISTRY answered `ok` (the handler never threw) and
 *  returns the handler's own value — the `ArchiveResult`/`ArchivedListing`. */
async function call(label, channel, args) {
  const res = await registry.invoke(channel, args);
  check(`${label}: the registry answered ok (nothing thrown)`, res.ok === true);
  return res.value;
}

/** Runs `fn` and returns how many pushes it caused, of each kind. */
async function pushesDuring(fn) {
  const before = { milestones: pushes.milestones, tasks: pushes.tasks.length };
  const value = await fn();
  return {
    value,
    milestones: pushes.milestones - before.milestones,
    tasks: pushes.tasks.slice(before.tasks),
  };
}

async function refused(label, channel, args, reason) {
  const { value, milestones, tasks } = await pushesDuring(() => call(label, channel, args));
  check(`${label}: refused as data (value.ok === false)`, value?.ok === false);
  check(`${label}: reason is ${reason}`, value?.reason === reason);
  check(
    `${label}: a readable message came with it`,
    typeof value?.message === 'string' && value.message.length > 0,
  );
  check(`${label}: no push fired`, milestones === 0 && tasks.length === 0);
}

// ───────────────────────────── What the hosts render from ─────────────────────────────
function index() {
  return archiveIndexOf(store.listMilestones(P), store.getTasks(P), store.listProjects());
}

/** The ids the BOARD would draw — every column and the shelf, steps included. */
function boardIds(includeArchived) {
  const { cardsByColumn, shelvedCards } = bucketBoardCards(
    store.getTasks(P),
    new Map(),
    null,
    new Set(),
    undefined,
    { index: index(), includeArchived },
  );
  const ids = new Set();
  for (const card of [...[...cardsByColumn.values()].flat(), ...shelvedCards]) {
    ids.add(card.task.id);
    for (const s of card.subtasks ?? []) ids.add(s.id);
  }
  return ids;
}

/** The ids the BACKLOG would draw — every row, plus every epic group header. */
function backlogIds(includeArchived) {
  const ids = new Set();
  for (const group of backlogRows(store.getTasks(P), '', 'key', {
    index: index(),
    includeArchived,
  })) {
    if (group.epicId) ids.add(group.epicId);
    for (const t of group.tickets) ids.add(t.id);
  }
  return ids;
}

/**
 * Exactly `hidden` is missing from both the board and the backlog input, every other seeded
 * id is present, and `includeArchived: true` brings every one of them back.
 */
function expectHidden(label, hidden) {
  const shown = ALL.filter((id) => !hidden.includes(id));
  for (const [surface, read] of [
    ['board', boardIds],
    ['backlog', backlogIds],
  ]) {
    const ids = read(false);
    check(
      `${label}: ${surface} hides exactly the expected tickets`,
      hidden.every((id) => !ids.has(id)),
    );
    check(
      `${label}: ${surface} shows every other ticket`,
      shown.every((id) => ids.has(id)),
    );
    const all = read(true);
    check(
      `${label}: ${surface} with includeArchived shows them all`,
      ALL.every((id) => all.has(id)),
    );
  }
  const j = store.getTask(jira.id);
  check(`${label}: the JIRA row is never hidden`, archivedBy(j, index()) === null);
}

function expectBy(label, taskId, by, id) {
  const got = archivedBy(store.getTask(taskId), index());
  check(
    `${label}: archivedBy is ${by === null ? 'null' : `{ by: ${by} }`}`,
    by === null ? got === null : got?.by === by && got.id === id,
  );
}

const milestone = (id) => store.listMilestones(P).find((m) => m.id === id);

expectHidden('seed', []);

// ───────────────────────────── 2. No choice → choice-required ─────────────────────────
await refused(
  'M1 with no choice',
  'archive:apply',
  [{ kind: 'milestone', id: m1.id }],
  'choice-required',
);
check('M1 with no choice: M1 is still active', milestone(m1.id)?.archivedAt == null);
check(
  'M1 with no choice: its open tickets did not move',
  store.getTask(a1.id)?.milestoneId === m1.id && store.getTask(a2.id)?.milestoneId === m1.id,
);

// ───────────────────────────── 3/4. Each choice ─────────────────────────────
// backlog: open tickets lose their milestone and stay visible; the done one stays on M1
// and hides with it.
{
  const r = await pushesDuring(() =>
    call('backlog choice', 'archive:apply', [
      { kind: 'milestone', id: m1.id },
      { kind: 'backlog' },
    ]),
  );
  check('backlog choice: succeeds', r.value?.ok === true);
  check(
    'backlog choice: changedTaskIds is exactly A1 and A2',
    sameIds(r.value?.changedTaskIds ?? [], [a1.id, a2.id]),
  );
  check(
    'backlog choice: pushed milestones once and tasks once for the project',
    r.milestones === 1 && sameIds(r.tasks, [P]),
  );
  check('backlog choice: M1 is archived', milestone(m1.id)?.archivedAt != null);
  check(
    'backlog choice: A1 and A2 lost their milestone',
    store.getTask(a1.id)?.milestoneId === null && store.getTask(a2.id)?.milestoneId === null,
  );
  check('backlog choice: the done AD stays on M1', store.getTask(ad.id)?.milestoneId === m1.id);
  expectHidden('backlog choice', [ad.id]);
  expectBy('backlog choice: A1', a1.id, null);
  expectBy('backlog choice: AD', ad.id, 'milestone', m1.id);
}

// milestone → T: open tickets move onto T and stay visible; the done one hides with M2.
{
  const r = await pushesDuring(() =>
    call('milestone choice', 'archive:apply', [
      { kind: 'milestone', id: m2.id },
      { kind: 'milestone', milestoneId: mT.id },
    ]),
  );
  check('milestone choice: succeeds', r.value?.ok === true);
  check(
    'milestone choice: changedTaskIds is exactly B1',
    sameIds(r.value?.changedTaskIds ?? [], [b1.id]),
  );
  check(
    'milestone choice: pushed milestones once and tasks once',
    r.milestones === 1 && sameIds(r.tasks, [P]),
  );
  check('milestone choice: B1 moved onto T', store.getTask(b1.id)?.milestoneId === mT.id);
  check('milestone choice: the done BD stays on M2', store.getTask(bd.id)?.milestoneId === m2.id);
  check('milestone choice: T itself was never archived', milestone(mT.id)?.archivedAt == null);
  expectHidden('milestone choice', [ad.id, bd.id]);
  expectBy('milestone choice: B1', b1.id, null);
  expectBy('milestone choice: BD', bd.id, 'milestone', m2.id);
}

// The separate archive of CSEP, before M3 goes — through the same channel, as an epic.
const csepResult = await call('CSEP epic archive', 'archive:apply', [
  { kind: 'epic', id: cSep.id },
]);
check('CSEP epic archive: succeeds', csepResult?.ok === true);
const csepAt = store.getTask(cSep.id)?.trackerArchivedAt;
check('CSEP epic archive: has its own trackerArchivedAt', typeof csepAt === 'number');

// archive: open tickets get `trackerArchivedAt` and hide; the done one and the JIRA row are
// never touched; CSEP keeps its own timestamp.
let m3At;
{
  const r = await pushesDuring(() =>
    call('archive choice', 'archive:apply', [
      { kind: 'milestone', id: m3.id },
      { kind: 'archive' },
    ]),
  );
  m3At = milestone(m3.id)?.archivedAt;
  check('archive choice: succeeds', r.value?.ok === true);
  check(
    'archive choice: pushed milestones once and tasks once',
    r.milestones === 1 && sameIds(r.tasks, [P]),
  );
  check('archive choice: M3 is archived', typeof m3At === 'number');
  check(
    "archive choice: C1 and C2 carry M3's own timestamp",
    store.getTask(c1.id)?.trackerArchivedAt === m3At &&
      store.getTask(c2.id)?.trackerArchivedAt === m3At,
  );
  check(
    'archive choice: C1 and C2 kept their milestone',
    store.getTask(c1.id)?.milestoneId === m3.id && store.getTask(c2.id)?.milestoneId === m3.id,
  );
  check(
    'archive choice: CSEP keeps its OWN earlier timestamp',
    store.getTask(cSep.id)?.trackerArchivedAt === csepAt,
  );
  check(
    'archive choice: the done CD was never touched',
    store.getTask(cd.id)?.trackerArchivedAt == null,
  );
  check(
    'archive choice: the JIRA row was never touched',
    store.getTask(jira.id)?.trackerArchivedAt == null,
  );
  expectHidden('archive choice', [ad.id, bd.id, c1.id, c2.id, cd.id, cSep.id]);
  expectBy('archive choice: C1', c1.id, 'milestone', m3.id);
  expectBy('archive choice: CD', cd.id, 'milestone', m3.id);
  expectBy('archive choice: CSEP', cSep.id, 'milestone', m3.id);
}
check(
  'done tickets hide with their milestone: AD, BD and CD are each hidden by it',
  archivedBy(store.getTask(ad.id), index())?.id === m1.id &&
    archivedBy(store.getTask(bd.id), index())?.id === m2.id &&
    archivedBy(store.getTask(cd.id), index())?.id === m3.id,
);

// ───────────────────────────── 5. Epic and project targets ─────────────────────────────
{
  const r = await pushesDuring(() =>
    call('epic E', 'archive:apply', [{ kind: 'epic', id: epic.id }]),
  );
  check('epic E: succeeds', r.value?.ok === true);
  check(
    'epic E: pushed tasks only (no milestone changed)',
    r.milestones === 0 && sameIds(r.tasks, [P]),
  );
  expectHidden('epic E', [ad.id, bd.id, c1.id, c2.id, cd.id, cSep.id, epic.id, ec.id]);
  expectBy('epic E: E itself', epic.id, 'self', epic.id);
  expectBy('epic E: its child EC', ec.id, 'epic', epic.id);
}

{
  const r = await pushesDuring(() =>
    call('project', 'archive:apply', [{ kind: 'project', id: P }]),
  );
  check('project: succeeds', r.value?.ok === true);
  check(
    'project: no push (its own row changed, the renderer re-reads project:list)',
    r.milestones === 0 && r.tasks.length === 0,
  );
  check('project: archivedAt is set', store.getProject(P)?.archivedAt != null);
  // Every native ticket is now hidden by the project; only the JIRA row stays.
  expectHidden(
    'project',
    ALL.filter((id) => id !== jira.id),
  );
  expectBy('project: F (nothing else archived it)', free.id, 'project', P);
  expectBy('project: C1 (project outranks its milestone)', c1.id, 'project', P);
}

{
  const listed = await call('archive:list', 'archive:list', [P]);
  check(
    'archive:list: lists M1, M2 and M3, not M4 or T',
    sameIds(
      (listed?.milestones ?? []).map((m) => m.id),
      [m1.id, m2.id, m3.id],
    ),
  );
  check(
    'archive:list: lists the epics E and CSEP',
    sameIds(
      (listed?.epics ?? []).map((e) => e.id),
      [epic.id, cSep.id],
    ),
  );
  check(
    'archive:list: lists the project',
    sameIds(
      (listed?.projects ?? []).map((p) => p.id),
      [P],
    ),
  );
  const unscoped = await call('archive:list unscoped', 'archive:list', []);
  check(
    'archive:list unscoped: lists the same milestones',
    sameIds(
      (unscoped?.milestones ?? []).map((m) => m.id),
      [m1.id, m2.id, m3.id],
    ),
  );
}

await refused(
  're-archive M1',
  'archive:apply',
  [{ kind: 'milestone', id: m1.id }, { kind: 'backlog' }],
  'already-archived',
);
await refused(
  're-archive epic E',
  'archive:apply',
  [{ kind: 'epic', id: epic.id }],
  'already-archived',
);
await refused(
  're-archive project',
  'archive:apply',
  [{ kind: 'project', id: P }],
  'already-archived',
);
await refused(
  'restore active M4',
  'archive:restore',
  [{ kind: 'milestone', id: m4.id }],
  'not-archived',
);
await refused(
  'restore a non-epic as an epic',
  'archive:restore',
  [{ kind: 'epic', id: ec.id }],
  'not-an-epic',
);
await refused(
  'move M4 onto archived M1',
  'archive:apply',
  [
    { kind: 'milestone', id: m4.id },
    { kind: 'milestone', milestoneId: m1.id },
  ],
  'target-archived',
);
check(
  'move M4 onto archived M1: M4 and D1 untouched',
  milestone(m4.id)?.archivedAt == null && store.getTask(d1.id)?.milestoneId === m4.id,
);
await refused(
  'unknown target kind (apply)',
  'archive:apply',
  [{ kind: 'bogus', id: P }],
  'not-found',
);
await refused(
  'unknown target kind (restore)',
  'archive:restore',
  [{ kind: 'bogus', id: P }],
  'not-found',
);

// ───────────────────────────── 6. Restore each ─────────────────────────────
{
  const r = await pushesDuring(() =>
    call('restore project', 'archive:restore', [{ kind: 'project', id: P }]),
  );
  check('restore project: succeeds', r.value?.ok === true);
  check('restore project: archivedAt is cleared', store.getProject(P)?.archivedAt == null);
  expectHidden('restore project', [ad.id, bd.id, c1.id, c2.id, cd.id, cSep.id, epic.id, ec.id]);
}
await refused(
  'restore project again',
  'archive:restore',
  [{ kind: 'project', id: P }],
  'not-archived',
);

{
  const r = await pushesDuring(() =>
    call('restore epic E', 'archive:restore', [{ kind: 'epic', id: epic.id }]),
  );
  check('restore epic E: succeeds', r.value?.ok === true);
  check('restore epic E: pushed tasks', r.tasks.length === 1 && r.milestones === 0);
  expectHidden('restore epic E', [ad.id, bd.id, c1.id, c2.id, cd.id, cSep.id]);
  expectBy('restore epic E: EC', ec.id, null);
}

{
  const r = await pushesDuring(() =>
    call('restore M3', 'archive:restore', [{ kind: 'milestone', id: m3.id }]),
  );
  check('restore M3: succeeds', r.value?.ok === true);
  check(
    'restore M3: changedTaskIds is exactly its co-archived C1 and C2',
    sameIds(r.value?.changedTaskIds ?? [], [c1.id, c2.id]),
  );
  check('restore M3: pushed milestones and tasks', r.milestones === 1 && sameIds(r.tasks, [P]));
  check(
    'restore M3: C1 and C2 are active again',
    store.getTask(c1.id)?.trackerArchivedAt == null &&
      store.getTask(c2.id)?.trackerArchivedAt == null,
  );
  check(
    'restore M3: the separately archived CSEP stays archived at its own timestamp',
    store.getTask(cSep.id)?.trackerArchivedAt === csepAt,
  );
  expectHidden('restore M3', [ad.id, bd.id, cSep.id]);
  expectBy('restore M3: CSEP is now hidden by itself', cSep.id, 'self', cSep.id);
}

{
  const r1 = await call('restore M1', 'archive:restore', [{ kind: 'milestone', id: m1.id }]);
  const r2 = await call('restore M2', 'archive:restore', [{ kind: 'milestone', id: m2.id }]);
  check('restore M1 and M2: both succeed', r1?.ok === true && r2?.ok === true);
  check(
    'restore M1 and M2: no ticket changed (backlog/milestone choices co-archived none)',
    r1?.changedTaskIds?.length === 0 && r2?.changedTaskIds?.length === 0,
  );
  check(
    'restore M1: A1/A2 stay in the backlog (a restore does not move tickets back)',
    store.getTask(a1.id)?.milestoneId === null,
  );
  expectHidden('restore M1 and M2', [cSep.id]);
}

const csepBack = await call('restore CSEP', 'archive:restore', [{ kind: 'epic', id: cSep.id }]);
check('restore CSEP: succeeds', csepBack?.ok === true);
expectHidden('everything restored', []);
{
  const listed = await call('archive:list after restores', 'archive:list', [P]);
  check(
    'archive:list after restores: empty',
    listed?.milestones?.length === 0 &&
      listed?.epics?.length === 0 &&
      listed?.projects?.length === 0,
  );
}

// ───────────────────────────── 7. The sweep, with a faked clock ─────────────────────────
// `t0` is a year in the past, so every ticket above — whose `updatedAt` is the real now and
// which has no `status-moved` row — is far too recent to be due at any `now` used below.
const N = 2;
const t0 = Date.now() - 52 * WEEK_MS;
const s1 = store.addMilestone(P, { name: 'S1 - all closed' });
const s2 = store.addMilestone(P, { name: 'S2 - one still open' });
const s3 = store.addMilestone(P, { name: 'S3 - empty' });
const s1a = done(ticket('S1A closed on S1', { milestoneId: s1.id }));
const s1b = ticket('S1B cancelled on S1', { milestoneId: s1.id });
store.updateTask(s1b.id, { status: 'cancelled' });
const s2a = done(ticket('S2A closed on S2', { milestoneId: s2.id }));
const s2b = ticket('S2B open on S2', { milestoneId: s2.id });
ALL.push(s1a.id, s1b.id, s2a.id, s2b.id);

function statusMoved(taskId, at, to) {
  store.appendActivity({
    at,
    projectId: P,
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
statusMoved(s1a.id, t0 - 1000, 'done');
statusMoved(s1b.id, t0, 'cancelled'); // the newest close on S1 — the one the threshold counts from
statusMoved(s2a.id, t0 - 1000, 'done');

let sweepPushes = 0;
const sweepLog = [];
// Wired to the real store exactly as `ipc.ts`'s `startAutoArchiveSweep({ … })` call is.
const sweepDeps = {
  getSettings: () => store.getSettings(),
  listMilestones: () =>
    store
      .listProjects()
      .filter((p) => ownsTickets(p) && p.archivedAt == null)
      .flatMap((p) => store.listMilestones(p.id)),
  listMilestoneTickets: () => store.listMilestoneTickets(),
  ticketDoneTimes: () => store.ticketDoneTimes(),
  archiveMilestone: (id, choice, at) => store.archiveMilestone(id, choice, at),
  appendActivity: (row) => store.appendActivity(row),
  onMilestonesChanged: () => sweepPushes++,
  log: (message) => sweepLog.push(message),
};
const archivedRows = () =>
  store.listActivity({ sinceMs: 0, kinds: ['milestone-archived'], limit: 200 }).rows;

store.saveSettings({ ...store.getSettings(), ticketAutoArchiveWeeks: null });
check(
  'sweep off: ticketAutoArchiveWeeks reads back null',
  store.getSettings().ticketAutoArchiveWeeks === null,
);
check(
  'sweep off: archives nothing even years later',
  runAutoArchiveSweep(sweepDeps, t0 + 520 * WEEK_MS).length === 0 &&
    milestone(s1.id)?.archivedAt == null,
);

store.saveSettings({ ...store.getSettings(), ticketAutoArchiveWeeks: N });
check(
  'sweep on: ticketAutoArchiveWeeks reads back N',
  store.getSettings().ticketAutoArchiveWeeks === N,
);
check(
  'sweep 1ms early: archives nothing',
  runAutoArchiveSweep(sweepDeps, t0 + N * WEEK_MS - 1).length === 0,
);
check(
  'sweep 1ms early: S1 still active, no activity row, no push',
  milestone(s1.id)?.archivedAt == null && archivedRows().length === 0 && sweepPushes === 0,
);
expectHidden('sweep 1ms early', []);

const swept = runAutoArchiveSweep(sweepDeps, t0 + N * WEEK_MS);
check('sweep at the threshold: archives exactly S1', sameIds(swept, [s1.id]));
check(
  'sweep at the threshold: S1.archivedAt is the faked now',
  milestone(s1.id)?.archivedAt === t0 + N * WEEK_MS,
);
check(
  'sweep at the threshold: S2 (open ticket) and S3 (empty) stay active',
  milestone(s2.id)?.archivedAt == null && milestone(s3.id)?.archivedAt == null,
);
check(
  'sweep at the threshold: no other milestone was archived',
  store
    .listMilestones(P)
    .filter((m) => m.archivedAt != null)
    .map((m) => m.id)
    .join(',') === s1.id,
);
check('sweep at the threshold: pushed milestones once', sweepPushes === 1);
check('sweep at the threshold: logged no refusal', sweepLog.length === 0);
{
  const rows = archivedRows();
  check('sweep at the threshold: wrote exactly one milestone-archived row', rows.length === 1);
  check(
    'sweep at the threshold: that row names S1 as an auto archive',
    rows[0]?.detail?.milestoneId === s1.id &&
      rows[0]?.detail?.reason === 'auto' &&
      rows[0]?.projectId === P,
  );
}
check(
  "sweep at the threshold: S1's closed tickets stayed on S1",
  store.getTask(s1a.id)?.milestoneId === s1.id && store.getTask(s1b.id)?.milestoneId === s1.id,
);
expectHidden("sweep at the threshold: hides S1's tickets", [s1a.id, s1b.id]);
expectBy('sweep at the threshold: S1A', s1a.id, 'milestone', s1.id);
check(
  'sweep again: already-archived S1 is not archived twice',
  runAutoArchiveSweep(sweepDeps, t0 + N * WEEK_MS + 1).length === 0 && archivedRows().length === 1,
);

store.close();

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
