import { ForbiddenException, UnauthorizedException, type ExecutionContext } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IamClient } from './iam.client';
import { IamAuthGuard } from './iamAuth.guard';
import { mintPatSecret } from './pat';
import type { PatResolution, PatService } from './patService';

function contextFor(headers: Record<string, string> = {}, method = 'POST') {
  const request: {
    headers: Record<string, string>;
    method: string;
    accountId?: string;
    authKind?: string;
  } = {
    headers,
    method,
  };
  return {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext & { request: typeof request };
}

describe('IamAuthGuard', () => {
  const originalEnv = { ...process.env };
  let iam: { introspectToken: ReturnType<typeof vi.fn>; authorize: ReturnType<typeof vi.fn> };
  let upsert: ReturnType<typeof vi.fn>;
  let pats: { resolve: ReturnType<typeof vi.fn>; touch: ReturnType<typeof vi.fn> };
  let guard: IamAuthGuard;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.CLOUD_DEV_NO_AUTH;
    iam = { introspectToken: vi.fn(), authorize: vi.fn() };
    upsert = vi.fn().mockResolvedValue(undefined);
    const dataSource = { manager: { upsert } };
    pats = {
      resolve: vi.fn().mockResolvedValue({ ok: false, reason: 'unknown' } satisfies PatResolution),
      touch: vi.fn(),
    };
    guard = new IamAuthGuard(
      iam as unknown as IamClient,
      dataSource as never,
      pats as unknown as PatService,
    );
  });

  it('bypasses to DEV_ACCOUNT_ID when CLOUD_DEV_NO_AUTH=1, never touching the IAM client', async () => {
    process.env.CLOUD_DEV_NO_AUTH = '1';
    const ctx = contextFor();

    await expect(guard.canActivate(ctx)).resolves.toBe(true);

    const request = ctx.switchToHttp().getRequest() as { accountId?: string; authKind?: string };
    expect(request.accountId).toBe('dev-account');
    expect(request.authKind).toBe('iam');
    expect(iam.introspectToken).not.toHaveBeenCalled();
  });

  it('rejects a request with no bearer token', async () => {
    const ctx = contextFor();
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects an inactive token', async () => {
    iam.introspectToken.mockResolvedValue({ active: false, subject: null });
    const ctx = contextFor({ authorization: 'Bearer vipr_x' });
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects when IAM denies the authorize check', async () => {
    iam.introspectToken.mockResolvedValue({ active: true, subject: 'account-1' });
    iam.authorize.mockResolvedValue({ allowed: false, scopes: [] });
    const ctx = contextFor({ authorization: 'Bearer vipr_x' });
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('introspects then authorizes, provisions the account, and attaches accountId', async () => {
    iam.introspectToken.mockResolvedValue({ active: true, subject: 'account-1' });
    iam.authorize.mockResolvedValue({ allowed: true, scopes: ['write'] });
    const ctx = contextFor({ authorization: 'Bearer vipr_x' }, 'POST');

    await expect(guard.canActivate(ctx)).resolves.toBe(true);

    expect(iam.introspectToken).toHaveBeenCalledWith('vipr_x');
    expect(iam.authorize).toHaveBeenCalledWith({
      token: 'vipr_x',
      resourceType: 'taskmanager',
      identifier: 'account-1',
      action: 'write',
    });
    expect(upsert).toHaveBeenCalledWith(expect.anything(), { id: 'account-1', name: 'account-1' }, [
      'id',
    ]);
    const request = ctx.switchToHttp().getRequest() as { accountId?: string; authKind?: string };
    expect(request.accountId).toBe('account-1');
    expect(request.authKind).toBe('iam');
  });

  it('authorizes a GET as a read', async () => {
    iam.introspectToken.mockResolvedValue({ active: true, subject: 'account-1' });
    iam.authorize.mockResolvedValue({ allowed: true, scopes: ['read'] });
    const ctx = contextFor({ authorization: 'Bearer vipr_x' }, 'GET');

    await guard.canActivate(ctx);

    expect(iam.authorize).toHaveBeenCalledWith(expect.objectContaining({ action: 'read' }));
  });

  describe('the PAT branch', () => {
    it('resolves a PAT-shaped bearer via PatService, never touching the IAM client', async () => {
      const { token } = mintPatSecret();
      pats.resolve.mockResolvedValue({
        ok: true,
        accountId: 'account-1',
        tokenId: 'pat-1',
      } satisfies PatResolution);
      const ctx = contextFor({ authorization: `Bearer ${token}` });

      await expect(guard.canActivate(ctx)).resolves.toBe(true);

      const request = ctx.switchToHttp().getRequest() as { accountId?: string; authKind?: string };
      expect(request.accountId).toBe('account-1');
      expect(request.authKind).toBe('pat');
      expect(pats.touch).toHaveBeenCalledWith('pat-1');
      expect(iam.introspectToken).not.toHaveBeenCalled();
      expect(upsert).not.toHaveBeenCalled();
    });

    it('401s a PAT-shaped bearer that fails to resolve, and still never calls introspectToken', async () => {
      const { token } = mintPatSecret();
      pats.resolve.mockResolvedValue({ ok: false, reason: 'revoked' } satisfies PatResolution);
      const ctx = contextFor({ authorization: `Bearer ${token}` });

      await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(UnauthorizedException);
      expect(iam.introspectToken).not.toHaveBeenCalled();
      expect(pats.touch).not.toHaveBeenCalled();
    });

    it('a valid PAT wins over CLOUD_DEV_NO_AUTH=1 — the account is the tokens, not dev-account', async () => {
      process.env.CLOUD_DEV_NO_AUTH = '1';
      const { token } = mintPatSecret();
      pats.resolve.mockResolvedValue({
        ok: true,
        accountId: 'account-1',
        tokenId: 'pat-1',
      } satisfies PatResolution);
      const ctx = contextFor({ authorization: `Bearer ${token}` });

      await guard.canActivate(ctx);

      const request = ctx.switchToHttp().getRequest() as { accountId?: string };
      expect(request.accountId).toBe('account-1');
    });

    it('CLOUD_DEV_NO_AUTH=1 with no bearer at all still yields dev-account', async () => {
      process.env.CLOUD_DEV_NO_AUTH = '1';
      const ctx = contextFor();

      await guard.canActivate(ctx);

      const request = ctx.switchToHttp().getRequest() as { accountId?: string };
      expect(request.accountId).toBe('dev-account');
      expect(pats.resolve).not.toHaveBeenCalled();
    });

    it('never calls ensureAccount — the FK already guarantees the row exists', async () => {
      const { token } = mintPatSecret();
      pats.resolve.mockResolvedValue({
        ok: true,
        accountId: 'account-1',
        tokenId: 'pat-1',
      } satisfies PatResolution);
      const ctx = contextFor({ authorization: `Bearer ${token}` });

      await guard.canActivate(ctx);

      expect(upsert).not.toHaveBeenCalled();
    });
  });
});
