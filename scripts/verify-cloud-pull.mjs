/**
 * Headless proof of the cloud board PULL path ("teach desktop to pull cloud-authored
 * projects and tickets"): a ticket the server's own CRUD created — never relayed as a
 * command, never written locally first — lands in local SQLite after one simulated
 * `GET /v1/board` poll cycle, its owning project's ticket allocator catches up so a
 * ticket minted locally afterwards can't reissue a cloud-issued key, and a row this
 * desktop edited but has not yet pushed survives a stale pull that predates the edit.
 *
 *     node scripts/verify-cloud-pull.mjs
 *
 * Same reason this is a script and not a `.test.ts`, and the same bundle-then-run-under-
 * Electron-as-Node trick — see `scripts/verify-resume-migration.mjs`, the worked example
 * this follows: `better-sqlite3`'s addon is compiled for Electron's ABI, so nothing that
 * calls `createStore` can run under the Node that runs vitest. The pure dispatch logic
 * already has a fast, fake-store vitest suite (`cloudBoardApply.test.ts`); this is the one
 * proof that the real SQL behind `upsertCloudProject`/`upsertCloudTask`/
 * `hasPendingCloudPush` does what that suite assumes.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const clientModules = join(root, 'apps', 'client', 'node_modules');
const scratch = mkdtempSync(join(tmpdir(), 'tm-cloud-pull-'));

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
  // Both files import nothing from Electron (only node:*, better-sqlite3, @shared/* and
  // type-only `@protocol/*`, which esbuild elides), which is what lets them run standalone.
  const bundle = (entry, outfile, external) =>
    spawnSync(
      esbuild,
      [
        entry,
        '--bundle',
        '--platform=node',
        '--format=cjs',
        `--alias:@shared=${join(root, 'packages', 'shared', 'src')}`,
        ...(external ? [`--external:${external}`] : []),
        `--outfile=${outfile}`,
        '--log-level=error',
      ],
      { stdio: 'inherit' },
    );

  bundle(join(root, 'apps/client/src/main/store.ts'), join(scratch, 'store.cjs'), 'better-sqlite3');
  bundle(
    join(root, 'apps/client/src/main/cloudBoardApply.ts'),
    join(scratch, 'cloudBoardApply.cjs'),
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
    },
  });
  process.exit(run.status ?? 1);
}

// ── Phase 2: under Electron-as-Node — the actual checks ──────────────────────────────
const require = createRequire(import.meta.url);
const work = process.argv[2];
const { createStore } = require(join(work, 'store.cjs'));
const { applyCloudBoardDelta } = require(join(work, 'cloudBoardApply.cjs'));

let failures = 0;
const check = (label, ok) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) failures++;
};

const dbPath = join(work, 'orchestrator.db');
const store = createStore(dbPath);

// ── A ticket project + one of its tickets, exactly as the server's TicketsService would
// shape them (apps/server/src/tickets/tickets.service.ts) — this desktop has never seen
// either row, and neither was ever relayed here as a command.
const cloudProject = {
  id: 'cloud-project-1',
  name: 'Cloud project',
  path: '',
  planPath: '',
  defaultModel: 'sonnet',
  planningModel: null,
  defaultPermissionMode: 'acceptEdits',
  concurrency: 1,
  useWorktrees: false,
  baseBranch: '',
  writeBackPlan: false,
  autoRelease: false,
  autoIntegrate: null,
  planAligned: true,
  kind: 'ticket',
  jiraEpicKeys: [],
  ticketPrefix: 'TM',
  target: { kind: 'local' },
  instructions: '',
  color: '',
  createdAt: 1000,
};
const cloudTicket = {
  id: 'cloud-ticket-1',
  projectId: 'cloud-project-1',
  phase: '',
  title: 'Filed straight through the web',
  status: 'pending',
  sessionId: null,
  order: 0,
  source: 'ticket',
  dependsOn: [],
  isContract: false,
  isScaffold: false,
  externalDescription: null,
  externalPriority: null,
  ticketKey: 'TM-1',
  ticketNumber: 1,
  issueType: 'task',
  epicTaskId: null,
  milestoneId: null,
  labels: [],
  storyPoints: null,
  estimateDays: null,
  startAt: null,
  dueAt: null,
  assigneeId: null,
  reporterId: null,
};

const firstPoll = applyCloudBoardDelta(store, {
  tasks: [cloudTicket],
  projects: [cloudProject],
  deletedTaskIds: [],
  deletedProjectIds: [],
});
check('the cloud project applied', firstPoll.appliedProjectIds.includes('cloud-project-1'));
check('the cloud ticket applied', firstPoll.appliedTaskIds.includes('cloud-ticket-1'));

const pulledProject = store.getProject('cloud-project-1');
check('the project reads back with the cloud data', pulledProject?.name === 'Cloud project');
const pulledTask = store.getTask('cloud-ticket-1');
check(
  'the ticket reads back with the cloud data',
  pulledTask?.title === 'Filed straight through the web',
);
check('and its ticket key round-tripped', pulledTask?.ticketKey === 'TM-1');

// Minting a ticket LOCALLY on the pulled-down project must not reissue TM-1: `ticketSeq`
// never travels on the wire, so this only works if `upsertCloudTask` caught the allocator
// up to the incoming ticketNumber.
const mintedLocally = store.createTicket('cloud-project-1', {
  title: 'Filed locally, after the pull',
});
check(
  "a locally-minted ticket does not reissue the cloud one's key",
  mintedLocally?.ticketKey === 'TM-2',
);
check('and gets the next number, not a reused one', mintedLocally?.ticketNumber === 2);

// ── A stale pull must not clobber a local edit still sitting unsent in the outbox.
const local = store.createTicket('cloud-project-1', { title: 'original title' });
const staleCopy = { ...local, title: 'STALE — predates the local edit' };

// The local edit: renames the ticket, which the trigger-backed outbox now has an
// un-pruned row for (nothing has "synced" in this script — there is no server here).
store.updateTask(local.id, { title: 'renamed locally, not yet pushed' });
check(
  'the outbox now shows a pending push for the local edit',
  store.hasPendingCloudPush('task', local.id),
);

applyCloudBoardDelta(store, {
  tasks: [staleCopy],
  projects: [],
  deletedTaskIds: [],
  deletedProjectIds: [],
});
const afterStalePull = store.getTask(local.id);
check(
  'the local edit survives a stale cloud pull racing it',
  afterStalePull?.title === 'renamed locally, not yet pushed',
);

// Once the outbox is pruned (this desktop's own `/v1/sync` push landed, in the real
// pipeline), the same id is no longer "pending" — a later pull with fresher data than what
// this desktop last pushed must be free to update the row.
store.pruneCloudOutbox(999_999);
check('pruning clears the pending flag', !store.hasPendingCloudPush('task', local.id));
applyCloudBoardDelta(store, {
  tasks: [{ ...afterStalePull, title: 'edited on a second desktop' }],
  projects: [],
  deletedTaskIds: [],
  deletedProjectIds: [],
});
check(
  'a pull with nothing pending updates the existing row',
  store.getTask(local.id)?.title === 'edited on a second desktop',
);

store.close();

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
