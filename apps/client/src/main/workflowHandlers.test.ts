/**
 * Proves the seven `workflow:*` handler bodies through the SAME path a browser tab actually
 * takes: a real `RelayRegistry`, dispatching to handlers built by `createWorkflowHandlers` —
 * no Electron, no real `Store`. Modelled on `skillHandlers.test.ts`: the in-memory store
 * fake's `saveWorkflow` calls the real `validateWorkflow` rather than stubbing it away, so an
 * invalid document is caught at the same layer production code catches it.
 *
 * `workflow:import` and `workflow:export` are host-only (`ipcRelay.ts`), so a real
 * `RelayRegistry` would refuse them before the handler ever ran — those two are called
 * directly off the handlers object instead, the same way `ipc.ts` itself calls them from a
 * native dialog callback.
 */
import { describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import { createWorkflowHandlers, type WorkflowHandlersDeps } from './workflowHandlers';
import { RelayRegistry } from './ipcRegistry';
import { MAX_PLAN_STEPS } from '@shared/board';
import type { Project, Task } from '@shared/model';
import {
  validateWorkflow,
  type AgentStep,
  type GateStep,
  type WorkflowDoc,
  type WorkflowStep,
} from '@shared/workflow';
import type { SaveWorkflowResult, SyncOnly } from './store';

function baseTask(over: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    projectId: 'proj-1',
    phase: '',
    title: 'A card',
    status: 'pending',
    sessionId: null,
    order: 0,
    dependsOn: [],
    source: 'adhoc',
    isContract: false,
    isScaffold: false,
    agentProjectId: null,
    ...over,
  };
}

function baseProject(over: Partial<Project> = {}): Project {
  return {
    id: 'proj-1',
    name: 'A project',
    path: '/repo',
    ...over,
  } as Project;
}

function agentStep(over: Partial<AgentStep> = {}): AgentStep {
  return {
    id: 'a1',
    kind: 'agent',
    title: 'Implement the feature',
    brief: 'Add the thing the ticket asks for.',
    ...over,
  };
}

function gateStep(over: Partial<GateStep> = {}): GateStep {
  return {
    id: 'g1',
    kind: 'gate',
    title: 'Run tests',
    command: 'pnpm test',
    onFail: { retryFrom: 'a1', maxAttempts: 3 },
    ...over,
  };
}

function workflowDoc(over: Partial<WorkflowDoc> = {}): WorkflowDoc {
  return {
    version: 1,
    id: 'wf-1',
    name: 'Implement + test gate',
    steps: [agentStep(), gateStep()],
    ...over,
  };
}

interface Harness {
  registry: RelayRegistry;
  handlers: ReturnType<typeof createWorkflowHandlers>;
  workflows: WorkflowDoc[];
  tasks: Map<string, Task>;
  projects: Map<string, Project>;
  saveWorkflow: Mock;
  deleteWorkflow: Mock;
  updateTask: Mock;
  setTaskSkillRefs: Mock;
  workflowsChanged: Mock;
  tasksChanged: Mock;
}

function buildHarness(
  opts: {
    workflows?: WorkflowDoc[];
    tasks?: Task[];
    projects?: Project[];
    newId?: WorkflowHandlersDeps['newId'];
    pickImportFile?: WorkflowHandlersDeps['pickImportFile'];
    pickExportPath?: WorkflowHandlersDeps['pickExportPath'];
    readText?: WorkflowHandlersDeps['readText'];
    writeText?: WorkflowHandlersDeps['writeText'];
  } = {},
): Harness {
  const workflows = [...(opts.workflows ?? [])];
  const tasks = new Map((opts.tasks ?? []).map((t) => [t.id, t] as const));
  const projects = new Map((opts.projects ?? []).map((p) => [p.id, p] as const));

  const saveWorkflow = vi.fn((doc: WorkflowDoc): SaveWorkflowResult => {
    const result = validateWorkflow(doc);
    if (!result.ok) return { ok: false, reason: 'invalid', issues: result.issues };
    const now = Date.now();
    const i = workflows.findIndex((w) => w.id === result.doc.id);
    if (i === -1) workflows.push(result.doc);
    else workflows[i] = result.doc;
    return { ok: true, workflow: result.doc, createdAt: now, updatedAt: now };
  });

  const deleteWorkflow = vi.fn((id: string) => {
    const i = workflows.findIndex((w) => w.id === id);
    if (i === -1) return false;
    workflows.splice(i, 1);
    return true;
  });

  let nextStepSeq = 0;
  const addSubtask = vi.fn(
    (
      parentId: string,
      input: {
        title: string;
        description?: string | null;
        round?: number;
        stepSpec?: WorkflowStep | null;
        workflowId?: string | null;
      },
    ): Task | undefined => {
      const title = input.title.trim();
      if (!title) return undefined;
      const parent = tasks.get(parentId);
      if (!parent || parent.parentTaskId) return undefined;

      const siblingRounds = [...tasks.values()]
        .filter((t) => t.parentTaskId === parentId)
        .map((t) => t.planRound ?? 0);
      const currentRound = Math.max(1, siblingRounds.length > 0 ? Math.max(...siblingRounds) : 0);

      nextStepSeq += 1;
      const task: Task = {
        id: `step-${nextStepSeq}`,
        projectId: parent.projectId,
        phase: parent.phase,
        title,
        status: 'pending',
        sessionId: null,
        order: nextStepSeq,
        dependsOn: [],
        source: 'adhoc',
        isContract: false,
        isScaffold: false,
        parentTaskId: parentId,
        description: input.description?.trim() || null,
        agentProjectId: parent.agentProjectId ?? null,
        agentModel: null,
        agentMode: 'bypassPermissions',
        planRound: input.round ?? currentRound,
        stepSpec: input.stepSpec ?? null,
        workflowId: input.workflowId ?? null,
      };
      tasks.set(task.id, task);
      return task;
    },
  );

  const updateTask = vi.fn((id: string, patch: Partial<Task>): Task | undefined => {
    const task = tasks.get(id);
    if (!task) return undefined;
    const updated = { ...task, ...patch };
    tasks.set(id, updated);
    return updated;
  });

  const setTaskSkillRefs = vi.fn((id: string, refs: readonly string[]): Task | undefined => {
    const task = tasks.get(id);
    if (!task) return undefined;
    const updated = { ...task, skillRefs: [...refs] };
    tasks.set(id, updated);
    return updated;
  });

  const workflowsChanged = vi.fn();
  const tasksChanged = vi.fn();

  const deps: WorkflowHandlersDeps = {
    store: {
      getWorkflows: () => [...workflows],
      getWorkflow: (id) => workflows.find((w) => w.id === id),
      saveWorkflow,
      deleteWorkflow,
      getTask: (id) => tasks.get(id),
      getProject: (id) => projects.get(id),
      getSubtasks: (parentId) => [...tasks.values()].filter((t) => t.parentTaskId === parentId),
      maxSubtaskRound: (parentId) => {
        const rounds = [...tasks.values()]
          .filter((t) => t.parentTaskId === parentId)
          .map((t) => t.planRound ?? 0);
        return rounds.length > 0 ? Math.max(...rounds) : 0;
      },
      addSubtask,
      updateTask,
      setTaskSkillRefs,
      runInTransaction<T>(fn: () => T, ..._syncOnly: SyncOnly<T>): T {
        return fn();
      },
    },
    newId: opts.newId ?? (() => 'generated-id'),
    pickImportFile:
      opts.pickImportFile ??
      (() => {
        throw new Error('pickImportFile should not have been called');
      }),
    pickExportPath:
      opts.pickExportPath ??
      (() => {
        throw new Error('pickExportPath should not have been called');
      }),
    readText:
      opts.readText ??
      (() => {
        throw new Error('readText should not have been called');
      }),
    writeText:
      opts.writeText ??
      (() => {
        throw new Error('writeText should not have been called');
      }),
    workflowsChanged,
    tasksChanged,
  };

  const handlers = createWorkflowHandlers(deps);
  const registry = new RelayRegistry();
  for (const channel of Object.keys(handlers) as (keyof typeof handlers)[]) {
    registry.register(channel, handlers[channel] as never);
  }

  return {
    registry,
    handlers,
    workflows,
    tasks,
    projects,
    saveWorkflow,
    deleteWorkflow,
    updateTask,
    setTaskSkillRefs,
    workflowsChanged,
    tasksChanged,
  };
}

describe('workflow:apply — reject before any refusal is even possible', () => {
  it('throws for an unknown task', async () => {
    const harness = buildHarness();

    const result = await harness.registry.invoke('workflow:apply', ['missing', 'wf-1']);

    expect(result).toEqual({ ok: false, error: 'Task not found.' });
  });

  it.each(['running', 'waiting-input'] as const)('throws when the card is %s', async (status) => {
    const task = baseTask({ id: 'task-1', status });
    const harness = buildHarness({ tasks: [task] });

    const result = await harness.registry.invoke('workflow:apply', ['task-1', 'wf-1']);

    expect(result).toEqual({ ok: false, error: 'Stop the task before applying a workflow.' });
  });
});

describe('workflow:apply — is-step', () => {
  it('refuses to apply a workflow to a step rather than its parent card', async () => {
    const parent = baseTask({ id: 'parent-1' });
    const step = baseTask({ id: 'step-1', parentTaskId: 'parent-1' });
    const harness = buildHarness({ tasks: [parent, step] });

    const result = await harness.handlers['workflow:apply']('step-1', 'wf-1');

    expect(result).toEqual({
      ok: false,
      reason: 'is-step',
      message: 'Apply a workflow to the card, not to one of its steps.',
    });
  });
});

describe('workflow:apply — no-project', () => {
  it('refuses a card with no agentProjectId', async () => {
    const task = baseTask({ id: 'task-1', agentProjectId: null });
    const harness = buildHarness({ tasks: [task] });

    const result = await harness.handlers['workflow:apply']('task-1', 'wf-1');

    expect(result).toEqual({
      ok: false,
      reason: 'no-project',
      message: 'Assign this card to an agent project before applying a workflow.',
    });
  });

  it('refuses a card whose project has no repo', async () => {
    const project = baseProject({ id: 'proj-1', path: '' });
    const task = baseTask({ id: 'task-1', agentProjectId: 'proj-1' });
    const harness = buildHarness({ projects: [project], tasks: [task] });

    const result = await harness.handlers['workflow:apply']('task-1', 'wf-1');

    expect(result).toEqual({
      ok: false,
      reason: 'no-project',
      message: 'Assign this card to an agent project before applying a workflow.',
    });
  });
});

describe('workflow:apply — unfinished-steps', () => {
  it('refuses a card with a pending step', async () => {
    const project = baseProject({ id: 'proj-1', path: '/repo' });
    const task = baseTask({ id: 'task-1', agentProjectId: 'proj-1' });
    const pendingStep = baseTask({ id: 'step-1', parentTaskId: 'task-1', status: 'pending' });
    const harness = buildHarness({ projects: [project], tasks: [task, pendingStep] });

    const result = await harness.handlers['workflow:apply']('task-1', 'wf-1');

    expect(result).toEqual({
      ok: false,
      reason: 'unfinished-steps',
      message: 'Finish or remove the current steps first.',
    });
  });

  it('refuses a card with a failed step', async () => {
    const project = baseProject({ id: 'proj-1', path: '/repo' });
    const task = baseTask({ id: 'task-1', agentProjectId: 'proj-1' });
    const failedStep = baseTask({ id: 'step-1', parentTaskId: 'task-1', status: 'failed' });
    const harness = buildHarness({ projects: [project], tasks: [task, failedStep] });

    const result = await harness.handlers['workflow:apply']('task-1', 'wf-1');

    expect(result).toEqual({
      ok: false,
      reason: 'unfinished-steps',
      message: 'Finish or remove the current steps first.',
    });
  });
});

describe('workflow:apply — invalid', () => {
  it('refuses an unknown workflow id', async () => {
    const project = baseProject({ id: 'proj-1', path: '/repo' });
    const task = baseTask({ id: 'task-1', agentProjectId: 'proj-1' });
    const harness = buildHarness({ projects: [project], tasks: [task] });

    const result = await harness.handlers['workflow:apply']('task-1', 'missing-wf');

    expect(result).toEqual({
      ok: false,
      reason: 'invalid',
      message: 'This workflow is no longer valid.',
    });
  });

  it('refuses a stored document that no longer passes validateWorkflow, carrying its issues', async () => {
    const project = baseProject({ id: 'proj-1', path: '/repo' });
    const task = baseTask({ id: 'task-1', agentProjectId: 'proj-1' });
    const broken = { version: 1, id: 'wf-broken', name: 'Broken', steps: [] } as WorkflowDoc;
    const harness = buildHarness({ projects: [project], tasks: [task], workflows: [broken] });

    const result = await harness.handlers['workflow:apply']('task-1', 'wf-broken');

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected a refusal');
    expect(result.reason).toBe('invalid');
    expect(result.message).toBe('This workflow is no longer valid.');
    expect(result.issues).toContain('A workflow needs at least one step.');
  });
});

describe('workflow:apply — chain-full', () => {
  it('refuses when applying would push the card past MAX_PLAN_STEPS', async () => {
    const project = baseProject({ id: 'proj-1', path: '/repo' });
    const task = baseTask({ id: 'task-1', agentProjectId: 'proj-1' });
    const doneSteps = Array.from({ length: MAX_PLAN_STEPS }, (_, i) =>
      baseTask({ id: `old-${i}`, parentTaskId: 'task-1', status: 'done', planRound: 1 }),
    );
    const doc = workflowDoc({ id: 'wf-1', steps: [agentStep({ id: 'a1' })] });
    const harness = buildHarness({
      projects: [project],
      tasks: [task, ...doneSteps],
      workflows: [doc],
    });

    const result = await harness.handlers['workflow:apply']('task-1', 'wf-1');

    expect(result).toEqual({
      ok: false,
      reason: 'chain-full',
      message: `This card already carries ${MAX_PLAN_STEPS} steps — the most one card can hold.`,
    });
  });
});

describe('workflow:apply — happy path', () => {
  it('writes a fresh round with stepSpec/workflowId, agent overrides and a resolved retryFromIndex, and calls tasksChanged once', async () => {
    const project = baseProject({ id: 'proj-1', path: '/repo' });
    const task = baseTask({ id: 'task-1', projectId: 'proj-1', agentProjectId: 'proj-1' });
    const doc = workflowDoc({
      id: 'wf-1',
      steps: [
        agentStep({ id: 'a1', model: 'sonnet', mode: 'plan', skillRefs: ['lib:abc123'] }),
        gateStep({ id: 'g1', onFail: { retryFrom: 'a1', maxAttempts: 2 } }),
      ],
    });
    const harness = buildHarness({ projects: [project], tasks: [task], workflows: [doc] });

    const result = await harness.handlers['workflow:apply']('task-1', 'wf-1');

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    expect(result.steps).toHaveLength(2);
    expect(result.steps.every((s) => s.planRound === 1)).toBe(true);
    expect(result.steps.every((s) => s.workflowId === 'wf-1')).toBe(true);
    expect(result.steps.every((s) => s.stepSpec !== null)).toBe(true);

    const [implementStep, gateTask] = result.steps;
    expect(implementStep.agentModel).toBe('sonnet');
    expect(implementStep.agentMode).toBe('plan');
    expect(implementStep.skillRefs).toEqual(['lib:abc123']);

    const resolvedGate = gateTask.stepSpec as GateStep & { onFail: { retryFromIndex: number } };
    expect(resolvedGate.onFail.retryFromIndex).toBe(0);

    expect(harness.tasksChanged).toHaveBeenCalledTimes(1);
    expect(harness.tasksChanged).toHaveBeenCalledWith('proj-1');
  });

  it('accepts a second workflow as a new round once every earlier step is done', async () => {
    const project = baseProject({ id: 'proj-1', path: '/repo' });
    const task = baseTask({ id: 'task-1', projectId: 'proj-1', agentProjectId: 'proj-1' });
    const doneStep = baseTask({
      id: 'old-1',
      parentTaskId: 'task-1',
      status: 'done',
      planRound: 1,
    });
    const doc = workflowDoc({ id: 'wf-2', steps: [agentStep({ id: 'a1' })] });
    const harness = buildHarness({
      projects: [project],
      tasks: [task, doneStep],
      workflows: [doc],
    });

    const result = await harness.handlers['workflow:apply']('task-1', 'wf-2');

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0].planRound).toBe(2);
  });
});

describe('workflow:save', () => {
  it('mints a fresh id when none is given', async () => {
    const harness = buildHarness({ newId: () => 'new-wf-id' });

    const result = await harness.registry.invoke('workflow:save', [
      { version: 1, name: 'New workflow', steps: [agentStep()] },
    ]);

    expect(result.ok).toBe(true);
    const value = result.value as { ok: true; workflow: WorkflowDoc };
    expect(value.ok).toBe(true);
    expect(value.workflow.id).toBe('new-wf-id');
    expect(harness.workflowsChanged).toHaveBeenCalledTimes(1);
  });

  it('returns issues for an invalid document, without calling workflowsChanged', async () => {
    const harness = buildHarness();

    const result = await harness.registry.invoke('workflow:save', [
      { version: 1, name: '', steps: [] },
    ]);

    expect(result.ok).toBe(true);
    const value = result.value as { ok: false; reason: 'invalid'; issues: string[] };
    expect(value.ok).toBe(false);
    expect(value.issues.length).toBeGreaterThan(0);
    expect(harness.workflowsChanged).not.toHaveBeenCalled();
  });
});

describe('workflow:delete', () => {
  it('calls workflowsChanged on a successful delete', async () => {
    const doc = workflowDoc({ id: 'wf-1' });
    const harness = buildHarness({ workflows: [doc] });

    const result = await harness.registry.invoke('workflow:delete', ['wf-1']);

    expect(result).toEqual({ ok: true, value: true });
    expect(harness.workflowsChanged).toHaveBeenCalledTimes(1);
  });

  it('does not call workflowsChanged when nothing was deleted', async () => {
    const harness = buildHarness();

    const result = await harness.registry.invoke('workflow:delete', ['missing']);

    expect(result).toEqual({ ok: true, value: false });
    expect(harness.workflowsChanged).not.toHaveBeenCalled();
  });
});

describe('workflow:import — text', () => {
  it('refuses bad JSON', async () => {
    const harness = buildHarness();

    const result = await harness.handlers['workflow:import']({
      source: 'text',
      text: 'not json at all',
    });

    expect(result).toEqual({
      ok: false,
      reason: 'invalid',
      issues: ['This file is not valid JSON.'],
    });
  });

  it('refuses a document that fails validateWorkflow, carrying its issues', async () => {
    const harness = buildHarness();

    const result = await harness.handlers['workflow:import']({
      source: 'text',
      text: JSON.stringify({ version: 1, name: '', steps: [] }),
    });

    expect(result).not.toBeNull();
    expect(result?.ok).toBe(false);
    if (!result || result.ok) throw new Error('expected a refusal');
    expect(result.reason).toBe('invalid');
    expect(result.issues.length).toBeGreaterThan(0);
  });

  it('mints a fresh id on success, ignoring any id in the imported JSON', async () => {
    const harness = buildHarness({ newId: () => 'imported-id' });

    const result = await harness.handlers['workflow:import']({
      source: 'text',
      text: JSON.stringify({
        version: 1,
        id: 'whatever-the-file-said',
        name: 'Imported',
        steps: [agentStep()],
      }),
    });

    expect(result?.ok).toBe(true);
    if (!result || !result.ok) throw new Error('expected success');
    expect(result.workflow.id).toBe('imported-id');
    expect(harness.workflowsChanged).toHaveBeenCalledTimes(1);
  });
});

describe('workflow:import — file', () => {
  it('returns null when the picker is cancelled', async () => {
    const harness = buildHarness({ pickImportFile: async () => null });

    const result = await harness.handlers['workflow:import']({ source: 'file' });

    expect(result).toBeNull();
  });

  it('reads the picked file and imports it', async () => {
    const harness = buildHarness({
      pickImportFile: async () => '/picked/workflow.json',
      readText: async (path) => {
        expect(path).toBe('/picked/workflow.json');
        return JSON.stringify({ version: 1, name: 'From disk', steps: [agentStep()] });
      },
      newId: () => 'file-id',
    });

    const result = await harness.handlers['workflow:import']({ source: 'file' });

    expect(result?.ok).toBe(true);
    if (!result || !result.ok) throw new Error('expected success');
    expect(result.workflow.id).toBe('file-id');
  });

  it('refuses an unreadable file', async () => {
    const harness = buildHarness({
      pickImportFile: async () => '/picked/workflow.json',
      readText: async () => {
        throw new Error('EACCES');
      },
    });

    const result = await harness.handlers['workflow:import']({ source: 'file' });

    expect(result).toEqual({
      ok: false,
      reason: 'unreadable',
      issues: ['Could not read workflow.json.'],
    });
  });
});

describe('workflow:export', () => {
  it('writes pretty JSON to the picked path', async () => {
    const doc = workflowDoc({ id: 'wf-1', name: 'Export me' });
    let written: { path: string; text: string } | undefined;
    const harness = buildHarness({
      workflows: [doc],
      pickExportPath: async (defaultName) => {
        expect(defaultName).toBe('export-me.workflow.json');
        return '/exports/export-me.workflow.json';
      },
      writeText: async (path, text) => {
        written = { path, text };
      },
    });

    const result = await harness.handlers['workflow:export']('wf-1');

    expect(result).toEqual({ path: '/exports/export-me.workflow.json' });
    expect(written).toEqual({
      path: '/exports/export-me.workflow.json',
      text: `${JSON.stringify(doc, null, 2)}\n`,
    });
  });

  it('returns null when the picker is cancelled', async () => {
    const doc = workflowDoc({ id: 'wf-1' });
    const harness = buildHarness({ workflows: [doc], pickExportPath: async () => null });

    const result = await harness.handlers['workflow:export']('wf-1');

    expect(result).toBeNull();
  });

  it('returns null for an unknown workflow id without opening a picker', async () => {
    const harness = buildHarness();

    const result = await harness.handlers['workflow:export']('missing');

    expect(result).toBeNull();
  });
});

describe('host-only channels refused through RelayRegistry', () => {
  it('refuses workflow:import and workflow:export even though handlers are registered', async () => {
    const harness = buildHarness();

    const importResult = await harness.registry.invoke('workflow:import', [{ source: 'file' }]);
    const exportResult = await harness.registry.invoke('workflow:export', ['wf-1']);

    expect(importResult.ok).toBe(false);
    expect(importResult.error).toContain('file picker');
    expect(exportResult.ok).toBe(false);
    expect(exportResult.error).toContain('file picker');
  });
});
