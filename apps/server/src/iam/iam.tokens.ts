/** DI token for the {@link import('./iam.client').IamClient} — split out to avoid a circular
 * import between `iam.module.ts` (provides it) and `iamAuth.guard.ts` (injects it). */
export const IAM_CLIENT = Symbol('IAM_CLIENT');
