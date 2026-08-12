import { Column, CreateDateColumn, Entity, Index, PrimaryColumn } from 'typeorm';

/**
 * "This id is gone" — one row per mirrored entity a Client deleted.
 *
 * The mirror deliberately keeps no history: `applyMirrorDelta` deletes the row and the wire
 * contract calls the mirror "disposable state". That reasoning holds for a desktop Client,
 * which has its own local copy and only ever needs the delta to catch up. It does NOT hold
 * for a browser, whose whole world is `GET /v1/board?since=` — a deleted row is simply
 * ABSENT from every read after it, which is indistinguishable from "unchanged". So a card
 * deleted on the desktop sat on an open web tab until somebody reloaded, and a deleted
 * comment would have sat there permanently.
 *
 * `cloudBoardStore.applyBoardResponse` has always handled `deletedTaskIds` correctly. It
 * just never received any, because `MirrorService.board` hardcoded `[]`. This is where they
 * come from.
 *
 * Keyed by `(accountId, entity, entityId)` rather than by id alone, because an id that was
 * deleted can come back: `task:restore` puts an archived card back with the SAME id, and the
 * upsert that re-mirrors it must not collide with the tombstone that says it is gone. The
 * board read applies deletions and upserts from the same page, so ordering matters —
 * `cloudBoardStore` applies the upserts last, which is what makes a restore win over its own
 * tombstone.
 *
 * Carries a ROWVERSION so it pages and catches up exactly like the mirror tables do.
 */
@Entity('tombstones')
export class Tombstone {
  /** `${accountId}:${entity}:${entityId}` — see the class docstring for why it is composite. */
  @PrimaryColumn({ type: 'nvarchar', length: 160 })
  id!: string;

  @Index()
  @Column({ type: 'nvarchar', length: 64 })
  accountId!: string;

  /** `'task' | 'project'`, stored untyped for the same reason `Command.kind` is. */
  @Column({ type: 'varchar', length: 16 })
  entity!: string;

  @Column({ type: 'nvarchar', length: 36 })
  entityId!: string;

  @Index()
  @Column({ type: 'rowversion', insert: false, update: false })
  rowVersion!: Buffer;

  @CreateDateColumn()
  createdAt!: Date;
}

/** The composite key, in one place so the writer and any future reader agree on its shape. */
export function tombstoneId(accountId: string, entity: string, entityId: string): string {
  return `${accountId}:${entity}:${entityId}`;
}
