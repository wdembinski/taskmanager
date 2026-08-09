/**
 * Shared MSSQL connection options, matching vipper.iam's split between the
 * runtime NestJS module (app.module.ts) and the standalone TypeORM CLI data
 * source (data-source.ts, used by migrations) — one source of truth so the
 * two never drift.
 *
 * Password auth only for v1 (unlike vipper.iam, which also supports
 * passwordless Entra auth for Azure SQL): this repo doesn't have an Azure SQL
 * deployment yet, and adding that mode now would be speculative. Revisit when
 * the server actually deploys to Azure SQL.
 */
export interface MssqlConnectionOptions {
  type: 'mssql';
  host: string;
  port: number;
  database: string;
  username: string;
  password: string;
  options: {
    encrypt: boolean;
    trustServerCertificate: boolean;
  };
}

/**
 * Build the MSSQL connection options from the environment. Defaults match the
 * root docker-compose.yml SQL Server, so this works out of the box in dev.
 */
export function buildMssqlConnectionOptions(
  env: NodeJS.ProcessEnv = process.env,
): MssqlConnectionOptions {
  return {
    type: 'mssql',
    host: env.DB_HOST ?? 'localhost',
    // Env vars arrive as strings; the mssql driver requires a real number for the port.
    port: parseInt(env.DB_PORT ?? '1433', 10),
    database: env.DB_NAME ?? 'taskmanager',
    username: env.DB_USER ?? 'sa',
    password: env.DB_PASSWORD ?? 'Local_Dev_Password_123!',
    options: {
      encrypt: true,
      // The local Docker SQL Server presents a self-signed certificate; trust it.
      // A real deployment against Azure SQL would need this false — revisit
      // alongside the Entra-auth mode note above when that deployment exists.
      trustServerCertificate: true,
    },
  };
}
