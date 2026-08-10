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
}

export function loadWebConfig(): WebConfig {
  const env = import.meta.env;
  return {
    cloudApiBase: (env.VITE_CLOUD_API_BASE ?? 'http://localhost:3100').replace(/\/+$/, ''),
    iamIssuer: env.VITE_CLOUD_IAM_ISSUER ?? 'https://iam.vipper.network/oidc',
    iamClientId: env.VITE_CLOUD_IAM_CLIENT_ID ?? 'taskmanager-web',
  };
}
