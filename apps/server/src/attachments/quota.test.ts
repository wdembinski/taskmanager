import { describe, expect, it } from 'vitest';
import { blobQuotaBytes, DEFAULT_BLOB_QUOTA_BYTES, planReclaim, type BlobFootprint } from './quota';

function blob(id: string, size: number, lastReadAt: number): BlobFootprint {
  return { id, size, lastReadAt };
}

describe('planReclaim', () => {
  it('evicts nothing when the incoming blob already fits', () => {
    const plan = planReclaim([blob('a', 10, 1), blob('b', 10, 2)], 0, 30, 100);
    expect(plan).toEqual({ evict: [], fits: true });
  });

  it('evicts coldest-first, and only as far as it has to', () => {
    const held = [blob('warm', 30, 300), blob('cold', 30, 100), blob('cool', 30, 200)];
    // 90 held + 50 incoming = 140 against a quota of 100. Dropping the coldest gets to 110,
    // which is still over; dropping the next gets to 80. The warmest is never touched.
    expect(planReclaim(held, 0, 50, 100)).toEqual({ evict: ['cold', 'cool'], fits: true });
    // And it stops as soon as it fits: 40 incoming needs only the coldest gone.
    expect(planReclaim(held, 0, 40, 100)).toEqual({ evict: ['cold'], fits: true });
  });

  it('counts pinned bytes against the quota without ever evicting them', () => {
    const plan = planReclaim([blob('a', 20, 1)], 70, 20, 100);
    // 70 pinned + 20 held + 20 incoming = 110. Dropping the only evictable blob gets to 90.
    expect(plan).toEqual({ evict: ['a'], fits: true });
  });

  it('refuses rather than evicting for nothing when even an empty account cannot hold it', () => {
    const plan = planReclaim([blob('a', 20, 1)], 90, 20, 100);
    // Pinned alone leaves 10 bytes of room, so the 20 never fits — but the plan still says
    // what would have to go, and `fits: false` is what stops the caller acting on it.
    expect(planReclaim([], 90, 20, 100).fits).toBe(false);
    expect(plan.fits).toBe(false);
  });

  it('is deterministic when two blobs are equally cold', () => {
    const plan = planReclaim([blob('b', 60, 5), blob('a', 60, 5)], 0, 60, 100);
    expect(plan.evict).toEqual(['a', 'b']);
  });

  it('leaves the caller free to exclude the blob being replaced', () => {
    // A re-push of `a` passes the OTHER blobs as evictable; counting `a`'s own bytes would
    // make replacing a file evict a neighbour that had done nothing wrong.
    const plan = planReclaim([blob('b', 40, 9)], 0, 50, 100);
    expect(plan).toEqual({ evict: [], fits: true });
  });
});

describe('blobQuotaBytes', () => {
  it('defaults when unset', () => {
    expect(blobQuotaBytes({})).toBe(DEFAULT_BLOB_QUOTA_BYTES);
  });

  it('honours a byte count', () => {
    expect(blobQuotaBytes({ CLOUD_BLOB_QUOTA_BYTES: '1048576' })).toBe(1048576);
  });

  it('falls back rather than refusing to boot on nonsense', () => {
    expect(blobQuotaBytes({ CLOUD_BLOB_QUOTA_BYTES: 'plenty' })).toBe(DEFAULT_BLOB_QUOTA_BYTES);
    expect(blobQuotaBytes({ CLOUD_BLOB_QUOTA_BYTES: '0' })).toBe(DEFAULT_BLOB_QUOTA_BYTES);
    expect(blobQuotaBytes({ CLOUD_BLOB_QUOTA_BYTES: '-5' })).toBe(DEFAULT_BLOB_QUOTA_BYTES);
  });
});
