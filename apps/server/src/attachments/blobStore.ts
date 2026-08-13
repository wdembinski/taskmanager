/**
 * Where an attachment's bytes actually sit — the one thing about this feature that is
 * expected to change, kept behind an interface so that changing it is a provider binding
 * rather than a rewrite.
 *
 * The default adapter is `sqlBlobStore.ts`: a `VARBINARY(MAX)` column beside the metadata
 * row. It ships because it needs **no infrastructure change at all** — no storage account, no
 * container, no second credential to rotate, nothing new that can be misconfigured in a
 * deploy — which is the difference between this step landing and this step waiting on the
 * infrastructure repo. It is not where this ends up: an Azure Blob adapter is the same three
 * methods over a container client, and the account quota, the LRU and both routes carry on
 * working unchanged because none of them knows which tier answered.
 *
 * `attachments.service.ts` owns the metadata rows and the quota; this owns bytes and nothing
 * else. That line is what keeps the SQL tier from being load-bearing: `size`, `mimeType`,
 * `lastReadAt` and the eviction that reads them live on a row either way.
 */

/** Which of the two tables (or, later, which container prefix) a blob belongs to. */
export type BlobKind = 'attachment' | 'upload';

/**
 * A blob's address. Deliberately not a string key: the two kinds live in different tables
 * under the SQL adapter, and flattening them into `"attachment/<id>"` would make every
 * adapter re-parse a string this side had already taken apart.
 */
export interface BlobRef {
  kind: BlobKind;
  id: string;
}

export interface BlobStore {
  /**
   * Write the bytes for a blob whose METADATA ROW ALREADY EXISTS.
   *
   * That order is the contract, and the SQL adapter is why: its `put` is an `UPDATE` against
   * the row `attachments.service.ts` just inserted. An adapter that writes elsewhere may
   * ignore the row entirely, but it must not require the opposite order — a row with no bytes
   * reads as "not stored" and is re-pushed, while bytes with no row are unreachable and
   * unaccounted for by the quota.
   */
  put(ref: BlobRef, bytes: Buffer): Promise<void>;

  /** The bytes, or null when this tier does not have them (evicted, never written, expired). */
  get(ref: BlobRef): Promise<Buffer | null>;

  /**
   * Drop bytes. Idempotent, and never an error for a ref that is already gone — every caller
   * is either reclaiming space or cleaning up after a failure, and both would rather carry on
   * than throw over something that was already true.
   */
  remove(refs: readonly BlobRef[]): Promise<void>;
}

/**
 * The DI token. A string rather than the interface (an interface is erased at runtime and
 * cannot be injected) and a `const` rather than a literal at the injection sites, so swapping
 * the adapter is one `useClass` in `attachments.module.ts`.
 */
export const BLOB_STORE = 'BLOB_STORE';
