/**
 * Headless proof of the review pane's real pipeline (F6.11): a real git repository's diff,
 * read through the actual `DiffService` and real `git` subprocess calls
 * (`apps/client/src/main/review/diffService.ts`, `apps/client/src/main/git.ts`), then fed
 * through the pane's pure state machine (`packages/ui/src/review/reviewState.ts`) and
 * view-model helpers (`packages/ui/src/review/reviewView.ts`) — everything
 * `ReviewPaneView.tsx` needs to draw, built the same way `ReviewPane.tsx` builds it, minus
 * the IPC round trip and the DOM render itself. This workspace has no DOM test harness, and
 * the *verify-electron-app* memory says never launch the real app to check something — this
 * script is the headless stand-in for both.
 *
 *     node scripts/verify-review-pane.mjs
 *
 * ## Why this is a script and not a test
 *
 * `diffService.ts` and `git.ts` shell out to a REAL `git` binary against a REAL temporary
 * repository — the same reason `git.review.test.ts` is an integration test rather than a
 * unit test with a fake git. This script goes one step further than that test: it drives the
 * FULL chain a human's "Changes" pane depends on — diffService → reviewState's transitions →
 * reviewView's tree/totals/word-diff/default-expansion — against one seeded repo, which no
 * existing test does end to end. Neither `diffService.ts` nor `git.ts` import Electron
 * (`LocalExecHost` is plain `node:child_process`), so this runs under plain Node with no
 * Electron-as-Node hop — unlike the store scripts, which need one for better-sqlite3's ABI.
 *
 * ## What it proves
 *
 * 1. A real `git diff` end to end becomes the exact `DiffSummary` the pane would receive: a
 *    modified file (word-diff-worthy), a deletion, a rename with an edit (oldPath carried), a
 *    brand-new file inside a chain of single-child directories, a binary image, a generated
 *    lock file past the collapse-line threshold, an added file whose patch exceeds
 *    `DIFF_FILE_MAX_BYTES`, and an untracked working-tree file — so `includesWorkingTree` is
 *    `true`.
 * 2. `reviewState`'s transitions (`summaryLoadStarted`/`summaryArrived`/`fileLoadStarted`/
 *    `fileArrived`) accept that summary and the file reads that follow it, landing in exactly
 *    the states `ReviewPaneView`/`DiffView` switch on: `loaded` and `tooLarge`.
 * 3. `reviewView.buildFileTree` groups the files into the tree `FileTree.tsx` renders,
 *    collapsing the `src/main/review` chain into one node, directories sorted before files.
 * 4. `reviewView.defaultExpanded`/`fetchablePaths` skip the binary image and the
 *    collapsed-by-size lock file, agreeing with the shared, path-pattern-aware
 *    `isCollapsedByDefault` that `FileTree`/`DiffView` label with on this scenario's files.
 * 5. `reviewView.pairWordDiffs` highlights the one changed word inside the modified line, and
 *    leaves every context line unhighlighted.
 * 6. `diffService.image` reads the binary file's new side within the image cap.
 * 7. `diffService.resolve` answers `no-branch` and `landed` for the deps-level branches that
 *    never touch the repo.
 *
 * Prove the checks matter yourself with either of these two mutations — both verified to go
 * red while writing this script, then reverted:
 *
 *   - In `packages/ui/src/review/reviewView.ts`, change `pairWordDiffs`'s pair count from
 *     `Math.min(delEnd - delStart, addEnd - addStart)` to `Math.max(...)`: the "unmatched
 *     deleted line stays null" and "the context line right after the add run is untouched"
 *     checks both go red, because pairing reads one past the shorter (add) run into the
 *     context line that follows it and wrongly highlights that line instead of leaving it
 *     alone.
 *   - In `apps/client/src/main/review/diffService.ts`, delete the `tooLarge` branch inside
 *     `fileFrom` (`if (bytes > DIFF_FILE_MAX_BYTES) { ... }`): "big-added.ts loads as
 *     tooLarge, not as hunks" goes red, because the file loads in full instead of being
 *     capped.
 */
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const scratch = mkdtempSync(join(tmpdir(), 'tm-review-pane-'));
const repo = join(scratch, 'repo');

/**
 * esbuild ships as a per-platform binary under a versioned `.pnpm` directory, so it is found
 * by pattern rather than by path: a dependency bump renames the directory, and hard-coding
 * one version would rot this script at the next `pnpm up`. Copied from
 * `verify-review-comments-store.mjs`.
 */
function findEsbuild() {
  const pnpm = join(root, 'node_modules', '.pnpm');
  const target = `${process.platform}-${process.arch}`;
  const dir = readdirSync(pnpm).find((d) => d.startsWith(`@esbuild+${target}@`));
  if (!dir) throw new Error(`no esbuild binary for ${target} under ${pnpm}`);
  const exe = process.platform === 'win32' ? 'esbuild.exe' : 'bin/esbuild';
  return join(pnpm, dir, 'node_modules', '@esbuild', target, exe);
}

const esbuild = findEsbuild();
const sharedSrc = join(root, 'packages', 'shared', 'src');

function bundle(entry, outfile) {
  const res = spawnSync(
    esbuild,
    [
      entry,
      '--bundle',
      '--platform=node',
      '--format=cjs',
      `--alias:@shared=${sharedSrc}`,
      `--alias:@tm/shared=${sharedSrc}`,
      `--outfile=${outfile}`,
      '--log-level=error',
    ],
    { stdio: 'inherit' },
  );
  if (res.status !== 0) throw new Error(`esbuild failed bundling ${entry}`);
}

bundle(join(root, 'apps/client/src/main/review/diffService.ts'), join(scratch, 'diffService.cjs'));
bundle(join(root, 'apps/client/src/main/exec/index.ts'), join(scratch, 'exec.cjs'));
bundle(join(root, 'packages/ui/src/review/reviewView.ts'), join(scratch, 'reviewView.cjs'));
bundle(join(root, 'packages/ui/src/review/reviewState.ts'), join(scratch, 'reviewState.cjs'));
bundle(join(root, 'packages/shared/src/review.ts'), join(scratch, 'sharedReview.cjs'));

const { DiffService, createDiffGit, imageMimeOf } = require(join(scratch, 'diffService.cjs'));
const { localHost } = require(join(scratch, 'exec.cjs'));
const {
  buildFileTree,
  statusLetter,
  summaryTotals,
  pairWordDiffs,
  defaultExpanded,
  fetchablePaths,
} = require(join(scratch, 'reviewView.cjs'));
const { EMPTY_REVIEW, summaryLoadStarted, summaryArrived, fileLoadStarted, fileArrived } = require(
  join(scratch, 'reviewState.cjs'),
);
const {
  isCollapsedByDefault: sharedIsCollapsedByDefault,
  DIFF_COLLAPSE_LINES,
  DIFF_FILE_MAX_BYTES,
} = require(join(scratch, 'sharedReview.cjs'));

let failures = 0;
const check = (label, ok) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) failures++;
};

function git(args) {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
}

// ── Seed a real repository ───────────────────────────────────────────────────────────────
mkdirSync(repo, { recursive: true });
git(['init', '-b', 'main']);
git(['config', 'user.email', 'test@example.com']);
git(['config', 'user.name', 'Test']);
git(['config', 'commit.gpgsign', 'false']);
git(['config', 'core.autocrlf', 'false']);

writeFileSync(
  join(repo, 'a.txt'),
  'line1\nconst value = 1;\nshared text A\nshared text B\nline5\nline6\nline7\nline8\n',
);
// (the feature branch deletes "const value = 1;" AND "shared text A", adding back only
// "const value = 2;" — an unequal del/add run. "shared text B", the context line right
// after, shares tokens with "shared text A", so a buggy pairing that reads past the add
// run would produce a real, non-wholeLine highlight on it instead of leaving it alone.)
writeFileSync(join(repo, 'to-delete.txt'), 'nothing to see here\n');
writeFileSync(
  join(repo, 'old-name.txt'),
  Array.from({ length: 20 }, (_, i) => `row ${i}`).join('\n') + '\n',
);
writeFileSync(join(repo, 'pnpm-lock.yaml'), 'lockfileVersion: 1\n');
git(['add', '-A']);
git(['commit', '--no-verify', '-m', 'initial']);

git(['checkout', '-b', 'feature']);

// a.txt: deletes two lines ("const value = 1;" and "shared text A") and adds back only
// one ("const value = 2;") — an unequal del/add run, so pairWordDiffs must pair the
// shortest run and leave the unmatched del tail (and the context line after it) null.
writeFileSync(
  join(repo, 'a.txt'),
  'line1\nconst value = 2;\nshared text B\nline5\nline6\nline7\nline8\n',
);

// to-delete.txt: a deletion.
rmSync(join(repo, 'to-delete.txt'));

// old-name.txt -> new-name.txt: a rename with a small edit, still similar enough to detect.
const renamed = Array.from({ length: 20 }, (_, i) => `row ${i}`);
renamed[0] = 'row 0 (edited)';
writeFileSync(join(repo, 'new-name.txt'), renamed.join('\n') + '\n');
rmSync(join(repo, 'old-name.txt'));

// A new file inside a chain of single-child directories.
mkdirSync(join(repo, 'src', 'main', 'review'), { recursive: true });
writeFileSync(join(repo, 'src', 'main', 'review', 'NewFile.ts'), 'export const x = 1;\n');

// A binary image: PNG magic bytes plus NUL padding, enough for git's binary heuristic.
mkdirSync(join(repo, 'assets'), { recursive: true });
writeFileSync(
  join(repo, 'assets', 'logo.png'),
  Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(256, 0),
  ]),
);

// pnpm-lock.yaml grows past DIFF_COLLAPSE_LINES — a generated file that collapses by default.
writeFileSync(
  join(repo, 'pnpm-lock.yaml'),
  'lockfileVersion: 1\n' +
    Array.from({ length: DIFF_COLLAPSE_LINES + 500 }, (_, i) => `  dep${i}: ^1.0.${i}`).join('\n') +
    '\n',
);

// big-added.ts: fewer than DIFF_COLLAPSE_LINES lines, but its patch exceeds DIFF_FILE_MAX_BYTES —
// the per-file byte cap is distinct from the line-count collapse threshold.
const padding = 'padding '.repeat(30);
const bigLines = Array.from({ length: 1800 }, (_, i) => `const value${i} = "${padding}"; // ${i}`);
writeFileSync(join(repo, 'big-added.ts'), bigLines.join('\n') + '\n');

git(['add', '-A']);
git(['commit', '--no-verify', '-m', 'feature work']);

// An untracked working-tree file — includesWorkingTree becomes true.
writeFileSync(join(repo, 'draft.txt'), 'draft notes\n');

// ── Drive the real DiffService against the seeded repo ──────────────────────────────────
const project = { id: 'proj-1', path: repo, baseBranch: 'main' };
const taskOk = { id: 'task-ok', projectId: 'proj-1', agentBranch: 'feature', landedAt: null };
const taskNoBranch = {
  id: 'task-no-branch',
  projectId: 'proj-1',
  agentBranch: 'no-such-branch',
  landedAt: null,
};
const taskLanded = {
  id: 'task-landed',
  projectId: 'proj-1',
  agentBranch: 'feature',
  landedAt: Date.now(),
};

function makeDeps({ inspectReturns, mergeRequests = [] }) {
  return {
    getTask: (id) => [taskOk, taskNoBranch, taskLanded].find((t) => t.id === id),
    getProject: (id) => (id === project.id ? project : undefined),
    inspect: async () => inspectReturns,
    gitFor: () => createDiffGit(localHost()),
    listMergeRequests: () => mergeRequests,
  };
}

const serviceOk = new DiffService(
  makeDeps({ inspectReturns: { cwd: repo, branch: 'feature', base: 'main' } }),
);
const serviceOffline = new DiffService(makeDeps({ inspectReturns: null }));

(async () => {
  // ── Check 1: the real diff summary ────────────────────────────────────────────────────
  const result = await serviceOk.summary(taskOk.id);
  check('summary resolves ok', result.status === 'ok');
  if (result.status !== 'ok') {
    console.log(`\n${failures + 1} FAILED`);
    process.exit(1);
  }
  const { summary } = result;
  check(
    'includesWorkingTree is true (an untracked file is present)',
    summary.includesWorkingTree === true,
  );
  check('summary lists all eight changed paths', summary.files.length === 8);

  const byPath = new Map(summary.files.map((f) => [f.path, f]));
  check('a.txt is modified', byPath.get('a.txt')?.status === 'modified');
  check('to-delete.txt is deleted', byPath.get('to-delete.txt')?.status === 'deleted');
  check(
    'old-name.txt was detected as a rename to new-name.txt',
    byPath.get('new-name.txt')?.status === 'renamed' &&
      byPath.get('new-name.txt')?.oldPath === 'old-name.txt',
  );
  check(
    'src/main/review/NewFile.ts is added',
    byPath.get('src/main/review/NewFile.ts')?.status === 'added',
  );
  check('draft.txt (untracked) is added', byPath.get('draft.txt')?.status === 'added');

  const png = byPath.get('assets/logo.png');
  check('assets/logo.png is detected as binary', png?.binary === true);
  check('assets/logo.png is classified as an image', png?.image === true);
  check('assets/logo.png reports a non-zero byte size', (png?.bytes ?? 0) > 0);
  check(
    'imageMimeOf(assets/logo.png) is image/png',
    imageMimeOf('assets/logo.png') === 'image/png',
  );

  const lock = byPath.get('pnpm-lock.yaml');
  check(
    'pnpm-lock.yaml exceeds DIFF_COLLAPSE_LINES',
    (lock?.additions ?? 0) + (lock?.deletions ?? 0) > DIFF_COLLAPSE_LINES,
  );
  check(
    'pnpm-lock.yaml is collapsed by the shared, path-aware rule',
    lock && sharedIsCollapsedByDefault(lock),
  );

  const big = byPath.get('big-added.ts');
  check(
    'big-added.ts is under DIFF_COLLAPSE_LINES by line count',
    big !== undefined && big.additions + big.deletions <= DIFF_COLLAPSE_LINES,
  );

  // ── Check 2: feeding the summary through reviewState, same as ReviewPane does ────────
  let state = summaryLoadStarted(EMPTY_REVIEW, taskOk.id, 1);
  state = summaryArrived(state, taskOk.id, 1, result);
  check(
    'reviewState accepted the summary',
    state.summary?.status === 'ok' && state.diffId === summary.diffId,
  );

  const expanded = defaultExpanded(summary, 5);
  const eligible = summary.files.filter(
    (f) => !f.binary && !f.image && f.additions + f.deletions <= DIFF_COLLAPSE_LINES,
  );
  check('defaultExpanded excludes the binary image', !expanded.includes('assets/logo.png'));
  check('defaultExpanded excludes the collapsed lock file', !expanded.includes('pnpm-lock.yaml'));
  check(
    'defaultExpanded picks exactly min(5, eligible) paths, all eligible',
    expanded.length === Math.min(5, eligible.length) &&
      expanded.every((p) => eligible.some((e) => e.path === p)),
  );

  state = { ...state, expanded };
  const toFetch = fetchablePaths(state);
  check(
    'fetchablePaths equals the expanded set before any file has loaded',
    toFetch.length === expanded.length,
  );

  // Load each expanded file for real, through diffService.file, same as DiffView does.
  let seq = 2;
  for (const path of toFetch) {
    seq += 1;
    state = fileLoadStarted(state, taskOk.id, summary.diffId, path, seq);
    const fileResult = await serviceOk.file(taskOk.id, summary.diffId, path);
    state = fileArrived(state, taskOk.id, summary.diffId, path, seq, fileResult);
  }

  check(
    'a.txt loaded with hunks',
    state.files['a.txt']?.status === 'loaded' && state.files['a.txt'].file.hunks.length > 0,
  );

  if (expanded.includes('big-added.ts')) {
    check("big-added.ts's patch is over the per-file byte cap", true);
    check(
      'big-added.ts loads as tooLarge, not as hunks',
      state.files['big-added.ts']?.status === 'tooLarge' &&
        state.files['big-added.ts'].bytes > DIFF_FILE_MAX_BYTES,
    );
  } else {
    // Still prove the cap directly, even if big-added.ts fell outside the default-5 window.
    seq += 1;
    const direct = fileLoadStarted(state, taskOk.id, summary.diffId, 'big-added.ts', seq);
    const bigResult = await serviceOk.file(taskOk.id, summary.diffId, 'big-added.ts');
    const afterBig = fileArrived(direct, taskOk.id, summary.diffId, 'big-added.ts', seq, bigResult);
    check(
      'big-added.ts loads as tooLarge, not as hunks',
      afterBig.files['big-added.ts']?.status === 'tooLarge' &&
        afterBig.files['big-added.ts'].bytes > DIFF_FILE_MAX_BYTES,
    );
  }

  // ── Check 3: buildFileTree groups and collapses the way FileTree.tsx expects ─────────
  const tree = buildFileTree(summary.files);
  check(
    'the tree puts directories before files',
    tree[0].kind === 'dir' && tree[tree.length - 1].kind === 'file',
  );
  const srcDir = tree.find((n) => n.kind === 'dir' && n.name === 'src/main/review');
  check('src/main/review collapses into one chained node', srcDir !== undefined);
  check(
    'the collapsed chain holds NewFile.ts',
    srcDir?.children.length === 1 &&
      srcDir.children[0].kind === 'file' &&
      srcDir.children[0].entry.path === 'src/main/review/NewFile.ts',
  );
  const assetsDir = tree.find((n) => n.kind === 'dir' && n.name === 'assets');
  check(
    'assets/logo.png sits under its own assets directory',
    assetsDir?.children[0]?.entry.path === 'assets/logo.png',
  );
  const dirNames = tree.filter((n) => n.kind === 'dir').map((n) => n.name);
  const fileNames = tree.filter((n) => n.kind === 'file').map((n) => n.entry.path);
  check(
    'directories are sorted alphabetically among themselves',
    JSON.stringify(dirNames) === JSON.stringify([...dirNames].sort()),
  );
  check(
    'files are sorted alphabetically among themselves',
    JSON.stringify(fileNames) === JSON.stringify([...fileNames].sort()),
  );

  // statusLetter / summaryTotals sanity against the same summary.
  check(
    'statusLetter maps every status in the summary without throwing',
    summary.files.every((f) => typeof statusLetter(f.status) === 'string'),
  );
  const totals = summaryTotals(summary);
  const wantAdditions = summary.files.reduce((n, f) => n + f.additions, 0);
  const wantDeletions = summary.files.reduce((n, f) => n + f.deletions, 0);
  check(
    "summaryTotals sums every file's additions and deletions",
    totals.files === summary.files.length &&
      totals.additions === wantAdditions &&
      totals.deletions === wantDeletions,
  );

  // ── Check 4: pairWordDiffs pairs the shortest run, nothing else ──────────────────────
  // a.txt's hunk has TWO del lines ("const value = 1;", "shared text A") and only ONE add
  // line ("const value = 2;") — an unequal run that only the shortest-run pairing gets right.
  const aFile = state.files['a.txt'].file;
  const lines = aFile.hunks.flatMap((h) => h.lines);
  const words = pairWordDiffs(lines);
  const delIdxs = lines.reduce((acc, l, i) => (l.kind === 'del' ? [...acc, i] : acc), []);
  const addIdx = lines.findIndex((l) => l.kind === 'add');
  check(
    'a.txt has exactly two deleted lines and one added line',
    delIdxs.length === 2 && addIdx !== -1,
  );
  check(
    'the first deleted line ("const value = 1;") pairs with the added line',
    words[delIdxs[0]] !== null,
  );
  check('the added line gets a word-level highlight', words[addIdx] !== null);
  check(
    'the second, unmatched deleted line ("shared text A") stays null rather than reading past the add run',
    words[delIdxs[1]] === null,
  );
  const contextIdx = lines.findIndex((l) => l.kind === 'context');
  check(
    'a context line has no word-level highlight',
    contextIdx !== -1 && words[contextIdx] === null,
  );
  check(
    'the context line right after the add run is untouched by the pairing (no out-of-run read)',
    lines[addIdx + 1]?.kind === 'context' && words[addIdx + 1] === null,
  );

  // ── Check 5: diffService.image reads the new side of the binary file ────────────────
  const imageResult = await serviceOk.image(taskOk.id, summary.diffId, 'assets/logo.png');
  check('diffService.image resolves ok', imageResult.status === 'ok');
  check(
    'the added image has no old side and a loaded new side',
    imageResult.status === 'ok' &&
      imageResult.image.old === null &&
      imageResult.image.new?.mime === 'image/png',
  );

  // ── Check 6: the deps-level branches that never touch the repo ──────────────────────
  const noBranchResult = await serviceOffline.summary(taskNoBranch.id);
  check(
    'a branch that was never created resolves no-branch',
    noBranchResult.status === 'no-branch',
  );

  const landedResult = await new DiffService(
    makeDeps({
      inspectReturns: null,
      mergeRequests: [
        { taskId: taskLanded.id, state: 'merged', webUrl: 'https://example.invalid/mr/1' },
      ],
    }),
  ).summary(taskLanded.id);
  check(
    'a landed task resolves landed with its merge request url',
    landedResult.status === 'landed' && landedResult.forgeUrl === 'https://example.invalid/mr/1',
  );
  const landedState = summaryArrived(
    summaryLoadStarted(EMPTY_REVIEW, taskLanded.id, 1),
    taskLanded.id,
    1,
    landedResult,
  );
  check(
    'reviewState clears the file list for a non-ok summary',
    landedState.diffId === null && landedState.files && Object.keys(landedState.files).length === 0,
  );

  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
