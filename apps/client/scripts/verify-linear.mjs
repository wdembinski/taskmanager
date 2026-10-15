/**
 * Headless verification for the Linear integration — the half `vitest` cannot reach.
 *
 * `verify-github.mjs`, one tracker over, against a one-endpoint GraphQL server instead of a
 * REST tree. Every PURE piece of this feature already has a unit suite (`linearClient.test.ts`,
 * `linearQueries.test.ts`, `linearSync.test.ts`, `linearMove.test.ts`). What none of those
 * touches is the two impure joints the whole feature hangs off: the SOCKET — where a header, a
 * query document and a set of variables either are what Linear expects or are not — and the
 * STORE, where a card either lands on the row it landed on last time or quietly becomes a
 * second one. Both joints live inside `ipc.ts`'s `registerIpc` closure (`syncLinear`,
 * `moveLinearIssue`, `learnStateColumn`, the `linear:sync`-poller's `backoffUntil`), which has no
 * test file of its own, so this drives the real client, the real pure reconcilers and a real
 * store either side of a mirror of that closure.
 *
 * Six claims, end to end, in the order F4.10's acceptance list gives them:
 *
 *   1. an issue is ADOPTED onto the board, keyed by its UUID, in the column its STATE says —
 *      and every request on the way carries the API key with its pasted whitespace stripped,
 *      raw, with no "Bearer " prefix;
 *   2. a card SURVIVES a team move: Linear rewrites the identifier (`ENG-12` → `OPS-40`) on the
 *      same UUID, and the board must still be looking at one card, not two;
 *   3. dragging a card writes an `issueUpdate` mutation for the right issue and the right state,
 *      and a drop into BLOCKED writes nothing at all — it stays local, by design;
 *   4. an issue that drops out of the mirrored scope by finishing is RE-READ BY ID, kept and
 *      retained rather than vanishing the moment the human drags it to Done, and only archived
 *      once that retention window actually elapses;
 *   5. a rate limit hit during that re-read is RETHROWN rather than swallowed, so the poller's
 *      back-off actually engages, with the reset time read off Linear's own header;
 *   6. a revoked key answers with Linear's own shape for it (HTTP 400, `AUTHENTICATION_ERROR`
 *      in `errors`, no `data`) and is read as `LinearAuthError` specifically — and because the
 *      failure happens before any reconciliation runs, nothing already on the board is archived
 *      on the strength of a key that no longer works.
 *
 * The SECTION numbers below follow that list one for one, except 3, which carries both drag
 * claims (the write and the refusal) since they are one drop apart on the same board.
 *
 * What is REAL here, and therefore what a failure below is evidence about:
 *
 *   - `LinearClient` — the one endpoint, the raw (non-Bearer) `Authorization` header with
 *     `sanitizeToken` applied at the point of use, the GraphQL body it posts, and its three-way
 *     read of a response (`LinearAuthError` / `LinearRateLimitError` / `LinearGraphQLError`),
 *     including Linear's own quirk of answering a bad key with HTTP 400 rather than 401;
 *   - `buildIssueFilter`, `issuesQuery`, `issuesByIdQuery`, `commentsQuery`, `teamStatesQuery`,
 *     `issueUpdateStateMutation` — every document and variable set actually sent, read back by a
 *     server that answers them for real rather than by a hand-written fixture pretending to;
 *   - `issueToTask`, `reconcileLinearIssues`, `linearTaskId`, `issuesToRecheck` — driven by what
 *     the server really answered, including the fetch that drops an issue, the re-read that
 *     brings it back, and the retention clock that starts and later expires;
 *   - `resolveLinearMove` and `shouldLearnState` — against the issue's real current state on a
 *     real team's real workflow;
 *   - a real `store.ts` on a real SQLite file in a scratch profile, so "the card kept its id
 *     across a team move" is a claim about a database row rather than about an object literal;
 *   - a throwaway `http` server standing in for `api.linear.app/graphql`, with MUTABLE issue and
 *     team state — an `issueUpdate` mutation really changes the issue's state server-side, and
 *     the next fetch really reflects it. That is what makes claim 3 a round trip rather than two
 *     assertions that happen to agree with each other.
 *
 * What is MIRRORED: `syncLinear`, `moveLinearIssue`, `learnStateColumn`, `drag` (the `task:move`
 * handler's Linear path) and the `linear:sync`-poller's `backoffUntil` predicate, copied from
 * `ipc.ts` deliberately line for line so the shape of the mirror stays checkable by eye against
 * the original. The assertions below are on what the REAL code returned and on what really went
 * over the wire, never on the mirror's own wording — but the mirror is the one place a bug could
 * hide that no pure-function mutation below can reach (see the mutation table), because the
 * orchestration it performs — "fetch this team's states, then call `updateIssueState`", "rethrow
 * a rate limit rather than swallow it" — exists only inside `ipc.ts`'s closure. If `ipc.ts`
 * changes, this file must be re-read against it; that is the cost of the closure not being
 * reachable from the outside.
 *
 * The app is NEVER launched (RELEASE.md rule 6). The only socket is on `127.0.0.1` with a port
 * the OS picked, and the only database is in a scratch profile under the system temp dir, kept
 * outside the repository the same way `verify-github.mjs`'s is — a directory inside the repo is
 * inside a git work tree, a trap the moment anything under test asks git where it is.
 *
 * How it works: the modules under test are TypeScript with `@shared` aliases and an `electron`
 * import in `store.ts`'s dependency graph, so the scenario file is bundled with Vite first
 * (aliasing `electron` to a stub whose every symbol throws), then run under Electron-as-Node so
 * `better_sqlite3.node`'s ABI matches the binary loading it.
 *
 *   cd apps/client && pnpm run verify:linear
 *
 * Deliberately NOT in CI, for the same reason `verify-github.mjs` is not: it stands up a server
 * and runs under Electron-as-Node, a separate decision from "the unit tests run on every push".
 *
 * Exits non-zero if any assertion failed, naming it.
 *
 * ---------------------------------------------------------------------------------------------
 * PROVING IT CAN FAIL. 56 green checks say nothing until a mutation turns some of them red.
 * Run on 2026-10-15, one at a time, each restored afterwards with `git status` showing the
 * touched file byte-identical again before the next one and before the final green run:
 *
 *   - **Claim 1, the token.** Drop the `sanitizeToken(...)` call from `LinearClient.request`
 *     (`main/linear/linearClient.ts`), passing `this.config.apiKey` straight through: 1 red —
 *     the Authorization-header check in section 1, which expects the pasted whitespace gone.
 *   - **Claim 1/2, identity.** In `issueToTask` (`main/linear/linearSync.ts`), change
 *     `id: existing?.id ?? linearTaskId(issue.id)` to build the id from `issue.identifier`
 *     instead of the uuid: 1 red in section 1 (the card id no longer reads `linear-<uuid>`).
 *     Section 2's "kept the same id across the team move" check stays green on this particular
 *     mutation — the existing card is still found by `externalId`/uuid lookup regardless of how
 *     a *new* card's id would have been built — which is itself worth recording: identity
 *     survives the move because the LOOKUP is keyed on the uuid, not because the id-builder is.
 *   - **Claim 3, the write.** In this script's own mirror of `moveLinearIssue` (`ipc.ts` has no
 *     exported hook to mutate from outside), comment out the
 *     `await client.updateIssueState(task.externalId, state.id)` line while leaving the
 *     function's return value unchanged: 3 red in section 3 — no mutation request was seen, the
 *     issue's state on the server never changed, and the card never actually reaches IN
 *     PROGRESS on the next read-back. `outcome.applied` itself stays `true`, because nothing
 *     reads the network to question it — which is exactly why the round-trip assertions exist
 *     rather than trusting the return value alone.
 *   - **Claim 4.** Make `issuesToRecheck` (`main/linear/linearSync.ts`) return `[]`
 *     unconditionally: 10 red — 6 in section 4, and the whole of section 5 besides. The
 *     finished issue in section 4 is never re-read, so it neither gains a retention clock nor
 *     ever gets archived; it simply sits in TO DO forever, which is the bug `rechecked: null`
 *     vs. `[]` exists to distinguish from "Linear said it is gone". Section 5 fails too, for a
 *     reason worth recording rather than surprising: with nothing ever queued to recheck, the
 *     by-id call the rate limit was supposed to hit never happens either, so `syncLinear` never
 *     throws at all — the same one gate guards both the retention re-read and the rate-limit
 *     path's only chance to fire, and the board ends up merely *silent* about the dropped
 *     issue rather than correctly backing off because of it.
 *   - **Claim 5.** In this script's own mirror of `syncLinear`, delete the
 *     `if (e instanceof LinearRateLimitError) throw e;` line from the recheck's catch block (the
 *     matching real line is `ipc.ts`'s `syncLinear`, equally unreachable from outside): 4 red in
 *     section 5 — the sync no longer throws at all, so the rate limit is swallowed exactly like
 *     an ordinary failed recheck, there is no error left to type-check as a
 *     `LinearRateLimitError`, no `resetAt` to read, and the poller's back-off is never given
 *     anything to act on.
 *   - **Claim 6.** In `LinearClient.request` (`main/linear/linearClient.ts`), delete the
 *     `authError` branch so an `AUTHENTICATION_ERROR` falls through to the generic
 *     `LinearGraphQLError` path: 1 red in section 6 — the thrown error is no longer an
 *     `instanceof LinearAuthError`. The "nothing already on the board gets archived" half of the
 *     claim stays green even under this mutation, because that guarantee comes from the error
 *     being thrown at all (before reconciliation ever runs), not from its specific class — which
 *     is worth recording for the same reason as claim 2 above: two assertions that happen to
 *     share a section are not always protecting the same fact.
 * ---------------------------------------------------------------------------------------------
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const require = createRequire(import.meta.url);
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/** `@shared`/`@protocol` live in their own workspace packages, not under this app — the same
 * two aliases `electron.vite.config.ts` resolves to source for the real build. */
const sharedSrc = join(repo, '..', '..', 'packages', 'shared', 'src');
const protocolSrc = join(repo, '..', '..', 'packages', 'protocol', 'src');

/** The bundle, INSIDE the repo — see `verify-github.mjs`'s header for why. */
const work = join(repo, '.verify-linear');

/** The scratch profile, OUTSIDE the repo — see `verify-github.mjs`'s header for why. */
const scratch = join(tmpdir(), 'verify-linear-profile');

const electronBin = join(repo, 'node_modules', 'electron', 'dist', 'electron.exe');
const electronBinPosix = join(repo, 'node_modules', 'electron', 'dist', 'electron');

function log(message) {
  process.stdout.write(`${message}\n`);
}

/** Nothing on this path reaches Electron for real — see `verify-github.mjs`'s own copy. */
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
  rmSync(scratch, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  mkdirSync(scratch, { recursive: true });

  try {
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
    writeFileSync(
      entry,
      SCENARIOS.replaceAll('__REPO__', repo.replace(/\\/g, '/')).replaceAll(
        '__SCRATCH__',
        scratch.replace(/\\/g, '/'),
      ),
      'utf8',
    );
    log('\nRunning the scenarios against the current code...');
    runUnderElectron(await bundle(entry, join(work, 'out')));

    log('\nAll scenarios passed.');
  } finally {
    if (process.argv.includes('--keep')) {
      log(`\nLeft ${work} and ${scratch} in place (--keep).`);
    } else {
      rmSync(work, { recursive: true, force: true });
      rmSync(scratch, { recursive: true, force: true });
    }
  }
}

/**
 * No backticks and no `${` below — see `verify-github.mjs`'s own note on `String.raw`.
 */
const SCENARIOS = String.raw`
import { createServer } from 'node:http';
import { mkdirSync } from 'node:fs';
import { columnForTask, restingStatus } from '@shared/board';
import { DEFAULT_SETTINGS } from '@shared/settings';
import { linearCategory } from '@shared/statusResolve';
import { createStore } from '__REPO__/src/main/store';
import { humanStatusPatch } from '__REPO__/src/main/cardStatusGuard';
import { resolveMove } from '__REPO__/src/main/jira/jiraMove';
import {
  LinearAuthError,
  LinearClient,
  LinearRateLimitError,
} from '__REPO__/src/main/linear/linearClient';
import { buildIssueFilter } from '__REPO__/src/main/linear/linearQueries';
import {
  issuesToRecheck as linearIssuesToRecheck,
  linearTaskId,
  reconcileLinearIssues,
} from '__REPO__/src/main/linear/linearSync';
import { resolveLinearMove, shouldLearnState } from '__REPO__/src/main/linear/linearMove';

let failures = 0;
function check(label, condition, detail) {
  if (condition) {
    console.log('  PASS  ' + label);
  } else {
    failures += 1;
    console.log('  FAIL  ' + label + (detail === undefined ? '' : ' - ' + detail));
  }
}
function section(name) {
  console.log('\n' + name);
}
function iso(ms) {
  return new Date(ms).toISOString();
}

// Fixed clock. Nothing here reads the wall clock.
const T0 = 1_780_000_000_000; // the first sync (adopt)
const DAY = 24 * 60 * 60 * 1000;
const T1 = T0 + 60_000; // the team move
const T2 = T0 + DAY; // the drag
const T3 = T0 + 2 * DAY; // the issue finishes, out of scope
const T4 = T3 + 4 * DAY; // past the 3-day retention window
const T5 = T4 + 60_000; // the webhook card is filed, ahead of the rate-limit scenario
const T6 = T5 + 60_000; // the rate limit hits
const T7 = T6 + 60_000; // the key is revoked

const VIEWER_ID = '00000000-0000-4000-8000-0000000000aa';
const OTHER_ID = '00000000-0000-4000-8000-0000000000bb';

// ===========================================================================
// A Linear workspace, on a real socket, with MUTABLE state: an issueUpdate mutation really
// changes an issue's state, and the next fetch really reflects it.

const TEAM_ENG = { id: '00000000-0000-4000-8000-00000000e001', key: 'ENG' };
const TEAM_OPS = { id: '00000000-0000-4000-8000-00000000e002', key: 'OPS' };

const STATES = [
  { id: '00000000-0000-4000-8000-00000000a001', teamKey: 'ENG', name: 'Todo', type: 'unstarted', position: 1 },
  { id: '00000000-0000-4000-8000-00000000a002', teamKey: 'ENG', name: 'In Progress', type: 'started', position: 2 },
  { id: '00000000-0000-4000-8000-00000000a003', teamKey: 'ENG', name: 'In Review', type: 'started', position: 3 },
  { id: '00000000-0000-4000-8000-00000000a004', teamKey: 'ENG', name: 'Done', type: 'completed', position: 4 },
  { id: '00000000-0000-4000-8000-00000000a005', teamKey: 'ENG', name: 'Canceled', type: 'canceled', position: 5 },
  { id: '00000000-0000-4000-8000-00000000b001', teamKey: 'OPS', name: 'Backlog', type: 'backlog', position: 1 },
  { id: '00000000-0000-4000-8000-00000000b002', teamKey: 'OPS', name: 'Doing', type: 'started', position: 2 },
  { id: '00000000-0000-4000-8000-00000000b003', teamKey: 'OPS', name: 'Done', type: 'completed', position: 3 },
];
const stateById = (id) => STATES.find((s) => s.id === id);
const S_ENG_TODO = STATES[0];
const S_ENG_IN_PROGRESS = STATES[1];
const S_ENG_IN_REVIEW = STATES[2];
const S_ENG_DONE = STATES[3];
const S_OPS_DOING = STATES[6];

const U1 = '00000000-0000-4000-8000-000000000001'; // the crash card — team move, later
const U2 = '00000000-0000-4000-8000-000000000002'; // the onboarding card — dragged
const U3 = '00000000-0000-4000-8000-000000000003'; // the pricing card — dropped into blocked
const U4 = '00000000-0000-4000-8000-000000000004'; // the report card — done retention
const U5 = '00000000-0000-4000-8000-000000000005'; // the webhook card — rate limit

const issues = new Map();
function issue(id, identifier, title, description, priority, team, state, labels) {
  return {
    id,
    identifier,
    title,
    description,
    priority,
    updatedAt: iso(T0),
    team,
    state,
    labels: { nodes: labels.map((name) => ({ name })) },
    assignee: { id: VIEWER_ID, name: 'You' },
  };
}
issues.set(U1, issue(U1, 'ENG-12', 'Fix the crash on save', 'It throws when the dialog closes.', 2, TEAM_ENG, S_ENG_IN_PROGRESS, ['bug']));
issues.set(U2, issue(U2, 'ENG-7', 'Write the onboarding doc', '', 0, TEAM_ENG, S_ENG_TODO, []));
issues.set(U3, issue(U3, 'ENG-9', 'Research the pricing page', 'Needs a competitor scan.', 3, TEAM_ENG, S_ENG_IN_REVIEW, ['design']));
issues.set(U4, issue(U4, 'ENG-15', 'Ship the printable report', '', 0, TEAM_ENG, S_ENG_TODO, []));

/** Comments by issue uuid. One foreign, older; one mine, newer — same fixture shape as GitHub's. */
const comments = new Map();
comments.set(U1, [
  { id: 'c1', body: 'I can reproduce it.', createdAt: iso(T0 - 3_600_000), url: 'https://linear.app/c1', user: { id: OTHER_ID, name: 'Ada', displayName: 'Ada' } },
  { id: 'c2', body: 'Looking at it now.', createdAt: iso(T0 - 1_800_000), url: 'https://linear.app/c2', user: { id: VIEWER_ID, name: 'You', displayName: 'You' } },
]);

/** Every request the server saw, in order. */
let seen = [];
const since = (mark) => seen.slice(mark);

let authErrorMode = false;
let rateLimitNextRecheck = false;
const RATE_LIMIT_RESET_SECONDS = Math.floor(T6 / 1000) + 3600;

function opName(query) {
  const m = /(query|mutation)\s+(\w+)/.exec(query || '');
  return m ? m[2] : '';
}

function matchesFilter(issueRow, filter) {
  if (!filter) return true;
  if (filter.and) return filter.and.every((clause) => matchesFilter(issueRow, clause));
  if (filter.team && filter.team.key && filter.team.key.in) {
    return filter.team.key.in.indexOf(issueRow.team.key) >= 0;
  }
  if (filter.assignee && filter.assignee.isMe && typeof filter.assignee.isMe.eq === 'boolean') {
    const isMine = Boolean(issueRow.assignee) && issueRow.assignee.id === VIEWER_ID;
    return isMine === filter.assignee.isMe.eq;
  }
  if (filter.state && filter.state.type && filter.state.type.in) {
    return filter.state.type.in.indexOf(issueRow.state.type) >= 0;
  }
  return true;
}

function issueFields(row) {
  return {
    id: row.id,
    identifier: row.identifier,
    title: row.title,
    description: row.description,
    url: 'https://linear.app/acme/issue/' + row.identifier,
    priority: row.priority,
    updatedAt: row.updatedAt,
    state: { id: row.state.id, name: row.state.name, type: row.state.type },
    team: { id: row.team.id, key: row.team.key },
    labels: { nodes: row.labels.nodes.map((l) => ({ name: l.name })) },
    assignee: row.assignee ? { id: row.assignee.id, name: row.assignee.name } : null,
  };
}

const json = (res, status, body, headers) => {
  res.writeHead(status, Object.assign({ 'Content-Type': 'application/json' }, headers || {}));
  res.end(JSON.stringify(body));
};

const server = createServer((req, res) => {
  let raw = '';
  req.on('data', (chunk) => {
    raw += chunk;
  });
  req.on('end', () => {
    let payload;
    try {
      payload = raw ? JSON.parse(raw) : {};
    } catch {
      payload = {};
    }
    const op = opName(payload.query);
    const variables = payload.variables || {};
    seen.push({
      op,
      variables,
      auth: req.headers.authorization,
      contentType: req.headers['content-type'],
    });

    if (authErrorMode) {
      json(res, 400, {
        errors: [{ message: 'Authentication required - invalid API key', extensions: { code: 'AUTHENTICATION_ERROR' } }],
      });
      return;
    }

    if (op === 'Viewer') {
      json(res, 200, { data: { viewer: { id: VIEWER_ID, name: 'You', displayName: 'You' } } });
      return;
    }

    if (op === 'Issues') {
      const nodes = [...issues.values()].filter((row) => matchesFilter(row, variables.filter)).map(issueFields);
      json(res, 200, { data: { issues: { nodes, pageInfo: { hasNextPage: false, endCursor: null } } } });
      return;
    }

    if (op === 'IssuesByIds') {
      if (rateLimitNextRecheck) {
        json(
          res,
          200,
          { errors: [{ message: 'Rate limited', extensions: { code: 'RATELIMITED' } }] },
          { 'x-ratelimit-requests-reset': String(RATE_LIMIT_RESET_SECONDS) },
        );
        return;
      }
      const ids = variables.ids || [];
      const nodes = ids.map((id) => issues.get(id)).filter(Boolean).map(issueFields);
      json(res, 200, { data: { issues: { nodes, pageInfo: { hasNextPage: false, endCursor: null } } } });
      return;
    }

    if (op === 'IssueComments') {
      const id = variables.id;
      if (!issues.has(id)) {
        json(res, 200, { data: { issue: null } });
        return;
      }
      const rows = comments.get(id) || [];
      json(res, 200, {
        data: { issue: { comments: { nodes: rows, pageInfo: { hasNextPage: false, endCursor: null } } } },
      });
      return;
    }

    if (op === 'TeamStates') {
      const nodes = STATES.filter((s) => s.teamKey === variables.key).map((s) => ({
        id: s.id,
        name: s.name,
        type: s.type,
        position: s.position,
      }));
      json(res, 200, { data: { workflowStates: { nodes } } });
      return;
    }

    if (op === 'IssueUpdateState') {
      const row = issues.get(variables.id);
      const state = stateById(variables.stateId);
      if (!row || !state) {
        json(res, 200, { data: { issueUpdate: { success: false } } });
        return;
      }
      row.state = { id: state.id, name: state.name, type: state.type };
      row.updatedAt = iso(Date.now());
      json(res, 200, { data: { issueUpdate: { success: true, issue: issueFields(row) } } });
      return;
    }

    json(res, 404, { errors: [{ message: 'no route for op ' + op }] });
  });
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const port = server.address().port;
const BASE = 'http://127.0.0.1:' + port + '/graphql';

// ===========================================================================
// The store, on a real SQLite file in a scratch profile OUTSIDE the repo.

mkdirSync('__SCRATCH__', { recursive: true });
const store = createStore('__SCRATCH__/orchestrator.db');

const LINEAR = {
  ...DEFAULT_SETTINGS.linear,
  enabled: true,
  teamKeys: ['ENG', 'OPS'],
  assignee: 'me',
  includeStateTypes: ['triage', 'backlog', 'unstarted', 'started'],
  stateColumnOverrides: {},
  learnedStateColumns: {},
  columnTargetStates: {},
  doneRetentionDays: 3,
};
store.saveSettings({ ...DEFAULT_SETTINGS, linear: LINEAR });

// The key carries pasted whitespace on purpose — sanitizeToken repairs it at the point of USE,
// and the Authorization header is the only place that can be observed. Built directly rather
// than through buildLinearClient, whose only extra job is safeStorage (see verify-github.mjs's
// own note on the same choice).
const client = new LinearClient({ apiKey: ' lin_api_pasted\ttoken \n', endpoint: BASE });

// ===========================================================================
// ipc.ts, mirrored. Copied from syncLinear, moveLinearIssue, learnStateColumn, the task:move
// handler's Linear path, and the linear:sync poller's backoffUntil — everything except what
// needs the closure (send, logMain, trackSync, the scheduler, safeStorage). Assertions are
// never on this code's own wording, only on the real client/reconciler/store it drives.

let linearViewer = null;
async function linearViewerFor() {
  if (linearViewer) return linearViewer;
  try {
    const viewer = await client.getViewer();
    linearViewer = { id: viewer.id, name: viewer.displayName };
    return linearViewer;
  } catch {
    return null;
  }
}

const linearStatesCache = new Map();
const linearCommentsReadAt = new Map();

async function syncLinear(now) {
  const settings = store.getSettings();
  const linear = settings.linear;
  if (!linear.enabled) return store.getPersonalTasks();
  linearStatesCache.clear();
  const viewer = await linearViewerFor();

  const filterResult = buildIssueFilter(linear);
  if (!filterResult.ok) throw new Error(filterResult.error);
  const filter = filterResult.filter;
  const filterKey = JSON.stringify(filter);
  const lastFilter = store.loadLinearLastFilter();
  const queryChanged = lastFilter !== null && lastFilter !== filterKey;

  const fetched = await client.fetchIssues(filter);
  const fetchedIssues = fetched.issues;
  const truncated = fetched.truncated;

  const personalForSync = store.getPersonalTasksForSync();

  const toRecheck = linearIssuesToRecheck(personalForSync, fetchedIssues);
  let rechecked = new Map();
  const recheckedIds = new Set(toRecheck);
  if (toRecheck.length > 0) {
    try {
      const found = await client.fetchIssuesByIds(toRecheck);
      rechecked = new Map(found.map((i) => [i.id, i]));
    } catch (e) {
      if (e instanceof LinearRateLimitError) throw e;
      rechecked = null;
    }
  }

  const fetchedComments = new Map();
  const queue = [...fetchedIssues, ...(rechecked ? [...rechecked.values()] : [])].filter((i) => {
    const updatedAt = Date.parse(i.updatedAt) || 0;
    return updatedAt > (linearCommentsReadAt.get(i.id) || 0);
  });
  async function worker() {
    for (let i = queue.shift(); i; i = queue.shift()) {
      try {
        fetchedComments.set(i.id, await client.fetchComments(i.id));
        linearCommentsReadAt.set(i.id, Date.parse(i.updatedAt) || 0);
      } catch (e) {
        if (e instanceof LinearRateLimitError) throw e;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, queue.length) }, worker));

  store.saveLinearLastFilter(filterKey);
  const outcome = reconcileLinearIssues(personalForSync, fetchedIssues, {
    overrides: linear.stateColumnOverrides,
    learned: linear.learnedStateColumns,
    comments: fetchedComments,
    isMine: viewer ? (c) => c.user && c.user.id === viewer.id : undefined,
    rechecked,
    recheckedIds,
    truncated,
    queryChanged,
    now,
    retentionMs: Math.max(0, linear.doneRetentionDays) * DAY,
  });
  for (const t of outcome.upserts) store.upsertJiraTask(t);
  for (const r of outcome.removals) store.archiveTask(r.taskId, now, r.reason);
  return { tasks: store.getPersonalTasks(), outcome };
}

function learnStateColumn(stateName, stateType, column) {
  const name = stateName.trim();
  const settings = store.getSettings();
  const linear = settings.linear;
  if (!shouldLearnState(name, stateType, column, linear)) return;
  store.saveSettings({
    ...settings,
    linear: { ...linear, learnedStateColumns: { ...linear.learnedStateColumns, [name]: column } },
  });
}

async function moveLinearIssue(task, toColumn) {
  const linear = store.getSettings().linear;
  if (!linear.enabled || !task.externalId) return { applied: false, patch: {} };

  let states = linearStatesCache.get(task.phase);
  if (!states) {
    states = await client.listTeamStates(task.phase);
    linearStatesCache.set(task.phase, states);
  }

  const resolution = resolveLinearMove(task, toColumn, { teamKey: task.phase, states }, linear);
  if (resolution.refusal) throw new Error(resolution.refusal);
  if (!resolution.target) return { applied: false, patch: {} };

  const state = resolution.target.state;
  await client.updateIssueState(task.externalId, state.id);
  learnStateColumn(state.name, state.type, toColumn);

  return {
    applied: true,
    patch: { externalStatus: state.name, externalStatusCategory: linearCategory(state.type) },
  };
}

const preBlockMarker = (move, outcome) => (outcome && outcome.applied ? null : move.preBlockStatus);

/** The whole drag, as task:move performs it for a Linear card. */
async function drag(taskId, toColumn) {
  const existing = store.getTask(taskId);
  if (!existing) throw new Error('Task not found.');
  const move = resolveMove(existing, toColumn);
  if (move.noop) return { task: existing, move, outcome: null };
  const outcome = existing.externalSource === 'linear' ? await moveLinearIssue(existing, toColumn) : null;
  const patch = {
    ...humanStatusPatch(existing, move.localStatus),
    preBlockStatus: preBlockMarker(move, outcome),
    ...((outcome && outcome.patch) || {}),
  };
  const task = store.updateTask(taskId, patch);
  store.recordStatusChange(task.projectId, taskId, restingStatus(existing), move.localStatus);
  return { task, move, outcome };
}

/** The linear:sync poller's own backoffUntil — syncPoller.ts, mirrored at the call site. */
function linearBackoffUntil(e) {
  return e instanceof LinearRateLimitError ? (e.resetAt ?? Date.now() + 60_000) : null;
}

/** The card for an issue uuid, off the board as it is now. */
const cardFor = (uuid) => store.getPersonalTasks().find((t) => t.externalId === uuid);
const columnOf = (uuid) => {
  const card = cardFor(uuid);
  return card ? columnForTask(card) : '(no card)';
};

// ===========================================================================
section('1. Adopt: four issues become four cards, each in the column its STATE says');

let mark = seen.length;
const first = await syncLinear(T0);

check('four open issues became four cards', first.tasks.length === 4, String(first.tasks.length));
check('the started state named plainly put the crash card in IN PROGRESS', columnOf(U1) === 'in-progress', columnOf(U1));
check('the unstarted state put the onboarding card in TO DO', columnOf(U2) === 'todo', columnOf(U2));
check('the started state named "In Review" put the pricing card in IN REVIEW by the NAME heuristic alone', columnOf(U3) === 'in-review', columnOf(U3));
check('the fourth card also rests in TO DO', columnOf(U4) === 'todo', columnOf(U4));

const crash = cardFor(U1);
check('the card id is linear-<uuid>, never the identifier', crash.id === linearTaskId(U1), crash.id);
check('externalKey is the identifier', crash.externalKey === 'ENG-12', crash.externalKey);
check('externalId is the uuid', crash.externalId === U1, crash.externalId);
check('phase is the team key', crash.phase === 'ENG', crash.phase);
check('the title came across', crash.title === 'Fix the crash on save', crash.title);
check('and so did the description', crash.externalDescription === 'It throws when the dialog closes.', String(crash.externalDescription));
check('externalStatus is the STATE NAME, not its type', crash.externalStatus === 'In Progress', crash.externalStatus);
check('externalStatusCategory is derived from the column', crash.externalStatusCategory === 'In Progress', crash.externalStatusCategory);
check('priority 2 is named High', crash.externalPriority === 'High', String(crash.externalPriority));
check('the first label came across as the chip', crash.externalLabel === 'bug', String(crash.externalLabel));

const onboarding = cardFor(U2);
check('priority 0 ("no priority") falls back to null rather than a label', onboarding.externalPriority === null, String(onboarding.externalPriority));

check('the newest comment that is not mine is what the card knows about', crash.latestCommentAt === T0 - 3_600_000, String(crash.latestCommentAt));
check('a brand-new card starts read, so the first sync does not turn it orange', crash.lastReadCommentAt === crash.latestCommentAt, String(crash.lastReadCommentAt));

const firstRequests = since(mark);
check('every request carried the key with its pasted whitespace stripped, and no Bearer prefix', firstRequests.every((r) => r.auth === 'lin_api_pastedtoken'), String(firstRequests[0] && firstRequests[0].auth));
check('every request was declared JSON', firstRequests.every((r) => r.contentType === 'application/json'));
const issuesReq = firstRequests.find((r) => r.op === 'Issues');
check('the scoped query carried both team keys', JSON.stringify(issuesReq.variables.filter).indexOf('"ENG"') >= 0 && JSON.stringify(issuesReq.variables.filter).indexOf('"OPS"') >= 0, JSON.stringify(issuesReq.variables.filter));
check('and the assignee=me clause', JSON.stringify(issuesReq.variables.filter).indexOf('isMe') >= 0, JSON.stringify(issuesReq.variables.filter));
check('nothing was re-read by id on a healthy first sync', firstRequests.filter((r) => r.op === 'IssuesByIds').length === 0);

const idsBefore = store.getPersonalTasks().map((t) => t.id).sort().join(',');
await syncLinear(T0 + 1000);
check('a second sync lands on the same four rows rather than mirroring four more in', store.getPersonalTasks().map((t) => t.id).sort().join(',') === idsBefore, String(store.getPersonalTasks().length));

// ---------------------------------------------------------------------------
section('2. Team move: the card survives a changed identifier');

mark = seen.length;
const moved = issues.get(U1);
moved.team = TEAM_OPS;
moved.identifier = 'OPS-40';
moved.state = { id: S_OPS_DOING.id, name: 'Doing', type: 'started' };
moved.updatedAt = iso(T1);
const afterMove = await syncLinear(T1);

check('still four cards — no duplicate filed under the new identifier', afterMove.tasks.length === 4, String(afterMove.tasks.length));
const movedCard = cardFor(U1);
check('the SAME card id as before the move', movedCard.id === crash.id, movedCard.id);
check('externalKey rewritten to the new identifier', movedCard.externalKey === 'OPS-40', movedCard.externalKey);
check('phase rewritten to the new team', movedCard.phase === 'OPS', movedCard.phase);
check('still resting in IN PROGRESS — "Doing" is a started-type state too', columnOf(U1) === 'in-progress', columnOf(U1));

// ---------------------------------------------------------------------------
section('3. The drag writes the state back, and a drop into BLOCKED never does');

mark = seen.length;
const onboardingCard = cardFor(U2);
const dragged = await drag(onboardingCard.id, 'in-progress');

const mutations = since(mark).filter((r) => r.op === 'IssueUpdateState');
check('exactly one issueUpdate mutation went out', mutations.length === 1, String(mutations.length));
check('carrying the issue\'s own uuid and the In Progress state id', Boolean(mutations[0]) && mutations[0].variables.id === U2 && mutations[0].variables.stateId === S_ENG_IN_PROGRESS.id, JSON.stringify(mutations[0] && mutations[0].variables));
check('and the issue on the server really changed state', issues.get(U2).state.name === 'In Progress', issues.get(U2).state.name);
check('the move counts as applied', dragged.outcome.applied === true);
check('the card rests in IN PROGRESS', columnOf(U2) === 'in-progress', columnOf(U2));
check('a state that already resolved here by category teaches the map nothing new', Object.keys(store.getSettings().linear.learnedStateColumns || {}).length === 0, JSON.stringify(store.getSettings().linear.learnedStateColumns));

mark = seen.length;
const pricingCard = cardFor(U3);
const pricingRestingBefore = restingStatus(pricingCard);
const blockedDrag = await drag(pricingCard.id, 'blocked');
check('a drop into BLOCKED writes NOTHING to Linear — it is local only', since(mark).length === 0, JSON.stringify(since(mark).map((r) => r.op)));
check('yet the card really is blocked, locally', restingStatus(blockedDrag.task) === 'blocked', restingStatus(blockedDrag.task));
check('remembering where to restore from on unblock', blockedDrag.task.preBlockStatus === pricingRestingBefore, String(blockedDrag.task.preBlockStatus));
check('and the issue on the server is untouched', issues.get(U3).state.name === 'In Review', issues.get(U3).state.name);

// ---------------------------------------------------------------------------
section('4. Done retention: a finished issue is re-read by id, kept, then archived once its window elapses');

mark = seen.length;
const finished = issues.get(U4);
finished.state = { id: S_ENG_DONE.id, name: 'Done', type: 'completed' };
finished.updatedAt = iso(T3);
const afterFinish = await syncLinear(T3);

const recheckReq = since(mark).find((r) => r.op === 'IssuesByIds');
check('the issue that dropped out of scope was re-read BY ID', Boolean(recheckReq) && recheckReq.variables.ids.indexOf(U4) >= 0, JSON.stringify(recheckReq && recheckReq.variables));
check('the re-read found it completed and moved the card to DONE rather than removing it', columnOf(U4) === 'done', columnOf(U4));
check('its retention clock started now', cardFor(U4).retainedSince === T3, String(cardFor(U4).retainedSince));
check('and nothing was archived yet', afterFinish.outcome.removals.length === 0, JSON.stringify(afterFinish.outcome.removals));

const afterWindow = await syncLinear(T4);
check('past the retention window, the card is finally archived', !cardFor(U4), Boolean(cardFor(U4)));
check('as the one removal this sync made', afterWindow.outcome.removals.length === 1 && afterWindow.outcome.removals[0].reason === 'retention-expired', JSON.stringify(afterWindow.outcome.removals));
check('three cards remain on the board', afterWindow.tasks.length === 3, String(afterWindow.tasks.length));

// ---------------------------------------------------------------------------
section('5. A rate limit during the re-read is rethrown, not swallowed, with a usable reset time');

issues.set(U5, issue(U5, 'ENG-20', 'Audit the webhook retries', '', 0, TEAM_ENG, S_ENG_TODO, []));
await syncLinear(T5);
check('setup: the webhook card was filed before the rate-limit scenario', Boolean(cardFor(U5)));

const boardBeforeLimit = store.getPersonalTasks().map((t) => t.id).sort().join(',');
issues.get(U5).assignee = null; // drops out of the assignee:me scope, forcing a by-id recheck
rateLimitNextRecheck = true;
let rateLimitError = null;
try {
  await syncLinear(T6);
} catch (e) {
  rateLimitError = e;
}
rateLimitNextRecheck = false;

check('syncLinear THREW rather than swallowing the recheck failure', rateLimitError !== null, 'no throw');
check('as a LinearRateLimitError specifically', rateLimitError instanceof LinearRateLimitError, String(rateLimitError && rateLimitError.constructor.name));
check('carrying the reset time read off the response header', rateLimitError && rateLimitError.resetAt === RATE_LIMIT_RESET_SECONDS * 1000, String(rateLimitError && rateLimitError.resetAt));
check('the poller\'s backoffUntil turns that into a usable pause', rateLimitError && linearBackoffUntil(rateLimitError) === RATE_LIMIT_RESET_SECONDS * 1000, String(rateLimitError && linearBackoffUntil(rateLimitError)));
check('and nothing on the board was touched by the failed sync', store.getPersonalTasks().map((t) => t.id).sort().join(',') === boardBeforeLimit, String(store.getPersonalTasks().length));

issues.get(U5).assignee = { id: VIEWER_ID, name: 'You' };

// ---------------------------------------------------------------------------
section('6. A revoked key reads as LinearAuthError, and archives nothing on the way out');

const boardBeforeAuth = store.getPersonalTasks().map((t) => t.id).sort().join(',');
authErrorMode = true;
let authError = null;
try {
  await syncLinear(T7);
} catch (e) {
  authError = e;
}
authErrorMode = false;

check('syncLinear threw on the revoked key', authError !== null, 'no throw');
check('as a LinearAuthError specifically, not a generic GraphQL error', authError instanceof LinearAuthError, String(authError && authError.constructor.name));
check('carrying the HTTP status Linear actually answered with', authError && authError.status === 400, String(authError && authError.status));
check('and the board is byte-identical to before the failed sync — nothing was archived on a dead key', store.getPersonalTasks().map((t) => t.id).sort().join(',') === boardBeforeAuth, String(store.getPersonalTasks().length));

// ===========================================================================
server.close();
if (failures > 0) {
  console.log('\n' + failures + ' check(s) failed.');
  process.exit(1);
}
`;

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
