/**
 * Headless proof of F12.4's Ticket section: `<TaskDetail>` rendered through the real
 * `renderToStaticMarkup` (`packages/ui/src/TaskDetail.tsx`, `./projects/TaskTicketSection.tsx`,
 * `./projects/TicketFieldsSection.tsx`, `./projects/ticketSummary.ts`), the same component tree
 * every host mounts, minus the DOM and the IPC round trip — modelled on
 * `verify-review-pane.mjs`. This workspace has no DOM test harness, and the
 * *verify-electron-app* memory says never launch the real app to check something.
 *
 *     node scripts/verify-ticket-section.mjs
 *
 * ## `--format=cjs`, not `--format=esm`
 *
 * `@fluentui/react-icons`'s package.json has no `"node"` export condition, only `"import"`
 * (`lib/index.js`) and `"require"` (`lib-cjs/index.js`); under Node's native ESM resolver
 * (`--format=esm`, icons left external) `lib/index.js`'s own internal imports are
 * extension-less and fail with `ERR_MODULE_NOT_FOUND` on a path like `.../icons/chunk-0`. Not
 * externalizing it sidesteps that, but then bundling `@fluentui/react-components` (which also
 * pulls Griffel in) as an ESM *output* fails a different way: `@griffel/react` does a plain
 * `require('react')` for its `useInsertionEffect` feature check, and esbuild's ESM output turns
 * every external `require` into a shim that throws `Dynamic require of "react" is not
 * supported` the instant it runs — `require` cannot be synchronous inside real ESM.
 * `--format=cjs` avoids both problems: Node's CJS resolver tolerates the extension-less
 * requires, and a real `require('react')` just works. `react`/`react-dom` stay external and
 * resolve from `packages/ui/node_modules` (pnpm symlinks workspace peer deps there);
 * everything else — all of `@fluentui/*` included — is bundled in.
 *
 * ## Why the work dir sits under `packages/ui/`
 *
 * esbuild's bare-specifier resolution walks up from the entry file's own directory, so
 * `packages/ui/.verify-ticket-section/` (gitignored by the repo's unanchored `.verify-*`
 * directory pattern) finds `packages/ui/node_modules/{react,react-dom,@fluentui}` the same way a file
 * under `packages/ui/src` would. `@tm/shared/*` is aliased straight to `packages/shared/src`
 * (copied from `verify-review-pane.mjs`), so this never depends on `packages/shared/dist`
 * being freshly built.
 *
 * ## What it proves
 *
 * 1. A native ticket (`source: 'ticket'`, type `story`, a milestone, 3 story points, a due
 *    date) renders the "Ticket" heading and the exact summary line `ticketSummaryLine` itself
 *    produces for that ticket — computed from the real function, not hand-typed, so a locale
 *    or year-boundary change can never make this assertion lie.
 * 2. A JIRA card (`source: 'jira'`) and an ad-hoc card (`source: 'adhoc'`) render neither the
 *    heading nor the summary line — `isNativeTicket` gates the whole section.
 * 3. With `localStorage` seeded as if the fold had already been opened on this device
 *    (`tm.taskDetail.ticketOpen` = `'1'`), the native card's markup contains the "Milestone"
 *    and "Story points" field labels from `TicketFieldsSection`.
 *
 * Prove the checks matter yourself: in `packages/ui/src/TaskDetail.tsx`, change
 * `{isNativeTicket(task) && (` to `{true && (`. The two "no Ticket section" checks (JIRA,
 * ad-hoc) both go red, because the section now renders for every card regardless of its
 * source — rerun this script to see it, then revert. Verified while writing this script
 * (both checks went red), then reverted; `git status` showed the file byte-identical
 * afterwards.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const uiRoot = join(root, 'packages', 'ui');
const work = join(uiRoot, '.verify-ticket-section');
const sharedSrc = join(root, 'packages', 'shared', 'src');
const protocolSrc = join(root, 'packages', 'protocol', 'src');

/**
 * esbuild ships as a per-platform binary under a versioned `.pnpm` directory, so it is found
 * by pattern rather than by path: a dependency bump renames the directory, and hard-coding
 * one version would rot this script at the next `pnpm up`. Copied from `verify-review-pane.mjs`.
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
import type { Milestone, Person, Project, Task, TicketLabel } from '@tm/shared/model';
import { TransportProvider, type Transport } from '../src/transport';
import { TaskDetail } from '../src/TaskDetail';
export { ticketSummaryLine } from '../src/projects/ticketSummary';

const stub: Transport = {
  invoke: (async () => []) as unknown as Transport['invoke'],
  on: () => () => {},
  pathForFile: () => '',
};

export interface RenderOpts {
  milestones?: Milestone[];
  people?: Person[];
  agentProjects?: Project[];
  labels?: TicketLabel[];
  ticketSectionOpen?: boolean;
}

// localStorage does not exist under plain Node; useDeviceFold already wraps its read in a
// try/catch for exactly that reason, so the fold silently defaults closed unless this stubs
// one in first — this is what seeds it as already open for the fold-open scenario.
export function renderTaskDetail(task: Task, opts: RenderOpts = {}): string {
  const store = new Map<string, string>();
  if (opts.ticketSectionOpen) store.set('tm.taskDetail.ticketOpen', '1');
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
        React.createElement(TaskDetail, {
          task,
          milestones: opts.milestones ?? [],
          people: opts.people ?? [],
          agentProjects: opts.agentProjects ?? [],
          labels: opts.labels ?? [],
        }),
      ),
    ),
  );
}
`,
);

function bundle() {
  const outfile = join(work, 'harness.cjs');
  const res = spawnSync(
    esbuild,
    [
      harnessPath,
      '--bundle',
      '--platform=node',
      '--format=cjs',
      `--alias:@tm/shared=${sharedSrc}`,
      `--alias:@tm/protocol=${protocolSrc}`,
      '--external:react',
      '--external:react-dom',
      '--external:react-dom/*',
      `--outfile=${outfile}`,
      '--log-level=warning',
    ],
    { stdio: 'inherit', cwd: uiRoot },
  );
  if (res.status !== 0) throw new Error('esbuild failed bundling the harness');
  return outfile;
}

let failures = 0;
const check = (label, ok) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) failures++;
};

const harnessOut = bundle();
const { renderTaskDetail, ticketSummaryLine } = require(harnessOut);

// ── Seed three cards: a native ticket, a JIRA card, an ad-hoc card ─────────────────────────
const milestone = {
  id: 'ms-1',
  projectId: 'proj-1',
  name: 'Launch',
  description: '',
  dueAt: null,
  color: '',
  closed: false,
  createdAt: 0,
};

const base = {
  projectId: 'proj-1',
  phase: 'Phase 1',
  status: 'pending',
  sessionId: null,
  order: 0,
  dependsOn: [],
  isContract: false,
  isScaffold: false,
};

const nativeTicket = {
  ...base,
  id: 'task-native',
  title: 'Add the billing export',
  source: 'ticket',
  issueType: 'story',
  milestoneId: 'ms-1',
  storyPoints: 3,
  dueAt: Date.UTC(2026, 11, 1),
};

const jiraCard = {
  ...base,
  id: 'task-jira',
  title: 'TM-100 synced card',
  source: 'jira',
  externalSource: 'jira',
  externalKey: 'TM-100',
  issueType: 'story',
  milestoneId: 'ms-1',
  storyPoints: 3,
  dueAt: Date.UTC(2026, 11, 1),
};

const adhocCard = {
  ...base,
  id: 'task-adhoc',
  title: 'Quick manual fix',
  source: 'adhoc',
};

// ── Check 1: the native ticket renders the Ticket section ─────────────────────────────────
const nativeMarkup = renderTaskDetail(nativeTicket, { milestones: [milestone] });
check('the native ticket renders the "Ticket" heading', nativeMarkup.includes('>Ticket<'));

const expectedSummary = ticketSummaryLine(nativeTicket, { milestones: [milestone] });
check(
  'the native ticket has a non-trivial summary line (type, milestone, points, due date all present)',
  ['Story', 'Launch', '3 pts', 'due'].every((part) => expectedSummary.includes(part)),
);
check(
  "the native ticket's markup contains the exact summary line",
  nativeMarkup.includes(expectedSummary),
);

// ── Check 2: JIRA and ad-hoc cards render neither the heading nor the summary ─────────────
const jiraMarkup = renderTaskDetail(jiraCard, { milestones: [milestone] });
check('the JIRA card does not render the "Ticket" heading', !jiraMarkup.includes('>Ticket<'));
check(
  "the JIRA card's markup does not contain the native ticket's summary line",
  !jiraMarkup.includes(expectedSummary),
);

const adhocMarkup = renderTaskDetail(adhocCard, {});
check('the ad-hoc card does not render the "Ticket" heading', !adhocMarkup.includes('>Ticket<'));

// ── Check 3: with the fold stored open, the field labels are in the markup ────────────────
const openMarkup = renderTaskDetail(nativeTicket, {
  milestones: [milestone],
  ticketSectionOpen: true,
});
check(
  'with the fold open, the "Milestone" field label is in the markup',
  openMarkup.includes('>Milestone<'),
);
check(
  'with the fold open, the "Story points" field label is in the markup',
  openMarkup.includes('>Story points<'),
);
check(
  'with the fold CLOSED (default), neither field label renders',
  !nativeMarkup.includes('>Milestone<') && !nativeMarkup.includes('>Story points<'),
);

rmSync(work, { recursive: true, force: true });

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
