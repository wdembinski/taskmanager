import type { IamClientConfig } from './iam.client';

/**
 * Reads {@link IamClientConfig} from the environment. Only called outside
 * `CLOUD_DEV_NO_AUTH=1` (see `iam.module.ts`), so a local dev checkout never needs these set —
 * but a real deploy fails fast at startup rather than 500ing on the first request. Populated
 * either directly (`.env`) or by `../config/secrets.ts` reading Azure Key Vault first.
 */
export function loadIamConfig(env: NodeJS.ProcessEnv = process.env): IamClientConfig {
  const apiBase = env.CLOUD_IAM_API_BASE;
  const clientId = env.CLOUD_IAM_CLIENT_ID;
  const clientSecret = env.CLOUD_IAM_CLIENT_SECRET;
  const missing = [
    !apiBase && 'CLOUD_IAM_API_BASE',
    !clientId && 'CLOUD_IAM_CLIENT_ID',
    !clientSecret && 'CLOUD_IAM_CLIENT_SECRET',
  ].filter((name): name is string => typeof name === 'string');
  if (missing.length > 0) {
    throw new Error(
      `Missing IAM config: ${missing.join(', ')}. Set them directly or via Azure Key Vault ` +
        '(AZURE_KEY_VAULT_URI) — see .env.example. Not required while CLOUD_DEV_NO_AUTH=1.',
    );
  }
  return { apiBase: apiBase!, clientId: clientId!, clientSecret: clientSecret! };
}
