import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `agent_profiles.model` was sized for the 3-alias catalog (`VARCHAR(16)`) that predated
 * the wider model catalog — a pinned version id like `claude-opus-4-8` (17 chars) no
 * longer fits. Widened to `VARCHAR(64)`, matching the cap `isUsableModel` itself enforces
 * (see `agentProfile.entity.ts`), so the column is never the thing that rejects a value
 * the shape check already accepted.
 */
export class WidenAgentProfileModel1791000000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "agent_profiles" ALTER COLUMN "model" VARCHAR(64) NOT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "agent_profiles" ALTER COLUMN "model" VARCHAR(16) NOT NULL`,
    );
  }
}
