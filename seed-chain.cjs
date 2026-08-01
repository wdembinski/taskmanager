/*
 * Temporary: seed the DEMO profile with the four-card chain from the step-7 E2E script —
 * a fan-out from #1 into #2 and #3, fanning back in on #4 — so the board's arrows,
 * handles and "waiting on" chip can be looked at without driving the mouse.
 *
 * Run with:
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/electron.exe seed-chain.cjs
 *
 * Only touches ids prefixed `chain-`, so it is safe to re-run alongside seed-demo.cjs.
 */
const Database = require('better-sqlite3');
const path = require('path');

const dbPath =
  process.argv[2] || path.join(process.env.APPDATA, 'claude-orchestrator-demo', 'orchestrator.db');
const db = new Database(dbPath);
db.pragma('foreign_keys = ON');
const now = Date.now();

// Cascades clear task_links, so the cards go first.
db.prepare(`DELETE FROM tasks WHERE id LIKE 'chain-%'`).run();

const COLS = [
  'id', 'projectId', 'phase', 'title', 'status', 'sessionId', 'order', 'source',
  'isContract', 'isScaffold', 'externalPriority', 'agentProjectId', 'agentMode',
  'agentModel', 'description', 'landedAt', 'agentBranch',
];
const ins = db.prepare(`
  INSERT INTO tasks (${COLS.map((c) => (c === 'order' ? '"order"' : c)).join(', ')})
  VALUES (${COLS.map((c) => '@' + c).join(', ')})
`);

/** All four cards are delegated to the demo agent project, which has worktrees on. */
const card = (o) =>
  ins.run({
    projectId: 'personal', phase: 'Personal', status: 'pending', sessionId: null,
    source: 'adhoc', isContract: 0, isScaffold: 0, externalPriority: 'Highest',
    agentProjectId: 'demo-agent-repo', agentMode: 'acceptEdits', agentModel: 'sonnet',
    description: null, landedAt: null, agentBranch: null,
    ...o,
  });

// #1 has landed — so the arrows out of it are the "released" ones, and #2/#3 are free.
card({ id: 'chain-1', order: 901, title: 'CHAIN 1 — extract the shared types', status: 'done',
       landedAt: now - 3_600_000, agentBranch: 'orch/chain-1' });
card({ id: 'chain-2', order: 902, title: 'CHAIN 2 — port the parser onto them' });
card({ id: 'chain-3', order: 903, title: 'CHAIN 3 — port the writer onto them' });
// #4 is the join: it waits on BOTH arms, neither of which has landed.
card({ id: 'chain-4', order: 904, title: 'CHAIN 4 — wire the CLI to both' });
// A card on nobody's chain, so focus mode has something to hide.
card({ id: 'chain-solo', order: 905, title: 'CHAIN SOLO — unrelated card' });

const insLink = db.prepare(
  `INSERT INTO task_links (id, fromTaskId, toTaskId, gate, createdAt) VALUES (?, ?, ?, ?, ?)`,
);
// The fan-out, then the fan-in. #1→#2 is stacked so both gates are on screen at once.
insLink.run('chain-l1', 'chain-1', 'chain-2', 'stacked', now);
insLink.run('chain-l2', 'chain-1', 'chain-3', 'after-merge', now);
insLink.run('chain-l3', 'chain-2', 'chain-4', 'after-merge', now);
insLink.run('chain-l4', 'chain-3', 'chain-4', 'after-merge', now);

console.log('seeded:', db.prepare(`SELECT count(*) c FROM tasks WHERE id LIKE 'chain-%'`).get().c,
            'cards,', db.prepare(`SELECT count(*) c FROM task_links`).get().c, 'links');
db.close();
