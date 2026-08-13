import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Somewhere for an attachment's bytes to live in the cloud (docs/plan/README.md Phase 26,
 * "Store attachment bytes in the cloud"). Two NEW tables, so nothing to migrate and nothing
 * to back-fill: every attachment that exists when this runs has its bytes on a desktop's
 * disk, which is where they were always going to be read from anyway, and the copy up here
 * is made on demand.
 *
 * `VARBINARY(MAX)` is the DEFAULT tier, not the only one — see `../attachments/blobStore.ts`.
 * It ships because it needs no infrastructure that isn't already provisioned: no storage
 * account, no container, no second set of credentials, no new failure mode in the deploy. An
 * Azure Blob adapter is one provider binding away, and the columns simply stay NULL when it
 * is bound, which is why the bytes are a column on a metadata row rather than the row itself.
 *
 * That tier is also why the eviction in `../attachments/attachments.service.ts` is not
 * optional garnish. The SQL database is 2 GB total and holds the mirror as well; a cache that
 * only ever grows would eventually take the whole service down over files nobody has looked
 * at in months. An evicted blob costs one re-push, and the desktop still has the file.
 *
 * `lastReadAt`/`expiresAt` are BIGINT epoch ms rather than DATETIME2, matching `commands.
 * issuedAt`: they are compared and sorted by a pure planner (`quota.ts`) in plain arithmetic,
 * and both are indexed because both are the column their table is swept by.
 */
export class AttachmentBlobs1787000000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "attachment_blobs" (
        "id" NVARCHAR(36) NOT NULL PRIMARY KEY,
        "accountId" NVARCHAR(64) NOT NULL,
        "fileName" NVARCHAR(255) NULL,
        "mimeType" NVARCHAR(128) NULL,
        "size" INT NOT NULL,
        "bytes" VARBINARY(MAX) NULL,
        "lastReadAt" BIGINT NOT NULL,
        "createdAt" DATETIME2 NOT NULL DEFAULT GETUTCDATE(),
        CONSTRAINT "FK_attachment_blobs_accountId" FOREIGN KEY ("accountId") REFERENCES "accounts"("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_attachment_blobs_accountId" ON "attachment_blobs" ("accountId")`,
    );
    // The LRU sort. Leading with `accountId` because every read of it is per account — the
    // quota is per account, so "this account's coldest blobs" is the only question asked.
    await queryRunner.query(
      `CREATE INDEX "IDX_attachment_blobs_lastReadAt" ON "attachment_blobs" ("accountId", "lastReadAt")`,
    );

    await queryRunner.query(`
      CREATE TABLE "attachment_uploads" (
        "id" NVARCHAR(36) NOT NULL PRIMARY KEY,
        "accountId" NVARCHAR(64) NOT NULL,
        "fileName" NVARCHAR(255) NOT NULL,
        "mimeType" NVARCHAR(128) NULL,
        "size" INT NOT NULL,
        "bytes" VARBINARY(MAX) NULL,
        "expiresAt" BIGINT NOT NULL,
        "claimedAt" BIGINT NULL,
        "createdAt" DATETIME2 NOT NULL DEFAULT GETUTCDATE(),
        CONSTRAINT "FK_attachment_uploads_accountId" FOREIGN KEY ("accountId") REFERENCES "accounts"("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_attachment_uploads_accountId" ON "attachment_uploads" ("accountId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_attachment_uploads_expiresAt" ON "attachment_uploads" ("expiresAt")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "attachment_uploads"`);
    await queryRunner.query(`DROP TABLE "attachment_blobs"`);
  }
}
