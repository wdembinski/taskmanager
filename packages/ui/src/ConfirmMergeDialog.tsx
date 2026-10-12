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
 *
 * On open it also asks `loadProposal` for the commit message the forge itself would write
 * (see `MergeProposal`) and shows it in an editable field — merging sends whatever is left in
 * it, blank or not, via `onConfirm`'s `message`. A method that creates no merge commit
 * (GitHub's rebase, GitLab's fast-forward) has nothing to propose, so a one-line note stands
 * in for the field; a proposal that fails to load leaves the field empty rather than guessing.
 */
import { useEffect, useState } from 'react';
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
  Textarea,
  makeStyles,
} from '@fluentui/react-components';
import { forgeName, mrRef, type MergeRequest } from '@tm/shared/mergeRequest';
import type { MergeProposal } from '@tm/shared/ipc';
import { MONO } from './theme';

const useStyles = makeStyles({
  message: { fontFamily: MONO },
  loading: { display: 'flex', alignItems: 'center', gap: '8px' },
});

export interface ConfirmMergeDialogProps {
  /** The MR this confirms merging — only the fields the question needs to ask. */
  mr: Pick<MergeRequest, 'provider' | 'number' | 'targetBranch'>;
  /**
   * Read the commit message the forge would propose for this merge. Called once, on open;
   * a rejection leaves the field empty rather than failing the dialog itself.
   */
  loadProposal: () => Promise<MergeProposal>;
  /**
   * Perform the merge, passing the (possibly edited, possibly blank) proposed message.
   * Resolving closes the dialog; rejecting shows the message and keeps it open.
   */
  onConfirm: (message?: string) => Promise<unknown>;
  onClose: () => void;
}

export function ConfirmMergeDialog({
  mr,
  loadProposal,
  onConfirm,
  onClose,
}: ConfirmMergeDialogProps): React.JSX.Element {
  const styles = useStyles();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [proposal, setProposal] = useState<MergeProposal | null>(null);
  const [message, setMessage] = useState('');

  useEffect(() => {
    let live = true;
    setLoading(true);
    loadProposal()
      .then((p) => {
        if (!live) return;
        setProposal(p);
        setMessage(p.message ?? '');
      })
      .catch((e) => {
        if (!live) return;
        setLoadError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
    // Reads once, for the MR this dialog was opened for — callers key the dialog itself by
    // MR id, so a different row gets a fresh mount rather than this effect re-running.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function merge(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await onConfirm(message.trim() || undefined);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  // No merge commit, no message to propose — true for GitHub's `rebase` and GitLab's `ff`.
  const noCommitMessage = proposal !== null && proposal.message === null && !loadError;

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
            {loading ? (
              <div className={styles.loading}>
                <Spinner size="tiny" />
                <span>Reading the proposed commit message…</span>
              </div>
            ) : noCommitMessage ? (
              <MessageBar intent="info">
                <MessageBarBody>
                  This merge won't create a merge commit, so there's no message to propose.
                </MessageBarBody>
              </MessageBar>
            ) : (
              <>
                {loadError && (
                  <MessageBar intent="warning">
                    <MessageBarBody>
                      Couldn't read {forgeName(mr.provider)}'s proposed commit message — merging
                      will use its default unless you write one.
                    </MessageBarBody>
                  </MessageBar>
                )}
                <Textarea
                  className={styles.message}
                  value={message}
                  resize="vertical"
                  textarea={{ rows: 8 }}
                  onChange={(_e, d) => setMessage(d.value)}
                  placeholder="Commit message for this merge…"
                />
              </>
            )}
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" disabled={busy} onClick={onClose}>
              Cancel
            </Button>
            <Button
              appearance="primary"
              disabled={busy || loading}
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
