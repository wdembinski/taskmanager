/**
 * ConfirmMergeDialog — one click's worth of safety before the forge's own merge fires.
 *
 * Shared by the card row (`board/TaskCard.tsx`) and the detail pane's list
 * (`MergeRequests.tsx`), which reach it from different places — the card already holds a
 * `Transport` and calls it directly, the pane bubbles the action up through a prop — so this
 * takes the merge itself as `onConfirm` rather than calling `transport.invoke('mr:merge', …)`
 * on its own. Follows the delete-task dialog's shape (`TaskDetailsCell.tsx:632`), except a
 * rejection stays open with the forge's own message rather than closing: "not mergeable any
 * more" is something to read, not dismiss blind.
 */
import { useState } from 'react';
import {
  Button,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  MessageBar,
  MessageBarBody,
  Spinner,
} from '@fluentui/react-components';
import { forgeName, mrRef, type MergeRequest } from '@tm/shared/mergeRequest';

export interface ConfirmMergeDialogProps {
  /** The MR this confirms merging — only the fields the question needs to ask. */
  mr: Pick<MergeRequest, 'provider' | 'number' | 'targetBranch'>;
  /** Perform the merge. Resolving closes the dialog; rejecting shows the message and keeps it open. */
  onConfirm: () => Promise<unknown>;
  onClose: () => void;
}

export function ConfirmMergeDialog({
  mr,
  onConfirm,
  onClose,
}: ConfirmMergeDialogProps): React.JSX.Element {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function merge(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(_e, d) => !d.open && !busy && onClose()}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>
            Merge {mrRef(mr)} into {mr.targetBranch} on {forgeName(mr.provider)}?
          </DialogTitle>
          <DialogContent>
            {error && (
              <MessageBar intent="error">
                <MessageBarBody>{error}</MessageBarBody>
              </MessageBar>
            )}
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" disabled={busy} onClick={onClose}>
              Cancel
            </Button>
            <Button
              appearance="primary"
              disabled={busy}
              icon={busy ? <Spinner size="tiny" /> : undefined}
              onClick={() => void merge()}
            >
              {busy ? 'Merging…' : 'Merge'}
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
