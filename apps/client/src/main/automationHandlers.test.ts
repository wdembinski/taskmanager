/**
 * Proves the `automation:*` channels refuse a non-owned relayed edit through the SAME path a
 * browser tab actually takes: a real `RelayRegistry`, dispatching to handlers built by
 * `createAutomationHandlers` — no Electron, no real Store. `automationEdits.test.ts` already
 * covers the ownership rule itself as a pure function; this is the wiring around it, proven
 * the way `ipcRegistry.test.ts` proves the registry itself.
 */
import { describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import { createAutomationHandlers, type AutomationHandlersDeps } from './automationHandlers';
import { RelayRegistry } from './ipcRegistry';
import type { Automation, AutomationRun } from '@shared/automation';
import type { AutomationFiring, AutomationRunDuplicate } from './automationRunner';

const NOW = 1_700_000_000_000;
const LOCAL_CLIENT_ID = 'this-desktop';
const OTHER_CLIENT_ID = 'other-desktop';
const OWNED_ERROR = '‹Foreign one› is owned by another desktop — edit it there.';

function baseAutomation(overrides: Partial<Automation> = {}): Automation {
  return {
    id: 'auto-1',
    revision: 1,
    name: 'Foreign one',
    enabled: false,
    ownerClientId: OTHER_CLIENT_ID,
    timeZone: 'UTC',
    trigger: { kind: 'schedule', schedule: { type: 'daily', hour: 4, minute: 0 } },
    action: {
      boardProjectId: 'board-1',
      agentProjectId: 'agent-1',
      titleTemplate: 'Nightly — {{date}}',
      briefTemplate: 'Triage new tickets.',
      mode: 'bypassPermissions',
    },
    enabledAt: null,
    nextRunAt: null,
    consecutiveFailures: 0,
    createdAt: NOW - 100_000,
    updatedAt: NOW - 100_000,
    ...overrides,
  };
}

interface Harness {
  registry: RelayRegistry;
  automations: Automation[];
  saveAutomation: Mock;
  deleteAutomation: Mock;
  evaluate: Mock;
  pushAutomations: Mock;
  fire: Mock;
}

function buildHarness(initial: Automation[]): Harness {
  const automations = [...initial];
  const saveAutomation = vi.fn((a: Automation) => {
    const i = automations.findIndex((existing) => existing.id === a.id);
    if (i === -1) automations.push(a);
    else automations[i] = a;
  });
  const deleteAutomation = vi.fn((id: string) => {
    const i = automations.findIndex((a) => a.id === id);
    if (i !== -1) automations.splice(i, 1);
  });
  const evaluate = vi.fn();
  const pushAutomations = vi.fn(() => automations);
  const fire = vi.fn((): AutomationRun | AutomationRunDuplicate => {
    throw new Error('fire should not have been called');
  });

  const deps: AutomationHandlersDeps = {
    store: {
      getAutomations: () => automations,
      saveAutomation,
      deleteAutomation,
      getAutomationRuns: () => [],
      loadCloudClientId: () => LOCAL_CLIENT_ID,
    },
    evaluate,
    pushAutomations,
    fire: fire as unknown as (
      automation: Automation,
      firing: AutomationFiring,
    ) => AutomationRun | AutomationRunDuplicate,
    saveContext: () => ({ now: NOW, localClientId: LOCAL_CLIENT_ID, newId: () => 'generated-1' }),
    newId: () => 'generated-1',
  };

  const handlers = createAutomationHandlers(deps);
  const registry = new RelayRegistry();
  for (const channel of Object.keys(handlers) as (keyof typeof handlers)[]) {
    registry.register(channel, handlers[channel] as never);
  }

  return {
    registry,
    automations,
    saveAutomation,
    deleteAutomation,
    evaluate,
    pushAutomations,
    fire,
  };
}

describe('automation handlers — relayed ownership refusal', () => {
  it('refuses automation:save for a non-owned automation', async () => {
    const foreign = baseAutomation();
    const harness = buildHarness([foreign]);

    const result = await harness.registry.invoke('automation:save', [
      { ...foreign, name: 'Renamed' },
    ]);

    expect(result).toEqual({ ok: false, error: OWNED_ERROR });
    expect(harness.automations).toEqual([foreign]);
    expect(harness.saveAutomation).not.toHaveBeenCalled();
    expect(harness.evaluate).not.toHaveBeenCalled();
    expect(harness.pushAutomations).not.toHaveBeenCalled();
    expect(harness.fire).not.toHaveBeenCalled();
  });

  it('refuses automation:delete for a non-owned automation', async () => {
    const foreign = baseAutomation();
    const harness = buildHarness([foreign]);

    const result = await harness.registry.invoke('automation:delete', [foreign.id]);

    expect(result).toEqual({ ok: false, error: OWNED_ERROR });
    expect(harness.automations).toEqual([foreign]);
    expect(harness.deleteAutomation).not.toHaveBeenCalled();
    expect(harness.evaluate).not.toHaveBeenCalled();
    expect(harness.pushAutomations).not.toHaveBeenCalled();
    expect(harness.fire).not.toHaveBeenCalled();
  });

  it('refuses automation:setEnabled for a non-owned automation', async () => {
    const foreign = baseAutomation();
    const harness = buildHarness([foreign]);

    const result = await harness.registry.invoke('automation:setEnabled', [foreign.id, true]);

    expect(result).toEqual({ ok: false, error: OWNED_ERROR });
    expect(harness.automations).toEqual([foreign]);
    expect(harness.saveAutomation).not.toHaveBeenCalled();
    expect(harness.evaluate).not.toHaveBeenCalled();
    expect(harness.pushAutomations).not.toHaveBeenCalled();
    expect(harness.fire).not.toHaveBeenCalled();
  });

  it('refuses automation:runNow for a non-owned automation', async () => {
    const foreign = baseAutomation();
    const harness = buildHarness([foreign]);

    const result = await harness.registry.invoke('automation:runNow', [foreign.id]);

    expect(result).toEqual({ ok: false, error: OWNED_ERROR });
    expect(harness.automations).toEqual([foreign]);
    expect(harness.saveAutomation).not.toHaveBeenCalled();
    expect(harness.evaluate).not.toHaveBeenCalled();
    expect(harness.pushAutomations).not.toHaveBeenCalled();
    expect(harness.fire).not.toHaveBeenCalled();
  });

  it('saves an owned automation through the same relayed path', async () => {
    const owned = baseAutomation({ name: 'Mine', ownerClientId: LOCAL_CLIENT_ID });
    const harness = buildHarness([owned]);

    const result = await harness.registry.invoke('automation:save', [
      { ...owned, name: 'Renamed' },
    ]);

    expect(result.ok).toBe(true);
    expect((result.value as Automation).name).toBe('Renamed');
    expect(harness.saveAutomation).toHaveBeenCalledTimes(1);
    expect(harness.evaluate).toHaveBeenCalledTimes(1);
    expect(harness.pushAutomations).toHaveBeenCalledTimes(1);
    expect(harness.fire).not.toHaveBeenCalled();
  });
});
