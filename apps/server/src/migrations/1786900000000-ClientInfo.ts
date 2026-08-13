import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Gives a desktop Client a name, so the web can say which machine it is driving instead of
 * counting anonymous ids (docs/plan/README.md Phase 26, "Name the desktop clients in the
 * web"). `clients.id` is a UUID a desktop generates for itself on first sync; it identifies
 * a Client perfectly and describes it not at all.
 *
 * Four columns rather than one JSON blob: they are four independent facts, three of them are
 * shown to a human as separate things (name · version · platform) and the fourth is compared
 * numerically against the browser's own `PROTOCOL_VERSION` — a blob would make that
 * comparison a parse, and would hide the whole shape from anyone reading the schema.
 *
 * All nullable and NOT back-filled. There is nothing to back-fill FROM: a row that exists
 * when this runs was written by a build that never sent its hostname, and inventing one
 * would be inventing a fact. Those Clients keep being named by id in the browser, which is
 * what happened before this migration and is not a regression.
 *
 * No index. The four columns are only ever read by primary key — `GET /v1/board` looks up
 * the handful of ids the presence map already says are live — so an index on any of them
 * would be a write cost with no reader.
 */
export class ClientInfo1786900000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "clients" ADD "name" NVARCHAR(128) NULL`);
    await queryRunner.query(`ALTER TABLE "clients" ADD "platform" VARCHAR(32) NULL`);
    await queryRunner.query(`ALTER TABLE "clients" ADD "appVersion" NVARCHAR(64) NULL`);
    await queryRunner.query(`ALTER TABLE "clients" ADD "protocolVersion" INT NULL`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "clients" DROP COLUMN "protocolVersion"`);
    await queryRunner.query(`ALTER TABLE "clients" DROP COLUMN "appVersion"`);
    await queryRunner.query(`ALTER TABLE "clients" DROP COLUMN "platform"`);
    await queryRunner.query(`ALTER TABLE "clients" DROP COLUMN "name"`);
  }
}
