/**
 * GraphLinkPicker — the dialog a React Flow `onConnect` gesture opens in the graph view, and
 * (in edit mode) the one an `onEdgeClick` on an existing edge reopens over it.
 *
 * A drag between two nodes only says a relationship is wanted, not WHICH one — unlike the
 * timeline's connect knob, a React Flow canvas gives no ctrl-drag equivalent mid-gesture, so
 * the choice moves to a small dialog asked for explicitly instead of inferred from a modifier
 * key: a `blocks` dependency (`ticketLink:add`) or an execution chain (`chain:link`, with its
 * own gate choice). `canLinkTickets`/`canLink` run the same checks the store's own handlers
 * will, against the lists `GraphPane` already holds, so a refusal it already knows about reads
 * inline without a round trip — `TimelinePane`'s own `commitConnect` doc gives the same
 * reasoning for the same no-round-trip check.
 *
 * **Editing.** `connection` (create) and `editingLink` (edit) are mutually exclusive —
 * `GraphPane` never sets both. Edit mode seeds `kind`/`gate` from the clicked edge rather
 * than always starting at `blocks`/`after-merge`. Saving with the SAME kind only ever means a
 * chain edge's gate changed (`chain:setGate` — nothing to switch, `blocks` has no gate at
 * all); saving with the OTHER kind is a remove-then-add across the two id spaces
 * (`ticketLink:remove` + `chain:link`, or `chain:unlink` + `ticketLink:add`), gated by the
 * same `canLinkTickets`/`canLink` pre-checks `create` below already runs, so a refusal reads
 * inline here too. The remove half is delegated to `GraphPane`'s own
 * `removeTicketLink`/`removeChainLink` (`onDeleteTicketLink`/`onDeleteChainLink`) — the same
 * functions the Delete key already drives — so its failure surfaces through the pane's
 * `deleteError` `MessageBar` exactly as a Delete-key removal would, rather than this dialog's
 * own inline `error` (reserved for the pre-checks and the add/link half).
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
  MessageBar,
  MessageBarBody,
  Text,
  makeStyles,
  mergeClasses,
  tokens,
} from '@fluentui/react-components';
import { DeleteRegular } from '@fluentui/react-icons';
import type { Task, TicketLink } from '@tm/shared/model';
import {
  canLink,
  LINK_GATES,
  LINK_GATE_HELP,
  LINK_GATE_TITLE,
  LINK_REFUSAL_MESSAGE,
  type LinkGate,
  type TaskLink,
} from '@tm/shared/taskChain';
import { canLinkTickets, TICKET_LINK_REFUSAL_MESSAGE } from '@tm/shared/ticketLinks';
import { useTransport } from '../transport';

export type LinkKind = 'blocks' | 'chain';

/** An existing edge clicked for editing. `gate` is only meaningful for `kind === 'chain'` —
 *  it seeds the gate row so reopening the dialog on a `stacked` edge doesn't show
 *  `after-merge` selected. */
export interface EditingGraphLink {
  id: string;
  kind: LinkKind;
  gate?: LinkGate;
  from: Task;
  to: Task;
}

const useStyles = makeStyles({
  body: { display: 'flex', flexDirection: 'column', gap: '10px', minWidth: '380px' },
  kindRow: { display: 'flex', flexDirection: 'column', gap: '6px' },
  gateRow: {
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
    paddingLeft: '10px',
    borderLeft: `2px solid ${tokens.colorNeutralStroke2}`,
  },
  /** One choice. A button, not a radio: the whole row (title + help line) is the target —
   *  `ChainLinkPopover.choice`'s own shape, reused here for the dialog. */
  choice: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-start',
    gap: '1px',
    textAlign: 'left',
    padding: '8px 10px',
    borderRadius: tokens.borderRadiusSmall,
    border: '1px solid transparent',
    backgroundColor: 'transparent',
    cursor: 'pointer',
    ':hover': { backgroundColor: tokens.colorNeutralBackground1Hover },
  },
  chosen: {
    backgroundColor: tokens.colorNeutralBackground1Selected,
    border: `1px solid ${tokens.colorBrandStroke1}`,
  },
  help: { color: tokens.colorNeutralForeground3 },
  // Pushed left by its own auto margin in the `DialogActions` flex row, so Cancel/Save stay
  // together on the right — the standard flexbox "push" trick, which wins over the row's own
  // `justify-content` for the item that carries the margin.
  deleteAction: { marginRight: 'auto' },
});

export interface GraphLinkPickerProps {
  /** The pending connect gesture — `null` means nothing is being created. Mutually exclusive
   *  with `editingLink`. */
  connection: { from: Task; to: Task } | null;
  /** The edge an `onEdgeClick` just resolved — `null` means nothing is being edited. Mutually
   *  exclusive with `connection`. */
  editingLink: EditingGraphLink | null;
  /** This project's own ticket links, for the local `canLinkTickets` precheck. */
  links: TicketLink[];
  /** This project's own chain links, for the local `canLink` precheck. */
  chainLinks: TaskLink[];
  onClose: () => void;
  /** `GraphPane.removeTicketLink` — the remove half of a `chain` → `blocks` switch, and what
   *  "Delete link" calls when the edited edge is a `blocks` dependency. */
  onDeleteTicketLink: (linkId: string) => Promise<void>;
  /** `GraphPane.removeChainLink` — the remove half of a `blocks` → `chain` switch, and what
   *  "Delete link" calls when the edited edge is a chain link. */
  onDeleteChainLink: (linkId: string) => Promise<void>;
}

export function GraphLinkPicker({
  connection,
  editingLink,
  links,
  chainLinks,
  onClose,
  onDeleteTicketLink,
  onDeleteChainLink,
}: GraphLinkPickerProps): JSX.Element {
  const styles = useStyles();
  const transport = useTransport();
  const [kind, setKind] = useState<LinkKind>('blocks');
  const [gate, setGate] = useState<LinkGate>('after-merge');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pair = connection ?? editingLink;
  const fromId = pair?.from.id ?? null;
  const toId = pair?.to.id ?? null;

  // Reseed on every open — a dialog reopened for a different pair (or a different edge, in
  // edit mode) must not carry the last one's kind/gate/error, `NewTicketDialog`'s own open
  // effect. Edit mode seeds from the clicked edge instead of always `blocks`/`after-merge`.
  useEffect(() => {
    setKind(editingLink?.kind ?? 'blocks');
    setGate(editingLink?.gate ?? 'after-merge');
    setError(null);
  }, [fromId, toId, editingLink]);

  /** "Delete link" in edit mode — the edited edge's OWN kind, never whatever `kind` the
   *  toggle above currently shows (that's the switch target, not what exists on screen). */
  async function deleteEditingLink(): Promise<void> {
    if (!editingLink) return;
    setSaving(true);
    try {
      if (editingLink.kind === 'blocks') await onDeleteTicketLink(editingLink.id);
      else await onDeleteChainLink(editingLink.id);
      onClose();
    } finally {
      setSaving(false);
    }
  }

  /**
   * "Save changes" in edit mode. Same kind as the edge already has: nothing to switch, so the
   * only possible change is a chain edge's gate (`chain:setGate` — `blocks` has no gate to
   * change). A different kind: the same `canLinkTickets`/`canLink` precheck `create` runs
   * below, then remove the old edge (through `GraphPane`'s own delete, so a failure there
   * reads from `deleteError` the same as a Delete-key removal) and add the new one (whose own
   * refusal, if the precheck missed a race, reads inline here).
   */
  async function saveEdit(): Promise<void> {
    if (!editingLink) return;
    setSaving(true);
    setError(null);
    try {
      if (kind === editingLink.kind) {
        if (kind === 'chain' && gate !== editingLink.gate) {
          await transport.invoke('chain:setGate', editingLink.id, gate);
        }
        onClose();
        return;
      }
      if (kind === 'chain') {
        const refusal = canLink(chainLinks, editingLink.from, editingLink.to);
        if (refusal) {
          setError(LINK_REFUSAL_MESSAGE[refusal]);
          return;
        }
        await onDeleteTicketLink(editingLink.id);
        const result = await transport.invoke(
          'chain:link',
          editingLink.from.id,
          editingLink.to.id,
          gate,
        );
        if (result.status === 'refused') {
          setError(LINK_REFUSAL_MESSAGE[result.reason]);
          return;
        }
      } else {
        const refusal = canLinkTickets(links, editingLink.from, editingLink.to, 'blocks');
        if (refusal) {
          setError(TICKET_LINK_REFUSAL_MESSAGE[refusal]);
          return;
        }
        await onDeleteChainLink(editingLink.id);
        const result = await transport.invoke(
          'ticketLink:add',
          editingLink.from.id,
          editingLink.to.id,
          'blocks',
        );
        if (result.status === 'refused') {
          setError(TICKET_LINK_REFUSAL_MESSAGE[result.reason]);
          return;
        }
      }
      onClose();
    } finally {
      setSaving(false);
    }
  }

  async function create(): Promise<void> {
    if (!connection) return;
    setSaving(true);
    setError(null);
    try {
      if (kind === 'blocks') {
        const refusal = canLinkTickets(links, connection.from, connection.to, 'blocks');
        if (refusal) {
          setError(TICKET_LINK_REFUSAL_MESSAGE[refusal]);
          return;
        }
        const result = await transport.invoke(
          'ticketLink:add',
          connection.from.id,
          connection.to.id,
          'blocks',
        );
        if (result.status === 'refused') {
          setError(TICKET_LINK_REFUSAL_MESSAGE[result.reason]);
          return;
        }
      } else {
        const refusal = canLink(chainLinks, connection.from, connection.to);
        if (refusal) {
          setError(LINK_REFUSAL_MESSAGE[refusal]);
          return;
        }
        const result = await transport.invoke(
          'chain:link',
          connection.from.id,
          connection.to.id,
          gate,
        );
        if (result.status === 'refused') {
          setError(LINK_REFUSAL_MESSAGE[result.reason]);
          return;
        }
      }
      onClose();
    } finally {
      setSaving(false);
    }
  }

  const fromLabel = pair ? (pair.from.ticketKey ?? pair.from.title) : '';
  const toLabel = pair ? (pair.to.ticketKey ?? pair.to.title) : '';

  return (
    <Dialog
      open={connection !== null || editingLink !== null}
      onOpenChange={(_e, d) => !d.open && onClose()}
    >
      <DialogSurface>
        <DialogBody>
          <DialogTitle>
            {editingLink
              ? `Edit ${fromLabel} → ${toLabel}`
              : connection
                ? `Link ${fromLabel} → ${toLabel}`
                : 'Link tickets'}
          </DialogTitle>
          <DialogContent>
            <div className={styles.body}>
              {error && (
                <MessageBar intent="error">
                  <MessageBarBody>{error}</MessageBarBody>
                </MessageBar>
              )}
              <div className={styles.kindRow}>
                <button
                  type="button"
                  className={mergeClasses(styles.choice, kind === 'blocks' && styles.chosen)}
                  aria-pressed={kind === 'blocks'}
                  onClick={() => setKind('blocks')}
                >
                  <Text weight="semibold" size={200}>
                    Blocks dependency
                  </Text>
                  <Caption1 className={styles.help}>
                    A documented relationship only — {toLabel || 'the ticket'} is blocked by{' '}
                    {fromLabel || 'the other ticket'}. Nothing about either ticket's own schedule
                    changes.
                  </Caption1>
                </button>
                <button
                  type="button"
                  className={mergeClasses(styles.choice, kind === 'chain' && styles.chosen)}
                  aria-pressed={kind === 'chain'}
                  onClick={() => setKind('chain')}
                >
                  <Text weight="semibold" size={200}>
                    Execution chain
                  </Text>
                  <Caption1 className={styles.help}>
                    {toLabel || 'The ticket'} will not start work until{' '}
                    {fromLabel || 'the other ticket'}
                    's own gate below is met.
                  </Caption1>
                </button>
              </div>

              {kind === 'chain' && (
                <div className={styles.gateRow}>
                  {LINK_GATES.map((g) => (
                    <button
                      key={g}
                      type="button"
                      className={mergeClasses(styles.choice, g === gate && styles.chosen)}
                      aria-pressed={g === gate}
                      onClick={() => setGate(g)}
                    >
                      <Text weight="semibold" size={200}>
                        {LINK_GATE_TITLE[g]}
                      </Text>
                      <Caption1 className={styles.help}>{LINK_GATE_HELP[g]}</Caption1>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </DialogContent>
          <DialogActions>
            {editingLink && (
              <Button
                className={styles.deleteAction}
                appearance="subtle"
                icon={<DeleteRegular />}
                onClick={() => void deleteEditingLink()}
                disabled={saving}
              >
                Delete link
              </Button>
            )}
            <Button appearance="secondary" onClick={onClose} disabled={saving}>
              Cancel
            </Button>
            <Button
              appearance="primary"
              onClick={() => void (editingLink ? saveEdit() : create())}
              disabled={saving}
            >
              {editingLink ? 'Save changes' : 'Create link'}
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
