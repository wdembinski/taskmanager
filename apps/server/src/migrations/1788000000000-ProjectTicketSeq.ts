import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Gives `project_mirrors` its own ticket-number allocator (`TicketsService`,
 * docs/plan/README.md's "cloud as central control" phase, step 1) — the server's
 * counterpart to the desktop's `projects.ticketSeq` column.
 *
 * A plain `ADD COLUMN ... DEFAULT 0`, so every existing row (every project mirrored
 * before this ran, ticket-kind or not) backfills to zero — "no key issued yet",
 * which is true of all of them: none has ever had a server-authored ticket.
 */
export class ProjectTicketSeq1788000000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "project_mirrors" ADD "ticketSeq" INT NOT NULL DEFAULT 0`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "project_mirrors" DROP COLUMN "ticketSeq"`);
  }
}
