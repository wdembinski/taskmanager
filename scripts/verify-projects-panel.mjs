/**
 * Headless proof of F12.8: Projects (Backlog, Timeline, Graph) now opens a ticket in the
 * same `TaskDetail` pane every other board uses, via `TaskDetailHost`
 * (`packages/ui/src/TaskDetailHostView.tsx`) — not its own `TicketDrawer`, which is gone.
 * Modelled on `verify-ticket-section.mjs`: `renderToStaticMarkup` through the real component
 * tree, minus the DOM and the IPC round trip. This workspace has no DOM test harness, and
 * the *verify-electron-app* memory says never launch the real app to check something.
 *
 *     node scripts/verify-projects-panel.mjs
 *
 * ## `--format=cjs`, esbuild lookup, the `.verify-projects-panel/` work dir
 *
 * Same three reasons as `verify-ticket-section.mjs`'s own header: `@fluentui/react-icons` has
 * no `"node"` export condition (breaks `--format=esm` under Node's resolver), bundling
 * `@griffel/react`'s `require('react')` as real ESM output throws `Dynamic require of
 * "react" is not supported`, and esbuild's bare-specifier resolution walks up from the entry
 * file's own directory — so the work dir sits under `packages/ui/` to find
 * `packages/ui/node_modules/{react,react-dom,@fluentui}` the same way a file under
 * `packages/ui/src` would. `@tm/shared/*` is aliased straight to `packages/shared/src`, so
 * this never depends on `packages/shared/dist` being freshly built. `.verify-projects-panel/`
 * is gitignored by the repo's unanchored `.verify-*` directory pattern.
 *
 * ## What it proves
 *
 * 1. `TaskDetailHost` — given a native ticket and a `chainTasksById` holding a second ticket
 *    in the same project, exactly as `Projects.tsx` passes it (`task`, `subtasks: []`,
 *    `chainTasksById`, `ticketFold: { key: 'tm.projects.ticketOpen', defaultOpen: true }`) —
 *    renders the "Ticket" heading, every `TicketFieldsSection` field label for the ten
 *    `TicketDraft` keys in `ticketFields.ts` (Type, Epic, Milestone, Labels, Story points,
 *    Estimate, Start, Due, Assignee, Reporter), the Links section's "Add link" row (offered
 *    because this ticket has no ticket links and no chain links yet — `TaskDetail`'s own
 *    `addLink` fallback), and the conversation region's `aria-label="Conversation"` — the
 *    whole pane Projects now mounts, not just the Ticket section.
 * 2. The fold opens WITHOUT seeding `localStorage` — `defaultOpen: true` on Projects' own key
 *    (`tm.projects.ticketOpen`) is enough on a device that has never touched it, unlike the
 *    board's `ticketFold` (`tm.taskDetail.ticketOpen`, `defaultOpen: false`), which keeps the
 *    section shut by default. Same ticket, same lack of seeding, two different hosts' keys —
 *    so the difference in the markup is the `fold` prop alone, not anything about the data.
 * 3. Static check: no file under `apps/`, `packages/`, or `test/` imports `TicketDrawer`
 *    (deleted in F12.8's implementation commit), and `BacklogTable.tsx`, `TimelinePane.tsx`
 *    and `GraphPane.tsx` each still reference `onSelectTicket` — the prop `Projects.tsx` wires
 *    to the shared pane instead of a per-pane drawer.
 *
 * Prove the fold check matters yourself: in the call below, change Projects' own
 * `ticketFold: { key: 'tm.projects.ticketOpen', defaultOpen: true }` to `defaultOpen: false`.
 * Every field-label check for that render goes red, because the section now starts folded
 * shut exactly like the board's — rerun this script to see it, then revert. Verified while
 * writing this script (all ten field-label checks and the "Add link" check went red, the
 * "Ticket" heading and conversation-region checks stayed green since neither depends on the
 * fold), then reverted; `git diff` showed this file byte-identical afterwards.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const uiRoot = join(root, 'packages', 'ui');
const work = join(uiRoot, '.verify-projects-panel');
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
import type { Task } from '@tm/shared/model';
import { TransportProvider, type Transport } from '../src/transport';
import { TaskDetailHost, type TaskDetailHostProps } from '../src/TaskDetailHostView';

const stub: Transport = {
  invoke: (async () => []) as unknown as Transport['invoke'],
  on: () => () => {},
  pathForFile: () => '',
};

export interface RenderOpts {
  chainTasksById?: ReadonlyMap<string, Task>;
  ticketFold?: TaskDetailHostProps['ticketFold'];
}

// localStorage does not exist under plain Node; useDeviceFold already wraps its read in a
// try/catch for exactly that reason, so a fresh Map here (never seeded) is what proves a
// fold's DEFAULT, as opposed to one some earlier render happened to open.
export function renderProjectsPanel(task: Task, opts: RenderOpts = {}): string {
  const store = new Map<string, string>();
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
        React.createElement(TaskDetailHost, {
          taskId: task.id,
          task,
          subtasks: [],
          chainTasksById: opts.chainTasksById ?? new Map([[task.id, task]]),
          ticketFold: opts.ticketFold,
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
const { renderProjectsPanel } = require(harnessOut);

// ── A native ticket, and a second ticket in the same project — the Links "Add link" row
// only offers a candidate list once there is someone other than the ticket itself to link
// to; `chainTasksById` is what `TaskDetail`'s `projectTickets` (its epic/link candidates)
// is narrowed from. ───────────────────────────────────────────────────────────────────────
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
  storyPoints: 3,
};

const otherTicket = {
  ...base,
  id: 'task-other',
  title: 'Wire up the export settings',
  source: 'ticket',
  issueType: 'task',
};

const chainTasksById = new Map([
  [nativeTicket.id, nativeTicket],
  [otherTicket.id, otherTicket],
]);

// The ten `TicketFieldsSection` field labels, one per `TicketDraft` key in `ticketFields.ts`.
const FIELD_LABELS = [
  'Type',
  'Epic',
  'Milestone',
  'Labels',
  'Story points',
  'Estimate (days)',
  'Start',
  'Due',
  'Assignee',
  'Reporter',
];

// ── Check 1: Projects' own host — ticketFold defaultOpen:true, key never seeded ───────────
const projectsMarkup = renderProjectsPanel(nativeTicket, {
  chainTasksById,
  ticketFold: { key: 'tm.projects.ticketOpen', defaultOpen: true },
});

check('Projects host renders the "Ticket" heading', projectsMarkup.includes('>Ticket<'));
for (const label of FIELD_LABELS) {
  check(
    `Projects host (default-open, unseeded) renders the "${label}" field label`,
    projectsMarkup.includes(`>${label}<`),
  );
}
check(
  'Projects host renders the Links section’s "Add link" row',
  projectsMarkup.includes('Add link'),
);
check(
  'Projects host renders the conversation region’s aria-label',
  projectsMarkup.includes('aria-label="Conversation"'),
);

// ── Check 2: the board's own fold key, same ticket, same lack of seeding — stays shut ─────
const boardMarkup = renderProjectsPanel(nativeTicket, { chainTasksById });

check('the board host still renders the "Ticket" heading', boardMarkup.includes('>Ticket<'));
for (const label of FIELD_LABELS) {
  check(
    `the board host's default-closed fold hides the "${label}" field label`,
    !boardMarkup.includes(`>${label}<`),
  );
}
check(
  "the board host's default-closed fold hides the Add link row",
  !boardMarkup.includes('Add link'),
);

// ── Check 3: no TicketDrawer import survives under apps/, packages/ or test/; the three
// panes still carry `onSelectTicket` — the prop Projects wires to the shared pane. ─────────
function listFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full));
    else if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(entry.name)) out.push(full);
  }
  return out;
}

const scannedDirs = ['apps', 'packages', 'test'].map((d) => join(root, d)).filter((d) => {
  try {
    readdirSync(d);
    return true;
  } catch {
    return false;
  }
});

const ticketDrawerImporters = scannedDirs
  .flatMap((d) => listFiles(d))
  .filter((f) => readFileSync(f, 'utf8').includes('TicketDrawer'));

check(
  'no file under apps/, packages/ or test/ imports TicketDrawer',
  ticketDrawerImporters.length === 0,
);
if (ticketDrawerImporters.length > 0) {
  for (const f of ticketDrawerImporters) console.log(`  still references TicketDrawer: ${f}`);
}

for (const pane of ['BacklogTable.tsx', 'TimelinePane.tsx', 'GraphPane.tsx']) {
  const src = readFileSync(join(uiRoot, 'src', 'projects', pane), 'utf8');
  check(`${pane} still references onSelectTicket`, src.includes('onSelectTicket'));
}

rmSync(work, { recursive: true, force: true });

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
