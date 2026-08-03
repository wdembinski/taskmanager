/**
 * The bytes behind an attachment row: copying them in, removing them, and sweeping up the
 * ones nothing points at any more.
 *
 * **A copy, not a reference.** The file the human picked can be moved, renamed, emptied or
 * deleted the minute after they picked it — and a brief that points at a file which is
 * gone is worse than a brief that never had one, because the agent reads the `@name` and
 * fails somewhere far from the cause. So the picked file is copied under `userData`, where
 * the app already keeps the database, the MCP config and the logs, and nothing outside the
 * app can move it.
 *
 * **The row and the bytes are two facts, and only one of them cascades.** SQLite takes the
 * rows with a deleted task for free (`ON DELETE CASCADE`, `store.ts`); nothing takes the
 * files. That asymmetry is the whole reason this module exists, and it is answered in
 * three places rather than one, because every single-place answer has a path that misses
 * it:
 *
 * 1. `attachment:remove` unlinks the one file, right after the row is gone.
 * 2. `task:delete` removes the card's directory and its steps' — *after* `deleteTask`
 *    returns, never inside the transaction, where a failed unlink would roll the row
 *    deletion back and leave the app half-deleted.
 * 3. {@link sweepOrphanAttachments} at boot is the backstop that actually makes it safe:
 *    deleting a PROJECT cascades its tasks without `task:delete` ever running, and a crash
 *    between the copy and the insert leaves bytes no row ever named. One pass over
 *    `attachments/*` catches both, and every future path that forgets.
 *
 * Nothing here throws at the caller for a filesystem failure it can do nothing about — a
 * file that would not unlink is logged and left to the sweep. The one exception is
 * {@link addAttachments}, where a file that did not land is something the human has to be
 * told about, and it reports rather than throws so one bad pick cannot discard the rest.
 */
import { copyFile, mkdir, readdir, rm, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { attachmentName, type TaskAttachment } from '@shared/attachments';
import {
  attachmentDir,
  attachmentFile,
  attachmentsRoot,
  mimeForExtension,
} from './attachmentPaths';
import { logMain } from './log';
import type { Store } from './store';

/**
 * The most one attachment may weigh.
 *
 * Not a security boundary — a picker the human drives is not an attack — but a copy into
 * the profile is a copy the human cannot see, and a disk quietly filling up is a worse
 * failure than "that file is too big". 100 MB clears the case the design names (a 30 MB
 * screen recording) with room to spare.
 */
export const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024;

/** One picked file that did not become an attachment, and the sentence explaining it. */
export interface FailedAttachment {
  path: string;
  reason: string;
}

/** What {@link addAttachments} managed, and what it did not. */
export interface AddAttachmentsResult {
  added: TaskAttachment[];
  failed: FailedAttachment[];
}

/**
 * Copy each path under `<root>/attachments/<taskId>/` and record a row for it.
 *
 * Per file, in this order and for these reasons:
 *
 * - **The bytes first, the row second.** The reverse leaves a row the UI renders as a chip
 *   pointing at nothing if the copy then fails; this way the worst case is bytes nobody
 *   named, which is exactly what the boot sweep exists to remove.
 * - **The name is decided against the names already taken**, growing as we go, so two
 *   files picked in one gesture with the same name land as `shot.png` and `shot-2.png`
 *   rather than one overwriting the other. `attachmentName` is what both this and the
 *   store's `UNIQUE (taskId, name)` mean by "taken" — one policy, checked here so the
 *   filesystem and the table cannot disagree.
 *
 * A file that fails is collected rather than thrown, because a pick of five files where
 * the fourth is a locked Outlook attachment should attach four files and say so — not
 * attach three and abandon the fifth. The caller reports `failed` after the ones that
 * landed are on screen.
 */
export async function addAttachments(
  store: Store,
  root: string,
  taskId: string,
  paths: readonly string[],
): Promise<AddAttachmentsResult> {
  const added: TaskAttachment[] = [];
  const failed: FailedAttachment[] = [];
  const taken = store.attachmentsForTask(taskId).map((a) => a.name);

  for (const source of paths) {
    try {
      added.push(await addOne(store, root, taskId, source, taken));
      taken.push(added[added.length - 1].name);
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      logMain(`Could not attach ${source}`, e);
      failed.push({ path: source, reason });
    }
  }
  return { added, failed };
}

/** One file's worth of {@link addAttachments}. Throws, so the loop above can carry on. */
async function addOne(
  store: Store,
  root: string,
  taskId: string,
  source: string,
  taken: readonly string[],
): Promise<TaskAttachment> {
  const info = await stat(source);
  // A directory reaches this only from a future drag-and-drop; the picker is `openFile`.
  if (!info.isFile()) throw new Error('not a file');
  if (info.size > MAX_ATTACHMENT_BYTES) {
    throw new Error(`larger than ${Math.round(MAX_ATTACHMENT_BYTES / (1024 * 1024))} MB`);
  }

  const fileName = basename(source);
  const name = attachmentName(fileName, taken);
  const target = attachmentFile(root, taskId, name);
  await mkdir(attachmentDir(root, taskId), { recursive: true });
  await copyFile(source, target);

  // `mimeType` is read off the name the file ARRIVED with. Sanitizing never touches the
  // suffix, so the two agree — but the original is the truth about what this file is.
  const row = store.addAttachment({
    taskId,
    name,
    fileName,
    mimeType: mimeForExtension(fileName),
    size: info.size,
  });
  if (row) return row;

  // Refused means an unknown task (the foreign key) or a name that was taken after we
  // read the list. The caller checks the task exists, so this is the unreachable half of
  // a contract rather than a case with a story — but the bytes are already written, so
  // they go back. Only when no row claims that name: in the racing case the file at that
  // path belongs to the row that won, and removing it would delete a live attachment.
  if (!store.attachmentsForTask(taskId).some((a) => a.name.toLowerCase() === name.toLowerCase())) {
    await rm(target, { force: true }).catch(() => {});
  }
  throw new Error('the store refused it');
}

/**
 * Unlink one attachment's file. Never throws: the row is already gone by the time this
 * runs, so a failure here is bytes to sweep at the next boot, not an error the human can
 * act on. `force` makes an already-missing file a success, which is the right answer.
 */
export async function deleteAttachmentFile(
  root: string,
  attachment: TaskAttachment,
): Promise<void> {
  const path = attachmentFile(root, attachment.taskId, attachment.name);
  try {
    await rm(path, { force: true });
  } catch (e) {
    logMain(`Could not remove the attachment file ${path}`, e);
  }
}

/**
 * Remove whole task directories — a deleted card and each of its steps.
 *
 * Called after `store.deleteTask` has returned, never inside its transaction: a throw in
 * there would roll the row deletion back and leave a card that is half-deleted, which is
 * the one outcome worse than either half on its own. Never throws, for the same reason
 * {@link deleteAttachmentFile} does not.
 */
export async function deleteTaskAttachments(
  root: string,
  taskIds: readonly string[],
): Promise<void> {
  for (const taskId of taskIds) {
    const dir = attachmentDir(root, taskId);
    try {
      await rm(dir, { recursive: true, force: true });
    } catch (e) {
      logMain(`Could not remove the attachments directory ${dir}`, e);
    }
  }
}

/**
 * Remove every attachment directory no row points at. Returns how many went.
 *
 * The backstop, and the only deletion path that cannot be forgotten: it runs at boot,
 * knows nothing about how the rows disappeared, and therefore covers the ones the handlers
 * never see — a deleted PROJECT (whose cascade takes its tasks, and their attachments,
 * without `task:delete` ever running), a crash between the copy and the insert, and
 * whatever a later phase adds that deletes a task by another route.
 *
 * The test is "no row names this directory" rather than "no task has this id", which is
 * the same test one notch tighter: a live task with no attachment rows has nothing in its
 * directory worth keeping either, and the rows are read fresh per candidate so a file
 * attached while the sweep is walking cannot be caught by a stale snapshot.
 *
 * A missing root is the ordinary state of a profile that has never attached anything, so
 * it is not worth a word in the log.
 */
export async function sweepOrphanAttachments(store: Store, root: string): Promise<number> {
  const dir = attachmentsRoot(root);
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      logMain(`Could not read the attachments directory ${dir}`, e);
    }
    return 0;
  }

  let removed = 0;
  for (const entry of entries) {
    if (store.attachmentsForTask(entry).length > 0) continue;
    // `join`, not `attachmentDir`: this name came from `readdir`, so it is already exactly
    // one segment, and what gets removed must be what was listed rather than what the
    // naming policy would have called it.
    const orphan = join(dir, entry);
    try {
      await rm(orphan, { recursive: true, force: true });
      removed += 1;
    } catch (e) {
      logMain(`Could not remove the orphaned attachments at ${orphan}`, e);
    }
  }
  if (removed > 0)
    logMain(`Swept ${removed} orphaned attachment director${removed === 1 ? 'y' : 'ies'}`);
  return removed;
}
