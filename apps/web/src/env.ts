/**
 * This build's own config, read from `import.meta.env` (Vite's build-time replacement of
 * `VITE_`-prefixed vars — see `.env.example`). A browser bundle has nothing to hide, so
 * unlike `apps/server/src/iam/iam.config.ts` there is no secret here and nothing to fail
 * fast on: an unset var falls back to the same default the desktop build's
 * `apps/client/src/main/iamConfig.ts` points at, one client id apart.
 */
export interface WebConfig {
  /** The @tm/server root — no trailing slash. */
  cloudApiBase: string;
  /** The vipper.iam OIDC issuer. */
  iamIssuer: string;
  /** This build's own registered PUBLIC vipper.iam client id (PKCE, no secret). */
  iamClientId: string;
  /**
   * vipper.iam's REST management API — no trailing slash. Separate from `iamIssuer`
   * because that one is an OIDC issuer URL (`/oidc`) and this is `/api/v1`; same host,
   * different path, per `docs/04-how-to/use-personal-access-tokens.md` in the vipper.iam
   * repo. Used for `/me/tokens` — the "Link desktop" pane's PAT create/list/revoke calls.
   */
  iamApiBase: string;
}

export function loadWebConfig(): WebConfig {
  const env = import.meta.env;
  return {
    cloudApiBase: (env.VITE_CLOUD_API_BASE ?? 'http://localhost:3100').replace(/\/+$/, ''),
    iamIssuer: env.VITE_CLOUD_IAM_ISSUER ?? 'https://auth.vipper.network/oidc',
    iamClientId: env.VITE_CLOUD_IAM_CLIENT_ID ?? 'taskmanager-web',
    iamApiBase: (env.VITE_CLOUD_IAM_API_BASE ?? 'https://auth.vipper.network/api/v1').replace(
      /\/+$/,
      '',
    ),
  };
}
