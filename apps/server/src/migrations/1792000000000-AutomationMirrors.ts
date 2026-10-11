import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Two new tables for F1.12: `automation_mirrors` (one row per automation, read whole by
 * `GET /v1/automations` — see `../entities/automationMirror.entity.ts` for why it carries no
 * `rowVersion`) and `automation_run_mirrors` (one row per firing, read newest-first by
 * `GET /v1/automations/:id/runs`).
 *
 * `(accountId, automationId, at)` on the runs table is the index that actually matters:
 * every read is "this automation's runs, newest first," and `applyAutomationDelta`'s
 * retention sweep is the same shape scoped down to one automation.
 */
export class AutomationMirrors1792000000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "automation_mirrors" (
        "id" NVARCHAR(36) NOT NULL PRIMARY KEY,
        "accountId" NVARCHAR(64) NOT NULL,
        "clientId" NVARCHAR(64) NOT NULL,
        "data" NVARCHAR(MAX) NOT NULL,
        "updatedAt" BIGINT NOT NULL,
        CONSTRAINT "FK_automation_mirrors_accountId" FOREIGN KEY ("accountId") REFERENCES "accounts"("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_automation_mirrors_accountId" ON "automation_mirrors" ("accountId")`,
    );

    await queryRunner.query(`
      CREATE TABLE "automation_run_mirrors" (
        "id" NVARCHAR(36) NOT NULL PRIMARY KEY,
        "accountId" NVARCHAR(64) NOT NULL,
        "automationId" NVARCHAR(36) NOT NULL,
        "data" NVARCHAR(MAX) NOT NULL,
        "at" BIGINT NOT NULL,
        CONSTRAINT "FK_automation_run_mirrors_accountId" FOREIGN KEY ("accountId") REFERENCES "accounts"("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_automation_run_mirrors_accountId_automationId_at" ON "automation_run_mirrors" ("accountId", "automationId", "at")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "automation_run_mirrors"`);
    await queryRunner.query(`DROP TABLE "automation_mirrors"`);
  }
}
