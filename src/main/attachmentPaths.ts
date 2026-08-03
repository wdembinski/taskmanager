/**
 * Where an attachment's bytes live, and what kind of file they are — the arithmetic only.
 *
 * Split from `attachments.ts` (which does the `fs`) for one reason: this is the part that
 * decides what a path IS, and it has to be testable without Electron, a store or a disk.
 * `attachments.ts` cannot be — it needs a real `better-sqlite3` and a real directory — so
 * everything here that could be a pure function is one, where a plain `vitest` run can
 * hold it to its rules.
 *
 * The root is a parameter rather than a call to `app.getPath('userData')`, for the same
 * reason `createStore(dbPath)` takes its path: a module that reaches for its own root can
 * only ever be exercised against the real profile.
 *
 * There is no path in `TaskAttachment` and no `path` column in the table (see
 * `@shared/attachments` and the design entry). Every absolute path in the app is built
 * HERE, out of the two things the row already holds, so a profile copied under a different
 * Windows account has nothing stale to be wrong about.
 */
import { join } from 'node:path';
import { attachmentName, ATTACHMENTS_DIR } from '@shared/attachments';

/** `<userData>/attachments` — the one directory the whole feature writes into. */
export function attachmentsRoot(root: string): string {
  return join(root, ATTACHMENTS_DIR);
}

/** Everything one task carries: `<userData>/attachments/<taskId>`. */
export function attachmentDir(root: string, taskId: string): string {
  return join(attachmentsRoot(root), segment(taskId));
}

/** One file: `<userData>/attachments/<taskId>/<name>`. */
export function attachmentFile(root: string, taskId: string, name: string): string {
  return join(attachmentDir(root, taskId), segment(name));
}

/**
 * A single path segment, guaranteed to stay one.
 *
 * Both segments go through `attachmentName` on the way in, even though every caller today
 * holds a name the store already sanitized. That is not distrust of the callers: it is
 * what makes "an attachment cannot escape its task's directory" a property of this module
 * instead of a property of every call site, and it is one line here against a review of
 * every future one. `attachmentName` is idempotent on a name it produced (and on a UUID),
 * so the honest paths are unchanged — while `..`, `..\evil`, `C:\Windows\x` and a bare `/`
 * all collapse to something that can only land inside the directory above.
 */
function segment(value: string): string {
  return attachmentName(value, []);
}

/**
 * Best-effort content type from the suffix, or null when the suffix says nothing.
 *
 * Null is a real answer rather than a failure — `TaskAttachment.mimeType` is nullable and
 * the row is written either way, because a file with no extension is still a file worth
 * attaching. Two things downstream read it: the `Content-Type` the attachment protocol
 * serves, and whether the pane previews the file as an image. So the `image/*` rows are
 * the ones that have to be right; the rest are a courtesy to whatever opens them.
 *
 * Sniffing the content instead would be more accurate and much worse: it would mean
 * reading the bytes of a 30 MB video to fill in a field the UI uses to pick an icon.
 */
export function mimeForExtension(name: string): string | null {
  const bare = name.split(/[\\/]/).pop() ?? '';
  const dot = bare.lastIndexOf('.');
  // `> 0`, not `>= 0`: a leading dot is a dotfile, not an extension — `.gitignore` has no
  // suffix to look up, the same rule `attachmentName` splits stems by.
  if (dot <= 0) return null;
  return MIME_BY_EXTENSION[bare.slice(dot + 1).toLowerCase()] ?? null;
}

/**
 * The suffixes worth knowing, keyed lower-case and without the dot.
 *
 * Deliberately a short list rather than a mime database: an unknown type costs nothing
 * (null, a generic icon, the OS still opens the file), so the only entries that earn their
 * place are the ones a human actually attaches to a ticket.
 *
 * `svg` is served as `image/svg+xml` and previewed like any other image. An SVG can carry
 * script, but only when it is navigated to or embedded as a document — loaded through
 * `<img src>`, which is the only way the renderer ever shows one (`img-src` in the CSP),
 * its scripts do not run.
 */
const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  // Images — the ones the pane previews.
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  svg: 'image/svg+xml',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  // Text an agent can read straight out of the file.
  txt: 'text/plain',
  log: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  json: 'application/json',
  xml: 'application/xml',
  yaml: 'application/yaml',
  yml: 'application/yaml',
  html: 'text/html',
  htm: 'text/html',
  css: 'text/css',
  // Documents.
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  // Archives and recordings — a screen capture of the bug is the common one.
  zip: 'application/zip',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
};
