/**
 * How much of the cloud's bytes one account may hold, and which of them go when it wants
 * more — the arithmetic, with no database and no clock in it, so the rule can be held to its
 * cases rather than inferred from a deploy.
 *
 * **Eviction is not garnish here, it is the design.** The default storage tier is a column in
 * a 2 GB SQL database shared with the mirror (see `sqlBlobStore.ts`), so an unbounded cache
 * is a service outage on a long enough timeline. What makes throwing bytes away legitimate is
 * that none of them are anybody's only copy: an attachment's file lives on the desktop that
 * attached it, and an evicted blob is one re-push away from being previewable again. That is
 * the whole trade — a cold blob costs one round trip the next time somebody looks at it, and
 * costs nothing at all if nobody ever does.
 */

/** One blob as the planner sees it: how big, how cold. */
export interface BlobFootprint {
  id: string;
  size: number;
  /** Epoch ms it was last SERVED — see `AttachmentBlob.lastReadAt` on why last read. */
  lastReadAt: number;
}

export interface ReclaimPlan {
  /** Ids to drop, coldest first. Empty when the incoming blob already fits. */
  evict: string[];
  /**
   * Whether it fits once those are gone. False means the account cannot hold this blob even
   * with every evictable byte reclaimed — the caller refuses the write rather than evicting
   * for nothing, which is the one case where dropping something would be pure loss.
   */
  fits: boolean;
}

/**
 * What to evict so that `incomingBytes` fits under `quota`, given what is already held.
 *
 * Two kinds of held bytes, and the split is the only subtle thing in here:
 *
 * - `evictable` — stored attachment blobs. Every one is re-pushable, so all of them are
 *   candidates, taken **coldest first** by `lastReadAt`. A mockup somebody opens daily
 *   survives a month of pressure; a blob nobody has looked at since it went up is the first
 *   to go, whatever order it arrived in.
 * - `pinnedBytes` — bytes that exist and cannot be reclaimed right now: live upload tickets,
 *   which are a browser's file mid-flight and whose only other copy is on a machine that has
 *   already moved on. They still count against the quota (they occupy the same tier), they
 *   are just never the answer. Their TTL is what bounds them instead.
 *
 * A blob being REPLACED must be left out of `evictable` and out of `pinnedBytes` by the
 * caller — its bytes are about to stop existing, so counting them would make a re-push of the
 * same file evict a neighbour for no reason.
 *
 * Ties on `lastReadAt` fall back to id, so the plan is deterministic: two blobs written in
 * the same millisecond and never read must not evict in an order that depends on what the
 * database felt like returning.
 */
export function planReclaim(
  evictable: readonly BlobFootprint[],
  pinnedBytes: number,
  incomingBytes: number,
  quota: number,
): ReclaimPlan {
  const coldestFirst = [...evictable].sort(
    (a, b) => a.lastReadAt - b.lastReadAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );

  let held = pinnedBytes + coldestFirst.reduce((sum, blob) => sum + blob.size, 0);
  const evict: string[] = [];
  for (const blob of coldestFirst) {
    if (held + incomingBytes <= quota) break;
    evict.push(blob.id);
    held -= blob.size;
  }

  return { evict, fits: held + incomingBytes <= quota };
}

/**
 * The per-account cap, in bytes. `CLOUD_BLOB_QUOTA_BYTES` overrides it.
 *
 * 256 MB is roughly ten of the largest blob this API accepts (`CLOUD_BLOB_MAX_BYTES`), or a
 * few hundred screenshots — comfortably more than a person looks at through a browser in a
 * working week, and small enough that several accounts fit in the SQL tier at once. It is a
 * cache size, not an allowance: nothing is refused because of it until the account cannot fit
 * ONE blob after reclaiming everything, which takes a wall of live upload tickets to reach.
 *
 * Unparseable or absurd values fall back to the default rather than refusing to boot, the
 * same call `config/bodyLimit.ts` makes and for the same reason: a typo in a size must not
 * take the API down.
 */
export const DEFAULT_BLOB_QUOTA_BYTES = 256 * 1024 * 1024;

export function blobQuotaBytes(env: NodeJS.ProcessEnv = process.env): number {
  const configured = Number((env.CLOUD_BLOB_QUOTA_BYTES ?? '').trim());
  if (!Number.isFinite(configured) || configured <= 0) return DEFAULT_BLOB_QUOTA_BYTES;
  return Math.floor(configured);
}
