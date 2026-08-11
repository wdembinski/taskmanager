import type { IamSignInConfig } from './iamSignIn';

/**
 * This desktop build's own vipper.iam OAuth client — a PUBLIC (no-secret) client, since PKCE
 * is what secures the exchange, so shipping `clientId` in the built app is fine; there is
 * nothing here for a decompiled binary to steal. Registered in the vipper.iam console the same
 * way `docs/04-how-to/connect-a-resource-server-with-vipper-iam-connector.md`'s Step 6
 * registers the npm registry's web UI: `grants: authorization_code + refresh_token`,
 * `token_endpoint_auth_method: none`.
 *
 * Overridable via env for a self-hosted vipper.iam or a staging tenant; the defaults point at
 * the same instance `apps/server/.env.example`'s `CLOUD_IAM_API_BASE` does.
 */
export function iamSignInConfig(env: NodeJS.ProcessEnv = process.env): IamSignInConfig {
  return {
    issuer: env.CLOUD_IAM_ISSUER ?? 'https://auth.vipper.network/oidc',
    clientId: env.CLOUD_IAM_CLIENT_ID ?? 'taskmanager-desktop',
    scope: 'openid offline_access',
  };
}
