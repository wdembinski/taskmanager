/**
 * This build's own config, read from `import.meta.env` — apps/web's `env.ts`, one app
 * over, and its own header explains why this stays a per-app file rather than moving into
 * `@tm/cloud`: `import.meta.env` is a Vite build-time replacement `@tm/cloud`'s esbuild
 * build cannot emit.
 *
 * The one difference from apps/web's defaults is `iamClientId` — `taskmanager-mobile` is
 * its own registered vipper.iam client id (Decision 4, docs/plan/README.md Phase 27), not
 * apps/web's `taskmanager-web`, so a desktop's redirect-URI allowlist entry for one build
 * can never be replayed against the other.
 */
import type { WebConfig } from '@tm/cloud/config';

export function loadMobileConfig(): WebConfig {
  const env = import.meta.env;
  return {
    cloudApiBase: (env.VITE_CLOUD_API_BASE ?? 'http://localhost:3100').replace(/\/+$/, ''),
    iamIssuer: env.VITE_CLOUD_IAM_ISSUER ?? 'https://auth.vipper.network/oidc',
    iamClientId: env.VITE_CLOUD_IAM_CLIENT_ID ?? 'taskmanager-mobile',
  };
}
