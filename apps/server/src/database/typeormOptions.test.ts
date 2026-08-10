import { describe, expect, it } from 'vitest';
import { buildMssqlConnectionOptions, shouldTrustServerCertificate } from './typeormOptions';

describe('shouldTrustServerCertificate', () => {
  it('trusts the local dev container, which is self-signed by construction', () => {
    expect(shouldTrustServerCertificate({})).toBe(true);
    expect(shouldTrustServerCertificate({ DB_HOST: 'localhost' })).toBe(true);
    expect(shouldTrustServerCertificate({ DB_HOST: '127.0.0.1' })).toBe(true);
    expect(shouldTrustServerCertificate({ DB_HOST: 'host.docker.internal' })).toBe(true);
  });

  it('does NOT trust an arbitrary certificate from Azure SQL', () => {
    // The whole point of the derivation: a deploy cannot inherit the dev setting by
    // forgetting a variable, because the insecure value requires talking to your own machine.
    expect(shouldTrustServerCertificate({ DB_HOST: 'taskmanager-sql.database.windows.net' })).toBe(
      false,
    );
  });

  it('is case-insensitive about the host', () => {
    expect(shouldTrustServerCertificate({ DB_HOST: 'LocalHost' })).toBe(true);
  });

  it('lets an explicit override win either way', () => {
    expect(
      shouldTrustServerCertificate({ DB_HOST: 'sql.internal', DB_TRUST_SERVER_CERT: 'true' }),
    ).toBe(true);
    expect(
      shouldTrustServerCertificate({ DB_HOST: 'sql.internal', DB_TRUST_SERVER_CERT: '1' }),
    ).toBe(true);
    expect(
      shouldTrustServerCertificate({ DB_HOST: 'localhost', DB_TRUST_SERVER_CERT: 'false' }),
    ).toBe(false);
  });

  it('ignores an empty override rather than reading it as false', () => {
    // An unset variable very often arrives as '' through a container platform.
    expect(shouldTrustServerCertificate({ DB_HOST: 'localhost', DB_TRUST_SERVER_CERT: '' })).toBe(
      true,
    );
  });
});

describe('buildMssqlConnectionOptions', () => {
  it('defaults to the docker-compose.yml server, encrypted and trusting', () => {
    expect(buildMssqlConnectionOptions({})).toEqual({
      type: 'mssql',
      host: 'localhost',
      port: 1433,
      database: 'taskmanager',
      username: 'sa',
      password: 'Local_Dev_Password_123!',
      options: { encrypt: true, trustServerCertificate: true },
    });
  });

  it('parses the port as a number — the driver rejects a string', () => {
    expect(buildMssqlConnectionOptions({ DB_PORT: '1444' }).port).toBe(1444);
  });

  it('encrypts without trusting when pointed at Azure SQL', () => {
    const options = buildMssqlConnectionOptions({
      DB_HOST: 'taskmanager-sql.database.windows.net',
      DB_NAME: 'taskmanager',
      DB_USER: 'tmapp',
      DB_PASSWORD: 'from-key-vault',
    });

    expect(options.options).toEqual({ encrypt: true, trustServerCertificate: false });
  });
});
