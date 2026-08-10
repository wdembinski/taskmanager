/**
 * Headless verification for the blocked round trip — the half `vitest` cannot reach.
 *
 * The bug this round fixed: dragging a card into IN PROGRESS moved the JIRA ticket to
 * **Blocked**. Every piece of the fix is unit-tested (`statusResolve.test.ts`,
 * `jiraMove.test.ts`, `jiraSync.test.ts`, `blockOwnerMigration.test.ts`), and all of it is
 * pure. What none of those tests touches is the one impure step in the middle:
 * `ipc.ts`'s `transitionIssue`, which asks the instance for a workflow, hands it to
 * `pickTransition`, and POSTs the id that comes back. `ipc.ts` has no test file, and
 * building a harness for a 2400-line `registerIpc` closure is a project rather than a
 * step — so this verifies the **HTTP round trip** instead, over a real socket.
 *
 * What is REAL here, and therefore what a failure below is evidence about:
 *
 *   - `JiraClient.getTransitions` and `doTransition` — the URL they build, the auth header
 *     they send, the JSON body they post, and their handling of a `204` and of a refusal;
 *   - `pickTransition`, `resolveMove` and `shouldLearnStatus`, called with exactly what a
 *     real instance answered with rather than with a hand-written transition list;
 *   - `isBlockedishStatus` and the whole tier stack underneath it;
 *   - a throwaway `http` server standing in for JIRA, so nothing is mocked below the socket.
 *
 * What is MIRRORED: the ~20 lines of `transitionIssue` and `preBlockMarker` themselves, and
 * the `task:move` handler around them. They are copied from `ipc.ts` deliberately line for
 * line so the shape of the mirror is checkable by eye against the original; the assertions
 * below are on what the REAL code returned and on what really went over the wire, never on
 * the mirror's own wording. If `ipc.ts` changes, this file must be re-read against it — that
 * is the cost of the closure not being reachable.
 *
 * The scenarios, in order:
 *
 *   1. the reported workflow verbatim — "Block" declared FIRST, then "Start Progress" — and
 *      an IN PROGRESS drag that must post Start Progress;
 *   2. the same workflow with its in-progress status NOT named after the column, which is
 *      the case only `isBlockedishStatus` can save (see "proving it can fail" below), plus
 *      the poisoned `{"Blocked":"in-progress"}` learned entry every affected install carries;
 *   3. a drop into BLOCKED, which must post the Block transition and leave the block the
 *      TRACKER's (`preBlockStatus` null);
 *   4. a workflow with no blocked status at all — the local-only fallback: a GET, no POST,
 *      and a block the APP owns;
 *   5. a POST the instance refuses, which must still throw;
 *   6. an internal card, which must touch the network not at all.
 *
 * **Proving it can fail.** Revert the blocked tier in `packages/shared/src/statusResolve.ts` —
 * either by deleting the `isBlockedishStatus` line from `resolveStatusColumn` or by making
 * `isBlockedishStatus` itself `return false` — and this goes red with **13 failures**, the
 * same 13 either way. Two of them are the reported bug, reproduced: section 2 posts
 * transition `12` (Block) for a drag into IN PROGRESS, and the card reads back "Blocked".
 * With the tier gone, "Blocked" resolves by its `indeterminate` category again, so it and
 * "In Development" land in the same tier, neither is literally named "In Progress", and the
 * workflow's declaration order hands the drag straight back to Block. Section 3 goes red too,
 * from the other side: with no status resolving to BLOCKED, the drop into BLOCKED finds no
 * transition and falls back to blocking locally.
 *
 * Section 1's own drag stays GREEN under the mutation, on purpose — there the destination
 * really is called "In Progress", so step 3's name preference catches it independently. That
 * is why section 2 exists: it is the case that isolates the tier from the second defence.
 * (One check in section 1 does go red, the one asserting where Block resolves to. It is a
 * claim about the tier, not about the drag.)
 *
 * The app is NEVER launched (RELEASE.md rule 6 — there is no single-instance lock, and a
 * second instance killed a live session on 2026-08-02). Nothing here opens the profile, a
 * database, or a real network: the only socket is on `127.0.0.1` with a port the OS picked.
 *
 * How it works, and why it is not simply a `node` script: `jiraClient.ts` and `jiraMove.ts`
 * are TypeScript with `@shared` aliases, so the scenario file is bundled with Vite first.
 * Unlike `verify-round.mjs` and `verify-jira-archive.mjs` it then runs under **plain Node**
 * rather than Electron-as-Node: nothing on this path reaches the store, so there is no
 * `better-sqlite3` and no ABI to match. `electron` is still aliased to a throwing stub, so a
 * scenario that ever does reach it fails loudly instead of quietly verifying nothing.
 *
 *   pnpm exec node scripts/verify-jira-move.mjs
 *
 * Exits non-zero if any assertion failed, naming it.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/** `@shared` now lives in the packages/shared workspace package, not under this app. */
const sharedSrc = join(repo, '..', '..', 'packages', 'shared', 'src');

/**
 * Everything this script writes lives here. Inside the repo rather than in the temp dir,
 * for consistency with the other `verify-*.mjs` work dirs and because a bundle that ever
 * does gain an external dependency must still have `node_modules` on its resolution path.
 * Removed on the way out, and on the way in — a crashed previous run must not leak into
 * this one. It is a scratch directory INSIDE a work tree, so nothing here may run git.
 */
const work = join(repo, '.verify-jira-move');

function log(message) {
  process.stdout.write(`${message}\n`);
}

/**
 * Nothing under test calls Electron on this path — the JIRA client is deliberately free of
 * it, which is what makes it testable at all — so every symbol throws rather than returning
 * a plausible value: a scenario that reaches it must fail loudly, not verify a stub.
 */
const ELECTRON_STUB = `
const unavailable = (name) => () => {
  throw new Error(\`Electron's \${name} is not available in headless verification\`);
};
export const app = { getPath: unavailable('app.getPath'), on: unavailable('app.on') };
export const ipcMain = { handle: unavailable('ipcMain.handle') };
export const safeStorage = { isEncryptionAvailable: unavailable('safeStorage') };
export const BrowserWindow = class {};
export default { app, ipcMain, safeStorage, BrowserWindow };
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
      rollupOptions: { output: { format: 'es', entryFileNames: 'bundle.mjs' } },
    },
  });
  return join(outDir, 'bundle.mjs');
}

/** Run the bundle under the Node that is running this script. No native addon is involved. */
function runUnderNode(bundlePath) {
  const result = spawnSync(process.execPath, [bundlePath], { encoding: 'utf8' });
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
    const entry = join(work, 'entry.ts');
    writeFileSync(entry, SCENARIOS.replaceAll('__REPO__', repo.replace(/\\/g, '/')), 'utf8');
    log('Running the scenarios against the current code...');
    runUnderNode(await bundle(entry, join(work, 'out')));
    log('\nAll scenarios passed.');
  } finally {
    // `--keep` leaves the bundle behind, which is the only way to read what a failing
    // scenario was actually compiled into.
    if (process.argv.includes('--keep')) log(`\nLeft ${work} in place (--keep).`);
    else rmSync(work, { recursive: true, force: true });
  }
}

/**
 * The scenarios themselves, as a template so the repo path is baked in rather than passed —
 * a bundle takes no argv worth threading.
 *
 * No backticks and no `${` below: `String.raw` still interpolates, so a template literal in
 * here would be evaluated by THIS file rather than by the scenario. Plain quotes and `+`.
 */
const SCENARIOS = String.raw`
import { createServer } from 'node:http';
import { categoryFromKey, restingStatus } from '@shared/board';
import { PERSONAL_PROJECT_ID } from '@shared/model';
import { DEFAULT_JIRA_SETTINGS } from '@shared/settings';
import { isBlockedishStatus } from '@shared/statusResolve';
import { humanStatusPatch } from '__REPO__/src/main/cardStatusGuard';
import { JiraClient, JiraError } from '__REPO__/src/main/jira/jiraClient';
import {
  TARGET_LABEL,
  pickTransition,
  resolveMove,
  shouldLearnStatus,
} from '__REPO__/src/main/jira/jiraMove';

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

// ===========================================================================
// A JIRA instance, on a real socket.

const KEY = 'AB-1';
const PATH = '/rest/api/2/issue/' + KEY + '/transitions';

/** The three status categories, by the stable keys JIRA sends (never the display names). */
const PROGRESS = { key: 'indeterminate', name: 'In Progress' };
const TODO = { key: 'new', name: 'To Do' };
const FINISHED = { key: 'done', name: 'Done' };

/** The workflow this instance answers with. Swapped between scenarios. */
let workflow = [];
/** Every request the server saw, in order — method, path, headers and body. */
let seen = [];
/** What the next POST answers with. 204 is what a real JIRA returns for an accepted move. */
let postReply = { status: 204 };

const server = createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => {
    body += chunk;
  });
  req.on('end', () => {
    seen.push({
      method: req.method,
      url: req.url,
      auth: req.headers.authorization,
      accept: req.headers.accept,
      contentType: req.headers['content-type'],
      body,
    });
    if (req.method === 'GET' && req.url === PATH) {
      // Shaped like the real answer, extra keys and all: the client must read
      // 'transitions' off it rather than assume the whole body is the list.
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ expand: 'transitions', transitions: workflow }));
      return;
    }
    if (req.method === 'POST' && req.url === PATH) {
      if (postReply.status === 204) {
        res.writeHead(204);
        res.end();
        return;
      }
      res.writeHead(postReply.status, { 'Content-Type': 'application/json' });
      res.end(postReply.body === undefined ? '' : postReply.body);
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('no route for ' + req.method + ' ' + req.url);
  });
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const port = server.address().port;

// The token carries pasted whitespace on purpose — sanitizeToken repairs that at the point
// of use, and the header below is where that can actually be observed (see v0.71.0).
const client = new JiraClient({
  baseUrl: 'http://127.0.0.1:' + port,
  apiVersion: '2',
  auth: { mode: 'bearer', token: '  a-pasted-token\n' },
});

/** Start a scenario: install a workflow, forget what the server has seen. */
function instance(next, reply) {
  workflow = next;
  seen = [];
  postReply = reply === undefined ? { status: 204 } : reply;
}

/** The transition ids posted so far, in order. */
const posted = () =>
  seen.filter((r) => r.method === 'POST').map((r) => JSON.parse(r.body).transition.id);

const settings = (over) => ({ ...DEFAULT_JIRA_SETTINGS, ...over });

/**
 * pickTransition legitimately returns null, and every assertion below has to survive that:
 * a mutation that breaks the picker must produce a readable FAIL naming the claim, not a
 * TypeError three frames deep that says nothing about which rule stopped holding.
 */
const pick = (list, target, jira) =>
  pickTransition(list, target, jira) ?? { transition: { id: null, name: null }, via: null };

/** A card on the Personal board, linked to AB-1 unless said otherwise. */
function card(over) {
  return {
    id: 'card-1',
    projectId: PERSONAL_PROJECT_ID,
    parentTaskId: null,
    title: 'the card that was dragged',
    status: 'pending',
    preRunStatus: null,
    preBlockStatus: null,
    externalSource: 'jira',
    externalKey: KEY,
    externalStatus: 'To Do',
    externalStatusCategory: 'To Do',
    ...over,
  };
}

// ===========================================================================
// ipc.ts, mirrored. Copied line for line from registerIpc's transitionIssue,
// preBlockMarker and the task:move handler — everything except the parts that need the
// closure (buildJiraClient, store, send). Assertions are never on this code's own wording.

const preBlockMarker = (move, outcome) => (outcome && outcome.applied ? null : move.preBlockStatus);

async function transitionIssue(task, target, jira) {
  if (task.externalSource !== 'jira' || !task.externalKey) return { applied: false, patch: {} };
  const transitions = await client.getTransitions(task.externalKey);
  const choice = pickTransition(transitions, target, jira);
  if (!choice && target === 'toBlocked') return { applied: false, patch: {} };
  if (!choice) {
    const blocking = transitions.filter((t) =>
      isBlockedishStatus(t.to.name, categoryFromKey(t.to.statusCategory.key)),
    );
    const aside = blocking.length
      ? ' The closest this workflow offers is ' +
        blocking.map((t) => '"' + t.name + '" (to ' + t.to.name + ')').join(', ') +
        ', which reads as BLOCKED, not ' + TARGET_LABEL[target] + '.'
      : '';
    throw new Error(
      'No JIRA transition to ' + TARGET_LABEL[target] + ' is available for ' + task.externalKey +
        '.' + aside + ' Set an exact transition name in Settings if your workflow uses a custom one.',
    );
  }
  const picked = choice.transition;
  await client.doTransition(task.externalKey, picked.id);
  const category = categoryFromKey(picked.to.statusCategory.key);
  return {
    applied: true,
    choice,
    // What learnStatusColumn would have been asked, so the map's own refusal is checkable.
    learn: { name: picked.to.name, category },
    patch: { externalStatus: picked.to.name, externalStatusCategory: category },
  };
}

/** The whole drag, as task:move performs it. Returns the card as it would have been saved. */
async function drag(task, toColumn, jira) {
  const move = resolveMove(task, toColumn);
  if (move.noop) return { task, move, outcome: null };
  const outcome = move.jiraTransition
    ? await transitionIssue(task, move.jiraTransition, jira)
    : null;
  const saved = {
    ...task,
    ...humanStatusPatch(task, move.localStatus),
    preBlockStatus: preBlockMarker(move, outcome),
    ...(outcome === null ? {} : outcome.patch),
  };
  return { task: saved, move, outcome };
}

// ===========================================================================
section('1. The reported workflow, with "Block" declared first');

// Verbatim as reported: the workflow lists its Block step BEFORE Start Progress, and both
// destinations sit in the indeterminate category — which is what made them
// indistinguishable to the old picker, and why dragging into IN PROGRESS blocked the ticket.
const REPORTED = [
  { id: '11', name: 'Block', to: { name: 'Blocked', statusCategory: PROGRESS } },
  { id: '21', name: 'Start Progress', to: { name: 'In Progress', statusCategory: PROGRESS } },
  { id: '31', name: 'Code Review', to: { name: 'In Review', statusCategory: PROGRESS } },
  { id: '41', name: 'Resolve', to: { name: 'Done', statusCategory: FINISHED } },
  { id: '51', name: 'Reopen', to: { name: 'To Do', statusCategory: TODO } },
];
instance(REPORTED);

check('the workflow really does declare Block first', workflow[0].name === 'Block', workflow[0].name);
check(
  'and both destinations are in the same JIRA category, so the category cannot tell them apart',
  workflow[0].to.statusCategory.key === workflow[1].to.statusCategory.key,
);

const jira = settings();
const dragged = await drag(card(), 'in-progress', jira);

check('the drag resolved to the toInProgress target', dragged.move.jiraTransition === 'toInProgress', String(dragged.move.jiraTransition));
check('exactly two requests went out — one GET, one POST', seen.length === 2, JSON.stringify(seen.map((r) => r.method + ' ' + r.url)));
check('the GET came first, and asked the right issue for its transitions', seen[0].method === 'GET' && seen[0].url === PATH, seen[0].method + ' ' + seen[0].url);
check('the POST went to the same URL', seen[1].method === 'POST' && seen[1].url === PATH, seen[1].url);
// The assertion this whole round exists for.
check(
  'the transition POSTed is Start Progress, NOT Block',
  JSON.stringify(posted()) === JSON.stringify(['21']),
  JSON.stringify(posted()) + ' (Block is 11, Start Progress is 21)',
);
check(
  'in the body shape JIRA expects',
  seen[1].body === JSON.stringify({ transition: { id: '21' } }),
  seen[1].body,
);
check('declared as JSON', seen[1].contentType === 'application/json', String(seen[1].contentType));
check('the GET carried no Content-Type — it has no body', seen[0].contentType === undefined, String(seen[0].contentType));
check('both requests asked for JSON back', seen.every((r) => r.accept === 'application/json'));
// Pasted whitespace really does reach the header, and really is stripped there.
check('and both carried the bearer token, whitespace stripped', seen.every((r) => r.auth === 'Bearer a-pasted-token'), String(seen[0].auth));

// The CATEGORY tier chose it, and that is the whole point: nothing about this workflow is
// configured, so the category is all there was to go on — and the old picker had exactly the
// same information and still took Block. What changed is that Blocked is no longer IN this
// tier: the blocked heuristic claims it one tier earlier, so the category tier is left with
// a single candidate rather than two it cannot choose between.
check('the plain category tier chose it', dragged.outcome.choice?.via === 'category', dragged.outcome.choice?.via);
check(
  'and Block was not in that tier to be chosen — it resolves to BLOCKED, one tier above',
  pick(REPORTED, 'toBlocked', jira).via === 'heuristic',
  pick(REPORTED, 'toBlocked', jira).via,
);
check('aiming where the drag aimed, so nothing is a mismatch', dragged.outcome.choice?.destinationColumn === 'in-progress' && dragged.outcome.choice?.mismatch === false);
check('the tracker moved', dragged.outcome.applied === true);
check('the card reads back the status JIRA now has', dragged.task.externalStatus === 'In Progress' && dragged.task.externalStatusCategory === 'In Progress', dragged.task.externalStatus + '/' + dragged.task.externalStatusCategory);
check('the card rests in IN PROGRESS', restingStatus(dragged.task) === 'in-progress', restingStatus(dragged.task));
check('and nothing was remembered to un-block, because nothing was blocked', dragged.task.preBlockStatus === null, String(dragged.task.preBlockStatus));

// The other three columns, over the same workflow — a fix for IN PROGRESS that broke a
// neighbouring drag would be no fix at all.
for (const [column, target, id] of [
  ['in-review', 'toInReview', '31'],
  ['done', 'toDone', '41'],
  ['todo', 'toTodo', '51'],
]) {
  instance(REPORTED);
  const other = await drag(card({ status: 'in-progress' }), column, jira);
  check(
    'dragging to ' + column + ' still posts ' + id + ', not Block',
    other.move.jiraTransition === target && JSON.stringify(posted()) === JSON.stringify([id]),
    String(other.move.jiraTransition) + ' posted ' + JSON.stringify(posted()),
  );
}

// The human's own map outranks everything, including the new blocked tier. Somebody who has
// written "Blocked means IN PROGRESS" in Settings has said something explicit, and this
// picks Block for an IN PROGRESS drag on purpose — the fix neutralises the map the APP
// wrote itself, never the one the human wrote.
instance(REPORTED);
await drag(card(), 'in-progress', settings({ statusCategoryOverrides: { Blocked: 'in-progress' } }));
check(
  'an explicit "Blocked means IN PROGRESS" in Settings still wins — the human is never overruled',
  JSON.stringify(posted()) === JSON.stringify(['11']),
  JSON.stringify(posted()),
);

// ---------------------------------------------------------------------------
section('2. A workflow whose in-progress status is not named after the column');

// The same shape, but the destination is called "In Development" — which plenty of schemes
// do. This is the case that isolates the blocked tier: with it reverted, "Blocked" and "In
// Development" both fall into the same category tier, NEITHER is literally named "In Progress",
// and declaration order hands the drag straight back to Block. Section 1 above survives that
// mutation on its own (its status really is called "In Progress"); this one does not, which
// is what makes it the proof.
const RENAMED = [
  { id: '12', name: 'Block', to: { name: 'Blocked', statusCategory: PROGRESS } },
  { id: '22', name: 'Start Progress', to: { name: 'In Development', statusCategory: PROGRESS } },
  { id: '42', name: 'Resolve', to: { name: 'Done', statusCategory: FINISHED } },
];
instance(RENAMED);

const renamed = await drag(card(), 'in-progress', jira);
check(
  'the transition POSTed is Start Progress, though nothing is named after the column',
  JSON.stringify(posted()) === JSON.stringify(['22']),
  JSON.stringify(posted()) + ' (Block is 12, Start Progress is 22)',
);
check('and the card reads back In Development', renamed.task.externalStatus === 'In Development', String(renamed.task.externalStatus));
check(
  'because Blocked was never a candidate for this column at all',
  pick(RENAMED, 'toInProgress', jira).transition.id === '22' &&
    isBlockedishStatus('Blocked', 'In Progress') === true,
);

// The poisoned entry. Every install that hit this bug wrote {"Blocked":"in-progress"} into
// the learned map on the authority of a drag that "succeeded"; the refusal in
// resolveStatusColumn is what neutralises it in place, with no migration.
instance(RENAMED);
const poisoned = settings({ learnedStatusColumns: { Blocked: 'in-progress' } });
await drag(card(), 'in-progress', poisoned);
check(
  'a stale learned "Blocked means IN PROGRESS" does not send the drag back to Block',
  JSON.stringify(posted()) === JSON.stringify(['22']),
  JSON.stringify(posted()),
);
instance(RENAMED);
const poisonedBlock = await drag(card({ status: 'in-progress' }), 'blocked', poisoned);
check(
  'and BLOCKED is still reachable with that entry in place',
  JSON.stringify(posted()) === JSON.stringify(['12']) && poisonedBlock.outcome.applied === true,
  JSON.stringify(posted()),
);

// ---------------------------------------------------------------------------
section('3. Dropping a card into BLOCKED blocks the ticket');

instance(REPORTED);
const blocked = await drag(card({ status: 'in-progress' }), 'blocked', jira);

check('the drag resolved to the toBlocked target', blocked.move.jiraTransition === 'toBlocked', String(blocked.move.jiraTransition));
check('one GET and one POST, as for every other column', seen.length === 2 && seen[0].method === 'GET' && seen[1].method === 'POST', JSON.stringify(seen.map((r) => r.method)));
check(
  'the transition POSTed is Block',
  JSON.stringify(posted()) === JSON.stringify(['11']),
  JSON.stringify(posted()),
);
check('chosen by the blocked heuristic', blocked.outcome.choice?.via === 'heuristic' && blocked.outcome.choice?.destinationColumn === 'blocked', blocked.outcome.choice?.via + '/' + blocked.outcome.choice?.destinationColumn);
check('the tracker moved', blocked.outcome.applied === true);
check('the card reads back the tracker status', blocked.task.externalStatus === 'Blocked' && blocked.task.externalStatusCategory === 'In Progress', blocked.task.externalStatus + '/' + blocked.task.externalStatusCategory);
check('and rests in BLOCKED', restingStatus(blocked.task) === 'blocked', restingStatus(blocked.task));
// The marker. resolveMove OFFERS the column to restore; the outcome is what decides whether
// it is worth remembering, and a tracker-backed block is the tracker's to undo.
check('resolveMove offered the column the card came from', blocked.move.preBlockStatus === 'in-progress', String(blocked.move.preBlockStatus));
check(
  'but the saved marker is null — the TRACKER owns this block, so the next sync decides when it ends',
  blocked.task.preBlockStatus === null,
  String(blocked.task.preBlockStatus),
);
// The map must not learn from this. "Blocked means BLOCKED" needs no entry, and the map is
// shown to the user as a list of facts the app has worked out.
check(
  'and nothing is learned from it — a blocked-ish destination never enters the map',
  blocked.outcome.learn !== undefined &&
    shouldLearnStatus(blocked.outcome.learn.name, blocked.outcome.learn.category, 'blocked', jira) === false,
);

// ---------------------------------------------------------------------------
section('4. A workflow with no blocked status blocks locally instead');

const NO_BLOCK = [
  { id: '23', name: 'Start Progress', to: { name: 'In Progress', statusCategory: PROGRESS } },
  { id: '43', name: 'Resolve', to: { name: 'Done', statusCategory: FINISHED } },
];
instance(NO_BLOCK);

check('this workflow really has no blocked-ish step', NO_BLOCK.every((t) => !isBlockedishStatus(t.to.name, categoryFromKey(t.to.statusCategory.key))));
check('so the picker finds nothing for toBlocked', pickTransition(NO_BLOCK, 'toBlocked', jira) === null);

const local = await drag(card({ status: 'in-progress' }), 'blocked', jira);
check('the transitions were still asked for', seen.length === 1 && seen[0].method === 'GET', JSON.stringify(seen.map((r) => r.method)));
check(
  'but NOTHING was POSTed — a workflow that cannot say blocked is not a reason to refuse the human',
  posted().length === 0,
  JSON.stringify(posted()),
);
check('the outcome says the tracker did not move', local.outcome.applied === false && JSON.stringify(local.outcome.patch) === '{}');
check('the card still blocks', restingStatus(local.task) === 'blocked', restingStatus(local.task));
check('its tracker status is untouched', local.task.externalStatus === 'To Do', String(local.task.externalStatus));
check(
  'and the marker IS kept — this block is the app\'s own, so only the app can undo it',
  local.task.preBlockStatus === 'in-progress',
  String(local.task.preBlockStatus),
);

// The softness is scoped to toBlocked and nothing else: for every other column a missing
// transition means the drag is impossible, and moving the card anyway would be the board
// lying about a status the ticket has never been in.
instance(NO_BLOCK);
let refusal = null;
try {
  await drag(card(), 'in-review', jira);
} catch (e) {
  refusal = e;
}
check('a missing IN REVIEW transition is refused, not applied locally', refusal !== null, 'no throw');
check('and nothing was POSTed on the way out', posted().length === 0, JSON.stringify(posted()));

// ---------------------------------------------------------------------------
section('5. A POST the instance refuses still throws');

instance(REPORTED, { status: 400, body: '{"errorMessages":["Transition is not valid"],"errors":{}}' });
let rejection = null;
try {
  await drag(card(), 'in-progress', jira);
} catch (e) {
  rejection = e;
}
check('the drag threw rather than moving the card', rejection !== null, 'no throw');
check('as a JiraError carrying the status', rejection instanceof JiraError && rejection.status === 400, rejection && rejection.name + ' ' + rejection.status);
check(
  'and the instance\'s own explanation, so the bar can say what JIRA said',
  rejection !== null && /Transition is not valid/.test(rejection.message),
  rejection && rejection.message,
);
check('the POST really was attempted', JSON.stringify(posted()) === JSON.stringify(['21']), JSON.stringify(posted()));

// ---------------------------------------------------------------------------
section('6. An internal card never touches JIRA');

instance(REPORTED);
const internal = await drag(card({ externalSource: null, externalKey: null, status: 'in-progress' }), 'blocked', jira);
check('no request was made at all', seen.length === 0, JSON.stringify(seen.map((r) => r.method)));
check('resolveMove asked for no transition', internal.move.jiraTransition === null, String(internal.move.jiraTransition));
check('the card blocks', restingStatus(internal.task) === 'blocked', restingStatus(internal.task));
check('and the block is the app\'s, so the column to restore is remembered', internal.task.preBlockStatus === 'in-progress', String(internal.task.preBlockStatus));

// ---------------------------------------------------------------------------
server.close();

console.log('');
if (failures > 0) {
  console.error(failures + ' check(s) failed.');
  process.exit(1);
}
`;

await main();
