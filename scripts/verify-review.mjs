/**
 * Headless end-to-end proof of F6 (`docs/plan/feature-roadmap/F6-in-app-code-review.md`): a
 * real temp git repository's diff, read through the real `DiffService` (F6.6), commented on
 * through the real `ReviewService` (F6.8) backed by a real SQLite `review_drafts` table
 * (F6.7, widened to any review subject by F15.4), sent as one batched follow-up (F6.9)
 * through a REAL spawned Claude session — a stub
 * `claude` on PATH (memory `stub-claude-on-path`), driven by the real `SessionManager` /
 * `claudeSession.ts` NDJSON pipe, exactly as `review:send` hands a human's drafts to
 * `chatWithAgent`'s live-run path.
 *
 *     node scripts/verify-review.mjs
 *
 * ## Why this is a script and not a test
 *
 * `reviewService.test.ts` drives `ReviewService` against fakes for both `store` and `diffs`,
 * and `diffService.test.ts` drives `DiffService` against a fake `DiffGit` — neither proves
 * the two wired together against a REAL git repository and a REAL `review_drafts` table.
 * `better-sqlite3`'s addon is compiled for Electron's ABI, so nothing that calls `createStore`
 * can run under the Node that runs vitest (memory *the-store-has-no-tests*) — this script is
 * the only thing that exercises the store's half of this chain at all. And no existing test
 * sends a review through a process that is really spawned and really parses NDJSON: that is
 * the same stub-CLI technique `verify-hand-off.mjs` uses, extended here so the stub records
 * every message it is handed, which is what lets this script assert on the EXACT text
 * `formatReviewMessage` produced rather than just "something arrived".
 *
 * ## What it proves
 *
 * 1. A real repo with a base commit, a feature commit (a new function in an existing file plus
 *    a brand-new file), a SECOND feature commit that rewrites one of those lines, and an
 *    uncommitted edit on top becomes the exact `DiffSummary`/`DiffFile` a real `DiffService`
 *    resolves — `includesWorkingTree: true`, three changed files — over the same
 *    `task:diffSummary`/`task:diffFile` methods the IPC handlers call.
 * 2. `ReviewService.add` anchors a single-line comment and a range comment against that diff,
 *    each excerpt pulled from the real parsed hunks (`excerptFor`, F6.4), persisted through the
 *    real `review_drafts` table under the Electron-as-Node ABI hop.
 * 3. After the second feature commit rewrites the single-line comment's anchored text,
 *    `ReviewService.list` recomputes `outdated: true` for it (`markOutdated`, F6.4) and leaves
 *    the untouched range comment `outdated: false` — and `ReviewService.update` REFUSES to
 *    move the range comment's anchor against the now-stale `diffId`, answering `stale` with
 *    the current `diffId` rather than silently re-anchoring it to text the human never saw.
 * 4. `ReviewService.send` batches both drafts into the one `formatReviewMessage` follow-up and
 *    delivers it into a session that is ALREADY live (the card's approved-plan step, per F6's
 *    "never moves the card" rule) — a stub CLI really spawned via `SessionManager.start`, then
 *    really pushed to via `SessionManager.send`. The stub appends every stdin `user` message's
 *    text to a log file; the message logged for this delivery is asserted to equal
 *    `formatReviewMessage`'s own output byte for byte, not merely "non-empty".
 * 5. A second `send()` right after is refused `nothing-to-send` and the stub's message log
 *    stays at two lines (the initial prompt, then the one review) — a double click sends
 *    exactly one review (F6.9's acceptance). `send()` on an unknown task is refused
 *    `unknown-task`.
 *
 * Prove the checks matter yourself with either of these two mutations to
 * `apps/client/src/main/review/reviewService.ts` — both verified to go red while writing this
 * script, then reverted:
 *
 *   - In `send()`, change the ids handed to `markReviewSent` from `drafts.map((c) => c.id)` to
 *     `[]`: check 5's "a second send() is refused nothing-to-send" goes red, because neither
 *     comment is ever stamped sent, so the second call still finds drafts and delivers a
 *     SECOND message — the stub's log grows to three lines instead of staying at two.
 *   - In `anchorAt()`, narrow the guard from `if (!current || current.diffId !== diffId)` to
 *     `if (!current)`: check 3's "moving the range comment's anchor against the stale diffId
 *     returns stale" goes red, because an anchor citing an old `diffId` is no longer caught —
 *     `update()` happily re-anchors it to the current (unrelated) revision instead of refusing.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const clientModules = join(root, 'apps', 'client', 'node_modules');
const scratch = mkdtempSync(join(tmpdir(), 'tm-review-'));
const repo = join(scratch, 'repo');

/**
 * esbuild ships as a per-platform binary under a versioned `.pnpm` directory, so it is found
 * by pattern rather than by path: a dependency bump renames the directory, and hard-coding one
 * version would rot this script at the next `pnpm up`. Copied from `verify-hand-off.mjs`.
 */
function findEsbuild() {
  const pnpm = join(root, 'node_modules', '.pnpm');
  const target = `${process.platform}-${process.arch}`;
  const dir = readdirSync(pnpm).find((d) => d.startsWith(`@esbuild+${target}@`));
  if (!dir) throw new Error(`no esbuild binary for ${target} under ${pnpm}`);
  const exe = process.platform === 'win32' ? 'esbuild.exe' : 'bin/esbuild';
  return join(pnpm, dir, 'node_modules', '@esbuild', target, exe);
}

// ── Phase 1: plain Node — seed the repo, bundle the sources, lay down the stub CLI ───────
if (!process.versions.electron) {
  // Seed a real repository before handing off to Electron: plain `git`, no Electron needed.
  mkdirSync(repo, { recursive: true });
  const git = (args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
  git(['init', '-b', 'main']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'Test']);
  git(['config', 'commit.gpgsign', 'false']);
  git(['config', 'core.autocrlf', 'false']);

  mkdirSync(join(repo, 'src'), { recursive: true });
  writeFileSync(
    join(repo, 'src', 'app.ts'),
    'export function greet(name: string): string {\n  return `hello, ${name}`;\n}\n',
  );
  writeFileSync(
    join(repo, 'src', 'util.ts'),
    'export function double(n: number): number {\n  return n * 2;\n}\n',
  );
  git(['add', '-A']);
  git(['commit', '--no-verify', '-m', 'initial']);

  git(['checkout', '-b', 'feature']);
  writeFileSync(
    join(repo, 'src', 'app.ts'),
    'export function greet(name: string): string {\n' +
      '  return `hello, ${name}`;\n' +
      '}\n' +
      '\n' +
      'export function farewell(name: string): string {\n' +
      '  return `bye, ${name}`;\n' +
      '}\n',
  );
  writeFileSync(
    join(repo, 'src', 'new.ts'),
    "export const VERSION = 1;\nexport const NAME = 'task-manager';\n",
  );
  git(['add', '-A']);
  git(['commit', '--no-verify', '-m', 'feature work']);

  // An uncommitted edit on top of the feature commit — includesWorkingTree becomes true.
  writeFileSync(
    join(repo, 'src', 'util.ts'),
    'export function double(n: number): number {\n  return n * 2 + 1;\n}\n',
  );

  const esbuild = findEsbuild();
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
        ...(external ? external.map((mod) => `--external:${mod}`) : []),
        `--outfile=${outfile}`,
        '--log-level=error',
      ],
      { stdio: 'inherit' },
    );

  bundle(join(root, 'apps/client/src/main/store.ts'), join(scratch, 'store.cjs'), [
    'better-sqlite3',
  ]);
  bundle(
    join(root, 'apps/client/src/main/review/diffService.ts'),
    join(scratch, 'diffService.cjs'),
  );
  bundle(
    join(root, 'apps/client/src/main/review/reviewService.ts'),
    join(scratch, 'reviewService.cjs'),
  );
  bundle(join(root, 'apps/client/src/main/exec/index.ts'), join(scratch, 'exec.cjs'));
  // `sessionManager.ts` pulls in `claudeSession.ts` (the real spawn + NDJSON parser),
  // `exec/index.ts`, `eventNoise.ts`, `headlessContract.ts` and `permissionServerSource.ts` —
  // none of them touch Electron or better-sqlite3, so this bundles and runs as plain Node too.
  bundle(join(root, 'apps/client/src/main/sessionManager.ts'), join(scratch, 'sessionManager.cjs'));
  bundle(join(root, 'packages/shared/src/review.ts'), join(scratch, 'sharedReview.cjs'));

  // The stub CLI: a `.cmd` shim (so Windows' shell lookup for a bare `claude` finds it, the
  // way a terminal would) plus the Node script it runs. It emits the two load-bearing NDJSON
  // lines a real `claude -p --output-format stream-json` run would (`system/init`, `result`),
  // keeps stdin open afterwards like a managed session does, and appends every incoming
  // `type: 'user'` message's text to a log file — the fact this script asserts on.
  const binDir = join(scratch, 'bin');
  mkdirSync(binDir, { recursive: true });
  const logPath = join(scratch, 'session-messages.ndjson');
  writeFileSync(join(binDir, 'claude.cmd'), '@echo off\r\nnode "%~dp0claude-stub.cjs" %*\r\n');
  writeFileSync(
    join(binDir, 'claude-stub.cjs'),
    [
      "const fs = require('fs');",
      "const readline = require('readline');",
      `const LOG_PATH = ${JSON.stringify(logPath)};`,
      'const args = process.argv.slice(2);',
      'const at = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };',
      "const sessionId = at('--session-id') ?? at('--resume') ?? 'stub-session';",
      "const model = at('--model') ?? 'stub';",
      'process.stdout.write(JSON.stringify({',
      "  type: 'system', subtype: 'init', session_id: sessionId, model,",
      "  cwd: process.cwd(), permissionMode: 'acceptEdits',",
      "}) + '\\n');",
      "readline.createInterface({ input: process.stdin }).on('line', (line) => {",
      '  let msg;',
      '  try { msg = JSON.parse(line); } catch { return; }',
      "  if (msg.type !== 'user') return;",
      "  const text = msg.message?.content?.[0]?.text ?? '';",
      "  fs.appendFileSync(LOG_PATH, JSON.stringify({ text }) + '\\n');",
      '});',
      'setTimeout(() => {',
      '  process.stdout.write(JSON.stringify({',
      "    type: 'result', subtype: 'success', is_error: false,",
      "    result: 'stub run complete', total_cost_usd: 0,",
      "  }) + '\\n');",
      '}, 300);',
      '// Stay alive — a managed session (stdin kept open) never self-exits after a result;',
      '// the caller terminates the process tree once it has what it needs.',
      'process.stdin.resume();',
      '',
    ].join('\n'),
  );

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
      NODE_PATH: clientModules,
      // Prepended, not replacing — `claude.cmd`'s own `node "%~dp0claude-stub.cjs"` still
      // needs the real `node` the rest of PATH provides.
      PATH: `${binDir}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH ?? ''}`,
    },
  });
  process.exit(run.status ?? 1);
}

// ── Phase 2: under Electron-as-Node — the actual end-to-end proof ───────────────────────
const require = createRequire(import.meta.url);
const work = process.argv[2];
const workRepo = join(work, 'repo');
const logPath = join(work, 'session-messages.ndjson');

const { createStore } = require(join(work, 'store.cjs'));
const { DiffService, createDiffGit } = require(join(work, 'diffService.cjs'));
const { ReviewService } = require(join(work, 'reviewService.cjs'));
const { localHost } = require(join(work, 'exec.cjs'));
const { SessionManager } = require(join(work, 'sessionManager.cjs'));
const { formatReviewMessage } = require(join(work, 'sharedReview.cjs'));

let failures = 0;
const check = (label, ok) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) failures++;
};

function git(args) {
  return execFileSync('git', args, { cwd: workRepo, encoding: 'utf8' });
}

function linesOf(file) {
  return file.hunks.flatMap((h) => h.lines);
}

function readLoggedMessages() {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line).text);
}

async function waitFor(predicate, timeoutMs = 10_000) {
  const start = Date.now();
  for (;;) {
    if (predicate()) return;
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function main() {
  const dbPath = join(work, 'orchestrator.db');
  const store = createStore(dbPath);

  const project = store.addProject({ name: 'Repo', path: workRepo, baseBranch: 'main' });
  check('setup: the project was created', project != null);

  let task = store.createTask('personal', { title: 'Review the branch' });
  check('setup: the card was created', task != null);
  task = store.updateTask(task.id, {
    agentProjectId: project.id,
    agentBranch: 'feature',
    status: 'running',
  });

  const diffs = new DiffService({
    getTask: (id) => store.getTask(id),
    getProject: (id) => store.getProject(id),
    inspect: async () => ({ cwd: workRepo, branch: 'feature', base: 'main' }),
    gitFor: () => createDiffGit(localHost()),
    listMergeRequests: () => [],
  });

  // ── Check 1: a real diff summary over committed + uncommitted changes ────────────────
  const firstSummary = await diffs.summary(task.id);
  check('diffs.summary resolves ok', firstSummary.status === 'ok');
  check(
    'includesWorkingTree is true (util.ts has an uncommitted edit)',
    firstSummary.summary.includesWorkingTree === true,
  );
  check('the summary lists all three changed files', firstSummary.summary.files.length === 3);
  const oldDiffId = firstSummary.summary.diffId;

  // ── Check 2: direct file reads through the diffService (task:diffFile) ──────────────
  const appFile = await diffs.file(task.id, oldDiffId, 'src/app.ts');
  check('diffs.file(src/app.ts) resolves ok', appFile.status === 'ok');
  check('src/app.ts loaded with hunks', appFile.status === 'ok' && appFile.file.hunks.length > 0);

  const newFile = await diffs.file(task.id, oldDiffId, 'src/new.ts');
  check('diffs.file(src/new.ts) resolves ok', newFile.status === 'ok');

  const appLines = linesOf(appFile.file);
  const byeLine = appLines.find((l) => l.kind === 'add' && l.text.includes('bye'));
  check("app.ts's added 'bye' line was found", byeLine !== undefined);

  const newLines = linesOf(newFile.file);
  check(
    'new.ts has exactly two added lines',
    newLines.length === 2 && newLines.every((l) => l.kind === 'add'),
  );

  // ── Check 3: ReviewService.add anchors a single-line and a range comment ────────────
  const reviewsDeps = {
    store: {
      getTask: (id) => store.getTask(id),
      listReviewComments: (id) => store.listReviewComments(id),
      addReviewComment: (input) => store.addReviewComment(input),
      updateReviewComment: (id, patch) => store.updateReviewComment(id, patch),
      deleteReviewComment: (id) => store.deleteReviewComment(id),
      markReviewSent: (id, ids, at) => store.markReviewSent(id, ids, at),
    },
    diffs: {
      filesFor: (id, paths) => diffs.filesFor(id, paths),
      summary: (id) => diffs.summary(id),
    },
    chat: undefined, // wired once the live session exists (check 5)
  };
  const reviews = new ReviewService(reviewsDeps);

  const singleAdd = await reviews.add({
    taskId: task.id,
    diffId: oldDiffId,
    path: 'src/app.ts',
    side: 'new',
    line: byeLine.newLine,
    body: "Should this say 'farewell' instead of 'bye'?",
  });
  check('the single-line comment was added', singleAdd.status === 'ok');
  check(
    "its excerpt is the 'bye' line itself",
    singleAdd.status === 'ok' && singleAdd.comment.excerpt === byeLine.text,
  );

  const rangeAdd = await reviews.add({
    taskId: task.id,
    diffId: oldDiffId,
    path: 'src/new.ts',
    side: 'new',
    line: newLines[1].newLine,
    start: { side: 'new', line: newLines[0].newLine },
    body: 'Consider sourcing these from package.json instead.',
  });
  check('the range comment was added', rangeAdd.status === 'ok');
  check(
    'its excerpt spans both lines of new.ts',
    rangeAdd.status === 'ok' && rangeAdd.comment.excerpt === newLines.map((l) => l.text).join('\n'),
  );

  const freshList = await reviews.list(task.id);
  check(
    'both drafts start not outdated',
    freshList.every((c) => c.outdated !== true),
  );

  // ── Check 4: the agent edits while you comment — outdated, and a stale anchor move ──
  writeFileSync(
    join(workRepo, 'src', 'app.ts'),
    'export function greet(name: string): string {\n' +
      '  return `hello, ${name}`;\n' +
      '}\n' +
      '\n' +
      'export function farewell(name: string): string {\n' +
      '  return `farewell, ${name}`;\n' +
      '}\n',
  );
  git(['add', 'src/app.ts']);
  git(['commit', '--no-verify', '-m', 'tweak the farewell message']);

  const secondSummary = await diffs.summary(task.id);
  check('diffs.summary resolves ok after the edit', secondSummary.status === 'ok');
  const newDiffId = secondSummary.summary.diffId;
  check('the diffId moved on with the new commit', newDiffId !== oldDiffId);

  const afterEditList = await reviews.list(task.id);
  const singleAfter = afterEditList.find((c) => c.id === singleAdd.comment.id);
  const rangeAfter = afterEditList.find((c) => c.id === rangeAdd.comment.id);
  check(
    "the single-line comment ('bye' got rewritten) is now outdated",
    singleAfter?.outdated === true,
  );
  check('the untouched range comment is still not outdated', rangeAfter?.outdated !== true);

  const staleMove = await reviews.update(task.id, rangeAdd.comment.id, {
    anchor: {
      diffId: oldDiffId,
      side: rangeAdd.comment.side,
      line: rangeAdd.comment.line,
      start: rangeAdd.comment.start,
    },
  });
  check(
    "moving the range comment's anchor against the now-stale diffId is refused",
    staleMove.status === 'stale' &&
      staleMove.diffId === oldDiffId &&
      staleMove.currentDiffId === newDiffId,
  );

  // ── Check 5: send() delivers into a REAL, already-live session ──────────────────────
  const sessionManager = new SessionManager(() => {});
  let runId;
  let startedSessionId;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('stub CLI never started')), 15_000);
    ({ runId } = sessionManager.start(
      {
        prompt: 'Begin work on the ticket.',
        cwd: workRepo,
        model: 'sonnet',
        permissionMode: 'acceptEdits',
      },
      {
        onEvent: (event) => {
          if (event.kind === 'started') {
            startedSessionId = event.sessionId;
            clearTimeout(timer);
            resolve();
          }
          if (event.kind === 'stderr') console.error('stub CLI stderr:', event.text);
        },
      },
    ));
  });
  check(
    'a real session really started',
    typeof startedSessionId === 'string' && startedSessionId.length > 0,
  );
  await waitFor(() => readLoggedMessages().length >= 1);
  check(
    'the stub logged the initial prompt',
    readLoggedMessages()[0] === 'Begin work on the ticket.',
  );

  reviewsDeps.chat = (taskId, message) => {
    sessionManager.send(runId, message);
    return { status: 'sent', taskId, runId };
  };

  const expectedDrafts = afterEditList.filter((c) => c.sentAt === null);
  const expectedMessage = formatReviewMessage(
    expectedDrafts,
    secondSummary.summary,
    'Please address these before merging.',
  );

  const sendResult = await reviews.send(task.id, 'Please address these before merging.');
  check('send() reports sent', sendResult.status === 'sent');
  check(
    'send() stamped both comments sentAt',
    sendResult.status === 'sent' &&
      sendResult.comments.length === 2 &&
      sendResult.comments.every((c) => typeof c.sentAt === 'number'),
  );

  await waitFor(() => readLoggedMessages().length >= 2);
  const loggedAfterFirstSend = readLoggedMessages();
  check('exactly one review message was delivered', loggedAfterFirstSend.length === 2);
  check(
    "the delivered text equals formatReviewMessage's own output",
    loggedAfterFirstSend[1] === expectedMessage,
  );

  // ── Check 6: a second send() is refused, and an unknown task too ────────────────────
  const secondSend = await reviews.send(task.id, 'ignored — nothing left to send');
  check(
    'a second send() is refused nothing-to-send',
    secondSend.status === 'refused' && secondSend.reason === 'nothing-to-send',
  );
  await new Promise((resolve) => setTimeout(resolve, 200));
  check('the double send delivered no further message', readLoggedMessages().length === 2);

  const unknownSend = await reviews.send('no-such-task');
  check(
    'send() on an unknown task is refused unknown-task',
    unknownSend.status === 'refused' && unknownSend.reason === 'unknown-task',
  );

  sessionManager.stop(runId);
  store.close();

  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
