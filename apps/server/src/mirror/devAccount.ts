/**
 * The single tenant every mirror row, Client and Command is scoped to while
 * `CLOUD_DEV_NO_AUTH=1` stands in for real auth (see ../config/devAuthGate.ts).
 * Seeded once by the initial migration. "Guard the cloud API with
 * vipper.iam" replaces every reference to this constant with the
 * authenticated caller's real account id — nothing else about the mirror
 * tables or their queries needs to change.
 */
export const DEV_ACCOUNT_ID = 'dev-account';
