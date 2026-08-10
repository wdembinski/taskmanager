import type { EntityManager } from 'typeorm';
import { Account } from '../entities/account.entity';

/**
 * Upserts the authenticated caller's `accounts` row. Every mirror table FKs to `accounts(id)`
 * (see `../entities/account.entity.ts`), and a real IAM subject has no row there until it is
 * seen for the first time — unlike {@link import('../mirror/devAccount').DEV_ACCOUNT_ID}, which
 * the initial migration seeds. Called from `IamAuthGuard` before a request reaches its
 * controller, so every mirror query downstream can assume the row already exists.
 */
export async function ensureAccount(
  manager: EntityManager,
  accountId: string,
  displayName: string,
): Promise<void> {
  await manager.upsert(Account, { id: accountId, name: displayName }, ['id']);
}
