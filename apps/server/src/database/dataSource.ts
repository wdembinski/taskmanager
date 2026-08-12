/**
 * Standalone TypeORM DataSource for the CLI (migration:run / migration:generate /
 * migration:revert — see package.json). Mirrors the connection config
 * app.module.ts builds for the running app, via the shared
 * {@link buildMssqlConnectionOptions}, so the two never drift.
 *
 * Usage: pnpm --filter @tm/server migration:run
 *
 * `dotenv` is a RUNTIME dependency, not a dev one, because `migrate.ts` imports this file
 * and runs from the pruned production image — `pnpm deploy --prod` would strip a dev
 * dependency and the migrate job would die on `Cannot find module 'dotenv'`. Neither
 * `.env` nor `.env.example` exists in that image (both are excluded by `.dockerignore`);
 * `dotenv.config` on a missing file is a no-op, and the real environment supplies
 * everything there.
 */
import 'reflect-metadata';
import { join } from 'path';
import * as dotenv from 'dotenv';
import { DataSource } from 'typeorm';
import { Account } from '../entities/account.entity';
import { Client } from '../entities/client.entity';
import { Command } from '../entities/command.entity';
import { CommandResultRow } from '../entities/commandResult.entity';
import { Tombstone } from '../entities/tombstone.entity';
import { ProjectMirror } from '../entities/projectMirror.entity';
import { TaskMirror } from '../entities/taskMirror.entity';
import { buildMssqlConnectionOptions } from './typeormOptions';

dotenv.config({ path: '.env' });
dotenv.config({ path: '.env.example' });

export const AppDataSource = new DataSource({
  ...buildMssqlConnectionOptions(),
  entities: [Account, Client, Command, CommandResultRow, ProjectMirror, TaskMirror, Tombstone],
  migrations: [join(__dirname, '..', 'migrations', '*.{ts,js}')],
  logging: process.env.NODE_ENV === 'development',
  // Migrations, not synchronize — matches vipper.iam's convention.
  synchronize: false,
});
