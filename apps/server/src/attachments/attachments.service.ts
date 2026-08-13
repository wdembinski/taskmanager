import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger, PayloadTooLargeException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, LessThanOrEqual, Not, Repository } from 'typeorm';
import type { BlobStored, UploadTicket } from '@tm/protocol/wire';
import { AttachmentBlob } from '../entities/attachmentBlob.entity';
import { AttachmentUpload } from '../entities/attachmentUpload.entity';
import { BLOB_STORE, type BlobRef, type BlobStore } from './blobStore';
import { blobQuotaBytes, planReclaim, type BlobFootprint } from './quota';

/**
 * The bytes side of an attachment, in both directions: a blob the desktop pushed up so a
 * browser can look at it, and an upload a browser pushed up so the desktop can turn it into a
 * real attachment.
 *
 * It owns the METADATA rows and the account's quota; where the bytes themselves live is
 * `BlobStore`'s business (see `blobStore.ts`). That line is deliberate — it is what lets the
 * default SQL tier be swapped for an Azure container without any of the accounting below
 * changing a line.
 *
 * Nothing here is anybody's only copy, and every decision leans on that. A blob is evicted
 * when the account is over quota; an unclaimed upload is reclaimed when it expires; a row
 * whose bytes have gone missing is deleted rather than repaired. In each case the answer is
 * the same: the file is still on the desktop that attached it, and the fix is one re-push.
 */

/**
 * How long a browser's upload stays claimable.
 *
 * It has to outlive the round trip it is part of — the browser relays an `attachment:*`
 * command, the desktop picks it up on its next sync (seconds at the active tier, up to a
 * minute at the idle one) and fetches the bytes. An hour is generous for that and short
 * enough that a tab which vanished mid-flow is not holding a shared quota tomorrow.
 */
export const UPLOAD_TTL_MS = 60 * 60_000;

@Injectable()
export class AttachmentsService {
  private readonly logger = new Logger(AttachmentsService.name);
  private readonly quota = blobQuotaBytes();

  constructor(
    @InjectRepository(AttachmentBlob) private readonly blobs: Repository<AttachmentBlob>,
    @InjectRepository(AttachmentUpload) private readonly uploads: Repository<AttachmentUpload>,
    @Inject(BLOB_STORE) private readonly store: BlobStore,
  ) {}

  /**
   * `PUT /v1/attachments/:id/blob` — the desktop handing over an attachment's bytes.
   *
   * The row goes in first and the bytes second, which is the order `BlobStore.put` requires
   * (its SQL adapter updates the row it is told already exists). If the bytes fail to land,
   * the row is taken back out: a metadata row with no bytes reads as "stored" to the quota
   * and as a 404 to every reader, which is the one state worth spending a delete to avoid.
   */
  async storeAttachment(
    accountId: string,
    attachmentId: string,
    bytes: Buffer,
    meta: { fileName: string | null; mimeType: string | null },
    now: number = Date.now(),
  ): Promise<BlobStored> {
    await this.reclaim(accountId, bytes.length, attachmentId, now);

    await this.blobs.upsert(
      {
        id: attachmentId,
        accountId,
        fileName: meta.fileName,
        mimeType: meta.mimeType,
        size: bytes.length,
        lastReadAt: String(now),
      },
      ['id'],
    );

    try {
      await this.store.put({ kind: 'attachment', id: attachmentId }, bytes);
    } catch (error) {
      await this.blobs.delete({ id: attachmentId, accountId });
      throw error;
    }

    return { storedAt: now, size: bytes.length };
  }

  /**
   * `GET /v1/attachments/:id?mt=` — the bytes, and what to serve them as.
   *
   * Scoped by `accountId`, which the media token resolved: a token speaks for an account, not
   * for an attachment, so this is where "that blob is not yours" becomes a 404 rather than a
   * picture. Not a 403 — an id nobody may read and an id nobody has are the same answer, and
   * saying which would confirm the id exists.
   *
   * The `lastReadAt` touch is what makes the LRU an LRU: it is the only write on the read
   * path, one `UPDATE` of one `BIGINT` per image served, and without it eviction would be
   * ordering by arrival and throwing away the picture everybody looks at.
   */
  async readAttachment(
    accountId: string,
    attachmentId: string,
    now: number = Date.now(),
  ): Promise<{ bytes: Buffer; mimeType: string | null; fileName: string | null } | null> {
    const row = await this.blobs.findOne({ where: { id: attachmentId, accountId } });
    if (!row) return null;

    const bytes = await this.store.get({ kind: 'attachment', id: attachmentId });
    if (!bytes) {
      // The row outlived its bytes — a failed `put`, or an eviction that got half way. Drop
      // it so the desktop's next look sees "not up there" and pushes again, rather than a
      // permanent 404 the quota is still paying for.
      this.logger.warn(`Attachment blob ${attachmentId} has a row but no bytes; dropping the row.`);
      await this.blobs.delete({ id: attachmentId, accountId });
      return null;
    }

    await this.blobs.update({ id: attachmentId, accountId }, { lastReadAt: String(now) });
    return { bytes, mimeType: row.mimeType, fileName: row.fileName };
  }

  /**
   * `DELETE /v1/attachments/:id/blob` — the attachment is gone (or the human asked for the
   * cloud copy to be), so drop it.
   *
   * Silent about an id it does not have: the desktop deleting an attachment it never pushed
   * is the ordinary case, not an error, and a 404 here would only ever be logged and ignored.
   */
  async removeAttachment(accountId: string, attachmentId: string): Promise<void> {
    const row = await this.blobs.findOne({
      where: { id: attachmentId, accountId },
      select: { id: true },
    });
    if (!row) return;
    await this.store.remove([{ kind: 'attachment', id: attachmentId }]);
    await this.blobs.delete({ id: attachmentId, accountId });
  }

  /**
   * `POST /v1/uploads` — a browser parking a file it wants attached.
   *
   * The id is the server's, not the caller's, unlike a command envelope's: nothing is
   * awaiting this id before the response arrives, and an id a browser could choose would let
   * one tab claim (or overwrite) another's upload.
   */
  async createUpload(
    accountId: string,
    bytes: Buffer,
    meta: { fileName: string; mimeType: string | null },
    now: number = Date.now(),
  ): Promise<UploadTicket> {
    await this.reclaim(accountId, bytes.length, null, now);

    const id = randomUUID();
    const expiresAt = now + UPLOAD_TTL_MS;
    await this.uploads.insert({
      id,
      accountId,
      fileName: meta.fileName,
      mimeType: meta.mimeType,
      size: bytes.length,
      expiresAt: String(expiresAt),
      claimedAt: null,
    });

    try {
      await this.store.put({ kind: 'upload', id }, bytes);
    } catch (error) {
      await this.uploads.delete({ id, accountId });
      throw error;
    }

    return { id, size: bytes.length, expiresAt };
  }

  /**
   * `GET /v1/uploads/:id` — the desktop collecting a browser's file.
   *
   * `claimedAt` is stamped rather than the row deleted, so a desktop whose response was lost
   * can ask again while the ticket lives — the same at-least-once shape the command queue
   * has. The bytes go on the next reclaim pass, which is also what collects a ticket nobody
   * ever came for.
   */
  async readUpload(
    accountId: string,
    uploadId: string,
    now: number = Date.now(),
  ): Promise<{ bytes: Buffer; fileName: string; mimeType: string | null } | null> {
    const row = await this.uploads.findOne({ where: { id: uploadId, accountId } });
    if (!row || Number(row.expiresAt) <= now) return null;

    const bytes = await this.store.get({ kind: 'upload', id: uploadId });
    if (!bytes) return null;

    if (row.claimedAt === null) {
      await this.uploads.update({ id: uploadId, accountId }, { claimedAt: String(now) });
    }
    return { bytes, fileName: row.fileName, mimeType: row.mimeType };
  }

  /**
   * Make room for `incomingBytes` on this account, or refuse.
   *
   * Two passes, because the two kinds of held bytes are reclaimable in different senses:
   *
   * 1. **Dead uploads go first, unconditionally** — expired, or already claimed. They are not
   *    LRU candidates, they are rubbish, and collecting them here rather than on a timer means
   *    the sweep happens exactly when somebody needs the space (and never on an idle account,
   *    which is most accounts most of the time).
   * 2. **Then attachment blobs, coldest first**, only as far as the quota needs — see
   *    `quota.ts`, which is where that arithmetic lives and is tested.
   *
   * Live uploads are counted but never evicted: they are a browser's file mid-flight, and the
   * machine that picked it has moved on. If they alone leave no room, the write is refused —
   * a 413 the caller can retry in a minute, rather than evicting somebody's blobs to make
   * room for something that still would not fit.
   */
  private async reclaim(
    accountId: string,
    incomingBytes: number,
    replacingId: string | null,
    now: number,
  ): Promise<void> {
    await this.collectDeadUploads(accountId, now);

    const live = await this.uploads.find({
      where: { accountId },
      select: { id: true, size: true },
    });
    const pinnedBytes = live.reduce((sum, row) => sum + row.size, 0);

    const held = await this.blobs.find({
      where: replacingId ? { accountId, id: Not(replacingId) } : { accountId },
      select: { id: true, size: true, lastReadAt: true },
    });
    const footprints: BlobFootprint[] = held.map((row) => ({
      id: row.id,
      size: row.size,
      lastReadAt: Number(row.lastReadAt),
    }));

    const plan = planReclaim(footprints, pinnedBytes, incomingBytes, this.quota);
    if (!plan.fits) {
      throw new PayloadTooLargeException(
        'This account has no room in the cloud for that file right now. Uploads in flight are ' +
          'holding the quota; try again in a few minutes.',
      );
    }
    if (plan.evict.length === 0) return;

    this.logger.log(
      `Evicting ${plan.evict.length} cold attachment blob(s) for ${accountId} to fit ${incomingBytes} bytes.`,
    );
    await this.dropBlobs(plan.evict.map((id) => ({ kind: 'attachment' as const, id })));
    await this.blobs.delete(plan.evict);
  }

  /** Expired or already-claimed upload tickets, bytes and rows. */
  private async collectDeadUploads(accountId: string, now: number): Promise<void> {
    const dead = await this.uploads.find({
      where: [
        { accountId, expiresAt: LessThanOrEqual(String(now)) },
        { accountId, claimedAt: Not(IsNull()) },
      ],
      select: { id: true },
    });
    if (dead.length === 0) return;
    await this.dropBlobs(dead.map((row) => ({ kind: 'upload' as const, id: row.id })));
    await this.uploads.delete(dead.map((row) => row.id));
  }

  /**
   * Bytes away first, rows after — and a store that fails does not stop the rows going.
   * Orphaned bytes in a tier that no row names are recoverable (they are addressed by id, and
   * the id is gone); a row whose bytes are gone but which still counts against the quota is
   * not, and would make the account permanently smaller.
   */
  private async dropBlobs(refs: readonly BlobRef[]): Promise<void> {
    try {
      await this.store.remove(refs);
    } catch (error) {
      this.logger.warn(`Blob store failed to drop ${refs.length} blob(s): ${String(error)}`);
    }
  }
}
