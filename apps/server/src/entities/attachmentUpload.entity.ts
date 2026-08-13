import { Column, CreateDateColumn, Entity, Index, PrimaryColumn } from 'typeorm';

/**
 * Bytes on their way IN — a file a browser picked, parked until the desktop can collect it.
 *
 * The other direction from `attachment_blobs`, and it needs its own table because the two
 * are keyed by different things at different times. A blob is keyed by an attachment that
 * already exists; an upload exists precisely BEFORE anything does. A browser has no
 * filesystem to write to and no `attachment:add` it can serve (that channel takes paths, on
 * the machine the desktop runs on), so the only way a file picked in a browser becomes an
 * attachment is: park the bytes here, hand the desktop this row's id over the relay, and let
 * the desktop pull them and do what it does with any other file.
 *
 * **A ticket, not a record.** `expiresAt` is not tidiness — it is what keeps a browser tab
 * that vanished mid-flow from leaving bytes in a shared quota forever. Nothing here is
 * anybody's only copy: the file is still on the machine the human picked it from, and an
 * upload nobody claimed simply has to be picked again.
 *
 * `claimedAt` is a one-shot marker rather than a delete, so a desktop whose HTTP response
 * was lost can fetch the same id again while the ticket lives — the same at-least-once
 * shape `commands.deliveredAt` has, for the same reason. The row (and its bytes) go on the
 * next reclaim pass.
 */
@Entity('attachment_uploads')
export class AttachmentUpload {
  /** Server-assigned. Named by the relayed channel that turns these bytes into an attachment. */
  @PrimaryColumn({ type: 'nvarchar', length: 36 })
  id!: string;

  @Index()
  @Column({ type: 'nvarchar', length: 64 })
  accountId!: string;

  /** The name the file was picked under — what the desktop passes to `attachmentName`. */
  @Column({ type: 'nvarchar', length: 255 })
  fileName!: string;

  @Column({ type: 'nvarchar', length: 128, nullable: true })
  mimeType!: string | null;

  /** Bytes counted off the wire — see `AttachmentBlob.size`. */
  @Column({ type: 'int' })
  size!: number;

  /** The SQL storage tier, same deal as `AttachmentBlob.bytes` — see `blobStore.ts`. */
  @Column({ type: 'varbinary', length: 'MAX', nullable: true, select: false })
  bytes!: Buffer | null;

  /** Epoch ms after which this ticket is unclaimable and its bytes are reclaimed. */
  @Index()
  @Column({ type: 'bigint' })
  expiresAt!: string;

  /** Epoch ms the desktop first fetched it. Null while it is still owed. */
  @Column({ type: 'bigint', nullable: true })
  claimedAt!: string | null;

  @CreateDateColumn()
  createdAt!: Date;
}
