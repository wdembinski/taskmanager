import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * One table for F8.12: `workflow_mirrors`, the account-scoped mirror of `WorkflowDoc`s
 * pushed through `PUT/DELETE /v1/workflows/:id` and read whole by `GET /v1/workflows` —
 * see `../entities/workflowMirror.entity.ts` for why the primary key is composite, why
 * `id` is `nvarchar(64)` rather than `(36)`, and why the tombstone lives on this row
 * rather than the shared `tombstones` table.
 */
export class WorkflowMirrors1794000000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "workflow_mirrors" (
        "accountId" NVARCHAR(64) NOT NULL,
        "id" NVARCHAR(64) NOT NULL,
        "data" NVARCHAR(MAX),
        "deletedAt" BIGINT,
        "updatedAt" BIGINT NOT NULL,
        CONSTRAINT "PK_workflow_mirrors" PRIMARY KEY ("accountId", "id"),
        CONSTRAINT "FK_workflow_mirrors_accountId" FOREIGN KEY ("accountId") REFERENCES "accounts"("id")
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "workflow_mirrors"`);
  }
}
