/**
 * Standalone TypeORM DataSource for the CLI (migration:run / migration:generate /
 * migration:revert — see package.json). Mirrors the connection config
 * app.module.ts builds for the running app, via the shared
 * {@link buildMssqlConnectionOptions}, so the two never drift.
 *
 * Usage: pnpm --filter @tm/server migration:run
 */
import 'reflect-metadata';
import { join } from 'path';
import * as dotenv from 'dotenv';
import { DataSource } from 'typeorm';
import { Account } from '../entities/account.entity';
import { Client } from '../entities/client.entity';
import { Command } from '../entities/command.entity';
import { ProjectMirror } from '../entities/projectMirror.entity';
import { TaskMirror } from '../entities/taskMirror.entity';
import { buildMssqlConnectionOptions } from './typeormOptions';

dotenv.config({ path: '.env' });
dotenv.config({ path: '.env.example' });

export const AppDataSource = new DataSource({
  ...buildMssqlConnectionOptions(),
  entities: [Account, Client, Command, ProjectMirror, TaskMirror],
  migrations: [join(__dirname, '..', 'migrations', '*.{ts,js}')],
  logging: process.env.NODE_ENV === 'development',
  // Migrations, not synchronize — matches vipper.iam's convention.
  synchronize: false,
});
