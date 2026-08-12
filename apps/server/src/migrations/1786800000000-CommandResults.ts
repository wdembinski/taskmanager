import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Makes command delivery at-least-once, and gives a relayed command somewhere to put its
 * answer — the two halves of the remote-IPC relay's reliability (docs/plan/README.md
 * Phase 26).
 *
 * `commands.ackedAt` turns `deliveredAt` from a tombstone into a lease: a delivered command
 * is now only retired when the applying Client names its id in `SyncRequest.ackedCommandIds`,
 * so one whose HTTP response was lost is redelivered rather than dropped. Every row that
 * exists when this runs was delivered under the OLD rule, where delivery meant done — so
 * they are back-filled as acked, not left to be redelivered as a wave the moment the new
 * code ships.
 *
 * `command_results` is the return path. Keyed by `commandId` (one result per command),
 * scoped by `issuedBy` (results are per-tab, unlike the account-wide board), and carrying
 * its own ROWVERSION so `GET /v1/results?since=` reads catch-up the same way
 * `GET /v1/board?since=` does.
 */
export class CommandResults1786800000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "commands" ADD "ackedAt" DATETIME2 NULL`);
    // Back-fill: under the old rule, delivered WAS done. Leaving these null would hand the
    // whole historical queue back to every Client on its next sync.
    await queryRunner.query(
      `UPDATE "commands" SET "ackedAt" = "deliveredAt" WHERE "deliveredAt" IS NOT NULL`,
    );
    await queryRunner.query(`CREATE INDEX "IDX_commands_ackedAt" ON "commands" ("ackedAt")`);

    await queryRunner.query(`
      CREATE TABLE "command_results" (
        "commandId" NVARCHAR(36) NOT NULL PRIMARY KEY,
        "accountId" NVARCHAR(64) NOT NULL,
        "issuedBy" NVARCHAR(128) NOT NULL,
        "ok" BIT NOT NULL,
        "value" NVARCHAR(MAX) NULL,
        "error" NVARCHAR(MAX) NULL,
        "rowVersion" ROWVERSION NOT NULL,
        "createdAt" DATETIME2 NOT NULL DEFAULT GETUTCDATE(),
        CONSTRAINT "FK_command_results_accountId" FOREIGN KEY ("accountId") REFERENCES "accounts"("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_command_results_accountId" ON "command_results" ("accountId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_command_results_issuedBy" ON "command_results" ("issuedBy")`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_command_results_rowVersion" ON "command_results" ("rowVersion")`,
    );

    // Tombstones — see ../entities/tombstone.entity.ts. Nothing to back-fill: a deletion
    // that happened before this table existed is one no web tab can be told about now, and
    // inventing rows for every id ever mirrored-then-dropped is not recoverable from the
    // schema anyway.
    await queryRunner.query(`
      CREATE TABLE "tombstones" (
        "id" NVARCHAR(160) NOT NULL PRIMARY KEY,
        "accountId" NVARCHAR(64) NOT NULL,
        "entity" VARCHAR(16) NOT NULL,
        "entityId" NVARCHAR(36) NOT NULL,
        "rowVersion" ROWVERSION NOT NULL,
        "createdAt" DATETIME2 NOT NULL DEFAULT GETUTCDATE(),
        CONSTRAINT "FK_tombstones_accountId" FOREIGN KEY ("accountId") REFERENCES "accounts"("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_tombstones_accountId" ON "tombstones" ("accountId")`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_tombstones_rowVersion" ON "tombstones" ("rowVersion")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "tombstones"`);
    await queryRunner.query(`DROP TABLE "command_results"`);
    await queryRunner.query(`DROP INDEX "IDX_commands_ackedAt" ON "commands"`);
    await queryRunner.query(`ALTER TABLE "commands" DROP COLUMN "ackedAt"`);
  }
}
