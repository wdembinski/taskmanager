import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Two new tables for "cloud as central control for projects" step 5: `agent_profiles`
 * (a reusable run configuration) and `assignments` (a durable queue of tickets waiting
 * on one). Both are new concepts with no desktop-side row to mirror — see
 * `../entities/agentProfile.entity.ts`/`assignment.entity.ts` for why they get real
 * columns rather than the `data` JSON blob `project_mirrors`/`task_mirrors` use.
 */
export class AgentAssignments1789000000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "agent_profiles" (
        "id" NVARCHAR(36) NOT NULL PRIMARY KEY,
        "accountId" NVARCHAR(64) NOT NULL,
        "name" NVARCHAR(255) NOT NULL,
        "model" VARCHAR(16) NOT NULL,
        "permissionMode" VARCHAR(32) NOT NULL,
        "defaultProjectId" NVARCHAR(36) NULL,
        "createdAt" DATETIME2 NOT NULL DEFAULT GETUTCDATE(),
        "updatedAt" DATETIME2 NOT NULL DEFAULT GETUTCDATE(),
        CONSTRAINT "FK_agent_profiles_accountId" FOREIGN KEY ("accountId") REFERENCES "accounts"("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_agent_profiles_accountId" ON "agent_profiles" ("accountId")`,
    );

    await queryRunner.query(`
      CREATE TABLE "assignments" (
        "id" NVARCHAR(36) NOT NULL PRIMARY KEY,
        "accountId" NVARCHAR(64) NOT NULL,
        "projectId" NVARCHAR(36) NOT NULL,
        "ticketId" NVARCHAR(36) NOT NULL,
        "profileId" NVARCHAR(36) NOT NULL,
        "status" VARCHAR(16) NOT NULL,
        "claimedByClientId" NVARCHAR(64) NULL,
        "claimedAt" DATETIME2 NULL,
        "startedAt" DATETIME2 NULL,
        "completedAt" DATETIME2 NULL,
        "runId" NVARCHAR(64) NULL,
        "createdAt" DATETIME2 NOT NULL DEFAULT GETUTCDATE(),
        "updatedAt" DATETIME2 NOT NULL DEFAULT GETUTCDATE(),
        CONSTRAINT "FK_assignments_accountId" FOREIGN KEY ("accountId") REFERENCES "accounts"("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_assignments_accountId" ON "assignments" ("accountId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_assignments_projectId" ON "assignments" ("projectId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_assignments_ticketId" ON "assignments" ("ticketId")`,
    );
    // The desktop poller's whole query shape: "queued rows for a project I serve" — status
    // first, since every poll filters on it regardless of which project asks.
    await queryRunner.query(
      `CREATE INDEX "IDX_assignments_status" ON "assignments" ("status", "projectId")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "assignments"`);
    await queryRunner.query(`DROP TABLE "agent_profiles"`);
  }
}
