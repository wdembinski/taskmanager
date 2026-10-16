const path = require('path');
const dbPath = path.join(process.env.APPDATA, 'claude-orchestrator', 'orchestrator.db');
const Database = require('C:/Repositories/task-manager/apps/client/node_modules/better-sqlite3');
const db = new Database(dbPath, { readonly: true });
const rows = db.prepare("SELECT id, name, ticketPrefix, ticketSeq, kind FROM projects WHERE ticketPrefix IS NOT NULL").all();
console.log(JSON.stringify(rows, null, 2));
db.close();
