/**
 * Wire a description/brief textarea's `onPaste` up to {@link attachFilesToTask}, so
 * pasting a screenshot into either does what dropping one onto its `AttachmentStrip`
 * already does.
 *
 * A hook rather than a shared component, because there is no element to render — the
 * caller's own `<Textarea>` already exists, and all this adds is one event handler and one
 * `busy` flag to fold into a control that is already there.
 */
import { useState, type ClipboardEvent } from 'react';
import type { TaskAttachment } from '@tm/shared/attachments';
import { attachFilesToTask, clipboardFiles } from './attachFiles';
import { useTransport } from './transport';

export interface UsePasteAttachmentsOptions {
  /** The card or step the pasted files land on — `AttachmentStrip`'s own `taskId`. */
  taskId: string;
  /**
   * This task's files as the caller already knows them, the moment a paste happens — the
   * "before" half of the same diff-by-id `AttachmentStrip`'s `attach()` does
   * (`AttachmentStrip.tsx:213-226`): the engine answers with the WHOLE board's list, so
   * this is what tells a freshly pasted file from one that was already sitting there.
   */
  attachments: readonly TaskAttachment[];
  /** Cite what was just pasted, at the caret — the same callback `AttachmentStrip` takes. */
  onInsertRefs: (names: readonly string[]) => void;
  /** True while the field around it refuses to accept a paste at all (mid-save, a live run). */
  disabled?: boolean;
  /** Where a failed attach is reported, as a sentence — the caller's own error state. */
  onError: (message: string) => void;
}

export interface UsePasteAttachmentsResult {
  /** Hand this to the textarea's `onPaste`. */
  onPaste: (event: ClipboardEvent<HTMLTextAreaElement>) => void;
  /** True while a pasted file is being attached — fold into the neighbouring strip's
   *  `disabled`, so the strip and a paste in flight cannot race. */
  busy: boolean;
}

export function usePasteAttachments({
  taskId,
  attachments,
  onInsertRefs,
  disabled = false,
  onError,
}: UsePasteAttachmentsOptions): UsePasteAttachmentsResult {
  const transport = useTransport();
  const [busy, setBusy] = useState(false);

  function onPaste(event: ClipboardEvent<HTMLTextAreaElement>): void {
    if (disabled || busy) return;
    const files = clipboardFiles(event.clipboardData);
    // Nothing to attach: fall through untouched, so ordinary typing and text pastes are
    // never affected by this hook existing.
    if (!files.length) return;
    event.preventDefault();
    const before = new Set(attachments.map((a) => a.id));
    setBusy(true);
    void attachFilesToTask(transport, taskId, files)
      .then((all) => {
        const added = all.filter((a) => a.taskId === taskId && !before.has(a.id));
        if (added.length) onInsertRefs(added.map((a) => a.name));
      })
      .catch((e) => onError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  }

  return { onPaste, busy };
}
