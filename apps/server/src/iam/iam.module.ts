import { Module } from '@nestjs/common';
import { devNoAuthEnabled } from '../config/devAuthGate';
import { createIamClient, type IamClient } from './iam.client';
import { loadIamConfig } from './iam.config';
import { IAM_CLIENT } from './iam.tokens';
import { IamAuthGuard } from './iamAuth.guard';

/**
 * Provides {@link IamAuthGuard} to `MirrorModule`/`PresenceModule`. The IAM client is built
 * lazily behind a factory rather than at import time so `loadIamConfig`'s "these env vars are
 * required" check only fires for a deploy that actually needs it — `CLOUD_DEV_NO_AUTH=1` never
 * calls the client at all (see `IamAuthGuard`), so a local checkout without
 * `CLOUD_IAM_CLIENT_ID`/`_SECRET` set still boots.
 */
@Module({
  providers: [
    {
      provide: IAM_CLIENT,
      useFactory: (): IamClient =>
        devNoAuthEnabled() ? unreachableIamClient() : createIamClient(loadIamConfig()),
    },
    IamAuthGuard,
  ],
  // IAM_CLIENT is exported alongside the guard, not just provided: `@UseGuards(IamAuthGuard)`
  // makes Nest instantiate the guard in the *controller's* module context (MirrorModule,
  // PresenceModule), so the token has to be resolvable from there too. Exporting only the
  // guard class compiles and unit-tests fine — the guard's own tests construct it directly —
  // and then fails at boot with "can't resolve dependencies of the IamAuthGuard".
  exports: [IamAuthGuard, IAM_CLIENT],
})
export class IamModule {}

/** Stands in for the real client while `CLOUD_DEV_NO_AUTH=1` — `IamAuthGuard` never calls it. */
function unreachableIamClient(): IamClient {
  const fail = (): never => {
    throw new Error(
      'IAM client called while CLOUD_DEV_NO_AUTH=1 is set — this should be unreachable.',
    );
  };
  return { introspectToken: fail, authorize: fail };
}
