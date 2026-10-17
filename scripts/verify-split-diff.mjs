/**
 * Headless proof of F15.12's side-by-side layout: the real `ReviewPaneView`
 * (`packages/ui/src/review/ReviewPaneView.tsx`), rendered through `renderToStaticMarkup` with a
 * `ReviewState` seeded by `reviewState.ts`'s own pure transitions (`summaryLoadStarted` /
 * `summaryArrived` / `fileLoadStarted` / `fileArrived` / `commentsArrived`) — modelled on
 * `verify-review-pane.mjs` and `verify-ticket-section.mjs`. This workspace has no DOM test
 * harness, and the *verify-electron-app* memory says never launch the real app to check
 * something.
 *
 *     node scripts/verify-split-diff.mjs
 *
 * ## Two bundles, one reason each
 *
 * `reviewState.ts` has no React in it, so it is bundled on its own (`reviewState.cjs`) and
 * `require`d directly by this plain-JS script to build the `ReviewState` fixture through its
 * real transitions, the same way `verify-review-pane.mjs` builds its state. `harness.tsx` is
 * the only thing that touches React: it renders `<ReviewPaneView>` wrapped in
 * `FluentProvider`/`webLightTheme` and `TransportProvider`, bundled separately
 * (`harness.cjs`) with `--format=cjs` (not `--format=esm` — see `verify-ticket-section.mjs`'s
 * header for why `@fluentui/react-icons`/`@griffel/react` need the CJS output) and `react`/
 * `react-dom` left external so they resolve from `packages/ui/node_modules`. Both bundles live
 * under `packages/ui/.verify-split-diff/` (gitignored by the repo's unanchored `.verify-*`
 * pattern) so esbuild's bare-specifier resolution walks up to `packages/ui/node_modules` the
 * same way a file under `packages/ui/src` would.
 *
 * ## What it proves
 *
 * One file's diff covers every `SplitRow` shape `splitHunkRows` produces (`@tm/shared/review`):
 * an uneven 3-del/1-add run, a context row, a pure-add hunk and a lone-del run. Seeded as a
 * loaded `ReviewState` with two comments on the context row (one per side) and rendered twice —
 * once with `tm.review.diffLayout` stubbed to `'unified'`, once to `'split'` — through the EXACT
 * same `ReviewPaneView` a human's wide Changes pane draws.
 *
 * 1. Both renders succeed with no thrown error and produce non-empty markup.
 * 2. Unified merges the context row's old/new line numbers into one row: the two gutter
 *    `<span>` elements sharing one class render back-to-back, `>501<` immediately followed by
 *    `>907<`. Split draws the SAME two numbers as two separate cells: the context row's own
 *    text marker appears exactly once in unified (one merged row) and exactly twice in split
 *    (once per column), and the back-to-back-same-class gutter pair unified has does not appear
 *    in split at all.
 * 3. The new-side comment on the context row renders after the row's right-column gutter number
 *    in split's markup (so it lands under the right column, never the left), while the old-side
 *    comment on the same row renders before it (so it lands under the left column) — split's two
 *    columns are strictly sequential, non-overlapping blocks of the rendered HTML, so an
 *    anchor's position relative to the shared row's two gutter numbers is exactly which column
 *    it fell under. Both comments still render once each in unified, under the row's one
 *    merged cell.
 * 4. Every hunk's own line text (the uneven run, the pure-add hunk, the lone-del run) renders in
 *    both layouts — nothing silently drops a row.
 *
 * Prove the checks matter yourself: in `packages/ui/src/review/DiffView.tsx`'s `SplitHunk`, swap
 * `splitCellComments(comments, row, 'old')` and `splitCellComments(comments, row, 'new')`
 * between the two columns. Check 3 goes red on both halves (the new-side comment now renders
 * before the row's right gutter, the old-side comment after it) — rerun this script to see it,
 * then revert.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const uiRoot = join(root, 'packages', 'ui');
const work = join(uiRoot, '.verify-split-diff');
const sharedSrc = join(root, 'packages', 'shared', 'src');
const protocolSrc = join(root, 'packages', 'protocol', 'src');

/**
 * esbuild ships as a per-platform binary under a versioned `.pnpm` directory, so it is found
 * by pattern rather than by path — copied from `verify-ticket-section.mjs`.
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

// ── Write the probe inside the repo's ignored scratch space ────────────────────────────────
rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });

const harnessPath = join(work, 'harness.tsx');
writeFileSync(
  harnessPath,
  `
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { FluentProvider, webLightTheme } from '@fluentui/react-components';
import { TransportProvider, type Transport } from '../src/transport';
import { ReviewPaneView } from '../src/review/ReviewPaneView';
import { DIFF_LAYOUT_STORAGE_KEY, type DiffLayout } from '../src/review/reviewView';
import type { ReviewState } from '../src/review/reviewState';

const stub: Transport = {
  invoke: (async () => []) as unknown as Transport['invoke'],
  on: () => () => {},
  pathForFile: () => '',
};

// Every ReviewPaneView callback prop is required but never exercised by renderToStaticMarkup
// (there is no DOM to click) — one no-op satisfies all of them regardless of arity.
const noop = (() => {}) as (...args: unknown[]) => void;

/**
 * Seeds localStorage fresh before each render — \`useDiffLayout\` reads
 * \`tm.review.diffLayout\` once, in its own useState initializer, so the stub has to be in
 * place before this call, not after.
 */
export function renderPane(state: ReviewState, layoutPref: DiffLayout): string {
  const store = new Map<string, string>();
  store.set(DIFF_LAYOUT_STORAGE_KEY, layoutPref);
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => store.set(key, value),
    removeItem: (key: string) => store.delete(key),
  };

  return renderToStaticMarkup(
    React.createElement(
      FluentProvider,
      { theme: webLightTheme },
      React.createElement(
        TransportProvider,
        { transport: stub },
        React.createElement(ReviewPaneView, {
          taskId: state.taskId ?? 'task-1',
          state,
          error: null,
          onReload: noop,
          onSelectFile: noop,
          onToggleExpanded: noop,
          onClickLine: noop,
          onTapLine: noop,
          onCancelSelection: noop,
          onCommentSelection: noop,
          onEditDraft: noop,
          onSave: noop,
          onCancel: noop,
          onEdit: noop,
          onDelete: noop,
          onEditNote: noop,
          onSend: noop,
        }),
      ),
    ),
  );
}
`,
);

function bundle(entry, outfile, { external = [] } = {}) {
  const res = spawnSync(
    esbuild,
    [
      entry,
      '--bundle',
      '--platform=node',
      '--format=cjs',
      `--alias:@tm/shared=${sharedSrc}`,
      `--alias:@tm/protocol=${protocolSrc}`,
      ...external.map((name) => `--external:${name}`),
      `--outfile=${outfile}`,
      '--log-level=warning',
    ],
    { stdio: 'inherit', cwd: uiRoot },
  );
  if (res.status !== 0) throw new Error(`esbuild failed bundling ${entry}`);
  return outfile;
}

let failures = 0;
const check = (label, ok) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) failures++;
};

const reviewStateOut = bundle(
  join(root, 'packages/ui/src/review/reviewState.ts'),
  join(work, 'reviewState.cjs'),
);
const harnessOut = bundle(harnessPath, join(work, 'harness.cjs'), {
  external: ['react', 'react-dom', 'react-dom/*'],
});

const {
  EMPTY_REVIEW,
  summaryLoadStarted,
  summaryArrived,
  fileLoadStarted,
  fileArrived,
  commentsArrived,
} = require(reviewStateOut);
const { renderPane } = require(harnessOut);

// ── Seed one file whose hunks cover every SplitRow shape ───────────────────────────────────
const path = 'src/example.ts';
const diffId = 'diff-1';
const taskId = 'task-1';

// Shape 1: an uneven 3-del/1-add run — pairWordDiffs/splitRows pad the shorter side with null.
const unevenHunk = {
  oldStart: 1,
  oldLines: 3,
  newStart: 1,
  newLines: 1,
  header: '@@ hunk-uneven @@',
  lines: [
    { kind: 'del', text: 'OLDA', oldLine: 1 },
    { kind: 'del', text: 'OLDB', oldLine: 2 },
    { kind: 'del', text: 'OLDC', oldLine: 3 },
    { kind: 'add', text: 'NEWX', newLine: 1 },
  ],
};

// Shape 2: a context row — both sides set, same DiffLine, two DIFFERENT line numbers so a
// gutter's position in the markup unambiguously identifies which column rendered it.
const contextHunk = {
  oldStart: 501,
  oldLines: 1,
  newStart: 907,
  newLines: 1,
  header: '@@ hunk-context @@',
  lines: [{ kind: 'context', text: 'CTXMARKER', oldLine: 501, newLine: 907 }],
};

// Shape 3: a pure-add hunk — every row's left side is null.
const pureAddHunk = {
  oldStart: 0,
  oldLines: 0,
  newStart: 1,
  newLines: 2,
  header: '@@ hunk-pure-add @@',
  lines: [
    { kind: 'add', text: 'ADDONLY1', newLine: 1 },
    { kind: 'add', text: 'ADDONLY2', newLine: 2 },
  ],
};

// Shape 4: a lone del run — no add right after it, so every row's right side is null.
const loneDelHunk = {
  oldStart: 10,
  oldLines: 2,
  newStart: 10,
  newLines: 0,
  header: '@@ hunk-lone-del @@',
  lines: [
    { kind: 'del', text: 'DELONLY1', oldLine: 10 },
    { kind: 'del', text: 'DELONLY2', oldLine: 11 },
  ],
};

const file = { diffId, path, hunks: [unevenHunk, contextHunk, pureAddHunk, loneDelHunk] };

const entry = {
  path,
  status: 'modified',
  additions: 3,
  deletions: 5,
  binary: false,
  image: false,
  bytes: 400,
};

const summary = {
  diffId,
  baseRef: 'main',
  baseSha: 'base-sha',
  headSha: 'head-sha',
  includesWorkingTree: false,
  files: [entry],
  truncated: false,
};

// Two comments on the SAME context row, one per side — the "which column" proof in check 3.
const oldComment = {
  id: 'c-old',
  taskId,
  diffId,
  path,
  side: 'old',
  line: 501,
  body: 'OLDSIDECOMMENT',
  excerpt: 'CTXMARKER',
  createdAt: 0,
  updatedAt: 0,
  sentAt: null,
};
const newComment = {
  id: 'c-new',
  taskId,
  diffId,
  path,
  side: 'new',
  line: 907,
  body: 'NEWSIDECOMMENT',
  excerpt: 'CTXMARKER',
  createdAt: 0,
  updatedAt: 0,
  sentAt: null,
};

// ── Build the ReviewState through reviewState.ts's own pure transitions ────────────────────
let state = summaryLoadStarted(EMPTY_REVIEW, taskId, 1);
state = summaryArrived(state, taskId, 1, { status: 'ok', summary });
check('summaryArrived loaded the diff', state.summary?.status === 'ok' && state.diffId === diffId);

state = { ...state, expanded: [path] };
state = fileLoadStarted(state, taskId, diffId, path, 2);
state = fileArrived(state, taskId, diffId, path, 2, { status: 'ok', file });
check('fileArrived loaded the file', state.files[path]?.status === 'loaded');

state = commentsArrived(state, taskId, 1, [oldComment, newComment]);
check('commentsArrived stored both comments', state.comments.length === 2);

// ── Render both layouts ─────────────────────────────────────────────────────────────────────
let unifiedMarkup = '';
let splitMarkup = '';
try {
  unifiedMarkup = renderPane(state, 'unified');
  check('the unified layout rendered', unifiedMarkup.length > 0);
} catch (err) {
  console.error(err);
  check('the unified layout rendered', false);
}
try {
  splitMarkup = renderPane(state, 'split');
  check('the split layout rendered', splitMarkup.length > 0);
} catch (err) {
  console.error(err);
  check('the split layout rendered', false);
}

const occurrences = (haystack, needle) => haystack.split(needle).length - 1;

// ── Check: unified merges the context row's two line numbers into one row ─────────────────
// DiffLineRow draws BOTH gutters in one <span class="X">501</span><span class="X">907</span>
// pair, back to back, reusing the exact same `styles.gutter` class for each — that adjacency,
// with the class repeated verbatim, only happens when one row carries both numbers.
const mergedGutterPair = /<span class="([^"]+)">501<\/span><span class="\1">907<\/span>/;
check(
  "unified's context row shows 501 and 907 as one merged gutter pair",
  mergedGutterPair.test(unifiedMarkup),
);
check(
  "split's context row does NOT show 501 and 907 as a merged gutter pair",
  !mergedGutterPair.test(splitMarkup),
);

// ── Check: split draws the context row as two separate cells, unified as one ──────────────
check(
  "unified's context row text renders once (one merged row)",
  occurrences(unifiedMarkup, 'CTXMARKER') === 1,
);
check(
  "split's context row text renders twice (one per column)",
  occurrences(splitMarkup, 'CTXMARKER') === 2,
);

// ── Check: a 'new'-side comment lands only under split's right column ─────────────────────
// Split's two columns are rendered as strictly sequential, non-overlapping blocks — the left
// column (gutter 501) is fully emitted before the right column (gutter 907) even starts, so an
// anchor's position relative to those two numbers IS which column it fell under.
const splitOldGutterIdx = splitMarkup.indexOf('>501<');
const splitNewGutterIdx = splitMarkup.indexOf('>907<');
check('split rendered both column gutters', splitOldGutterIdx !== -1 && splitNewGutterIdx !== -1);
check('split renders the left column before the right one', splitOldGutterIdx < splitNewGutterIdx);

check(
  'split: the new-side comment renders exactly once',
  occurrences(splitMarkup, 'NEWSIDECOMMENT') === 1,
);
check(
  'split: the new-side comment renders AFTER the right column gutter (under the right column)',
  splitMarkup.indexOf('NEWSIDECOMMENT') > splitNewGutterIdx,
);
check(
  'split: the old-side comment renders exactly once',
  occurrences(splitMarkup, 'OLDSIDECOMMENT') === 1,
);
check(
  'split: the old-side comment renders BEFORE the right column gutter (under the left column)',
  splitMarkup.indexOf('OLDSIDECOMMENT') < splitNewGutterIdx,
);

// Unified has no columns to split between — the same context row shows both comments.
check(
  'unified still shows both comments, under the one merged row',
  occurrences(unifiedMarkup, 'NEWSIDECOMMENT') === 1 &&
    occurrences(unifiedMarkup, 'OLDSIDECOMMENT') === 1,
);

// ── Check: every other SplitRow shape rendered in both layouts, nothing silently dropped ──
for (const marker of [
  'OLDA',
  'OLDB',
  'OLDC',
  'NEWX',
  'ADDONLY1',
  'ADDONLY2',
  'DELONLY1',
  'DELONLY2',
]) {
  check(`unified renders ${marker}`, unifiedMarkup.includes(marker));
  check(`split renders ${marker}`, splitMarkup.includes(marker));
}

rmSync(work, { recursive: true, force: true });

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
