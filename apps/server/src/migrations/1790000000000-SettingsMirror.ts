import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * One table: `settings_mirrors`, the account-scoped global settings blob cloud web reads and
 * writes with no desktop polling — see `settingsMirror.entity.ts` for why it is one row per
 * account rather than many like the task/project mirrors.
 *
 * `accountId` is the primary key AND the FK to `accounts(id)`, the same double duty
 * `1787100000000-PersonalAccessTokens.ts` gives it: a settings row cannot exist for an account
 * that does not, so nothing here has to provision one. `data` is `NVARCHAR(MAX)` for the same
 * reason the mirror `data` columns are — a JSON blob of the whole {@link AppSettings}, whose
 * shape lives in `@tm/shared`, not in a column per field.
 */
export class SettingsMirror1790000000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "settings_mirrors" (
        "accountId" NVARCHAR(64) NOT NULL PRIMARY KEY,
        "data" NVARCHAR(MAX) NOT NULL,
        CONSTRAINT "FK_settings_mirrors_accountId" FOREIGN KEY ("accountId") REFERENCES "accounts"("id")
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "settings_mirrors"`);
  }
}
