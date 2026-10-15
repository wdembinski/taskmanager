/**
 * The seven `workflow:*` IPC handler bodies, pulled out of `ipc.ts` the same way
 * `skillHandlers.ts` pulls its nine out — so they can be run through a real
 * `RelayRegistry` in a test without standing up Electron. No import here reaches
 * `electron`; `ipc.ts` still does the `ipcMain.handle` / `relayRegistry.register` wiring
 * and the native `dialog.showOpenDialog` / `dialog.showSaveDialog` calls themselves,
 * handing this module only the already-resolved path (or `null` for "the human cancelled").
 *
 * `workflow:apply` is the one worth reading closely: it turns a stored `WorkflowDoc` into a
 * fresh round of a card's own steps, refusing with a typed `WorkflowApplyRefusal` for every
 * precondition `@shared/workflow` names rather than throwing — the same posture
 * `ChatRefusal` takes for a chat send. Only two cases throw, and both match an existing
 * `task:*` handler's own wording: an unknown task (`task:setSkillRefs`'s "Task not found."),
 * and a card an agent is actively working on (`task:delete`'s "Stop the task before…").
 */
import { basename } from 'node:path';
import { hasRepo, type Task } from '@shared/model';
import type { IpcApi } from '@shared/ipc';
import { MAX_PLAN_STEPS } from '@shared/board';
import {
  instantiateWorkflow,
  validateWorkflow,
  workflowDocBytes,
  workflowFileName,
  workflowTooLargeMessage,
  WORKFLOW_APPLY_REFUSAL_MESSAGE,
  WORKFLOW_DOC_MAX,
  type WorkflowDoc,
  type WorkflowImportResult,
} from '@shared/workflow';
import type { Store } from './store';

export interface WorkflowHandlersDeps {
  store: Pick<
    Store,
    | 'getWorkflows'
    | 'getWorkflow'
    | 'saveWorkflow'
    | 'deleteWorkflow'
    | 'getTask'
    | 'getProject'
    | 'getSubtasks'
    | 'maxSubtaskRound'
    | 'addSubtask'
    | 'updateTask'
    | 'setTaskSkillRefs'
    | 'runInTransaction'
  >;
  newId(): string;
  /** Open a native "choose a workflow file" dialog; the chosen absolute path, or `null` if
   *  cancelled. */
  pickImportFile(): Promise<string | null>;
  /** Open a native "save workflow as" dialog defaulted to `defaultName`; the chosen absolute
   *  path, or `null` if cancelled. */
  pickExportPath(defaultName: string): Promise<string | null>;
  readText(path: string): Promise<string>;
  writeText(path: string, text: string): Promise<void>;
  /** `cloudWorkflowPusher.scan()` — pushes a changed workflow to the cloud without waiting
   *  for the poller's own next tick. */
  workflowsChanged(): void;
  /** `send('project:tasksChanged', { projectId, tasks: store.getTasks(projectId) })` — the
   *  board push a card's own fresh steps need after landing. */
  tasksChanged(projectId: string): void;
}

/** The subset of `IpcApi` these seven channels implement — same contract, no Electron import. */
export type WorkflowHandlers = Pick<
  IpcApi,
  | 'workflow:list'
  | 'workflow:get'
  | 'workflow:save'
  | 'workflow:delete'
  | 'workflow:import'
  | 'workflow:export'
  | 'workflow:apply'
>;

/**
 * Parse → validate → size → save, for one imported document. Always saves under a FRESH
 * id (`newId()`, never whatever the parsed JSON names) so an import can never overwrite an
 * existing workflow. `WORKFLOW_DOC_MAX` is checked here rather than inside
 * `validateWorkflow` or `store.saveWorkflow` — neither enforces it today — the same reason
 * `importSkillText` (`skillHandlers.ts`) checks `SKILL_BODY_MAX` itself.
 */
function importWorkflowDoc(
  parsed: unknown,
  store: Pick<Store, 'saveWorkflow'>,
  newId: () => string,
): WorkflowImportResult {
  const base = typeof parsed === 'object' && parsed !== null ? parsed : {};
  const candidate = { ...base, id: newId() };

  const validated = validateWorkflow(candidate);
  if (!validated.ok) return { ok: false, reason: 'invalid', issues: validated.issues };

  const bytes = workflowDocBytes(validated.doc);
  if (bytes > WORKFLOW_DOC_MAX) {
    return { ok: false, reason: 'invalid', issues: [workflowTooLargeMessage(bytes)] };
  }

  const saved = store.saveWorkflow(validated.doc);
  if (!saved.ok) return { ok: false, reason: 'invalid', issues: saved.issues };
  return { ok: true, workflow: saved.workflow };
}

export function createWorkflowHandlers(deps: WorkflowHandlersDeps): WorkflowHandlers {
  function importWorkflowText(text: string): WorkflowImportResult {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { ok: false, reason: 'invalid', issues: ['This file is not valid JSON.'] };
    }
    return importWorkflowDoc(parsed, deps.store, deps.newId);
  }

  return {
    'workflow:list': async () => deps.store.getWorkflows(),

    'workflow:get': async (id) => deps.store.getWorkflow(id) ?? null,

    'workflow:save': async (draft) => {
      const doc: WorkflowDoc = { ...draft, id: draft.id ?? deps.newId() };
      const result = deps.store.saveWorkflow(doc);
      if (!result.ok) return { ok: false, reason: 'invalid', issues: result.issues };
      deps.workflowsChanged();
      return { ok: true, workflow: result.workflow };
    },

    'workflow:delete': async (id) => {
      const deleted = deps.store.deleteWorkflow(id);
      if (deleted) deps.workflowsChanged();
      return deleted;
    },

    'workflow:import': async (request) => {
      let result: WorkflowImportResult;
      if (request.source === 'text') {
        result = importWorkflowText(request.text);
      } else {
        const path = await deps.pickImportFile();
        if (!path) return null;
        let text: string;
        try {
          text = await deps.readText(path);
        } catch {
          return { ok: false, reason: 'unreadable', issues: [`Could not read ${basename(path)}.`] };
        }
        result = importWorkflowText(text);
      }
      if (result.ok) deps.workflowsChanged();
      return result;
    },

    'workflow:export': async (id) => {
      const doc = deps.store.getWorkflow(id);
      if (!doc) return null;
      const path = await deps.pickExportPath(workflowFileName(doc.name));
      if (!path) return null;
      await deps.writeText(path, `${JSON.stringify(doc, null, 2)}\n`);
      return { path };
    },

    'workflow:apply': async (taskId, workflowId) => {
      const task = deps.store.getTask(taskId);
      if (!task) throw new Error('Task not found.');

      if (task.parentTaskId) {
        return {
          ok: false,
          reason: 'is-step',
          message: WORKFLOW_APPLY_REFUSAL_MESSAGE['is-step'],
        };
      }

      if (task.status === 'running' || task.status === 'waiting-input') {
        throw new Error('Stop the task before applying a workflow.');
      }

      const project = task.agentProjectId ? deps.store.getProject(task.agentProjectId) : undefined;
      if (!project || !hasRepo(project)) {
        return {
          ok: false,
          reason: 'no-project',
          message: WORKFLOW_APPLY_REFUSAL_MESSAGE['no-project'],
        };
      }

      const existingSteps = deps.store.getSubtasks(taskId);
      if (existingSteps.some((step) => step.status !== 'done' && step.status !== 'cancelled')) {
        return {
          ok: false,
          reason: 'unfinished-steps',
          message: WORKFLOW_APPLY_REFUSAL_MESSAGE['unfinished-steps'],
        };
      }

      const stored = deps.store.getWorkflow(workflowId);
      if (!stored) {
        return { ok: false, reason: 'invalid', message: WORKFLOW_APPLY_REFUSAL_MESSAGE['invalid'] };
      }
      const validated = validateWorkflow(stored);
      if (!validated.ok) {
        return {
          ok: false,
          reason: 'invalid',
          message: WORKFLOW_APPLY_REFUSAL_MESSAGE['invalid'],
          issues: validated.issues,
        };
      }
      const doc = validated.doc;

      if (existingSteps.length + doc.steps.length > MAX_PLAN_STEPS) {
        return {
          ok: false,
          reason: 'chain-full',
          message: WORKFLOW_APPLY_REFUSAL_MESSAGE['chain-full'],
        };
      }

      const round = deps.store.runInTransaction(() => {
        const nextRound = deps.store.maxSubtaskRound(taskId) + 1;
        for (const stepDraft of instantiateWorkflow(doc, task, nextRound)) {
          const step = deps.store.addSubtask(taskId, {
            title: stepDraft.title,
            description: stepDraft.description,
            round: stepDraft.planRound,
            stepSpec: stepDraft.stepSpec,
            workflowId: stepDraft.workflowId,
          });
          if (!step) continue;

          const patch: Partial<Pick<Task, 'agentModel' | 'agentMode'>> = {};
          if (stepDraft.agentModel !== null) patch.agentModel = stepDraft.agentModel;
          if (stepDraft.agentMode !== null) patch.agentMode = stepDraft.agentMode;
          if (Object.keys(patch).length > 0) deps.store.updateTask(step.id, patch);

          if (stepDraft.skillRefs !== null)
            deps.store.setTaskSkillRefs(step.id, stepDraft.skillRefs);
        }
        return nextRound;
      });

      deps.tasksChanged(task.projectId);
      return {
        ok: true,
        steps: deps.store.getSubtasks(taskId).filter((step) => step.planRound === round),
      };
    },
  };
}
