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
 * 1. A card with no ticket links and no chain links still renders the "Links" heading, with
 *    the "No linked tickets." empty state under it.
 * 2. An order arrow A → B: A's markup lists B (key and title) under "Blocks"; B's markup
 *    lists A's key under "Blocked by", with its "not merged" state. A leftover `blocks`
 *    TICKET link between them is not listed at all — the arrows are the dependencies.
 * 3. A link to an id absent from `chainTasksById` still renders that id, plus a remove
 *    button addressed to it — the link stays removable even though the other ticket is gone.
 * 4. A card with only an incoming arrow (no ticket links) lists it under "Blocked by" as a
 *    dependency row — there is no "see Chain" pointer any more.
 * 5. Every non-step card, native ticket or JIRA card alike, shows the add row ("Add link") in
 *    its Links section, even with no links at all.
 *
 * Prove the checks matter yourself: in `packages/ui/src/projects/linkedTickets.ts`, drop the
 * `link.type !== 'blocks'` filter. Check 2's "leftover blocks ticket link" line goes red.
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

// ── Check 1: no links at all still renders the heading and the empty state ─────────────────
const noLinksMarkup = renderTaskDetail(taskA, { chainTasksById: new Map([['a', taskA]]) });
check(
  'a card with no ticket links and no chain links still has the "Links" heading',
  noLinksMarkup.includes('>Links<') && noLinksMarkup.includes('No linked tickets.'),
);

// ── Check 2: an arrow A → B, read from both ends ──────────────────────────────────────────
const arrowAB = {
  id: 'arrow-1',
  fromTaskId: 'a',
  toTaskId: 'b',
  gate: 'after-merge',
  createdAt: 0,
};
const staleBlocks = { id: 'link-1', fromTaskId: 'a', toTaskId: 'b', type: 'blocks', createdAt: 0 };

const fromA = renderTaskDetail(taskA, {
  chainLinks: [arrowAB],
  ticketLinks: [staleBlocks],
  chainTasksById: tasksAB,
});
check("A's markup shows a 'Blocks' group", fromA.includes('data-links-blocks'));
check(
  "A's markup shows B's key and title",
  fromA.includes('TM-2') && fromA.includes('Fix the invoice total'),
);
check('a leftover blocks ticket link is not listed', !fromA.includes('Remove link to TM-2'));

const fromB = renderTaskDetail(taskB, { chainLinks: [arrowAB], chainTasksById: tasksAB });
check(
  "B's markup shows 'Blocked by'",
  fromB.includes('data-links-blocked-by') && fromB.includes('Blocked by'),
);
check("B's markup shows A's key", fromB.includes('TM-1'));
check("B's markup says A has not merged", fromB.includes('not merged'));

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

// ── Check 4: an arrow-only card lists it as a dependency row, with no pointer ────────────
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
check(
  'an arrow-only card lists it under "Blocked by"',
  chainOnlyMarkup.includes('data-dependency-row="chain-1"') &&
    chainOnlyMarkup.includes('Remove dependency on TM-3'),
);
check('there is no "see Chain" pointer any more', !chainOnlyMarkup.includes('see Chain'));

// ── Check 5: every non-step card gets the add row in its Links section ─────────────────────
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
check('a JIRA card with no links shows the add row too', jiraOpenMarkup.includes('Add link'));

rmSync(work, { recursive: true, force: true });

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
