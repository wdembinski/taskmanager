import { describe, expect, it } from 'vitest';
import type { MergeRequest, PipelineStatus } from '@shared/mergeRequest';
import {
  CI_SETTLE_GRACE_MS,
  needsCiRefresh,
  needsDetailRefresh,
  PIPELINE_IN_FLIGHT,
} from './refreshPolicy';

/** Just enough of a stored row for these forge-neutral predicates to read. */
const prior = (over: Partial<MergeRequest> = {}): MergeRequest =>
  ({
    state: 'opened',
    pipelineStatus: 'success',
    updatedAt: 900,
    ...over,
  }) as MergeRequest;

describe('needsDetailRefresh', () => {
  it('always reads an MR it has never seen', () => {
    expect(needsDetailRefresh(undefined, 900)).toBe(true);
  });

  it('reads one whose updated_at moved', () => {
    expect(needsDetailRefresh(prior({ updatedAt: 900 }), 901)).toBe(true);
  });

  // The bug: neither forge touches the MR when its pipeline finishes, so `updated_at` alone
  // left an MR first seen mid-pipeline reading "running" for good — Sync re-listed it, saw
  // nothing had moved, and kept the stale status.
  it.each(['created', 'pending', 'running'] as const)(
    're-reads an untouched MR whose pipeline is still %s',
    (pipelineStatus) => {
      expect(needsDetailRefresh(prior({ updatedAt: 900, pipelineStatus }), 900)).toBe(true);
    },
  );

  // Bounded on purpose: the re-reading stops the moment the pipeline settles, and `manual`
  // / `unknown` / `none` can sit unchanged forever so they must not keep it going.
  it.each(['success', 'failed', 'canceled', 'skipped', 'manual', 'unknown', 'none'] as const)(
    'leaves an untouched MR alone once its pipeline is %s',
    (pipelineStatus) => {
      expect(needsDetailRefresh(prior({ updatedAt: 900, pipelineStatus }), 900)).toBe(false);
    },
  );
});

describe('PIPELINE_IN_FLIGHT', () => {
  it('holds exactly the statuses a runner still moves on its own', () => {
    expect([...PIPELINE_IN_FLIGHT].sort()).toEqual(['created', 'pending', 'running']);
  });

  it('excludes manual and unknown, which can sit unchanged forever', () => {
    expect(PIPELINE_IN_FLIGHT.has('manual')).toBe(false);
    expect(PIPELINE_IN_FLIGHT.has('unknown')).toBe(false);
    expect(PIPELINE_IN_FLIGHT.has('none')).toBe(false);
  });
});

describe('needsCiRefresh', () => {
  it('never asks about an MR it has never seen', () => {
    expect(needsCiRefresh(undefined, 1_000)).toBe(false);
  });

  // `unknown` never becomes stale by `updated_at` — GitHub does not touch a PR when its
  // checks start — so it is always worth another look, no matter how long it has sat there.
  it('is true for an open PR reading unknown, regardless of age', () => {
    expect(needsCiRefresh(prior({ pipelineStatus: 'unknown', updatedAt: 0 }), 1_000)).toBe(true);
    expect(
      needsCiRefresh(
        prior({ pipelineStatus: 'unknown', updatedAt: 1_000 - CI_SETTLE_GRACE_MS * 10 }),
        1_000,
      ),
    ).toBe(true);
  });

  // The "read back a settled MR" pass in `ipc.ts` already hands a settled row's detail
  // through unconditionally, so this predicate has nothing left to add for one.
  it.each(['merged', 'closed'] as const)('is false for a %s PR reading unknown', (state) => {
    expect(needsCiRefresh(prior({ state, pipelineStatus: 'unknown' }), 1_000)).toBe(false);
  });

  it('is true for a freshly seen none, within the settle grace window', () => {
    const now = 1_000;
    expect(
      needsCiRefresh(
        prior({ pipelineStatus: 'none', updatedAt: now - CI_SETTLE_GRACE_MS + 1 }),
        now,
      ),
    ).toBe(true);
  });

  // A repo with genuinely no CI must stop being asked, or it would be re-read forever.
  it('is false for a none that has sat past the settle grace window', () => {
    const now = 1_000;
    expect(
      needsCiRefresh(prior({ pipelineStatus: 'none', updatedAt: now - CI_SETTLE_GRACE_MS }), now),
    ).toBe(false);
    expect(
      needsCiRefresh(
        prior({ pipelineStatus: 'none', updatedAt: now - CI_SETTLE_GRACE_MS - 1 }),
        now,
      ),
    ).toBe(false);
  });

  it.each([
    'created',
    'pending',
    'running',
    'success',
    'failed',
    'canceled',
    'skipped',
    'manual',
  ] as const)('is false for every other pipeline status (%s)', (pipelineStatus: PipelineStatus) => {
    expect(needsCiRefresh(prior({ pipelineStatus, updatedAt: 0 }), 1_000)).toBe(false);
  });
});
