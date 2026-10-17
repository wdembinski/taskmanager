import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * One table for F14.11: `milestone_mirrors`, modelled on `task_mirrors`/`project_mirrors`
 * (`InitialSchema`) — see `../entities/milestoneMirror.entity.ts` for why `projectId` is
 * indexed alongside `accountId` and why `rowVersion` is what makes
 * `GET /v1/board?since=<rowversion>` possible for this table too.
 */
export class MilestoneMirrors1795000000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "milestone_mirrors" (
        "id" NVARCHAR(36) NOT NULL PRIMARY KEY,
        "accountId" NVARCHAR(64) NOT NULL,
        "projectId" NVARCHAR(36) NOT NULL,
        "data" NVARCHAR(MAX) NOT NULL,
        "rowVersion" ROWVERSION NOT NULL,
        CONSTRAINT "FK_milestone_mirrors_accountId" FOREIGN KEY ("accountId") REFERENCES "accounts"("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_milestone_mirrors_accountId" ON "milestone_mirrors" ("accountId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_milestone_mirrors_projectId" ON "milestone_mirrors" ("projectId")`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_milestone_mirrors_rowVersion" ON "milestone_mirrors" ("rowVersion")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "milestone_mirrors"`);
  }
}
