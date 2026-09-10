/**
 * GraphLinkPicker — the dialog a React Flow `onConnect` gesture opens in the graph view.
 *
 * A drag between two nodes only says a relationship is wanted, not WHICH one — unlike the
 * timeline's connect knob, a React Flow canvas gives no ctrl-drag equivalent mid-gesture, so
 * the choice moves to a small dialog asked for explicitly instead of inferred from a modifier
 * key: a `blocks` dependency (`ticketLink:add`) or an execution chain (`chain:link`, with its
 * own gate choice). `canLinkTickets`/`canLink` run the same checks the store's own handlers
 * will, against the lists `GraphPane` already holds, so a refusal it already knows about reads
 * inline without a round trip — `TimelinePane`'s own `commitConnect` doc gives the same
 * reasoning for the same no-round-trip check.
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

type LinkKind = 'blocks' | 'chain';

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
});

export interface GraphLinkPickerProps {
  /** The pending connect gesture — `null` means the dialog is closed. */
  connection: { from: Task; to: Task } | null;
  /** This project's own ticket links, for the local `canLinkTickets` precheck. */
  links: TicketLink[];
  /** This project's own chain links, for the local `canLink` precheck. */
  chainLinks: TaskLink[];
  onClose: () => void;
}

export function GraphLinkPicker({
  connection,
  links,
  chainLinks,
  onClose,
}: GraphLinkPickerProps): JSX.Element {
  const styles = useStyles();
  const transport = useTransport();
  const [kind, setKind] = useState<LinkKind>('blocks');
  const [gate, setGate] = useState<LinkGate>('after-merge');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fromId = connection?.from.id ?? null;
  const toId = connection?.to.id ?? null;

  // Reseed on every open — a dialog reopened for a different pair must not carry the last
  // one's kind/gate/error, `NewTicketDialog`'s own open effect.
  useEffect(() => {
    setKind('blocks');
    setGate('after-merge');
    setError(null);
  }, [fromId, toId]);

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

  const fromLabel = connection ? (connection.from.ticketKey ?? connection.from.title) : '';
  const toLabel = connection ? (connection.to.ticketKey ?? connection.to.title) : '';

  return (
    <Dialog open={connection !== null} onOpenChange={(_e, d) => !d.open && onClose()}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>
            {connection ? `Link ${fromLabel} → ${toLabel}` : 'Link tickets'}
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
            <Button appearance="secondary" onClick={onClose} disabled={saving}>
              Cancel
            </Button>
            <Button appearance="primary" onClick={() => void create()} disabled={saving}>
              Create link
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
