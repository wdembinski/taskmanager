/**
 * Proves the nine `skill:*`/`task:setSkillRefs` handler bodies through the SAME path a
 * browser tab actually takes: a real `RelayRegistry`, dispatching to handlers built by
 * `createSkillHandlers` — no Electron, no real `Store`. The in-memory store fake mimics
 * `store.saveSkill`'s own refusals (`apps/client/src/main/store.ts`) rather than stubbing
 * them away, so a name clash or an oversized body is caught at the same layer production
 * code catches it.
 *
 * `skill:import` and `skill:export` are host-only (`ipcRelay.ts`), so a real `RelayRegistry`
 * would refuse them before the handler ever ran — those two are called directly off the
 * handlers object instead, the same way `ipc.ts` itself calls them from a native dialog
 * callback.
 */
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import { createSkillHandlers, type SkillHandlersDeps } from './skillHandlers';
import { RelayRegistry } from './ipcRegistry';
import { isValidSkillName, SKILL_BODY_MAX, type Skill } from '@shared/skills';
import type { Task } from '@shared/model';
import type { SaveSkillResult } from './store';

const NOW = 1_700_000_000_000;

function baseSkill(overrides: Partial<Skill> = {}): Skill {
  return {
    id: 'skill-1',
    name: 'tdd',
    description: 'Write the test first',
    body: 'Body text.',
    createdAt: NOW - 100_000,
    updatedAt: NOW - 100_000,
    ...overrides,
  };
}

function baseTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    projectId: 'project-1',
    phase: '',
    title: 'A task',
    status: 'pending',
    sessionId: null,
    order: 0,
    dependsOn: [],
    source: 'adhoc',
    isContract: false,
    isScaffold: false,
    ...overrides,
  };
}

interface Harness {
  registry: RelayRegistry;
  handlers: ReturnType<typeof createSkillHandlers>;
  skills: Skill[];
  tasks: Map<string, Task>;
  saveSkill: Mock;
  deleteSkill: Mock;
  taskChanged: Mock;
}

function buildHarness(
  opts: {
    skills?: Skill[];
    tasks?: Task[];
    pickImportFiles?: SkillHandlersDeps['pickImportFiles'];
    pickImportFolder?: SkillHandlersDeps['pickImportFolder'];
    pickExportDir?: SkillHandlersDeps['pickExportDir'];
    readText?: SkillHandlersDeps['readText'];
    listDir?: SkillHandlersDeps['listDir'];
    writeText?: SkillHandlersDeps['writeText'];
  } = {},
): Harness {
  const skills = [...(opts.skills ?? [])];
  const tasks = new Map((opts.tasks ?? []).map((t) => [t.id, t] as const));

  const saveSkill = vi.fn((skill: Skill): SaveSkillResult => {
    if (!isValidSkillName(skill.name)) return { ok: false, reason: 'invalid-name' };
    if (Buffer.byteLength(skill.body, 'utf8') > SKILL_BODY_MAX) {
      return { ok: false, reason: 'too-large' };
    }
    const ownedBy = skills.find((s) => s.name === skill.name);
    if (ownedBy && ownedBy.id !== skill.id) return { ok: false, reason: 'name-taken' };
    const i = skills.findIndex((s) => s.id === skill.id);
    if (i === -1) skills.push(skill);
    else skills[i] = skill;
    return { ok: true, skill };
  });

  const deleteSkill = vi.fn((id: string) => {
    const i = skills.findIndex((s) => s.id === id);
    if (i === -1) return false;
    skills.splice(i, 1);
    return true;
  });

  const taskChanged = vi.fn();

  const deps: SkillHandlersDeps = {
    store: {
      getSkills: () => [...skills],
      getSkill: (id) => skills.find((s) => s.id === id),
      saveSkill,
      deleteSkill,
      getProject: () => undefined,
      getTask: (id) => tasks.get(id),
      setTaskSkillRefs: (id, refs) => {
        const task = tasks.get(id);
        if (!task) return undefined;
        const updated = { ...task, skillRefs: [...refs] };
        tasks.set(id, updated);
        return updated;
      },
    },
    now: () => NOW,
    newId: () => 'generated-1',
    hostFor: () => {
      throw new Error('hostFor should not have been called');
    },
    pickImportFiles:
      opts.pickImportFiles ??
      (() => {
        throw new Error('pickImportFiles should not have been called');
      }),
    pickImportFolder:
      opts.pickImportFolder ??
      (() => {
        throw new Error('pickImportFolder should not have been called');
      }),
    pickExportDir:
      opts.pickExportDir ??
      (() => {
        throw new Error('pickExportDir should not have been called');
      }),
    readText:
      opts.readText ??
      (() => {
        throw new Error('readText should not have been called');
      }),
    listDir:
      opts.listDir ??
      (() => {
        throw new Error('listDir should not have been called');
      }),
    writeText:
      opts.writeText ??
      (() => {
        throw new Error('writeText should not have been called');
      }),
    taskChanged,
  };

  const handlers = createSkillHandlers(deps);
  const registry = new RelayRegistry();
  for (const channel of Object.keys(handlers) as (keyof typeof handlers)[]) {
    registry.register(channel, handlers[channel] as never);
  }

  return { registry, handlers, skills, tasks, saveSkill, deleteSkill, taskChanged };
}

describe('skill:save', () => {
  it('refuses a name belonging to a different skill, naming it, without writing', async () => {
    const existing = baseSkill({ id: 'skill-1', name: 'tdd' });
    const other = baseSkill({ id: 'skill-2', name: 'other' });
    const harness = buildHarness({ skills: [existing, other] });

    const result = await harness.registry.invoke('skill:save', [
      { id: 'skill-2', name: 'tdd', description: other.description, body: other.body },
    ]);

    expect(result).toEqual({
      ok: true,
      value: {
        ok: false,
        reason: 'name-taken',
        message: 'A skill named "tdd" already exists.',
      },
    });
    expect(harness.skills).toEqual([existing, other]);
  });

  it('succeeds when saving a skill under its own name, keeping createdAt', async () => {
    const existing = baseSkill({ id: 'skill-1', name: 'tdd', createdAt: 42 });
    const harness = buildHarness({ skills: [existing] });

    const result = await harness.registry.invoke('skill:save', [
      { id: 'skill-1', name: 'tdd', description: 'Updated', body: 'New body.' },
    ]);

    expect(result.ok).toBe(true);
    const value = result.value as { ok: true; skill: Skill };
    expect(value.ok).toBe(true);
    expect(value.skill.createdAt).toBe(42);
    expect(value.skill.description).toBe('Updated');
    expect(value.skill.updatedAt).toBe(NOW);
    expect(harness.skills).toEqual([value.skill]);
  });
});

describe('skill:import — text', () => {
  it('refuses text with no frontmatter as no-name', async () => {
    const harness = buildHarness();

    const result = await harness.handlers['skill:import']({
      source: 'text',
      text: 'Just plain markdown, no frontmatter.',
    });

    expect(result).toEqual([
      {
        status: 'refused',
        source: 'text',
        reason: 'no-name',
        message:
          'No valid skill name in the frontmatter, and no usable file or folder name to fall back to.',
      },
    ]);
    expect(harness.skills).toEqual([]);
  });

  it('refuses text with an unclosed frontmatter block as no-name', async () => {
    const harness = buildHarness();

    const result = await harness.handlers['skill:import']({
      source: 'text',
      text: '---\nname: tdd\ndescription: d\n\nNo closing delimiter.',
    });

    expect(result).toEqual([
      {
        status: 'refused',
        source: 'text',
        reason: 'no-name',
        message:
          'No valid skill name in the frontmatter, and no usable file or folder name to fall back to.',
      },
    ]);
  });

  it('refuses a body over SKILL_BODY_MAX as too-large', async () => {
    const harness = buildHarness();
    const body = 'a'.repeat(SKILL_BODY_MAX + 1);

    const result = await harness.handlers['skill:import']({
      source: 'text',
      text: `---\nname: tdd\ndescription: d\n---\n\n${body}`,
    });

    expect(result).toEqual([
      {
        status: 'refused',
        source: 'text',
        reason: 'too-large',
        message: '"tdd" is larger than 64 KiB and cannot be imported.',
      },
    ]);
    expect(harness.skills).toEqual([]);
  });

  it('clashes against an existing skill, carrying candidate and existing, store untouched', async () => {
    const existing = baseSkill({ id: 'skill-1', name: 'tdd' });
    const harness = buildHarness({ skills: [existing] });

    const result = await harness.handlers['skill:import']({
      source: 'text',
      text: '---\nname: tdd\ndescription: Imported description\n---\n\nImported body.',
    });

    expect(result).toEqual([
      {
        status: 'clash',
        candidate: { name: 'tdd', description: 'Imported description', body: 'Imported body.' },
        existing,
        source: 'text',
        message: 'A skill named "tdd" already exists.',
      },
    ]);
    expect(harness.skills).toEqual([existing]);
  });
});

describe('skill:import — folder', () => {
  it('imports a malformed SKILL.md, name = folder, warnings non-empty', async () => {
    const dir = join('/projects', 'demo', '.claude', 'skills');
    const harness = buildHarness({
      pickImportFolder: async () => dir,
      listDir: async () => [{ name: 'cool-skill', isDirectory: true }],
      readText: async (path) => {
        expect(path).toBe(join(dir, 'cool-skill', 'SKILL.md'));
        return 'No frontmatter at all, just prose.';
      },
    });

    const result = await harness.handlers['skill:import']({ source: 'folder' });

    expect(result).not.toBeNull();
    const [imported] = result as Array<{ status: string }>;
    expect(imported.status).toBe('imported');
    const typed = imported as { status: 'imported'; skill: Skill; warnings: string[] };
    expect(typed.skill.name).toBe('cool-skill');
    expect(typed.warnings.length).toBeGreaterThan(0);
    expect(harness.skills.map((s) => s.name)).toEqual(['cool-skill']);
  });

  it('refuses an unreadable file as unreadable', async () => {
    const harness = buildHarness({
      pickImportFolder: async () => join('/projects', 'demo', '.claude', 'skills'),
      listDir: async () => [{ name: 'broken', isDirectory: true }],
      readText: async () => {
        throw new Error('EACCES');
      },
    });

    const result = await harness.handlers['skill:import']({ source: 'folder' });

    expect(result).toEqual([
      {
        status: 'refused',
        source: 'folder',
        reason: 'unreadable',
        message: 'No readable SKILL.md under broken.',
      },
    ]);
  });
});

describe('skill:import / skill:export — cancelled picker', () => {
  it('returns null for skill:import when the folder picker is cancelled', async () => {
    const harness = buildHarness({ pickImportFolder: async () => null });

    const result = await harness.handlers['skill:import']({ source: 'folder' });

    expect(result).toBeNull();
  });

  it('returns null for skill:export when the folder picker is cancelled', async () => {
    const harness = buildHarness({ pickExportDir: async () => null });

    const result = await harness.handlers['skill:export'](['skill-1']);

    expect(result).toBeNull();
  });
});

describe('task:setSkillRefs', () => {
  it('throws for an unknown task', async () => {
    const harness = buildHarness();

    const result = await harness.registry.invoke('task:setSkillRefs', ['missing', ['lib:1']]);

    expect(result).toEqual({ ok: false, error: 'Task not found.' });
    expect(harness.taskChanged).not.toHaveBeenCalled();
  });

  it('writes the refs and calls taskChanged for a known task', async () => {
    const task = baseTask({ id: 'task-1' });
    const harness = buildHarness({ tasks: [task] });

    const result = await harness.registry.invoke('task:setSkillRefs', [
      'task-1',
      ['lib:skill-1', 'repo:tdd'],
    ]);

    expect(result.ok).toBe(true);
    const value = result.value as Task;
    expect(value.skillRefs).toEqual(['lib:skill-1', 'repo:tdd']);
    expect(harness.taskChanged).toHaveBeenCalledTimes(1);
    expect(harness.taskChanged).toHaveBeenCalledWith(value);
  });
});
