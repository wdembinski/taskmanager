import { describe, expect, it } from 'vitest';
import type { Task } from './model';
import { TASK_DETAIL_KEYS, TASK_SUMMARY_KEYS, toTaskSummary } from './taskSummary';

const text = (n: number) => 'x'.repeat(n);

/** A board card the way the 5,000-card fixture's rows look: light fields plus ~5 KB of text. */
function heavyTask(): Task {
  return {
    id: 'sc-1',
    projectId: 'personal',
    phase: 'Phase 1',
    title: 'Measure the board',
    status: 'pending',
    sessionId: null,
    order: 1,
    dependsOn: ['Set up the fixture'],
    source: 'ticket',
    isContract: false,
    isScaffold: false,
    ticketKey: 'TM-1',
    labels: ['perf'],
    agentPlan: text(2000),
    description: text(1000),
    externalDescription: text(1500),
    statusNote: text(200),
    plannedFiles: ['packages/shared/src/taskSummary.ts', 'packages/ui/src/taskSummaryStore.ts'],
    skillRefs: ['lib:perf'],
    stepSpec: null,
  };
}

describe('toTaskSummary', () => {
  it('leaves every heavy field out', () => {
    const summary = toTaskSummary(heavyTask());
    for (const key of TASK_DETAIL_KEYS) expect(summary).not.toHaveProperty(key);
  });

  it('shrinks a ~5 KB row to under 1 KB', () => {
    const task = heavyTask();
    expect(JSON.stringify(task).length).toBeGreaterThan(4500);
    expect(JSON.stringify(toTaskSummary(task)).length).toBeLessThan(1024);
  });

  it('omits undefined keys rather than writing them', () => {
    const summary = toTaskSummary(heavyTask());
    expect(Object.keys(summary)).not.toContain('externalKey');
    expect(Object.values(summary)).not.toContain(undefined);
  });

  it('round-trips every summary key', () => {
    const task = heavyTask() as unknown as Record<string, unknown>;
    TASK_SUMMARY_KEYS.forEach((key, i) => {
      if (!(key in task)) task[key] = `value-${i}`;
    });
    const summary = toTaskSummary(task as unknown as Task) as Record<string, unknown>;
    for (const key of TASK_SUMMARY_KEYS) expect(summary[key]).toEqual(task[key]);
    expect(JSON.parse(JSON.stringify(summary))).toEqual(summary);
  });

  it('sorts no key into both lists', () => {
    const detail = new Set<string>(TASK_DETAIL_KEYS);
    expect(TASK_SUMMARY_KEYS.filter((k) => detail.has(k))).toEqual([]);
  });
});
