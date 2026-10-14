import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * One table for F7.11: `skill_mirrors`, the account-scoped mirror of library `Skill`s
 * pushed through `PUT/DELETE /v1/skills/:id` and read whole by `GET /v1/skills` — see
 * `../entities/skillMirror.entity.ts` for why the primary key is composite and why the
 * tombstone lives on this row rather than the shared `tombstones` table.
 */
export class SkillMirrors1793000000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "skill_mirrors" (
        "accountId" NVARCHAR(64) NOT NULL,
        "id" NVARCHAR(36) NOT NULL,
        "data" NVARCHAR(MAX),
        "deletedAt" BIGINT,
        "updatedAt" BIGINT NOT NULL,
        CONSTRAINT "PK_skill_mirrors" PRIMARY KEY ("accountId", "id"),
        CONSTRAINT "FK_skill_mirrors_accountId" FOREIGN KEY ("accountId") REFERENCES "accounts"("id")
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "skill_mirrors"`);
  }
}
