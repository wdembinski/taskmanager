/**
 * Unit tests for `AutomationClock` — every dependency is a fake, per the module's own
 * `AutomationClockDeps` contract, so these never touch a real Store, Scheduler or
 * `powerMonitor`. Fake timers throughout, in the style of `syncPoller.test.ts`.
 */
import { describe, expect, it, vi } from 'vitest';
import { AutomationClock, type AutomationClockDeps } from './automationClock';
import type { AutomationFiring } from './automationRunner';
import type { Automation, AutomationRun } from '@shared/automation';

const DAY_MS = 24 * 60 * 60_000;
const HOUR_MS = 60 * 60_000;
// Jan 1 2026, 04:00 UTC — a round number, and UTC sidesteps DST entirely.
const DAY0_4AM = Date.UTC(2026, 0, 1, 4, 0, 0);

function baseAutomation(overrides: Partial<Automation> = {}): Automation {
  return {
    id: 'auto-1',
    revision: 1,
    name: 'Nightly triage',
    enabled: true,
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
    enabledAt: DAY0_4AM - 1000,
    nextRunAt: null,
    consecutiveFailures: 0,
    createdAt: DAY0_4AM - 100_000,
    updatedAt: DAY0_4AM - 100_000,
    ...overrides,
  };
}

/**
 * An in-memory `getAutomations`/`saveAutomation`/`reserveAutomationRun` triple, the same
 * shared-mutable-record trick `automationRunner.test.ts`'s `createDeps` uses, plus a `fire`
 * spy standing in for `AutomationRunner.fire`.
 */
function createDeps(automations: Automation[], overrides: Partial<AutomationClockDeps> = {}) {
  let items = automations;
  const reservedRuns: AutomationRun[] = [];

  const store = {
    getAutomations: vi.fn(() => items),
    saveAutomation: vi.fn((a: Automation) => {
      items = items.map((x) => (x.id === a.id ? a : x));
    }),
    reserveAutomationRun: vi.fn((run: AutomationRun) => {
      reservedRuns.push(run);
      return true;
    }),
  };

  const fire = vi.fn(
    (_automation: Automation, _firing: AutomationFiring) =>
      ({ status: 'started' }) as AutomationRun,
  );

  let resumeCb: (() => void) | undefined;
  const unsubscribeResume = vi.fn();
  const onResume = vi.fn((cb: () => void) => {
    resumeCb = cb;
    return unsubscribeResume;
  });

  const deps: AutomationClockDeps = {
    store,
    fire,
    isOwnedHere: () => true,
    onResume,
    ...overrides,
  };

  return {
    deps,
    store,
    fire,
    reservedRuns,
    unsubscribeResume,
    triggerResume: () => resumeCb?.(),
    getAutomation: (id: string) => items.find((a) => a.id === id),
  };
}

describe('AutomationClock — arming', () => {
  it('arms to the earliest nextRunAt, firing nothing early and the earliest on time', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(DAY0_4AM);
      const now = Date.now();
      const far = baseAutomation({ id: 'far', nextRunAt: now + 5000 });
      const near = baseAutomation({ id: 'near', nextRunAt: now + 2000 });
      const { deps, fire } = createDeps([far, near]);
      const clock = new AutomationClock(deps);

      clock.start();
      expect(fire).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1999);
      expect(fire).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expect(fire).toHaveBeenCalledTimes(1);
      const [firedAutomation, firing] = fire.mock.calls[0];
      expect((firedAutomation as Automation).id).toBe('near');
      expect((firing as AutomationFiring).kind).toBe('scheduled');

      clock.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('never waits more than 60s even for a nextRunAt 10 days out', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(DAY0_4AM);
      const now = Date.now();
      const farOut = baseAutomation({ nextRunAt: now + 10 * DAY_MS });
      const { deps, store } = createDeps([farOut]);
      const clock = new AutomationClock(deps);

      clock.start();
      expect(store.getAutomations).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(59_999);
      expect(store.getAutomations).toHaveBeenCalledTimes(1);

      // If the clock had armed to the full 10 days, nothing would happen here.
      await vi.advanceTimersByTimeAsync(1);
      expect(store.getAutomations).toHaveBeenCalledTimes(2);

      clock.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('AutomationClock — boot catch-up', () => {
  it('a daily asleep just over 2 days produces one catch-up with skippedCount 2', () => {
    vi.useFakeTimers();
    try {
      // Due at day 0, 04:00. Woken at day 2, 14:00 — 10h after day 2's own occurrence,
      // so the missed set is {day0, day1, day2} and the one that fires is day2's (the
      // latest), leaving the other two as skippedCount 2. Lateness (now - day2 04:00) is
      // 10h: past the 10 min grace, inside the 24h catch-up window.
      const due = DAY0_4AM;
      const now = due + 2 * DAY_MS + 10 * HOUR_MS;
      vi.setSystemTime(now);

      const automation = baseAutomation({ nextRunAt: due });
      const { deps, fire, store } = createDeps([automation]);
      const clock = new AutomationClock(deps);

      clock.start();

      expect(fire).toHaveBeenCalledTimes(1);
      const [, firing] = fire.mock.calls[0];
      expect((firing as AutomationFiring).kind).toBe('catch-up');
      expect((firing as AutomationFiring).skippedCount).toBe(2);

      const saved = store.saveAutomation.mock.calls.at(-1)?.[0] as Automation;
      expect(saved.nextRunAt).not.toBeNull();
      expect(saved.nextRunAt as number).toBeGreaterThan(now);

      clock.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('an hours schedule 30h late writes a skipped receipt and never calls fire', () => {
    vi.useFakeTimers();
    try {
      const due = DAY0_4AM;
      const now = due + 30 * HOUR_MS;
      vi.setSystemTime(now);

      const automation = baseAutomation({
        trigger: { kind: 'schedule', schedule: { type: 'hours', every: 6 } },
        nextRunAt: due,
      });
      const { deps, fire, reservedRuns, store } = createDeps([automation]);
      const clock = new AutomationClock(deps);

      clock.start();

      expect(fire).not.toHaveBeenCalled();
      expect(reservedRuns).toHaveLength(1);
      expect(reservedRuns[0].status).toBe('skipped');
      expect(reservedRuns[0].skippedCount).toBeGreaterThan(0);

      const saved = store.saveAutomation.mock.calls.at(-1)?.[0] as Automation;
      expect(saved.nextRunAt as number).toBeGreaterThan(now);

      clock.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('saves the re-armed nextRunAt before firing, so a throwing fire cannot burst-fire it again', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(DAY0_4AM);
      const now = Date.now();
      const automation = baseAutomation({ nextRunAt: now - 1000 });
      const { deps, fire, store } = createDeps([automation]);
      fire.mockImplementation(() => {
        throw new Error('boom');
      });
      const clock = new AutomationClock(deps);

      clock.start();
      expect(fire).toHaveBeenCalledTimes(1);
      const firstNextRunAt = (store.saveAutomation.mock.calls.at(-1)?.[0] as Automation).nextRunAt;
      expect(firstNextRunAt).toBeGreaterThan(now);

      // A second evaluate() (the re-armed timer, a resume, …) must not re-decide the same
      // occurrence: nextRunAt was already moved past `now` before `fire` ever threw.
      clock.evaluate();
      expect(fire).toHaveBeenCalledTimes(1);

      clock.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('AutomationClock — editing re-arms', () => {
  it('a changed automation with nextRunAt: null gets a fresh nextRunAt and moves the timer', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(DAY0_4AM);
      const now = Date.now();
      const automation = baseAutomation({ nextRunAt: now + 5000 });
      const { deps, store } = createDeps([automation]);
      const clock = new AutomationClock(deps);

      clock.start();
      expect(store.saveAutomation).not.toHaveBeenCalled();

      // Simulate the save handler (a later task) clearing nextRunAt on a schedule edit.
      store.saveAutomation({ ...automation, nextRunAt: null, updatedAt: now });
      clock.evaluate();

      const saved = store.saveAutomation.mock.calls.at(-1)?.[0] as Automation;
      expect(saved.nextRunAt).not.toBeNull();
      expect(saved.nextRunAt as number).toBeGreaterThan(now);

      clock.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('AutomationClock — what evaluate() ignores', () => {
  it('a disabled, a tracker-kind, and another desktop’s automation are all ignored', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(DAY0_4AM);
      const now = Date.now();
      const disabled = baseAutomation({ id: 'disabled', enabled: false, nextRunAt: now - 1000 });
      const tracker = baseAutomation({
        id: 'tracker',
        trigger: { kind: 'tracker', tracker: { source: 'jira', event: 'appeared' } },
      });
      const otherDesktop = baseAutomation({ id: 'other', nextRunAt: now - 1000 });
      const { deps, fire, store } = createDeps([disabled, tracker, otherDesktop], {
        isOwnedHere: (a) => a.id !== 'other',
      });
      const clock = new AutomationClock(deps);

      clock.start();

      expect(fire).not.toHaveBeenCalled();
      expect(store.saveAutomation).not.toHaveBeenCalled();

      clock.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('AutomationClock — resume', () => {
  it('a resume callback triggers evaluate()', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(DAY0_4AM);
      const now = Date.now();
      const automation = baseAutomation({ nextRunAt: now + 10 * DAY_MS });
      const { deps, store, triggerResume } = createDeps([automation]);
      const clock = new AutomationClock(deps);

      clock.start();
      expect(store.getAutomations).toHaveBeenCalledTimes(1);

      triggerResume();
      expect(store.getAutomations).toHaveBeenCalledTimes(2);

      clock.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('AutomationClock — dispose', () => {
  it('clears the timer, unsubscribes resume, and nothing fires afterwards', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(DAY0_4AM);
      const now = Date.now();
      const automation = baseAutomation({ nextRunAt: now + 2000 });
      const { deps, fire, unsubscribeResume, triggerResume } = createDeps([automation]);
      const clock = new AutomationClock(deps);

      clock.start();
      expect(vi.getTimerCount()).toBeGreaterThan(0);

      clock.dispose();
      expect(vi.getTimerCount()).toBe(0);
      expect(unsubscribeResume).toHaveBeenCalledTimes(1);

      // A straggling resume event after dispose must do nothing.
      triggerResume();
      // And time passing — including past the due occurrence — must not fire either.
      vi.advanceTimersByTime(10_000);
      expect(fire).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('AutomationClock — isolation between automations', () => {
  it('one automation with an invalid time zone does not stop another from firing', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(DAY0_4AM);
      const now = Date.now();
      const broken = baseAutomation({
        id: 'broken',
        timeZone: 'Not/AZone',
        nextRunAt: null,
      });
      const ok = baseAutomation({ id: 'ok', nextRunAt: now - 1000 });
      const { deps, fire } = createDeps([broken, ok]);
      const clock = new AutomationClock(deps);

      expect(() => clock.start()).not.toThrow();

      expect(fire).toHaveBeenCalledTimes(1);
      expect((fire.mock.calls[0][0] as Automation).id).toBe('ok');

      clock.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});
