/**
 * Persistent store — the app's memory of projects and their tasks.
 *
 * Backed by SQLite via `better-sqlite3` (a synchronous, embedded database; no
 * server, one file on disk). The database lives under Electron's per-user data
 * directory, passed in by the caller so this module stays decoupled from
 * Electron and is easy to point at a temp file in tests.
 *
 * The reconciliation logic (merging a freshly parsed plan into the tasks we
 * already track) lives in the pure `taskReconcile` module so it can be unit
 * tested without a database — the native better-sqlite3 binary is built for
 * Electron's ABI, not the Node that runs Vitest.
 */
import { randomUUID } from 'node:crypto';
import { basename, join } from 'node:path';
import Database from 'better-sqlite3';
import type {
  AddProjectInput,
  Project,
  ProjectPatch,
  Task,
  TaskActivityEntry,
  TaskStatus,
} from '@shared/model';
import type { LimitState } from '@shared/limit';
import type { SessionEvent } from '@shared/session';
import { type AppSettings, DEFAULT_SETTINGS } from '@shared/settings';
import { mergeActivity } from './activityMerge';
import type { ParsedTask } from './planParser';
import { reconcileTasks } from './taskReconcile';

/** A row as stored; SQLite has no boolean, so we keep types explicit here. */
interface TaskRow {
  id: string;
  projectId: string;
  phase: string;
  title: string;
  status: string;
  sessionId: string | null;
  order: number;
  source: string;
}

/** A project row as stored; `writeBackPlan` is a 0/1 INTEGER (SQLite has no boolean). */
interface ProjectRow {
  id: string;
  name: string;
  path: string;
  planPath: string;
  defaultModel: string;
  defaultPermissionMode: string;
  writeBackPlan: number;
  createdAt: number;
}

/** The store's public surface. Constructed once in the main process. */
export interface Store {
  addProject(input: AddProjectInput): Project;
  listProjects(): Project[];
  getProject(id: string): Project | undefined;
  removeProject(id: string): void;
  /** Toggle the plan write-back opt-in for a project. */
  setWriteBack(id: string, enabled: boolean): void;
  /** Edit a project's name/plan/model/mode/write-back (Phase 8); returns the updated project. */
  updateProject(id: string, patch: ProjectPatch): Project | undefined;
  getTasks(projectId: string): Task[];
  getTask(id: string): Task | undefined;
  /** Patch a task's live fields (status/sessionId); returns the updated task. */
  updateTask(id: string, patch: Partial<Pick<Task, 'status' | 'sessionId'>>): Task | undefined;
  /** Create an ad-hoc task (Phase 8): appended after existing tasks, `source: 'adhoc'`. */
  createTask(projectId: string, input: { title: string; phase?: string }): Task | undefined;
  /** Delete one task (and its transcript history) by id. */
  deleteTask(id: string): void;
  /** Re-parse a plan and reconcile it into the project's tasks; returns the result. */
  syncTasksFromPlan(projectId: string, parsed: ParsedTask[]): Task[];
  /**
   * Append one normalized session event to a task's persisted history (Phase 6),
   * so its transcript is viewable after the run ends or the app restarts.
   */
  appendTaskEvent(projectId: string, taskId: string, runId: string, event: SessionEvent): void;
  /** Load a task's full event history in order (all of its runs), for replay in the UI. */
  getTaskHistory(taskId: string): SessionEvent[];
  /** Append a human progress comment to a task (Phase 9); returns the created entry. */
  addComment(projectId: string, taskId: string, body: string): TaskActivityEntry | undefined;
  /** Record a status change on a task's timeline (Phase 9). */
  recordStatusChange(
    projectId: string,
    taskId: string,
    from: TaskStatus | null,
    to: TaskStatus,
  ): void;
  /** Delete one comment by id. */
  deleteComment(commentId: number): void;
  /** The task's unified activity timeline: comments + status changes + AI transcript. */
  getTaskActivity(taskId: string): TaskActivityEntry[];
  /**
   * Persist (or clear, with `null`) the account-wide usage-limit gate so a limit
   * survives an app restart and the resume still happens after a relaunch (Phase 5).
   */
  saveLimitGate(state: LimitState | null): void;
  /** Load a persisted usage-limit gate, or null if none is in force. */
  loadLimitGate(): LimitState | null;
  /** Current app settings, with any unset field filled from `DEFAULT_SETTINGS` (Phase 6). */
  getSettings(): AppSettings;
  /** Persist the full app settings object. */
  saveSettings(settings: AppSettings): void;
  close(): void;
}

/**
 * Open (or create) the database at `dbPath` and return the store API.
 * `join(app.getPath('userData'), 'orchestrator.db')` is the production path.
 */
export function createStore(dbPath: string): Store {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL'); // better concurrency + crash safety
  db.pragma('foreign_keys = ON'); // so deleting a project cascades to its tasks

  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id                    TEXT PRIMARY KEY,
      name                  TEXT NOT NULL,
      path                  TEXT NOT NULL,
      planPath              TEXT NOT NULL,
      defaultModel          TEXT NOT NULL,
      defaultPermissionMode TEXT NOT NULL,
      writeBackPlan         INTEGER NOT NULL DEFAULT 0,
      createdAt             INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS tasks (
      id         TEXT PRIMARY KEY,
      projectId  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      phase      TEXT NOT NULL,
      title      TEXT NOT NULL,
      status     TEXT NOT NULL,
      sessionId  TEXT,
      "order"    INTEGER NOT NULL,
      source     TEXT NOT NULL DEFAULT 'plan'
    );
    CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(projectId, "order");
    CREATE TABLE IF NOT EXISTS app_state (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS task_events (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      projectId TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      taskId    TEXT NOT NULL,
      runId     TEXT NOT NULL,
      event     TEXT NOT NULL,
      createdAt INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_task_events_task ON task_events(taskId, id);
    CREATE TABLE IF NOT EXISTS task_activity (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      projectId  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      taskId     TEXT NOT NULL,
      kind       TEXT NOT NULL,           -- 'comment' | 'status'
      body       TEXT,                    -- comment text (kind = 'comment')
      fromStatus TEXT,                    -- prior status (kind = 'status')
      toStatus   TEXT,                    -- new status  (kind = 'status')
      createdAt  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_task_activity_task ON task_activity(taskId, id);
  `);

  // Migrate databases created before Phase 3 added the write-back column.
  const projectColumns = db.prepare(`PRAGMA table_info(projects)`).all() as Array<{ name: string }>;
  if (!projectColumns.some((c) => c.name === 'writeBackPlan')) {
    db.exec(`ALTER TABLE projects ADD COLUMN writeBackPlan INTEGER NOT NULL DEFAULT 0`);
  }

  // Migrate databases created before Phase 8 added the task source column. Existing
  // tasks all came from plans, so the 'plan' default is correct for them.
  const taskColumns = db.prepare(`PRAGMA table_info(tasks)`).all() as Array<{ name: string }>;
  if (!taskColumns.some((c) => c.name === 'source')) {
    db.exec(`ALTER TABLE tasks ADD COLUMN source TEXT NOT NULL DEFAULT 'plan'`);
  }

  const insertProject = db.prepare<[ProjectRow]>(
    `INSERT INTO projects (id, name, path, planPath, defaultModel, defaultPermissionMode, writeBackPlan, createdAt)
     VALUES (@id, @name, @path, @planPath, @defaultModel, @defaultPermissionMode, @writeBackPlan, @createdAt)`,
  );
  const selectProjects = db.prepare(`SELECT * FROM projects ORDER BY createdAt`);
  const selectProject = db.prepare(`SELECT * FROM projects WHERE id = ?`);
  const deleteProject = db.prepare(`DELETE FROM projects WHERE id = ?`);
  const updateWriteBack = db.prepare(`UPDATE projects SET writeBackPlan = ? WHERE id = ?`);
  const selectTasks = db.prepare(`SELECT * FROM tasks WHERE projectId = ? ORDER BY "order"`);
  const selectTask = db.prepare(`SELECT * FROM tasks WHERE id = ?`);
  const deleteTasks = db.prepare(`DELETE FROM tasks WHERE projectId = ?`);
  const insertTask = db.prepare<[TaskRow]>(
    `INSERT INTO tasks (id, projectId, phase, title, status, sessionId, "order", source)
     VALUES (@id, @projectId, @phase, @title, @status, @sessionId, @order, @source)`,
  );
  const deleteTask = db.prepare(`DELETE FROM tasks WHERE id = ?`);
  const nextOrder = db.prepare(
    `SELECT COALESCE(MAX("order"), -1) + 1 AS next FROM tasks WHERE projectId = ?`,
  );
  const upsertState = db.prepare(
    `INSERT INTO app_state (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  );
  const deleteState = db.prepare(`DELETE FROM app_state WHERE key = ?`);
  const selectState = db.prepare(`SELECT value FROM app_state WHERE key = ?`);
  // task_events references the PROJECT (not the task) so a plan re-sync — which
  // deletes and re-inserts task rows — never cascades away a task's history.
  const insertEvent = db.prepare(
    `INSERT INTO task_events (projectId, taskId, runId, event, createdAt)
     VALUES (@projectId, @taskId, @runId, @event, @createdAt)`,
  );
  const selectEvents = db.prepare(`SELECT event FROM task_events WHERE taskId = ? ORDER BY id`);
  // Timeline reads need id + createdAt (not just the event blob) to interleave with
  // human activity; the task-scoped deletes clean up on an explicit ad-hoc delete.
  const selectEventsFull = db.prepare(
    `SELECT id, event, createdAt FROM task_events WHERE taskId = ? ORDER BY id`,
  );
  const deleteEventsForTask = db.prepare(`DELETE FROM task_events WHERE taskId = ?`);
  const insertActivity = db.prepare(
    `INSERT INTO task_activity (projectId, taskId, kind, body, fromStatus, toStatus, createdAt)
     VALUES (@projectId, @taskId, @kind, @body, @fromStatus, @toStatus, @createdAt)`,
  );
  const selectActivity = db.prepare(
    `SELECT id, kind, body, fromStatus, toStatus, createdAt FROM task_activity
     WHERE taskId = ? ORDER BY id`,
  );
  const selectActivityRow = db.prepare(`SELECT * FROM task_activity WHERE id = ?`);
  const deleteActivity = db.prepare(`DELETE FROM task_activity WHERE id = ?`);
  const deleteActivityForTask = db.prepare(`DELETE FROM task_activity WHERE taskId = ?`);

  /** The single row key under which the usage-limit gate is persisted. */
  const LIMIT_GATE_KEY = 'limitGate';
  /** The single row key under which app settings are persisted. */
  const SETTINGS_KEY = 'settings';

  /** Read app settings, merging any stored fields over the built-in defaults. */
  function getSettings(): AppSettings {
    const row = selectState.get(SETTINGS_KEY) as { value: string } | undefined;
    if (!row) return { ...DEFAULT_SETTINGS };
    try {
      return { ...DEFAULT_SETTINGS, ...(JSON.parse(row.value) as Partial<AppSettings>) };
    } catch {
      return { ...DEFAULT_SETTINGS };
    }
  }

  /** SQLite stores writeBackPlan as 0/1; present it to the app as a real boolean. */
  function rowToProject(r: ProjectRow): Project {
    return {
      id: r.id,
      name: r.name,
      path: r.path,
      planPath: r.planPath,
      defaultModel: r.defaultModel as Project['defaultModel'],
      defaultPermissionMode: r.defaultPermissionMode as Project['defaultPermissionMode'],
      writeBackPlan: r.writeBackPlan !== 0,
      createdAt: r.createdAt,
    };
  }

  function rowToTask(r: TaskRow): Task {
    return {
      id: r.id,
      projectId: r.projectId,
      phase: r.phase,
      title: r.title,
      status: r.status as Task['status'],
      sessionId: r.sessionId,
      order: r.order,
      source: (r.source as Task['source']) ?? 'plan',
    };
  }

  function getTasks(projectId: string): Task[] {
    return (selectTasks.all(projectId) as TaskRow[]).map(rowToTask);
  }

  function getTask(id: string): Task | undefined {
    const row = selectTask.get(id) as TaskRow | undefined;
    return row ? rowToTask(row) : undefined;
  }

  return {
    addProject(input) {
      // Unspecified project fields inherit the user's global defaults (Phase 6).
      const defaults = getSettings();
      const project: Project = {
        id: randomUUID(),
        name: input.name?.trim() || basename(input.path),
        path: input.path,
        planPath: input.planPath ?? join(input.path, 'plan.md'),
        defaultModel: input.defaultModel ?? defaults.defaultModel,
        defaultPermissionMode: input.defaultPermissionMode ?? defaults.defaultPermissionMode,
        writeBackPlan: input.writeBackPlan ?? defaults.writeBackPlan,
        createdAt: Date.now(),
      };
      insertProject.run({ ...project, writeBackPlan: project.writeBackPlan ? 1 : 0 });
      return project;
    },

    listProjects() {
      return (selectProjects.all() as ProjectRow[]).map(rowToProject);
    },

    getProject(id) {
      const row = selectProject.get(id) as ProjectRow | undefined;
      return row ? rowToProject(row) : undefined;
    },

    removeProject(id) {
      deleteProject.run(id);
    },

    setWriteBack(id, enabled) {
      updateWriteBack.run(enabled ? 1 : 0, id);
    },

    updateProject(id, patch) {
      // Build a dynamic UPDATE from only the provided fields (like updateTask).
      const sets: string[] = [];
      const params: Record<string, unknown> = { id };
      if (patch.name !== undefined) {
        sets.push(`name = @name`);
        params.name = patch.name;
      }
      if (patch.planPath !== undefined) {
        sets.push(`planPath = @planPath`);
        params.planPath = patch.planPath;
      }
      if (patch.defaultModel !== undefined) {
        sets.push(`defaultModel = @defaultModel`);
        params.defaultModel = patch.defaultModel;
      }
      if (patch.defaultPermissionMode !== undefined) {
        sets.push(`defaultPermissionMode = @defaultPermissionMode`);
        params.defaultPermissionMode = patch.defaultPermissionMode;
      }
      if (patch.writeBackPlan !== undefined) {
        sets.push(`writeBackPlan = @writeBackPlan`);
        params.writeBackPlan = patch.writeBackPlan ? 1 : 0;
      }
      if (sets.length > 0) {
        db.prepare(`UPDATE projects SET ${sets.join(', ')} WHERE id = @id`).run(params);
      }
      const row = selectProject.get(id) as ProjectRow | undefined;
      return row ? rowToProject(row) : undefined;
    },

    getTasks,

    getTask,

    updateTask(id, patch) {
      const sets: string[] = [];
      const params: Record<string, unknown> = { id };
      if (patch.status !== undefined) {
        sets.push(`status = @status`);
        params.status = patch.status;
      }
      if (patch.sessionId !== undefined) {
        sets.push(`sessionId = @sessionId`);
        params.sessionId = patch.sessionId;
      }
      if (sets.length > 0) {
        db.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = @id`).run(params);
      }
      return getTask(id);
    },

    createTask(projectId, input) {
      const title = input.title.trim();
      if (!title) return undefined;
      const task: Task = {
        id: randomUUID(),
        projectId,
        phase: input.phase?.trim() || '',
        title,
        status: 'pending',
        sessionId: null,
        order: (nextOrder.get(projectId) as { next: number }).next,
        source: 'adhoc',
      };
      insertTask.run(task as unknown as TaskRow);
      return task;
    },

    deleteTask(id) {
      // Explicit delete (ad-hoc task): also drop its timeline + transcript. (The
      // plan-sync path never calls this, so plan history is unaffected.)
      const clear = db.transaction((taskId: string) => {
        deleteActivityForTask.run(taskId);
        deleteEventsForTask.run(taskId);
        deleteTask.run(taskId);
      });
      clear(id);
    },

    syncTasksFromPlan(projectId, parsed) {
      const desired = reconcileTasks(projectId, getTasks(projectId), parsed);
      // Replace the project's task set with the reconciled list, in one transaction.
      const replace = db.transaction((tasks: Task[]) => {
        deleteTasks.run(projectId);
        for (const t of tasks) insertTask.run(t as unknown as TaskRow);
      });
      replace(desired);
      return desired;
    },

    appendTaskEvent(projectId, taskId, runId, event) {
      insertEvent.run({
        projectId,
        taskId,
        runId,
        event: JSON.stringify(event),
        createdAt: Date.now(),
      });
    },

    getTaskHistory(taskId) {
      const rows = selectEvents.all(taskId) as Array<{ event: string }>;
      const events: SessionEvent[] = [];
      for (const row of rows) {
        try {
          events.push(JSON.parse(row.event) as SessionEvent);
        } catch {
          // Skip a corrupt row rather than break the whole transcript.
        }
      }
      return events;
    },

    addComment(projectId, taskId, body) {
      const text = body.trim();
      if (!text) return undefined;
      const createdAt = Date.now();
      const { lastInsertRowid } = insertActivity.run({
        projectId,
        taskId,
        kind: 'comment',
        body: text,
        fromStatus: null,
        toStatus: null,
        createdAt,
      });
      return { kind: 'comment', id: Number(lastInsertRowid), body: text, createdAt };
    },

    recordStatusChange(projectId, taskId, from, to) {
      insertActivity.run({
        projectId,
        taskId,
        kind: 'status',
        body: null,
        fromStatus: from,
        toStatus: to,
        createdAt: Date.now(),
      });
    },

    deleteComment(commentId) {
      const row = selectActivityRow.get(commentId) as { kind: string } | undefined;
      // Only delete comments — status entries are an immutable audit trail.
      if (row?.kind === 'comment') deleteActivity.run(commentId);
    },

    getTaskActivity(taskId) {
      const entries: TaskActivityEntry[] = [];
      const activity = selectActivity.all(taskId) as Array<{
        id: number;
        kind: string;
        body: string | null;
        fromStatus: string | null;
        toStatus: string | null;
        createdAt: number;
      }>;
      for (const r of activity) {
        if (r.kind === 'comment' && r.body !== null) {
          entries.push({ kind: 'comment', id: r.id, body: r.body, createdAt: r.createdAt });
        } else if (r.kind === 'status' && r.toStatus !== null) {
          entries.push({
            kind: 'status',
            id: r.id,
            from: r.fromStatus as TaskStatus | null,
            to: r.toStatus as TaskStatus,
            createdAt: r.createdAt,
          });
        }
      }
      const events = selectEventsFull.all(taskId) as Array<{
        id: number;
        event: string;
        createdAt: number;
      }>;
      for (const r of events) {
        try {
          entries.push({
            kind: 'event',
            id: r.id,
            event: JSON.parse(r.event) as SessionEvent,
            createdAt: r.createdAt,
          });
        } catch {
          // Skip a corrupt row rather than break the whole timeline.
        }
      }
      return mergeActivity(entries);
    },

    saveLimitGate(state) {
      if (state === null) deleteState.run(LIMIT_GATE_KEY);
      else upsertState.run(LIMIT_GATE_KEY, JSON.stringify(state));
    },

    loadLimitGate() {
      const row = selectState.get(LIMIT_GATE_KEY) as { value: string } | undefined;
      if (!row) return null;
      try {
        return JSON.parse(row.value) as LimitState;
      } catch {
        return null; // corrupt/legacy value — treat as no gate
      }
    },

    getSettings,

    saveSettings(settings) {
      upsertState.run(SETTINGS_KEY, JSON.stringify(settings));
    },

    close() {
      db.close();
    },
  };
}
