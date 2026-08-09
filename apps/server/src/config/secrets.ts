import { DefaultAzureCredential } from '@azure/identity';
import { SecretClient } from '@azure/keyvault-secrets';

/** The minimal Key Vault surface this module needs — narrowed so a test can stub it without a
 * real `SecretClient`. */
export interface SecretReader {
  getSecret(name: string): Promise<{ value?: string }>;
}

/**
 * Every secret this server reads from Key Vault, and the env var each becomes once read. Key
 * Vault secret names can't contain underscores, hence the dashed names on the left.
 */
const SECRET_ENV_MAP: Readonly<Record<string, string>> = {
  'db-password': 'DB_PASSWORD',
  'cloud-iam-client-secret': 'CLOUD_IAM_CLIENT_SECRET',
};

/**
 * Populates `env` from Azure Key Vault, once, at startup — the cost estimate's line item
 * (docs/plan/README.md: "Key Vault | Standard, secrets read at startup") assumes exactly this
 * shape: a handful of reads per cold start, not a read per request. A no-op when
 * `AZURE_KEY_VAULT_URI` is unset, which is the local-dev case — `.env` supplies the same vars
 * directly there.
 *
 * Reads run in parallel and each is independent: a vault with only some of these secrets still
 * populates what it has, so (for example) a deploy using `CLOUD_DEV_NO_AUTH=1` doesn't need a
 * `cloud-iam-client-secret` to exist.
 */
export async function loadSecretsFromKeyVault(
  env: NodeJS.ProcessEnv = process.env,
  buildClient: (vaultUri: string) => SecretReader = (vaultUri) =>
    new SecretClient(vaultUri, new DefaultAzureCredential()),
): Promise<void> {
  const vaultUri = env.AZURE_KEY_VAULT_URI;
  if (!vaultUri) return;

  const client = buildClient(vaultUri);
  await Promise.all(
    Object.entries(SECRET_ENV_MAP).map(async ([secretName, envVar]) => {
      const secret = await client.getSecret(secretName);
      if (secret.value) env[envVar] = secret.value;
    }),
  );
}
