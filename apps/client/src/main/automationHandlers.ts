/**
 * The six `automation:*` IPC handler bodies, pulled out of `ipc.ts` so they can be run — and
 * their ownership refusals proven — through a real {@link RelayRegistry} without standing up
 * Electron. No import here reaches `electron`; `ipc.ts` still does the `ipcMain.handle` /
 * `relayRegistry.register` wiring itself, via the small `handle()` helper it already has.
 *
 * `createAutomationHandlers` takes exactly what the six bodies touch — the store slice, the
 * clock's `evaluate`, the board-push and the runner's `fire`, plus `saveContext`/`newId` for
 * minting the server-owned fields a save stamps — and returns them keyed by channel, so
 * `ipc.ts` can register every one with a loop instead of six repeated `handle(...)` calls.
 */
import type { Automation, AutomationRun } from '@shared/automation';
import type { IpcApi } from '@shared/ipc';
import {
  assertCanRunNow,
  assertOwnedHere,
  manualFiring,
  prepareAutomationSave,
  prepareSetEnabled,
  type PrepareSaveContext,
} from './automationEdits';
import type { AutomationFiring, AutomationRunDuplicate } from './automationRunner';
import type { Store } from './store';

export interface AutomationHandlersDeps {
  store: Pick<
    Store,
    | 'getAutomations'
    | 'saveAutomation'
    | 'deleteAutomation'
    | 'getAutomationRuns'
    | 'loadCloudClientId'
  >;
  evaluate(): void;
  pushAutomations(): Automation[];
  fire(automation: Automation, firing: AutomationFiring): AutomationRun | AutomationRunDuplicate;
  saveContext(): PrepareSaveContext;
  newId(): string;
}

/** The subset of `IpcApi` these six channels implement — same contract, no Electron import. */
export type AutomationHandlers = Pick<
  IpcApi,
  | 'automation:list'
  | 'automation:save'
  | 'automation:delete'
  | 'automation:setEnabled'
  | 'automation:runNow'
  | 'automation:runs'
>;

export function createAutomationHandlers(deps: AutomationHandlersDeps): AutomationHandlers {
  /** `store.saveAutomation` + the clock re-arm + the board push, shared by save and setEnabled. */
  function commitAutomation(prepared: Automation): Automation {
    deps.store.saveAutomation(prepared);
    deps.evaluate();
    deps.pushAutomations();
    const saved = deps.store.getAutomations().find((a) => a.id === prepared.id);
    if (!saved) throw new Error('Could not save that automation.');
    return saved;
  }

  return {
    'automation:list': async () => deps.store.getAutomations(),

    'automation:save': async (input) => {
      const existing = deps.store.getAutomations().find((a) => a.id === input.id);
      return commitAutomation(prepareAutomationSave(input, existing, deps.saveContext()));
    },

    'automation:delete': async (id) => {
      const existing = deps.store.getAutomations().find((a) => a.id === id);
      if (!existing) return;
      assertOwnedHere(existing, deps.store.loadCloudClientId());
      deps.store.deleteAutomation(id);
      deps.evaluate();
      deps.pushAutomations();
    },

    'automation:setEnabled': async (id, enabled) => {
      const existing = deps.store.getAutomations().find((a) => a.id === id);
      if (!existing) throw new Error('That automation no longer exists.');
      return commitAutomation(prepareSetEnabled(existing, enabled, deps.saveContext()));
    },

    'automation:runNow': async (id) => {
      const automation = deps.store.getAutomations().find((a) => a.id === id);
      if (!automation) throw new Error('That automation no longer exists.');
      assertCanRunNow(automation, deps.store.loadCloudClientId());
      const run = deps.fire(automation, manualFiring(Date.now(), deps.newId));
      if (run.status === 'duplicate') {
        throw new Error(`‹${automation.name}› already has a run reserved for this occurrence.`);
      }
      deps.pushAutomations();
      return run;
    },

    'automation:runs': async (automationId, limit) =>
      deps.store.getAutomationRuns(automationId, limit),
  };
}
