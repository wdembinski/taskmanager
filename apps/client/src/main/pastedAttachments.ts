/**
 * The clipboard's bytes, landed on this machine's disk — the paste-side twin of
 * `uploadedAttachments.ts`, and built the same way for the same reason: `attachment:add`
 * takes paths because a copy of a copy through a structured clone is worse than a `stat`
 * and a `copyFile`, and clipboard bytes are no exception once they exist as a `Uint8Array`
 * in the main process. What this module does is turn those bytes into a temp file with a
 * name `addAttachments` (`attachments.ts`) can read straight off the path, exactly as it
 * already does for an upload or a picked file.
 *
 * TWO RULES CARRIED OVER FROM `uploadedAttachments.ts`, FOR THE SAME REASON
 * --------------------------------------------------------------------------
 * **One temp directory per file.** `addAttachments` reads a file's name off its path with
 * `basename`, so two pastes in one gesture must not be able to land in the same directory —
 * `pastedFileName` (`@shared/attachments`) names a file after the moment it was pasted, and
 * two images copied together can still collide on the millisecond. Separate directories make
 * that impossible rather than unlikely, same as it does for an upload.
 *
 * **Not trusted, sanitized once.** `PastedAttachment.fileName` and `.mimeType` are whatever
 * the source page or app declared, unchecked by the renderer before they cross IPC.
 * `pastedFileName` turns them into a name that does not depend on either being honest, and
 * `uploadTempName` (imported from `uploadedAttachments.ts`, not reimplemented) is what makes
 * that name safe to write here — one sanitizer for a temp file's name, shared by both routes
 * bytes reach main by.
 *
 * Nothing written here is meant to survive a restart: {@link sweepPasteTemp} removes the
 * whole root at boot, the same backstop `sweepOrphanAttachments` is for real attachments,
 * and for the same reason — a crash between this write and the `attachment:add` that would
 * have turned it into a real one must not leave bytes nobody will ever clean up.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAX_PASTE_BYTES, pastedFileName, type PastedAttachment } from '@shared/attachments';
import { logMain } from './log';
import { uploadTempName } from './uploadedAttachments';

/** `<tmpdir>/vipper-paste` — every pasted file's temp copy lives somewhere under here. */
export const PASTE_TEMP_ROOT = join(tmpdir(), 'vipper-paste');

/**
 * The most files one `attachment:stagePasted` call may carry.
 *
 * A real paste is one image, occasionally a handful; nothing pastes dozens of files in one
 * gesture. The cap exists for the caller that is not a human doing that — a renderer bug or
 * a payload built by hand — and a clear refusal is the right answer to that, rather than
 * writing however many files it happened to ask for.
 */
export const MAX_PASTE_FILES = 8;

export interface StagePastedFilesOptions {
  /** Where the per-file temp directories are made. Defaults to {@link PASTE_TEMP_ROOT}. */
  root?: string;
}

/**
 * Write each pasted file's bytes into a temp directory of its own and return the paths, in
 * order — ready for `attachment:add`'s `addAttachments`, exactly as a picked file's path is.
 *
 * All-or-nothing, unlike `collectUploads`: a paste is one clipboard read, not a multi-file
 * dialog pick, so there is no "three of four landed" to preserve, and a bad file (too large,
 * or too many at once) is refused with a sentence before anything is written, rather than
 * letting some of the batch land. Whatever a call did manage to write before a later file
 * failed is removed again before the throw, so a refused paste leaves nothing behind for
 * {@link sweepPasteTemp} to have to find later.
 */
export async function stagePastedFiles(
  files: readonly PastedAttachment[],
  options: StagePastedFilesOptions = {},
): Promise<string[]> {
  if (files.length > MAX_PASTE_FILES) {
    throw new Error(`Paste at most ${MAX_PASTE_FILES} files at a time.`);
  }

  const root = options.root ?? PASTE_TEMP_ROOT;
  await mkdir(root, { recursive: true });

  const dirs: string[] = [];
  const paths: string[] = [];
  try {
    for (const file of files) {
      if (file.bytes.byteLength > MAX_PASTE_BYTES) {
        const limitMb = Math.round(MAX_PASTE_BYTES / (1024 * 1024));
        throw new Error(`${file.fileName || 'The pasted file'} is larger than ${limitMb} MB.`);
      }
      // Per file, before the write: two images pasted in one gesture can still collide on
      // the name `pastedFileName` gives them, and the directory is what keeps them apart.
      const dir = await mkdtemp(join(root, 'vipper-paste-'));
      dirs.push(dir);
      const name = uploadTempName(pastedFileName(file.fileName, file.mimeType, Date.now()));
      const path = join(dir, name);
      await writeFile(path, file.bytes);
      paths.push(path);
    }
    return paths;
  } catch (e) {
    for (const dir of dirs) {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
    throw e;
  }
}

/**
 * Remove every temp file a paste has ever left under `root`. Called once at boot, beside
 * `sweepOrphanAttachments`: nothing pasted is meant to outlive a restart, whether it went on
 * to become a real attachment (whose bytes now live under `userData`, not here) or never got
 * that far. Never throws — a directory that would not remove is left for the OS's own temp
 * sweep, the same as an attachment file that would not unlink.
 */
export async function sweepPasteTemp(root: string = PASTE_TEMP_ROOT): Promise<void> {
  try {
    await rm(root, { recursive: true, force: true });
  } catch (e) {
    logMain(`Could not sweep the paste temp directory ${root}`, e);
  }
}
