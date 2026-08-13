/**
 * Headless verification for the GitHub integration — the half `vitest` cannot reach.
 *
 * Every piece of this feature is unit-tested and pure (`githubClient.test.ts`,
 * `githubIssueSync.test.ts`, `githubMove.test.ts`, `githubPrSync.test.ts`, `prMatch.test.ts`,
 * `describePullRequest.test.ts`, `checkRuns.test.ts`, `statusResolve.test.ts`). What none of
 * those touches is the two impure joints the whole feature hangs off: the **socket**, where a
 * URL, a header and a JSON body either are what GitHub expects or are not, and the **store**,
 * where a mirrored issue either lands on the row it landed on last time or quietly becomes a
 * second card. Both joints live inside `ipc.ts`'s 3000-line `registerIpc` closure, which has
 * no test file, so this drives the real code either side of them.
 *
 * Five claims, end to end, in the order a user meets them:
 *
 *   1. an issue becomes a card in the column its LABEL says;
 *   2. dragging that card to DONE **closes the issue upstream** — and the very next poll,
 *      which can no longer find it (the query says `is:open`), keeps the card rather than
 *      taking away the thing you just finished;
 *   3. a pull request whose body says `closes #7` lands on **issue 7 of its own repository**'s
 *      card, with a decoy `acme/tools#7` sitting on the same board to prove it;
 *   4. a comment somebody ELSE left on a pull request raises its unread mark, and one of your
 *      own does not — read from all **three** endpoints GitHub scatters a discussion across;
 *   5. a merged pull request sets {@link Task.landedAt}, which opens an `after-merge` gate.
 *
 * The numbered SECTIONS below are the scenario's own running order and do not line up one to
 * one: claims 3 and 4 are both asserted in section 3, off the same pair of pull requests,
 * because the discussion is a property of a PR that has already been filed onto a card.
 *
 * What is REAL here, and therefore what a failure below is evidence about:
 *
 *   - `GitHubClient` — every URL it builds (including `apiRoot`'s `/api/v3` suffix for an
 *     Enterprise-shaped base), the three headers it sends, the `advanced_search=true` search
 *     deprecation flag, the JSON bodies it PATCHes and POSTs, and its handling of a 404;
 *   - `reconcileGitHubIssues` + `issueToTask` + `issuesToRecheck`, driven by what a server
 *     really answered rather than by a hand-written issue list;
 *   - `resolveGitHubColumn`, on BOTH sides of the same drag — the resolver that decides the
 *     column and the one that decides whether the move "took";
 *   - `planLabelChange` and `githubMove.resolveMove`, against the issue's real current labels;
 *   - `describePullRequest`, `reconcilePullRequests`, `prMatch`, `landedTaskIds`;
 *   - `foldNotes` + `forge/notes.ts`'s `latestForeignNoteAt`, against three real endpoints —
 *     including `/pulls/{n}/comments`, whose absence is invisible to any assertion that only
 *     asks whether SOME comment was found;
 *   - `linkSatisfied` / `readyToRelease` — the chain gate, asked of a real link row;
 *   - a real `store.ts` on a real SQLite file in a scratch profile, so "the card kept its id"
 *     is a claim about a database rather than about an object literal;
 *   - a throwaway `http` server standing in for `api.github.com`, so nothing is mocked below
 *     the socket. Its issues and pull requests are MUTABLE state: a PATCH really closes the
 *     issue, and the next search really stops returning it. That is what makes step 2 a round
 *     trip rather than two assertions that happen to agree.
 *
 * What is MIRRORED: `syncGitHubIssues`, `syncGitHubPullRequests`, `moveGitHubIssue`,
 * `learnLabelColumn` and the `task:move` handler, copied from `ipc.ts` deliberately line for
 * line so the shape of the mirror is checkable by eye against the original — plus
 * `ChainRunner.landed`'s two lines, which is where `landedAt` is actually stamped. The
 * assertions below are on what the REAL code returned and on what really went over the wire,
 * never on the mirror's own wording. If `ipc.ts` changes, this file must be re-read against
 * it — that is the cost of the closure not being reachable.
 *
 * That cost has been paid once already, and it is worth recording what it looked like. The
 * mirror was re-read against `ipc.ts` on 2026-08-13, after the branch was rebased onto
 * `development` and after the PR fetch path gained the discussion. One real drift: the mirror
 * called `reconcilePullRequests` without the `identity` its options had just gained. JavaScript
 * has no compiler to say so, so it ran perfectly — and passed `undefined`, which makes
 * `githubAuthorIsMe` answer *false* for every author on earth. A mirror that lags is not a
 * mirror that fails loudly; it is one that quietly verifies the bug. Restoring that omission
 * on purpose reddens the same four checks mutation 5 below does.
 *
 * Two deliberate, standing differences from `ipc.ts`, neither of them drift: the mirror runs
 * its detail/comment fetches SERIALLY where `ipc.ts` runs four at a time (a fixed request order
 * is what makes `seen` assertable), and it folds `syncGitHub`'s `syncIssues`/`syncPullRequests`
 * toggles into the two functions those toggles guard.
 *
 * **Proving it can fail.** 98 green checks say nothing until a mutation turns them red. Run
 * on 2026-08-13, one at a time, each restored afterwards with `git status` showing the file
 * byte-identical again — re-run them after touching the feature:
 *
 *   - **Claim 1.** Delete the `explicit` loop from `resolveGitHubColumn`
 *     (`packages/shared/src/statusResolve.ts`), so the user's label map stops being consulted:
 *     **4 red**, all in section 1. Both mapped cards land in TO DO, and the crash card's
 *     `externalStatus` reads `open` instead of the label that decided its column. Note what
 *     stays green — the label CHIP, which reads the map directly rather than through the
 *     resolver; only the column moves.
 *   - **Claim 2.** Make `planLabelChange` (`main/github/githubMove.ts`) compute
 *     `stateAfter: 'open'` for every target: **14 red**. No PATCH is sent, the stub's issue
 *     is still open afterwards, the move does not count as applied — and then the whole tail
 *     goes with it: the issue never leaves the query so nothing is re-read by number, the
 *     card falls back to TO DO on the next poll, its retention clock never starts, and
 *     section 5's archive and pull-request sweep never happen at all.
 *   - **Claim 3.** Drop the `closingReferences` loop from `discoverPullRequestKeys`
 *     (`main/github/prMatch.ts`): **10 red**. The pull request files under nothing (`taskId`
 *     null, no keys), and because the arrow's predecessor is that card, claim 5 falls with it.
 *   - **Claim 4, the endpoint.** Replace the `listReviewComments` call in
 *     `describePullRequest.ts` with `[]`, so the inline half of a review goes unread: **4
 *     red**. The mark does not merely vanish — it falls back to `11:00`, the older review
 *     body, which is the whole reason the fixture puts a note in all three places and expects
 *     the middle one. An assertion that only asked "is it non-null?" would have stayed green.
 *   - **Claim 4, the predicate.** Change `reconcilePullRequests`'s `isMine` argument to
 *     `() => false`, so nothing counts as yours: **4 red**, and note the direction — the mark
 *     rises to `13:00` on the pull request you spoke on last, and PR 42, every word of which
 *     is yours, grows an unread mark it should never have. That is the ring that never goes
 *     out, and it is why both halves are asserted rather than only the lighting-up one. This
 *     is also the mutation the mirror's missing `identity` reproduced exactly, above.
 *   - **Claim 5.** Change `landedTaskIds` (`main/gitlab/gitlabSync.ts`) to count `closed`
 *     rather than `merged`: **5 red**, and section 3 stays entirely green. `landedAt` is
 *     never stamped, so the gate stays shut and the successor is never ready to release.
 *     That is the pair that isolates the landing from the filing.
 *
 * The app is NEVER launched (RELEASE.md rule 6 — there is no single-instance lock, and a
 * second instance killed a live session on 2026-08-02). Nothing here opens the real profile:
 * the only socket is on `127.0.0.1` with a port the OS picked, and the only database is in a
 * scratch profile under the system temp dir.
 *
 * Two directories, and the split is deliberate. The BUNDLE lives inside the repo, because it
 * keeps `better-sqlite3` external and Node's resolution needs `node_modules` on the path. The
 * scratch PROFILE lives outside it (`os.tmpdir()`), because a directory inside the repo is
 * inside a git work tree — which is a trap the moment anything under test asks git a question
 * about where it is.
 *
 * How it works, and why it is not simply a `node` script: the modules under test are
 * TypeScript with `@shared` aliases and an `electron` import in `store.ts`'s dependency graph.
 * So the scenario file is bundled with Vite first (aliasing `electron` to a stub whose every
 * symbol throws — a scenario that somehow reached Electron must fail loudly rather than
 * quietly verify a stub), then run under Electron-as-Node so the addon's ABI matches the
 * binary loading it.
 *
 *   cd apps/client && pnpm run verify:github
 *
 * Deliberately NOT in CI: it stands up a server and runs under Electron-as-Node, which is a
 * separate decision from "the unit tests run on every push". The `package.json` entry exists
 * so the path is not something only this header remembers.
 *
 * Exits non-zero if any assertion failed, naming it.
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
/** `@shared` lives in the packages/shared workspace package, not under this app. */
const sharedSrc = join(repo, '..', '..', 'packages', 'shared', 'src');

/**
 * The bundle, INSIDE the repo: it keeps `better-sqlite3` external, so it must sit somewhere
 * Node's resolution can still find `node_modules`. Removed on the way out, and on the way in —
 * a crashed previous run must not leak into this one.
 */
const work = join(repo, '.verify-github');

/**
 * The scratch profile, OUTSIDE the repo — see the header. Nothing here is a work tree, so a
 * scenario that ever does shell out to git cannot accidentally read this repository's graph.
 */
const scratch = join(tmpdir(), 'verify-github-profile');

const electronBin = join(repo, 'node_modules', 'electron', 'dist', 'electron.exe');
const electronBinPosix = join(repo, 'node_modules', 'electron', 'dist', 'electron');

function log(message) {
  process.stdout.write(`${message}\n`);
}

/**
 * Nothing on this path calls into Electron: the GitHub client is deliberately free of it, and
 * `store.ts` needs none of it (`logMain`'s `app.getPath` already sits inside a `try` that
 * swallows the throw). Throwing rather than returning a plausible value is the point — a
 * scenario that ever does reach Electron must fail loudly instead of verifying a stub.
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
      // file is exactly the mistake the ABI dance below exists to avoid.
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
    // The ABI the store half depends on. Checked first and by itself, because every scenario
    // below fails identically and unhelpfully when this is wrong (v0.25.0's Linux build
    // shipped a Node-22 addon against Electron 33 and every tab just said "Loading").
    // `require('better-sqlite3')` would NOT catch it — the binding loads lazily, inside the
    // `Database` constructor — so the header is read off the file instead.
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
    // `--keep` leaves the bundle and the scratch database behind, which is the only way to
    // open one afterwards and see what a failing scenario actually wrote.
    if (process.argv.includes('--keep')) {
      log(`\nLeft ${work} and ${scratch} in place (--keep).`);
    } else {
      rmSync(work, { recursive: true, force: true });
      rmSync(scratch, { recursive: true, force: true });
    }
  }
}

/**
 * The scenarios themselves, as a template so the paths are baked in rather than passed — a
 * bundle takes no argv worth threading, and both paths are POSIX-ified above because a
 * substituted Windows path inside a JS string is read as escape sequences.
 *
 * No backticks and no `${` below: `String.raw` still interpolates, so a template literal in
 * here would be evaluated by THIS file rather than by the scenario. Plain quotes and `+`.
 */
const SCENARIOS = String.raw`
import { createServer } from 'node:http';
import { mkdirSync } from 'node:fs';
import { columnForTask, restingStatus } from '@shared/board';
import { PERSONAL_PROJECT_ID } from '@shared/model';
import { DEFAULT_SETTINGS } from '@shared/settings';
import { mrIsSettled } from '@shared/mergeRequest';
import { resolveGitHubColumn } from '@shared/statusResolve';
import { linkSatisfied, readyToRelease } from '@shared/taskChain';
import { createStore } from '__REPO__/src/main/store';
import { humanStatusPatch } from '__REPO__/src/main/cardStatusGuard';
import { GitHubClient, GitHubError } from '__REPO__/src/main/github/githubClient';
import {
  categoryForColumn,
  issuesToRecheck,
  issueTaskId,
  parseIssueKey,
  reconcileGitHubIssues,
} from '__REPO__/src/main/github/githubIssueSync';
import {
  planLabelChange,
  resolveMove as resolveGitHubMove,
  shouldLearnLabel,
} from '__REPO__/src/main/github/githubMove';
import {
  describePullRequest,
  listedFromDetail,
  repoRefFromApiUrl,
} from '__REPO__/src/main/github/describePullRequest';
import {
  needsDetailRefresh,
  reconcilePullRequests,
  rematchPullRequests,
} from '__REPO__/src/main/github/githubPrSync';
import { landedTaskIds } from '__REPO__/src/main/gitlab/gitlabSync';
import { githubIdentityFrom } from '__REPO__/src/main/github/identity';
import { resolveMove } from '__REPO__/src/main/jira/jiraMove';

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

// Fixed clocks. Nothing here reads the wall clock: a fixture stamped with Date.now() makes a
// retention window untestable and a failure unreproducible.
const T0 = 1_770_000_000_000; // the first sync
const DAY = 24 * 60 * 60 * 1000;
const T1 = T0 + 60_000; // the drag, and the poll after it
const T2 = T0 + 2 * DAY; // the pull request lands
const T3 = T0 + 3 * DAY; // the poll after that
const T4 = T0 + 20 * DAY; // past the 14-day retention window

// ===========================================================================
// A GitHub instance, on a real socket, with MUTABLE state.
//
// The issues and pull requests below are what the server answers with, and a write really
// changes them: closing issue 7 through the API is what makes the NEXT search stop returning
// it. That is the difference between a round trip and two assertions that happen to agree.

const WIDGETS = 'acme/widgets';
const TOOLS = 'acme/tools';

/** One issue, in the shape both the search and the by-number endpoint return. */
function issue(path, number, title, body, state, labels, updatedAt) {
  return {
    id: 900000 + number,
    node_id: 'I_kwDO' + path.replace('/', '_') + number,
    number,
    title,
    body,
    state,
    html_url: 'https://github.example.com/' + path + '/issues/' + number,
    // The ONLY thing on a listing that says which repository a row belongs to, and the field
    // repoRefFrom/repoRefFromApiUrl parse the owner and repo back out of.
    repository_url: 'https://api.github.example.com/repos/' + path,
    updated_at: updatedAt,
    labels: labels.map((name) => ({ name })),
    user: { id: 501, login: 'someone-else' },
  };
}

const issues = new Map();
const put = (path, row) => issues.set(path + '#' + row.number, row);

put(WIDGETS, issue(WIDGETS, 7, 'The crash on save', 'It throws when the dialog closes.', 'open', ['bug', 'status: in progress'], '2026-08-10T09:00:00Z'));
put(WIDGETS, issue(WIDGETS, 8, 'Polish the empty state', 'Nothing is drawn when the list is empty.', 'open', ['status: in review', 'design'], '2026-08-10T09:05:00Z'));
put(WIDGETS, issue(WIDGETS, 9, 'Write the migration guide', '', 'open', [], '2026-08-10T09:10:00Z'));
// The decoy. Issue 7 exists in every repository there has ever been, which is exactly why a
// bare '#7' in a pull request must resolve against the PR'S OWN repo and nothing else.
put(TOOLS, issue(TOOLS, 7, 'A different repository entirely', 'Not the crash.', 'open', [], '2026-08-10T09:15:00Z'));

/** The comments on an issue, by 'owner/repo#n'. */
const comments = new Map();
comments.set(WIDGETS + '#7', [
  { id: 1, body: 'I can reproduce it.', created_at: '2026-08-10T08:00:00Z', user: { id: 501, login: 'someone-else' } },
  { id: 2, body: 'Looking at it now.', created_at: '2026-08-10T08:30:00Z', user: { id: 500, login: 'me' } },
]);

/** One pull request, in the DETAIL shape. The search rows are derived from these. */
const pulls = new Map();
pulls.set(WIDGETS + '#41', {
  id: 4100,
  number: 41,
  title: 'Fix the crash on save',
  // The claim under test: a closing reference in the BODY, written the commonest way there is.
  body: 'The dialog disposed its model twice.\n\ncloses #7',
  state: 'open',
  draft: false,
  merged: false,
  merged_at: null,
  html_url: 'https://github.example.com/' + WIDGETS + '/pull/41',
  updated_at: '2026-08-11T10:00:00Z',
  mergeable: true,
  mergeable_state: 'clean',
  head: { ref: 'wd/crash-on-save', sha: 'abc123def456', repo: { id: 7001, full_name: WIDGETS } },
  base: { ref: 'main', repo: { id: 7001, full_name: WIDGETS } },
});
pulls.set(WIDGETS + '#42', {
  id: 4200,
  number: 42,
  title: 'ENG-431: retune the cache',
  // A closing reference to an issue NOBODY has on the board, plus a tracker key that IS on it.
  body: 'Unrelated to any GitHub issue. closes #4242',
  state: 'open',
  draft: false,
  merged: false,
  merged_at: null,
  html_url: 'https://github.example.com/' + WIDGETS + '/pull/42',
  updated_at: '2026-08-11T10:05:00Z',
  mergeable: true,
  mergeable_state: 'clean',
  head: { ref: 'wd/ENG-431', sha: 'feed0000cafe', repo: { id: 7001, full_name: WIDGETS } },
  base: { ref: 'main', repo: { id: 7001, full_name: WIDGETS } },
});

// ---------------------------------------------------------------------------
// The discussion on a pull request, which GitHub scatters across THREE endpoints.
//
// The fixture is arranged so that no single endpoint can carry the claim on its own, and so
// that neither half of the rule is satisfiable by a mistake. On PR 41 there is one note in
// each place and the NEWEST of the three is mine:
//
//   10:30  an APPROVED review with an empty body   (reviewer)  — a verdict, not a remark
//   11:00  a COMMENTED review with a body          (reviewer)  — foreign, and older
//   12:00  an inline review comment                (someone-else) — the expected answer
//   13:00  a comment on the conversation tab       (me)        — newer, and not news
//
// So the one epoch asserted below is red if /pulls/41/comments is never asked (it falls back
// to 11:00) and red if whose-comment-is-whose has been forgotten (it rises to 13:00).
//
// On PR 42 there is one note in each place too and every one of them is mine, so the answer
// is null — the half that says a ring must also be able to STAY off.

/** Inline review comments, by 'owner/repo#n' — the endpoint listReviewComments added. */
const reviewComments = new Map();
reviewComments.set(WIDGETS + '#41', [
  { id: 61, body: 'This dispose looks doubled.', created_at: '2026-08-11T12:00:00Z', user: { id: 501, login: 'someone-else' } },
]);
reviewComments.set(WIDGETS + '#42', [
  { id: 62, body: 'Note to self: measure this.', created_at: '2026-08-11T13:40:00Z', user: { id: 500, login: 'me' } },
]);

/**
 * The reviews, per pull request rather than one list for all of them: a row here feeds BOTH
 * the approval count and the note list, so the two pull requests can no longer share one.
 */
const reviews = new Map();
reviews.set(WIDGETS + '#41', [
  { id: 1, state: 'APPROVED', user: { id: 900, login: 'reviewer' }, submitted_at: '2026-08-11T10:30:00Z', body: '' },
  // A later COMMENTED review by the SAME reviewer, which must not un-approve them — and whose
  // body IS a remark, unlike the bare verdict above it.
  { id: 2, state: 'COMMENTED', user: { id: 900, login: 'reviewer' }, submitted_at: '2026-08-11T11:00:00Z', body: 'Nice one.' },
]);
reviews.set(WIDGETS + '#42', [
  { id: 3, state: 'COMMENTED', user: { id: 500, login: 'me' }, submitted_at: '2026-08-11T13:50:00Z', body: 'Rebasing this now.' },
]);

// The conversation tab. Keyed the same way as an issue's comments because on GitHub a pull
// request IS an issue — /issues/{n}/comments is the endpoint either way.
comments.set(WIDGETS + '#41', [
  { id: 41001, body: 'Pushed a fix for that.', created_at: '2026-08-11T13:00:00Z', user: { id: 500, login: 'me' } },
]);
comments.set(WIDGETS + '#42', [
  { id: 42001, body: 'Parking this until the cache work lands.', created_at: '2026-08-11T13:30:00Z', user: { id: 500, login: 'me' } },
]);

/** A detail response dressed as the search row the open-PR listing returns. */
function prSearchRow(path, pr) {
  return {
    id: pr.id,
    number: pr.number,
    title: pr.title,
    body: pr.body,
    state: pr.state,
    draft: pr.draft,
    html_url: pr.html_url,
    repository_url: 'https://api.github.example.com/repos/' + path,
    updated_at: pr.updated_at,
    pull_request: { merged_at: pr.merged_at },
  };
}

/** Every request the server saw, in order. */
let seen = [];
const since = (mark) => seen.slice(mark);
const writesSince = (mark) => since(mark).filter((r) => r.method !== 'GET');

const json = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};

const server = createServer((req, res) => {
  let raw = '';
  req.on('data', (chunk) => {
    raw += chunk;
  });
  req.on('end', () => {
    const url = new URL(req.url, 'http://127.0.0.1');
    seen.push({
      method: req.method,
      url: req.url,
      path: url.pathname,
      query: url.search,
      auth: req.headers.authorization,
      accept: req.headers.accept,
      apiVersion: req.headers['x-github-api-version'],
      contentType: req.headers['content-type'],
      body: raw,
    });

    // Everything hangs off /api/v3 because the configured base is an instance root rather
    // than api.github.com — apiRoot's Enterprise branch, exercised for free by every call.
    const parts = url.pathname.split('/').filter((p) => p.length > 0);
    if (parts[0] !== 'api' || parts[1] !== 'v3') {
      json(res, 404, { message: 'not the API root: ' + url.pathname });
      return;
    }
    const seg = parts.slice(2).map((p) => decodeURIComponent(p));

    if (req.method === 'GET' && seg[0] === 'user') {
      json(res, 200, { id: 500, login: 'me', name: 'The Human' });
      return;
    }

    if (req.method === 'GET' && seg[0] === 'search' && seg[1] === 'issues') {
      const q = url.searchParams.get('q') || '';
      // The stub reads the two qualifiers our own queries actually use. is:open is what makes
      // a closed issue drop out of the answer, which is the whole trap section 2 walks into.
      const wantsPulls = q.indexOf('is:pr') >= 0;
      const items = wantsPulls
        ? [...pulls.entries()]
            .filter((e) => e[1].state === 'open')
            .map((e) => prSearchRow(e[0].split('#')[0], e[1]))
        : [...issues.values()].filter((i) => i.state === 'open');
      json(res, 200, { total_count: items.length, incomplete_results: false, items });
      return;
    }

    if (seg[0] === 'repos') {
      const path = seg[1] + '/' + seg[2];
      const kind = seg[3];
      const number = Number(seg[4]);
      const key = path + '#' + number;

      if (kind === 'issues' && seg.length === 5) {
        const row = issues.get(key);
        if (!row) {
          json(res, 404, { message: 'Not Found' });
          return;
        }
        if (req.method === 'GET') {
          json(res, 200, row);
          return;
        }
        if (req.method === 'PATCH') {
          const patch = JSON.parse(raw || '{}');
          if (patch.state) row.state = patch.state;
          json(res, 200, row);
          return;
        }
      }
      if (kind === 'issues' && seg[5] === 'comments' && req.method === 'GET') {
        json(res, 200, comments.get(key) || []);
        return;
      }
      if (kind === 'issues' && seg[5] === 'labels') {
        const row = issues.get(key);
        if (!row) {
          json(res, 404, { message: 'Not Found' });
          return;
        }
        if (req.method === 'POST') {
          const body = JSON.parse(raw || '{}');
          for (const name of body.labels || []) row.labels.push({ name });
          json(res, 200, row.labels);
          return;
        }
        if (req.method === 'DELETE' && seg[6] !== undefined) {
          const before = row.labels.length;
          row.labels = row.labels.filter((l) => l.name !== seg[6]);
          // GitHub 404s a label that was not on the issue, and the caller treats that as
          // success — the state it asked for is the state that holds.
          if (row.labels.length === before) {
            json(res, 404, { message: 'Label does not exist' });
            return;
          }
          json(res, 200, row.labels);
          return;
        }
      }

      if (kind === 'pulls' && seg.length === 5 && req.method === 'GET') {
        const pr = pulls.get(key);
        if (!pr) {
          json(res, 404, { message: 'Not Found' });
          return;
        }
        json(res, 200, pr);
        return;
      }
      if (kind === 'pulls' && seg[5] === 'reviews' && req.method === 'GET') {
        json(res, 200, reviews.get(key) || []);
        return;
      }
      // The INLINE remarks — /pulls/{n}/comments, which is a different endpoint from
      // /issues/{n}/comments above and holds the half of a review nobody reads on the
      // conversation tab.
      if (kind === 'pulls' && seg[5] === 'comments' && req.method === 'GET') {
        json(res, 200, reviewComments.get(key) || []);
        return;
      }
      if (kind === 'commits' && seg[5] === 'check-runs' && req.method === 'GET') {
        json(res, 200, {
          total_count: 2,
          check_runs: [
            { id: 1, name: 'build', status: 'completed', conclusion: 'success' },
            { id: 2, name: 'test', status: 'completed', conclusion: 'success' },
          ],
        });
        return;
      }
      if (kind === 'commits' && seg[5] === 'status' && req.method === 'GET') {
        json(res, 200, { state: 'success', statuses: [] });
        return;
      }
      if (kind === 'branches' && seg[5] === 'protection' && req.method === 'GET') {
        // Not protected. A real answer, and really zero — unlike the 403 an unprivileged
        // token gets, which stays null. See readApprovalBar.
        json(res, 404, { message: 'Branch not protected' });
        return;
      }
    }

    json(res, 404, { message: 'no route for ' + req.method + ' ' + url.pathname });
  });
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const port = server.address().port;
const BASE = 'http://127.0.0.1:' + port;

// ===========================================================================
// The store, on a real SQLite file in a scratch profile OUTSIDE the repo.

mkdirSync('__SCRATCH__', { recursive: true });
const store = createStore('__SCRATCH__/orchestrator.db');

const GITHUB = {
  ...DEFAULT_SETTINGS.github,
  enabled: true,
  baseUrl: BASE,
  syncIssues: true,
  syncPullRequests: true,
  issueQuery: 'is:issue is:open assignee:@me',
  // The ONLY way a GitHub issue reaches a column other than TO DO or DONE.
  labelColumnOverrides: { 'status: in progress': 'in-progress', 'status: in review': 'in-review' },
  doneRetentionDays: 14,
};
store.saveSettings({ ...DEFAULT_SETTINGS, github: GITHUB });

// The token carries pasted whitespace on purpose — sanitizeToken repairs it at the point of
// USE, and the Authorization header is the only place that can be observed (see v0.71.0).
// Built directly rather than through buildGitHubClient, whose only extra job is safeStorage.
const client = new GitHubClient({ baseUrl: BASE, token: '  ghp_a-pasted-token\n' });

// ===========================================================================
// ipc.ts, mirrored. Copied from registerIpc's syncGitHubIssues, syncGitHubPullRequests,
// moveGitHubIssue, learnLabelColumn and the task:move handler — everything except the parts
// that need the closure (safeStorage, send, logMain, trackSync, the scheduler). Assertions
// are never on this code's own wording.

/** boardKeyIndex, verbatim: the archived-excluding read, keyed case-insensitively. */
function boardKeyIndex() {
  const taskIdByKey = new Map();
  for (const task of store.getPersonalTasks()) {
    if (task.externalSource && task.externalKey) {
      taskIdByKey.set(task.externalKey.toUpperCase(), task.id);
    }
  }
  return { knownKeys: [...taskIdByKey.keys()], taskIdByKey };
}

/** learnLabelColumn, verbatim minus the send(). */
function learnLabelColumn(label, column) {
  const name = label.trim();
  const settings = store.getSettings();
  const github = settings.github;
  if (!shouldLearnLabel(name, column, github)) return;
  store.saveSettings({
    ...settings,
    github: { ...github, learnedLabelColumns: { ...github.learnedLabelColumns, [name]: column } },
  });
}

/** ChainRunner.landed's first two lines — where landedAt is actually stamped, and once. */
function noteWorkLanded(taskId, at) {
  const task = store.getTask(taskId);
  if (!task) return;
  if (task.landedAt == null) store.updateTask(taskId, { landedAt: at });
}

/** githubCommentsReadAt: in memory, not the DB. */
const githubCommentsReadAt = new Map();

/**
 * syncGitHubIssues. The clock is passed in rather than read, and githubIdentity's app_state
 * cache is skipped — it saves a call, and every sync here wants the same answer.
 */
async function syncIssues(now) {
  const github = store.getSettings().github;
  if (!github.enabled || !github.syncIssues) return store.getPersonalTasks();
  const identity = githubIdentityFrom(await client.getMe(), github.baseUrl);
  const query = github.issueQuery.trim();
  if (!query) throw new Error('Set the GitHub issue query in Settings, or turn issue syncing off.');
  const lastQuery = store.loadGitHubLastQuery();
  const queryChanged = lastQuery !== null && lastQuery !== query;

  const searched = await client.searchIssues(query);
  const items = searched.items;
  const truncated = searched.truncated;

  const personalForSync = store.getPersonalTasksForSync();

  const rechecked = new Map();
  const recheckedKeys = new Set();
  for (const ref of issuesToRecheck(personalForSync, items)) {
    try {
      const found = await client.getIssue(ref.owner, ref.repo, ref.number);
      rechecked.set(ref.key, found);
      recheckedKeys.add(ref.key);
    } catch (e) {
      // A 404 is an ANSWER. Anything else is a question that failed, and only the first ever
      // lets a card leave the board.
      if (e instanceof GitHubError && e.status === 404) recheckedKeys.add(ref.key);
    }
  }

  const fetchedComments = new Map();
  const commentQueue = [...items, ...rechecked.values()].filter((row) => {
    const ref = repoRefFromApiUrl(row.repository_url);
    const key = ref.owner + '/' + ref.repo + '#' + row.number;
    const updatedAt = Date.parse(row.updated_at) || 0;
    return updatedAt > (githubCommentsReadAt.get(key) || 0);
  });
  for (const row of commentQueue) {
    const ref = repoRefFromApiUrl(row.repository_url);
    const key = ref.owner + '/' + ref.repo + '#' + row.number;
    try {
      fetchedComments.set(key, await client.listIssueComments(ref.owner, ref.repo, row.number));
      githubCommentsReadAt.set(key, Date.parse(row.updated_at) || 0);
    } catch (e) {
      // Kept as they were: a rate limit must not blank a card's unread marker.
    }
  }

  store.saveGitHubLastQuery(query);
  const outcome = reconcileGitHubIssues(personalForSync, items, {
    overrides: github.labelColumnOverrides,
    learned: github.learnedLabelColumns,
    identity,
    comments: fetchedComments,
    rechecked,
    recheckedKeys,
    truncated,
    queryChanged,
    now,
    retentionMs: Math.max(0, github.doneRetentionDays) * DAY,
  });
  // Restore, then upsert, then archive — the order ipc.ts uses, so an issue back in the query
  // lands on its own card rather than beside the archived one.
  for (const id of outcome.restoreIds) store.unarchiveTask(id);
  for (const t of outcome.upserts) store.upsertJiraTask(t);
  for (const r of outcome.removals) store.archiveTask(r.taskId, now, r.reason);
  return { tasks: store.getPersonalTasks(), outcome };
}

const COLUMN_LABEL = {
  todo: 'TO DO',
  'in-progress': 'IN PROGRESS',
  'in-review': 'IN REVIEW',
  blocked: 'BLOCKED',
  done: 'DONE',
};

/** moveGitHubIssue. Throws rather than returning a failure — see its docstring in ipc.ts. */
async function moveGitHubIssue(task, target) {
  const github = store.getSettings().github;
  if (!github.enabled) return { applied: false, patch: {} };
  const ref = task.externalKey ? parseIssueKey(task.externalKey) : null;
  if (!ref) return { applied: false, patch: {} };

  const found = await client.getIssue(ref.owner, ref.repo, ref.number);
  const labels = (found.labels || [])
    .map((l) => ((l && l.name) || '').trim())
    .filter((name) => name.length > 0);
  const change = planLabelChange(labels, found.state, target, github);
  if (!change && target === 'blocked') return { applied: false, patch: {} };
  if (!change) {
    throw new Error(
      'No GitHub label means ' + COLUMN_LABEL[target] + ', and a GitHub issue has no state ' +
        'that does. Map a label to it in Settings, then move ' + task.externalKey + ' again.',
    );
  }

  if (change.state) await client.setIssueState(ref.owner, ref.repo, ref.number, change.state);
  if (change.addLabel) await client.addLabels(ref.owner, ref.repo, ref.number, [change.addLabel]);
  for (const label of change.removeLabels) {
    try {
      await client.removeLabel(ref.owner, ref.repo, ref.number, label);
    } catch (e) {
      if (e instanceof GitHubError && e.status === 404) continue;
      throw e;
    }
  }

  if (change.columnLabel) learnLabelColumn(change.columnLabel, target);
  const after = resolveGitHubColumn(
    change.labelsAfter,
    change.stateAfter,
    github.labelColumnOverrides,
    store.getSettings().github.learnedLabelColumns,
  );
  return {
    applied: after.column === target,
    patch: {
      externalStatus: after.label ?? change.stateAfter,
      externalStatusCategory: categoryForColumn(after.column),
    },
  };
}

/** preBlockMarker, verbatim. */
const preBlockMarker = (move, outcome) => (outcome && outcome.applied ? null : move.preBlockStatus);

/** The whole drag, as task:move performs it. Returns the card as it was saved. */
async function drag(taskId, toColumn) {
  const existing = store.getTask(taskId);
  if (!existing) throw new Error('Task not found.');
  const move = resolveMove(existing, toColumn);
  if (move.noop) return { task: existing, move, outcome: null };
  const target = resolveGitHubMove(existing, toColumn).target;
  const outcome = target ? await moveGitHubIssue(existing, target) : null;
  const patch = {
    ...humanStatusPatch(existing, move.localStatus),
    preBlockStatus: preBlockMarker(move, outcome),
    ...((outcome && outcome.patch) || {}),
  };
  const task = store.updateTask(taskId, patch);
  store.recordStatusChange(task.projectId, taskId, restingStatus(existing), move.localStatus);
  return { task, move, outcome };
}

/** syncGitHubPullRequests, with the noteWorkLanded hand-off the scheduler makes. */
async function syncPullRequests(now) {
  const github = store.getSettings().github;
  if (!github.enabled || !github.syncPullRequests) return store.listMergeRequests();
  // Who you are on this instance. ipc.ts reads it through githubIdentity's per-site cache;
  // here, as in syncIssues, the cache is skipped because every sync wants the same answer.
  // Required rather than optional, and passing it is the whole difference between a ring that
  // means something and one every pull request you have spoken on wears for good.
  const identity = githubIdentityFrom(await client.getMe(), github.baseUrl);
  const stored = store.listMergeRequests().filter((mr) => mr.provider === 'github');
  const list = await client.listMyPullRequests();

  const prRef = (projectPath, number) => projectPath.toLowerCase() + '#' + number;
  const listedRef = (item) => {
    const ref = repoRefFromApiUrl(item.repository_url);
    return prRef(ref.owner + '/' + ref.repo, item.number);
  };
  const priorByRef = new Map(stored.map((mr) => [prRef(mr.projectPath, mr.number), mr]));

  const detailed = [];
  for (const item of list) {
    const prior = priorByRef.get(listedRef(item));
    const updatedAt = Date.parse(item.updated_at) || 0;
    const stale = needsDetailRefresh(prior, updatedAt);
    detailed.push(await describePullRequest(client, item, { stale, prior }));
  }

  // Read back the open PRs that dropped out of the list, so their ENDING is a fact.
  const listedRefs = new Set(list.map(listedRef));
  for (const prior of stored) {
    if (listedRefs.has(prRef(prior.projectPath, prior.number)) || mrIsSettled(prior)) continue;
    const parts = prior.projectPath.split('/');
    if (!parts[0] || !parts[1]) continue;
    const detail = await client.getPullRequest(parts[0], parts[1], prior.number).catch(() => null);
    if (detail) {
      detailed.push(
        await describePullRequest(client, listedFromDetail(detail, parts[0], parts[1]), {
          stale: false,
          prior,
        }),
      );
    }
  }

  const index = boardKeyIndex();
  const reconciled = reconcilePullRequests(stored, detailed, {
    knownKeys: index.knownKeys,
    taskIdByKey: index.taskIdByKey,
    identity,
    now,
  });
  for (const mr of reconciled.upserts) store.upsertMergeRequest(mr);
  store.deleteMergeRequests(reconciled.deleteIds);
  // The hand-off that makes an after-merge gate work on a GitHub repository at all.
  for (const taskId of landedTaskIds(reconciled.upserts)) noteWorkLanded(taskId, now);
  return { mrs: store.listMergeRequests(), reconciled };
}

/** rematchStoredMergeRequests, the GitHub half. No network. */
function rematchStored() {
  const stored = store.listMergeRequests().filter((mr) => mr.provider === 'github');
  if (!stored.length) return;
  for (const mr of rematchPullRequests(stored, boardKeyIndex())) store.upsertMergeRequest(mr);
}

/** The card for an issue key, off the board as it is now. */
const cardFor = (key) => store.getPersonalTasks().find((t) => t.externalKey === key);
const columnOf = (key) => {
  const card = cardFor(key);
  return card ? columnForTask(card) : '(no card)';
};

// ===========================================================================
section('1. An issue becomes a card in the column its LABEL says');

let mark = seen.length;
const first = await syncIssues(T0);

check('the four open issues became four cards', first.tasks.length === 4, String(first.tasks.length));
check(
  'the mapped label put the crash card in IN PROGRESS, which its own state could never say',
  columnOf(WIDGETS + '#7') === 'in-progress',
  columnOf(WIDGETS + '#7'),
);
check(
  'and the other mapped label put the polish card in IN REVIEW',
  columnOf(WIDGETS + '#8') === 'in-review',
  columnOf(WIDGETS + '#8'),
);
check(
  'an open issue nothing is mapped for rests in TO DO — a poll never guesses at a label',
  columnOf(WIDGETS + '#9') === 'todo',
  columnOf(WIDGETS + '#9'),
);

const crash = cardFor(WIDGETS + '#7');
check('the card is keyed owner/repo#number, not the bare number', crash.externalKey === WIDGETS + '#7', crash.externalKey);
check('and its id is built from the same three parts', crash.id === issueTaskId('acme', 'widgets', 7), crash.id);
check('the repository is what the card calls its project', crash.phase === WIDGETS, crash.phase);
check('the title came across', crash.title === 'The crash on save', crash.title);
check('so did the body, as the description', crash.externalDescription === 'It throws when the dialog closes.', String(crash.externalDescription));
check('externalStatus is the LABEL that decided the column', crash.externalStatus === 'status: in progress', String(crash.externalStatus));
check('with the category derived from the column, never invented beside it', crash.externalStatusCategory === 'In Progress', String(crash.externalStatusCategory));
check('the "bug" label became the type', crash.externalType === 'Bug', String(crash.externalType));
check(
  'and the chip shows the label NOT already spending itself on the column',
  crash.externalLabel === 'bug',
  String(crash.externalLabel),
);
check('the node id is stored as externalId', crash.externalId === issues.get(WIDGETS + '#7').node_id, String(crash.externalId));
check(
  'the decoy issue in the other repository is its own card',
  Boolean(cardFor(TOOLS + '#7')) && cardFor(TOOLS + '#7').id !== crash.id,
);

// The unread marker. A brand-new card starts READ, and your own comment never counts.
check(
  'the newest comment that is not yours is what the card knows about',
  crash.latestCommentAt === Date.parse('2026-08-10T08:00:00Z'),
  String(crash.latestCommentAt),
);
check(
  'and a brand-new card starts read, so the first sync does not turn the board orange',
  crash.lastReadCommentAt === crash.latestCommentAt,
  String(crash.lastReadCommentAt),
);

// The wire. Everything above is a claim about what the client SENT as much as about what the
// reconciler did with the answer.
const firstRequests = since(mark);
check('every request carried the bearer token, whitespace stripped', firstRequests.every((r) => r.auth === 'Bearer ghp_a-pasted-token'), String(firstRequests[0].auth));
check('every request asked for GitHub JSON', firstRequests.every((r) => r.accept === 'application/vnd.github+json'));
check(
  'and pinned the API version, so a new default cannot silently reshape a response',
  firstRequests.every((r) => r.apiVersion === '2022-11-28'),
  String(firstRequests[0].apiVersion),
);
const search = firstRequests.find((r) => r.path.indexOf('/search/issues') >= 0);
check('the search went below the Enterprise API root', search && search.path === '/api/v3/search/issues', search && search.path);
check(
  'carrying advanced_search=true — the legacy syntax is deprecated and scheduled to stop working',
  search && search.query.indexOf('advanced_search=true') >= 0,
  search && search.query,
);
check('and the user query verbatim', search && search.query.indexOf(encodeURIComponent('is:issue is:open assignee:@me')) >= 0, search && search.query);
check('nothing was written to GitHub by a poll', writesSince(mark).length === 0, JSON.stringify(writesSince(mark).map((r) => r.method + ' ' + r.path)));
check(
  'and nothing was re-read by number — a search that returned everything asks nothing',
  firstRequests.filter((r) => /\/issues\/\d+$/.test(r.path)).length === 0,
);

// A second sync changes nothing: the same cards, under the same ids.
const idsBefore = store.getPersonalTasks().map((t) => t.id).sort().join(',');
await syncIssues(T0 + 1000);
check(
  'a second sync lands on the same rows rather than mirroring four more cards in',
  store.getPersonalTasks().map((t) => t.id).sort().join(',') === idsBefore,
  String(store.getPersonalTasks().length),
);

// ---------------------------------------------------------------------------
section('2. Dragging that card to DONE closes the issue upstream');

mark = seen.length;
const dragged = await drag(crash.id, 'done');

const patched = writesSince(mark).filter((r) => r.method === 'PATCH');
check('exactly one PATCH went out', patched.length === 1, JSON.stringify(writesSince(mark).map((r) => r.method)));
check('to the issue, by owner, repo and number', patched[0] && patched[0].path === '/api/v3/repos/acme/widgets/issues/7', patched[0] && patched[0].path);
check(
  'carrying ONLY the state — a move cannot quietly rewrite a title it merely read',
  patched[0] && patched[0].body === JSON.stringify({ state: 'closed' }),
  patched[0] && patched[0].body,
);
check('declared as JSON', patched[0] && patched[0].contentType === 'application/json', patched[0] && String(patched[0].contentType));
// The claim itself: the ISSUE, not the card.
check(
  'and the issue on the server really is closed now',
  issues.get(WIDGETS + '#7').state === 'closed',
  issues.get(WIDGETS + '#7').state,
);
const deleted = writesSince(mark).filter((r) => r.method === 'DELETE');
check(
  'the label that spoke for the column it LEFT was removed, escaped in the path',
  deleted.length === 1 && deleted[0].path === '/api/v3/repos/acme/widgets/issues/7/labels/status%3A%20in%20progress',
  JSON.stringify(deleted.map((r) => r.path)),
);
check(
  'while a label the maps say nothing about is somebody else\'s data and is left alone',
  issues.get(WIDGETS + '#7').labels.map((l) => l.name).join(',') === 'bug',
  JSON.stringify(issues.get(WIDGETS + '#7').labels.map((l) => l.name)),
);
check('no label was added — DONE is said by the state itself', writesSince(mark).filter((r) => r.method === 'POST').length === 0);
check('the move counts as applied, because the next poll will agree with it', dragged.outcome.applied === true);
check('the card rests in DONE', restingStatus(dragged.task) === 'done', restingStatus(dragged.task));
check('reading back the state GitHub now has', dragged.task.externalStatus === 'closed' && dragged.task.externalStatusCategory === 'Done', dragged.task.externalStatus + '/' + dragged.task.externalStatusCategory);
check('and nothing was remembered to un-block, because nothing was blocked', dragged.task.preBlockStatus === null, String(dragged.task.preBlockStatus));

// The trap. The query says is:open, so the issue you just finished stops matching it — and a
// sync that read that absence as a shrunken board would delete the card out of the column you
// had just dropped it in.
mark = seen.length;
const afterClose = await syncIssues(T1);
check(
  'the search no longer returns it, so it was re-read BY NUMBER',
  since(mark).some((r) => r.path === '/api/v3/repos/acme/widgets/issues/7' && r.method === 'GET'),
);
check('and the card is still on the board', Boolean(cardFor(WIDGETS + '#7')), 'archived');
check('still in DONE', columnOf(WIDGETS + '#7') === 'done', columnOf(WIDGETS + '#7'));
check('under the same id it has always had', cardFor(WIDGETS + '#7').id === crash.id);
check('with the retention clock started', cardFor(WIDGETS + '#7').retainedSince === T1, String(cardFor(WIDGETS + '#7').retainedSince));
check('and nothing was archived', afterClose.outcome.removals.length === 0, JSON.stringify(afterClose.outcome.removals));

// The refusal, and the one exception to it.
const guide = cardFor(WIDGETS + '#9');
const saved = store.getSettings();
// A repository whose labels say nothing about review: now IN REVIEW cannot be expressed.
store.saveSettings({
  ...saved,
  github: { ...saved.github, labelColumnOverrides: { 'status: in progress': 'in-progress' } },
});
mark = seen.length;
let refusal = null;
try {
  await drag(guide.id, 'in-review');
} catch (e) {
  refusal = e;
}
check('a column no label can say is REFUSED rather than applied locally', refusal !== null, 'no throw');
check('and nothing was written on the way out', writesSince(mark).length === 0, JSON.stringify(writesSince(mark).map((r) => r.method)));
check('the card did not move', columnOf(WIDGETS + '#9') === 'todo', columnOf(WIDGETS + '#9'));
store.saveSettings(saved);

// BLOCKED is the exception: no forge is obliged to be able to say "this is stuck". Nothing
// maps to it even under the FULL settings above, which is the ordinary case rather than a
// contrived one.
mark = seen.length;
const blocked = await drag(guide.id, 'blocked');
check('a BLOCKED drop with no label behind it is allowed', restingStatus(blocked.task) === 'blocked', restingStatus(blocked.task));
check('nothing was written for it either', writesSince(mark).length === 0, JSON.stringify(writesSince(mark).map((r) => r.method)));
check(
  'and the block is the APP\'s, so the column to restore is remembered',
  blocked.task.preBlockStatus === 'pending',
  String(blocked.task.preBlockStatus),
);
const afterBlock = await syncIssues(T1 + 1000);
check('which survives the next poll — nothing else will ever move that card out', columnOf(WIDGETS + '#9') === 'blocked', columnOf(WIDGETS + '#9'));
check('and that poll took nothing off the board', afterBlock.outcome.removals.length === 0, JSON.stringify(afterBlock.outcome.removals));

mark = seen.length;
const unblocked = await drag(guide.id, 'todo');
check('un-blocking puts it back in TO DO', columnOf(WIDGETS + '#9') === 'todo', columnOf(WIDGETS + '#9'));
check('clearing the marker', unblocked.task.preBlockStatus === null, String(unblocked.task.preBlockStatus));
check(
  'and writes NOTHING to GitHub — the issue was open all along and still is',
  writesSince(mark).length === 0,
  JSON.stringify(writesSince(mark).map((r) => r.method)),
);

// ---------------------------------------------------------------------------
section('3. A pull request that says "closes #7" lands on issue 7\'s card');

// A JIRA card, so PR 42's branch has a tracker key on the board to compete with — the case
// that proves a closing reference outranks one, and that a key nothing carries is not a key.
const eng = store.createTask(PERSONAL_PROJECT_ID, { title: 'ENG-431: retune the cache' });
store.updateTask(eng.id, { externalSource: 'jira', externalKey: 'ENG-431' });

mark = seen.length;
await syncPullRequests(T2);
const stored41 = store.listMergeRequests().find((mr) => mr.number === 41);
const stored42 = store.listMergeRequests().find((mr) => mr.number === 42);

// The keys a PR remembers are the BOARD's own spelling of them, and boardKeyIndex holds
// those upper-cased so the lookup is case-insensitive on both spellings. So every comparison
// below is made case-insensitively rather than against the fixture's lower-case literal.
const keys = (mr) => (mr ? mr.issueKeys.map((k) => k.toLowerCase()) : []);

check('both open pull requests were stored', Boolean(stored41) && Boolean(stored42));
// The claim.
check(
  'the pull request landed on the CARD for issue 7',
  stored41 && stored41.taskId === crash.id,
  stored41 && String(stored41.taskId),
);
check(
  'because the bare "#7" resolved against the pull request\'s OWN repository',
  keys(stored41)[0] === WIDGETS + '#7',
  JSON.stringify(keys(stored41)),
);
check(
  'and not the decoy issue 7 sitting on the same board in another repository',
  stored41 &&
    stored41.taskId !== cardFor(TOOLS + '#7').id &&
    keys(stored41).indexOf(TOOLS + '#7') < 0,
  JSON.stringify(keys(stored41)),
);
check('filed under this forge', stored41 && stored41.provider === 'github', stored41 && stored41.provider);
check(
  'with an id built from the numeric repo id the DETAIL response carried',
  stored41 && stored41.id === 'gh-7001-41',
  stored41 && stored41.id,
);
check('the branches came off the detail', stored41 && stored41.sourceBranch === 'wd/crash-on-save' && stored41.targetBranch === 'main', stored41 && stored41.sourceBranch + ' -> ' + stored41.targetBranch);
check('the checks were read off the head SHA and are green', stored41 && stored41.pipelineStatus === 'success', stored41 && stored41.pipelineStatus);
check('both check runs became stages', stored41 && stored41.pipelineStages.length === 2, stored41 && String(stored41.pipelineStages.length));
check(
  'one reviewer approved, and their later COMMENTED review did not take it back',
  stored41 && stored41.approvalsGiven === 1 && stored41.changesRequested === false,
  stored41 && String(stored41.approvalsGiven),
);
check(
  'an unprotected target branch really does require zero approvals',
  stored41 && stored41.approvalsRequired === 0,
  stored41 && String(stored41.approvalsRequired),
);
check('GitHub\'s own merge verdict was kept raw', stored41 && stored41.detailedMergeStatus === 'clean', stored41 && String(stored41.detailedMergeStatus));
check('and mergeable: true is not a conflict', stored41 && stored41.hasConflicts === false);

// The discussion. Both halves of the rule, because either one alone is satisfiable by a
// mistake: a ring that never lights is exactly as wrong as one that never goes out.
check(
  'all three of the places GitHub scatters a discussion were read',
  [
    '/api/v3/repos/acme/widgets/issues/41/comments',
    '/api/v3/repos/acme/widgets/pulls/41/comments',
    '/api/v3/repos/acme/widgets/pulls/41/reviews',
  ].every((p) => since(mark).some((r) => r.method === 'GET' && r.path === p)),
  JSON.stringify(since(mark).filter((r) => r.path.indexOf('/41/') >= 0).map((r) => r.path)),
);
check(
  'the newest remark somebody ELSE left raised the unread mark',
  stored41 && stored41.latestNoteAt === Date.parse('2026-08-11T12:00:00Z'),
  stored41 && String(stored41.latestNoteAt),
);
check(
  'and it is the INLINE one, so the endpoint nobody reads on the conversation tab counts',
  stored41 && stored41.latestNoteAt > Date.parse('2026-08-11T11:00:00Z'),
  stored41 && String(stored41.latestNoteAt),
);
check(
  'while my own, newer, comment on the very same pull request was not news',
  stored41 && stored41.latestNoteAt < Date.parse('2026-08-11T13:00:00Z'),
  stored41 && String(stored41.latestNoteAt),
);
check(
  'and a pull request whose every remark is mine carries no unread mark at all',
  stored42 && stored42.latestNoteAt === null,
  stored42 && String(stored42.latestNoteAt),
);

// The decoy PR: its closing reference names an issue nobody has, so the tracker key in its
// branch is what files it.
check(
  'a closing reference to an issue nothing on the board carries is not a key',
  Boolean(stored42) && keys(stored42).indexOf(WIDGETS + '#4242') < 0,
  JSON.stringify(keys(stored42)),
);
check(
  'so the tracker key in its branch files it instead',
  stored42 && stored42.taskId === eng.id,
  stored42 && String(stored42.taskId),
);
check(
  'and a re-match against the same board changes neither of them',
  (() => {
    rematchStored();
    const a = store.listMergeRequests().find((mr) => mr.number === 41);
    const b = store.listMergeRequests().find((mr) => mr.number === 42);
    return a.taskId === crash.id && b.taskId === eng.id;
  })(),
);

// ---------------------------------------------------------------------------
section('4. A merged pull request opens an after-merge gate');

const successor = store.createTask(PERSONAL_PROJECT_ID, { title: 'The follow-up that waits for it' });
const link = store.addTaskLink(crash.id, successor.id, 'after-merge');
check('the arrow was drawn', Boolean(link) && link.gate === 'after-merge');

const byId = () => new Map(store.getPersonalTasksForSync().map((t) => [t.id, t]));
check('the crash card has not landed yet', store.getTask(crash.id).landedAt == null, String(store.getTask(crash.id).landedAt));
check('so the gate is shut', linkSatisfied(link, store.getTask(crash.id)) === false);
check('and the successor is not ready to be released', readyToRelease(successor, store.listTaskLinks(), byId()) === false);

// Somebody clicks Merge on github.com. The PR is closed with merged_at set, and it stops
// coming back from a search asking for is:open — which is exactly how a merged MR used to
// vanish off its card at the moment it had something worth saying.
const pr41 = pulls.get(WIDGETS + '#41');
pr41.state = 'closed';
pr41.merged = true;
pr41.merged_at = '2026-08-12T12:00:00Z';
pr41.updated_at = '2026-08-12T12:00:00Z';

mark = seen.length;
await syncPullRequests(T3);
check(
  'the pull request dropped out of the open list, so it was re-read by number',
  since(mark).some((r) => r.method === 'GET' && r.path === '/api/v3/repos/acme/widgets/pulls/41'),
);
const after41 = store.listMergeRequests().find((mr) => mr.number === 41);
check('it was NOT deleted on that absence', Boolean(after41), 'gone');
check(
  'and reads as merged rather than closed — the difference between shipped and thrown away',
  after41 && after41.state === 'merged',
  after41 && after41.state,
);
check('still filed on the same card', after41 && after41.taskId === crash.id, after41 && String(after41.taskId));
check('and it kept its id, so the read markers went with it', after41 && after41.id === 'gh-7001-41', after41 && after41.id);
check(
  'including the unread mark, which a re-read that never looked at the discussion must keep',
  after41 && after41.latestNoteAt === Date.parse('2026-08-11T12:00:00Z'),
  after41 && String(after41.latestNoteAt),
);

// The claim.
check(
  'the card\'s work is now recorded as landed',
  store.getTask(crash.id).landedAt === T3,
  String(store.getTask(crash.id).landedAt),
);
check('so the gate is open', linkSatisfied(store.listTaskLinks()[0], store.getTask(crash.id)) === true);
check(
  'and the successor is ready to be released',
  readyToRelease(successor, store.listTaskLinks(), byId()) === true,
);
check(
  'the successor itself was never touched — a gate opening is not a run',
  store.getTask(successor.id).landedAt == null && store.getTask(successor.id).status === 'pending',
  store.getTask(successor.id).status,
);

// The landing is a fact that gets stamped once, however many polls repeat "merged".
await syncPullRequests(T3 + 5 * DAY);
check(
  'a later poll repeating "merged" does not restamp the landing',
  store.getTask(crash.id).landedAt === T3,
  String(store.getTask(crash.id).landedAt),
);
check(
  'and the merged pull request is still retained on the card',
  Boolean(store.listMergeRequests().find((mr) => mr.number === 41)),
);

// ---------------------------------------------------------------------------
section('5. Past the retention window, the card leaves — taking its pull request with it');

const expired = await syncIssues(T4);
check(
  'the closed issue\'s card is archived once its 14 days are up',
  expired.outcome.removals.length === 1 && expired.outcome.removals[0].reason === 'retention-expired',
  JSON.stringify(expired.outcome.removals),
);
check('so it is off the board', !cardFor(WIDGETS + '#7'), 'still there');
check(
  'but not deleted — the row keeps its timeline, its links and its files',
  Boolean(store.getTask(crash.id)) && store.getArchivedTasks().some((t) => t.id === crash.id),
);
check('and the landing it recorded is still on it', store.getTask(crash.id).landedAt === T3, String(store.getTask(crash.id).landedAt));

await syncPullRequests(T4 + 1000);
check(
  'the settled pull request goes with the card, rather than pointing at nothing forever',
  !store.listMergeRequests().some((mr) => mr.number === 41),
  JSON.stringify(store.listMergeRequests().map((mr) => mr.number)),
);
check(
  'while the open one filed under a card still on the board stays',
  Boolean(store.listMergeRequests().find((mr) => mr.number === 42)),
);

// ---------------------------------------------------------------------------
server.close();
store.close();

console.log('');
if (failures > 0) {
  console.error(failures + ' check(s) failed.');
  process.exit(1);
}
`;

await main();
