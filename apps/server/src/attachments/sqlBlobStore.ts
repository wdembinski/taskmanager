import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, In } from 'typeorm';
import { AttachmentBlob } from '../entities/attachmentBlob.entity';
import { AttachmentUpload } from '../entities/attachmentUpload.entity';
import type { BlobRef, BlobStore } from './blobStore';

/**
 * The default {@link BlobStore}: the bytes in a `VARBINARY(MAX)` column beside their own
 * metadata row.
 *
 * Two properties come free from that, and they are the reason this is the tier that ships:
 * a blob and its accounting are written in the same database (so a crash cannot leave bytes
 * that nothing knows the size of), and the whole feature deploys with a migration and no
 * infrastructure change. What is NOT free is space — the SQL tier is small and shared with
 * the mirror — which is exactly what `attachments.service.ts`'s quota and LRU are for.
 *
 * `bytes` is `select: false` on both entities, so every ordinary read (the quota scan, the
 * metadata behind a response) leaves the payload in the database; only `get` below asks for
 * it, and only for the one row being served.
 *
 * The two kinds are branched on by hand rather than resolved through a lookup, because a
 * union of two entity classes is not a thing TypeORM's `update`/`findOne` overloads can be
 * given — and the branch is three lines that typecheck against the real column each time.
 */
@Injectable()
export class SqlBlobStore implements BlobStore {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  /**
   * An `UPDATE`, per the port's contract that the metadata row is written first. A `put` for
   * a ref with no row therefore writes nothing and says so, rather than silently succeeding —
   * bytes the quota has never counted are exactly what this tier cannot afford.
   */
  async put(ref: BlobRef, bytes: Buffer): Promise<void> {
    const manager = this.dataSource.manager;
    const result =
      ref.kind === 'attachment'
        ? await manager.update(AttachmentBlob, ref.id, { bytes })
        : await manager.update(AttachmentUpload, ref.id, { bytes });
    if (!result.affected) {
      throw new Error(`No ${ref.kind} row ${ref.id} to store bytes against.`);
    }
  }

  async get(ref: BlobRef): Promise<Buffer | null> {
    const manager = this.dataSource.manager;
    const row =
      ref.kind === 'attachment'
        ? await manager.findOne(AttachmentBlob, {
            where: { id: ref.id },
            select: { bytes: true },
          })
        : await manager.findOne(AttachmentUpload, {
            where: { id: ref.id },
            select: { bytes: true },
          });
    return row?.bytes ?? null;
  }

  /**
   * Nulls the column rather than deleting the row: the row is the service's to keep or drop
   * (it may be recording an eviction, or cleaning up after a failed `put`), and a store that
   * deleted rows would be deciding that on its behalf.
   */
  async remove(refs: readonly BlobRef[]): Promise<void> {
    const manager = this.dataSource.manager;
    const attachmentIds = refs.filter((r) => r.kind === 'attachment').map((r) => r.id);
    const uploadIds = refs.filter((r) => r.kind === 'upload').map((r) => r.id);
    if (attachmentIds.length > 0) {
      await manager.update(AttachmentBlob, { id: In(attachmentIds) }, { bytes: null });
    }
    if (uploadIds.length > 0) {
      await manager.update(AttachmentUpload, { id: In(uploadIds) }, { bytes: null });
    }
  }
}
