import { describe, expect, it } from 'vitest';
import { rowFor } from './createPr';

/** What both forges' creates boil down to — the shape `rowFor` reads from. */
const created = (over: Record<string, unknown> = {}) => ({
  provider: 'github' as const,
  repoId: 42,
  projectPath: 'acme/web',
  number: 7,
  title: 'Add the thing',
  webUrl: 'https://github.com/acme/web/pull/7',
  sourceBranch: 'feat/thing',
  targetBranch: 'main',
  draft: false,
  existed: false,
  updatedAt: 1_700_000_000_000,
  ...over,
});

describe('rowFor', () => {
  // The bug: seeding `updatedAt` from `now` (the app's clock, read after the push and the
  // create both round-tripped) routinely reads later than the forge's own timestamp for the
  // same event, so the row looks already-current on the very next sync and never gets its
  // first real detail read. `updatedAt` has to come from the forge, not from when we happened
  // to look.
  it('stamps updatedAt from the created ref, not from `now`', () => {
    const row = rowFor(created({ updatedAt: 1_700_000_000_000 }), 'task-1', 1_800_000_000_000);
    expect(row.updatedAt).toBe(1_700_000_000_000);
    // `syncedAt` really does mean "when we looked".
    expect(row.syncedAt).toBe(1_800_000_000_000);
  });

  it('falls back to 0 when the forge did not say', () => {
    const row = rowFor(created({ updatedAt: 0 }), 'task-1', 1_800_000_000_000);
    expect(row.updatedAt).toBe(0);
  });

  // Honest empty values: a freshly opened PR has not been read for CI or approvals yet, and
  // must not claim a confident answer it does not have.
  it('seeds pipelineStatus as unknown rather than a guess', () => {
    const row = rowFor(created(), 'task-1', 1_800_000_000_000);
    expect(row.pipelineStatus).toBe('unknown');
    expect(row.approvalsRequired).toBeNull();
    expect(row.pipelineStages).toEqual([]);
  });
});
