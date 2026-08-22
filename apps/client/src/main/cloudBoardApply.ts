/**
 * Applies one `GET /v1/board` pull's `MirrorDelta` (`@tm/protocol/wire`) to the local store —
 * the pull-side counterpart to `cloudDelta.ts`'s push. Shaped like `cloudCommands.ts`'s own
 * dispatch: this file decides WHETHER a row lands, `store.ts`'s `upsertCloudProject`/
 * `upsertCloudTask` decide HOW.
 *
 * THE ONE GUARD THIS EXISTS TO ENFORCE
 * -------------------------------------
 * A cloud pull races this very desktop's own outbox: an entity edited here since the last
 * successful `/v1/sync` sits in `cloud_outbox` unsent, and the cloud's copy of it is
 * therefore STALE relative to what is on disk right now. Applying it anyway would clobber
 * the edit with older data the instant a poll happened to land between the edit and the
 * next push — see `store.hasPendingCloudPush`. Skipping it here costs nothing: the pending
 * write reaches the cloud on this desktop's own next `/v1/sync`, and the row this pull would
 * have written is a strict subset of what that push is about to overwrite it with.
 *
 * Projects are applied before tasks so a project pulled down in the same batch as its own
 * tickets already exists locally by the time `upsertCloudTask` bumps its ticket allocator —
 * see that method's own docstring.
 */
import type { MirrorDelta } from '@protocol/wire';
import type { Store } from './store';

export interface CloudBoardApplyResult {
  appliedProjectIds: string[];
  skippedProjectIds: string[];
  appliedTaskIds: string[];
  skippedTaskIds: string[];
}

export function applyCloudBoardDelta(store: Store, delta: MirrorDelta): CloudBoardApplyResult {
  const result: CloudBoardApplyResult = {
    appliedProjectIds: [],
    skippedProjectIds: [],
    appliedTaskIds: [],
    skippedTaskIds: [],
  };

  for (const project of delta.projects) {
    if (store.hasPendingCloudPush('project', project.id)) {
      result.skippedProjectIds.push(project.id);
      continue;
    }
    store.upsertCloudProject(project);
    result.appliedProjectIds.push(project.id);
  }
  for (const id of delta.deletedProjectIds) {
    if (store.hasPendingCloudPush('project', id)) {
      result.skippedProjectIds.push(id);
      continue;
    }
    store.removeProject(id);
  }

  for (const task of delta.tasks) {
    if (store.hasPendingCloudPush('task', task.id)) {
      result.skippedTaskIds.push(task.id);
      continue;
    }
    store.upsertCloudTask(task);
    result.appliedTaskIds.push(task.id);
  }
  for (const id of delta.deletedTaskIds) {
    if (store.hasPendingCloudPush('task', id)) {
      result.skippedTaskIds.push(id);
      continue;
    }
    store.deleteTask(id);
  }

  return result;
}
