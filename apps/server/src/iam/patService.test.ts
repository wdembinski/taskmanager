import { ConflictException, NotFoundException } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import { describe, expect, it, vi } from 'vitest';
import { hashPat, mintPatSecret } from './pat';
import {
  PAT_CACHE_TTL_MS,
  PAT_LAST_USED_FLUSH_MS,
  PAT_MAX_ACTIVE_TOKENS,
  PatService,
} from './patService';

const NOW = 1_700_000_000_000;

interface FakeRow {
  id: string;
  accountId: string;
  tokenHash: string;
  expiresAt: string | null;
  revokedAt: string | null;
}

function fakeDataSource(overrides: Partial<Record<string, ReturnType<typeof vi.fn>>> = {}) {
  const repo = {
    findOne: vi.fn().mockResolvedValue(null),
    update: vi.fn().mockResolvedValue(undefined),
    save: vi.fn().mockImplementation(async (row: unknown) => row),
    count: vi.fn().mockResolvedValue(0),
    find: vi.fn().mockResolvedValue([]),
    delete: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
  const dataSource = { getRepository: () => repo } as unknown as DataSource;
  return { dataSource, repo };
}

describe('PatService.resolve', () => {
  it('resolves a valid PAT to its account, and a second call inside the TTL makes no second findOne', async () => {
    const { token, hash } = mintPatSecret();
    const row: FakeRow = {
      id: 'pat-1',
      accountId: 'account-1',
      tokenHash: hash,
      expiresAt: null,
      revokedAt: null,
    };
    const { dataSource, repo } = fakeDataSource({ findOne: vi.fn().mockResolvedValue(row) });
    const service = new PatService(dataSource);

    expect(await service.resolve(token, NOW)).toEqual({
      ok: true,
      accountId: 'account-1',
      tokenId: 'pat-1',
    });
    expect(repo.findOne).toHaveBeenCalledTimes(1);

    expect(await service.resolve(token, NOW + PAT_CACHE_TTL_MS - 1)).toEqual({
      ok: true,
      accountId: 'account-1',
      tokenId: 'pat-1',
    });
    expect(repo.findOne).toHaveBeenCalledTimes(1);
  });

  it('refuses a revoked row, and the refusal is never cached', async () => {
    const { token, hash } = mintPatSecret();
    const row: FakeRow = {
      id: 'pat-1',
      accountId: 'account-1',
      tokenHash: hash,
      expiresAt: null,
      revokedAt: String(NOW - 1),
    };
    const { dataSource, repo } = fakeDataSource({ findOne: vi.fn().mockResolvedValue(row) });
    const service = new PatService(dataSource);

    expect(await service.resolve(token, NOW)).toEqual({ ok: false, reason: 'revoked' });
    expect(await service.resolve(token, NOW)).toEqual({ ok: false, reason: 'revoked' });
    expect(repo.findOne).toHaveBeenCalledTimes(2);
  });

  it('reports an expired row as expired, at the exact boundary', async () => {
    const { token, hash } = mintPatSecret();
    const row: FakeRow = {
      id: 'pat-1',
      accountId: 'account-1',
      tokenHash: hash,
      expiresAt: String(NOW),
      revokedAt: null,
    };
    const { dataSource } = fakeDataSource({ findOne: vi.fn().mockResolvedValue(row) });
    const service = new PatService(dataSource);

    expect(await service.resolve(token, NOW)).toEqual({ ok: false, reason: 'expired' });
  });

  it('never touches findOne for a bearer that is not PAT-shaped', async () => {
    const { dataSource, repo } = fakeDataSource();
    const service = new PatService(dataSource);

    expect(await service.resolve('not-a-pat', NOW)).toEqual({ ok: false, reason: 'unknown' });
    expect(repo.findOne).not.toHaveBeenCalled();
  });

  it('answers unknown for a well-shaped token nobody minted', async () => {
    const { token } = mintPatSecret();
    const { dataSource } = fakeDataSource({ findOne: vi.fn().mockResolvedValue(null) });
    const service = new PatService(dataSource);

    expect(await service.resolve(token, NOW)).toEqual({ ok: false, reason: 'unknown' });
  });
});

describe('PatService.revoke', () => {
  it('makes the very next resolve() fail even inside the TTL window', async () => {
    const { token, hash } = mintPatSecret();
    const liveRow: FakeRow = {
      id: 'pat-1',
      accountId: 'account-1',
      tokenHash: hash,
      expiresAt: null,
      revokedAt: null,
    };
    const findOne = vi.fn().mockResolvedValue(liveRow);
    const { dataSource } = fakeDataSource({ findOne });
    const service = new PatService(dataSource);

    expect(await service.resolve(token, NOW)).toEqual({
      ok: true,
      accountId: 'account-1',
      tokenId: 'pat-1',
    });

    findOne.mockResolvedValue({ ...liveRow, revokedAt: String(NOW) });
    await service.revoke('account-1', 'pat-1', NOW);

    expect(await service.resolve(token, NOW + 1)).toEqual({ ok: false, reason: 'revoked' });
  });

  it('is a 404, not a 403, for a token id belonging to another account', async () => {
    const { dataSource } = fakeDataSource({ findOne: vi.fn().mockResolvedValue(null) });
    const service = new PatService(dataSource);

    await expect(service.revoke('someone-elses-account', 'pat-1', NOW)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

describe('PatService.touch', () => {
  it('writes once, not again within the flush window, then again after it', () => {
    const { dataSource, repo } = fakeDataSource();
    const service = new PatService(dataSource);

    service.touch('pat-1', NOW);
    service.touch('pat-1', NOW + 1_000);
    expect(repo.update).toHaveBeenCalledTimes(1);

    service.touch('pat-1', NOW + PAT_LAST_USED_FLUSH_MS);
    expect(repo.update).toHaveBeenCalledTimes(2);
  });
});

describe('PatService.create', () => {
  it('refuses to mint past the active-token cap', async () => {
    const { dataSource } = fakeDataSource({
      count: vi.fn().mockResolvedValue(PAT_MAX_ACTIVE_TOKENS),
    });
    const service = new PatService(dataSource);

    await expect(service.create('account-1', { name: 'laptop' }, NOW)).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('returns the secret exactly once; the persisted row carries only its hash', async () => {
    let saved: Record<string, unknown> | undefined;
    const { dataSource } = fakeDataSource({
      save: vi.fn().mockImplementation(async (row: Record<string, unknown>) => {
        saved = row;
        return row;
      }),
    });
    const service = new PatService(dataSource);

    const created = await service.create('account-1', { name: 'laptop', expiresInDays: 90 }, NOW);

    expect(created.token.startsWith('tmpat_')).toBe(true);
    expect(saved?.tokenHash).toBe(hashPat(created.token));
    expect(saved).not.toHaveProperty('token');
    expect(created.pat).not.toHaveProperty('tokenHash');
    expect(created.pat).not.toHaveProperty('token');
  });
});
