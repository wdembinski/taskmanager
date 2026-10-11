/**
 * Unit tests for the automation edit rules — pure, per `automationEdits.ts`'s own contract,
 * so these never touch a real Store, Electron or the clock. In the style of
 * `automationClock.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import {
  assertCanRunNow,
  assertOwnedHere,
  isOwnedHere,
  manualFiring,
  prepareAutomationSave,
  prepareSetEnabled,
  type PrepareSaveContext,
} from './automationEdits';
import type { Automation } from '@shared/automation';

const NOW = 1_700_000_000_000;
const LOCAL_CLIENT_ID = 'client-local';

function baseAutomation(overrides: Partial<Automation> = {}): Automation {
  return {
    id: 'auto-1',
    revision: 1,
    name: 'Nightly triage',
    enabled: false,
    ownerClientId: null,
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

function ctx(overrides: Partial<PrepareSaveContext> = {}): PrepareSaveContext {
  let n = 0;
  return {
    now: NOW,
    localClientId: LOCAL_CLIENT_ID,
    newId: () => `generated-${++n}`,
    ...overrides,
  };
}

describe('isOwnedHere / assertOwnedHere', () => {
  it('a null owner and the local owner are both owned here', () => {
    expect(isOwnedHere(baseAutomation({ ownerClientId: null }), LOCAL_CLIENT_ID)).toBe(true);
    expect(isOwnedHere(baseAutomation({ ownerClientId: LOCAL_CLIENT_ID }), LOCAL_CLIENT_ID)).toBe(
      true,
    );
  });

  it('another desktop’s owner is not owned here, and asserting throws', () => {
    const foreign = baseAutomation({ name: 'Foreign one', ownerClientId: 'other-client' });

    expect(isOwnedHere(foreign, LOCAL_CLIENT_ID)).toBe(false);
    expect(() => assertOwnedHere(foreign, LOCAL_CLIENT_ID)).toThrow(
      '‹Foreign one› is owned by another desktop — edit it there.',
    );
  });
});

describe('prepareAutomationSave — create', () => {
  it('stamps owner, revision 1, createdAt and no enabledAt for a disabled create', () => {
    const input = baseAutomation({ enabled: false });

    const saved = prepareAutomationSave(input, undefined, ctx());

    expect(saved.ownerClientId).toBe(LOCAL_CLIENT_ID);
    expect(saved.revision).toBe(1);
    expect(saved.createdAt).toBe(NOW);
    expect(saved.updatedAt).toBe(NOW);
    expect(saved.enabledAt).toBeNull();
    expect(saved.nextRunAt).toBeNull();
    expect(saved.consecutiveFailures).toBe(0);
  });

  it('creating already-enabled stamps enabledAt too', () => {
    const input = baseAutomation({ enabled: true });

    const saved = prepareAutomationSave(input, undefined, ctx());

    expect(saved.enabledAt).toBe(NOW);
    expect(saved.nextRunAt).toBeNull();
    expect(saved.consecutiveFailures).toBe(0);
  });

  it('mints an id when input.id is empty, otherwise keeps it', () => {
    const minted = prepareAutomationSave(baseAutomation({ id: '' }), undefined, ctx());
    expect(minted.id).toBe('generated-1');

    const kept = prepareAutomationSave(baseAutomation({ id: 'preassigned' }), undefined, ctx());
    expect(kept.id).toBe('preassigned');
  });

  it('ignores server-owned fields the caller echoes back on input', () => {
    const input = baseAutomation({
      enabled: false,
      revision: 99,
      ownerClientId: 'someone-else',
      createdAt: 1,
      enabledAt: 2,
      nextRunAt: 3,
      consecutiveFailures: 99,
    });

    const saved = prepareAutomationSave(input, undefined, ctx());

    expect(saved.revision).toBe(1);
    expect(saved.ownerClientId).toBe(LOCAL_CLIENT_ID);
    expect(saved.createdAt).toBe(NOW);
    expect(saved.enabledAt).toBeNull();
    expect(saved.nextRunAt).toBeNull();
    expect(saved.consecutiveFailures).toBe(0);
  });

  it('throws the validator’s messages for invalid input, e.g. mode: "manual"', () => {
    const input = baseAutomation({ action: { ...baseAutomation().action, mode: 'manual' } });

    expect(() => prepareAutomationSave(input, undefined, ctx())).toThrow(/Manual permission mode/);
  });
});

describe('prepareAutomationSave — edit', () => {
  it('bumps revision and keeps createdAt', () => {
    const existing = baseAutomation({ revision: 3, createdAt: NOW - 50_000 });
    const input = { ...existing, name: 'Renamed' };

    const saved = prepareAutomationSave(input, existing, ctx());

    expect(saved.revision).toBe(4);
    expect(saved.createdAt).toBe(NOW - 50_000);
    expect(saved.updatedAt).toBe(NOW);
    expect(saved.name).toBe('Renamed');
  });

  it('a schedule shape change clears nextRunAt; a name-only change keeps it', () => {
    const existing = baseAutomation({ nextRunAt: NOW + 10_000 });

    const scheduleChanged = {
      ...existing,
      trigger: {
        kind: 'schedule' as const,
        schedule: { type: 'daily' as const, hour: 5, minute: 0 },
      },
    };
    expect(prepareAutomationSave(scheduleChanged, existing, ctx()).nextRunAt).toBeNull();

    const nameOnly = { ...existing, name: 'Renamed' };
    expect(prepareAutomationSave(nameOnly, existing, ctx()).nextRunAt).toBe(NOW + 10_000);
  });

  it('a time-zone change clears nextRunAt', () => {
    const existing = baseAutomation({ nextRunAt: NOW + 10_000, timeZone: 'UTC' });
    const input = { ...existing, timeZone: 'Europe/Warsaw' };

    expect(prepareAutomationSave(input, existing, ctx()).nextRunAt).toBeNull();
  });

  it('switching to a tracker trigger clears nextRunAt to null', () => {
    const existing = baseAutomation({ nextRunAt: NOW + 10_000 });
    const input: Automation = {
      ...existing,
      trigger: { kind: 'tracker', tracker: { source: 'jira', event: 'appeared' } },
    };

    expect(prepareAutomationSave(input, existing, ctx()).nextRunAt).toBeNull();
  });

  it('a false→true enable sets enabledAt and resets consecutiveFailures', () => {
    const existing = baseAutomation({
      enabled: false,
      enabledAt: null,
      consecutiveFailures: 3,
      nextRunAt: null,
    });
    const input = { ...existing, enabled: true };

    const saved = prepareAutomationSave(input, existing, ctx());

    expect(saved.enabledAt).toBe(NOW);
    expect(saved.consecutiveFailures).toBe(0);
  });

  it('disabling keeps the existing enabledAt', () => {
    const existing = baseAutomation({ enabled: true, enabledAt: NOW - 5000 });
    const input = { ...existing, enabled: false };

    const saved = prepareAutomationSave(input, existing, ctx());

    expect(saved.enabledAt).toBe(NOW - 5000);
  });

  it('staying enabled keeps consecutiveFailures and nextRunAt', () => {
    const existing = baseAutomation({
      enabled: true,
      enabledAt: NOW - 5000,
      consecutiveFailures: 2,
      nextRunAt: NOW + 10_000,
    });
    const input = { ...existing, name: 'Renamed' };

    const saved = prepareAutomationSave(input, existing, ctx());

    expect(saved.consecutiveFailures).toBe(2);
    expect(saved.nextRunAt).toBe(NOW + 10_000);
  });

  it('refuses an edit owned by another desktop', () => {
    const existing = baseAutomation({ name: 'Foreign one', ownerClientId: 'other-client' });
    const input = { ...existing, name: 'Renamed' };

    expect(() => prepareAutomationSave(input, existing, ctx())).toThrow(
      '‹Foreign one› is owned by another desktop — edit it there.',
    );
  });

  it('stamps a null owner with the local client id on save', () => {
    const existing = baseAutomation({ ownerClientId: null });
    const input = { ...existing, name: 'Renamed' };

    const saved = prepareAutomationSave(input, existing, ctx());

    expect(saved.ownerClientId).toBe(LOCAL_CLIENT_ID);
  });

  it('keeps an already-local owner as-is', () => {
    const existing = baseAutomation({ ownerClientId: LOCAL_CLIENT_ID });
    const input = { ...existing, name: 'Renamed' };

    const saved = prepareAutomationSave(input, existing, ctx());

    expect(saved.ownerClientId).toBe(LOCAL_CLIENT_ID);
  });
});

describe('prepareSetEnabled', () => {
  it('is a thin wrapper around prepareAutomationSave', () => {
    const existing = baseAutomation({ enabled: false, enabledAt: null, consecutiveFailures: 1 });

    const saved = prepareSetEnabled(existing, true, ctx());

    expect(saved.enabled).toBe(true);
    expect(saved.enabledAt).toBe(NOW);
    expect(saved.consecutiveFailures).toBe(0);
    expect(saved.revision).toBe(existing.revision + 1);
  });
});

describe('manualFiring', () => {
  it('prefixes the occurrence key with "manual:" and uses the given id', () => {
    const firing = manualFiring(NOW, () => 'uuid-1');

    expect(firing.kind).toBe('manual');
    expect(firing.occurrenceKey).toBe('manual:uuid-1');
    expect(firing.occurrenceAt).toBe(NOW);
    expect(firing.skippedCount).toBe(0);
  });

  it('produces a unique key per call', () => {
    let n = 0;
    const newId = () => `uuid-${++n}`;

    const first = manualFiring(NOW, newId);
    const second = manualFiring(NOW, newId);

    expect(first.occurrenceKey).not.toBe(second.occurrenceKey);
  });
});

describe('assertCanRunNow', () => {
  it('allows a schedule automation owned here', () => {
    expect(() => assertCanRunNow(baseAutomation(), LOCAL_CLIENT_ID)).not.toThrow();
  });

  it('refuses a tracker automation', () => {
    const tracker = baseAutomation({
      name: 'Tracker one',
      trigger: { kind: 'tracker', tracker: { source: 'jira', event: 'appeared' } },
    });

    expect(() => assertCanRunNow(tracker, LOCAL_CLIENT_ID)).toThrow(
      '‹Tracker one› is a tracker automation — it has no manual trigger.',
    );
  });

  it('refuses an automation owned by another desktop', () => {
    const foreign = baseAutomation({ name: 'Foreign one', ownerClientId: 'other-client' });

    expect(() => assertCanRunNow(foreign, LOCAL_CLIENT_ID)).toThrow(
      '‹Foreign one› is owned by another desktop — edit it there.',
    );
  });
});
