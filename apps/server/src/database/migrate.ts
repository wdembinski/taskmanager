/**
 * Standalone migration runner — applies every pending TypeORM migration, then exits.
 *
 * WHY this exists alongside the `migration:run` script in package.json: that script is
 * `tsx ./node_modules/typeorm/cli.js … -d src/database/dataSource.ts`, and neither `tsx`
 * nor `src/` survives into the production image — `pnpm deploy --prod` prunes dev
 * dependencies and ships only `dist/`. So the CLI path, which is the right thing at a
 * developer's keyboard, has no way to run in the cloud at all. This runner uses only
 * compiled output and the runtime `typeorm` dependency, so the slim image can run it:
 *
 *     node dist/database/migrate.js
 *
 * which is exactly the `command` the Azure Container Apps migrate job overrides the
 * image's default `CMD` with (see the `taskmanager` module in the infrastructure repo).
 * A job is used rather than a CI step because Azure SQL's firewall admits Azure services,
 * not arbitrary GitHub runner IPs — and rather than the app's own boot, because a replica
 * that migrates on startup races every other replica trying to do the same.
 *
 * It reuses the one {@link AppDataSource}, so the entity and migration set can never drift
 * from what the CLI path applies locally.
 *
 * Exit code is 0 on success — including "nothing to do" — and 1 on any failure, so the
 * deploy stops on a bad migration instead of pointing the app at a schema that never
 * arrived.
 */
import 'reflect-metadata';
import { AppDataSource } from './dataSource';

async function run(): Promise<void> {
  console.log('[migrate] connecting…');
  const dataSource = await AppDataSource.initialize();
  try {
    // `transaction: 'each'` wraps every migration in its own transaction: a failure
    // part-way leaves the ones before it committed and only the failing one rolled back,
    // rather than silently redoing applied work on the next attempt.
    const applied = await dataSource.runMigrations({ transaction: 'each' });
    if (applied.length === 0) {
      console.log('[migrate] schema already up to date — no pending migrations.');
      return;
    }
    console.log(`[migrate] applied ${applied.length} migration(s):`);
    for (const migration of applied) {
      console.log(`  applied ${migration.name}`);
    }
  } finally {
    await dataSource.destroy();
  }
}

run()
  .then(() => {
    console.log('[migrate] done.');
    process.exit(0);
  })
  .catch((error) => {
    console.error('[migrate] FAILED:', error);
    process.exit(1);
  });
