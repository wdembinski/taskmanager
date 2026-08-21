import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * One table: `personal_access_tokens`, what replaces vipper.iam sign-in for the desktop.
 *
 * `tokenHash` is `CHAR(64)` rather than `NVARCHAR`, because a SHA-256 hex digest is ASCII and
 * fixed width — `CHAR` costs half the index bytes `NVARCHAR` would for the same string, and
 * this column is looked up on every guarded request. `expiresAt`/`revokedAt`/`lastUsedAt` are
 * `BIGINT` epoch ms rather than `DATETIME2`, the same call `1787000000000-AttachmentBlobs.ts`
 * made for `lastReadAt`/`expiresAt`: a pure planner (`patService.ts`'s `patUsable`) compares
 * them in plain arithmetic, not through a `Date`.
 *
 * The one thing a future reader will trip over: the FK to `accounts(id)` is not just
 * referential hygiene. It is what lets `IamAuthGuard` skip `ensureAccount` on the PAT path —
 * a row could not exist here unless the account already did, so resolving a PAT never needs
 * to provision one.
 */
export class PersonalAccessTokens1787100000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "personal_access_tokens" (
        "id" NVARCHAR(36) NOT NULL PRIMARY KEY,
        "accountId" NVARCHAR(64) NOT NULL,
        "tokenHash" CHAR(64) NOT NULL,
        "name" NVARCHAR(100) NOT NULL,
        "hint" NVARCHAR(32) NOT NULL,
        "createdAt" DATETIME2 NOT NULL DEFAULT GETUTCDATE(),
        "expiresAt" BIGINT NULL,
        "revokedAt" BIGINT NULL,
        "lastUsedAt" BIGINT NULL,
        CONSTRAINT "FK_personal_access_tokens_accountId" FOREIGN KEY ("accountId") REFERENCES "accounts"("id")
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_pat_tokenHash" ON "personal_access_tokens" ("tokenHash")`,
    );
    // Leading with accountId because the list route's only question is "this account's
    // tokens, newest first".
    await queryRunner.query(
      `CREATE INDEX "IDX_pat_accountId" ON "personal_access_tokens" ("accountId", "createdAt")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "personal_access_tokens"`);
  }
}
