/**
 * A browser's uploaded files, landed on this machine's disk so the ordinary attachment path
 * can take them from there.
 *
 * `attachment:add` takes PATHS — an attachment can be a 30 MB screen recording, and bytes
 * through a structured clone would copy it twice through memory to reach a process that can
 * read the file itself. A browser has no path to give, so `attachment:addUploaded` names
 * upload tickets instead and the desktop fetches those bytes over the raw blob route. What
 * this module does is the join between the two: bytes in, a path out, and then
 * {@link addAttachments} runs exactly as it does for a file the human picked here — same
 * naming policy, same dedupe, same size check, same collected failures. There is no second
 * implementation of "become an attachment", which is the whole point.
 *
 * TWO RULES, AND THE SECOND ONE IS THE SECURITY BOUNDARY
 * -----------------------------------------------------
 * **One temp directory per file.** `mkdtemp` per upload, not one directory for the batch:
 * `addAttachments` reads the name off the path with `basename`, so the file has to keep the
 * name it arrived with — and two files called `shot.png` picked in a single gesture would
 * then overwrite each other before either became a row. Separate directories make that
 * impossible rather than unlikely, and it is the same reason the app copies an attachment
 * into `userData` instead of pointing at where it was.
 *
 * **`fileName` is a string from another machine.** It reached the desktop over the network,
 * from a browser, and is under nobody's control here — so it is sanitized twice, for two
 * different writes:
 *
 *  1. {@link uploadTempName} for the write into the temp directory. Directories are stripped
 *     and the characters Windows will not open are dropped, but spaces, parentheses and
 *     accents survive, so the row keeps the name the human recognizes.
 *  2. `attachmentName` (`@shared/attachments`) for the write into `userData`, applied by
 *     `addAttachments` itself. That is the one that matters: it is the narrow
 *     `[A-Za-z0-9._-]` intersection of a Windows filename and an `@token`, `..` and `.`
 *     collapse to the fallback, and it is where an authenticated browser stops being able to
 *     choose a path in the profile directory.
 *
 * Nothing here throws for one bad upload. A batch of five where the third has expired should
 * attach four and say so, which is the contract `addAttachments` already has and this
 * mirrors, reporting `failed` in the same shape.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { UploadedAttachment } from '@shared/attachments';
import { logMain } from './log';

/** One upload that did not land, and the sentence explaining it. Mirrors `FailedAttachment`. */
export interface FailedUpload {
  /** The name the browser gave, since there is no path to name — this is what the human sees. */
  path: string;
  reason: string;
}

/** What {@link collectUploads} produced: files to attach, files that never arrived, and a broom. */
export interface CollectedUploads {
  /** Absolute paths, ready for `addAttachments`, in the order the uploads were given. */
  paths: string[];
  failed: FailedUpload[];
  /**
   * Remove every temp directory this made. Never throws, and must be called on both paths —
   * these are copies of copies, and the OS's own temp sweep is not a schedule anybody should
   * be relying on for a 25 MB file.
   */
  cleanup: () => Promise<void>;
}

/** The most a temp file's name may run to, well inside every filesystem's own limit. */
const TEMP_NAME_MAX = 120;

/** What a name degrades to when there is nothing left of it — the same word `attachmentName` uses. */
const FALLBACK_NAME = 'file';

/**
 * What a browser's `fileName` is called inside its temp directory.
 *
 * Deliberately looser than `attachmentName`: this name exists so `basename` can hand the
 * original back to `addAttachments`, and stripping it down to `[A-Za-z0-9._-]` here would
 * throw away the spaces and parentheses that are how a human recognizes their own
 * "Screenshot 2026-08-03 at 11.04 (1).png". What it does remove is everything that makes a
 * string dangerous or unopenable rather than merely untidy:
 *
 * - **Directories.** Split on both separators and keep the last segment, so `../../evil` is
 *   `evil` before it is ever joined onto anything.
 * - **Control characters and the Windows-reserved set** `<>:"|?*` — a `:` is an NTFS
 *   alternate data stream, and the rest simply fail at `open()`.
 * - **Trailing dots and spaces**, legal to write on Windows and impossible to open after.
 * - `.` and `..`, which is what a name made only of dots collapses to, and which would name
 *   the directory rather than a file in it.
 *
 * The traversal argument does not rest on this function — `..` cannot survive the segment
 * split, and even if something did, the directory is one `mkdtemp` made a moment ago and the
 * profile is protected by `attachmentName` further down. This is about the file opening.
 */
export function uploadTempName(fileName: string): string {
  const bare = (fileName ?? '').split(/[\\/]/).pop() ?? '';
  const cleaned = bare
    .normalize('NFC')
    // eslint-disable-next-line no-control-regex -- control characters are exactly what must go.
    .replace(/[\x00-\x1f\x7f<>:"|?*]/g, '')
    .replace(/[. ]+$/, '')
    .trim();
  if (cleaned === '' || cleaned === '.' || cleaned === '..') return FALLBACK_NAME;
  return capName(cleaned);
}

/** Cap the length by eating into the STEM, so the extension — which decides the MIME — survives. */
function capName(name: string): string {
  if (name.length <= TEMP_NAME_MAX) return name;
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 ? name.slice(dot) : '';
  const room = TEMP_NAME_MAX - ext.length;
  if (room < 1) return name.slice(0, TEMP_NAME_MAX);
  return `${name.slice(0, room)}${ext}`;
}

/**
 * Fetch each upload's bytes and write them where `addAttachments` can pick them up.
 *
 * `fetchBytes` is injected rather than imported so this module knows nothing about the cloud:
 * the desktop's HTTP edge is `cloudAttachmentUploader.ts`, and what happens here is the same
 * whether the bytes came from there or from a test.
 */
export async function collectUploads(
  uploads: readonly UploadedAttachment[],
  fetchBytes: (upload: UploadedAttachment) => Promise<Uint8Array>,
  options: { tempRoot?: string } = {},
): Promise<CollectedUploads> {
  const root = options.tempRoot ?? tmpdir();
  const dirs: string[] = [];
  const paths: string[] = [];
  const failed: FailedUpload[] = [];

  for (const upload of uploads) {
    try {
      const bytes = await fetchBytes(upload);
      // Per file, before the write: two uploads in one gesture may carry one name, and the
      // directory is what keeps them apart. Recorded for cleanup before anything can throw.
      const dir = await mkdtemp(join(root, 'vipper-upload-'));
      dirs.push(dir);
      const path = join(dir, uploadTempName(upload.fileName));
      await writeFile(path, bytes);
      paths.push(path);
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      logMain(`Could not collect the uploaded file ${upload.fileName}`, e);
      failed.push({ path: upload.fileName, reason });
    }
  }

  return {
    paths,
    failed,
    cleanup: async () => {
      for (const dir of dirs) {
        try {
          await rm(dir, { recursive: true, force: true });
        } catch (e) {
          // Left for the OS's temp sweep. A copy that would not delete is not a reason to
          // fail an attachment that landed.
          logMain(`Could not remove the upload temp directory ${dir}`, e);
        }
      }
    },
  };
}
