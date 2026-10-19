/**
 * The documented relationships one ticket has to others — "blocks", "duplicates", … (Phase
 * 24). Reads through `linksFor()` (`@tm/shared/ticketLinks`) so this editor and the store's
 * own handler always phrase the same row identically from whichever end it names — see that
 * module's header for why it is pure and shared rather than reimplemented here.
 *
 * `TicketLinkAddRow` owns drawing a new link on its own — the type/ticket pickers, the busy
 * flag and the refusal message — so `TaskLinksSection` can mount the same controls without
 * going through this drawer-only editor at all.
 *
 * A dependency is an order ARROW, never a `blocks` ticket link: the picker's "blocks" and
 * "is blocked by" draw one through `chain:link` (the engine's own handler, gate
 * `after-merge`), and every other type stays a plain ticket link through `ticketLink:add`.
 * `canLink` is asked first so a loop or a step is refused while the human is still picking,
 * in the same words the handler would refuse it in — the handler's answer still decides.
 */
import { useEffect, useState } from 'react';
import {
  Badge,
  Body1,
  Button,
  Caption1,
  Dropdown,
  MessageBar,
  MessageBarBody,
  Option,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { DeleteRegular } from '@fluentui/react-icons';
import { columnForTask } from '@tm/shared/board';
import type { Task, TicketLink, TicketLinkType } from '@tm/shared/model';
import { canLink, LINK_REFUSAL_MESSAGE, type TaskLink } from '@tm/shared/taskChain';
import { TICKET_LINK_TYPES } from '@tm/shared/tickets';
import { linksFor, TICKET_LINK_VOCABULARY } from '@tm/shared/ticketLinks';
import { columnBadge } from '../taskStatus';
import { useTransport } from '../transport';
import { arrowAddRefusal, linkAddRefusal } from './linkedTickets';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: '6px' },
  row: { display: 'flex', alignItems: 'center', gap: '6px', justifyContent: 'space-between' },
  rowLabel: { display: 'flex', alignItems: 'center', gap: '6px' },
  addRow: { display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' },
  hint: { color: tokens.colorNeutralForeground3 },
  picker: { minWidth: '130px' },
});

/** A candidate ticket has to name at least what the picker, `labelFor`, the row's own
 *  status badge (`columnForTask`) and the live `canLink` check (`parentTaskId`) read. */
export type LinkCandidate = Pick<
  Task,
  'id' | 'title' | 'ticketKey' | 'status' | 'preRunStatus' | 'parentTaskId'
>;

export interface TicketLinksEditorProps {
  ticket: Pick<Task, 'id' | 'parentTaskId'>;
  /** Every other ticket this one could be linked to — this project's own backlog. */
  candidates: LinkCandidate[];
  /** Every order arrow on the board — what the add row checks a new one against. */
  chainLinks?: readonly TaskLink[];
}

function labelFor(t: Pick<Task, 'title' | 'ticketKey'>): string {
  return t.ticketKey ? `${t.ticketKey} ${t.title}` : t.title;
}

/**
 * What the add row's type picker can draw: an order arrow either way round, or a ticket
 * link of any type but `blocks` (a dependency is an arrow, never a ticket link).
 */
export type AddLinkKind = 'blocks' | 'is-blocked-by' | Exclude<TicketLinkType, 'blocks'>;

export const ADD_LINK_KINDS: readonly AddLinkKind[] = [
  'blocks',
  'is-blocked-by',
  ...TICKET_LINK_TYPES.filter((t): t is Exclude<TicketLinkType, 'blocks'> => t !== 'blocks'),
];

/** What the type picker shows for `kind`. */
export function addLinkKindLabel(kind: AddLinkKind): string {
  if (kind === 'blocks') return TICKET_LINK_VOCABULARY.blocks.outward;
  if (kind === 'is-blocked-by') return TICKET_LINK_VOCABULARY.blocks.inward;
  return TICKET_LINK_VOCABULARY[kind].outward;
}

/** An arrow kind as `[from, to]` — "is blocked by" swaps the ends. `null` for a ticket link. */
function arrowEnds(kind: AddLinkKind, self: string, other: string): [string, string] | null {
  if (kind === 'blocks') return [self, other];
  if (kind === 'is-blocked-by') return [other, self];
  return null;
}

export interface TicketLinkAddRowProps {
  ticket: Pick<Task, 'id' | 'parentTaskId'>;
  candidates: LinkCandidate[];
  /** Every order arrow on the board — what a new "blocks" is checked against. */
  chainLinks?: readonly TaskLink[];
  disabled?: boolean;
}

/** Nothing to link this ticket to — every candidate is itself. */
export function TicketLinkAddRow({
  ticket,
  candidates,
  chainLinks = [],
  disabled = false,
}: TicketLinkAddRowProps): JSX.Element | null {
  const styles = useStyles();
  const transport = useTransport();
  const [kind, setKind] = useState<AddLinkKind>('blocks');
  const [otherId, setOtherId] = useState('');
  const [refusal, setRefusal] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const others = candidates.filter((c) => c.id !== ticket.id);

  // The handler's own check, asked early: a loop or a step reads as refused while the human
  // is still picking, rather than only after the click.
  const ends = otherId ? arrowEnds(kind, ticket.id, otherId) : null;
  const endFor = (id: string) => (id === ticket.id ? ticket : others.find((c) => c.id === id));
  const liveRefusal = ends ? canLink(chainLinks, endFor(ends[0]), endFor(ends[1])) : null;
  const shownRefusal = refusal ?? (liveRefusal ? LINK_REFUSAL_MESSAGE[liveRefusal] : null);

  async function add(): Promise<void> {
    if (!otherId) return;
    setBusy(true);
    setRefusal(null);
    try {
      let message: string | null;
      if (kind === 'blocks' || kind === 'is-blocked-by') {
        const [from, to] = kind === 'blocks' ? [ticket.id, otherId] : [otherId, ticket.id];
        message = arrowAddRefusal(await transport.invoke('chain:link', from, to, 'after-merge'));
      } else {
        message = linkAddRefusal(
          await transport.invoke('ticketLink:add', ticket.id, otherId, kind),
        );
      }
      if (message) {
        setRefusal(message);
      } else {
        setOtherId('');
      }
    } finally {
      setBusy(false);
    }
  }

  if (others.length === 0) return null;

  return (
    <div className={styles.root}>
      {shownRefusal && (
        <MessageBar intent="warning">
          <MessageBarBody>{shownRefusal}</MessageBarBody>
        </MessageBar>
      )}
      <div className={styles.addRow}>
        <Dropdown
          className={styles.picker}
          size="small"
          value={addLinkKindLabel(kind)}
          selectedOptions={[kind]}
          disabled={disabled}
          onOptionSelect={(_e, d) => {
            if (d.optionValue) {
              setKind(d.optionValue as AddLinkKind);
              setRefusal(null);
            }
          }}
        >
          {ADD_LINK_KINDS.map((k) => (
            <Option key={k} value={k}>
              {addLinkKindLabel(k)}
            </Option>
          ))}
        </Dropdown>
        <Dropdown
          className={styles.picker}
          size="small"
          placeholder="Ticket…"
          value={otherId ? labelFor(others.find((c) => c.id === otherId)!) : ''}
          selectedOptions={otherId ? [otherId] : []}
          disabled={disabled}
          onOptionSelect={(_e, d) => {
            if (d.optionValue) {
              setOtherId(d.optionValue);
              setRefusal(null);
            }
          }}
        >
          {others.map((c) => (
            <Option key={c.id} value={c.id} text={labelFor(c)}>
              {labelFor(c)}
            </Option>
          ))}
        </Dropdown>
        <Button
          size="small"
          disabled={disabled || busy || !otherId || liveRefusal !== null}
          onClick={() => void add()}
        >
          Add link
        </Button>
      </div>
    </div>
  );
}

export function TicketLinksEditor({
  ticket,
  candidates,
  chainLinks,
}: TicketLinksEditorProps): JSX.Element {
  const styles = useStyles();
  const transport = useTransport();
  const [links, setLinks] = useState<TicketLink[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    void transport.invoke('ticketLink:list').then((all) => {
      if (live) setLinks(all);
    });
    const off = transport.on('ticketLink:changed', setLinks);
    return () => {
      live = false;
      off();
    };
  }, [transport]);

  // A leftover `blocks` ticket link decides nothing — the arrows are the dependencies.
  const views = linksFor(
    links.filter((l) => l.type !== 'blocks'),
    ticket.id,
  );

  async function remove(id: string): Promise<void> {
    setBusy(true);
    try {
      await transport.invoke('ticketLink:remove', id);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={styles.root}>
      {views.length === 0 ? (
        <Caption1 className={styles.hint}>No linked tickets.</Caption1>
      ) : (
        views.map((view) => {
          const other = candidates.find((c) => c.id === view.otherTaskId);
          const badge = other ? columnBadge(columnForTask(other)) : null;
          return (
            <div key={view.link.id} className={styles.row}>
              <div className={styles.rowLabel}>
                <Body1>
                  {view.phrase} {other ? labelFor(other) : view.otherTaskId}
                </Body1>
                {badge && (
                  <Badge appearance="tint" size="small" color={badge.color}>
                    {badge.label}
                  </Badge>
                )}
              </div>
              <Button
                size="small"
                appearance="subtle"
                icon={<DeleteRegular />}
                disabled={busy}
                aria-label="Remove this link"
                title="Remove this link"
                onClick={() => void remove(view.link.id)}
              />
            </div>
          );
        })
      )}

      <TicketLinkAddRow
        ticket={ticket}
        candidates={candidates}
        chainLinks={chainLinks}
        disabled={busy}
      />
    </div>
  );
}
