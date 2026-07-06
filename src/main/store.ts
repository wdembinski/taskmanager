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

/** The store's public surface. Constructed once in the main process. */
export interface Store {
  addProject(input: AddProjectInput): Project;
  listProjects(): Project[];
  removeProject(id: string): void;
  getTasks(projectId: string): Task[];
  /** Re-parse a plan and reconcile it into the project's tasks; returns the result. */
  syncTasksFromPlan(projectId: string, parsed: ParsedTask[]): Task[];
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
  `);

  const insertProject = db.prepare<[Project]>(
    `INSERT INTO projects (id, name, path, planPath, defaultModel, defaultPermissionMode, createdAt)
     VALUES (@id, @name, @path, @planPath, @defaultModel, @defaultPermissionMode, @createdAt)`,
  );
  const selectProjects = db.prepare(`SELECT * FROM projects ORDER BY createdAt`);
  const deleteProject = db.prepare(`DELETE FROM projects WHERE id = ?`);
  const selectTasks = db.prepare(`SELECT * FROM tasks WHERE projectId = ? ORDER BY "order"`);
  const deleteTasks = db.prepare(`DELETE FROM tasks WHERE projectId = ?`);
  const insertTask = db.prepare<[TaskRow]>(
    `INSERT INTO tasks (id, projectId, phase, title, status, sessionId, "order")
     VALUES (@id, @projectId, @phase, @title, @status, @sessionId, @order)`,
  );

  function getTasks(projectId: string): Task[] {
    return (selectTasks.all(projectId) as TaskRow[]).map((r) => ({
      id: r.id,
      projectId: r.projectId,
      phase: r.phase,
      title: r.title,
      status: r.status as Task['status'],
      sessionId: r.sessionId,
      order: r.order,
    }));
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
        createdAt: Date.now(),
      };
      insertProject.run(project);
      return project;
    },

    listProjects() {
      return selectProjects.all() as Project[];
    },

    removeProject(id) {
      deleteProject.run(id);
    },

    getTasks,

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

    close() {
      db.close();
    },
  };
}
