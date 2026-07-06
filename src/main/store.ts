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
import type { AddProjectInput, Project, Task } from '@shared/model';
import type { LimitState } from '@shared/limit';
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
  getTasks(projectId: string): Task[];
  getTask(id: string): Task | undefined;
  /** Patch a task's live fields (status/sessionId); returns the updated task. */
  updateTask(id: string, patch: Partial<Pick<Task, 'status' | 'sessionId'>>): Task | undefined;
  /** Re-parse a plan and reconcile it into the project's tasks; returns the result. */
  syncTasksFromPlan(projectId: string, parsed: ParsedTask[]): Task[];
  /**
   * Persist (or clear, with `null`) the account-wide usage-limit gate so a limit
   * survives an app restart and the resume still happens after a relaunch (Phase 5).
   */
  saveLimitGate(state: LimitState | null): void;
  /** Load a persisted usage-limit gate, or null if none is in force. */
  loadLimitGate(): LimitState | null;
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
      "order"    INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(projectId, "order");
    CREATE TABLE IF NOT EXISTS app_state (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  // Migrate databases created before Phase 3 added the write-back column.
  const projectColumns = db.prepare(`PRAGMA table_info(projects)`).all() as Array<{ name: string }>;
  if (!projectColumns.some((c) => c.name === 'writeBackPlan')) {
    db.exec(`ALTER TABLE projects ADD COLUMN writeBackPlan INTEGER NOT NULL DEFAULT 0`);
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
    `INSERT INTO tasks (id, projectId, phase, title, status, sessionId, "order")
     VALUES (@id, @projectId, @phase, @title, @status, @sessionId, @order)`,
  );
  const upsertState = db.prepare(
    `INSERT INTO app_state (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  );
  const deleteState = db.prepare(`DELETE FROM app_state WHERE key = ?`);
  const selectState = db.prepare(`SELECT value FROM app_state WHERE key = ?`);

  /** The single row key under which the usage-limit gate is persisted. */
  const LIMIT_GATE_KEY = 'limitGate';

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
      const project: Project = {
        id: randomUUID(),
        name: input.name?.trim() || basename(input.path),
        path: input.path,
        planPath: input.planPath ?? join(input.path, 'plan.md'),
        defaultModel: input.defaultModel ?? 'sonnet',
        defaultPermissionMode: input.defaultPermissionMode ?? 'acceptEdits',
        writeBackPlan: input.writeBackPlan ?? false,
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

    close() {
      db.close();
    },
  };
}
