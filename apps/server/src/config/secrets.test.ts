import { describe, expect, it, vi } from 'vitest';
import { loadSecretsFromKeyVault, type SecretReader } from './secrets';

describe('loadSecretsFromKeyVault', () => {
  it('does nothing when AZURE_KEY_VAULT_URI is unset', async () => {
    const buildClient = vi.fn();
    const env: NodeJS.ProcessEnv = {};

    await loadSecretsFromKeyVault(env, buildClient);

    expect(buildClient).not.toHaveBeenCalled();
    expect(env).toEqual({});
  });

  it('maps each dashed secret name to its env var', async () => {
    const client: SecretReader = {
      getSecret: vi.fn(async (name: string) => {
        if (name === 'db-password') return { value: 'sekrit-db' };
        if (name === 'cloud-iam-client-secret') return { value: 'sekrit-iam' };
        throw new Error(`unexpected secret: ${name}`);
      }),
    };
    const env: NodeJS.ProcessEnv = { AZURE_KEY_VAULT_URI: 'https://vault.example/' };

    await loadSecretsFromKeyVault(env, () => client);

    expect(env.DB_PASSWORD).toBe('sekrit-db');
    expect(env.CLOUD_IAM_CLIENT_SECRET).toBe('sekrit-iam');
  });

  it('leaves env untouched for a secret with no value', async () => {
    const client: SecretReader = { getSecret: vi.fn(async () => ({ value: undefined })) };
    const env: NodeJS.ProcessEnv = { AZURE_KEY_VAULT_URI: 'https://vault.example/' };

    await loadSecretsFromKeyVault(env, () => client);

    expect(env.DB_PASSWORD).toBeUndefined();
    expect(env.CLOUD_IAM_CLIENT_SECRET).toBeUndefined();
  });
});
