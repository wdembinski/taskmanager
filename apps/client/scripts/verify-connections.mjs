/**
 * Headless verification for the chaining-tickets plan's last step: the timeline's dependency
 * and execution-chain arrows, and the Graph view's saved node layout, all round-trip through
 * the REAL store.
 *
 * `taskChain.test.ts` and `ticketLinks.test.ts` already cover the pure refusal logic
 * (`canLink`/`canLinkTickets` — cycles, self-links, duplicates) against plain objects. What
 * neither can reach is `store.ts` itself: every store method needs a real `better-sqlite3`,
 * which only loads inside Electron's own ABI, so nothing here can run under the Node that runs
 * `vitest`. This drives `createStore` directly under `ELECTRON_RUN_AS_NODE`, against a scratch
 * database, and never opens, reads or writes the real profile (RELEASE.md rule 6 — the app
 * itself is never launched). Modelled on `verify-tickets.mjs`, minus its migration leg: there
 * is no schema change to prove here, only that the four link methods and the two layout
 * methods do what their own doc comments in `store.ts` say.
 *
 *   pnpm exec node scripts/verify-connections.mjs
 *
 * Exits non-zero on the first failed assertion, naming it.
 *
 * What this does NOT cover, and needs a human click instead: dragging a connect handle off a
 * timeline bar, holding Ctrl while dragging to draw a chain arrow instead of a dependency,
 * clicking an arrow to select it and pressing Delete, and creating/arranging nodes on the
 * React-Flow canvas in the Graph view itself. All of that is DOM/pointer interaction this
 * script cannot drive — it proves the store underneath it is correct, not the drag.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const require = createRequire(import.meta.url);
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/** `@shared` for the packages/shared workspace package. */
const sharedSrc = join(repo, '..', '..', 'packages', 'shared', 'src');

/**
 * Everything this script writes lives here, INSIDE the app package: the bundle keeps
 * `better-sqlite3` external, so Node's resolution needs `node_modules` on the path, which
 * means the scratch dir has to sit somewhere that walk reaches. Removed on the way out, and
 * on the way in — a crashed previous run must not leak into this one.
 */
const work = join(repo, '.verify-connections');

const electronBin = join(repo, 'node_modules', 'electron', 'dist', 'electron.exe');
const electronBinPosix = join(repo, 'node_modules', 'electron', 'dist', 'electron');

function log(message) {
  process.stdout.write(`${message}\n`);
}

/**
 * `protocol` and `app` are imported transitively by nothing on this path — `store.ts` itself
 * never touches Electron — but the stub is kept anyway, exactly as `verify-tickets.mjs` keeps
 * it, so a future import that DOES reach one of these fails loudly here instead of quietly
 * verifying a stub.
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

/** Bundle the scenario file to a runnable ESM module. */
async function bundle(entry, outDir) {
  const stub = join(work, 'electron-stub.mjs');
  writeFileSync(stub, ELECTRON_STUB, 'utf8');
  await build({
    configFile: false,
    logLevel: 'error',
    resolve: { alias: { '@shared': sharedSrc, electron: stub } },
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
    // `verify-tickets.mjs` checks it — every scenario below fails identically and
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

    const scratch = join(work, 'scratch').replace(/\\/g, '/');
    const entry = join(work, 'entry.ts');
    writeFileSync(
      entry,
      SCENARIOS.replaceAll('__SCRATCH__', scratch).replaceAll('__REPO__', repo.replace(/\\/g, '/')),
      'utf8',
    );
    log('\nRunning the connection scenarios against the real store...');
    runUnderElectron(await bundle(entry, join(work, 'out')));

    log('\nAll scenarios passed.');
  } finally {
    if (process.argv.includes('--keep')) log(`\nLeft ${work} in place (--keep).`);
    else rmSync(work, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 });
  }
}

/**
 * The scenarios, as a template so the paths are baked in rather than passed — a bundle takes
 * no argv worth threading, and every path in it is scratch.
 *
 * NO BACKTICKS below: this is a `String.raw` template, and one inside a comment closes it with
 * a SyntaxError pointing at a word in prose. `${}` still interpolates in `String.raw` too.
 */
const SCENARIOS = String.raw`
import { mkdirSync, rmSync } from 'node:fs';
import Database from 'better-sqlite3';
import { createStore } from '__REPO__/src/main/store';

let failures = 0;
function check(label, condition, detail) {
  if (condition) {
    console.log('  PASS  ' + label);
  } else {
    failures += 1;
    console.log('  FAIL  ' + label + (detail === undefined ? '' : ' — ' + detail));
  }
}
function section(name) {
  console.log('\n' + name);
}

const scratch = '__SCRATCH__';
rmSync(scratch, { recursive: true, force: true });
mkdirSync(scratch, { recursive: true });

const dbPath = scratch + '/orchestrator.db';
const store = createStore(dbPath);
const raw = new Database(dbPath);
raw.pragma('foreign_keys = ON');

const projA = store.addProject({ path: '', kind: 'ticket', ticketPrefix: 'CXA', name: 'chain A' });
const projB = store.addProject({ path: '', kind: 'ticket', ticketPrefix: 'CXB', name: 'chain B' });
const t1 = store.createTask(projA.id, { title: 'card one' });
const t2 = store.createTask(projA.id, { title: 'card two' });
const t3 = store.createTask(projA.id, { title: 'card three' });
const tOther = store.createTask(projB.id, { title: 'card in another project' });

// ---------------------------------------------------------------------------
section('1. Dependency links (addTicketLink / deleteTicketLink)');

const dep = store.addTicketLink(t1.id, t2.id, 'blocks');
check('a dependency link is created', Boolean(dep) && dep.type === 'blocks');
check(
  'it reads back through listTicketLinks',
  store
    .listTicketLinks()
    .some((l) => l.id === dep.id && l.fromTaskId === t1.id && l.toTaskId === t2.id),
);

const selfDep = store.addTicketLink(t1.id, t1.id, 'relates');
check('a ticket cannot be linked to itself', selfDep === undefined);

const unknownDep = store.addTicketLink(t1.id, 'does-not-exist', 'relates');
check('linking to an unknown ticket is refused, not thrown', unknownDep === undefined);

const dupDep = store.addTicketLink(t1.id, t2.id, 'blocks');
check(
  'the exact same directed link with the same type is refused as a duplicate',
  dupDep === undefined,
);

const secondTypeDep = store.addTicketLink(t1.id, t2.id, 'relates');
check(
  'the same pair with a DIFFERENT type is a distinct link, not a duplicate',
  Boolean(secondTypeDep),
);

store.deleteTicketLink(dep.id);
check(
  'deleting one link leaves the other on the same pair alone',
  !store.listTicketLinks().some((l) => l.id === dep.id) &&
    store.listTicketLinks().some((l) => l.id === secondTypeDep.id),
);

store.deleteTicketLink('does-not-exist');
check('deleting an unknown id is a silent no-op, not a throw', true);

const cascadeDep = store.addTicketLink(t2.id, t3.id, 'duplicates');
store.deleteTask(t3.id);
check(
  "deleting a ticket takes its dependency links with it",
  !store.listTicketLinks().some((l) => l.id === cascadeDep.id),
);

// ---------------------------------------------------------------------------
section('2. Execution-chain links (addTaskLink / deleteTaskLink)');

const chain = store.addTaskLink(t1.id, t2.id, 'after-merge');
check('a chain link is created with its gate', Boolean(chain) && chain.gate === 'after-merge');
check(
  'it reads back through listTaskLinks',
  store
    .listTaskLinks()
    .some((l) => l.id === chain.id && l.fromTaskId === t1.id && l.toTaskId === t2.id),
);

const dupChain = store.addTaskLink(t1.id, t2.id, 'stacked');
check(
  'the same pair cannot be linked twice even with a different gate — ' +
    'task_links has no type column, unlike ticket_links',
  dupChain === undefined,
);

const unknownChain = store.addTaskLink(t1.id, 'does-not-exist', 'after-merge');
check(
  'chaining to an unknown card is refused via the foreign key, not thrown',
  unknownChain === undefined,
);

const regated = store.setTaskLinkGate(chain.id, 'stacked');
check('setTaskLinkGate changes the gate without redrawing the arrow', regated.gate === 'stacked');
check(
  'the id and endpoints are unchanged by the regate',
  regated.id === chain.id && regated.fromTaskId === t1.id && regated.toTaskId === t2.id,
);

store.deleteTaskLink(chain.id);
check('the chain link is gone after deleteTaskLink', !store.listTaskLinks().some((l) => l.id === chain.id));

store.deleteTaskLink('does-not-exist');
check('deleting an unknown chain link id is a silent no-op, not a throw', true);

const crossProjectChain = store.addTaskLink(t1.id, tOther.id, 'after-merge');
check(
  'a chain link can cross projects — nothing in the store scopes it to one board',
  Boolean(crossProjectChain),
);

// t3 was deleted in section 1 — a fresh card here means this section proves ITS OWN
// cascade rather than reusing a card another section already deleted, which would prove
// nothing new.
const t4 = store.createTask(projA.id, { title: 'card four' });
const cascadeChain = store.addTaskLink(t2.id, t4.id, 'after-merge');
check('a fresh chain link was created for the cascade check', Boolean(cascadeChain));
store.deleteTask(cascadeChain.toTaskId);
check(
  'deleting a card takes its chain links with it',
  !store.listTaskLinks().some((l) => l.id === cascadeChain.id),
);

// ---------------------------------------------------------------------------
section('3. Graph-view node layout (getTicketGraphLayout / saveTicketGraphLayout)');

check(
  'a project with nothing dragged yet has an empty saved layout',
  store.getTicketGraphLayout(projA.id).length === 0,
  JSON.stringify(store.getTicketGraphLayout(projA.id)),
);

store.saveTicketGraphLayout(projA.id, [
  { taskId: t1.id, x: 100, y: 200 },
  { taskId: t2.id, x: 300, y: 400 },
]);
const layoutAfterSave = store.getTicketGraphLayout(projA.id);
check(
  'both positions round-trip',
  layoutAfterSave.length === 2 &&
    layoutAfterSave.some((p) => p.taskId === t1.id && p.x === 100 && p.y === 200) &&
    layoutAfterSave.some((p) => p.taskId === t2.id && p.x === 300 && p.y === 400),
  JSON.stringify(layoutAfterSave),
);

store.saveTicketGraphLayout(projA.id, [{ taskId: t1.id, x: 999, y: 888 }]);
const layoutAfterMove = store.getTicketGraphLayout(projA.id);
const t1AfterMove = layoutAfterMove.find((p) => p.taskId === t1.id);
check(
  'saving again for the same ticket UPSERTS its position rather than adding a row',
  layoutAfterMove.length === 2 && Boolean(t1AfterMove) && t1AfterMove.x === 999 && t1AfterMove.y === 888,
  JSON.stringify(layoutAfterMove),
);
const t2Untouched = layoutAfterMove.find((p) => p.taskId === t2.id);
check(
  'the ticket not re-saved keeps its earlier position',
  Boolean(t2Untouched) && t2Untouched.x === 300 && t2Untouched.y === 400,
);

// The store's own doc comment on saveTicketGraphLayout: it is "not scoped to projectId
// beyond what it stamps on new rows" — an upsert re-stamps whichever projectId the
// CALL carried, trusting the caller rather than checking the ticket's real project.
store.saveTicketGraphLayout(projB.id, [{ taskId: t1.id, x: 1, y: 2 }]);
const underA = store.getTicketGraphLayout(projA.id);
const underB = store.getTicketGraphLayout(projB.id);
check(
  "re-saving t1's position under projB's id moves the row — " +
    "projA's layout no longer lists it",
  !underA.some((p) => p.taskId === t1.id),
  JSON.stringify(underA),
);
check(
  "and projB's layout now does, with the new position",
  underB.some((p) => p.taskId === t1.id && p.x === 1 && p.y === 2),
  JSON.stringify(underB),
);

// Put it back under projA so the cascade checks below read cleanly.
store.saveTicketGraphLayout(projA.id, [{ taskId: t1.id, x: 999, y: 888 }]);

const cascadeLayoutTask = store.createTask(projA.id, { title: 'card five' });
store.saveTicketGraphLayout(projA.id, [{ taskId: cascadeLayoutTask.id, x: 5, y: 5 }]);
check(
  'the position exists before the delete',
  store.getTicketGraphLayout(projA.id).some((p) => p.taskId === cascadeLayoutTask.id),
);
store.deleteTask(cascadeLayoutTask.id);
check(
  'deleting a ticket takes its saved graph position with it',
  !store.getTicketGraphLayout(projA.id).some((p) => p.taskId === cascadeLayoutTask.id),
);

// The chaining-tickets fix round (plan step 22) added epic-as-a-zone grouping to the Graph
// view (layoutNodes nests a child under its epic's zone with a parentId, packages/ui's own
// graphLayout.test.ts proves that) and to the Timeline (ganttEpicBands, ganttLayout.test.ts).
// Neither of those is store-backed — layoutNodes/ganttEpicBands are pure functions that never
// touch the database — but the saved POSITIONS an epic and its children drag to are, through
// this same getTicketGraphLayout/saveTicketGraphLayout pair, and the store treats every taskId
// identically whether or not it names an epic. This proves that indifference rather than
// assuming it: an epic's own position and a child's both round-trip, independently, exactly
// like the plain tickets above.
const epicForLayout = store.createTask(projA.id, { title: 'Epic with a zone', issueType: 'epic' });
const childForLayout = store.createTask(projA.id, {
  title: 'Child in the zone',
  epicTaskId: epicForLayout.id,
});
store.saveTicketGraphLayout(projA.id, [
  { taskId: epicForLayout.id, x: 0, y: 500 },
  { taskId: childForLayout.id, x: 40, y: 540 },
]);
const epicLayout = store.getTicketGraphLayout(projA.id);
check(
  "an epic's own saved position round-trips",
  epicLayout.some((p) => p.taskId === epicForLayout.id && p.x === 0 && p.y === 500),
  JSON.stringify(epicLayout),
);
check(
  "its child's saved position round-trips independently of the epic's",
  epicLayout.some((p) => p.taskId === childForLayout.id && p.x === 40 && p.y === 540),
  JSON.stringify(epicLayout),
);

const doomedProj = store.addProject({ path: '', kind: 'ticket', ticketPrefix: 'CXD', name: 'doomed' });
const doomedTask = store.createTask(doomedProj.id, { title: 'going down with its project' });
store.saveTicketGraphLayout(doomedProj.id, [{ taskId: doomedTask.id, x: 7, y: 7 }]);
check(
  'the position exists before the project delete',
  store.getTicketGraphLayout(doomedProj.id).length === 1,
);
store.removeProject(doomedProj.id);
const doomedRow = raw
  .prepare('SELECT * FROM ticket_graph_positions WHERE taskId = ?')
  .get(doomedTask.id);
check(
  "deleting a project takes its tickets' saved graph positions with it",
  doomedRow === undefined,
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
