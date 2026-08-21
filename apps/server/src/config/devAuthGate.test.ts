import { describe, expect, it } from 'vitest';
import { assertDevAuthGateSafe, devNoAuthEnabled } from './devAuthGate';

describe('assertDevAuthGateSafe', () => {
  // Two reasons this must never reach production, not one: every route answers as
  // `dev-account` with nothing presented, AND — since PatService.create shipped —
  // `POST /v1/tokens` under the bypass mints a DURABLE personal access token for
  // `dev-account`, not a ten-minute ticket. That credential survives the bypass being
  // turned back off, which is the failure this assertion exists to make impossible.
  it('throws when the dev bypass is set alongside NODE_ENV=production', () => {
    expect(() => assertDevAuthGateSafe({ NODE_ENV: 'production', CLOUD_DEV_NO_AUTH: '1' })).toThrow(
      /CLOUD_DEV_NO_AUTH/,
    );
  });

  it('allows the dev bypass outside production', () => {
    expect(() =>
      assertDevAuthGateSafe({ NODE_ENV: 'development', CLOUD_DEV_NO_AUTH: '1' }),
    ).not.toThrow();
  });

  it('allows production when the dev bypass is not set', () => {
    expect(() => assertDevAuthGateSafe({ NODE_ENV: 'production' })).not.toThrow();
  });

  it('allows an env with neither variable set', () => {
    expect(() => assertDevAuthGateSafe({})).not.toThrow();
  });
});

describe('devNoAuthEnabled', () => {
  it('is true only for the exact string "1"', () => {
    expect(devNoAuthEnabled({ CLOUD_DEV_NO_AUTH: '1' })).toBe(true);
    expect(devNoAuthEnabled({ CLOUD_DEV_NO_AUTH: 'true' })).toBe(false);
    expect(devNoAuthEnabled({})).toBe(false);
  });
});
