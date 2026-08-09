/**
 * The mirror API (POST /v1/sync, POST /v1/commands, GET /v1/board) ships with no
 * real auth yet — that lands in the "Guard the cloud API with vipper.iam" phase,
 * this ticket's one externally-blocked dependency (it needs a registry
 * configured before `@vipper/iam-connector` can resolve). Until then, the
 * routes work only when `CLOUD_DEV_NO_AUTH=1` is set (see {@link DevNoAuthGuard}
 * in ../mirror/devNoAuth.guard.ts) — an explicit opt-in rather than an
 * implicit "no guard configured yet" gap.
 *
 * That opt-in must never reach a production deploy: this is the one check that
 * keeps it off the critical path (docs/plan/README.md Phase 25's "risks and open
 * assumptions") without also keeping the rest of the phase's work blocked on
 * auth landing first.
 */
export function assertDevAuthGateSafe(env: NodeJS.ProcessEnv): void {
  if (env.NODE_ENV === 'production' && env.CLOUD_DEV_NO_AUTH === '1') {
    throw new Error(
      'CLOUD_DEV_NO_AUTH=1 is set alongside NODE_ENV=production. This dev-only ' +
        'auth bypass must never run in production; unset one of them.',
    );
  }
}

/** Whether the mirror API's dev-only auth bypass is active. See {@link assertDevAuthGateSafe}. */
export function devNoAuthEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CLOUD_DEV_NO_AUTH === '1';
}
