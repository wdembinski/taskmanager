/**
 * Headless end-to-end proof of F5.9: `handOffSteps`/`executeHandOffSteps` — the pure
 * module the previous step added — actually DRIVES a real import, a real assign, and a
 * real agent run starting, rather than the fake `invoke` `handOffSteps.test.ts` uses.
 *
 *     node scripts/verify-hand-off.mjs
 *
 * Same bundle-then-run-under-Electron-as-Node trick as `scripts/verify-tickets.mjs`:
 * `better-sqlite3`'s addon is compiled for Electron's ABI, so nothing that calls
 * `createStore` can run under the Node that runs vitest. Layered on top of that is the
 * stub-`claude`-on-PATH technique (memory: `stub-claude-on-path`): a `claude.cmd` placed
 * in a directory prepended to PATH stands in for the real CLI, so `SessionManager` /
 * `claudeSession.ts` really spawn a process and really parse its NDJSON stream — nothing
 * about that half of the path is faked either.
 *
 * What's real: `handOffSteps` / `executeHandOffSteps` / `handOffMessage` (this ticket's
 * own code, unmodified), `importIssue` (real, pure, injected deps — the exact function
 * `ipc.ts`'s `issues:import` handler calls), `store.upsertJiraTask` / `store.getTask` /
 * `store.updateTask` / `store.pinImport` (real SQLite), `SessionManager` and everything
 * under it down to the real child-process spawn and its real stdout parsing.
 *
 * What's faked: the tracker fetch itself (`fetchCard` returns a hand-built card instead
 * of actually calling Jira — `verify-assignment-poll.mjs`'s docstring makes the same call
 * about its own fetch) and the body of the 'task:assignAgent' IPC handler. That handler
 * (`assignAgentToTask` / `writeMoveToForge` / the scheduler's concurrency, retries, forge
 * sync) is a closure inside `registerIpcHandlers` in `ipc.ts`, out of reach from a harness
 * like this one — the same situation `verify-tickets.mjs`'s header describes for
 * `assertTicketRefs`. Restating that closure here would be a second copy that could
 * quietly drift from the real one; what this script proves instead is the one new
 * contract — `executeHandOffSteps`'s import-then-assign call order — against a real store
 * row and a real agent run that really starts, carrying forward only the one fact that
 * closure writes synchronously before a session's first event ever arrives
 * (`status: 'running'`, see `ipc.ts` around `startTaskNow`'s re-read).
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const clientModules = join(root, 'apps', 'client', 'node_modules');
const scratch = mkdtempSync(join(tmpdir(), 'tm-hand-off-'));

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

// ── Phase 1: plain Node — bundle the sources, lay down the stub CLI, hand over ───────
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
    join(root, 'apps/client/src/main/issues/importIssue.ts'),
    join(scratch, 'importIssue.cjs'),
  );
  // `sessionManager.ts` pulls in `claudeSession.ts` (the real spawn + NDJSON parser),
  // `exec/index.ts` (the real `LocalExecHost`), `eventNoise.ts`, `limitGate.ts`,
  // `headlessContract.ts` and `permissionServerSource.ts` — none of them touch Electron
  // or better-sqlite3, so this bundles and runs as plain Node.
  bundle(join(root, 'apps/client/src/main/sessionManager.ts'), join(scratch, 'sessionManager.cjs'));
  // `packages/ui` code, not `apps/client` code — resolves `@tm/shared/*` through the
  // ordinary pnpm-linked `node_modules` beside it (built `dist`), same as
  // `verify-tickets.mjs`'s `backlogView.cjs`. No alias needed for that require.
  bundle(join(root, 'packages/ui/src/issues/handOffSteps.ts'), join(scratch, 'handOffSteps.cjs'));

  // The stub CLI: a `.cmd` shim (so Windows' shell lookup for a bare `claude` finds it,
  // the way a terminal would) plus the Node script it runs. Emits the two load-bearing
  // NDJSON lines a real `claude -p --output-format stream-json` run would — `system/init`
  // (the session id `SessionManager` surfaces) and `result` (what `runFromAssign` reads
  // `task.status` for having happened at all means this round trip is real, not mocked).
  const binDir = join(scratch, 'bin');
  mkdirSync(binDir, { recursive: true });
  writeFileSync(join(binDir, 'claude.cmd'), '@echo off\r\nnode "%~dp0claude-stub.cjs" %*\r\n');
  writeFileSync(
    join(binDir, 'claude-stub.cjs'),
    [
      "const args = process.argv.slice(2);",
      "const at = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };",
      "const sessionId = at('--session-id') ?? at('--resume') ?? 'stub-session';",
      "const model = at('--model') ?? 'stub';",
      "process.stdout.write(JSON.stringify({",
      "  type: 'system', subtype: 'init', session_id: sessionId, model,",
      "  cwd: process.cwd(), permissionMode: 'acceptEdits',",
      "}) + '\\n');",
      "setTimeout(() => {",
      "  process.stdout.write(JSON.stringify({",
      "    type: 'result', subtype: 'success', is_error: false,",
      "    result: 'stub run complete', total_cost_usd: 0,",
      "  }) + '\\n');",
      "}, 300);",
      "// Stay alive — a managed session (stdin kept open) never self-exits after a",
      "// result; the caller terminates the process tree once it has what it needs.",
      "process.stdin.resume();",
      "",
    ].join('\n'),
  );

  const repoDir = join(scratch, 'repo');
  mkdirSync(repoDir, { recursive: true });

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

// ── Phase 2: under Electron-as-Node — the actual end-to-end proof ───────────────────
const require = createRequire(import.meta.url);
const { randomUUID } = require('node:crypto');
const work = process.argv[2];
const { createStore } = require(join(work, 'store.cjs'));
const { importIssue } = require(join(work, 'importIssue.cjs'));
const { SessionManager } = require(join(work, 'sessionManager.cjs'));
const { handOffSteps, executeHandOffSteps, handOffMessage } = require(join(work, 'handOffSteps.cjs'));

let failures = 0;
const check = (label, ok) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) failures++;
};

async function main() {
  const dbPath = join(work, 'orchestrator.db');
  const store = createStore(dbPath);
  const repoDir = join(work, 'repo');

  const project = store.addProject({ name: 'Repo', path: repoDir });
  check('the agent project was created', project != null);

  // The issue the panel is handing off — not yet on the board, so `handOffSteps` must
  // emit an import step ahead of the assign step.
  const issue = { provider: 'jira', key: 'TM-999', onBoardTaskId: null };
  const request = {
    action: 'hand',
    assign: { agentProjectId: project.id, model: null, mode: null },
    prompt: 'Fix the thing TM-999 describes.',
  };

  const steps = handOffSteps(issue, request);
  check(
    'handOffSteps emits import then assign for a new issue',
    JSON.stringify(steps.map((s) => s.kind)) === JSON.stringify(['import', 'assign']),
  );

  let sawSessionStart = false;
  let sawSessionResult = false;

  const invoke = async (channel, ...args) => {
    if (channel === 'issues:import') {
      const [provider, key] = args;
      return importIssue(provider, key, {
        findCard: () => undefined,
        fetchCard: async () => ({
          id: randomUUID(),
          projectId: project.id,
          phase: '',
          title: 'Fix the thing',
          status: 'running',
          sessionId: null,
          order: 0,
          source: 'jira',
          dependsOn: [],
          isContract: false,
          isScaffold: false,
          externalSource: provider,
          externalKey: key,
        }),
        insert: (task) => store.upsertJiraTask(task),
        unarchive: (id) => store.unarchiveTask(id),
        pin: (id) => {
          const pinned = store.pinImport(id);
          if (!pinned) throw new Error('That card is no longer there.');
          return pinned;
        },
      });
    }

    if (channel === 'task:assignAgent') {
      const [taskId, input] = args;
      const existing = store.getTask(taskId);
      if (!existing) throw new Error('Task not found.');

      // The one real-world fact `ipc.ts`'s own handler writes synchronously, before the
      // session's first event ever arrives — see this file's header.
      store.updateTask(taskId, {
        agentProjectId: input.agentProjectId,
        agentMode: input.mode ?? null,
        agentModel: input.model ?? null,
        sessionId: null,
        status: 'running',
      });

      const sessionManager = new SessionManager(() => {});
      let runId;
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('stub CLI never started')), 15000);
        ({ runId } = sessionManager.start(
          {
            prompt: input.notes ?? 'Do the ticket.',
            cwd: repoDir,
            model: 'sonnet',
            permissionMode: 'acceptEdits',
          },
          {
            onEvent: (event) => {
              if (event.kind === 'started') {
                sawSessionStart = true;
                clearTimeout(timer);
                store.updateTask(taskId, { sessionId: event.sessionId });
                resolve();
              }
              if (event.kind === 'result') sawSessionResult = true;
              if (event.kind === 'stderr') console.error('stub CLI stderr:', event.text);
            },
          },
        ));
      });

      // Wait for the stub's `result` line too — not just `started` — so this proves the
      // whole NDJSON round trip, not only its first line.
      await new Promise((resolve) => {
        const poll = setInterval(() => {
          if (sawSessionResult) {
            clearInterval(poll);
            resolve();
          }
        }, 25);
      });
      sessionManager.stop(runId);

      return store.getTask(taskId);
    }

    throw new Error(`unexpected channel ${channel}`);
  };

  const result = await executeHandOffSteps(steps, issue, invoke);

  check('executeHandOffSteps reports a real import', result.imported === true);
  const stored = store.getTask(result.taskId);
  check('the imported row is really in the store', stored != null);
  check('the imported row is pinned (issues:import always pins)', stored?.pinnedImport === true);
  check('the imported row carries the tracker key', stored?.externalKey === 'TM-999');
  check('a real agent session really started', sawSessionStart === true);
  check('the stub CLI really produced a result over the real NDJSON parser', sawSessionResult === true);
  check(
    'the task carries the real session id the stub CLI reported',
    typeof stored?.sessionId === 'string' && stored.sessionId.length > 0,
  );
  check('executeHandOffSteps reads the run as started', result.run === 'started');

  const message = handOffMessage(result, request);
  check('handOffMessage reports success', message.tone === 'success');
  check(
    '…naming that the agent actually started',
    message.text === 'Handed to the agent — the run has started.',
  );

  store.close();
  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
