/**
 * Headless verification for the one-shot conversion of `blocks` ticket links into order
 * arrows (`migration.blocksToArrows` in `store.ts`).
 *
 * `blocksLinkMigration.test.ts` covers the decision — which link converts, which is kept as
 * `relates`, which is deleted — against plain objects. What it cannot reach is the store
 * applying that plan: the arrows inserted, the links deleted and rewritten, the counts stored
 * as the guard's value, and above all the guard itself, so a second launch converts nothing.
 * Every store method needs a real `better-sqlite3`, which only loads inside Electron's own
 * ABI, so this drives `createStore` under `ELECTRON_RUN_AS_NODE` against a scratch database
 * and never opens, reads or writes the real profile (RELEASE.md rule 6 — the app itself is
 * never launched). Modelled on `verify-connections.mjs`.
 *
 *   pnpm exec node scripts/verify-blocks-migration.mjs
 *
 * The shape of it: create a store (the pass runs on an empty board and sets its key), seed
 * cards and `blocks`/`relates` ticket links and one pre-existing arrow straight into SQL,
 * clear the key, and re-open — that is the upgrade a real profile makes. Then seed one more
 * `blocks` link and re-open again: the guard must leave it exactly where it is.
 *
 * Exits non-zero on the first failed scenario run, naming every failed check.
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
/** @protocol for packages/protocol, which store.ts reaches through cloudDelta.ts. */
const protocolSrc = join(repo, '..', '..', 'packages', 'protocol', 'src');

/**
 * Everything this script writes lives here, INSIDE the app package: the bundle keeps
 * `better-sqlite3` external, so Node's resolution needs `node_modules` on the path, which
 * means the scratch dir has to sit somewhere that walk reaches. Removed on the way out, and
 * on the way in — a crashed previous run must not leak into this one.
 */
const work = join(repo, '.verify-blocks-migration');

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
    resolve: { alias: { '@shared': sharedSrc, '@protocol': protocolSrc, electron: stub } },
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
    log('\nRunning the blocks-migration scenarios against the real store...');
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
 * NO BACKTICKS below: this is a String.raw template, and one inside a comment closes it with
 * a SyntaxError pointing at a word in prose. A dollar-brace still interpolates in it too.
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

const KEY = 'migration.blocksToArrows';
const scratch = '__SCRATCH__';
rmSync(scratch, { recursive: true, force: true });
mkdirSync(scratch, { recursive: true });
const dbPath = scratch + '/orchestrator.db';

/** Open a raw handle, run fn against it, and close it again — never held across a store open. */
function withRaw(fn) {
  const raw = new Database(dbPath);
  raw.pragma('foreign_keys = ON');
  try {
    return fn(raw);
  } finally {
    raw.close();
  }
}

/** The pair-and-gate view of the arrows, sorted so two reads compare as strings. */
function arrows(raw) {
  return raw
    .prepare('SELECT fromTaskId, toTaskId, gate FROM task_links ORDER BY fromTaskId, toTaskId')
    .all();
}
function ticketLinks(raw) {
  return raw.prepare('SELECT id, fromTaskId, toTaskId, type FROM ticket_links ORDER BY id').all();
}
function stateValue(raw) {
  const row = raw.prepare('SELECT value FROM app_state WHERE key = ?').get(KEY);
  return row ? JSON.parse(row.value) : undefined;
}
const NONE = { converted: 0, duplicate: 0, missing: 0, step: 0, cycle: 0, unlanded: 0 };

// ---------------------------------------------------------------------------
section('1. A fresh store runs the pass once, over nothing');

let store = createStore(dbPath);
const proj = store.addProject({ path: '', kind: 'ticket', ticketPrefix: 'BM', name: 'blocks' });
const card = (title) => store.createTask(proj.id, { title }).id;
const a = card('a, converts');
const b = card('b, blocked by a');
const c = card('c, done outside the app');
const d = card('d, done and landed');
const e = card('e, blocked by c and d');
const f = card('f, already chained after e');
const p = card('p, a parent');
const s = card('s, a step of p');
const g = card('g, seeded after the pass');
const h = card('h, blocked by g');
store.close();

withRaw((raw) => {
  check(
    'the key is set on a fresh database, with nothing converted',
    JSON.stringify(stateValue(raw)) === JSON.stringify(NONE),
    JSON.stringify(stateValue(raw)),
  );
});

// ---------------------------------------------------------------------------
section('2. An upgraded profile: blocks links written before the rule');

withRaw((raw) => {
  raw.prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(c);
  raw.prepare("UPDATE tasks SET status = 'done', landedAt = 1000 WHERE id = ?").run(d);
  raw.prepare('UPDATE tasks SET parentTaskId = ? WHERE id = ?').run(p, s);
  raw
    .prepare(
      "INSERT INTO task_links (id, fromTaskId, toTaskId, gate, createdAt) VALUES ('pre-e-f', ?, ?, 'after-merge', 1)",
    )
    .run(e, f);
  const link = raw.prepare(
    'INSERT INTO ticket_links (id, fromTaskId, toTaskId, type, createdAt) VALUES (?, ?, ?, ?, ?)',
  );
  link.run('1-a-b', a, b, 'blocks', 10);
  link.run('2-b-a', b, a, 'blocks', 20);
  link.run('3-c-e', c, e, 'blocks', 30);
  link.run('4-d-e', d, e, 'blocks', 40);
  link.run('5-s-a', s, a, 'blocks', 50);
  link.run('6-e-f', e, f, 'blocks', 60);
  link.run('7-a-f', a, f, 'relates', 70);
  link.run('8-b-d', b, d, 'duplicates', 80);
  raw.prepare('DELETE FROM app_state WHERE key = ?').run(KEY);
});

store = createStore(dbPath);
store.close();

const afterFirst = withRaw((raw) => ({
  arrows: arrows(raw),
  links: ticketLinks(raw),
  state: stateValue(raw),
}));
const has = (from, to) =>
  afterFirst.arrows.some(
    (l) => l.fromTaskId === from && l.toTaskId === to && l.gate === 'after-merge',
  );
const typeOf = (id) => afterFirst.links.find((l) => l.id === id)?.type;

check('a blocks b became an after-merge arrow', has(a, b));
check('d blocks e (d landed) became an arrow', has(d, e));
check('the pre-existing arrow e to f is still there', has(e, f));
check(
  'exactly three arrows: the pre-existing one plus two converted',
  afterFirst.arrows.length === 3,
  JSON.stringify(afterFirst.arrows),
);
check(
  'the converted links are gone',
  typeOf('1-a-b') === undefined && typeOf('4-d-e') === undefined,
);
check('the duplicate of an existing arrow is gone', typeOf('6-e-f') === undefined);
check('b blocks a, which would loop, is kept as relates', typeOf('2-b-a') === 'relates');
check(
  'c blocks e, from a card done but never landed, is kept as relates',
  typeOf('3-c-e') === 'relates',
);
check('s blocks a, from a step, is kept as relates', typeOf('5-s-a') === 'relates');
check('no arrow was drawn for any demoted link', !has(b, a) && !has(c, e) && !has(s, a));
check('a relates link is untouched', typeOf('7-a-f') === 'relates');
check('a duplicates link is untouched', typeOf('8-b-d') === 'duplicates');
check(
  'no blocks ticket link is left',
  !afterFirst.links.some((l) => l.type === 'blocks'),
  JSON.stringify(afterFirst.links),
);
check(
  'the counts per outcome are the stored key',
  JSON.stringify(afterFirst.state) ===
    JSON.stringify({ ...NONE, converted: 2, duplicate: 1, step: 1, cycle: 1, unlanded: 1 }),
  JSON.stringify(afterFirst.state),
);

// ---------------------------------------------------------------------------
section('3. Re-opening runs nothing: the key guards the pass');

withRaw((raw) => {
  raw
    .prepare(
      "INSERT INTO ticket_links (id, fromTaskId, toTaskId, type, createdAt) VALUES ('9-g-h', ?, ?, 'blocks', 90)",
    )
    .run(g, h);
});
store = createStore(dbPath);
store.close();

const afterSecond = withRaw((raw) => ({
  arrows: arrows(raw),
  links: ticketLinks(raw),
  state: stateValue(raw),
}));
check(
  'the arrows are exactly as the first pass left them',
  JSON.stringify(afterSecond.arrows) === JSON.stringify(afterFirst.arrows),
  JSON.stringify(afterSecond.arrows),
);
check(
  'a blocks link written after the pass is left a blocks link',
  afterSecond.links.find((l) => l.id === '9-g-h')?.type === 'blocks',
  JSON.stringify(afterSecond.links),
);
check(
  'every other ticket link is as the first pass left it',
  JSON.stringify(afterSecond.links.filter((l) => l.id !== '9-g-h')) ===
    JSON.stringify(afterFirst.links),
);
check(
  'the stored counts are unchanged',
  JSON.stringify(afterSecond.state) === JSON.stringify(afterFirst.state),
  JSON.stringify(afterSecond.state),
);

console.log('');
if (failures > 0) {
  console.error(failures + ' check(s) failed.');
  process.exit(1);
}
`;

await main();
