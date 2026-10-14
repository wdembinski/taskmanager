/**
 * The nine `skill:*`/`task:setSkillRefs` IPC handler bodies, pulled out of `ipc.ts` the same
 * way `automationHandlers.ts` pulls its six out — so they can be run through a real
 * {@link RelayRegistry} in a test without standing up Electron. No import here reaches
 * `electron`; `ipc.ts` still does the `ipcMain.handle` / `relayRegistry.register` wiring and
 * the native `dialog.showOpenDialog` calls themselves, handing this module only the already-
 * resolved paths (or `null` for "the human cancelled").
 *
 * `importSkillText` is the one piece worth reading on its own: every candidate a
 * `skill:import` call produces — one file, one folder's `SKILL.md`, or one paste — runs through it
 * in turn, and it is what decides `'imported'` vs `'clash'` vs `'refused'`. Clashes are
 * resolved against whatever is in the store AT THE TIME each candidate is checked, which is
 * why a batch's own earlier imports are visible to its later ones: save a `tdd` skill from
 * file one, and file two's own `tdd` clashes against the skill file one just created, not a
 * second time against nothing.
 */
import { basename, dirname, join } from 'node:path';
import type { ExecHost } from './exec';
import type { ExecTarget } from '@shared/execTarget';
import { hasRepo, type Task } from '@shared/model';
import type { IpcApi } from '@shared/ipc';
import {
  parseSkillMarkdown,
  serializeSkillMarkdown,
  skillNameFromFileName,
  SKILL_BODY_MAX,
  type Skill,
  type SkillImportRequest,
  type SkillImportResult,
} from '@shared/skills';
import { listRepoSkills, readRepoSkill, REPO_SKILLS_DIR } from './repoSkills';
import type { Store } from './store';

export interface SkillHandlersDeps {
  store: Pick<
    Store,
    | 'getSkills'
    | 'getSkill'
    | 'saveSkill'
    | 'deleteSkill'
    | 'getProject'
    | 'getTask'
    | 'setTaskSkillRefs'
  >;
  now(): number;
  newId(): string;
  hostFor(target: ExecTarget | undefined): ExecHost;
  /** Open a native "choose files" dialog; the chosen absolute paths, or `null` if cancelled. */
  pickImportFiles(): Promise<string[] | null>;
  /** Open a native "choose a folder" dialog; the chosen absolute path, or `null` if cancelled. */
  pickImportFolder(): Promise<string | null>;
  /** Open a native "choose a folder" dialog for export; the chosen absolute path, or `null`. */
  pickExportDir(): Promise<string | null>;
  readText(path: string): Promise<string>;
  listDir(path: string): Promise<Array<{ name: string; isDirectory: boolean }>>;
  writeText(path: string, text: string): Promise<void>;
  /** `send('task:changed', { task, runId: null })` — the board push every other `task:*` write
   *  in `ipc.ts` makes after a store write lands. */
  taskChanged(task: Task): void;
}

/** The subset of `IpcApi` these nine channels implement — same contract, no Electron import. */
export type SkillHandlers = Pick<
  IpcApi,
  | 'skill:list'
  | 'skill:get'
  | 'skill:save'
  | 'skill:delete'
  | 'skill:import'
  | 'skill:export'
  | 'skill:listRepo'
  | 'skill:getRepo'
  | 'task:setSkillRefs'
>;

/** The one sentence a human reads for each `SkillSaveResult` refusal. `name` is the clashing
 *  name, which for `'name-taken'` is the existing skill's own name — the plan's "refused with
 *  the existing skill named". */
function saveRefusalMessage(
  reason: 'invalid-name' | 'too-large' | 'name-taken',
  name: string,
): string {
  switch (reason) {
    case 'invalid-name':
      return 'Skill names must be lower-case letters, numbers and hyphens, 1 to 64 characters.';
    case 'too-large':
      return `A skill's body cannot be over ${SKILL_BODY_MAX / 1024} KiB.`;
    case 'name-taken':
      return `A skill named "${name}" already exists.`;
  }
}

/**
 * The fallback name a file at `path` offers `parseSkillMarkdown` when its own frontmatter has
 * none (or an invalid one): `SKILL.md` falls back to its PARENT folder's name (the folder
 * import's one-level-down `SKILL.md` shape), anything else falls back to its own file name.
 * Either way {@link skillNameFromFileName} slugs the result, so `My Skill.md` still offers
 * `my-skill` rather than failing outright over capitalisation or spaces.
 */
function fallbackNameFromPath(path: string): string {
  const base = basename(path);
  const stem = base.toLowerCase() === 'skill.md' ? basename(dirname(path)) : base;
  return skillNameFromFileName(stem);
}

/**
 * Parse → name → size → clash → save, for one imported candidate. Pure apart from the two
 * store calls, which is why it takes `store` and `ctx` explicitly rather than closing over a
 * `SkillHandlersDeps` — a batch importing several candidates calls this once per candidate,
 * in order, so an earlier candidate's save is visible to a later candidate's clash check.
 */
function importSkillText(
  text: string,
  fallbackName: string,
  store: Pick<Store, 'getSkills' | 'saveSkill'>,
  ctx: { source: SkillImportRequest['source']; now(): number; newId(): string },
): SkillImportResult {
  const parsed = parseSkillMarkdown(text, fallbackName || undefined);
  if (!parsed.name) {
    return {
      status: 'refused',
      source: ctx.source,
      reason: 'no-name',
      message:
        'No valid skill name in the frontmatter, and no usable file or folder name to fall back to.',
    };
  }
  if (Buffer.byteLength(parsed.body, 'utf8') > SKILL_BODY_MAX) {
    return {
      status: 'refused',
      source: ctx.source,
      reason: 'too-large',
      message: `"${parsed.name}" is larger than ${SKILL_BODY_MAX / 1024} KiB and cannot be imported.`,
    };
  }

  const candidate = { name: parsed.name, description: parsed.description, body: parsed.body };
  const existing = store.getSkills().find((s) => s.name === parsed.name);
  if (existing) {
    return {
      status: 'clash',
      candidate,
      existing,
      source: ctx.source,
      message: `A skill named "${parsed.name}" already exists.`,
    };
  }

  const skill: Skill = {
    id: ctx.newId(),
    ...candidate,
    createdAt: ctx.now(),
    updatedAt: ctx.now(),
  };
  const saved = store.saveSkill(skill);
  if (!saved.ok) {
    // Unreachable in practice: `parsed.name` already passed `isValidSkillName` (or came back
    // ''), the size check above already ran, and `existing` already ruled out this exact name
    // — nothing between that check and this call can change it inside one synchronous handler.
    return {
      status: 'refused',
      source: ctx.source,
      reason: 'unreadable',
      // Never word a main-process string as the keyword import followed by a quote: electron-vite
      // mistakes it for an import statement and injects its shim into it (scripts/check-esm-shim.mjs).
      message: `Could not save the imported skill "${parsed.name}".`,
    };
  }
  return { status: 'imported', skill: saved.skill, warnings: parsed.warnings, source: ctx.source };
}

export function createSkillHandlers(deps: SkillHandlersDeps): SkillHandlers {
  async function importFromFiles(): Promise<SkillImportResult[] | null> {
    const paths = await deps.pickImportFiles();
    if (!paths) return null;
    const ctx = { source: 'files' as const, now: deps.now, newId: deps.newId };
    const results: SkillImportResult[] = [];
    for (const path of paths) {
      try {
        const text = await deps.readText(path);
        results.push(importSkillText(text, fallbackNameFromPath(path), deps.store, ctx));
      } catch {
        results.push({
          status: 'refused',
          source: ctx.source,
          reason: 'unreadable',
          message: `Could not read ${basename(path)}.`,
        });
      }
    }
    return results;
  }

  async function importFromFolder(): Promise<SkillImportResult[] | null> {
    const dir = await deps.pickImportFolder();
    if (!dir) return null;
    const ctx = { source: 'folder' as const, now: deps.now, newId: deps.newId };
    const entries = await deps.listDir(dir);
    const results: SkillImportResult[] = [];

    for (const entry of entries) {
      if (entry.isDirectory || !entry.name.toLowerCase().endsWith('.md')) continue;
      const path = join(dir, entry.name);
      try {
        const text = await deps.readText(path);
        results.push(importSkillText(text, fallbackNameFromPath(path), deps.store, ctx));
      } catch {
        results.push({
          status: 'refused',
          source: ctx.source,
          reason: 'unreadable',
          message: `Could not read ${entry.name}.`,
        });
      }
    }

    for (const entry of entries) {
      if (!entry.isDirectory) continue;
      const path = join(dir, entry.name, 'SKILL.md');
      try {
        const text = await deps.readText(path);
        results.push(importSkillText(text, fallbackNameFromPath(path), deps.store, ctx));
      } catch {
        results.push({
          status: 'refused',
          source: ctx.source,
          reason: 'unreadable',
          message: `No readable SKILL.md under ${entry.name}.`,
        });
      }
    }

    return results;
  }

  return {
    'skill:list': async () => deps.store.getSkills(),

    'skill:get': async (id) => deps.store.getSkill(id) ?? null,

    'skill:save': async (input) => {
      const existing = input.id ? deps.store.getSkill(input.id) : undefined;
      const skill: Skill = {
        id: input.id ?? deps.newId(),
        name: input.name,
        description: input.description,
        body: input.body,
        createdAt: existing?.createdAt ?? deps.now(),
        updatedAt: deps.now(),
      };
      const result = deps.store.saveSkill(skill);
      if (result.ok) return result;
      return {
        ok: false,
        reason: result.reason,
        message: saveRefusalMessage(result.reason, skill.name),
      };
    },

    'skill:delete': async (id) => deps.store.deleteSkill(id),

    'skill:import': async (request) => {
      if (request.source === 'text') {
        const ctx = { source: 'text' as const, now: deps.now, newId: deps.newId };
        return [importSkillText(request.text, '', deps.store, ctx)];
      }
      return request.source === 'files' ? importFromFiles() : importFromFolder();
    },

    'skill:export': async (ids) => {
      const dir = await deps.pickExportDir();
      if (!dir) return null;
      const written: string[] = [];
      for (const id of ids) {
        const skill = deps.store.getSkill(id);
        if (!skill) continue;
        await deps.writeText(join(dir, skill.name, 'SKILL.md'), serializeSkillMarkdown(skill));
        written.push(skill.name);
      }
      return { dir, written };
    },

    'skill:listRepo': async (projectId) => {
      const project = deps.store.getProject(projectId);
      if (!project || !hasRepo(project)) return [];
      return listRepoSkills(projectId, project.path, deps.hostFor(project.target));
    },

    'skill:getRepo': async (projectId, name) => {
      const project = deps.store.getProject(projectId);
      if (!project || !hasRepo(project)) return null;
      const skill = await readRepoSkill(project.path, name, deps.hostFor(project.target));
      if (!skill) return null;
      return {
        name: skill.name,
        description: skill.description,
        body: skill.body,
        path: [...REPO_SKILLS_DIR, skill.name, 'SKILL.md'].join('/'),
        warnings: skill.warnings,
      };
    },

    'task:setSkillRefs': async (taskId, refs) => {
      const existing = deps.store.getTask(taskId);
      if (!existing) throw new Error('Task not found.');
      const task = deps.store.setTaskSkillRefs(taskId, refs);
      if (!task) throw new Error('Task not found.');
      deps.taskChanged(task);
      return task;
    },
  };
}
