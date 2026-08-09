import { createParamDecorator, type ExecutionContext } from '@nestjs/common';

/**
 * The authenticated caller's account id, as resolved by {@link import('./iamAuth.guard').IamAuthGuard}
 * and attached to the request. Every `/v1/*` route is guarded, so this is always populated by
 * the time a controller method runs — a route that used `@AccountId()` without the guard would
 * be a bug, not a valid "no account" state, hence the throw rather than an `| undefined` type.
 */
export const AccountId = createParamDecorator((_: unknown, ctx: ExecutionContext): string => {
  const request = ctx.switchToHttp().getRequest<{ accountId?: string }>();
  if (!request.accountId) {
    throw new Error('@AccountId() used on a route not behind IamAuthGuard');
  }
  return request.accountId;
});
