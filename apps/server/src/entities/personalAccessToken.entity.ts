import { Column, CreateDateColumn, Entity, Index, PrimaryColumn } from 'typeorm';

/**
 * A personal access token: what replaces vipper.iam sign-in for the desktop. One account,
 * full read-and-write access to that account's mirror, until it expires or is revoked.
 *
 * Only `tokenHash` ever exists here — the token itself is returned once, by
 * `PatService.create`, and never again. `CHAR(64)` because a SHA-256 hex digest is ASCII and
 * fixed width, half the index bytes an `NVARCHAR` would cost. `expiresAt`/`revokedAt`/
 * `lastUsedAt` are epoch ms rather than `DATETIME2` for the same reason `attachment_
 * blobs.lastReadAt` is: `patService.ts`'s `patUsable` compares them in plain arithmetic, not
 * through a `Date`.
 *
 * The FK to `accounts(id)` is not just referential hygiene — it is what lets `IamAuthGuard`
 * skip `ensureAccount` on the PAT path. A row could not have been inserted here unless the
 * account already existed, so resolving a PAT never needs to provision one.
 */
@Entity('personal_access_tokens')
export class PersonalAccessToken {
  @PrimaryColumn({ type: 'nvarchar', length: 36 })
  id!: string;

  @Index()
  @Column({ type: 'nvarchar', length: 64 })
  accountId!: string;

  @Index({ unique: true })
  @Column({ type: 'char', length: 64 })
  tokenHash!: string;

  @Column({ type: 'nvarchar', length: 100 })
  name!: string;

  /** `PAT_PREFIX` plus the first 6 secret characters — enough to recognise a token in a list. */
  @Column({ type: 'nvarchar', length: 32 })
  hint!: string;

  @CreateDateColumn()
  createdAt!: Date;

  /** Epoch ms. `null` means the token never expires. */
  @Column({ type: 'bigint', nullable: true })
  expiresAt!: string | null;

  /** Epoch ms the token was revoked, or `null` while it is still live. */
  @Column({ type: 'bigint', nullable: true })
  revokedAt!: string | null;

  /** Epoch ms this token last authorized a request, or `null` if it never has. */
  @Column({ type: 'bigint', nullable: true })
  lastUsedAt!: string | null;
}
