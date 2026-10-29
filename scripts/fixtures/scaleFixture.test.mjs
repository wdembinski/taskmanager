/**
 * `scaleFixture.mjs`'s own promises — the ones F29's baseline numbers stand on: the same seed
 * is the same board in any process, `cards` is the row count, and a row weighs what a live one
 * does (≈5.5 KB; see the module doc).
 *
 * Collected by the root `vitest.config.ts` the same way `scripts/next-version.test.mjs` is.
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SCALE_APPROVE_TASK_ID, buildScaleFixture } from './scaleFixture.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const sha = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Hashes the fixture in a fresh `node` process, so a clock read anywhere would show up. */
function hashInChildProcess(opts) {
  const url = pathToFileURL(join(here, 'scaleFixture.mjs')).href;
  const src =
    `const { createHash } = await import('node:crypto');` +
    `const { buildScaleFixture } = await import(${JSON.stringify(url)});` +
    `const f = buildScaleFixture(${JSON.stringify(opts)});` +
    `process.stdout.write(createHash('sha256').update(JSON.stringify(f)).digest('hex'));`;
  const res = spawnSync(process.execPath, ['--input-type=module', '-e', src], {
    encoding: 'utf8',
  });
  if (res.status !== 0) throw new Error(res.stderr);
  return res.stdout;
}

describe('buildScaleFixture', () => {
  const fixture = buildScaleFixture();

  it('gives byte-identical JSON for the same seed, in this process and in a fresh one', () => {
    const opts = { cards: 600, seed: 7 };
    const here1 = sha(buildScaleFixture(opts));
    expect(sha(buildScaleFixture(opts))).toBe(here1);
    expect(hashInChildProcess(opts)).toBe(here1);
  }, 30_000);

  it('gives a different board for a different seed', () => {
    expect(sha(buildScaleFixture({ cards: 200, seed: 1 }))).not.toBe(
      sha(buildScaleFixture({ cards: 200, seed: 2 })),
    );
  });

  it('honours cards: TASKS and board:tasks hold exactly that many rows', () => {
    expect(fixture.TASKS).toHaveLength(5000);
    expect(fixture.BOOT_CHANNELS['board:tasks']).toHaveLength(5000);
    expect(buildScaleFixture({ cards: 137 }).TASKS).toHaveLength(137);
    expect(Object.keys(fixture.TASKS_BY_ID)).toHaveLength(5000);
  });

  it('weighs between 5.0 and 6.0 KB of JSON per card on average', () => {
    const avgKb = Buffer.byteLength(JSON.stringify(fixture.TASKS)) / fixture.TASKS.length / 1024;
    expect(avgKb).toBeGreaterThanOrEqual(5.0);
    expect(avgKb).toBeLessThanOrEqual(6.0);
  });

  it('parks one plan-approval item on an existing card', () => {
    const items = fixture.BOOT_CHANNELS['attention:list'];
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe('plan-approval');
    expect(items[0].taskId).toBe(SCALE_APPROVE_TASK_ID);
    expect(fixture.TASKS_BY_ID[items[0].taskId]).toBeDefined();
  });

  it('spreads cards over every board column, with steps, epics and milestones', () => {
    const top = fixture.TASKS.filter((t) => !t.parentTaskId);
    const statuses = new Set(top.map((t) => t.status));
    for (const s of ['pending', 'in-progress', 'in-review', 'blocked', 'done', 'running']) {
      expect(statuses.has(s)).toBe(true);
    }
    const steps = fixture.TASKS.filter((t) => t.parentTaskId);
    expect(steps.every((s) => fixture.TASKS_BY_ID[s.parentTaskId])).toBe(true);
    const parents = new Set(steps.map((s) => s.parentTaskId));
    expect(parents.size / top.length).toBeGreaterThan(0.2);
    expect(top.some((t) => t.issueType === 'epic')).toBe(true);
    const perMilestone = {};
    for (const t of top) perMilestone[t.milestoneId] = (perMilestone[t.milestoneId] ?? 0) + 1;
    for (const m of fixture.BOOT_CHANNELS['milestone:list']) {
      expect(perMilestone[m.id]).toBeGreaterThan(100);
    }
  });
});
