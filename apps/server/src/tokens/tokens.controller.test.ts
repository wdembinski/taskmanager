import 'reflect-metadata';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { CreatedPersonalAccessToken, PersonalAccessTokenList } from '@tm/protocol/wire';
import type { PatService } from '../iam/patService';
import { TokensController } from './tokens.controller';

function controllerWith(pats: Partial<PatService>): TokensController {
  return new TokensController(pats as PatService);
}

describe('TokensController', () => {
  it('returns the secret exactly once; the listed row carries neither secret nor hash', async () => {
    const created: CreatedPersonalAccessToken = {
      token: 'tmpat_abc',
      pat: {
        id: 'pat-1',
        name: 'laptop',
        hint: 'tmpat_ab',
        createdAt: 1,
        expiresAt: null,
        revokedAt: null,
        lastUsedAt: null,
      },
    };
    const create = vi.fn().mockResolvedValue(created);
    const controller = controllerWith({ create });

    const answer = await controller.create('account-1', { name: 'laptop' });
    expect(answer.token).toBe('tmpat_abc');
    expect(answer).not.toHaveProperty('pat.token');
    expect(answer).not.toHaveProperty('pat.tokenHash');
    expect(create).toHaveBeenCalledWith('account-1', { name: 'laptop', expiresInDays: null });
  });

  it('rejects a blank name', async () => {
    const controller = controllerWith({});
    await expect(controller.create('account-1', { name: '   ' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('rejects a name over 100 characters', async () => {
    const controller = controllerWith({});
    await expect(controller.create('account-1', { name: 'x'.repeat(101) })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('rejects expiresInDays over the maximum', async () => {
    const controller = controllerWith({});
    await expect(
      controller.create('account-1', { name: 'laptop', expiresInDays: 366 }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('lists this account’s tokens', async () => {
    const list: PersonalAccessTokenList = { tokens: [] };
    const controllerList = vi.fn().mockResolvedValue(list);
    const controller = controllerWith({ list: controllerList });

    await expect(controller.list('account-1')).resolves.toEqual(list);
    expect(controllerList).toHaveBeenCalledWith('account-1');
  });

  it('scopes delete to the caller’s account — another account’s id is a 404', async () => {
    const revoke = vi.fn().mockRejectedValue(new NotFoundException('No such token.'));
    const controller = controllerWith({ revoke });

    await expect(controller.revoke('account-2', 'pat-1')).rejects.toBeInstanceOf(NotFoundException);
    expect(revoke).toHaveBeenCalledWith('account-2', 'pat-1');
  });

  it('sets Cache-Control: no-store on the mint route', () => {
    const headers: Array<{ name: string; value: string }> = Reflect.getMetadata(
      '__headers__',
      TokensController.prototype.create,
    );
    expect(headers).toContainEqual({ name: 'Cache-Control', value: 'no-store' });
  });
});
