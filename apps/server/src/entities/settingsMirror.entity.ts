import { Column, Entity, PrimaryColumn } from 'typeorm';
import type { AppSettings } from '@tm/shared/settings';

/**
 * The server's mirror of one account's GLOBAL settings — the source of truth cloud web reads
 * and writes when no desktop is polling. One row per account (`accountId` is the whole key),
 * unlike `task_mirrors`/`project_mirrors` which hold many rows each: settings are a single
 * blob, not a collection.
 *
 * `data` holds a whole {@link AppSettings} — imported, never redeclared, same reasoning as
 * `TaskMirror.data` — but only its account-scoped keys are ever meaningfully written: every
 * write goes through `@tm/shared`'s `pickGlobalSettings`, so a machine-local field
 * (`fontSizePx`, `defaultExecTarget`, `cloud`, …) in this column is only ever the stock
 * default, never a real desktop's value. Cloud web still receives a complete object to render.
 *
 * No `rowVersion` here, deliberately: settings are not part of the board's rowVersion change
 * stream (`GET /v1/board`) — cloud web reads them on their own route (`GET /v1/settings`), one
 * blob at a time — so there is no cursor for this table to advance.
 */
@Entity('settings_mirrors')
export class SettingsMirror {
  /** The account this settings blob belongs to — the whole primary key. */
  @PrimaryColumn({ type: 'nvarchar', length: 64 })
  accountId!: string;

  @Column({ type: 'simple-json' })
  data!: AppSettings;
}
