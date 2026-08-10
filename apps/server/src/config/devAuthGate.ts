/**
 * The mirror API (POST /v1/sync, POST /v1/commands, GET /v1/board, POST /v1/presence) is
 * guarded by `IamAuthGuard` (../iam/iamAuth.guard.ts) — real auth, not a placeholder.
 * `@vipper/iam-connector` itself never resolved (`npm.vipper.network` 401s without a registry
 * token this repo has no way to obtain — see the root `.npmrc`), so the guard talks to IAM
 * over `../iam/iam.client.ts`'s small `fetch`-based fallback instead.
 *
 * `CLOUD_DEV_NO_AUTH=1` still exists as a local-dev convenience — `IamAuthGuard` short-circuits
 * to `DEV_ACCOUNT_ID` when it's set, same as before — but it is no longer a *separate* guard
 * standing in for the whole API; it's one branch inside the real one. This function is what
 * keeps that convenience from ever reaching a production deploy.
 */
export function assertDevAuthGateSafe(env: NodeJS.ProcessEnv): void {
  if (env.NODE_ENV === 'production' && env.CLOUD_DEV_NO_AUTH === '1') {
    throw new Error(
      'CLOUD_DEV_NO_AUTH=1 is set alongside NODE_ENV=production. This dev-only ' +
        'auth bypass must never run in production; unset one of them.',
    );
  }
}

/** Whether the mirror API's dev-only auth bypass is active. See {@link assertDevAuthGateSafe} and IamAuthGuard. */
export function devNoAuthEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CLOUD_DEV_NO_AUTH === '1';
}
