/**
 * Headless end-to-end proof of F15, the review workspace
 * (`docs/plan/feature-roadmap/F15-review-workspace.md`): a pull request's queue row, summary,
 * file, context expansion and viewed marks, read through the REAL `ReviewQueueService`,
 * `ReviewSubjectService`, `DiffService`, `ForgeDiffSource` and `createReviewHandlers`, against
 * real git, a real SQLite store and a real (fake) HTTP forge.
 *
 *     node scripts/verify-review-workspace.mjs
 *
 * ## Why this is a script and not a test
 *
 * Every F15 piece has unit tests against fakes: `queueService.test.ts` fakes the store and the
 * forge, `diffService.prLocal.test.ts` fakes `ReviewRefGit`, `forgeDiffSource.test.ts` fakes the
 * client, `reviewHandlers.test.ts` fakes the services. None of them says whether the chain holds
 * together — whether a forced `+refs/pull/N/head` refspec really lands in a real clone without
 * touching its HEAD, branches, index or dirty work tree; whether the `review_queue` and
 * `review_viewed` tables really store and reconcile what the service hands them; whether the
 * GitHub client really talks to an HTTP server the way the services assume. `better-sqlite3`'s
 * addon is compiled for Electron's ABI, so nothing that calls `createStore` can run under the
 * Node that runs vitest (memory *the-store-has-no-tests*) — this script is the only thing that
 * exercises the store's half of the chain at all.
 *
 * So, the same way `verify-board-review.mjs` does, it bundles the app's own modules with esbuild
 * and runs them under Electron-as-Node — no window, no second instance of the app. `ipc.ts`'s
 * handlers are out of reach (`registerIpcHandlers` builds its own store and pollers), so the
 * wiring below restates `ipc.ts`'s `DiffService` block and its F15.9/F15.10 block line for line,
 * with two changes: the GitHub client is built with a plain `'test-token'` instead of a
 * `safeStorage`-decrypted one, and GitLab stays disabled, its client factory throwing.
 *
 * ## The fixture
 *
 *  - A work repo whose `main` holds a 60-line `src/app.ts` and a `README.md`, and one PR commit
 *    on a detached head that edits lines 5 and 50 of `src/app.ts` (two hunks, a gap of more than
 *    20 lines between them) and adds a 2,500-line `src/new.ts` (past `DIFF_CONTEXT_MAX_LINES`).
 *  - A bare `forge.git` holding `main` as `refs/heads/main` and the PR commit ONLY as
 *    `refs/pull/7/head` — not a branch, the way GitHub keeps it.
 *  - A clone of it registered as a project, its `origin` set to
 *    `http://127.0.0.1/acme/widgets.git`, with an uncommitted edit in `README.md`.
 *  - A fake GitHub (`node:http` on `127.0.0.1:<port>`) answering the search, repository, pull
 *    request, files and contents endpoints for `acme/widgets#7` (repo id 42, cloned) and
 *    `acme/gadgets#12` (repo id 43, not cloned anywhere).
 *
 * **Why the fake forge also serves git.** The clone's `origin` reaches `forge.git` through an
 * `insteadOf` redirect in a scratch `GIT_CONFIG_GLOBAL`. `git remote -v` — what
 * `DiffService.matchProject` parses — prints the REWRITTEN url, so a redirect straight to a
 * `file://` path would leave `parseRemoteUrl` no host to match and every PR would read
 * `no-project`. The redirect therefore points at `http://127.0.0.1:<port>/acme/widgets.git`,
 * which this script serves as git's dumb HTTP protocol (static files out of `forge.git`, kept
 * current with `update-server-info`): `parseRemoteUrl` drops the port, so the match still sees
 * host `127.0.0.1` and path `acme/widgets`, the same pair `hostOf` derives from the GitHub URL.
 *
 * ## What it proves
 *
 *  1. **Queue.** `review:refreshQueues` lists `gh-42-7` (matched to the clone's project) and
 *     `gh-43-12` (no project) as `requested`, both cached in `review_queue`, with a live
 *     `asOf`, and every forge call carried `Authorization: Bearer test-token`.
 *  2. **Summary, `local-ref`.** `gh-42-7` resolves from the clone: exactly the two changed files,
 *     the real blob sha, `refs/tm/review/gh-42-7/head` at the PR commit — and the clone's HEAD,
 *     branches, porcelain status and index bytes untouched, with no `/pulls/7/files` request.
 *  3. **File.** Two hunks, the edited line present as an `add`; an unknown `diffId` is `stale`.
 *  4. **Context expansion.** The gap between the hunks reads back the PR's own lines;
 *     `expandContext` joins it into one hunk whose line numbers agree with both sides of the
 *     file; a read past `DIFF_CONTEXT_MAX_LINES` is capped and flagged `truncated`, not thrown.
 *  5. **Viewed state.** A mark set, listed and counted on the queue row; a re-push by the author
 *     gives a new `diffId` and turns the mark `changed`; `null` clears it.
 *  6. **`forge-api`.** `gh-43-12` falls back with a `no project` reason; its file is parsed from
 *     the served `patch`, a patch-less file is `tooLarge`, a second read is served from the LRU,
 *     and a context read hits `/contents/…?ref=<head>`.
 *  7. **Queue cache.** A search outage (500) keeps both rows with their `syncedAt` and marks
 *     `requested` partial; the next complete answer drops `gh-42-7`, and the prune that follows
 *     deletes its review refs — leaving the clone's branches, HEAD and status as they were.
 *
 * ## Prove it can fail
 *
 * Filled in by the mutation step of F15.16: each mutation, the checks it turns red, and the
 * restore back to green.
 *
 * Pass `--keep` to leave the scratch directory behind. Prints `N passed, M failed` and exits
 * non-zero on any failure.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const clientModules = join(root, 'apps', 'client', 'node_modules');
const sharedSrc = join(root, 'packages', 'shared', 'src');
const protocolSrc = join(root, 'packages', 'protocol', 'src');

const REPO_PATH = 'acme/widgets';
const ORIGIN_URL = `http://127.0.0.1/${REPO_PATH}.git`;
const APP_LINES = 60;
const NEW_LINES = 2500;

function log(message) {
  process.stdout.write(`${message}\n`);
}

/** esbuild's per-platform binary, found by pattern so a dependency bump cannot rot it. */
function findEsbuild() {
  const pnpm = join(root, 'node_modules', '.pnpm');
  const target = `${process.platform}-${process.arch}`;
  const dir = readdirSync(pnpm).find((d) => d.startsWith(`@esbuild+${target}@`));
  if (!dir) throw new Error(`no esbuild binary for ${target} under ${pnpm}`);
  const exe = process.platform === 'win32' ? 'esbuild.exe' : 'bin/esbuild';
  return join(pnpm, dir, 'node_modules', '@esbuild', target, exe);
}

/** The one module this script bundles: everything the driver touches, in ONE copy. */
function entrySource() {
  const main = (p) => JSON.stringify(join(root, 'apps/client/src/main', p).replace(/\\/g, '/'));
  const shared = (p) => JSON.stringify(join(sharedSrc, p).replace(/\\/g, '/'));
  return [
    `export { createStore } from ${main('store')};`,
    `export { DiffService, createDiffGit, createReviewRefGit } from ${main('review/diffService')};`,
    `export { ForgeDiffSource } from ${main('review/forgeDiffSource')};`,
    `export { ReviewQueueService, hostOf } from ${main('review/queueService')};`,
    `export { ReviewSubjectService } from ${main('review/subjectService')};`,
    `export { createReviewHandlers } from ${main('review/reviewHandlers')};`,
    `export { GitHubClient } from ${main('github/githubClient')};`,
    `export { forgeBaseUrl } from ${main('forge/baseUrl')};`,
    `export { hostFor } from ${main('exec')};`,
    `export { viewedState, expandContext, subjectId, DIFF_CONTEXT_MAX_LINES } from ${shared('review')};`,
    '',
  ].join('\n');
}

/** `src/app.ts` at `main`: numbered, distinct lines, so every hunk and gap is unambiguous. */
function appLines() {
  return Array.from(
    { length: APP_LINES },
    (_, i) => `export const v${String(i + 1).padStart(2, '0')} = ${i + 1}; // line ${i + 1}`,
  );
}

async function main() {
  let status = 1;
  // The OS temp directory, NOT a folder inside the repo: the scratch repos below must be
  // repositories of their own, and a directory under a work tree IS part of that work tree.
  const scratch = mkdtempSync(join(tmpdir(), 'tm-review-ws-'));
  try {
    const gitconfig = join(scratch, 'gitconfig');
    writeFileSync(
      gitconfig,
      [
        '[user]',
        '\tname = Verify',
        '\temail = verify@example.com',
        '[commit]',
        '\tgpgsign = false',
        '[core]',
        '\tautocrlf = false',
        '',
      ].join('\n'),
      'utf8',
    );
    // Every git below — here, and in the child — reads this, not the human's own config.
    const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: gitconfig };
    const gitIn =
      (cwd) =>
      (...args) =>
        execFileSync('git', args, { cwd, encoding: 'utf8', env: gitEnv });

    // The work repo: `main`, then one PR commit on a detached head.
    const work = join(scratch, 'work');
    mkdirSync(join(work, 'src'), { recursive: true });
    const w = gitIn(work);
    w('init', '-q', '-b', 'main');
    writeFileSync(join(work, 'src', 'app.ts'), appLines().join('\n') + '\n', 'utf8');
    writeFileSync(join(work, 'README.md'), '# Widgets\n\nThe widget library.\n', 'utf8');
    w('add', '-A');
    w('commit', '-q', '--no-verify', '-m', 'initial');
    const mainSha = w('rev-parse', 'HEAD').trim();

    w('checkout', '-q', '--detach');
    const edited = appLines();
    edited[4] = 'export const v05 = 500; // line 5, edited by the PR';
    edited[49] = 'export const v50 = 5000; // line 50, edited by the PR';
    writeFileSync(join(work, 'src', 'app.ts'), edited.join('\n') + '\n', 'utf8');
    const added = Array.from(
      { length: NEW_LINES },
      (_, i) => `export const n${String(i + 1).padStart(4, '0')} = ${i + 1};`,
    );
    writeFileSync(join(work, 'src', 'new.ts'), added.join('\n') + '\n', 'utf8');
    w('add', '-A');
    w('commit', '-q', '--no-verify', '-m', 'Widen the widget');
    const prSha = w('rev-parse', 'HEAD').trim();

    // The forge: `main` as a branch, the PR commit ONLY under `refs/pull/7/head`.
    const forge = join(scratch, 'forge.git');
    // `-b main`: the bare repo's HEAD names a branch that exists, or the clone checks nothing out.
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', forge], { env: gitEnv });
    w('push', '-q', forge, 'main:refs/heads/main', `${prSha}:refs/pull/7/head`);
    gitIn(forge)('update-server-info');

    // The clone a human has open, registered as a project below — dirty on purpose.
    const clone = join(scratch, 'clone');
    execFileSync('git', ['clone', '-q', forge, clone], { env: gitEnv });
    const c = gitIn(clone);
    c('remote', 'set-url', 'origin', ORIGIN_URL);
    writeFileSync(join(clone, 'README.md'), '# Widgets\n\nAn edit nobody committed.\n', 'utf8');
    c('status', '--porcelain'); // settle the index's stat cache before anything snapshots it

    writeFileSync(
      join(scratch, 'fixture.json'),
      JSON.stringify({ work, forge, clone, gitconfig, mainSha, prSha }),
      'utf8',
    );

    const esbuild = findEsbuild();
    const entry = join(scratch, 'entry.mjs');
    writeFileSync(entry, entrySource(), 'utf8');
    // `electron` external for the reason `verify-pr-watch.mjs` gives: inlined, its loader
    // resolves off the bundle's own `__dirname` and throws "Electron failed to install".
    const result = spawnSync(
      esbuild,
      [
        entry,
        '--bundle',
        '--platform=node',
        '--format=cjs',
        `--alias:@shared=${sharedSrc}`,
        `--alias:@protocol=${protocolSrc}`,
        '--external:better-sqlite3',
        '--external:electron',
        `--outfile=${join(scratch, 'app.cjs')}`,
        '--log-level=error',
      ],
      { stdio: 'inherit' },
    );
    if (result.status !== 0) throw new Error('esbuild failed');

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
        ...gitEnv,
        ELECTRON_RUN_AS_NODE: '1',
        // The bundle lives in temp, outside any node_modules tree, so its external
        // `require('better-sqlite3')` needs somewhere to resolve from.
        NODE_PATH: clientModules,
        // The fake forge is on loopback; a proxy in the human's environment must not see it.
        NO_PROXY: '127.0.0.1,localhost',
        no_proxy: '127.0.0.1,localhost',
      },
    });
    status = run.status ?? 1;
  } finally {
    if (!process.argv.includes('--keep')) {
      try {
        rmSync(scratch, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 });
      } catch (e) {
        // Never let a locked file replace the real result.
        log(`\nCould not remove ${scratch}: ${e instanceof Error ? e.message : String(e)}`);
      }
    } else {
      log(`\nLeft ${scratch} in place (--keep).`);
    }
  }
  process.exit(status);
}

// ── Phase 1: plain Node — build the repos, bundle, then hand over to Electron ───────────
if (!process.versions.electron) {
  await main();
}

// ── Phase 2: under Electron-as-Node — the actual checks ─────────────────────────────────
const require = createRequire(import.meta.url);
const scratch = process.argv[2];
const fixture = JSON.parse(readFileSync(join(scratch, 'fixture.json'), 'utf8'));
const { work, forge, clone, gitconfig, mainSha, prSha } = fixture;

const {
  createStore,
  DiffService,
  createDiffGit,
  createReviewRefGit,
  ForgeDiffSource,
  ReviewQueueService,
  hostOf,
  ReviewSubjectService,
  createReviewHandlers,
  GitHubClient,
  forgeBaseUrl,
  hostFor,
  viewedState,
  expandContext,
  subjectId,
  DIFF_CONTEXT_MAX_LINES,
} = require(join(scratch, 'app.cjs'));

let passed = 0;
let failures = 0;
function check(label, condition, detail) {
  if (condition) {
    passed += 1;
    console.log('  PASS  ' + label);
  } else {
    failures += 1;
    console.log('  FAIL  ' + label + (detail === undefined ? '' : ' — ' + detail));
  }
}

// Read-only git for the driver's own assertions. `GIT_OPTIONAL_LOCKS=0` keeps `status` from
// refreshing the index behind the snapshot it is part of.
const readEnv = { ...process.env, GIT_OPTIONAL_LOCKS: '0' };
const gitIn =
  (cwd) =>
  (...args) =>
    execFileSync('git', args, { cwd, encoding: 'utf8', env: readEnv });
const cg = gitIn(clone);
const wg = gitIn(work);

function cloneState() {
  return {
    head: cg('rev-parse', 'HEAD').trim(),
    branches: cg('for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads'),
    status: cg('status', '--porcelain'),
    index: createHash('sha256')
      .update(readFileSync(join(clone, '.git', 'index')))
      .digest('hex'),
  };
}

// ── The fake forge ──────────────────────────────────────────────────────────────────────
// `/api/v3/...` is GitHub's REST API, as `GitHubClient` addresses an Enterprise base URL;
// `/acme/widgets.git/...` is `forge.git` over git's dumb HTTP protocol (see the header).

const GADGETS_HEAD = 'c'.repeat(40);
const GADGETS_BASE = 'b'.repeat(40);
const UTIL_LINES = Array.from({ length: 30 }, (_, i) => `export const u${i + 1} = ${i + 1};`);
UTIL_LINES[1] = 'export const u2 = 200; // changed';
UTIL_LINES[19] = 'export const u20 = 2000; // changed';
const UTIL_PATCH = [
  '@@ -1,4 +1,4 @@',
  ' export const u1 = 1;',
  '-export const u2 = 2;',
  '+export const u2 = 200; // changed',
  ' export const u3 = 3;',
  ' export const u4 = 4;',
  '@@ -18,5 +18,5 @@',
  ' export const u18 = 18;',
  ' export const u19 = 19;',
  '-export const u20 = 20;',
  '+export const u20 = 2000; // changed',
  ' export const u21 = 21;',
  ' export const u22 = 22;',
].join('\n');
const UTIL_SHA = 'd'.repeat(40);

const forgeState = {
  searchStatus: 200,
  searchNumbers: [7, 12],
  widgetsHead: prSha,
};
/** Every request the fake saw: `{ method, path, search, auth }`. */
const requests = [];

function searchItem(base, number) {
  const repo = number === 7 ? 'widgets' : 'gadgets';
  return {
    number,
    title: number === 7 ? 'Widen the widget' : 'Tidy the gadget',
    repository_url: `${base}/api/v3/repos/acme/${repo}`,
    user: { login: 'octo' },
    draft: false,
    updated_at: '2026-10-20T12:00:00Z',
  };
}

function serveGit(res, rest) {
  const file = resolve(forge, rest);
  if (!file.startsWith(resolve(forge) + sep) || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404).end();
    return;
  }
  // `text/plain`, not `application/x-git-upload-pack-advertisement`: what tells git this is
  // the dumb protocol, so it reads `info/refs` and walks the objects itself.
  res.writeHead(200, { 'Content-Type': 'text/plain' }).end(readFileSync(file));
}

function startForge() {
  let base = '';
  const json = (res, status, body) =>
    res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const path = url.pathname;
    if (path.startsWith(`/${REPO_PATH}.git/`)) {
      serveGit(res, decodeURIComponent(path.slice(`/${REPO_PATH}.git/`.length)));
      return;
    }
    requests.push({
      method: req.method,
      path,
      search: url.search,
      auth: req.headers.authorization ?? null,
    });
    if (!path.startsWith('/api/v3/')) return json(res, 404, { message: 'Not Found' });
    const api = path.slice('/api/v3'.length);

    if (api === '/search/issues') {
      if (forgeState.searchStatus !== 200) {
        return json(res, forgeState.searchStatus, { message: 'Search is down' });
      }
      return json(res, 200, {
        total_count: forgeState.searchNumbers.length,
        incomplete_results: false,
        items: forgeState.searchNumbers.map((n) => searchItem(base, n)),
      });
    }
    if (api === '/repos/acme/widgets') return json(res, 200, { id: 42, full_name: REPO_PATH });
    if (api === '/repos/acme/gadgets') return json(res, 200, { id: 43, full_name: 'acme/gadgets' });
    if (api === '/repos/acme/widgets/pulls/7') {
      return json(res, 200, {
        number: 7,
        head: { sha: forgeState.widgetsHead, ref: 'widen' },
        base: { sha: mainSha, ref: 'main' },
      });
    }
    if (api === '/repos/acme/gadgets/pulls/12') {
      return json(res, 200, {
        number: 12,
        head: { sha: GADGETS_HEAD, ref: 'tidy' },
        base: { sha: GADGETS_BASE, ref: 'main' },
      });
    }
    if (api === '/repos/acme/gadgets/pulls/12/files') {
      return json(res, 200, [
        {
          sha: UTIL_SHA,
          filename: 'lib/util.ts',
          status: 'modified',
          additions: 2,
          deletions: 2,
          patch: UTIL_PATCH,
        },
        {
          sha: 'e'.repeat(40),
          filename: 'data/blob.bin',
          status: 'added',
          additions: 0,
          deletions: 0,
        },
      ]);
    }
    if (api === '/repos/acme/gadgets/contents/lib/util.ts') {
      if (url.searchParams.get('ref') !== GADGETS_HEAD) return json(res, 404, {});
      res.writeHead(200, { 'Content-Type': 'application/vnd.github.raw+json' });
      return res.end(UTIL_LINES.join('\n') + '\n');
    }
    return json(res, 404, { message: 'Not Found' });
  });
  return new Promise((resolveListen) => {
    server.listen(0, '127.0.0.1', () => {
      base = `http://127.0.0.1:${server.address().port}`;
      resolveListen({ server, base });
    });
  });
}

const count = (pred) => requests.filter(pred).length;

let server = null;
let store = null;
try {
  const started = await startForge();
  server = started.server;
  const baseUrl = started.base;
  log(`Fake forge on ${baseUrl}; scratch ${scratch}`);

  // The redirect `origin` resolves through — see the header for why it targets the fake.
  appendFileSync(
    gitconfig,
    [`[url "${baseUrl}/${REPO_PATH}.git"]`, `\tinsteadOf = ${ORIGIN_URL}`, ''].join('\n'),
    'utf8',
  );

  store = createStore(join(scratch, 'tm.db'));
  const saved = store.getSettings();
  store.saveSettings({
    ...saved,
    github: { ...saved.github, enabled: true, baseUrl },
    gitlab: { ...saved.gitlab, enabled: false },
  });
  const project = store.addProject({
    path: clone,
    name: 'Widgets',
    kind: 'agent',
    baseBranch: 'main',
  });

  // ── The wiring, as `ipc.ts` does it ──
  const diffs = new DiffService({
    getTask: (id) => store.getTask(id),
    getProject: (id) => store.getProject(id),
    inspect: async () => null,
    gitFor: (p) => createDiffGit(hostFor(p.target)),
    listMergeRequests: () => store.listMergeRequests(),
    listProjects: () => store.listProjects(),
    refGitFor: (p) => createReviewRefGit(hostFor(p.target)),
    // No `fetchAuthFor`: the named remote is fetched as-is.
  });
  const buildGitHubClient = () =>
    new GitHubClient({ baseUrl: forgeBaseUrl('github', store.getSettings()), token: 'test-token' });
  const buildGitLabClient = () => {
    throw new Error('GitLab is not part of this scenario.');
  };
  const queues = new ReviewQueueService({
    store,
    diffs,
    github: buildGitHubClient,
    gitlab: buildGitLabClient,
    emit: () => {},
  });
  const forgeDiffSource = new ForgeDiffSource({
    githubClient: () => buildGitHubClient(),
    gitlabClient: () => buildGitLabClient(),
  });
  const subjects = new ReviewSubjectService({
    diffs,
    forge: forgeDiffSource,
    store,
    hostFor: (provider) => hostOf(forgeBaseUrl(provider, store.getSettings())),
  });
  const handlers = createReviewHandlers({ subjects, queues, store, now: () => Date.now() });

  const before = cloneState();
  const showNew = wg('show', `${prSha}:src/app.ts`).split('\n');
  const showOld = wg('show', `${mainSha}:src/app.ts`).split('\n');
  const WIDGETS = 'gh-42-7';
  const GADGETS = 'gh-43-12';
  check(
    'subjectId of the widgets PR is gh-42-7',
    subjectId({
      kind: 'pr',
      provider: 'github',
      repoId: 42,
      repoPath: REPO_PATH,
      number: 7,
    }) === WIDGETS,
  );

  // ── 1. Queue ──
  log('\n1. Queue');
  const snap1 = await handlers['review:refreshQueues']();
  const requested = snap1.items.filter((i) => i.queue === 'requested').map((i) => i.subjectId);
  check(
    'requested holds gh-42-7 and gh-43-12',
    requested.length === 2 && requested.includes(WIDGETS) && requested.includes(GADGETS),
    JSON.stringify(requested),
  );
  const row7 = snap1.items.find((i) => i.subjectId === WIDGETS);
  const row12 = snap1.items.find((i) => i.subjectId === GADGETS);
  check(
    'gh-42-7 is matched to the clone project',
    row7?.projectId === project.id,
    String(row7?.projectId),
  );
  check('gh-43-12 has no project', row12?.projectId === null, String(row12?.projectId));
  const cached1 = store.listReviewQueue();
  check(
    'listReviewQueue() caches both rows',
    cached1.some((r) => r.item.subjectId === WIDGETS) &&
      cached1.some((r) => r.item.subjectId === GADGETS),
    JSON.stringify(cached1.map((r) => r.item.subjectId)),
  );
  check('asOf.requested is set', snap1.asOf.requested !== null);
  const apiCalls = requests.filter((r) => r.path.startsWith('/api/v3/'));
  check(
    'every forge call carried Authorization: Bearer test-token',
    apiCalls.length > 0 && apiCalls.every((r) => r.auth === 'Bearer test-token'),
    JSON.stringify([...new Set(apiCalls.map((r) => r.auth))]),
  );

  // ── 2. Summary, local-ref ──
  log('\n2. Summary, local-ref');
  const sum7 = await handlers['review:subjectSummary'](WIDGETS);
  const s7 = sum7.status === 'ok' ? sum7.summary : null;
  check('summary is ok', sum7.status === 'ok', sum7.status);
  check('source is local-ref', s7?.source === 'local-ref', `${s7?.source} (${s7?.fallbackReason})`);
  check('capabilities.expandContext is true', s7?.capabilities?.expandContext === true);
  const paths7 = (s7?.files ?? []).map((f) => f.path).sort();
  check(
    'files are exactly src/app.ts and src/new.ts',
    JSON.stringify(paths7) === JSON.stringify(['src/app.ts', 'src/new.ts']),
    JSON.stringify(paths7),
  );
  const appBlob = wg('rev-parse', `${prSha}:src/app.ts`).trim();
  const appEntry = s7?.files.find((f) => f.path === 'src/app.ts');
  check(
    'src/app.ts newBlobSha is the PR blob',
    appEntry?.newBlobSha === appBlob,
    `${appEntry?.newBlobSha} vs ${appBlob}`,
  );
  const headRef = cg('for-each-ref', '--format=%(objectname)', `refs/tm/review/${WIDGETS}/head`);
  check('refs/tm/review/gh-42-7/head is the PR commit', headRef.trim() === prSha, headRef.trim());
  const after2 = cloneState();
  check('clone HEAD unchanged', after2.head === before.head);
  check('clone branches unchanged', after2.branches === before.branches, after2.branches);
  check('clone porcelain status unchanged', after2.status === before.status, after2.status);
  check('clone index bytes unchanged', after2.index === before.index);
  check(
    'no /pulls/7/files request (the local source did not fall back)',
    count((r) => r.path.endsWith('/pulls/7/files')) === 0,
  );

  // ── 3. File ──
  log('\n3. File');
  const diffId7 = s7?.diffId ?? '';
  const file7 = await handlers['review:subjectFile'](WIDGETS, diffId7, 'src/app.ts');
  const hunks = file7.status === 'ok' ? file7.file.hunks : [];
  check('subjectFile is ok', file7.status === 'ok', file7.status);
  check('src/app.ts has 2 hunks', hunks.length === 2, String(hunks.length));
  check(
    "line 50's new text is an add line",
    hunks.some((h) =>
      h.lines.some((l) => l.kind === 'add' && l.newLine === 50 && l.text === showNew[49]),
    ),
  );
  const bogus = await handlers['review:subjectFile'](WIDGETS, 'bogus', 'src/app.ts');
  check(
    'a bogus diffId is stale, naming the current one',
    bogus.status === 'stale' && bogus.currentDiffId === diffId7,
    JSON.stringify(bogus).slice(0, 200),
  );

  // ── 4. Context expansion ──
  log('\n4. Context expansion');
  const [h1, h2] = hunks;
  const gapFrom = h1 ? h1.newStart + h1.newLines : 0;
  const gapTo = h2 ? h2.newStart - 1 : 0;
  check(
    'the gap between the hunks is over 20 lines',
    gapTo - gapFrom + 1 > 20,
    `${gapFrom}-${gapTo}`,
  );
  const ctx = await handlers['review:context'](
    WIDGETS,
    diffId7,
    'src/app.ts',
    'new',
    gapFrom,
    gapTo,
  );
  const ctxText = ctx.status === 'ok' ? ctx.context.text : [];
  check(
    'context text equals the PR file lines',
    ctx.status === 'ok' &&
      ctx.context.start === gapFrom &&
      JSON.stringify(ctxText) === JSON.stringify(showNew.slice(gapFrom - 1, gapTo)),
    `${ctxText.length} lines from ${ctx.status === 'ok' ? ctx.context.start : '-'}`,
  );
  const expanded =
    file7.status === 'ok'
      ? expandContext(file7.file, 1, { start: ctx.context.start, text: ctxText })
      : { hunks: [] };
  check(
    'expanding the whole gap leaves fewer hunks',
    expanded.hunks.length < hunks.length,
    String(expanded.hunks.length),
  );
  const rows = expanded.hunks.flatMap((h) => h.lines);
  const gapRows = rows.filter((l) => l.newLine >= gapFrom && l.newLine <= gapTo);
  check(
    'every expanded row has both line numbers, matching both sides of the file',
    gapRows.length === gapTo - gapFrom + 1 &&
      gapRows.every(
        (l) =>
          l.kind === 'context' &&
          l.oldLine !== undefined &&
          l.text === showNew[l.newLine - 1] &&
          l.text === showOld[l.oldLine - 1],
      ),
    `${gapRows.length} rows`,
  );
  const big = await handlers['review:context'](WIDGETS, diffId7, 'src/new.ts', 'new', 1, 5000);
  check(
    `a ${NEW_LINES}-line read is capped at DIFF_CONTEXT_MAX_LINES (${DIFF_CONTEXT_MAX_LINES}) and flagged truncated`,
    big.status === 'ok' &&
      big.context.text.length === DIFF_CONTEXT_MAX_LINES &&
      big.context.truncated === true,
    big.status === 'ok'
      ? `${big.context.text.length} lines, truncated ${big.context.truncated}`
      : big.status,
  );

  // ── 5. Viewed state ──
  log('\n5. Viewed state');
  const marks = await handlers['review:setViewed'](WIDGETS, 'src/app.ts', appBlob);
  check(
    'setViewed returns the mark',
    marks.some((m) => m.path === 'src/app.ts' && m.blobSha === appBlob),
    JSON.stringify(marks),
  );
  const listed = await handlers['review:viewed'](WIDGETS);
  check(
    'review:viewed lists it',
    listed.some((m) => m.path === 'src/app.ts'),
  );
  const vs1 = viewedState(s7?.files ?? [], listed);
  check(
    "viewedState: src/app.ts 'viewed', src/new.ts 'unviewed'",
    vs1.byPath['src/app.ts'] === 'viewed' && vs1.byPath['src/new.ts'] === 'unviewed',
    JSON.stringify(vs1.byPath),
  );
  const snap5 = await handlers['review:refreshQueues']();
  const row7b = snap5.items.find((i) => i.subjectId === WIDGETS);
  check("gh-42-7's viewedCount is 1", row7b?.viewedCount === 1, String(row7b?.viewedCount));

  // The author pushes again.
  const repushed = showNew.slice(0, APP_LINES);
  repushed[29] = 'export const v30 = 3000; // line 30, edited on the second push';
  writeFileSync(join(work, 'src', 'app.ts'), repushed.join('\n') + '\n', 'utf8');
  const wgw = (...args) =>
    execFileSync('git', args, { cwd: work, encoding: 'utf8', env: process.env });
  wgw('commit', '-q', '--no-verify', '-am', 'Address the review');
  const prSha2 = wgw('rev-parse', 'HEAD').trim();
  wgw('push', '-q', '--force', forge, `${prSha2}:refs/pull/7/head`);
  execFileSync('git', ['update-server-info'], { cwd: forge, env: process.env });
  forgeState.widgetsHead = prSha2;

  const sum7b = await handlers['review:subjectSummary'](WIDGETS);
  const s7b = sum7b.status === 'ok' ? sum7b.summary : null;
  check(
    'the re-push gives a new diffId',
    s7b?.source === 'local-ref' && s7b.diffId !== diffId7,
    `${s7b?.source} ${s7b?.diffId} (${s7b?.fallbackReason})`,
  );
  const vs2 = viewedState(s7b?.files ?? [], await handlers['review:viewed'](WIDGETS));
  check(
    "viewedState: src/app.ts is now 'changed'",
    vs2.byPath['src/app.ts'] === 'changed',
    JSON.stringify(vs2.byPath),
  );
  const cleared = await handlers['review:setViewed'](WIDGETS, 'src/app.ts', null);
  check(
    'setViewed(null) clears the mark',
    !cleared.some((m) => m.path === 'src/app.ts') &&
      (await handlers['review:viewed'](WIDGETS)).length === 0,
    JSON.stringify(cleared),
  );

  // ── 6. The forge-api source ──
  log('\n6. The forge-api source');
  const sum12 = await handlers['review:subjectSummary'](GADGETS);
  const s12 = sum12.status === 'ok' ? sum12.summary : null;
  check('source is forge-api', s12?.source === 'forge-api', s12?.source);
  check(
    "fallbackReason names 'no project'",
    (s12?.fallbackReason ?? '').includes('no project'),
    s12?.fallbackReason,
  );
  check('capabilities.expandContext is true', s12?.capabilities?.expandContext === true);
  const diffId12 = s12?.diffId ?? '';
  const filesCalls = () => count((r) => r.path.endsWith('/pulls/12/files'));
  const filesAfterSummary = filesCalls();
  const util = await handlers['review:subjectFile'](GADGETS, diffId12, 'lib/util.ts');
  const utilHunks = util.status === 'ok' ? util.file.hunks : [];
  check(
    'lib/util.ts is parsed from the served patch into 2 hunks',
    utilHunks.length === 2 &&
      utilHunks[0].newStart === 1 &&
      utilHunks[1].newStart === 18 &&
      utilHunks[1].lines.some((l) => l.kind === 'add' && l.text === UTIL_LINES[19]),
    JSON.stringify(utilHunks.map((h) => h.header)),
  );
  const utilEntry = s12?.files.find((f) => f.path === 'lib/util.ts');
  check('newBlobSha is the served sha', utilEntry?.newBlobSha === UTIL_SHA, utilEntry?.newBlobSha);
  const blob = await handlers['review:subjectFile'](GADGETS, diffId12, 'data/blob.bin');
  check(
    'a file served with no patch reads tooLarge',
    blob.status === 'ok' && blob.file.tooLarge !== undefined && blob.file.hunks.length === 0,
    JSON.stringify(blob).slice(0, 200),
  );
  await handlers['review:subjectFile'](GADGETS, diffId12, 'lib/util.ts');
  check(
    'a second read adds no /pulls/12/files request (the LRU)',
    filesCalls() === filesAfterSummary,
    `${filesAfterSummary} -> ${filesCalls()}`,
  );
  const contentsBefore = count((r) => r.path.endsWith('/contents/lib/util.ts'));
  const ctx12 = await handlers['review:context'](GADGETS, diffId12, 'lib/util.ts', 'new', 8, 12);
  const contentsHits = requests.filter((r) => r.path.endsWith('/contents/lib/util.ts'));
  check(
    'review:context hits /contents/lib/util.ts?ref=<head sha>',
    contentsHits.length === contentsBefore + 1 &&
      new URLSearchParams(contentsHits.at(-1)?.search ?? '').get('ref') === GADGETS_HEAD,
    JSON.stringify(contentsHits.at(-1)),
  );
  check(
    'review:context returns the served lines',
    ctx12.status === 'ok' &&
      JSON.stringify(ctx12.context.text) === JSON.stringify(UTIL_LINES.slice(7, 12)),
    ctx12.status === 'ok' ? JSON.stringify(ctx12.context.text) : ctx12.status,
  );

  // ── 7. Queue cache under an outage, then a complete answer ──
  log('\n7. Queue cache under an outage, then a complete answer');
  const syncedBefore = new Map(store.listReviewQueue().map((r) => [r.item.subjectId, r.syncedAt]));
  forgeState.searchStatus = 500;
  await handlers['review:refreshQueues']();
  const duringOutage = store.listReviewQueue();
  check(
    'both rows survive the outage',
    duringOutage.some((r) => r.item.subjectId === WIDGETS) &&
      duringOutage.some((r) => r.item.subjectId === GADGETS),
    JSON.stringify(duringOutage.map((r) => r.item.subjectId)),
  );
  check(
    'their syncedAt is unchanged',
    duringOutage
      .filter((r) => r.item.queue === 'requested')
      .every((r) => r.syncedAt === syncedBefore.get(r.item.subjectId)),
  );
  check(
    "snapshot().partial contains 'requested'",
    queues.snapshot().partial.includes('requested'),
    JSON.stringify(queues.snapshot().partial),
  );
  const refsBeforePrune = cg('for-each-ref', '--format=%(refname)', 'refs/tm/review/');
  check(
    'the review refs are still there during the outage',
    refsBeforePrune.includes(`refs/tm/review/${WIDGETS}/head`),
    refsBeforePrune,
  );

  forgeState.searchStatus = 200;
  forgeState.searchNumbers = [12];
  await handlers['review:refreshQueues']();
  const afterComplete = store.listReviewQueue();
  check(
    'gh-42-7 is gone after a complete answer without it',
    !afterComplete.some((r) => r.item.subjectId === WIDGETS) &&
      afterComplete.some((r) => r.item.subjectId === GADGETS),
    JSON.stringify(afterComplete.map((r) => r.item.subjectId)),
  );
  check(
    "snapshot().partial no longer contains 'requested'",
    !queues.snapshot().partial.includes('requested'),
  );
  const refsAfter = cg('for-each-ref', '--format=%(refname)', 'refs/tm/review/');
  check('pruneReviewRefs emptied refs/tm/review/', refsAfter.trim() === '', refsAfter);
  const after7 = cloneState();
  check('clone HEAD still unchanged', after7.head === before.head);
  check('clone branches still unchanged', after7.branches === before.branches, after7.branches);
  check('clone porcelain status still unchanged', after7.status === before.status, after7.status);
} catch (e) {
  failures += 1;
  console.log('  FAIL  the scenario threw — ' + (e instanceof Error ? e.stack : String(e)));
} finally {
  if (server) await new Promise((r) => server.close(() => r()));
  try {
    store?.close();
  } catch (e) {
    console.log(`  (could not close the store at ${join(scratch, 'tm.db')}: ${e})`);
  }
}

console.log(`\n${passed} passed, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
