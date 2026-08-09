/**
 * The single tenant every mirror row, Client and Command is scoped to while
 * `CLOUD_DEV_NO_AUTH=1` stands in for real auth (see ../config/devAuthGate.ts).
 * Seeded once by the initial migration. `IamAuthGuard` (../iam/iamAuth.guard.ts)
 * is the only place this constant is still read directly — every controller and
 * service now takes the authenticated caller's real account id from `@AccountId()`
 * instead.
 */
export const DEV_ACCOUNT_ID = 'dev-account';
