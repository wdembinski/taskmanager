import { In, type EntityManager } from 'typeorm';
import type { MirrorDelta } from '@tm/protocol/wire';
import { ProjectMirror } from '../entities/projectMirror.entity';
import { TaskMirror } from '../entities/taskMirror.entity';
import { Tombstone, tombstoneId } from '../entities/tombstone.entity';

/**
 * Applies one Client's {@link MirrorDelta} — upsert-and-delete, in the
 * transaction the caller (MirrorService.sync) already opened, so a Client's
 * whole tick either lands or doesn't.
 *
 * A deletion drops the mirror row AND records a {@link Tombstone}. The row is what a
 * desktop Client's catch-up needs; the tombstone is what a browser's does — see that
 * entity's docstring for why an absent row is not a deletion anyone can observe.
 *
 * An upsert of an id that has a tombstone CLEARS it: `task:restore` brings a card back with
 * the same id, and leaving the tombstone would tell every web tab to drop the card it had
 * just been sent.
 *
 * Every statement is scoped to `accountId`, the authenticated caller's real account id
 * (see `../iam/iamAuth.guard.ts`) outside `CLOUD_DEV_NO_AUTH=1`.
 */
export async function applyMirrorDelta(
  manager: EntityManager,
  accountId: string,
  delta: MirrorDelta,
): Promise<void> {
  if (delta.tasks.length > 0) {
    await manager.upsert(
      TaskMirror,
      delta.tasks.map((task) => ({
        id: task.id,
        accountId,
        projectId: task.projectId,
        data: task,
      })),
      ['id'],
    );
  }
  if (delta.projects.length > 0) {
    await manager.upsert(
      ProjectMirror,
      delta.projects.map((project) => ({ id: project.id, accountId, data: project })),
      ['id'],
    );
  }
  // Clear any tombstone for something that just came back — before the deletions below, so a
  // delta that both restores one id and deletes another cannot cancel its own deletion.
  await clearTombstones(
    manager,
    accountId,
    'task',
    delta.tasks.map((t) => t.id),
  );
  await clearTombstones(
    manager,
    accountId,
    'project',
    delta.projects.map((p) => p.id),
  );

  if (delta.deletedTaskIds.length > 0) {
    await manager.delete(TaskMirror, { id: In(delta.deletedTaskIds), accountId });
    await writeTombstones(manager, accountId, 'task', delta.deletedTaskIds);
  }
  if (delta.deletedProjectIds.length > 0) {
    await manager.delete(ProjectMirror, { id: In(delta.deletedProjectIds), accountId });
    await writeTombstones(manager, accountId, 'project', delta.deletedProjectIds);
  }
}

/**
 * `delete` then `insert` rather than `upsert`, deliberately: a row updated in place keeps
 * its old identity but gets a NEW rowVersion either way, so an upsert would work — except
 * that deleting the same id twice (two Clients, or a retried tick) must still produce a
 * tombstone a browser past the first one's cursor can see. Re-inserting guarantees that.
 */
async function writeTombstones(
  manager: EntityManager,
  accountId: string,
  entity: 'task' | 'project',
  ids: readonly string[],
): Promise<void> {
  const rows = ids.map((entityId) => ({
    id: tombstoneId(accountId, entity, entityId),
    accountId,
    entity,
    entityId,
  }));
  await manager.delete(Tombstone, { id: In(rows.map((r) => r.id)) });
  await manager.insert(Tombstone, rows);
}

async function clearTombstones(
  manager: EntityManager,
  accountId: string,
  entity: 'task' | 'project',
  ids: readonly string[],
): Promise<void> {
  if (ids.length === 0) return;
  await manager.delete(Tombstone, {
    id: In(ids.map((entityId) => tombstoneId(accountId, entity, entityId))),
  });
}
