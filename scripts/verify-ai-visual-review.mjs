/**
 * Headless proof of "Visual sign-off by AI reviewer" — a UI card's PR goes from open to
 * auto-merge armed with no human click, through the REAL engine.
 *
 *     node scripts/verify-ai-visual-review.mjs
 *
 * ## Why this is a script and not a test
 *
 * `aiVisualReview.test.ts` proves the decisions are pure and correct, and
 * `aiVisualReviewer.test.ts` proves the reviewer carries each one out against fake deps.
 * Neither can answer what the owner actually cares about: does a push really start a fresh,
 * read-only Claude session, does its verdict really add and RUN a fix step, does the next
 * push really start the next review, and does an approval really reach GitHub's
 * `enablePullRequestAutoMerge`? That is the REAL store, `SessionManager`,
 * `Scheduler.startAuxiliarySession`, `createAiVisualReviewer`, `requestAutoMerge` and
 * `applyVisualSignOff`, wired exactly as `ipc.ts` wires them.
 *
 * So, the same way `verify-pr-watch.mjs` does, this bundles the app's own modules with
 * esbuild and runs them under Electron-as-Node — no window, no second instance of the app
 * (`RELEASE.md` rule 6, the `verify-electron-app` memory) — against:
 *
 *  - a real SQLite store (`better-sqlite3`, which only loads under Electron's ABI),
 *  - a stub `claude` on PATH that records its argv, pid and stdin prompt, and holds its
 *    `result` until the driver drops a `proceed-N` file — whose CONTENT is the turn's
 *    `resultText`, so the driver plays the reviewer's verdict, and
 *  - a `global.fetch` recorder standing in for GitHub, the only thing `GitHubClient` calls.
 *
 * `ipc.ts`'s handlers are out of reach from here (`registerIpcHandlers` builds its own store,
 * scheduler and pollers — the `headless-scenario-harness-traps` memory), so `reviewerDeps`,
 * `postVisualSignOff` and `humanVisualSignOff` below restate its three closures line for line.
 * Its `inspect` is the one stand-in: it answers the card's worktree as the repo itself, whose
 * `origin` is a github.com URL so `resolveForgeGitTarget` resolves a real GitHub target.
 *
 * Each card carries two shots (`board-light.png` with its `-mockup.png`, and `board-dark.png`
 * with none) and an open PR, on a project with Merge on green, AI sign-off on and max rounds 1.
 *
 * ## What it proves
 *
 *  A. **PR open to auto-merge armed, with no human click.** `requestAutoMerge` holds for
 *     sign-off and starts a review session: `--permission-mode plan`, `--disallowedTools`
 *     naming Edit/Write/Bash, a fresh `--session-id` (never `--resume`), and a prompt holding
 *     the rubric and both PNG paths. A second push mid-review starts no second session. The
 *     stub answers needs-changes: a needs-changes note, a fix step carrying the reason, and
 *     that step's own run starts. Its "push" (`requestAutoMerge` again) starts a second
 *     review; the stub approves, `Visual sign-off: approved (AI reviewer)` is posted, and the
 *     fetch recorder saw GitHub's `enablePullRequestAutoMerge` and the `Auto-merge enabled`
 *     note followed.
 *  B. **The round cap stops it.** The stub always answers needs-changes. After one fix round
 *     the second review gives up: the gave-up note, an Inbox `decisionQuestion`, no second
 *     fix step, no third session — and a further `requestAutoMerge` starts nothing and says
 *     the hold is the human's again.
 *  C. **A human's verdict wins.** Approve pressed while a review runs stops its process, and
 *     a result written for it afterwards posts nothing. A review whose result really does
 *     land — after a human sign-off reached the timeline some other way — is dropped too.
 *
 * ## Prove it can fail
 *
 * Remove the rounds check in `packages/shared/src/aiVisualReview.ts`: in `aiReviewOutcome`
 * make the last line `return 'fix-step';`, and in `aiReviewNext` make it `return 'review';`.
 * Re-run and Scenario B goes red — no gave-up note, no `decisionQuestion`, a second fix step
 * and its run, and the further `requestAutoMerge` starts a third review session. Restore the
 * file (`git diff` empty) and the run is green again.
 *
 * Pass `--keep` to leave the scratch directory behind. Exits non-zero naming every failed
 * check.
 */
import { spawnSync, execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const clientModules = join(root, 'apps', 'client', 'node_modules');
const sharedSrc = join(root, 'packages', 'shared', 'src');
const protocolSrc = join(root, 'packages', 'protocol', 'src');

function log(message) {
  process.stdout.write(`${message}\n`);
}

/** esbuild's per-platform binary, found by pattern so a dependency bump cannot rot it. */
function findEsbuild() {
  const pnpm = join(root, 'node_modules', '.pnpm');
  const target = `${process.platform}-${process.arch}`;
  const dir = readdirSync(pnpm).find((d) => d.startsWith(`@esbuild+${target}@`));
  if (!dir) throw new Error(`no esbuild binary for ${target} under ${pnpm}`);
  const exe = process.platform === 'win32' ? 'esbuild.exe' : 'bin/esbuild';
  return join(pnpm, dir, 'node_modules', '@esbuild', target, exe);
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
 * The fake `claude`. Records its argv and pid, captures the stdin prompt to `prompt-N.txt`,
 * and waits for `proceed-N` before ending its turn — with that file's content as the turn's
 * `result`, so the driver decides both WHEN a review finishes and WHAT it concluded.
 */
function stubSource(logPath, promptsDir, proceedDir) {
  return [
    "'use strict';",
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    "const readline = require('node:readline');",
    `const LOG = ${JSON.stringify(logPath)};`,
    `const PROMPTS = ${JSON.stringify(promptsDir)};`,
    `const PROCEED = ${JSON.stringify(proceedDir)};`,
    'const argv = process.argv.slice(2);',
    'const arg = (name) => {',
    '  const i = argv.indexOf(name);',
    "  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : '';",
    '};',
    "const say = (o) => process.stdout.write(JSON.stringify(o) + '\\n');",
    '',
    "fs.appendFileSync(LOG, JSON.stringify({ argv, cwd: process.cwd(), pid: process.pid }) + '\\n');",
    "const index = fs.readFileSync(LOG, 'utf8').trim().split('\\n').length;",
    '',
    'const rl = readline.createInterface({ input: process.stdin });',
    "rl.once('line', (line) => {",
    "  let text = '';",
    '  try {',
    '    const msg = JSON.parse(line);',
    "    const block = (msg?.message?.content ?? []).find((c) => c.type === 'text');",
    "    text = block?.text ?? '';",
    '  } catch {',
    '    // Not JSON, or not the shape we expect.',
    '  }',
    "  fs.writeFileSync(path.join(PROMPTS, 'prompt-' + index + '.txt'), text, 'utf8');",
    '});',
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
    "  const file = PROCEED + '/proceed-' + index;",
    '  if (!fs.existsSync(file)) return;',
    '  clearInterval(timer);',
    "  const text = fs.readFileSync(file, 'utf8');",
    '  say({',
    "    type: 'result',",
    "    subtype: 'success',",
    '    is_error: false,',
    "    result: text || 'the stub finished run ' + index,",
    '    total_cost_usd: 0,',
    '  });',
    '}, 20);',
    '',
    '// Never self-exit — the scheduler kills the process after `result`, as it does the real',
    '// CLI. The backstop is only so a crashed driver leaves nothing behind.',
    'process.stdin.resume();',
    'setTimeout(() => process.exit(0), 120000);',
  ].join('\n');
}

/** The one module this script bundles: everything the driver touches, in ONE copy. */
function entrySource() {
  const main = (p) => JSON.stringify(join(root, 'apps/client/src/main', p).replace(/\\/g, '/'));
  const shared = (p) => JSON.stringify(join(sharedSrc, p).replace(/\\/g, '/'));
  return [
    `export { createStore } from ${main('store')};`,
    `export { SessionManager } from ${main('sessionManager')};`,
    `export { Scheduler } from ${main('scheduler')};`,
    `export { createAiVisualReviewer, isAiReviewDecision } from ${main('forge/aiVisualReviewer')};`,
    `export { requestAutoMerge, applyVisualSignOff } from ${main('forge/autoMerge')};`,
    `export { attachmentFile } from ${main('attachmentPaths')};`,
    `export { hostFor } from ${main('exec')};`,
    `export { formatSignOff } from ${shared('visualSignOff')};`,
    `export { AI_REVIEW_RUBRIC } from ${shared('aiVisualReview')};`,
    '',
  ].join('\n');
}

async function main() {
  let status = 1;
  // The OS temp directory, NOT a folder inside the repo: the scratch repo below must be a
  // repository of its own, and a directory under a work tree IS part of that work tree.
  const scratch = mkdtempSync(join(tmpdir(), 'tm-ai-review-'));
  try {
    const esbuild = findEsbuild();
    const entry = join(scratch, 'entry.mjs');
    writeFileSync(entry, entrySource(), 'utf8');
    // `electron` external for the reason `verify-pr-watch.mjs` gives: inlined, its loader
    // resolves off the bundle's own `__dirname` and throws "Electron failed to install".
    const result = spawnSync(
      esbuild,
      [
        entry,
        '--bundle',
        '--platform=node',
        '--format=cjs',
        `--alias:@shared=${sharedSrc}`,
        `--alias:@protocol=${protocolSrc}`,
        '--external:better-sqlite3',
        '--external:electron',
        `--outfile=${join(scratch, 'app.cjs')}`,
        '--log-level=error',
      ],
      { stdio: 'inherit' },
    );
    if (result.status !== 0) throw new Error('esbuild failed');

    const electron = join(
      clientModules,
      'electron',
      'dist',
      process.platform === 'win32' ? 'electron.exe' : 'electron',
    );
    if (!existsSync(electron)) throw new Error(`electron not installed at ${electron}`);

    const binDir = join(scratch, 'bin');
    for (const dir of [binDir, join(scratch, 'proceed'), join(scratch, 'prompts')]) {
      mkdirSync(dir, { recursive: true });
    }
    const logPath = join(scratch, 'invocations.jsonl');
    writeFileSync(logPath, '', 'utf8');
    const stubPath = join(binDir, 'claude-stub.cjs');
    writeFileSync(
      stubPath,
      stubSource(logPath, join(scratch, 'prompts'), join(scratch, 'proceed')),
      'utf8',
    );
    writeStubCli(binDir, stubPath, electron);

    // A real repository whose `origin` is a github.com URL — nothing is ever pushed to it;
    // `resolveForgeGitTarget` only reads it to know the PR lives on GitHub, as acme/web.
    const repoDir = join(scratch, 'repo');
    const git = (...args) => execFileSync('git', args, { cwd: repoDir, encoding: 'utf8' });
    mkdirSync(repoDir, { recursive: true });
    git('init');
    git('config', 'user.email', 'verify@example.com');
    git('config', 'user.name', 'Verify');
    git('config', 'commit.gpgsign', 'false');
    git('config', 'core.autocrlf', 'false');
    writeFileSync(join(repoDir, 'README.md'), '# web\n', 'utf8');
    git('add', '-A');
    git('commit', '--no-verify', '-m', 'initial');
    git('remote', 'add', 'origin', 'https://github.com/acme/web.git');
    const base = git('rev-parse', '--abbrev-ref', 'HEAD').trim();

    const run = spawnSync(electron, [fileURLToPath(import.meta.url), scratch, repoDir, base], {
      stdio: 'inherit',
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        // The bundle lives in temp, outside any node_modules tree, so its external
        // `require('better-sqlite3')` needs somewhere to resolve from.
        NODE_PATH: clientModules,
      },
    });
    status = run.status ?? 1;
  } finally {
    if (!process.argv.includes('--keep')) {
      rmSync(scratch, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 });
    } else {
      log(`\nLeft ${scratch} in place (--keep).`);
    }
  }
  process.exit(status);
}

// ── Phase 1: plain Node — bundle, set up a repo, then hand over to Electron ─────────────
if (!process.versions.electron) {
  await main();
}

// ── Phase 2: under Electron-as-Node — the actual checks ──────────────────────────────
const require = createRequire(import.meta.url);
const work = process.argv[2];
const repoDir = process.argv[3];
const base = process.argv[4];

const {
  createStore,
  SessionManager,
  Scheduler,
  createAiVisualReviewer,
  isAiReviewDecision,
  requestAutoMerge,
  applyVisualSignOff,
  attachmentFile,
  hostFor,
  formatSignOff,
  AI_REVIEW_RUBRIC,
} = require(join(work, 'app.cjs'));

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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(what, predicate, timeoutMs = 20000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return true;
    await sleep(20);
  }
  check('waited for ' + what, false, 'timed out after ' + timeoutMs + 'ms');
  return false;
}

const LOG = join(work, 'invocations.jsonl');
const PROMPTS = join(work, 'prompts');
const PROCEED = join(work, 'proceed');

/** Every invocation of the stub so far, oldest first. */
const invocations = () =>
  readFileSync(LOG, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));

/** The value the CLI was given for a flag. */
function flag(invocation, name) {
  const i = invocation.argv.indexOf(name);
  return i >= 0 && i + 1 < invocation.argv.length ? invocation.argv[i + 1] : '';
}
const has = (invocation, name) => invocation.argv.includes(name);
/** A review session is the only one ever spawned with tools taken away. */
const isReview = (invocation) => has(invocation, '--disallowedTools');

/** Wait for the stub's Nth spawn (1-based) and hand it back. */
async function spawnNumber(n, what) {
  await waitFor(what, () => invocations().length >= n);
  return invocations()[n - 1] ?? { argv: [], cwd: '', pid: 0 };
}

/** Wait for run N's own prompt file and read it. */
async function promptFor(n, what) {
  const path = join(PROMPTS, 'prompt-' + n + '.txt');
  await waitFor(what, () => existsSync(path));
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

/** Let run N end its turn with `resultText`. */
const proceed = (n, resultText = '') =>
  writeFileSync(join(PROCEED, 'proceed-' + n), resultText, 'utf8');

/** Whether a process is still alive — signal 0 only asks. */
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** What the reviewer answers, the way the prompt asks it to: prose, then a ```json block. */
function verdictText(verdict, screens) {
  return (
    'I opened both shots and the mockup.\n\n```json\n' +
    JSON.stringify({ verdict, screens, outOfScope: ['the sidebar is the older shell'] }) +
    '\n```\n'
  );
}
const REASON = 'the header overlaps the first column';
const APPROVE = verdictText('approve', [
  { screen: 'board-light', status: 'ok', reason: '' },
  { screen: 'board-dark', status: 'ok', reason: '' },
]);
const NEEDS_CHANGES = verdictText('needs-changes', [
  { screen: 'board-light', status: 'mismatch', reason: REASON },
  { screen: 'board-dark', status: 'ok', reason: '' },
]);

process.env.PATH = join(work, 'bin') + delimiter + process.env.PATH;

// ── The engine, wired as `ipc.ts` wires it ─────────────────────────────────────────────
const userData = join(work, 'userData');
const store = createStore(join(work, 'orchestrator.db'));
const saved = store.getSettings();
store.saveSettings({
  ...saved,
  maxAutoRetries: 0,
  limitJitterMs: 0,
  github: { ...saved.github, enabled: true, baseUrl: 'https://api.github.com' },
});

const sessions = new SessionManager(() => {});
const taskChanges = [];
const scheduler = new Scheduler(
  store,
  sessions,
  (change) => taskChanges.push(change),
  () => {},
  () => {},
  () => {},
  () => {},
);

const TOKEN = 'ghp_verifyaireview0000';

// GitHub, as a recorder: `getPullRequest` answers an un-armed PR with a node id, and the
// `enablePullRequestAutoMerge` mutation answers as GitHub does.
const fetchCalls = [];
globalThis.fetch = async (url, init) => {
  const method = init?.method ?? 'GET';
  const body = String(init?.body ?? '');
  fetchCalls.push({ url: String(url), method, body });
  let answer = {};
  const pull = /\/repos\/acme\/web\/pulls\/(\d+)$/.exec(String(url));
  if (pull && method === 'GET') {
    answer = { number: Number(pull[1]), node_id: 'PR_node_' + pull[1], auto_merge: null };
  } else if (String(url).endsWith('/graphql')) {
    const vars = JSON.parse(body).variables ?? {};
    answer = { data: { enablePullRequestAutoMerge: { pullRequest: { number: vars.id } } } };
  }
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => answer,
    text: async () => JSON.stringify(answer),
    headers: { get: () => null },
  };
};
const armedFor = (number) =>
  fetchCalls.some(
    (c) =>
      c.url.endsWith('/graphql') &&
      c.body.includes('enablePullRequestAutoMerge') &&
      c.body.includes('PR_node_' + number),
  );

const note = (projectId, taskId, body) => {
  store.addComment(projectId, taskId, body);
};

const appMergeAttempts = new Map();
const createPrDeps = () => ({
  getTask: (id) => store.getTask(id),
  getProject: (id) => store.getProject(id),
  getSettings: () => store.getSettings(),
  listMergeRequests: () => store.listMergeRequests(),
  listVariantRows: (leaderId) => store.listVariantRows(leaderId),
  listAttachments: (taskId) => store.attachmentsForTask(taskId),
  listActivity: (taskId) => store.getTaskActivity(taskId),
  upsertMergeRequest: (mr) => store.upsertMergeRequest(mr),
  // The one stand-in (see the header): the card's worktree is the repo itself.
  inspect: async (_project, ownerTaskId) => ({ cwd: repoDir, branch: 'feat/' + ownerTaskId, base }),
  tokenFor: () => TOKEN,
  note,
  now: () => Date.now(),
  onAwaitSignOff: (projectId, ownerId) => {
    void reviewer.onAwaitSignOff(projectId, ownerId);
  },
});

/** `ipc.ts`'s `postVisualSignOff`, line for line. */
async function postVisualSignOff(taskId, status, screens, by) {
  const task = store.getTask(taskId);
  if (!task) throw new Error('Task not found.');
  const body =
    status === 'approved'
      ? formatSignOff('approved', [], by)
      : formatSignOff('needs-changes', screens);
  const entry = store.addComment(task.projectId, taskId, body);
  await applyVisualSignOff({ ...createPrDeps(), appMergeAttempts }, taskId, status);
  return entry;
}

const attachmentPath = (project, attachment) =>
  hostFor(project.target).toNative(attachmentFile(userData, attachment.taskId, attachment.name));

const reviewer = createAiVisualReviewer({
  getTask: (id) => store.getTask(id),
  getProject: (id) => store.getProject(id),
  listSubtasks: (ownerId) => store.getSubtasks(ownerId),
  listAttachments: (taskId) => store.attachmentsForTask(taskId),
  listActivity: (taskId) => store.getTaskActivity(taskId),
  attachmentPath,
  // No WorktreeManager here, so `inspect` would find nothing and fall back the same way.
  cwdFor: async (project) => project.path,
  note,
  now: () => Date.now(),
  startSession: (projectId, request, onResult, onExit) =>
    scheduler.startAuxiliarySession(projectId, request, {
      onResult: (event) => onResult(event.resultText),
      onExit,
    }),
  stopRun: (runId) => scheduler.stopAuxiliarySession(runId),
  signOffApproved: async (ownerId) => {
    await postVisualSignOff(ownerId, 'approved', [], 'ai');
  },
  addFixStep: (ownerId, title, description) => {
    store.addSubtask(ownerId, { title, description });
  },
  runCard: (ownerId) => {
    scheduler.startTaskNow(ownerId);
  },
  raiseInbox: (ownerId, question) => {
    scheduler.setDecision(ownerId, question);
  },
});

/** `ipc.ts`'s `task:visualSignOff` handler — the human's own button. */
async function humanVisualSignOff(taskId, status) {
  const task = store.getTask(taskId);
  reviewer.cancel(taskId);
  if (isAiReviewDecision(task.decisionQuestion)) scheduler.setDecision(taskId, null);
  return postVisualSignOff(taskId, status, [], 'human');
}

// ── The project and its UI cards ──────────────────────────────────────────────────────
const added = store.addProject({
  path: repoDir,
  name: 'the web repo',
  kind: 'agent',
  defaultModel: 'sonnet',
  defaultPermissionMode: 'acceptEdits',
  baseBranch: base,
});
const project = store.updateProject(added.id, {
  autoMergeOnGreen: true,
  autoMergeMethod: 'squash',
  autoVisualSignOff: true,
  autoVisualSignOffMaxRounds: 1,
});
check(
  'the project reads back with Merge on green, AI sign-off on and max rounds 1',
  project?.autoMergeOnGreen === true &&
    project?.autoVisualSignOff === true &&
    project?.autoVisualSignOffMaxRounds === 1,
  JSON.stringify(project),
);

/** A UI card: two shots (one with a mockup), and an open GitHub PR numbered `number`. */
function uiCard(title, number) {
  const created = store.createTask('personal', {
    title,
    description: 'Make the board header stay above the columns.',
  });
  const card = store.updateTask(created.id, { agentProjectId: project.id });
  for (const name of ['board-light.png', 'board-light-mockup.png', 'board-dark.png']) {
    store.addAttachment({ taskId: card.id, name, fileName: name, mimeType: 'image/png', size: 1 });
    const file = attachmentFile(userData, card.id, name);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, 'png', 'utf8');
  }
  store.upsertMergeRequest({
    id: 'gh-555-' + number,
    taskId: card.id,
    openedForTaskId: card.id,
    provider: 'github',
    repoId: 555,
    projectPath: 'acme/web',
    number,
    title,
    displayName: null,
    webUrl: 'https://github.com/acme/web/pull/' + number,
    sourceBranch: 'feat/' + card.id,
    targetBranch: base,
    state: 'opened',
    draft: false,
    headSha: 'head' + number,
    lastActedSha: null,
    lastActedAction: null,
    pipelineStatus: 'unknown',
    pipelineStages: [],
    pipelineUrl: null,
    approvalsRequired: null,
    approvalsGiven: 0,
    changesRequested: false,
    detailedMergeStatus: null,
    hasConflicts: false,
    issueKeys: [],
    latestNoteAt: null,
    lastReadAt: null,
    lastEventAt: null,
    lastEventSeenAt: null,
    updatedAt: 1_760_000_000_000,
    syncedAt: 1_760_000_000_000,
  });
  return { ...card, number };
}

/** A push to the card's PR — what `openPullRequest` calls on every one. */
const pushed = (card) =>
  requestAutoMerge(createPrDeps(), {
    project: store.getProject(project.id),
    owner: store.getTask(card.id),
    mr: { provider: 'github', projectPath: 'acme/web', number: card.number },
    token: TOKEN,
    settings: store.getSettings(),
  });

const comments = (taskId) =>
  store
    .getTaskActivity(taskId)
    .filter((e) => e.kind === 'comment')
    .map((e) => e.body);
const timeline = (taskId) => comments(taskId).join('\n');
const count = (taskId, prefix) => comments(taskId).filter((b) => b.startsWith(prefix)).length;

/** How many times a run on this task has emitted its empty, run-less patch. */
const exitCountFor = (taskId) =>
  taskChanges.filter((c) => c.task.id === taskId && c.runId === null).length;

/** Run a fix step's turn to the end, and wait until its process is gone. */
async function finishStepRun(n, stepId) {
  const before = exitCountFor(stepId);
  proceed(n);
  await waitFor('the fix step run to settle', () => exitCountFor(stepId) > before);
  await waitFor('the fix step process to exit', () => !alive(invocations()[n - 1].pid));
  // Its settle and exit bookkeeping are fire-and-forget; give them a beat to finish.
  await sleep(300);
}

const lightPair = (card) => {
  const all = store.attachmentsForTask(card.id);
  const real = all.find((a) => a.name === 'board-light.png');
  const mockup = all.find((a) => a.name === 'board-light-mockup.png');
  return { real: attachmentPath(project, real), mockup: attachmentPath(project, mockup) };
};

try {
  // =========================================================================================
  section('A. PR open to auto-merge armed, with no human click');

  const a = uiCard('A: header overlaps the board', 12);
  await pushed(a);
  check(
    'the push holds auto-merge for sign-off and says the AI reviewer is checking',
    timeline(a.id).includes('the AI reviewer is checking the shots'),
    timeline(a.id),
  );

  const review1 = await spawnNumber(1, 'the first review session to spawn');
  check('a review session started', isReview(review1), JSON.stringify(review1.argv));
  check(
    'it runs in plan mode',
    flag(review1, '--permission-mode') === 'plan',
    flag(review1, '--permission-mode'),
  );
  const disallowed = flag(review1, '--disallowedTools').split(',');
  check(
    '--disallowedTools takes Edit, Write and Bash away',
    ['Edit', 'Write', 'Bash'].every((t) => disallowed.includes(t)),
    disallowed.join(','),
  );
  check(
    'it is a FRESH session: --session-id, never --resume',
    flag(review1, '--session-id') !== '' && !has(review1, '--resume'),
    JSON.stringify(review1.argv),
  );
  const prompt1 = await promptFor(1, 'the review prompt');
  const paths = lightPair(a);
  check('the prompt quotes the rubric', prompt1.includes(AI_REVIEW_RUBRIC), prompt1.slice(0, 400));
  check("the prompt names the real shot's PNG path", prompt1.includes(paths.real), paths.real);
  check("the prompt names the mockup's PNG path", prompt1.includes(paths.mockup), paths.mockup);
  check(
    'a started note says round 1 of 2',
    timeline(a.id).includes('AI visual review started (round 1 of 2).'),
  );
  check('the reviewer knows it is reviewing', reviewer.isReviewing(a.id));

  // A second push while that review is still open must not start a second session.
  await pushed(a);
  await sleep(500);
  check(
    'a push mid-review starts no second session',
    invocations().length === 1,
    String(invocations().length),
  );

  proceed(1, NEEDS_CHANGES);
  await waitFor('the fix step to be added', () => store.getSubtasks(a.id).length === 1);
  const fixA = store.getSubtasks(a.id)[0];
  check(
    'the fix step is round 1, named for the review',
    fixA?.title === 'Fix the visual review findings (round 1)',
    fixA?.title,
  );
  check(
    'a needs-changes note carries the reason',
    comments(a.id).some(
      (b) => b.startsWith('AI visual review: needs changes (round 1 of 1)') && b.includes(REASON),
    ),
    timeline(a.id),
  );
  check(
    'needs-changes is a note, never a "Visual sign-off:" comment',
    count(a.id, 'Visual sign-off:') === 0,
  );
  const fixRunA = await spawnNumber(2, 'the fix step to start');
  check('the fix step runs as an ordinary session, not a review', !isReview(fixRunA));
  const fixPromptA = await promptFor(2, 'the fix step prompt');
  check(
    'the fix step was handed the reason',
    fixPromptA.includes(REASON),
    fixPromptA.slice(0, 400),
  );
  check('nothing was armed on GitHub yet', !armedFor(12));
  await finishStepRun(2, fixA.id);

  // The fix step's push — `openPullRequest` would call `requestAutoMerge` again.
  await pushed(a);
  const review2 = await spawnNumber(3, 'the second review session to spawn');
  check('the push started a second review', isReview(review2), JSON.stringify(review2.argv));
  check(
    'with a session of its own',
    flag(review2, '--session-id') !== '' &&
      flag(review2, '--session-id') !== flag(review1, '--session-id'),
  );
  check(
    'a started note says round 2 of 2',
    timeline(a.id).includes('AI visual review started (round 2 of 2).'),
  );

  proceed(3, APPROVE);
  await waitFor(
    'the AI approval and the forge note',
    () =>
      comments(a.id).includes('Visual sign-off: approved (AI reviewer)') &&
      timeline(a.id).includes('Auto-merge enabled'),
  );
  check(
    'the AI posted "Visual sign-off: approved (AI reviewer)"',
    comments(a.id).includes('Visual sign-off: approved (AI reviewer)'),
    timeline(a.id),
  );
  check(
    'GitHub was asked to enablePullRequestAutoMerge on #12',
    armedFor(12),
    JSON.stringify(fetchCalls.map((c) => c.method + ' ' + c.url)),
  );
  check(
    "with the project's squash method",
    fetchCalls.some((c) => c.url.endsWith('/graphql') && c.body.includes('SQUASH')),
  );
  check(
    'the "Auto-merge enabled" note followed',
    timeline(a.id).includes('Auto-merge enabled for #12'),
    timeline(a.id),
  );
  check('no Inbox question was raised', store.getTask(a.id).decisionQuestion == null);
  check(
    'three sessions in all: review, fix, review',
    invocations().length === 3,
    String(invocations().length),
  );
  check('only one fix step', store.getSubtasks(a.id).length === 1);

  // =========================================================================================
  section('B. The stub always answers needs-changes: the round cap stops it');

  const b = uiCard('B: header still overlaps', 13);
  const startB = invocations().length;
  const reviewsOfB = () => invocations().slice(startB).filter(isReview).length;

  await pushed(b);
  const b1 = startB + 1;
  check('the push started a review', isReview(await spawnNumber(b1, "B's first review")));
  proceed(b1, NEEDS_CHANGES);
  await waitFor("B's fix step", () => store.getSubtasks(b.id).length === 1);
  const fixB = store.getSubtasks(b.id)[0];
  const b2 = startB + 2;
  check('its fix step ran', !isReview(await spawnNumber(b2, "B's fix step run")));
  await finishStepRun(b2, fixB.id);

  await pushed(b);
  const b3 = startB + 3;
  check(
    'the fix push started a second review',
    isReview(await spawnNumber(b3, "B's second review")),
  );
  proceed(b3, NEEDS_CHANGES);
  await waitFor(
    'the gave-up note',
    () => count(b.id, 'AI visual review: stopped after') > 0,
    10000,
  );
  check(
    'the gave-up note is posted, with the reason',
    comments(b.id).some(
      (c) =>
        c.startsWith('AI visual review: stopped after 2 rounds — a human has to look.') &&
        c.includes(REASON),
    ),
    timeline(b.id),
  );
  const question = store.getTask(b.id).decisionQuestion;
  check(
    'decisionQuestion raises the card in the Inbox',
    typeof question === 'string' &&
      question.startsWith('AI visual review could not approve after 2 rounds'),
    String(question),
  );
  await sleep(750);
  check(
    'no second fix step was added',
    store.getSubtasks(b.id).length === 1,
    String(store.getSubtasks(b.id).length),
  );
  check(
    'no third session: review, fix, review',
    invocations().length === startB + 3,
    String(invocations().length - startB),
  );

  const before = invocations().length;
  await pushed(b);
  await sleep(1000);
  check(
    'a further requestAutoMerge starts nothing',
    invocations().length === before && reviewsOfB() === 2,
    `${invocations().length - before} new session(s), ${reviewsOfB()} review(s)`,
  );
  check(
    "and its hold note is the human's again",
    comments(b.id).at(-1)?.includes('press Approve in the Visual sign-off panel') === true,
    comments(b.id).at(-1),
  );
  check(
    'no AI sign-off and nothing armed for #13',
    count(b.id, 'Visual sign-off:') === 0 && !armedFor(13),
  );

  // =========================================================================================
  section("C. A human's Approve while a review is running");

  const c = uiCard('C: the human gets there first', 14);
  const startC = invocations().length;
  await pushed(c);
  const c1 = startC + 1;
  const reviewC = await spawnNumber(c1, "C's review");
  check('a review is running', isReview(reviewC) && reviewer.isReviewing(c.id));
  await promptFor(c1, "C's review prompt");

  await humanVisualSignOff(c.id, 'approved');
  check('the reviewer let the card go', !reviewer.isReviewing(c.id));
  await waitFor('the review process to be stopped', () => !alive(reviewC.pid));
  check('the review process was stopped', !alive(reviewC.pid), String(reviewC.pid));

  // The verdict it would have given — written anyway, in case anything still listens.
  proceed(c1, NEEDS_CHANGES);
  await sleep(1000);
  check(
    'its late result posted no needs-changes note',
    count(c.id, 'AI visual review: needs changes') === 0,
  );
  check('added no fix step', store.getSubtasks(c.id).length === 0);
  check('raised no Inbox question', store.getTask(c.id).decisionQuestion == null);
  check(
    "and the only sign-off is the human's",
    comments(c.id)
      .filter((b) => b.startsWith('Visual sign-off:'))
      .join('|') === 'Visual sign-off: approved',
    comments(c.id)
      .filter((b) => b.startsWith('Visual sign-off:'))
      .join('|'),
  );
  check('which armed auto-merge on #14', armedFor(14));
  check('no further session started', invocations().length === startC + 1);

  // The same rule when the result DOES land: a human sign-off reached the timeline some other
  // way (no cancel), and the review's verdict arrives after it.
  const d = uiCard('D: a sign-off from elsewhere', 15);
  const startD = invocations().length;
  await pushed(d);
  const d1 = startD + 1;
  check('a review is running for D', isReview(await spawnNumber(d1, "D's review")));
  await promptFor(d1, "D's review prompt");
  store.addComment(d.projectId, d.id, formatSignOff('approved'));
  proceed(d1, NEEDS_CHANGES);
  await waitFor("D's review to finish", () => !reviewer.isReviewing(d.id));
  await sleep(500);
  check(
    'a result landing after a human sign-off posts nothing',
    count(d.id, 'AI visual review: needs changes') === 0 &&
      store.getSubtasks(d.id).length === 0 &&
      store.getTask(d.id).decisionQuestion == null &&
      count(d.id, 'Visual sign-off:') === 1,
    timeline(d.id),
  );
} catch (err) {
  failures += 1;
  console.log('  FAIL  the scenario threw — ' + (err instanceof Error ? err.stack : String(err)));
}

// Kill every stub still waiting on a proceed file before the database is closed; the pause is
// for Windows, where a stub keeps its CWD locked until it is really gone.
scheduler.dispose();
sessions.stopAll();
await sleep(750);
store.close();

console.log('\n' + invocations().length + ' CLI invocation(s) observed.');
if (failures > 0) {
  console.error(failures + ' check(s) failed.');
  process.exit(1);
}
console.log('All checks passed.');
process.exit(0);
