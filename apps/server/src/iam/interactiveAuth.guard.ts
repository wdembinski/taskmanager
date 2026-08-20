import { ForbiddenException, Injectable } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import type { AuthedRequest } from './iamAuth.guard';

/**
 * Refuses anything not resolved by an interactive vipper.iam sign-in — in practice, everything
 * behind `TokensController`. A personal access token may read and write the whole mirror, but
 * it may not mint or revoke MORE personal access tokens: a token that can mint tokens is a
 * permanent foothold that survives revoking the one that leaked.
 *
 * A second guard rather than a flag inside `IamAuthGuard` so the refusal reads as a visible
 * decision on the controller (`@UseGuards(IamAuthGuard, InteractiveAuthGuard)`), not a branch
 * buried in a guard everything else also depends on.
 *
 * Refuses `authKind: 'pat'` AND a missing `authKind` — the latter is what happens if this is
 * ever mounted on a route `IamAuthGuard` did not run in front of, and failing closed there
 * beats trusting a value nobody set.
 */
@Injectable()
export class InteractiveAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<AuthedRequest>();
    if (request.authKind !== 'iam') {
      throw new ForbiddenException(
        'This route requires an interactive vipper.iam sign-in — a personal access token may not manage tokens.',
      );
    }
    return true;
  }
}
