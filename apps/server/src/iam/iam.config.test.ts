import { describe, expect, it } from 'vitest';
import { loadIamConfig } from './iam.config';

describe('loadIamConfig', () => {
  it('reads all three vars', () => {
    expect(
      loadIamConfig({
        CLOUD_IAM_API_BASE: 'https://auth.vipper.network/api/v1',
        CLOUD_IAM_CLIENT_ID: 'cid',
        CLOUD_IAM_CLIENT_SECRET: 'csecret',
      }),
    ).toEqual({
      apiBase: 'https://auth.vipper.network/api/v1',
      clientId: 'cid',
      clientSecret: 'csecret',
    });
  });

  it('names every missing var in one error', () => {
    expect(() => loadIamConfig({})).toThrow(
      /CLOUD_IAM_API_BASE, CLOUD_IAM_CLIENT_ID, CLOUD_IAM_CLIENT_SECRET/,
    );
  });

  it('throws when only one var is missing', () => {
    expect(() => loadIamConfig({ CLOUD_IAM_API_BASE: 'x', CLOUD_IAM_CLIENT_ID: 'y' })).toThrow(
      /CLOUD_IAM_CLIENT_SECRET/,
    );
  });
});
