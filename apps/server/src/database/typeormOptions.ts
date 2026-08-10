/**
 * Shared MSSQL connection options, matching vipper.iam's split between the
 * runtime NestJS module (app.module.ts) and the standalone TypeORM CLI data
 * source (dataSource.ts, used by migrations) — one source of truth so the
 * two never drift.
 *
 * Password auth only for v1 (unlike vipper.iam, which also supports
 * passwordless Entra auth for Azure SQL). The password reaches the container
 * from Key Vault (`../config/secrets.ts` maps the `db-password` secret onto
 * `DB_PASSWORD`), so it is never baked into an image or a tfstate — but it is
 * still a password, and moving to Entra managed-identity auth the way
 * `vipper.iam` does remains the better end state. Revisit once this has run in
 * Azure long enough to be worth the change.
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

/** Hosts whose TLS certificate is self-signed by construction — the local dev container. */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', 'host.docker.internal']);

/**
 * Whether to accept a certificate the system's CA store can't verify.
 *
 * This has to be `false` against Azure SQL: trusting any presented certificate defeats
 * TLS entirely, so a connection that thinks it is encrypted can be read by whoever
 * answered. It also has to be `true` against the local `docker-compose.yml` SQL Server,
 * which presents a self-signed certificate and would otherwise refuse to connect at all.
 *
 * Rather than pick one and make the other configuration a footgun, it is DERIVED from the
 * host: local hosts get the trust they need, anything reachable over a network does not.
 * A deployment cannot silently inherit the dev default by forgetting a variable, because
 * the only way to get the insecure setting is to be talking to your own machine.
 * `DB_TRUST_SERVER_CERT` overrides it explicitly for the rare case that needs to say so —
 * a self-signed cert on a private host — and is never needed for either normal path.
 */
export function shouldTrustServerCertificate(env: NodeJS.ProcessEnv = process.env): boolean {
  const explicit = env.DB_TRUST_SERVER_CERT;
  if (explicit !== undefined && explicit !== '') return explicit === 'true' || explicit === '1';
  return LOCAL_HOSTS.has((env.DB_HOST ?? 'localhost').toLowerCase());
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
      trustServerCertificate: shouldTrustServerCertificate(env),
    },
  };
}
