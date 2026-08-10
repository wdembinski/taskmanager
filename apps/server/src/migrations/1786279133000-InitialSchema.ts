import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Creates the five tables the mirror API needs: `accounts` (the tenant
 * boundary, one row for now — see ../mirror/devAccount.ts), `clients`
 * (registered desktop/web Clients), `commands` (queued relayed actions), and
 * `task_mirrors`/`project_mirrors` (the actual Task/Project mirror — one JSON
 * `data` column each, per ../entities/taskMirror.entity.ts's docstring, plus
 * a database-maintained `rowVersion` for `GET /v1/board?since=`).
 *
 * Seeds the single dev-mode account row so `CLOUD_DEV_NO_AUTH=1` requests
 * have somewhere to attribute rows to before real accounts exist.
 */
export class InitialSchema1786279133000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "accounts" (
        "id" NVARCHAR(64) NOT NULL PRIMARY KEY,
        "name" NVARCHAR(255) NOT NULL,
        "createdAt" DATETIME2 NOT NULL DEFAULT GETUTCDATE()
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "clients" (
        "id" NVARCHAR(64) NOT NULL PRIMARY KEY,
        "accountId" NVARCHAR(64) NOT NULL,
        "createdAt" DATETIME2 NOT NULL DEFAULT GETUTCDATE(),
        CONSTRAINT "FK_clients_accountId" FOREIGN KEY ("accountId") REFERENCES "accounts"("id")
      )
    `);
    await queryRunner.query(`CREATE INDEX "IDX_clients_accountId" ON "clients" ("accountId")`);

    await queryRunner.query(`
      CREATE TABLE "commands" (
        "id" NVARCHAR(36) NOT NULL PRIMARY KEY,
        "accountId" NVARCHAR(64) NOT NULL,
        "targetClientId" NVARCHAR(64) NOT NULL,
        "issuedAt" BIGINT NOT NULL,
        "issuedBy" NVARCHAR(128) NOT NULL,
        "kind" VARCHAR(32) NOT NULL,
        "payload" NVARCHAR(MAX) NOT NULL,
        "deliveredAt" DATETIME2 NULL,
        "createdAt" DATETIME2 NOT NULL DEFAULT GETUTCDATE(),
        CONSTRAINT "FK_commands_accountId" FOREIGN KEY ("accountId") REFERENCES "accounts"("id")
      )
    `);
    await queryRunner.query(`CREATE INDEX "IDX_commands_accountId" ON "commands" ("accountId")`);
    await queryRunner.query(
      `CREATE INDEX "IDX_commands_targetClientId" ON "commands" ("targetClientId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_commands_deliveredAt" ON "commands" ("deliveredAt")`,
    );

    await queryRunner.query(`
      CREATE TABLE "task_mirrors" (
        "id" NVARCHAR(36) NOT NULL PRIMARY KEY,
        "accountId" NVARCHAR(64) NOT NULL,
        "projectId" NVARCHAR(36) NOT NULL,
        "data" NVARCHAR(MAX) NOT NULL,
        "rowVersion" ROWVERSION NOT NULL,
        CONSTRAINT "FK_task_mirrors_accountId" FOREIGN KEY ("accountId") REFERENCES "accounts"("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_task_mirrors_accountId" ON "task_mirrors" ("accountId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_task_mirrors_projectId" ON "task_mirrors" ("projectId")`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_task_mirrors_rowVersion" ON "task_mirrors" ("rowVersion")`,
    );

    await queryRunner.query(`
      CREATE TABLE "project_mirrors" (
        "id" NVARCHAR(36) NOT NULL PRIMARY KEY,
        "accountId" NVARCHAR(64) NOT NULL,
        "data" NVARCHAR(MAX) NOT NULL,
        "rowVersion" ROWVERSION NOT NULL,
        CONSTRAINT "FK_project_mirrors_accountId" FOREIGN KEY ("accountId") REFERENCES "accounts"("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_project_mirrors_accountId" ON "project_mirrors" ("accountId")`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_project_mirrors_rowVersion" ON "project_mirrors" ("rowVersion")`,
    );

    await queryRunner.query(
      `INSERT INTO "accounts" ("id", "name") VALUES ('dev-account', 'Local dev (CLOUD_DEV_NO_AUTH)')`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "project_mirrors"`);
    await queryRunner.query(`DROP TABLE "task_mirrors"`);
    await queryRunner.query(`DROP TABLE "commands"`);
    await queryRunner.query(`DROP TABLE "clients"`);
    await queryRunner.query(`DROP TABLE "accounts"`);
  }
}
