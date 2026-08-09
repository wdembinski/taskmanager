import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';

/**
 * A tenant boundary every mirror row, Client and Command is scoped to.
 *
 * v1 has exactly one row — {@link DEV_ACCOUNT_ID} in ../mirror/devAccount.ts,
 * seeded by the initial migration — because there is no auth yet to derive a
 * real account from (see ../config/devAuthGate.ts). The table exists now so
 * "Guard the cloud API with vipper.iam" only has to change how accountId is
 * resolved, not add the column to every mirror table after the fact.
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
