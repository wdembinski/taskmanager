import { In, type EntityManager } from 'typeorm';
import type { MirrorDelta } from '@tm/protocol/wire';
import { ProjectMirror } from '../entities/projectMirror.entity';
import { TaskMirror } from '../entities/taskMirror.entity';

/**
 * Applies one Client's {@link MirrorDelta} — upsert-and-delete, in the
 * transaction the caller (MirrorService.sync) already opened, so a Client's
 * whole tick either lands or doesn't. Deletions are ids (per the wire
 * contract's own docstring: "the mirror is disposable state"), so they're a
 * plain `DELETE ... WHERE id IN (...)`, not a tombstone write.
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
  if (delta.deletedTaskIds.length > 0) {
    await manager.delete(TaskMirror, { id: In(delta.deletedTaskIds), accountId });
  }
  if (delta.deletedProjectIds.length > 0) {
    await manager.delete(ProjectMirror, { id: In(delta.deletedProjectIds), accountId });
  }
}
