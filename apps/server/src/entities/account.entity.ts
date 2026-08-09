import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';

/**
 * A tenant boundary every mirror row, Client and Command is scoped to.
 *
 * Outside `CLOUD_DEV_NO_AUTH=1` (whose one row is {@link DEV_ACCOUNT_ID} in
 * ../mirror/devAccount.ts, seeded by the initial migration), a row is created lazily by
 * `../iam/ensureAccount.ts` the first time `IamAuthGuard` sees a given IAM subject — there is
 * no separate account-provisioning flow to run first.
 */
@Entity('accounts')
export class Account {
  @PrimaryColumn({ type: 'nvarchar', length: 64 })
  id!: string;

  @Column({ type: 'nvarchar', length: 255 })
  name!: string;

  @CreateDateColumn()
  createdAt!: Date;
}
