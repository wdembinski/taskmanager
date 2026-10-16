/**
 * Headless proof of F12.5's Links section: `<TaskDetail>` rendered through the real
 * `renderToStaticMarkup` (`packages/ui/src/TaskDetail.tsx`,
 * `./projects/TaskLinksSection.tsx`, `./projects/TaskTicketSection.tsx`,
 * `./projects/linkedTickets.ts`), the same component tree every host mounts, minus the DOM
 * and the IPC round trip — modelled on `verify-ticket-section.mjs` (F12.4), down to the
 * esbuild `--format=cjs` reasoning and the gitignored `.verify-*` work dir under
 * `packages/ui/`; see that script's header for both. `ticketLinks`, `chainLinks` and
 * `chainTasksById` are passed to `TaskDetail` explicitly, so nothing here needs a live IPC
 * channel.
 *
 *     node scripts/verify-links-section.mjs
 *
 * ## What it proves
 *
 * 1. A card with no ticket links and no chain links renders no "Links" heading at all.
 * 2. A blocks B: A's markup shows "blocks" plus B's key and title; B's markup shows
 *    "is blocked by" plus A's key.
 * 3. A link to an id absent from `chainTasksById` still renders that id, plus a remove
 *    button addressed to it — the link stays removable even though the other ticket is gone.
 * 4. A card with only a chain link (no ticket links) shows the chain-pointer row, ending in
 *    "— see Chain".
 * 5. A native ticket with no links at all, with `tm.taskDetail.ticketOpen` seeded `'1'`,
 *    shows the ticket-link add row ("Add link") inside the Ticket section — the fallback
 *    `TaskTicketSection.addLink` takes over once the Links section itself has nothing to
 *    show. A JIRA card with no links shows neither the Ticket section nor the add row,
 *    because `isNativeTicket` gates the whole section before `addLink` is ever reached.
 *
 * Prove the checks matter yourself: in `packages/ui/src/projects/TaskLinksSection.tsx`,
 * change `if (!section) return null;` to `if (false) return null;`. Check 1 goes red — with
 * no guard, `section` is `null` and `section.groups.map(...)` throws, so the "no links"
 * card's render itself fails instead of quietly omitting the heading. Verified while writing
 * this script (check 1 threw and failed), then reverted; `git status` showed the file
 * byte-identical afterwards.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const uiRoot = join(root, 'packages', 'ui');
const work = join(uiRoot, '.verify-links-section');
const sharedSrc = join(root, 'packages', 'shared', 'src');
const protocolSrc = join(root, 'packages', 'protocol', 'src');

/** Copied from `verify-ticket-section.mjs` — see its header for why this has to hunt a
 *  per-platform binary under a versioned `.pnpm` directory rather than a fixed path. */
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
import type { Task, TicketLink } from '@tm/shared/model';
import type { TaskLink } from '@tm/shared/taskChain';
import { TransportProvider, type Transport } from '../src/transport';
import { TaskDetail } from '../src/TaskDetail';

const stub: Transport = {
  invoke: (async () => []) as unknown as Transport['invoke'],
  on: () => () => {},
  pathForFile: () => '',
};

export interface RenderOpts {
  ticketLinks?: readonly TicketLink[];
  chainLinks?: readonly TaskLink[];
  chainTasksById?: ReadonlyMap<string, Task>;
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
          ticketLinks: opts.ticketLinks ?? [],
          chainLinks: opts.chainLinks ?? [],
          chainTasksById: opts.chainTasksById ?? new Map(),
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
const { renderTaskDetail } = require(harnessOut);

// ── Fixtures ────────────────────────────────────────────────────────────────────────────
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

const taskA = {
  ...base,
  id: 'a',
  title: 'Add the billing export',
  source: 'ticket',
  ticketKey: 'TM-1',
};
const taskB = {
  ...base,
  id: 'b',
  title: 'Fix the invoice total',
  source: 'ticket',
  ticketKey: 'TM-2',
};
const taskC = { ...base, id: 'c', title: 'Unrelated epic', source: 'ticket', ticketKey: 'TM-3' };
const taskD = {
  ...base,
  id: 'd',
  title: 'Candidate for linking',
  source: 'ticket',
  ticketKey: 'TM-4',
};
const jiraCard = {
  ...base,
  id: 'jira-1',
  title: 'TM-100 synced card',
  source: 'jira',
  externalSource: 'jira',
  externalKey: 'TM-100',
};

const tasksAB = new Map([
  ['a', taskA],
  ['b', taskB],
]);

// ── Check 1: no links at all renders no "Links" heading ───────────────────────────────────
const noLinksMarkup = renderTaskDetail(taskA, { chainTasksById: new Map([['a', taskA]]) });
check(
  'a card with no ticket links and no chain links has no "Links" heading',
  !noLinksMarkup.includes('>Links<'),
);

// ── Check 2: A blocks B, read from both ends ──────────────────────────────────────────────
const blocksLink = { id: 'link-1', fromTaskId: 'a', toTaskId: 'b', type: 'blocks', createdAt: 0 };

const fromA = renderTaskDetail(taskA, { ticketLinks: [blocksLink], chainTasksById: tasksAB });
check('A\'s markup shows "blocks"', fromA.includes('blocks'));
check(
  "A's markup shows B's key and title",
  fromA.includes('TM-2') && fromA.includes('Fix the invoice total'),
);

const fromB = renderTaskDetail(taskB, { ticketLinks: [blocksLink], chainTasksById: tasksAB });
check('B\'s markup shows "is blocked by"', fromB.includes('is blocked by'));
check("B's markup shows A's key", fromB.includes('TM-1'));

// ── Check 3: a link to an id missing from chainTasksById still renders, with a remove button
const missingLink = {
  id: 'link-2',
  fromTaskId: 'a',
  toTaskId: 'gone',
  type: 'relates',
  createdAt: 0,
};
const missingMarkup = renderTaskDetail(taskA, {
  ticketLinks: [missingLink],
  chainTasksById: new Map([['a', taskA]]),
});
check('a link to a missing id renders that id', missingMarkup.includes('gone'));
check(
  'a link to a missing id still has a remove button',
  missingMarkup.includes('Remove link to gone'),
);

// ── Check 4: a chain-only link shows the pointer text ─────────────────────────────────────
const chainLink = {
  id: 'chain-1',
  fromTaskId: 'c',
  toTaskId: 'a',
  gate: 'after-merge',
  createdAt: 0,
};
const chainOnlyMarkup = renderTaskDetail(taskA, {
  chainLinks: [chainLink],
  chainTasksById: new Map([
    ['a', taskA],
    ['c', taskC],
  ]),
});
check('a chain-only link shows the "see Chain" pointer', chainOnlyMarkup.includes('see Chain'));

// ── Check 5: the Ticket section's own add row, only when the Links section is empty ──────
const candidatesById = new Map([
  ['a', taskA],
  ['d', taskD],
]);

const nativeOpenMarkup = renderTaskDetail(taskA, {
  chainTasksById: candidatesById,
  ticketSectionOpen: true,
});
check(
  'a native ticket with no links, Ticket section open, shows the add row',
  nativeOpenMarkup.includes('Add link'),
);

const jiraOpenMarkup = renderTaskDetail(jiraCard, {
  chainTasksById: new Map([
    ['jira-1', jiraCard],
    ['d', { ...taskD, projectId: jiraCard.projectId }],
  ]),
  ticketSectionOpen: true,
});
check('a JIRA card with no links does not show the add row', !jiraOpenMarkup.includes('Add link'));

rmSync(work, { recursive: true, force: true });

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
