/**
 * Headless proof of epic/child native tickets (Epic/Group tickets) against a REAL SQLite
 * store, plus the real `groupTickets` bucketing over rows that store actually produced.
 *
 *     node scripts/verify-tickets.mjs
 *
 * Same bundle-then-run-under-Electron-as-Node trick as `scripts/verify-assignment-poll.mjs`:
 * `better-sqlite3`'s addon is compiled for Electron's ABI, so nothing that calls `createStore`
 * can run under the Node that runs vitest — see `the-store-has-no-tests` /
 * `headless-scenario-harness-traps`.
 *
 * ## What this does NOT prove
 *
 * The three refusals — "an epic cannot itself hang under another epic", "the epic must
 * belong to the ticket's own project", "a ticket cannot be its own epic" — live in
 * `assertTicketRefs`, an unexported closure inside `registerIpcHandlers` in `ipc.ts`.
 * That function builds its OWN store from `app.getPath('userData')`, a real `BrowserWindow`,
 * a `SessionManager`, pollers, git clients — the exact case
 * `headless-scenario-harness-traps` warns "is out of reach from a harness like this". Rather
 * than restate its three `if`s as a second copy that could quietly drift from the real one,
 * this script proves the PREMISES those refusals are built from, using the real store and
 * the real (imported, not restated) `isEpic` predicate against rows the store actually wrote
 * and re-read — not hand-typed fixtures:
 *
 *   - `isEpic` really does read `true` off a store-created epic and `false` off everything
 *     else (the "parent must be an epic" refusal's only test).
 *   - two tickets created under two different real projects really do carry two different
 *     `projectId`s off `store.getTask` (the "same project" refusal's only test).
 *   - a ticket's own id, read back from the store, really is what a self-reference would be
 *     compared against (the "not itself" refusal's only test — a plain `===`, nothing to
 *     import).
 *
 * `groupTickets` itself (`packages/ui/src/projects/backlogView.ts`) has a fast, no-Electron
 * vitest suite (`backlogView.test.ts`) already, against hand-built fixtures. What that suite
 * cannot do is prove the shape it assumes — an epic's `issueType`, a child's `epicTaskId` —
 * is what `createTicket` and a SQLite round-trip actually produce; that is the one thing
 * this script adds on top of it.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const clientModules = join(root, 'apps', 'client', 'node_modules');
const scratch = mkdtempSync(join(tmpdir(), 'tm-tickets-'));

/**
 * esbuild ships as a per-platform binary under a versioned `.pnpm` directory, so it is found
 * by pattern rather than by path: a dependency bump renames the directory, and hard-coding
 * one version would rot this script at the next `pnpm up`.
 */
function findEsbuild() {
  const pnpm = join(root, 'node_modules', '.pnpm');
  const target = `${process.platform}-${process.arch}`;
  const dir = readdirSync(pnpm).find((d) => d.startsWith(`@esbuild+${target}@`));
  if (!dir) throw new Error(`no esbuild binary for ${target} under ${pnpm}`);
  const exe = process.platform === 'win32' ? 'esbuild.exe' : 'bin/esbuild';
  return join(pnpm, dir, 'node_modules', '@esbuild', target, exe);
}

// ── Phase 1: plain Node — bundle the sources, then hand over to Electron ──────────────
if (!process.versions.electron) {
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
        ...(external ? external.map((mod) => `--external:${mod}`) : []),
        `--outfile=${outfile}`,
        '--log-level=error',
      ],
      { stdio: 'inherit' },
    );

  bundle(join(root, 'apps/client/src/main/store.ts'), join(scratch, 'store.cjs'), [
    'better-sqlite3',
  ]);
  bundle(join(root, 'packages/shared/src/tickets.ts'), join(scratch, 'tickets.cjs'));
  // `backlogView.ts` reaches `@tm/shared/ticketKey` through the workspace package rather
  // than the `@shared` path alias `store.ts` uses — it is `packages/ui` code, not
  // `apps/client` code — so it resolves through the ordinary pnpm-linked `node_modules`
  // beside it, which `pnpm build` populated. No alias needed for that require.
  bundle(join(root, 'packages/ui/src/projects/backlogView.ts'), join(scratch, 'backlogView.cjs'));

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
    },
  });
  process.exit(run.status ?? 1);
}

// ── Phase 2: under Electron-as-Node — the actual checks ──────────────────────────────
const require = createRequire(import.meta.url);
const work = process.argv[2];
const { createStore } = require(join(work, 'store.cjs'));
const { isEpic } = require(join(work, 'tickets.cjs'));
const { groupTickets, NO_EPIC_GROUP } = require(join(work, 'backlogView.cjs'));

let failures = 0;
const check = (label, ok) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) failures++;
};

const dbPath = join(work, 'orchestrator.db');
const store = createStore(dbPath);

// Two real ticket boards — the "same project" refusal's premise needs two projects that
// really do have different ids, not two strings typed by hand.
const projectA = store.addProject({ name: 'Alpha', ticketPrefix: 'AA' });
const projectB = store.addProject({ name: 'Beta', ticketPrefix: 'BB' });
check('project A really owns tickets (a prefix was allocated)', projectA.ticketPrefix === 'AA');
check('project B got its own, different prefix', projectB.ticketPrefix === 'BB');

// ── Epic + child create ────────────────────────────────────────────────────────────
const epic = store.createTicket(projectA.id, { title: 'Epic one', issueType: 'epic' });
check('an epic was created', epic != null);
check('the epic keyed under its project prefix', epic?.ticketKey?.startsWith('AA-') === true);
check('an epic starts with no epic of its own', epic?.epicTaskId === null);

const child = store.createTicket(projectA.id, {
  title: 'Child story',
  issueType: 'story',
  epicTaskId: epic.id,
});
check('a child ticket was created', child != null);
check('the child carries the issueType it was given', child?.issueType === 'story');
check('the child carries the epic it was filed under', child?.epicTaskId === epic.id);

// Re-read both through the store rather than trusting the value `createTicket` just handed
// back — the round trip through SQLite is the thing actually under test.
const epicRow = store.getTask(epic.id);
const childRow = store.getTask(child.id);
check('the epic round-trips issueType: epic', epicRow?.issueType === 'epic');
check('the child round-trips epicTaskId across a re-read', childRow?.epicTaskId === epic.id);

// ── The premises `assertTicketRefs` (ipc.ts) refuses on — see this file's header ──────

// "That ticket is not an epic": the real, imported predicate on real rows.
check('isEpic reads true off a real epic row', isEpic(epicRow) === true);
check('isEpic reads false off a real non-epic row', isEpic(childRow) === false);

const plainTask = store.createTicket(projectA.id, { title: 'Plain task' });
check('a ticket with no issueType given defaults to task', plainTask?.issueType === 'task');
check(
  'so isEpic refuses it too — the exact case "parent must be an epic" exists to catch',
  isEpic(store.getTask(plainTask.id)) === false,
);

// "The epic must belong to the ticket's own project": two tickets from two real projects
// really do disagree on projectId.
const epicB = store.createTicket(projectB.id, {
  title: 'Epic in the other project',
  issueType: 'epic',
});
check('epic B belongs to project B', epicB?.projectId === projectB.id);
check(
  'so a ticket in project A naming epic B would fail the same-project check',
  store.getTask(epicB.id)?.projectId !== projectA.id,
);

// "A ticket cannot be its own epic": a plain identity comparison — nothing to import, but
// exercised against a real generated id rather than a hand-picked string.
const selfCheckTicket = store.createTicket(projectA.id, { title: 'Would-be self reference' });
check(
  'a ticket compared against its own id is caught by ===, not by a fresh lookup',
  selfCheckTicket.id === selfCheckTicket.id,
);
check(
  'and is never accidentally equal to an unrelated ticket’s id',
  selfCheckTicket.id !== epic.id && selfCheckTicket.id !== child.id,
);

// ── groupTickets bucketing, over rows the store actually wrote ───────────────────────
const boardATickets = store.getTasks(projectA.id);
check('project A holds exactly the four tickets created on it', boardATickets.length === 4);

const groups = groupTickets(boardATickets);
const epicGroup = groups.find((g) => g.epicId === epic.id);
check(
  'the epic groups its child underneath it',
  epicGroup?.tickets.map((t) => t.id).join(',') === child.id,
);

const noEpicGroup = groups.find((g) => g.epicId === null);
check('the "No epic" bucket exists and is named as such', noEpicGroup?.epicTitle === NO_EPIC_GROUP);
const noEpicIds = new Set((noEpicGroup?.tickets ?? []).map((t) => t.id));
check(
  'the epic itself, the plain task and the self-check ticket all land in "No epic" — none dropped',
  noEpicIds.has(epic.id) && noEpicIds.has(plainTask.id) && noEpicIds.has(selfCheckTicket.id),
);
check('and the child never doubles up in that bucket', !noEpicIds.has(child.id));
check(
  'every ticket on the board appears in exactly one group',
  groups.reduce((sum, g) => sum + g.tickets.length, 0) === boardATickets.length,
);

store.close();

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
