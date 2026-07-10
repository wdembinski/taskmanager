// scripts/unblock-limit.cjs
// Clears a falsely-engaged usage-limit gate and re-queues its parked tasks.
// Run with the app CLOSED (SQLite lock), via Electron-as-node — better-sqlite3 is
// built for Electron's ABI, so plain `node` can't load it:
//   $env:ELECTRON_RUN_AS_NODE=1
//   & .\node_modules\electron\dist\electron.exe .\scripts\unblock-limit.cjs
const { existsSync } = require('node:fs');
const { join } = require('node:path');
const Database = require('better-sqlite3');

const appData = process.env.APPDATA || join(process.env.USERPROFILE || '', 'AppData', 'Roaming');
const candidates = [
  process.env.ORCHESTRATOR_DB,
  join(appData, 'claude-orchestrator', 'orchestrator.db'),
  join(appData, 'Claude Orchestrator', 'orchestrator.db'),
].filter(Boolean);

const dbPath = candidates.find((p) => existsSync(p));
if (!dbPath) {
  console.error('orchestrator.db not found. Tried:\n  ' + candidates.join('\n  '));
  console.error('Set ORCHESTRATOR_DB=<full path> and re-run.');
  process.exit(1);
}
console.log('DB:', dbPath);

const db = new Database(dbPath);
try {
  const row = db.prepare("SELECT value FROM app_state WHERE key = 'limitGate'").get();
  console.log('limitGate before:', row ? row.value : '(none)');
  db.prepare("DELETE FROM app_state WHERE key = 'limitGate'").run();
  const upd = db.prepare("UPDATE tasks SET status = 'pending' WHERE status = 'blocked-by-limit'").run();
  console.log(`Cleared gate; re-queued ${upd.changes} parked task(s) to pending.`);
  console.log('Relaunch the app and press Run — the banner is gone and tasks resume by sessionId.');
} finally {
  db.close();
}
