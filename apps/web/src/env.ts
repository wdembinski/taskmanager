/**
 * This build's own config, read from `import.meta.env` (Vite's build-time replacement of
 * `VITE_`-prefixed vars — see `.env.example`). A browser bundle has nothing to hide, so
 * unlike `apps/server/src/iam/iam.config.ts` there is no secret here and nothing to fail
 * fast on: an unset var falls back to the same default the desktop build's
 * `apps/client/src/main/iamConfig.ts` points at, one client id apart.
 *
 * This file stays in apps/web on purpose — it is not part of the `@tm/cloud` extraction.
 * `import.meta.env` is a Vite build-time replacement that esbuild (what `@tm/cloud`'s tsup
 * build runs on) cannot emit in CJS; a shared reader here would build clean and ship a
 * production bundle pointing at the wrong client id. `@tm/cloud` only names the shape
 * (`WebConfig`, from `@tm/cloud/config`) and takes it as a parameter instead.
 */
import type { WebConfig } from '@tm/cloud/config';

export function loadWebConfig(): WebConfig {
  const env = import.meta.env;
  return {
    cloudApiBase: (env.VITE_CLOUD_API_BASE ?? 'http://localhost:3100').replace(/\/+$/, ''),
    iamIssuer: env.VITE_CLOUD_IAM_ISSUER ?? 'https://auth.vipper.network/oidc',
    iamClientId: env.VITE_CLOUD_IAM_CLIENT_ID ?? 'taskmanager-web',
  };
}
