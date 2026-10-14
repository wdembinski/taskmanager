/**
 * Headless verification for F7.6 — does a run's resolved skills actually reach the CLI, not
 * just the `skillsSection` string `scheduler.test.ts` asserts a mock `SessionManager.start`
 * was called with?
 *
 * `runSkills.test.ts` proves `runSkillRefs`/`resolveRunSkills`/`skillsTimelineNote` are
 * correct against hand-built maps standing in for the store and the worktree.
 * `scheduler.test.ts`'s "skills in force" suite proves `launch` builds the right
 * `skillsSection` and files the right note, against a fake `SessionManager` that never
 * touches a real file. Neither can answer what a human actually cares about: **does the
 * `--append-system-prompt-file` the CLI is handed really contain the skill a card carries,
 * read from a REAL repo skill file on disk, in the right order, with a dangling ref noted on
 * the REAL activity timeline and nothing added for a run that should skip it?** That answer
 * only exists at the far end of `claudeSession.ts`'s `writeContractFile`, which this drives
 * by running the real engine end to end:
 *
 *  - a real SQLite store (`better-sqlite3`, which only loads under Electron's ABI — the
 *    reason this lives here rather than in the vitest suite, memory `the-store-has-no-tests`),
 *  - the real `Scheduler` and `SessionManager`,
 *  - a repo skill read from an actual `.claude/skills/<name>/SKILL.md` on disk, not a map,
 *  - and a **stub `claude` on PATH** (memory `stub-claude-on-path`) that records its own argv
 *    and waits for this script to say so before ending its turn, so every assertion is made
 *    while the contract file this run was handed still exists (`claudeSession.ts` deletes it
 *    on `close`) and nothing races a timer (memory `headless-scenario-harness-traps`).
 *
 * Five sections, one real spawn each:
 *
 *   1. A lone card with one library skill: the contract file gets the "Skills in force"
 *      section with that skill's name and body, and the card's timeline gets the matching
 *      note — both read off disk/SQLite, not off a mock.
 *   2. A card with a repo skill, a step that adds a library skill AND re-lists the card's own
 *      repo ref with extra whitespace: the step's run sees both bodies, the repo one read
 *      fresh off the worktree, in CARD-then-step order, and the re-listed ref collapses to
 *      one block rather than two.
 *   3. A card whose only skill ref names a library skill that no longer exists: the run still
 *      starts (a stale ref never blocks it), the contract file carries NO skills section
 *      (nothing resolved), and the timeline names the dangling ref by its own text. (The
 *      OTHER dangling reason, a ref too malformed to parse at all, cannot be reproduced here
 *      — `Store.setTaskSkillRefs` is the only writer of `Task.skillRefs` and already discards
 *      anything `parseSkillRef` rejects before it reaches the column, so a real task can never
 *      carry one; `runSkills.test.ts` covers that branch directly against hand-built input.)
 *   4. A release run on a card that carries a skill: the contract file is the bare headless
 *      contract, byte for byte — `launch` skips skill resolution outright for a release, and
 *      files no note.
 *   5. A card with no refs at all: the same bare contract, same no note — the ordinary run
 *      this feature must leave untouched.
 *
 * The app is NEVER launched (RELEASE.md rule 6 / memory `verify-electron-app`). Nothing
 * outside the scratch directory is written: no real profile, no network. No `WorktreeManager`
 * either — every run lands in the project directory itself (`useWorktrees: false`), which is
 * what section 2's repo skill file sits under.
 *
 *   pnpm exec node scripts/verify-run-skills.mjs                  # the scenario, once, green
 *   pnpm exec node scripts/verify-run-skills.mjs --mutate=NAME    # apply one mutation below,
 *                                                                  # rerun, see it go red
 *   pnpm exec node scripts/verify-run-skills.mjs --prove           # do that for every mutation
 *                                                                  # and report which checks
 *                                                                  # reddened
 *
 * Exits non-zero on the first failed assertion in the plain run, naming it. `--mutate`/
 * `--prove` edit `runSkills.ts`/`scheduler.ts` ON DISK (one literal substitution each, see
 * `MUTATIONS`), rerun the bundle against THAT, and always restore both files in a `finally`.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const require = createRequire(import.meta.url);
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/** `@shared` lives in the packages/shared workspace package, not under this app. */
const sharedSrc = join(repo, '..', '..', 'packages', 'shared', 'src');
/** `store.ts` reaches `cloudDelta.ts`, which takes a runtime value from `@protocol/wire`. */
const protocolSrc = join(repo, '..', '..', 'packages', 'protocol', 'src');

/**
 * Everything this script writes lives here, INSIDE the repo rather than in the temp dir, for
 * one reason: the bundle keeps `better-sqlite3` external, so it must sit somewhere Node's
 * resolution can still find `node_modules`. Removed on the way out, and on the way in — a
 * crashed previous run must not leak into this one.
 */
const work = join(repo, '.verify-run-skills');

const electronBin = join(repo, 'node_modules', 'electron', 'dist', 'electron.exe');
const electronBinPosix = join(repo, 'node_modules', 'electron', 'dist', 'electron');
const runSkillsPath = join(repo, 'src', 'main', 'runSkills.ts');
const schedulerPath = join(repo, 'src', 'main', 'scheduler.ts');

function log(message) {
  process.stdout.write(`${message}\n`);
}

/**
 * Nothing under test calls Electron on this path — `store.ts` and `scheduler.ts` never touch
 * it — but every symbol throws rather than returning a plausible value, so a scenario that
 * DOES reach one fails loudly here instead of quietly verifying a stub.
 */
const ELECTRON_STUB = `
const unavailable = (name) => () => {
  throw new Error(\`Electron's \${name} is not available in headless verification\`);
};
export const app = { getPath: unavailable('app.getPath'), on: unavailable('app.on') };
export const protocol = { handle: unavailable('protocol.handle') };
export const ipcMain = { handle: unavailable('ipcMain.handle') };
export const shell = { openPath: unavailable('shell.openPath') };
export const safeStorage = { isEncryptionAvailable: () => false };
export const BrowserWindow = class {};
export default { app, protocol, ipcMain, shell, safeStorage, BrowserWindow };
`;

/** Bundle the scenario file to a runnable ESM module. */
async function bundle(entry, outDir) {
  const stub = join(work, 'electron-stub.mjs');
  writeFileSync(stub, ELECTRON_STUB, 'utf8');
  await build({
    configFile: false,
    logLevel: 'error',
    resolve: { alias: { '@shared': sharedSrc, '@protocol': protocolSrc, electron: stub } },
    build: {
      ssr: entry,
      outDir,
      emptyOutDir: true,
      target: 'node20',
      minify: false,
      // The native addon must stay a real `import` resolved at run time — bundling a `.node`
      // file is exactly the mistake this whole ABI dance exists to avoid.
      rollupOptions: {
        external: ['better-sqlite3'],
        output: { format: 'es', entryFileNames: 'bundle.mjs' },
      },
    },
  });
  return join(outDir, 'bundle.mjs');
}

/**
 * Run a bundle under Electron-as-Node, so `better_sqlite3.node` loads against its own ABI.
 * Captures stdout/stderr (and still prints them) so a mutation run can be graded on which
 * `FAIL` lines it produced, not just its exit code.
 */
function runUnderElectron(bundlePath) {
  const bin = existsSync(electronBin) ? electronBin : electronBinPosix;
  if (!existsSync(bin)) throw new Error(`No Electron binary at ${bin}`);
  const result = spawnSync(bin, [bundlePath], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    encoding: 'utf8',
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  return {
    status: result.status,
    signal: result.signal,
    stdout: result.stdout ?? '',
    failLines: (result.stdout ?? '')
      .split('\n')
      .filter((line) => line.includes('FAIL'))
      .map((line) => line.trim()),
  };
}

// ---------------------------------------------------------------------------

/**
 * The fake `claude`, written as a `.cjs` the shim on PATH invokes.
 *
 * It records its argv (the whole point — `--append-system-prompt-file`'s value is how the
 * driver finds the contract file to read), speaks the `system`/`init` line every run gets,
 * then waits for this script to drop a `proceed-N` file before reporting a plain success
 * `result`. That wait is what makes the scenario deterministic: the contract file is deleted
 * the moment the session's process closes, so every assertion on its contents has to happen
 * while the Nth run is still open.
 */
function stubSource(logPath, proceedDir) {
  return [
    "'use strict';",
    "const fs = require('node:fs');",
    `const LOG = ${JSON.stringify(logPath)};`,
    `const PROCEED = ${JSON.stringify(proceedDir)};`,
    'const argv = process.argv.slice(2);',
    'const arg = (name) => {',
    '  const i = argv.indexOf(name);',
    "  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : '';",
    '};',
    "const say = (o) => process.stdout.write(JSON.stringify(o) + '\\n');",
    '',
    "fs.appendFileSync(LOG, JSON.stringify({ argv, cwd: process.cwd() }) + '\\n');",
    '// 1-based index of THIS invocation, read back from the log so the driver and the stub',
    '// agree on which run a `proceed-N` file releases. Runs never overlap here.',
    "const index = fs.readFileSync(LOG, 'utf8').trim().split('\\n').length;",
    '',
    'say({',
    "  type: 'system',",
    "  subtype: 'init',",
    "  session_id: arg('--session-id') || arg('--resume'),",
    "  model: arg('--model'),",
    '  cwd: process.cwd(),',
    "  permissionMode: arg('--permission-mode'),",
    '});',
    '',
    'const timer = setInterval(() => {',
    "  if (!fs.existsSync(PROCEED + '/proceed-' + index)) return;",
    '  clearInterval(timer);',
    '  say({',
    "    type: 'result',",
    "    subtype: 'success',",
    '    is_error: false,',
    "    result: 'the stub finished run ' + index,",
    '    total_cost_usd: 0,',
    '  });',
    '}, 20);',
    '',
    '// Never self-exit — the scheduler kills the process after `result`, exactly as it does',
    '// the real CLI. The backstop is only so a crashed driver leaves nothing behind.',
    'process.stdin.resume();',
    'setTimeout(() => process.exit(0), 120000);',
  ].join('\n');
}

/** Put the fake `claude` on disk, in the shape each platform resolves from PATH. */
function writeStubCli(binDir, stubPath, electron) {
  writeFileSync(
    join(binDir, 'claude.cmd'),
    ['@echo off', 'set ELECTRON_RUN_AS_NODE=1', `"${electron}" "${stubPath}" %*`, ''].join('\r\n'),
    'utf8',
  );
  const posix = join(binDir, 'claude');
  writeFileSync(
    posix,
    ['#!/bin/sh', `ELECTRON_RUN_AS_NODE=1 exec "${electron}" "${stubPath}" "$@"`, ''].join('\n'),
    'utf8',
  );
  try {
    chmodSync(posix, 0o755);
  } catch {
    // Windows has no execute bit; the `.cmd` above is what runs there.
  }
}

/**
 * The mutations `--mutate`/`--prove` can apply, each a single literal substitution in the
 * named file. Chosen to target exactly the wiring this script proves end to end and nothing
 * `runSkills.test.ts`/`scheduler.test.ts` already pins at the unit level on their own:
 *
 *  - `release-skip` inverts the one line deciding whether a run resolves skills at all —
 *    flips sections 1-3 (lose their section/note) AND section 4 (gains one it must not have).
 *  - `repo-lookup` makes every `repo:` ref resolve to nothing, as if the lookup were never
 *    wired — only section 2's repo skill assertions depend on it.
 *  - `card-first-order` reverses the union so a step's own refs would out-rank its card's —
 *    only section 2's ordering assertion depends on it.
 *  - `dangling-sentence` drops the per-ref dangling line from the timeline note — only
 *    section 3's note assertions depend on it.
 */
const MUTATIONS = [
  {
    name: 'release-skip',
    file: schedulerPath,
    from: 'if (!run.releaseSeed) {',
    to: 'if (run.releaseSeed) {',
  },
  {
    name: 'repo-lookup',
    file: runSkillsPath,
    from: 'const skill = lookups.repo(parsed.name);',
    to: 'const skill = undefined;',
  },
  {
    name: 'card-first-order',
    file: runSkillsPath,
    from: 'const combined = [...(card.skillRefs ?? []), ...(step.skillRefs ?? [])];',
    to: 'const combined = [...(step.skillRefs ?? []), ...(card.skillRefs ?? [])];',
  },
  {
    name: 'dangling-sentence',
    file: runSkillsPath,
    from:
      '  for (const d of dangling) {\n' +
      '    sentences.push(`Skill \\`${d.ref}\\` no longer exists — this run started without it.`);\n' +
      '  }\n',
    to: '',
  },
];

/** Apply one named mutation's literal substitution, failing loudly if its anchor is gone. */
function applyMutation(source, mutation) {
  if (!source.includes(mutation.from)) {
    throw new Error(
      `could not find the "${mutation.name}" anchor in ${mutation.file} — has it been edited?`,
    );
  }
  return source.replace(mutation.from, mutation.to);
}

async function main() {
  const proveAll = process.argv.includes('--prove');
  const mutateArg = process.argv.find((a) => a.startsWith('--mutate'));
  const mutateName = mutateArg
    ? mutateArg.includes('=')
      ? mutateArg.slice(mutateArg.indexOf('=') + 1)
      : process.argv[process.argv.indexOf(mutateArg) + 1]
    : null;
  if (mutateName && !MUTATIONS.some((m) => m.name === mutateName)) {
    throw new Error(
      `unknown --mutate "${mutateName}" — choose one of: ${MUTATIONS.map((m) => m.name).join(', ')}`,
    );
  }

  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });

  const originals = new Map([
    [runSkillsPath, readFileSync(runSkillsPath, 'utf8')],
    [schedulerPath, readFileSync(schedulerPath, 'utf8')],
  ]);
  const restoreAllFiles = () => {
    for (const [path, text] of originals) writeFileSync(path, text, 'utf8');
  };

  try {
    // The ABI the whole exercise depends on. Checked first and by itself — every scenario
    // below fails identically and unhelpfully when this is wrong.
    const abi = require('./native-abi.mjs');
    const addon = join(
      dirname(require.resolve('better-sqlite3/package.json')),
      abi.ADDON_RELATIVE_PATH,
    );
    const expected = abi.readElectronAbi(require('electron'));
    const actual = abi.readModuleAbi(readFileSync(addon));
    if (expected !== actual) {
      throw new Error(
        `better_sqlite3.node targets ABI ${actual} but Electron is ABI ${expected} — ` +
          `run \`pnpm ensure:abi\` first`,
      );
    }
    log(`ABI ok: addon and Electron both ${actual}`);

    const electron = existsSync(electronBin) ? electronBin : electronBinPosix;
    const posix = (p) => p.replace(/\\/g, '/');
    const scratch = join(work, 'scratch');
    const binDir = join(work, 'bin');
    const proceedDir = join(work, 'proceed');
    const logPath = join(work, 'invocations.jsonl');
    const stubPath = join(binDir, 'claude-stub.cjs');

    /**
     * Fresh runtime state for ONE run of the scenario: a new scratch database, an empty
     * invocation log, an empty proceed directory, and the project repo directory the skills
     * live under. `--prove` runs the scenario multiple times (the baseline, then once per
     * mutation) and every one of them must start from nothing.
     */
    function resetRuntimeDirs() {
      rmSync(scratch, { recursive: true, force: true });
      rmSync(proceedDir, { recursive: true, force: true });
      mkdirSync(join(scratch, 'repo'), { recursive: true });
      mkdirSync(proceedDir, { recursive: true });
      mkdirSync(binDir, { recursive: true });
      writeFileSync(logPath, '', 'utf8');
      writeFileSync(stubPath, stubSource(posix(logPath), posix(proceedDir)), 'utf8');
      writeStubCli(binDir, stubPath, electron);
    }
    resetRuntimeDirs();
    log(`Stub claude written to ${binDir}`);

    const entry = join(work, 'entry.ts');
    writeFileSync(
      entry,
      SCENARIOS.replaceAll('__REPO__', posix(repo))
        .replaceAll('__SCRATCH__', posix(scratch))
        // Quoted by JSON so a Windows path's backslashes survive into the scenario's own
        // source, where a bare C:\Users\... would be read as escape sequences.
        .replaceAll('__BIN__', JSON.stringify(binDir))
        .replaceAll('__LOG__', posix(logPath))
        .replaceAll('__PROCEED__', posix(proceedDir)),
      'utf8',
    );

    /** Bundle and run the (possibly mutated) current sources, against a fresh outDir. */
    async function runScenarioOnce(label, outDirName) {
      log(`\nRunning the scenario${label ? ` (${label})` : ''}...`);
      resetRuntimeDirs();
      const bundlePath = await bundle(entry, join(work, outDirName));
      return runUnderElectron(bundlePath);
    }

    if (proveAll) {
      const baseline = await runScenarioOnce('baseline', 'out-baseline');
      if (baseline.status !== 0) {
        throw new Error(
          'the unmutated scenario is not green — fix that before --prove means anything',
        );
      }
      log('\nBaseline is green. Applying each mutation in turn...');
      const report = [];
      for (const mutation of MUTATIONS) {
        const original = originals.get(mutation.file);
        writeFileSync(mutation.file, applyMutation(original, mutation), 'utf8');
        let outcome;
        try {
          outcome = await runScenarioOnce(
            `--mutate=${mutation.name}`,
            `out-mutate-${mutation.name}`,
          );
        } finally {
          writeFileSync(mutation.file, original, 'utf8');
        }
        report.push({ mutation: mutation.name, ...outcome });
      }

      log('\n--prove summary — which checks each mutation turned red:');
      for (const row of report) {
        log(`\n  ${row.mutation}:`);
        if (row.failLines.length === 0) log('    (nothing failed)');
        for (const line of row.failLines) log(`    ${line}`);
      }

      const uncaught = report.filter((r) => r.failLines.length === 0);
      if (uncaught.length > 0) {
        throw new Error(
          `these mutations applied with NO check going red: ${uncaught.map((r) => r.mutation).join(', ')}`,
        );
      }
      log('\nEvery mutation this scenario can apply is load-bearing.');
    } else if (mutateName) {
      const mutation = MUTATIONS.find((m) => m.name === mutateName);
      const original = originals.get(mutation.file);
      writeFileSync(mutation.file, applyMutation(original, mutation), 'utf8');
      let outcome;
      try {
        outcome = await runScenarioOnce(`--mutate=${mutateName}`, `out-mutate-${mutateName}`);
      } finally {
        writeFileSync(mutation.file, original, 'utf8');
      }
      if (outcome.status === 0) {
        throw new Error(`--mutate=${mutateName} was expected to turn a check red, but exited 0`);
      }
      log(`\n--mutate=${mutateName} correctly turned ${outcome.failLines.length} check(s) red.`);
    } else {
      const outcome = await runScenarioOnce(null, 'out');
      if (outcome.status !== 0) {
        throw new Error(`scenario exited ${outcome.status ?? `on ${outcome.signal}`}`);
      }
      log('\nAll scenarios passed.');
    }
  } finally {
    // Belt and suspenders on top of every mutation's own restore above: whatever happened,
    // both files on disk must be byte-identical to what this run started with.
    restoreAllFiles();
    if (process.argv.includes('--keep')) log(`\nLeft ${work} in place (--keep).`);
    else {
      try {
        // Retries because a killed stub's directory handle can outlive it by a moment on
        // Windows, and losing the run's verdict to an EBUSY on cleanup would be absurd.
        rmSync(work, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 });
      } catch (err) {
        log(`\nCould not remove ${work} (${err.code ?? err.message}); delete it by hand.`);
      }
    }
  }
}

/**
 * The scenario itself, as a template so the paths are baked in rather than passed — a bundle
 * takes no argv worth threading, and every path in it is scratch or this repo.
 *
 * NO BACKTICKS below: this is a `String.raw` template, and one inside a comment or a string
 * closes it with a SyntaxError pointing at a word in prose (memory
 * `headless-scenario-harness-traps`). Every dangling-ref assertion below is written as two
 * substring checks instead of one backtick-quoted string for exactly that reason.
 */
const SCENARIOS = String.raw`
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { PERSONAL_PROJECT_ID } from '@shared/model';
import { HEADLESS_TURN_CONTRACT } from '__REPO__/src/main/headlessContract';
import { Scheduler } from '__REPO__/src/main/scheduler';
import { SessionManager } from '__REPO__/src/main/sessionManager';
import { createStore } from '__REPO__/src/main/store';

let failures = 0;
function check(label, condition, detail) {
  if (condition) {
    console.log('  PASS  ' + label);
  } else {
    failures += 1;
    console.log('  FAIL  ' + label + (detail === undefined ? '' : ' — ' + detail));
  }
}
function section(name) {
  console.log('\n' + name);
}

const SCRATCH = '__SCRATCH__';
const LOG = '__LOG__';
const PROCEED = '__PROCEED__';
const REPO_DIR = SCRATCH + '/repo';

// The one line that makes the fake CLI the real one for this process. Everything above it —
// the scheduler, the store, runSkills, claudeSession, the spawn — is the app's own code.
process.env.PATH = __BIN__ + delimiter + process.env.PATH;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(what, predicate, timeoutMs = 30000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return true;
    await sleep(20);
  }
  check('waited for ' + what, false, 'timed out after ' + timeoutMs + 'ms');
  return false;
}

/** Every invocation of the stub so far, oldest first. */
const invocations = () =>
  readFileSync(LOG, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));

/** The value the CLI was given for a flag — read off the argv, positionally, as the CLI does. */
function flag(invocation, name) {
  const i = invocation.argv.indexOf(name);
  return i >= 0 && i + 1 < invocation.argv.length ? invocation.argv[i + 1] : '';
}

/** Wait for the Nth spawn (1-based) and hand it back. */
async function nthInvocation(n, what) {
  await waitFor(what, () => invocations().length >= n);
  return invocations()[n - 1] ?? { argv: [] };
}

/** The contract file this invocation's CLI was handed, read while its run is still open. */
function contractOf(invocation) {
  const path = flag(invocation, '--append-system-prompt-file');
  if (!path) return '';
  return readFileSync(path, 'utf8');
}

/** How many times 'needle' occurs in 'haystack', as a non-overlapping substring count. */
function occurrences(haystack, needle) {
  return haystack.split(needle).length - 1;
}

/** Let run N report its result, which is what advances the engine and frees its slot. */
const proceed = (n) => writeFileSync(PROCEED + '/proceed-' + n, 'go', 'utf8');

/** Every note noteRun filed on a card's own timeline, oldest first. */
function notesFor(taskId) {
  return store
    .getTaskActivity(taskId)
    .filter((e) => e.kind === 'event' && e.event && e.event.kind === 'assistant')
    .map((e) => e.event.text);
}

const store = createStore(SCRATCH + '/orchestrator.db');
const sessions = new SessionManager(() => {});
const scheduler = new Scheduler(
  store,
  sessions,
  () => {},
  () => {},
  () => {},
  () => {},
  () => {},
);

// No WorktreeManager on purpose: every run then happens in the project directory itself —
// which is what section 2's repo skill file sits under, read fresh off disk each run.
const project = store.addProject({
  path: REPO_DIR,
  name: 'the skills project',
  kind: 'agent',
  defaultModel: 'haiku',
  defaultPermissionMode: 'acceptEdits',
  useWorktrees: false,
});

/**
 * A card on the Personal board, delegated to that project, with its own skillRefs.
 *
 * Re-reads the row after setTaskSkillRefs rather than returning updateTask's own result —
 * that result is a snapshot from BEFORE the refs were written, so a caller that goes
 * through the low-level startTask (section 4) rather than runTask (which re-reads the task
 * itself) would otherwise hand the engine a task whose skillRefs is still null.
 */
function card(title, refs) {
  const created = store.createTask(PERSONAL_PROJECT_ID, { title });
  if (!created) throw new Error('the store refused ' + title);
  const updated = store.updateTask(created.id, { agentProjectId: project.id });
  if (!updated) throw new Error('the store refused the patch for ' + title);
  if (refs) store.setTaskSkillRefs(updated.id, refs);
  return store.getTask(updated.id);
}

// ===========================================================================
section('1. A lone card with one library skill');

const LIBRARY_SKILL_ID = 'tdd-skill';
const saved = store.saveSkill({
  id: LIBRARY_SKILL_ID,
  name: 'tdd',
  description: 'Write the test first.',
  body: 'Write the test first, then the code.',
  createdAt: Date.now(),
  updatedAt: Date.now(),
});
check('the library skill saved', saved.ok, JSON.stringify(saved));

const card1 = card('Card with a library skill', ['lib:' + LIBRARY_SKILL_ID]);
scheduler.runTask(card1.id);
const invocation1 = await nthInvocation(1, 'card 1 to spawn');
const contract1 = contractOf(invocation1);

check(
  'the contract file still starts with the headless contract, unchanged',
  contract1.startsWith(HEADLESS_TURN_CONTRACT),
);
check(
  'and carries the "Skills in force" section',
  contract1.includes('## Skills in force for this run'),
);
check('with the skill\'s own heading', contract1.includes('### tdd'));
check('and its full body', contract1.includes('Write the test first, then the code.'));

const notes1 = notesFor(card1.id);
check(
  'the card\'s timeline notes which skill is in force',
  notes1.some((n) => n.includes('Skills in force for this run: tdd.')),
  JSON.stringify(notes1),
);

proceed(1);

// ---------------------------------------------------------------------------
section('2. A repo skill on the card, a step that adds a library skill and re-lists it');

mkdirSync(join(REPO_DIR, '.claude', 'skills', 'security-review'), { recursive: true });
writeFileSync(
  join(REPO_DIR, '.claude', 'skills', 'security-review', 'SKILL.md'),
  [
    '---',
    'name: security-review',
    'description: Check every input before trusting it.',
    '---',
    '',
    'Check every input for injection before it reaches a query or a shell.',
  ].join('\n'),
  'utf8',
);

const card2 = card('Card with a repo skill', ['repo:security-review']);
const step2 = store.addSubtask(card2.id, { title: 'Step 1' });
if (!step2) throw new Error('the store refused the step');
check(
  'the step inherited the card\'s project',
  step2.agentProjectId === project.id,
  String(step2.agentProjectId),
);
// The same repo ref again, with padding whitespace, plus a library ref the step adds on its
// own — proving both that the duplicate collapses to one block and that the step's own ref
// still lands.
store.setTaskSkillRefs(step2.id, ['lib:' + LIBRARY_SKILL_ID, ' repo:security-review ']);

scheduler.runTask(step2.id);
const invocation2 = await nthInvocation(2, 'step 1 of card 2 to spawn');
const contract2 = contractOf(invocation2);

check(
  'the repo skill\'s heading appears exactly once, despite being listed twice',
  occurrences(contract2, '### security-review') === 1,
  String(occurrences(contract2, '### security-review')),
);
check('the repo skill tells the agent where its files live', contract2.includes('.claude/skills/security-review'));
check('the repo skill\'s body made it in', contract2.includes('Check every input for injection'));
check('the step\'s own library skill made it in too', contract2.includes('Write the test first, then the code.'));
check(
  'the card\'s skill renders BEFORE the step\'s own — card ref first, per the resolver\'s order',
  contract2.indexOf('### security-review') < contract2.indexOf('### tdd'),
  'security-review at ' + contract2.indexOf('### security-review') + ', tdd at ' + contract2.indexOf('### tdd'),
);

proceed(2);

// ---------------------------------------------------------------------------
section('3. A card whose only skill ref names a library skill that no longer exists');

const card3 = card('Card with a dangling ref', ['lib:does-not-exist']);
scheduler.runTask(card3.id);
const invocation3 = await nthInvocation(3, 'card 3 to spawn');
check('a stale ref never blocks the run from starting', invocations().length >= 3);
const contract3 = contractOf(invocation3);

check(
  'nothing resolved, so the contract carries no skills section at all',
  contract3 === HEADLESS_TURN_CONTRACT,
);

const notes3 = notesFor(card3.id);
check(
  'the missing library ref is named on the timeline',
  notes3.some((n) => n.includes('lib:does-not-exist') && n.includes('no longer exists')),
  JSON.stringify(notes3),
);

proceed(3);

// ---------------------------------------------------------------------------
section('4. A release run skips skill resolution outright, even on a card that carries one');

const card4 = card('Card released despite carrying a skill', ['lib:' + LIBRARY_SKILL_ID]);
// The private route a release run actually starts through (scheduler.test.ts's own release
// case uses the same cast-free call once compiled — TS 'private' is a compile-time fence
// only, and this bundle is never type-checked).
scheduler.startTask(project, card4, { releaseSeed: true, chatPrompt: 'Release now.' });
const invocation4 = await nthInvocation(4, 'the release run to spawn');
const contract4 = contractOf(invocation4);

check(
  'the contract is the bare headless contract — no skills section for a release run',
  contract4 === HEADLESS_TURN_CONTRACT,
);
check('and no note was filed either', notesFor(card4.id).length === 0, JSON.stringify(notesFor(card4.id)));

proceed(4);

// ---------------------------------------------------------------------------
section('5. An ordinary card with no refs at all stays exactly as it always was');

const card5 = card('Card with no skills', null);
scheduler.runTask(card5.id);
const invocation5 = await nthInvocation(5, 'card 5 to spawn');
const contract5 = contractOf(invocation5);

check('the contract is the bare headless contract', contract5 === HEADLESS_TURN_CONTRACT);
check('and no note was filed', notesFor(card5.id).length === 0, JSON.stringify(notesFor(card5.id)));

proceed(5);

// ===========================================================================
// Kill every stub still waiting before the database is closed. The pause is for Windows:
// termination is a taskkill of its own, and a stub whose CWD is the project directory keeps
// that directory locked until it is really gone.
scheduler.dispose();
sessions.stopAll();
await sleep(750);
store.close();

console.log('');
console.log(invocations().length + ' CLI invocation(s) observed.');
if (failures > 0) {
  console.error(failures + ' check(s) failed.');
  process.exit(1);
}
`;

await main();
