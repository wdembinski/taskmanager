/**
 * Scavenge deleted cards — and their transcripts, comments, steps, arrows and attachments —
 * out of an `orchestrator.db` that no longer has rows for them.
 *
 * This is the RECOVERY half of "tasks disappear from the Kanban board". The other half stops the
 * bleeding (`archivedAt`, a sync that no longer deletes, a confirmation before a drop). This one
 * is for the cards that already went, before any of that landed.
 *
 * ## Why it can work at all
 *
 * SQLite does not erase a deleted row. `DELETE` unlinks the cell from its b-tree page and adds
 * its bytes to that page's free-block chain; a page that empties entirely goes onto the
 * database's free list with its content untouched. `secure_delete` is off — the default, and the
 * app never turns it on — so those bytes stay legible until something else needs the space. And
 * in WAL mode the `-wal` holds page images from BEFORE the delete as well as after: the frame
 * written when the row was inserted is still sitting there next to the frame that removed it.
 *
 * So there are three places a vanished card can still be:
 *
 *   1. the unallocated gap and the free-block chain inside a live leaf page;
 *   2. a page on the database free list, still holding whatever it held;
 *   3. any `-wal` frame, including superseded ones and ones from a previous WAL generation.
 *
 * This walks all three, decodes every byte offset that could begin a record, and keeps the ones
 * whose shape and values match `tasks`, `task_activity`, `task_events`, `task_links` or
 * `task_attachments`.
 *
 * ## Why the children come back by themselves
 *
 * `task_events` and `task_activity` key on `taskId` with **no foreign key** onto `tasks`. So a
 * scavenged transcript event or comment re-attaches to its card the moment that card exists
 * again — and a JIRA card comes back on the next sync under its original `jira-${issue.id}`.
 * That is why `--apply` inserts a child row even when its parent card is missing: it is not
 * garbage, it is a row waiting for the sync to catch up.
 *
 * ## What it cannot do
 *
 * It recovers what is still IN THE FILE. A page reused since the delete is gone — genuinely,
 * irrecoverably — and the odds fall with every minute the app keeps running. `printLimits()`
 * says so at the bottom of every report, because that is the one thing a person reading a
 * recovery report has to believe.
 *
 * So this is **best-effort, and it gets worse with time** — which is why nothing else in the
 * fix depends on it. It is not a backstop, and it must never be treated as one: no code path
 * may delete a card on the reasoning that this could dig it out again. Everything that keeps
 * a board honest (`archivedAt`, the confirm pass, the removal guard, the retention sweep) is
 * built to need no recovery at all, and this script exists for the one population they cannot
 * help — the cards that were already gone before any of it shipped.
 *
 * ## Running it
 *
 *   node scripts/recover-deleted-tasks.mjs <path/to/orchestrator.db>          # report only
 *   node scripts/recover-deleted-tasks.mjs <db> --json report.json            # machine-readable
 *   node scripts/recover-deleted-tasks.mjs <db> --apply <path/to/orchestrator.db>
 *
 * Read-only by default: it copies the database (and its `-wal`) to a scratch directory and never
 * opens the original for writing. `--apply` is the only path that writes, it takes a `.bak`
 * first, and everything it inserts goes in one transaction.
 *
 * It refuses a database that looks like a LIVE profile without `--force` — quit the app first,
 * both so the copy is coherent and because every write the app makes is another chance to reuse
 * the page your card is lying in.
 *
 * `scripts/verify-recovery.mjs` is the harness: it seeds a board, deletes a card with steps, a
 * transcript, comments, an arrow and an attachment, and asserts each class comes back — through a
 * live `-wal` and through a checkpointed main file — while a database nothing was deleted from
 * recovers nothing. Measured there and worth knowing: 48 MiB in about three seconds, and 48 MB of
 * pure random bytes appended to a real database yielded not one false positive.
 *
 * ## Dependencies
 *
 * The scan is plain Node with nothing imported beyond `node:*`: it parses the SQLite file format
 * itself, so it works against a database written by any version of the app, on a machine with
 * nothing installed, and even against a file too damaged to open. Only `--apply` needs a real
 * SQLite, and the `better-sqlite3` here is built for Electron's ABI — so when the addon will not
 * load under plain `node`, this re-executes itself under the bundled Electron binary with
 * `ELECTRON_RUN_AS_NODE=1` (the trick `scripts/verify-*.mjs` use) rather than expecting whoever
 * is recovering their board to know that.
 */
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// ---------------------------------------------------------------------------
// 1. The SQLite file format, as much of it as scavenging needs.
// ---------------------------------------------------------------------------

const SQLITE_MAGIC = 'SQLite format 3\0';

/**
 * One reusable varint result. A varint is read at nearly every byte offset of every page — tens
 * of millions of times on a real profile — and an object per call would dominate the run. Every
 * caller consumes both fields immediately, before reading another.
 */
const VARINT = { value: 0, size: 0 };

/**
 * Read a SQLite varint at `off` into `VARINT`. Returns `false` when it would run past `limit`,
 * which is how a scan rejects a bad offset.
 *
 * Values above `Number.MAX_SAFE_INTEGER` would lose precision, and nothing here can reach that:
 * serial types are bounded by the length of a column and rowids by how many rows the app has
 * ever written, both astronomically below 2^53.
 */
function readVarint(buf, off, limit) {
  let value = 0;
  for (let i = 0; i < 8; i += 1) {
    if (off + i >= limit) return false;
    const byte = buf[off + i];
    value = value * 128 + (byte & 0x7f);
    if ((byte & 0x80) === 0) {
      VARINT.value = value;
      VARINT.size = i + 1;
      return true;
    }
  }
  if (off + 8 >= limit) return false;
  VARINT.value = value * 256 + buf[off + 8];
  VARINT.size = 9;
  return true;
}

/** How many bytes of record body a serial type occupies. `-1` for the two reserved types. */
function serialSize(type) {
  if (type <= 4) return type; // 0 = NULL, 1..4 = 1..4-byte integers
  if (type === 5) return 6;
  if (type === 6 || type === 7) return 8;
  if (type === 8 || type === 9) return 0; // the constants 0 and 1, stored in the type itself
  if (type < 12) return -1; // 10 and 11 are reserved and never appear in a real record
  return (type - 12) >> 1; // 12+2n = BLOB of n bytes, 13+2n = TEXT of n bytes
}

// The storage classes, one bit each, so a column can say which of them it will accept.
const CLS_NULL = 1;
const CLS_INT = 2;
const CLS_REAL = 4;
const CLS_TEXT = 8;
const CLS_BLOB = 16;

/** The storage class a serial type produces, or `0` for the reserved types. */
function serialClass(type) {
  if (type === 0) return CLS_NULL;
  if (type === 7) return CLS_REAL;
  if (type <= 9) return CLS_INT; // 1..6 are integers, 8 and 9 are the constants 0 and 1
  if (type < 12) return 0;
  return type & 1 ? CLS_TEXT : CLS_BLOB;
}

/** Decode one column's body bytes. `off` is where the value starts. */
function decodeValue(buf, off, type) {
  switch (type) {
    case 0:
      return null;
    case 1:
      return buf.readInt8(off);
    case 2:
      return buf.readInt16BE(off);
    case 3:
      return (buf.readInt8(off) << 16) | buf.readUInt16BE(off + 1);
    case 4:
      return buf.readInt32BE(off);
    case 5:
      return buf.readInt16BE(off) * 2 ** 32 + buf.readUInt32BE(off + 2);
    case 6:
      return Number(buf.readBigInt64BE(off));
    case 7:
      return buf.readDoubleBE(off);
    case 8:
      return 0;
    case 9:
      return 1;
    default: {
      const size = serialSize(type);
      // Text is read as UTF-8; the header's encoding word is checked once, up front, rather
      // than asked about per value.
      return type & 1
        ? buf.toString('utf8', off, off + size)
        : Buffer.from(buf.subarray(off, off + size));
    }
  }
}

/** Parse the 100-byte file header. Throws if this is not a SQLite database at all. */
function parseHeader(db) {
  if (db.length < 100 || db.toString('latin1', 0, 16) !== SQLITE_MAGIC) {
    throw new Error('not a SQLite database (the 16-byte magic string is wrong)');
  }
  const raw = db.readUInt16BE(16);
  const pageSize = raw === 1 ? 65536 : raw;
  if (pageSize < 512 || (pageSize & (pageSize - 1)) !== 0) {
    throw new Error(`implausible page size ${pageSize}`);
  }
  return {
    pageSize,
    reserved: db[20],
    // The file's own length, not the header's page count: a database left behind by a crash can
    // have a stale count, and every page present is a page worth scanning.
    pageCount: Math.floor(db.length / pageSize),
    encoding: db.readUInt32BE(56),
    freelistTrunk: db.readUInt32BE(32),
    freelistCount: db.readUInt32BE(36),
  };
}

/**
 * Every page image the `-wal` holds, in file order, and which of them are current.
 *
 * A frame's salt pair identifies the WAL generation it belongs to. Frames whose salts do not
 * match the WAL header are left over from before the last reset — stale for reading the current
 * database, and some of the best scavenging material in the file. So they are returned too, and
 * simply not applied.
 */
function parseWal(wal, pageSize) {
  if (!wal || wal.length < 32) return { frames: [], malformed: false };
  const magic = wal.readUInt32BE(0);
  if (magic !== 0x377f0682 && magic !== 0x377f0683) return { frames: [], malformed: true };
  if (wal.readUInt32BE(8) !== pageSize) return { frames: [], malformed: true };
  const salt1 = wal.readUInt32BE(16);
  const salt2 = wal.readUInt32BE(20);
  const frames = [];
  const stride = 24 + pageSize;
  for (let off = 32; off + stride <= wal.length; off += stride) {
    frames.push({
      pgno: wal.readUInt32BE(off),
      // Non-zero on a commit frame, and then the database size in pages after that commit.
      dbSize: wal.readUInt32BE(off + 4),
      current: wal.readUInt32BE(off + 8) === salt1 && wal.readUInt32BE(off + 12) === salt2,
      data: wal.subarray(off + 24, off + 24 + pageSize),
    });
  }
  return { frames, malformed: false };
}

/**
 * Open a database file (and its `-wal`) for reading, and expose it two ways:
 *
 *   - `livePage(pgno)` — what the database says TODAY: the main file with the current WAL frames
 *     laid over it. Used to work out what is still there, so the report only claims rows that
 *     are genuinely missing.
 *   - `images()` — every page image in the file, current or not, wherever it is. Used to
 *     scavenge, because the whole point is the images that are no longer current.
 */
function openDatabaseFile(dbPath) {
  const db = readFileSync(dbPath);
  const header = parseHeader(db);
  const walPath = `${dbPath}-wal`;
  const wal = existsSync(walPath) ? readFileSync(walPath) : null;
  const { frames, malformed } = parseWal(wal, header.pageSize);

  // The last commit frame bounds what is really part of the database; anything past it belongs
  // to a transaction that never committed.
  let lastCommit = -1;
  for (let i = 0; i < frames.length; i += 1) {
    if (frames[i].current && frames[i].dbSize !== 0) lastCommit = i;
  }
  const overlay = new Map();
  for (let i = 0; i <= lastCommit; i += 1) {
    if (frames[i].current) overlay.set(frames[i].pgno, frames[i].data);
  }

  function mainPage(pgno) {
    const start = (pgno - 1) * header.pageSize;
    if (pgno < 1 || start + header.pageSize > db.length) return null;
    return db.subarray(start, start + header.pageSize);
  }

  function livePage(pgno) {
    return overlay.get(pgno) ?? mainPage(pgno);
  }

  /** The database's free list, as a set of page numbers — for the report, not for the scan. */
  function freelistPages() {
    const pages = new Set();
    const seen = new Set();
    let trunk = header.freelistTrunk;
    while (trunk > 0 && !seen.has(trunk)) {
      seen.add(trunk);
      const page = livePage(trunk);
      if (!page) break;
      pages.add(trunk);
      const count = page.readUInt32BE(4);
      for (let i = 0; i < count && 8 + i * 4 + 4 <= page.length; i += 1) {
        pages.add(page.readUInt32BE(8 + i * 4));
      }
      trunk = page.readUInt32BE(0);
    }
    return pages;
  }

  /**
   * Every page image worth scanning, oldest first: the main file, then the WAL frames in order.
   *
   * `seq` counts them, and that ordering is a real claim rather than an accident of iteration. A
   * WAL frame is by definition a page the main file has not caught up with yet, and frame N+1 was
   * written after frame N — so when the same row turns up in several images, the highest `seq`
   * holds the last state it was in before it was deleted. That is the copy to keep.
   */
  function* images() {
    let seq = 0;
    for (let pgno = 1; pgno <= header.pageCount; pgno += 1) {
      const page = mainPage(pgno);
      if (page) yield { pgno, page, source: 'db', seq: (seq += 1) };
    }
    for (let i = 0; i < frames.length; i += 1) {
      yield {
        pgno: frames[i].pgno,
        page: frames[i].data,
        source: frames[i].current ? `wal#${i}` : `wal#${i} (stale)`,
        seq: (seq += 1),
      };
    }
  }

  return {
    header,
    walFrames: frames.length,
    walStaleFrames: frames.filter((f) => !f.current).length,
    walMalformed: malformed,
    hasWal: Boolean(wal),
    byteLength: db.length,
    livePage,
    freelistPages,
    images,
  };
}

/**
 * Walk a table b-tree from `rootPgno` and hand each live row's record bytes to `visit`.
 *
 * Only ever run against `livePage`, and only to learn what the database still has. Cells whose
 * payload spills onto overflow pages are handed over truncated: every column needed to identify
 * a row (the ids, the timestamps) sits at the front of the record, well inside the portion that
 * stays on the page.
 */
function walkTable(file, rootPgno, visit) {
  const usable = file.header.pageSize - file.header.reserved;
  const maxLocal = usable - 35;
  const minLocal = Math.floor(((usable - 12) * 32) / 255) - 23;
  const stack = [rootPgno];
  const seen = new Set();
  while (stack.length > 0) {
    const pgno = stack.pop();
    if (pgno < 1 || seen.has(pgno)) continue;
    seen.add(pgno);
    const page = file.livePage(pgno);
    if (!page) continue;
    const base = pgno === 1 ? 100 : 0;
    const type = page[base];
    if (type === 0x05) {
      const cells = page.readUInt16BE(base + 3);
      stack.push(page.readUInt32BE(base + 8)); // the rightmost child
      for (let i = 0; i < cells; i += 1) {
        const at = page.readUInt16BE(base + 12 + i * 2);
        if (at + 4 <= page.length) stack.push(page.readUInt32BE(at));
      }
    } else if (type === 0x0d) {
      const cells = page.readUInt16BE(base + 3);
      for (let i = 0; i < cells; i += 1) {
        const at = page.readUInt16BE(base + 8 + i * 2);
        if (at <= 0 || at >= page.length) continue;
        let cursor = at;
        if (!readVarint(page, cursor, page.length)) continue;
        const payload = VARINT.value;
        cursor += VARINT.size;
        if (!readVarint(page, cursor, page.length)) continue;
        cursor += VARINT.size;
        let local = payload;
        if (payload > maxLocal) {
          const k = minLocal + ((payload - minLocal) % (usable - 4));
          local = k <= maxLocal ? k : minLocal;
        }
        visit(page, cursor, Math.min(cursor + local, page.length));
      }
    }
  }
}

/**
 * Decode a record that starts with its header-size varint — the normal, undamaged case. Returns
 * the decoded values (short, if the payload was truncated by overflow) or `null`.
 */
function decodeRecordAt(page, start, limit) {
  if (!readVarint(page, start, limit)) return null;
  const headerEnd = start + VARINT.value;
  let cursor = start + VARINT.size;
  if (headerEnd > limit || headerEnd < cursor) return null;
  const types = [];
  while (cursor < headerEnd) {
    if (!readVarint(page, cursor, limit)) return null;
    types.push(VARINT.value);
    cursor += VARINT.size;
  }
  if (cursor !== headerEnd) return null;
  const values = [];
  for (const type of types) {
    const size = serialSize(type);
    if (size < 0 || cursor + size > limit) break;
    values.push(decodeValue(page, cursor, type));
    cursor += size;
  }
  return values;
}

// ---------------------------------------------------------------------------
// 2. The schema, read out of the file being scavenged.
// ---------------------------------------------------------------------------

/**
 * The column list of one table, taken from the `CREATE TABLE` text in `sqlite_master`.
 *
 * Read from the file rather than hardcoded, because `tasks` has been ALTERed a dozen times and a
 * database written by an older build has fewer columns than today's schema. A scavenger that
 * assumed today's column count would find nothing in yesterday's file.
 */
function parseCreateTable(sql) {
  const open = sql.indexOf('(');
  const close = sql.lastIndexOf(')');
  if (open < 0 || close < open) return [];
  // Split on commas at paren depth zero, so `UNIQUE (taskId, name)` stays one piece.
  const parts = [];
  let depth = 0;
  let current = '';
  for (const ch of sql.slice(open + 1, close)) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) {
      parts.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  parts.push(current);

  const columns = [];
  for (const part of parts) {
    // The app's DDL is full of `--` commentary; strip it before anything else.
    const text = part
      .split('\n')
      .map((line) => line.replace(/--.*$/, ''))
      .join(' ')
      .trim()
      .replace(/\s+/g, ' ');
    if (!text) continue;
    if (/^(UNIQUE|PRIMARY|FOREIGN|CHECK|CONSTRAINT)\b/i.test(text)) continue;
    const match = /^("([^"]+)"|`([^`]+)`|\[([^\]]+)\]|(\w+))\s*(.*)$/.exec(text);
    if (!match) continue;
    const rest = match[6] ?? '';
    // The FIRST word only. `INTEGER PRIMARY KEY AUTOINCREMENT` is all letters and spaces, so a
    // greedier match swallows the constraint into the type name — and then `INTEGER PRIMARY KEY`
    // never equals `INTEGER`, no column is recognised as a rowid alias, and the anchor that
    // recovers a row whose first serial type was clobbered is silently never built.
    const typeName = (/^([A-Za-z]+)/.exec(rest)?.[1] ?? '').toUpperCase();
    columns.push({
      name: match[2] ?? match[3] ?? match[4] ?? match[5],
      type: typeName,
      notNull: /\bNOT NULL\b/i.test(rest),
      // An INTEGER PRIMARY KEY is an alias for the rowid: the record stores NULL in its place and
      // the real value lives in the cell header. The most useful single fact about the shape of
      // `task_events` and `task_activity`, because it pins their first serial type to one byte.
      rowidAlias: typeName === 'INTEGER' && /\bPRIMARY KEY\b/i.test(rest),
    });
  }
  return columns;
}

/** Read `sqlite_master` straight out of the page images — no SQLite engine involved. */
function readSchema(file) {
  const tables = new Map();
  walkTable(file, 1, (page, start, limit) => {
    const values = decodeRecordAt(page, start, limit);
    if (!values || values.length < 5) return;
    const [type, name, , rootpage, sql] = values;
    if (type !== 'table' || typeof name !== 'string' || typeof sql !== 'string') return;
    tables.set(name, { name, rootpage, sql, columns: parseCreateTable(sql) });
  });
  return tables;
}

// ---------------------------------------------------------------------------
// 3. What a recoverable row looks like.
// ---------------------------------------------------------------------------

// Every status the app has ever written to `tasks.status` (see `@shared/model`). A column with
// eleven legal values is the strongest single filter in the whole scan: random bytes essentially
// never spell one of these at exactly the right offset.
const TASK_STATUSES = new Set([
  'pending',
  'in-progress',
  'in-review',
  'blocked',
  'running',
  'waiting-input',
  'blocked-by-limit',
  'done',
  'failed',
  'stopped',
  'cancelled',
]);
const ACTIVITY_KINDS = new Set(['comment', 'chat', 'status-note', 'status']);
const LINK_GATES = new Set(['after-merge', 'stacked']);

// Timestamps outside this window are not this app's. Generous on purpose — a clock-skewed
// machine still gets its cards back — but narrow enough to reject a random 8-byte integer.
const MIN_TIME = Date.UTC(2020, 0, 1);
const MAX_TIME = Date.UTC(2100, 0, 1);

const isTimestamp = (v) =>
  typeof v === 'number' && Number.isInteger(v) && v >= MIN_TIME && v <= MAX_TIME;
/** An id the app mints: a UUID, a `jira-<id>`, or a built-in name like `personal`. */
const isId = (v) =>
  typeof v === 'string' && v.length >= 1 && v.length <= 200 && /^[\x21-\x7e]+$/.test(v);
/** Free text a human or JIRA wrote. The control characters are what decoded garbage looks like. */
const isText = (v) => typeof v === 'string' && !/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(v);
const isCount = (v) => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 1e9;

/**
 * The five tables worth scavenging, and how to tell one of their records from noise.
 *
 * `core` is the prefix of columns a record must have decoded in full before it counts as a find.
 * Anything past it may be missing — a `tasks` row whose JIRA description spilled onto an overflow
 * page is still a card worth having back, with its id, its title and its status intact.
 *
 * `minColumns` is how short a record may legitimately be. It is only below the current column
 * count for `tasks`, which has been ALTERed repeatedly: SQLite omits trailing columns added after
 * a row was written, so an old card genuinely has fewer serial types than the schema.
 *
 * `identity` is what makes a row the same row across the main file, four WAL frames and a second
 * run of `--apply`. `identityColumns` is the same thing said to SQL, so asking a live database
 * whether it already has a row does not mean loading every transcript event in it.
 */
const TARGETS = [
  {
    table: 'tasks',
    core: ['id', 'projectId', 'phase', 'title', 'status', 'order'],
    minColumns: 6,
    validate: {
      id: isId,
      projectId: isId,
      phase: isText,
      title: isText,
      status: (v) => TASK_STATUSES.has(v),
      order: (v) => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 1e6,
    },
    identity: (row) => `tasks ${row.id}`,
    identityColumns: ['id'],
    taskId: (row) => row.id,
  },
  {
    table: 'task_activity',
    core: ['id', 'projectId', 'taskId', 'kind', 'body', 'fromStatus', 'toStatus', 'createdAt'],
    validate: {
      projectId: isId,
      taskId: isId,
      kind: (v) => ACTIVITY_KINDS.has(v),
      body: (v) => v === null || isText(v),
      fromStatus: (v) => v === null || TASK_STATUSES.has(v),
      toStatus: (v) => v === null || TASK_STATUSES.has(v),
      createdAt: isTimestamp,
    },
    identity: (row) => `task_activity ${row.taskId} ${row.createdAt} ${row.kind} ${hash(row.body)}`,
    identityColumns: ['taskId', 'createdAt', 'kind', 'body'],
    taskId: (row) => row.taskId,
    rowidTable: true,
  },
  {
    table: 'task_events',
    core: ['id', 'projectId', 'taskId', 'runId', 'event', 'createdAt'],
    validate: {
      projectId: isId,
      taskId: isId,
      runId: isId,
      // `appendTaskEvent` stores `JSON.stringify(event)`, so every legitimate value is an object
      // literal. Cheap, and it rules out the byte runs that happen to decode as text.
      event: (v) => typeof v === 'string' && v.startsWith('{') && v.endsWith('}'),
      createdAt: isTimestamp,
    },
    identity: (row) => `task_events ${row.taskId} ${row.createdAt} ${hash(row.event)}`,
    identityColumns: ['taskId', 'createdAt', 'event'],
    taskId: (row) => row.taskId,
    rowidTable: true,
  },
  {
    table: 'task_links',
    core: ['id', 'fromTaskId', 'toTaskId', 'gate', 'createdAt'],
    validate: {
      id: isId,
      fromTaskId: isId,
      toTaskId: isId,
      gate: (v) => LINK_GATES.has(v),
      createdAt: isTimestamp,
    },
    identity: (row) => `task_links ${row.id}`,
    identityColumns: ['id'],
    taskId: (row) => row.fromTaskId,
  },
  {
    table: 'task_attachments',
    core: ['id', 'taskId', 'name', 'fileName', 'mimeType', 'size', 'createdAt'],
    validate: {
      id: isId,
      taskId: isId,
      name: isText,
      fileName: isText,
      mimeType: (v) => v === null || isText(v),
      size: isCount,
      createdAt: isTimestamp,
    },
    identity: (row) => `task_attachments ${row.id}`,
    identityColumns: ['id'],
    taskId: (row) => row.taskId,
  },
];

/** FNV-1a over a string, so a long transcript event can key a Map without being one. */
function hash(value) {
  if (value === null || value === undefined) return '-';
  const text = String(value);
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${text.length}:${h.toString(36)}`;
}

/**
 * Turn a target plus the file's own column list into the anchors the scan matches against.
 *
 * An **anchor** is "a serial-type array starts at this byte, and it describes columns
 * `startColumn` onwards". There are usually two per table, and the second one is the reason this
 * recovers anything at all from a checkpointed database.
 *
 * When SQLite frees a cell it writes a 4-byte free-block header over the FIRST four bytes of that
 * cell. A cell begins with its payload-length and rowid varints, so those four bytes cover the
 * cell header and then bite into the record — usually taking the record's header-size varint, and
 * on a short row the first serial type with it. So the scan never relies on the header-size
 * varint (it starts at the serial types, and treats a matching header byte as corroboration), and
 * for a table whose first column is a rowid alias it also offers an anchor that assumes that byte
 * is the casualty. A rowid alias always stores NULL, which occupies no body bytes, so nothing
 * downstream shifts when it is inferred rather than read.
 */
function buildAnchors(target, columns) {
  const index = new Map(columns.map((c, i) => [c.name, i]));
  for (const name of target.core) {
    if (!index.has(name)) return []; // this file's schema predates the table as we know it
  }
  const masks = columns.map((column) => {
    if (column.rowidAlias) return CLS_NULL;
    let mask = column.type.includes('INT') ? CLS_INT : CLS_TEXT;
    if (!column.notNull) mask |= CLS_NULL;
    // A validator that rejects null says more than the DDL does. `tasks.id` is a TEXT PRIMARY
    // KEY, which SQLite leaves nullable, but the app has never written a card without one — and
    // dropping CLS_NULL there stops the scan trying `tasks` at every zero byte in the file.
    const check = target.validate[column.name];
    if (check && !check(null)) mask &= ~CLS_NULL;
    return mask;
  });
  const coreEnd = Math.max(...target.core.map((name) => index.get(name))) + 1;
  const minColumns = Math.max(target.minColumns ?? columns.length, coreEnd);

  const starts = columns[0].rowidAlias ? [0, 1] : [0];
  return starts.map((startColumn) => ({
    target,
    columns,
    startColumn,
    masks: masks.slice(startColumn),
    minTypes: minColumns - startColumn,
    maxTypes: columns.length - startColumn,
    coreEnd,
    // Which first bytes are worth trying at all. One byte comparison rejects most of the file
    // before any varint is read, and it is the difference between a scan that takes seconds and
    // one that takes minutes.
    firstByte: firstByteFilter(masks[startColumn]),
  }));
}

/**
 * The plausible first serial-type bytes for a column of the given class.
 *
 * For a rowid alias that is exactly `0x00`. For text it is the odd single-byte serial types
 * covering strings of 3 to 57 characters — every id, key, status, kind and gate this app writes
 * as a first column falls inside that. A first column longer than 57 characters would need a
 * two-byte serial type and is not something the app produces.
 */
function firstByteFilter(mask) {
  const allowed = new Uint8Array(256);
  if (mask & CLS_NULL) allowed[0] = 1;
  if (mask & CLS_INT) for (let t = 1; t <= 9; t += 1) allowed[t] = 1;
  if (mask & CLS_REAL) allowed[7] = 1;
  if (mask & CLS_TEXT) for (let t = 19; t <= 127; t += 2) allowed[t] = 1;
  if (mask & CLS_BLOB) for (let t = 18; t <= 126; t += 2) allowed[t] = 1;
  return allowed;
}

// ---------------------------------------------------------------------------
// 4. The scan.
// ---------------------------------------------------------------------------

/** Scratch arrays, sized once for the widest table and reused at every offset. */
const MAX_COLUMNS = 128;
const typeAt = new Int32Array(MAX_COLUMNS);
const typeEnd = new Int32Array(MAX_COLUMNS + 1);
const bodyBefore = new Int32Array(MAX_COLUMNS + 1);

/**
 * Try to read a record at `start` under one anchor. Returns the decoded row, or `null`.
 *
 * The record's column count is not known up front — a `tasks` row written by an older build has
 * fewer columns than the schema — so the serial types are read greedily and then every plausible
 * count is tried, longest first. Changing the count moves the whole body, and only one placement
 * can put the `status` string where it spells a real status, which is what makes trying them all
 * safe rather than merely convenient.
 */
function matchAt(page, start, limit, anchor) {
  const { masks, minTypes, maxTypes } = anchor;
  let cursor = start;
  let read = 0;
  while (read < maxTypes) {
    if (!readVarint(page, cursor, limit)) break;
    const type = VARINT.value;
    const size = serialSize(type);
    if (size < 0 || (serialClass(type) & masks[read]) === 0) break;
    typeAt[read] = type;
    cursor += VARINT.size;
    typeEnd[read] = cursor;
    bodyBefore[read + 1] = bodyBefore[read] + size;
    read += 1;
  }
  if (read < minTypes) return null;

  for (let n = read; n >= minTypes; n -= 1) {
    const match = tryColumnCount(page, limit, anchor, n);
    if (match) return match;
  }
  return null;
}

/** One candidate column count: place the body, decode what fits, and check every value. */
function tryColumnCount(page, limit, anchor, n) {
  const { target, columns, startColumn, coreEnd } = anchor;
  const coreTypes = coreEnd - startColumn;
  if (coreTypes > n) return null;
  const bodyStart = typeEnd[n - 1];
  // The core columns have to be present in full, or there is no row worth reporting.
  if (bodyStart + bodyBefore[coreTypes] > limit) return null;

  const row = {};
  let cursor = bodyStart;
  let truncated = false;
  for (let i = 0; i < n; i += 1) {
    const type = typeAt[i];
    const size = serialSize(type);
    if (cursor + size > limit) {
      truncated = true;
      break;
    }
    const column = columns[startColumn + i];
    row[column.name] = column.rowidAlias ? null : decodeValue(page, cursor, type);
    cursor += size;
  }
  // A rowid alias the anchor inferred rather than read is simply absent from the record.
  if (startColumn > 0) row[columns[0].name] = null;

  for (const [name, check] of Object.entries(target.validate)) {
    if (!check(row[name] ?? null)) return null;
  }
  return { row, truncated, typesEnd: bodyStart, end: cursor };
}

/**
 * Look backwards from a matched record for the cell header SQLite wrote in front of it.
 *
 * When it is still there — on a free-list page, in a stale WAL frame, anywhere the free-block
 * header did not reach — it yields the row's original rowid, and it corroborates the match: the
 * payload length has to agree, to the byte, with the record the scan just decoded. A missing
 * header is common and is not a reason to discard the row.
 */
function recoverCellHeader(page, typeStart, typesEnd, recordEnd) {
  for (let headerVarint = 1; headerVarint <= 2; headerVarint += 1) {
    const recordStart = typeStart - headerVarint;
    if (recordStart < 0) continue;
    if (!readVarint(page, recordStart, page.length)) continue;
    if (VARINT.size !== headerVarint) continue;
    if (recordStart + VARINT.value !== typesEnd) continue;
    // The header survived. The cell in front of it is `payload-length varint`, `rowid varint`.
    const payload = recordEnd - recordStart;
    for (let back = 2; back <= 18; back += 1) {
      const cellStart = recordStart - back;
      if (cellStart < 0) break;
      if (!readVarint(page, cellStart, page.length)) continue;
      if (VARINT.value !== payload) continue;
      const afterPayload = cellStart + VARINT.size;
      if (!readVarint(page, afterPayload, page.length)) continue;
      if (afterPayload + VARINT.size !== recordStart) continue;
      return { rowid: VARINT.value, confirmed: true };
    }
    return { rowid: null, confirmed: true };
  }
  return { rowid: null, confirmed: false };
}

/**
 * Sweep every page image for records matching any anchor, and hand each hit to `emit`.
 *
 * Deliberately byte by byte rather than a walk of each page's free-block chain. A freed cell can
 * be anywhere: in the unallocated gap above the cell-content area, in a free block between live
 * cells, in a page handed back to the free list whole, or in a WAL frame that no longer describes
 * anything. One sweep covers all of them under one rule — and the live rows it also finds are not
 * waste, they are the scan's own proof that it can read this file, reported as the "recognised"
 * figure.
 */
function scan(file, anchors, emit) {
  const byByte = new Array(256).fill(null);
  for (const anchor of anchors) {
    for (let b = 0; b < 256; b += 1) {
      if (anchor.firstByte[b]) (byByte[b] ??= []).push(anchor);
    }
  }

  for (const image of file.images()) {
    const page = image.page;
    const limit = page.length;
    // Page 1 opens with the 100-byte file header; nothing there is a record.
    for (let off = image.pgno === 1 ? 100 : 0; off < limit; off += 1) {
      const candidates = byByte[page[off]];
      if (candidates === null) continue;
      for (const anchor of candidates) {
        const match = matchAt(page, off, limit, anchor);
        if (!match) continue;
        const cell = recoverCellHeader(page, off, match.typesEnd, match.end);
        emit(anchor.target, match.row, {
          truncated: match.truncated,
          rowid: cell.rowid,
          confirmed: cell.confirmed,
          source: image.source,
          pgno: image.pgno,
          seq: image.seq,
        });
        // One anchor matching at an offset is enough; a second reading of the same bytes would
        // be the same row twice.
        break;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 5. What the database still has.
// ---------------------------------------------------------------------------

/** The identities of every row still live in the file, per target table. */
function readLive(file, schema) {
  const live = new Map();
  for (const target of TARGETS) {
    const identities = new Set();
    const table = schema.get(target.table);
    if (table) {
      walkTable(file, table.rootpage, (page, start, end) => {
        const values = decodeRecordAt(page, start, end);
        if (!values) return;
        const row = {};
        table.columns.forEach((column, i) => {
          row[column.name] = values[i] ?? null;
        });
        identities.add(target.identity(row));
      });
    }
    live.set(target.table, identities);
  }
  return live;
}

// ---------------------------------------------------------------------------
// 6. Attachments whose bytes outlived their rows.
// ---------------------------------------------------------------------------

/**
 * Extension → content type, for a directory of files being re-adopted as rows.
 *
 * A deliberate copy of `MIME_BY_EXTENSION` in `src/main/attachmentPaths.ts` rather than an import
 * of it. This script has to run standalone — copied onto a machine, pointed at a profile, with no
 * build, no `node_modules`, possibly no repository at all — and a recovery tool that only works
 * inside its own checkout is a recovery tool that is missing when it is needed. The column is
 * nullable and only picks an icon and whether the pane previews the file, so a suffix that is not
 * here costs nothing but a generic icon.
 */
const MIME_BY_EXTENSION = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  svg: 'image/svg+xml',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  txt: 'text/plain',
  log: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  json: 'application/json',
  xml: 'application/xml',
  yaml: 'application/yaml',
  yml: 'application/yaml',
  html: 'text/html',
  htm: 'text/html',
  css: 'text/css',
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  zip: 'application/zip',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
};

function mimeForExtension(name) {
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return null;
  return MIME_BY_EXTENSION[name.slice(dot + 1).toLowerCase()] ?? null;
}

/**
 * Turn `attachments/<taskId>/` directories that nothing points at back into rows.
 *
 * The bytes were never in danger. `ON DELETE CASCADE` reaches `task_attachments` and stops there,
 * because no cascade reaches the filesystem — so a card whose rows are gone very often still has
 * every file it carried, sitting under its own task id, waiting to be described again.
 *
 * A file is only adopted when neither the live database nor the scavenged rows already account
 * for it, so this never invents a duplicate of a row that came back on its own.
 */
function adoptOrphanAttachments(profileDir, accountedFor) {
  const root = join(profileDir, 'attachments');
  if (!existsSync(root)) return [];
  const adopted = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(root, entry.name);
    for (const file of readdirSync(dir, { withFileTypes: true })) {
      if (!file.isFile()) continue;
      if (accountedFor.has(`${entry.name} ${file.name.toLowerCase()}`)) continue;
      const stat = statSync(join(dir, file.name));
      adopted.push({
        id: randomUUID(),
        taskId: entry.name,
        name: file.name,
        fileName: file.name,
        mimeType: mimeForExtension(file.name),
        size: stat.size,
        // The row's own `createdAt` went with it. The file's mtime is the closest thing left to
        // when it was attached, and it keeps the card's timeline in a sane order.
        createdAt: Math.round(stat.mtimeMs),
      });
    }
  }
  return adopted;
}

// ---------------------------------------------------------------------------
// 7. Writing it back.
// ---------------------------------------------------------------------------

/**
 * Load `better-sqlite3`, re-executing under the bundled Electron if the addon will not load here.
 *
 * The repository's copy is built for Electron's ABI (`pnpm ensure:abi`), so plain `node` cannot
 * open it. Only `--apply` needs a SQL engine at all, and the middle of a board recovery is a poor
 * time to teach anyone about native module ABIs.
 */
function loadSqlite() {
  try {
    const Database = require('better-sqlite3');
    // `require` alone proves nothing: better-sqlite3 loads its native addon lazily, inside the
    // constructor, so a wrong-ABI addon sails through the import and then throws in the middle of
    // `--apply` — after the report has been printed and the `.bak` taken. Open one throwaway
    // in-memory database here, where the failure can still be answered with a relaunch.
    new Database(':memory:').close();
    return Database;
  } catch (error) {
    if (process.env.RECOVER_DELETED_TASKS_RELAUNCHED === '1') throw error;
    const electron = ['electron.exe', 'electron']
      .map((name) => join(repo, 'node_modules', 'electron', 'dist', name))
      .find((path) => existsSync(path));
    if (!electron) {
      throw new Error(
        `better-sqlite3 will not load under this runtime (${error.message}), and there is no ` +
          `Electron binary in node_modules to fall back to. Run --apply under the Electron that ` +
          `built the addon, or run \`pnpm install\` first.`,
      );
    }
    log(`(better-sqlite3 is built for Electron's ABI — re-running under ${basename(electron)})`);
    const result = spawnSync(electron, [fileURLToPath(import.meta.url), ...process.argv.slice(2)], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', RECOVER_DELETED_TASKS_RELAUNCHED: '1' },
      stdio: 'inherit',
    });
    process.exit(result.status ?? 1);
  }
}

/** SQLite takes numbers, strings, buffers and null — booleans and `undefined` it does not. */
function normalize(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  return value;
}

/**
 * Insert what is missing into a live database, in one transaction, after taking a `.bak`.
 *
 * Foreign keys are OFF for the duration, on purpose. `task_links` and `task_attachments` DO have
 * a real key onto `tasks`, and a child whose card has not been re-synced yet would be refused by
 * it — but that child is not garbage, it is a row waiting for the next JIRA sync to re-create the
 * card under the same `jira-${issue.id}` it left under. `PRAGMA foreign_key_check` runs
 * afterwards and the dangling rows are counted in the output, so nothing is left implicit.
 * `--skip-dangling` declines the trade and inserts only children whose card is present.
 */
function apply(Database, livePath, byTable, options) {
  const backup = `${livePath}.bak`;
  copyFileSync(livePath, backup);
  if (existsSync(`${livePath}-wal`)) {
    copyFileSync(`${livePath}-wal`, `${backup}-wal`);
    log(`  ! ${basename(livePath)} has a -wal beside it, so something may still have it open.`);
  }
  log(`  Backed up to ${backup}`);

  const db = new Database(livePath);
  db.pragma('foreign_keys = OFF');

  const inserted = {};
  const skipped = {};
  let dangling = 0;
  const statements = new Map();
  const prepare = (sql) => {
    let statement = statements.get(sql);
    if (!statement) statements.set(sql, (statement = db.prepare(sql)));
    return statement;
  };

  const run = db.transaction(() => {
    const liveTaskIds = new Set(db.prepare('SELECT id FROM tasks').pluck().all());

    for (const target of TARGETS) {
      inserted[target.table] = 0;
      skipped[target.table] = 0;
      const rows = byTable.get(target.table) ?? [];
      if (rows.length === 0) continue;
      const columns = db
        .prepare(`PRAGMA table_info(${JSON.stringify(target.table)})`)
        .all()
        .map((c) => c.name);
      if (columns.length === 0) {
        skipped[target.table] = rows.length;
        continue;
      }

      // What is already there. Streamed rather than collected, because `task_events.event` can be
      // most of the database and only its hash is wanted.
      const existing = new Set();
      const quotedIdentity = target.identityColumns.map((n) => JSON.stringify(n)).join(', ');
      for (const row of db.prepare(`SELECT ${quotedIdentity} FROM ${target.table}`).iterate()) {
        existing.add(target.identity(row));
      }
      const usedRowids = target.rowidTable
        ? new Set(db.prepare(`SELECT id FROM ${target.table}`).pluck().all())
        : null;

      for (const candidate of rows) {
        const row = candidate.row;
        if (existing.has(target.identity(row))) {
          skipped[target.table] += 1;
          continue;
        }
        if (target.table !== 'tasks' && !liveTaskIds.has(target.taskId(row))) {
          if (options.skipDangling) {
            skipped[target.table] += 1;
            continue;
          }
          dangling += 1;
        }
        // Only the columns this database actually has, and only the ones the record carried: an
        // omitted column takes the schema's default, which is exactly right both for a truncated
        // row and for one written before a migration added the column.
        const names = columns.filter((name) => row[name] !== undefined);
        const values = names.map((name) => normalize(row[name]));
        if (target.rowidTable && candidate.rowid !== null && !usedRowids.has(candidate.rowid)) {
          names.push('id');
          values.push(candidate.rowid);
          usedRowids.add(candidate.rowid);
        }
        const quoted = names.map((name) => JSON.stringify(name)).join(', ');
        const holes = names.map(() => '?').join(', ');
        prepare(`INSERT INTO ${target.table} (${quoted}) VALUES (${holes})`).run(values);
        existing.add(target.identity(row));
        inserted[target.table] += 1;
        if (target.table === 'tasks') liveTaskIds.add(row.id);
      }
    }
  });
  run();

  const violations = db.pragma('foreign_key_check');
  db.close();
  return { inserted, skipped, dangling, violations: violations.length };
}

// ---------------------------------------------------------------------------
// 8. The report.
// ---------------------------------------------------------------------------

function log(message = '') {
  process.stdout.write(`${message}\n`);
}

/**
 * The paragraph every report ends with. Not a disclaimer — the operational instruction that
 * matters most, printed last because it is what a person should act on whether the run found
 * forty cards or none.
 */
function printLimits(offerApply) {
  log('');
  log('What this cannot do');
  log('-------------------');
  log('  It recovers what is STILL IN THE FILE. A deleted row survives only until SQLite needs');
  log('  its page for something else; once that space is reused the bytes are gone, and no tool');
  log('  can bring them back. The odds fall with every minute the app keeps running, because');
  log('  every sync, comment and transcript line is another write looking for a page.');
  log('');
  log('  So: if cards are missing, QUIT THE APP FIRST and take a copy of the profile, then run');
  log('  this. A card this run did not find may simply have been overwritten — a clean report is');
  log('  not proof that nothing was ever deleted.');
  log('');
  log('  Rows whose payload spilled onto an overflow page come back truncated: the long fields');
  log('  (a JIRA description, a large transcript event) are on a page this scan cannot re-link.');
  log('  Those rows are marked "partial" above.');
  if (offerApply) {
    log('');
    log('  Nothing has been written. Re-run with `--apply <path/to/orchestrator.db>` to insert');
    log('  what is missing (a `.bak` is taken first, and it all goes in one transaction).');
  }
}

// ---------------------------------------------------------------------------
// 9. The command line.
// ---------------------------------------------------------------------------

const USAGE = `
Scavenge deleted cards out of an orchestrator.db.

  node scripts/recover-deleted-tasks.mjs <orchestrator.db> [options]

  --apply <live.db>   insert what is missing into <live.db> (a .bak is taken first)
  --profile <dir>     where attachments/ lives; defaults to the database's own directory
  --json <path>       write the whole report as JSON as well
  --force             proceed even though the database looks like a live profile
  --skip-dangling     do not insert children whose card is not (yet) back
  --keep              leave the working copy behind
  --self-test         prove the scavenger works, on scratch databases, and exit

Without a database argument it does nothing; --self-test is the one exception, since it
builds its own.
`;

function parseArgs(argv) {
  const options = {
    source: null,
    apply: null,
    profile: null,
    json: null,
    force: false,
    skipDangling: false,
    keep: false,
    help: false,
    selfTest: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--apply') options.apply = argv[++i];
    else if (arg === '--profile') options.profile = argv[++i];
    else if (arg === '--json') options.json = argv[++i];
    else if (arg === '--force') options.force = true;
    else if (arg === '--skip-dangling') options.skipDangling = true;
    else if (arg === '--keep') options.keep = true;
    else if (arg === '--self-test') options.selfTest = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg.startsWith('--')) throw new Error(`unknown option ${arg}`);
    else if (options.source === null) options.source = arg;
    else throw new Error(`unexpected argument ${arg}`);
  }
  return options;
}

/**
 * Why this database looks like one the app is using, or `null` when it does not.
 *
 * Two signals. A `-shm` file means some process has the database open right now — SQLite removes
 * it when the last connection closes. And the path being inside the app's own userData directory
 * means that even with the app shut, this is the profile it will re-open the moment it starts,
 * which is precisely the file that must not be worked on in place.
 */
function looksLive(dbPath) {
  if (existsSync(`${dbPath}-shm`)) {
    return 'there is a -shm file beside it, which means a process has it open right now';
  }
  const roots = [
    process.env.APPDATA && join(process.env.APPDATA, 'claude-orchestrator'),
    process.env.HOME && join(process.env.HOME, '.config', 'claude-orchestrator'),
    process.env.HOME &&
      join(process.env.HOME, 'Library', 'Application Support', 'claude-orchestrator'),
  ].filter(Boolean);
  const resolved = resolve(dbPath).toLowerCase();
  if (roots.some((root) => resolved.startsWith(resolve(root).toLowerCase() + sep))) {
    return "it is inside the app's own profile directory";
  }
  return null;
}

/**
 * `--self-test` runs `scripts/verify-recovery.mjs`, which seeds a database, deletes a card out
 * of it, scavenges it back and asserts every part of it returned — on scratch databases under
 * `.verify-recovery/`, never a real profile.
 *
 * It lives in that file rather than this one because it needs a bundler and Electron to seed
 * (see its header), while this script's whole point is to run under plain `node`. But the
 * command to prove this script works should be discoverable FROM this script, not only from
 * whoever remembers the other filename — so the flag is here and forwards.
 */
function runSelfTest() {
  const harness = join(repo, 'scripts', 'verify-recovery.mjs');
  if (!existsSync(harness)) throw new Error(`the self-test harness is missing: ${harness}`);
  const result = spawnSync(process.execPath, [harness], {
    stdio: 'inherit',
    // Under an Electron relaunch `process.execPath` is Electron, which needs telling to be Node.
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });
  process.exit(result.status ?? 1);
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.selfTest) runSelfTest();
  if (options.help || !options.source) {
    log(USAGE.trim());
    process.exit(options.source ? 0 : 1);
  }
  const source = resolve(options.source);
  if (!existsSync(source)) throw new Error(`no such file: ${source}`);

  const liveReason = looksLive(source);
  if (liveReason && !options.force) {
    log('');
    log(`REFUSING to read ${source}`);
    log(`  ${liveReason}.`);
    log('');
    log('  QUIT THE APP FIRST. Two reasons, and the second is the important one:');
    log('    1. a copy taken while the app is writing is a copy of a half-finished transaction;');
    log('    2. every write the app makes can reuse the very page your deleted card is lying in,');
    log('       and once that happens the card is gone for good.');
    log('');
    log('  Then re-run with --force. Nothing here writes to this file either way — the database');
    log('  is copied to a scratch directory and scavenged there.');
    process.exit(2);
  }

  // Resolved before any work, so a missing addon costs one line of output rather than a whole
  // report printed twice either side of the relaunch.
  const Database = options.apply ? loadSqlite() : null;

  // The copy. Everything downstream reads this and never the original, so a mistake in the scan
  // cannot cost anything — and so the file cannot change under the scan halfway through.
  const work = mkdtempSync(join(tmpdir(), 'recover-deleted-tasks-'));
  const copy = join(work, 'orchestrator.db');
  try {
    copyFileSync(source, copy);
    for (const suffix of ['-wal', '-shm']) {
      if (existsSync(source + suffix)) copyFileSync(source + suffix, copy + suffix);
    }
    const report = scavenge(copy, source, options, Database);
    if (options.json) {
      writeFileSync(options.json, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
      log(`\nWrote ${options.json}`);
    }
  } finally {
    if (options.keep) log(`\nLeft the working copy in ${work} (--keep).`);
    else rmSync(work, { recursive: true, force: true });
  }
}

/** Everything between "we have a copy" and "we have printed a report". */
function scavenge(copy, source, options, Database) {
  const file = openDatabaseFile(copy);
  log('');
  log(`Scavenging ${source}`);
  log(
    `  ${(file.byteLength / 1024).toFixed(0)} KiB, ${file.header.pageCount} pages of ` +
      `${file.header.pageSize} bytes` +
      (file.hasWal ? `, ${file.walFrames} WAL frames (${file.walStaleFrames} stale)` : ', no -wal'),
  );
  if (file.header.encoding !== 1) {
    log(`  ! the text encoding is ${file.header.encoding}, not UTF-8 — strings may decode wrongly`);
  }
  if (file.walMalformed) log('  ! the -wal file could not be parsed and was skipped');
  const freelist = file.freelistPages();
  log(`  ${freelist.size} page(s) on the free list`);

  const schema = readSchema(file);
  const anchors = [];
  for (const target of TARGETS) {
    const table = schema.get(target.table);
    if (!table) {
      log(`  ! this database has no ${target.table} table — skipping it`);
      continue;
    }
    if (table.columns.length > MAX_COLUMNS) {
      throw new Error(`${target.table} has ${table.columns.length} columns, more than this allows`);
    }
    anchors.push(...buildAnchors(target, table.columns));
  }
  if (anchors.length === 0)
    throw new Error('none of the tables this recovers are in that database');

  const live = readLive(file, schema);

  // Everything the scan finds, deduplicated by identity. A row is very often present in several
  // places at once — the main file and three WAL frames — and the copy worth keeping is the one
  // that decoded whole.
  const found = new Map();
  const recognised = new Set();
  scan(file, anchors, (target, row, meta) => {
    const identity = target.identity(row);
    if (live.get(target.table).has(identity)) {
      recognised.add(identity);
      return;
    }
    const previous = found.get(identity);
    const candidate = { table: target.table, row, ...meta };
    if (!previous || better(candidate, previous)) found.set(identity, candidate);
  });

  // The scan's own credibility, stated rather than assumed: these anchors, over these pages,
  // matched N of the rows that are demonstrably still there. A figure well short of all of them
  // means the scan is not reading this file properly, and its silence proves nothing.
  const liveCards = live.get('tasks').size;
  const recognisedCards = [...recognised].filter((k) => k.startsWith('tasks ')).length;
  log(
    `  Sanity: the same scan recognised ${recognisedCards} of the ${liveCards} card(s) still in ` +
      `the database` +
      (liveCards > 0 && recognisedCards < liveCards ? ' — treat anything below as incomplete' : ''),
  );

  const byTable = new Map(TARGETS.map((t) => [t.table, []]));
  for (const candidate of found.values()) byTable.get(candidate.table).push(candidate);

  // Attachment rows we already have — live or scavenged — tell the disk sweep what NOT to adopt.
  const accountedFor = new Set();
  const attachments = schema.get('task_attachments');
  if (attachments) {
    walkTable(file, attachments.rootpage, (page, start, end) => {
      const values = decodeRecordAt(page, start, end);
      if (!values) return;
      const row = {};
      attachments.columns.forEach((column, i) => {
        row[column.name] = values[i] ?? null;
      });
      if (row.taskId && row.name) {
        accountedFor.add(`${row.taskId} ${String(row.name).toLowerCase()}`);
      }
    });
  }
  for (const candidate of byTable.get('task_attachments')) {
    accountedFor.add(`${candidate.row.taskId} ${String(candidate.row.name).toLowerCase()}`);
  }
  const profileDir = options.profile ? resolve(options.profile) : dirname(resolve(source));
  const adopted = adoptOrphanAttachments(profileDir, accountedFor);
  for (const row of adopted) {
    byTable.get('task_attachments').push({
      table: 'task_attachments',
      row,
      rowid: null,
      truncated: false,
      confirmed: false,
      source: 'disk',
    });
  }

  // ---- the report ---------------------------------------------------------
  const taskRows = byTable.get('tasks');
  const cards = taskRows.filter((c) => !c.row.parentTaskId);
  const steps = taskRows.filter((c) => c.row.parentTaskId);
  const childrenOf = (taskId) => ({
    events: byTable.get('task_events').filter((c) => c.row.taskId === taskId).length,
    comments: byTable.get('task_activity').filter((c) => c.row.taskId === taskId).length,
    steps: steps.filter((c) => c.row.parentTaskId === taskId).length,
    links: byTable
      .get('task_links')
      .filter((c) => c.row.fromTaskId === taskId || c.row.toTaskId === taskId).length,
    attachments: byTable.get('task_attachments').filter((c) => c.row.taskId === taskId).length,
  });

  log('');
  if (taskRows.length === 0) {
    log('No deleted cards found in this file.');
  } else {
    log(`Recovered ${cards.length} card(s) and ${steps.length} step(s):`);
    log('');
    const ordered = [...cards].sort((a, b) =>
      String(a.row.title).localeCompare(String(b.row.title)),
    );
    for (const card of ordered) {
      const counts = childrenOf(card.row.id);
      log(`  ${card.row.externalKey ? `${card.row.externalKey}  ` : ''}${card.row.title}`);
      log(
        `      ${card.row.id}   status ${card.row.status}` +
          (card.truncated ? '   (partial — long fields were on an overflow page)' : ''),
      );
      log(
        `      ${counts.events} transcript event(s), ${counts.comments} comment(s)/note(s), ` +
          `${counts.steps} step(s), ${counts.links} link(s), ${counts.attachments} attachment(s)` +
          `   [found in ${card.source}]`,
      );
    }
  }

  // Children whose card came back neither here nor in the database. Worth naming: they are the
  // ones that light up on their own once the next sync re-creates the card.
  const knownTasks = new Set([
    ...[...live.get('tasks')].map((k) => k.slice('tasks '.length)),
    ...taskRows.map((c) => c.row.id),
  ]);
  const orphans = new Map();
  for (const key of ['task_events', 'task_activity', 'task_links', 'task_attachments']) {
    const target = TARGETS.find((t) => t.table === key);
    for (const candidate of byTable.get(key)) {
      const taskId = target.taskId(candidate.row);
      if (knownTasks.has(taskId)) continue;
      const bucket = orphans.get(taskId) ?? {};
      bucket[key] = (bucket[key] ?? 0) + 1;
      orphans.set(taskId, bucket);
    }
  }
  if (orphans.size > 0) {
    log('');
    log(`${orphans.size} task id(s) have recovered rows but no card, here or in the database:`);
    for (const [taskId, bucket] of orphans) {
      log(
        `  ${taskId} — ${bucket.task_events ?? 0} event(s), ${bucket.task_activity ?? 0} ` +
          `comment(s), ${bucket.task_links ?? 0} link(s), ` +
          `${bucket.task_attachments ?? 0} attachment(s)`,
      );
    }
    log('  These re-attach by themselves: task_events and task_activity have no foreign key onto');
    log('  tasks, so the next sync that re-creates the card under its original id picks them up.');
  }
  if (adopted.length > 0) {
    log('');
    log(`${adopted.length} file(s) under attachments/ had no row and were re-adopted.`);
  }

  const totals = {};
  for (const [table, rows] of byTable) totals[table] = rows.length;
  log('');
  log(
    `Totals: ${totals.tasks} task row(s), ${totals.task_events} event(s), ` +
      `${totals.task_activity} activity row(s), ${totals.task_links} link(s), ` +
      `${totals.task_attachments} attachment(s)`,
  );

  let applied = null;
  if (options.apply) {
    const target = resolve(options.apply);
    if (!existsSync(target)) throw new Error(`--apply: no such file: ${target}`);
    log('');
    log(`Applying to ${target}`);
    applied = apply(Database, target, byTable, options);
    for (const [table, count] of Object.entries(applied.inserted)) {
      log(`  ${table}: ${count} inserted, ${applied.skipped[table]} already there`);
    }
    if (applied.dangling > 0) {
      log(
        `  ${applied.dangling} row(s) point at a card that is not back yet — inserted anyway, ` +
          `waiting for the sync (${applied.violations} dangling reference(s) seen by SQLite).`,
      );
    }
    log('  Done, in one transaction.');
  }

  printLimits(taskRows.length > 0 && !options.apply);

  return {
    source,
    file: {
      bytes: file.byteLength,
      pageSize: file.header.pageSize,
      pages: file.header.pageCount,
      walFrames: file.walFrames,
      freelistPages: freelist.size,
    },
    sanity: { liveCards, recognisedCards },
    totals,
    cards: cards.map((c) => ({
      id: c.row.id,
      key: c.row.externalKey ?? null,
      title: c.row.title,
      status: c.row.status,
      projectId: c.row.projectId,
      truncated: c.truncated,
      source: c.source,
      ...childrenOf(c.row.id),
    })),
    steps: steps.map((c) => ({
      id: c.row.id,
      parentTaskId: c.row.parentTaskId,
      title: c.row.title,
    })),
    orphanTaskIds: [...orphans.keys()],
    adoptedAttachments: adopted.length,
    applied,
  };
}

/**
 * Which of two readings of the same row to keep: whole over truncated, then longer, then NEWER.
 *
 * That third rule earns its place. A `-wal` holds an image of the page from every transaction that
 * touched it, so a card edited three times before it was deleted appears three times over — and
 * the oldest of those is a card as it was before the edits. Preferring the highest `seq` is what
 * makes the recovered card the card as it last stood, rather than whichever version the scan
 * happened to reach first. The rowid is the last tiebreak, for two images that are otherwise equal.
 */
function better(candidate, previous) {
  if (candidate.truncated !== previous.truncated) return !candidate.truncated;
  const a = Object.keys(candidate.row).length;
  const b = Object.keys(previous.row).length;
  if (a !== b) return a > b;
  if (candidate.seq !== previous.seq) return candidate.seq > previous.seq;
  return candidate.rowid !== null && previous.rowid === null;
}

try {
  main();
} catch (error) {
  process.stderr.write(`\n${error.message}\n`);
  process.exit(1);
}
