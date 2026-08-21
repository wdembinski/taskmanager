import { Module } from '@nestjs/common';
import { devNoAuthEnabled } from '../config/devAuthGate';
import { createIamClient, type IamClient } from './iam.client';
import { loadIamConfig } from './iam.config';
import { IAM_CLIENT } from './iam.tokens';
import { IamAuthGuard } from './iamAuth.guard';
import { InteractiveAuthGuard } from './interactiveAuth.guard';
import { PatService } from './patService';

/**
 * Provides {@link IamAuthGuard} to `MirrorModule`/`PresenceModule`/`TokensModule`, plus the two
 * things that grew up around it: `PatService`, which the guard now depends on directly, and
 * `InteractiveAuthGuard`, which only `TokensController` uses. The IAM client is built lazily
 * behind a factory rather than at import time so `loadIamConfig`'s "these env vars are
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
    InteractiveAuthGuard,
    PatService,
  ],
  // Every one of these is exported, not just provided: `@UseGuards(IamAuthGuard)` makes Nest
  // instantiate the guard in the *controller's* module context (MirrorModule, PresenceModule,
  // TokensModule), so all three have to be resolvable from there too. Exporting only the guard
  // classes compiles and unit-tests fine — their own tests construct them directly — and then
  // fails at boot with "can't resolve dependencies of the IamAuthGuard".
  exports: [IamAuthGuard, InteractiveAuthGuard, PatService, IAM_CLIENT],
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
