/**
 * The confirmation `archiveDialogModel` (`archiveDialog.ts`) says is needed: a milestone with
 * open tickets cannot be archived in one click, because archiving has to say what happens to
 * them. Asks exactly that — leave them in the Backlog (the default), move them onto another
 * milestone, or archive them along with their parent — then sends the chosen
 * `OpenTicketsChoice` through `useArchiveAction`, the same call every one-click archive button
 * uses.
 *
 * Opened by `MilestoneList` whenever its own one-click attempt comes back `choice-required` —
 * the model it read a moment earlier was already stale — as well as whenever it computes
 * `needsDialog` up front, so both paths land here rather than each inventing their own retry.
 *
 * Always mounted, `open` toggled by whether `milestone`/`model` are given — `GraphLinkPicker`'s
 * own shape for a dialog whose target is sometimes nothing, rather than an early return that
 * would have to invent fallback content just to satisfy `DialogSurface`'s required children.
 */
import { useEffect, useState } from 'react';
import {
  Button,
  Caption1,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Dropdown,
  MessageBar,
  MessageBarBody,
  Option,
  Radio,
  RadioGroup,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import type { Milestone } from '@tm/shared/model';
import type { OpenTicketsChoice } from '@tm/shared/trackerArchive';
import { archiveDialogTitle, type ArchiveDialogModel } from './archiveDialog';
import { useArchiveAction } from './useArchiveAction';

const useStyles = makeStyles({
  body: { display: 'flex', flexDirection: 'column', gap: '10px', minWidth: '380px' },
  keys: {
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
    fontFamily: 'ui-monospace, Consolas, monospace',
    color: tokens.colorNeutralForeground2,
  },
  more: { color: tokens.colorNeutralForeground3 },
  choices: { display: 'flex', flexDirection: 'column', gap: '6px' },
  choiceRow: { display: 'flex', flexDirection: 'column', gap: '4px', paddingLeft: '26px' },
  hint: { color: tokens.colorNeutralForeground3 },
});

type ChoiceKind = OpenTicketsChoice['kind'];

export interface ArchiveMilestoneDialogProps {
  /** `null` while there is nothing to confirm — the dialog renders closed either way, but a
   *  caller does not have to hold its own open/closed flag on top of these two. */
  milestone: Milestone | null;
  model: ArchiveDialogModel | null;
  onClose: () => void;
}

export function ArchiveMilestoneDialog({
  milestone,
  model,
  onClose,
}: ArchiveMilestoneDialogProps): JSX.Element {
  const styles = useStyles();
  const { archive } = useArchiveAction();
  const [choiceKind, setChoiceKind] = useState<ChoiceKind>('backlog');
  const [targetId, setTargetId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const milestoneId = milestone?.id ?? null;
  // Reseed on every open — a dialog reopened for a different milestone must not carry the
  // last one's choice, error or in-flight target id.
  useEffect(() => {
    setChoiceKind('backlog');
    setTargetId('');
    setError(null);
  }, [milestoneId]);

  const targets = model?.targets ?? [];
  const noTargets = targets.length === 0;

  async function archiveMilestone(): Promise<void> {
    if (!milestone) return;
    const choice: OpenTicketsChoice =
      choiceKind === 'milestone'
        ? { kind: 'milestone', milestoneId: targetId }
        : { kind: choiceKind };
    setBusy(true);
    setError(null);
    try {
      const result = await archive({ kind: 'milestone', id: milestone.id }, milestone.name, choice);
      if (!result.ok) {
        setError(result.message);
        return;
      }
      onClose();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={milestone !== null && model !== null}
      onOpenChange={(_e, d) => !d.open && onClose()}
    >
      <DialogSurface>
        <DialogBody>
          <DialogTitle>
            {milestone && model ? archiveDialogTitle(milestone, model) : ''}
          </DialogTitle>
          <DialogContent>
            <div className={styles.body}>
              {error && (
                <MessageBar intent="error">
                  <MessageBarBody>{error}</MessageBarBody>
                </MessageBar>
              )}

              <div className={styles.keys}>
                {(model?.sampleKeys ?? []).map((key) => (
                  <Caption1 key={key}>{key}</Caption1>
                ))}
                {model && model.moreCount > 0 && (
                  <Caption1 className={styles.more}>and {model.moreCount} more</Caption1>
                )}
              </div>

              <RadioGroup
                value={choiceKind}
                onChange={(_e, d) => setChoiceKind(d.value as ChoiceKind)}
              >
                <div className={styles.choices}>
                  <Radio value="backlog" label="Move them to the Backlog" />
                  <Radio
                    value="milestone"
                    disabled={noTargets}
                    label="Move them to another milestone"
                  />
                  {choiceKind === 'milestone' && !noTargets && (
                    <div className={styles.choiceRow}>
                      <Dropdown
                        placeholder="Choose a milestone"
                        value={targets.find((m) => m.id === targetId)?.name ?? ''}
                        selectedOptions={targetId ? [targetId] : []}
                        onOptionSelect={(_e, d) => {
                          if (d.optionValue !== undefined) setTargetId(d.optionValue);
                        }}
                      >
                        {targets.map((m) => (
                          <Option key={m.id} value={m.id} text={m.name}>
                            {m.name}
                          </Option>
                        ))}
                      </Dropdown>
                    </div>
                  )}
                  {noTargets && (
                    <div className={styles.choiceRow}>
                      <Caption1 className={styles.hint}>
                        No other open milestone in this project to move them to.
                      </Caption1>
                    </div>
                  )}
                  <Radio value="archive" label="Archive them too" />
                  {choiceKind === 'archive' && (
                    <div className={styles.choiceRow}>
                      <Caption1 className={styles.hint}>
                        Hides {(model?.archiveTooKeys ?? []).join(', ')}
                      </Caption1>
                    </div>
                  )}
                </div>
              </RadioGroup>
            </div>
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button
              appearance="primary"
              disabled={busy || (choiceKind === 'milestone' && !targetId)}
              onClick={() => void archiveMilestone()}
            >
              Archive
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
