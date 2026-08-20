/**
 * Turning a paste into attachments — the host branch `AttachmentStrip`'s drop handler
 * already has, pulled out so a textarea's `onPaste` can share it instead of growing its
 * own copy.
 *
 * Two pieces, one for each half of the gesture:
 *
 * - {@link clipboardFiles} reads what a paste actually carried. It is the paste-side
 *   mirror of `isFileDrag` (`AttachmentStrip.tsx`) — pure, and pinned the same way — and
 *   answers `[]` for ordinary text, which is what lets a caller decide whether to
 *   `preventDefault()` at all: a paste that inserts no files must fall through to the
 *   textarea's own paste behaviour untouched.
 * - {@link attachFilesToTask} is the two-branch write `AttachmentStrip`'s `onDrop` also
 *   does — bytes for a browser, paths for a desktop with a filesystem behind it — with one
 *   addition a paste needs that a drop never did: a file with no path on disk is no longer
 *   a refusal. `AttachmentStrip.tsx`'s drop handler still says "no file on disk" for one
 *   of those, because everything a native OS drag can carry already has a path; a paste
 *   commonly does not (a screenshot copied out of a viewer, a picture dragged out of
 *   another window), and staging it through `attachment:stagePasted` is what turns that
 *   into an ordinary attachment instead of a dead end.
 */
import type { PastedAttachment, TaskAttachment } from '@tm/shared/attachments';
import type { Transport } from './transport';

/**
 * The files a paste carried, or `[]` for a paste that carried none (ordinary text, a
 * copied cell, a link).
 *
 * Unlike `isFileDrag`, this can read the payload directly rather than only the type list —
 * a `paste` event, unlike `dragover`, is the moment the data is actually handed over — so
 * there is no equivalent trick to pin here beyond the empty case: Chromium leaves
 * `DataTransfer.files` empty for anything that is not a file, which is exactly the
 * distinction a caller needs to leave plain typing alone.
 */
export function clipboardFiles(data: DataTransfer | null): File[] {
  return data ? Array.from(data.files) : [];
}

/**
 * Attach `files` to `taskId`, however this host does that, and return the board's whole
 * attachment list — the same contract `AttachmentStrip`'s `add`/`addFiles` already have,
 * so a caller diffs the result the same way the strip does.
 *
 * The browser branch is taken WHENEVER `transport.attachFiles` exists, exactly the
 * condition `AttachmentStrip` branches on — a browser has no paths and no business being
 * asked to find one, so the bytes it already holds are handed over as-is.
 *
 * The desktop branch runs each file through `transport.pathForFile` first: one dropped
 * from a file manager, or otherwise backed by a real file, resolves to a path and is
 * copied in exactly like a picked file. Whatever is left with no path is bytes that exist
 * only in memory — read once, staged to disk in one `attachment:stagePasted` call, and
 * folded back into the SAME list its path-bearing siblings are in, so the final
 * `attachment:add` is one call carrying every path in the order `files` arrived in. One
 * call, not one per pathless file, because `attachmentName`'s `-2`/`-3` dedupe suffixes are
 * assigned against `taken` as it stood at the START of the call — a second call would not
 * yet see the names the first just took.
 */
export async function attachFilesToTask(
  transport: Transport,
  taskId: string,
  files: readonly File[],
): Promise<TaskAttachment[]> {
  if (!files.length) return [];
  if (transport.attachFiles) return transport.attachFiles(taskId, files);

  const located = files.map((file) => ({ file, path: transport.pathForFile(file) }));
  const pathless = located.filter((f) => f.path === '');
  const staged = pathless.length
    ? await transport.invoke(
        'attachment:stagePasted',
        await Promise.all(pathless.map((f) => toPastedAttachment(f.file))),
      )
    : [];

  // `pathless` was filtered out of `located` in order, so walking it alongside `staged`
  // in lockstep recombines the two into `located`'s own order — a picked-path file keeps
  // its path, a staged one takes the next path `stagePastedFiles` handed back for it.
  let next = 0;
  const paths = located.map((f) => (f.path !== '' ? f.path : staged[next++]));
  return transport.invoke('attachment:add', taskId, paths);
}

/** One `File`'s bytes, read once, in the shape `attachment:stagePasted` takes. */
async function toPastedAttachment(file: File): Promise<PastedAttachment> {
  return {
    fileName: file.name,
    mimeType: file.type || null,
    bytes: new Uint8Array(await file.arrayBuffer()),
  };
}
