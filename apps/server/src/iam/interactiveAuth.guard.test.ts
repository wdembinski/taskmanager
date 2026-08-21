import { ForbiddenException, type ExecutionContext } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { InteractiveAuthGuard } from './interactiveAuth.guard';

function contextFor(authKind: string | undefined): ExecutionContext {
  const request = { authKind };
  return {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

describe('InteractiveAuthGuard', () => {
  const guard = new InteractiveAuthGuard();

  it('forbids a PAT, naming the reason', () => {
    try {
      guard.canActivate(contextFor('pat'));
      expect.unreachable('expected a ForbiddenException');
    } catch (error) {
      expect(error).toBeInstanceOf(ForbiddenException);
      expect((error as ForbiddenException).message).toMatch(/personal access token/i);
    }
  });

  it('passes an interactive vipper.iam sign-in', () => {
    expect(guard.canActivate(contextFor('iam'))).toBe(true);
  });

  it('refuses a missing authKind — fails closed if ever mounted alone', () => {
    expect(() => guard.canActivate(contextFor(undefined))).toThrow(ForbiddenException);
  });
});
