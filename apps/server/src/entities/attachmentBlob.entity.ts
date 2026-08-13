import { Column, CreateDateColumn, Entity, Index, PrimaryColumn } from 'typeorm';

/**
 * The cloud's copy of one attachment's bytes — the second copy of a file whose first copy
 * is, and stays, on the desktop's disk.
 *
 * **This table is a cache, not a record.** Nothing here is the truth about an attachment:
 * the row that says the file exists is `task_attachments` in the desktop's own SQLite (see
 * `@tm/shared/attachments`), mirrored to a browser over the relay like every other row. What
 * this holds is bytes a browser can look at, and every one of them can be thrown away and
 * asked for again — which is what makes the LRU eviction in `attachments.service.ts` a
 * legitimate design rather than data loss.
 *
 * Keyed by the ATTACHMENT's id, not by an id of its own. There is exactly one blob per
 * attachment, an attachment's bytes never change (re-attaching a file mints a new id — see
 * `attachmentName`'s dedupe), and the id is what a browser already has in the row it
 * rendered. That is also what makes `Cache-Control: immutable` honest on the read route.
 *
 * `bytes` is the DEFAULT storage tier and deliberately nullable — see `blobStore.ts`. With
 * the SQL adapter bound (which is what ships, because it needs no infrastructure that isn't
 * already there) the bytes sit in this column; with an Azure Blob adapter bound they sit in a
 * container and this column stays NULL, while everything else on the row — the quota
 * accounting, the LRU key, the MIME type the read route serves — carries on working
 * unchanged. That split is the reason the metadata is a row at all rather than a blob name.
 */
@Entity('attachment_blobs')
export class AttachmentBlob {
  /** The `TaskAttachment.id` these bytes belong to. */
  @PrimaryColumn({ type: 'nvarchar', length: 36 })
  id!: string;

  @Index()
  @Column({ type: 'nvarchar', length: 64 })
  accountId!: string;

  /** The name the file arrived with — what `Content-Disposition` offers on a download. */
  @Column({ type: 'nvarchar', length: 255, nullable: true })
  fileName!: string | null;

  /** Best-effort content type, or null. Decides inline-vs-download on the read route. */
  @Column({ type: 'nvarchar', length: 128, nullable: true })
  mimeType!: string | null;

  /**
   * How many bytes were actually counted off the wire — the number the per-account quota is
   * summed from, and the one thing that has to stay right whichever storage tier holds them.
   */
  @Column({ type: 'int' })
  size!: number;

  /** The SQL storage tier. Null when another `BlobStore` adapter owns the bytes. */
  @Column({ type: 'varbinary', length: 'MAX', nullable: true, select: false })
  bytes!: Buffer | null;

  /**
   * Epoch ms this blob was last SERVED, and therefore the key eviction sorts on.
   *
   * Last read, not last written: a mockup pushed a month ago and looked at every day is the
   * one worth keeping, and a blob nobody has opened since it went up is the one to drop. Held
   * as an epoch number rather than a `DATETIME2` because it is compared and sorted by the
   * eviction planner in plain arithmetic (`quota.ts`), and a round trip through `Date` on
   * every candidate would buy nothing.
   */
  @Index()
  @Column({ type: 'bigint' })
  lastReadAt!: string;

  @CreateDateColumn()
  createdAt!: Date;
}
