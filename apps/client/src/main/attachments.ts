/**
 * The bytes behind an attachment row: copying them in, serving them to the window,
 * removing them, and sweeping up the ones nothing points at any more.
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
 * **Reading them out is a protocol, not an IPC channel.** {@link registerAttachmentProtocol}
 * is how a `contextIsolation: true` renderer that has never been told a path gets to see a
 * picture: it writes `<img src={attachmentUrl(id)}>` and the handler below turns that id
 * into bytes. No path crosses the bridge in either direction, so traversal is not
 * something to validate — there is nothing to traverse WITH.
 *
 * Nothing here throws at the caller for a filesystem failure it can do nothing about — a
 * file that would not unlink is logged and left to the sweep. The one exception is
 * {@link addAttachments}, where a file that did not land is something the human has to be
 * told about, and it reports rather than throws so one bad pick cannot discard the rest.
 */
import { copyFile, mkdir, readdir, readFile, rm, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { protocol } from 'electron';
import {
  ATTACHMENT_SCHEME,
  attachmentIdFromUrl,
  attachmentName,
  type TaskAttachment,
} from '@shared/attachments';
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

/**
 * The most one attachment may weigh and still be served to the window.
 *
 * Well under {@link MAX_ATTACHMENT_BYTES}, because the two limits answer different
 * questions: that one is about the disk, this one is about the renderer, where the whole
 * response is decoded into a bitmap in the GPU process. A 40 MB PNG is a perfectly good
 * attachment — the human can still open it in a real viewer — it just does not get an
 * inline preview, which fails as "no thumbnail" rather than as a stalled window.
 */
export const MAX_PREVIEW_BYTES = 25 * 1024 * 1024;

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
 * Answer `vipper-attachment://a/<id>` with that attachment's bytes.
 *
 * Called once, from `registerIpcHandlers` — after the app is ready (which `protocol.handle`
 * requires) and beside `createStore`, since the store is the whole point of the handler.
 * The scheme itself is declared privileged at module scope in `index.ts`; that half must
 * run BEFORE ready, which is why the two live apart.
 *
 * The request carries an id and nothing else, and the id is resolved THROUGH the store, so
 * the path this reads is one main assembled out of a row that exists. That is the property
 * worth stating plainly: no string the renderer chose reaches `readFile`. An id that names
 * nothing — a stale pane still pointing at a removed attachment is the ordinary way this
 * happens — is a 404, which the `<img>` renders as a broken image and the pane can style.
 *
 * Failures are statuses rather than throws: a rejected handler shows Chromium's own error
 * page inside the element, which says nothing useful and cannot be styled. A file that is
 * missing on disk under a live row is the one case worth a line in the log, because it
 * means the bytes and the rows disagree and the sweep is not what caused it.
 */
export function registerAttachmentProtocol(store: Store, root: string): void {
  protocol.handle(ATTACHMENT_SCHEME, async (request) => {
    const id = attachmentIdFromUrl(request.url);
    const attachment = id ? store.getAttachment(id) : undefined;
    if (!attachment) return notFound();
    if (attachment.size > MAX_PREVIEW_BYTES) {
      // 413 rather than 404: the attachment is there, it is just not previewable. Nothing
      // reads the status today — it is what a future "too big to preview" hint would.
      return new Response('Too large to preview', { status: 413 });
    }

    const path = attachmentFile(root, attachment.taskId, attachment.name);
    try {
      const bytes = await readFile(path);
      return new Response(bytes, {
        headers: {
          // Explicit, and never sniffed: Chromium has no filename to guess from here, and
          // an image served without a type is not rendered at all. `mimeType` is null only
          // for a suffix `mimeForExtension` does not know, and such a file is not an image
          // the pane would be previewing anyway.
          'content-type': attachment.mimeType ?? 'application/octet-stream',
          // The URL is keyed by an id, and the bytes behind one id never change — removing
          // an attachment and adding it again mints a new UUID. So the response is safe to
          // treat as immutable, and a pane that re-renders does not re-read the file.
          'cache-control': 'max-age=31536000, immutable',
        },
      });
    } catch (e) {
      logMain(`Could not read the attachment file ${path}`, e);
      return notFound();
    }
  });
}

/** The one answer for "that attachment is not there", however it turned out not to be. */
function notFound(): Response {
  return new Response('No such attachment', { status: 404 });
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
