/**
 * Headless verification for the "incomplete answer" round: a JIRA instance that
 * under-answers one poll and answers fully on the next must take nothing off the board, and
 * the notice bar it raises must not persist once JIRA recovers.
 *
 * `jiraSync.test.ts` and `jiraSync.integration.test.ts` already prove the DECISION —
 * `reconcileJiraTasks` removes nothing for a large, query-unchanged shortfall and says so
 * quietly. What neither of them touches is the REAL DATABASE (do those removals, all zero of
 * them, actually leave every row on the board across two real syncs?) or the notice-dedupe
 * logic in `ipc.ts`'s `syncJira` — `jiraGuardRefused` / `lastJiraNotice` / `dedupeNotice`,
 * which exist only as closures inside `registerIpcHandlers` and have no test file, by that
 * file's own stated design ("a handler growing a rule it alone knows is the signal to
 * extract, not to build the harness" — see `ipc.ts`'s top-of-file docstring).
 *
 * So this drives the REAL `reconcileJiraTasks` against a REAL SQLite store across a pair of
 * polls (Sections 1-3), and separately MIRRORS the ~6 lines of `ipc.ts`'s notice-dedupe
 * (Section 0, `pollerNotice` / `manualNotice`) — copied deliberately so the shape is checkable
 * by eye against `ipc.ts`, the same approach `verify-jira-move.mjs` takes for `transitionIssue`.
 * If `ipc.ts`'s dedupe condition ever changes, this file must be re-read against it; nothing
 * below asserts on the mirror's own wording, only on what it decided to send.
 *
 * Section 4 proves the mechanism, not just the outcome: it feeds `guardRemovals` (unchanged,
 * imported for real) the exact 52-candidate set the user's own bug report named — "Kept 52 of
 * 82 JIRA cards..." — and gets that loud sentence back verbatim. That is the contrast for
 * Sections 1-3: the fix is not that `guardRemovals` was softened, it is that `reconcileJiraTasks`
 * no longer ever builds that candidate set for a query-unchanged shortfall (see the sweep in
 * `jiraSync.test.ts`), so the loud sentence has nowhere left to come from.
 *
 * The app is NEVER launched (RELEASE.md rule 6). This drives `store.ts` and `jiraSync.ts`
 * directly under `ELECTRON_RUN_AS_NODE`, against a scratch database under `.verify-incomplete-
 * jira-answer/`. It never opens, reads or writes the real profile.
 *
 *   pnpm exec node scripts/verify-incomplete-jira-answer.mjs
 *
 * Exits non-zero on the first failed assertion, naming it.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const require = createRequire(import.meta.url);
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/** `@shared` now lives in the packages/shared workspace package, not under this app. */
const sharedSrc = join(repo, '..', '..', 'packages', 'shared', 'src');

/**
 * Everything this script writes lives here, INSIDE the repo rather than in the temp dir, for
 * the same reason every other `verify-*.mjs` does it: the bundle keeps `better-sqlite3`
 * external, so it must sit somewhere Node's resolution can still walk up to `node_modules`.
 * Removed on the way out, and on the way in — a crashed previous run must not leak into this
 * one. It is a scratch directory INSIDE a work tree, so nothing here may run git.
 */
const work = join(repo, '.verify-incomplete-jira-answer');

const electronBin = join(repo, 'node_modules', 'electron', 'dist', 'electron.exe');
const electronBinPosix = join(repo, 'node_modules', 'electron', 'dist', 'electron');

function log(message) {
  process.stdout.write(`${message}\n`);
}

/**
 * Nothing on this path calls into Electron: neither `store.ts` nor `jiraSync.ts` touch it, so
 * every symbol throws rather than returning a plausible value — a scenario that ever does
 * reach it must fail loudly here instead of quietly verifying a stub.
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
      // The native addon must stay a real `import` resolved at run time — bundling a `.node`
      // file is exactly the mistake this whole ABI dance exists to avoid.
      rollupOptions: {
        external: ['better-sqlite3'],
        output: { format: 'es', entryFileNames: 'bundle.mjs' },
      },
    },
  });
  return join(outDir, 'bundle.mjs');
}

/** Run the bundle under Electron-as-Node, so `better_sqlite3.node` loads against its own ABI. */
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
    // The ABI the whole exercise depends on, checked first and by itself — every scenario
    // below fails identically and unhelpfully when this is wrong.
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

    const entry = join(work, 'entry.ts');
    writeFileSync(entry, SCENARIOS.replaceAll('__REPO__', repo.replace(/\\/g, '/')), 'utf8');
    log('\nRunning the scenarios against the current code...');
    runUnderElectron(await bundle(entry, join(work, 'out')));

    log('\nAll scenarios passed.');
  } finally {
    // `--keep` leaves the bundle and the scratch database behind, the only way to open one
    // afterwards and see what a failing scenario actually wrote.
    if (process.argv.includes('--keep')) log(`\nLeft ${work} in place (--keep).`);
    else rmSync(work, { recursive: true, force: true });
  }
}

/**
 * The scenarios themselves, as a template so the repo path is baked in rather than passed — a
 * bundle takes no argv worth threading.
 *
 * No backticks and no `${` below: `String.raw` still interpolates, so a template literal in
 * here would be evaluated by THIS file rather than by the scenario. Plain quotes and `+`.
 */
const SCENARIOS = String.raw`
import { mkdirSync, rmSync } from 'node:fs';
import { createStore } from '__REPO__/src/main/store';
import { guardRemovals, isIncompleteAnswer } from '__REPO__/src/main/forge/removalGuard';
// The real reconciler — the round trip has to be driven by the thing that really decides, or
// this would only prove the script can call archiveTask by hand.
import { issueToBoardTask, reconcileJiraTasks } from '__REPO__/src/main/jira/jiraSync';

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

const PERSONAL = 'personal';
const JIRA_OPTS = { baseUrl: 'https://jira.example.com' };

const scratch = '__REPO__/.verify-incomplete-jira-answer/scratch';
rmSync(scratch, { recursive: true, force: true });
mkdirSync(scratch, { recursive: true });

const store = createStore(scratch + '/orchestrator.db');

// A board's worth of JIRA cards, written the way the app really writes one — through
// issueToBoardTask + upsertJiraTask, not a hand-built lookalike. See verify-jira-archive.mjs's
// section 8 for why: the id has to be the store's own, not the reconciler's fallback id, or
// every "same row" check below would pass by coincidence.
function jiraIssue(prefix, n, category) {
  return {
    id: prefix + '-' + n,
    key: prefix + '-' + n,
    fields: {
      summary: 'Card for ' + prefix + '-' + n,
      status: {
        name: category === 'done' ? 'Closed' : 'To Do',
        statusCategory: { key: category || 'new', name: 'X' },
      },
      priority: { name: 'Medium' },
      project: { key: prefix, name: 'The Board' },
    },
  };
}

/** prefix distinguishes one seeded board from another — externalKey collisions would blur
 * which board a card belongs to and how many cards reconcileJiraTasks sees on it. */
function seedBoard(prefix, n) {
  const cards = [];
  for (let i = 1; i <= n; i++) {
    const local = store.createTask(PERSONAL, { title: 'Card for ' + prefix + '-' + i });
    cards.push(store.upsertJiraTask(issueToBoardTask(jiraIssue(prefix, i), local, JIRA_OPTS)));
  }
  return cards;
}

/** Re-derive the issue for a card already on the board, from its own externalKey. */
function issueFor(prefix, task, category) {
  return jiraIssue(prefix, Number(task.externalKey.slice(prefix.length + 1)), category);
}

/**
 * ipc.ts's syncJira notice-dedupe, MIRRORED — not called, since registerIpcHandlers needs a
 * real BrowserWindow, its own store and a settings row, none of which this is about (see
 * ipc.ts's own top-of-file docstring: "There is no test harness for this file, and that is the
 * design"). This is the same approach verify-jira-move.mjs takes for transitionIssue: copied
 * deliberately close enough to ipc.ts that the two are checkable by eye, side by side.
 *
 *   let jiraGuardRefused = false;
 *   let lastJiraNotice = null;
 *   ...
 *   const noticeChanged = warning !== lastJiraNotice;
 *   lastJiraNotice = warning;
 *   if (opts.dedupeNotice ? noticeChanged : warning) {
 *     send('board:notice', { text: warning ?? '', intent: 'warning' });
 *   }
 *
 * sent carries exactly what would have gone out 'board:notice', in order — '' standing for
 * the bar being told to clear, the only thing this channel has for "never mind".
 */
function noticeChannel() {
  let lastNotice = null;
  const sent = [];
  return {
    sent,
    // dedupeNotice true = the poller; false/absent = the button (manual sync).
    poll(warning, dedupeNotice) {
      const noticeChanged = warning !== lastNotice;
      lastNotice = warning;
      if (dedupeNotice ? noticeChanged : warning) sent.push(warning === null ? '' : warning);
    },
  };
}

/** Applied the way ipc.ts applies a reconcile result: archive first, then upsert. */
function apply(result) {
  for (const r of result.removals) store.archiveTask(r.taskId, Date.now(), r.reason);
  for (const t of result.upserts) store.upsertJiraTask(t);
}

// ---------------------------------------------------------------------------
section('0. A 30-card board, and the channel that watches its notices');

const board = seedBoard('BOARD', 30);
check('the board really has 30 cards', store.getPersonalTasks().length === 30);
const channel = noticeChannel();

// ---------------------------------------------------------------------------
section('1. Poll 1 — JIRA answers 18 of 30, the query unchanged: kept, quietly');

// The lying-total case: truncated: false and a total that matches what came back, exactly
// what a Cloud instance under load or mid-reindex looks like from here. The 12 missing keys
// are asked about by key too (queryChecked/queryMatches), and JIRA denies every one of them —
// the strongest case there is for a genuine removal, and still not enough on its own.
const missing1 = board.slice(18).map((t) => t.externalKey);
const poll1 = reconcileJiraTasks(store.getPersonalTasksForSync(), board.slice(0, 18).map((t) =>
  issueFor('BOARD', t)
), {
  ...JIRA_OPTS,
  queryChecked: missing1,
  queryMatches: [],
  truncated: false,
  queryChanged: false,
});

check('nothing was removed', poll1.removals.length === 0, JSON.stringify(poll1.removals));
check('nothing was refused either — guardRemovals never saw a candidate', poll1.refused.length === 0);
check(
  'the warning names the shortfall quietly',
  poll1.warning !== null && poll1.warning.indexOf('left out 12 of 30 board cards') !== -1,
  poll1.warning,
);
check(
  'and never the loud refusal sentence the user actually reported',
  poll1.warning.indexOf("Check the board's JQL") === -1,
  poll1.warning,
);
apply(poll1);
channel.poll(poll1.warning, true);

check('the board still has all 30 cards after poll 1', store.getPersonalTasks().length === 30);
check('none of them are archived', store.getArchivedTasks().length === 0);
check('exactly one notice went out so far', channel.sent.length === 1, JSON.stringify(channel.sent));
check(
  'and it is the quiet one, not empty and not the loud one',
  channel.sent[0] === poll1.warning,
);

// ---------------------------------------------------------------------------
section('2. Poll 2 — the SAME shortfall again: the poller does not repeat itself');

// JIRA is still unwell, two minutes later. Identical inputs, so isIncompleteAnswer trips the
// same way and (per jiraSync.test.ts's determinism test) the warning text is byte-identical —
// which is the precondition the poller's dedupe relies on to collapse this into nothing sent.
const poll2 = reconcileJiraTasks(store.getPersonalTasksForSync(), board.slice(0, 18).map((t) =>
  issueFor('BOARD', t)
), {
  ...JIRA_OPTS,
  queryChecked: missing1,
  queryMatches: [],
  truncated: false,
  queryChanged: false,
});

check('still nothing removed', poll2.removals.length === 0);
check('the warning text is identical to poll 1 — the dedupe precondition', poll2.warning === poll1.warning, poll2.warning);
apply(poll2);
channel.poll(poll2.warning, true);

check('the board still has all 30 cards after poll 2', store.getPersonalTasks().length === 30);
check(
  'the poller sent NOTHING new — a permanently-wrong-looking answer does not repeat the bar every poll',
  channel.sent.length === 1,
  JSON.stringify(channel.sent),
);

// ---------------------------------------------------------------------------
section('3. Poll 3 — JIRA recovers: the bar clears itself, and nothing was ever lost');

const poll3 = reconcileJiraTasks(store.getPersonalTasksForSync(), board.map((t) =>
  issueFor('BOARD', t)
), {
  ...JIRA_OPTS,
  truncated: false,
  queryChanged: false,
});

check('removes nothing — there was nothing to remove', poll3.removals.length === 0);
check('the warning clears', poll3.warning === null, String(poll3.warning));
apply(poll3);
channel.poll(poll3.warning, true);

check('the board has all 30 cards after all three polls', store.getPersonalTasks().length === 30);
check('and NOT ONE of them was ever archived, across the whole pair', store.getArchivedTasks().length === 0);
check(
  'the poller sent exactly two notices in total: the quiet warning, then the clear',
  JSON.stringify(channel.sent) === JSON.stringify([poll1.warning, '']),
  JSON.stringify(channel.sent),
);
check(
  'neither of them is the loud refusal — no red bar was ever possible here',
  channel.sent.every((n) => n.indexOf("Check the board's JQL") === -1),
);

// ---------------------------------------------------------------------------
section('3b. A manual sync always reports the truth, unaffected by the poller dedupe');

const manualChannel = noticeChannel();
manualChannel.poll(poll1.warning, false);
manualChannel.poll(poll2.warning, false); // identical text, but this is the button, not the poller
check(
  'both manual syncs sent a notice, even though the text repeated',
  manualChannel.sent.length === 2,
  JSON.stringify(manualChannel.sent),
);

// ---------------------------------------------------------------------------
section('4. A genuine query change still turns the board over normally');

// A second, independently-keyed board — distinct from section 0-3's so this scenario's
// removals cannot be confused with (or accidentally cancel out) that one's zero removals.
const board2 = seedBoard('TURN', 30);
// isIncompleteAnswer and guardRemovals both stand down on queryChanged — the sprint rolled
// over, the JQL was edited in Settings, and a shrinking board is then the expected outcome.
const turned = reconcileJiraTasks(store.getPersonalTasksForSync().filter((t) => t.externalKey && t.externalKey.indexOf('TURN-') === 0), board2.slice(0, 18).map((t) =>
  issueFor('TURN', t)
), {
  ...JIRA_OPTS,
  queryChecked: board2.slice(18).map((t) => t.externalKey),
  queryMatches: [],
  queryChanged: true,
});
check('all 12 genuinely-departed cards go through', turned.removals.length === 12, JSON.stringify(turned.removals.length));
check('none refused', turned.refused.length === 0);
check('no warning — an expected turnover is not a thing to warn about', turned.warning === null, String(turned.warning));
apply(turned);
check(
  'the 12 are actually gone from the board this time',
  store.getPersonalTasks().filter((t) => t.externalKey && t.externalKey.indexOf('TURN-') === 0).length === 18,
);
check(
  "and section 0-3's board of 30 is still untouched by this — the two scenarios did not bleed into each other",
  store.getPersonalTasks().filter((t) => t.externalKey && t.externalKey.indexOf('BOARD-') === 0).length === 30,
);

// ---------------------------------------------------------------------------
section('5. The mechanism, not just the outcome: the user\'s own message, reproduced on demand');

// guardRemovals is UNCHANGED — calling it directly with the 52-candidate shape from the bug
// report ("Kept 52 of 82 JIRA cards...") still refuses exactly as it always did. What changed
// is that reconcileJiraTasks no longer ever builds this candidate list for a query-unchanged
// shortfall (see jiraSync.test.ts's sweep) — the fix is upstream of this function, not in it.
const reported = [];
for (let i = 1; i <= 52; i++) {
  reported.push({ taskId: 'jira-' + i, key: 'PROJ-' + i, title: 'Do a thing', reason: 'left-query' });
}
const directGuard = guardRemovals(reported, 82, { tracker: 'JIRA', queryName: 'JQL' });
check('guardRemovals itself still refuses this shape', directGuard.refused.length === 52);
check(
  'and still produces the sentence the user actually saw',
  directGuard.warning === (
    'Kept 52 of 82 JIRA cards that JIRA says have left the query — more than 25% of the ' +
    'board in one sync. Nothing was removed. Check the board\'s JQL and that JIRA is ' +
    'answering it in full.'
  ),
  directGuard.warning,
);
// And the dedupe applies to THIS text too, uniformly — it does not special-case which branch
// produced the warning.
const loudChannel = noticeChannel();
loudChannel.poll(directGuard.warning, true);
loudChannel.poll(directGuard.warning, true);
check(
  'even a genuinely loud refusal is only ever posted once per poller cycle it repeats in',
  loudChannel.sent.length === 1,
  JSON.stringify(loudChannel.sent),
);

// ---------------------------------------------------------------------------
store.close();

console.log('');
if (failures > 0) {
  console.error(failures + ' check(s) failed.');
  process.exit(1);
}
`;

await main();
