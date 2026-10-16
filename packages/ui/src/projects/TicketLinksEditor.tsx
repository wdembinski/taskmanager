/**
 * The documented relationships one ticket has to others — "blocks", "duplicates", … (Phase
 * 24). Reads through `linksFor()` (`@tm/shared/ticketLinks`) so this editor and the store's
 * own handler always phrase the same row identically from whichever end it names — see that
 * module's header for why it is pure and shared rather than reimplemented here.
 *
 * `TicketLinkAddRow` owns drawing a new link on its own — the type/ticket pickers, the busy
 * flag and the refusal message — so `TaskLinksSection` and a native ticket's empty Ticket
 * section (`TaskTicketSection`) can mount the same controls without going through this
 * drawer-only editor at all.
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
import { TICKET_LINK_TYPES } from '@tm/shared/tickets';
import { linksFor, TICKET_LINK_VOCABULARY } from '@tm/shared/ticketLinks';
import { columnBadge } from '../taskStatus';
import { useTransport } from '../transport';
import { linkAddRefusal } from './linkedTickets';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: '6px' },
  row: { display: 'flex', alignItems: 'center', gap: '6px', justifyContent: 'space-between' },
  rowLabel: { display: 'flex', alignItems: 'center', gap: '6px' },
  addRow: { display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' },
  hint: { color: tokens.colorNeutralForeground3 },
  picker: { minWidth: '130px' },
});

/** A candidate ticket has to name at least what the picker, `labelFor` and the row's own
 *  status badge (`columnForTask`) read. */
export type LinkCandidate = Pick<Task, 'id' | 'title' | 'ticketKey' | 'status' | 'preRunStatus'>;

export interface TicketLinksEditorProps {
  ticket: Pick<Task, 'id'>;
  /** Every other ticket this one could be linked to — this project's own backlog. */
  candidates: LinkCandidate[];
}

function labelFor(t: Pick<Task, 'title' | 'ticketKey'>): string {
  return t.ticketKey ? `${t.ticketKey} ${t.title}` : t.title;
}

export interface TicketLinkAddRowProps {
  ticket: Pick<Task, 'id'>;
  candidates: LinkCandidate[];
  disabled?: boolean;
}

/** Nothing to link this ticket to — every candidate is itself. */
export function TicketLinkAddRow({
  ticket,
  candidates,
  disabled = false,
}: TicketLinkAddRowProps): JSX.Element | null {
  const styles = useStyles();
  const transport = useTransport();
  const [type, setType] = useState<TicketLinkType>('blocks');
  const [otherId, setOtherId] = useState('');
  const [refusal, setRefusal] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const others = candidates.filter((c) => c.id !== ticket.id);

  async function add(): Promise<void> {
    if (!otherId) return;
    setBusy(true);
    setRefusal(null);
    try {
      const result = await transport.invoke('ticketLink:add', ticket.id, otherId, type);
      const message = linkAddRefusal(result);
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
      {refusal && (
        <MessageBar intent="warning">
          <MessageBarBody>{refusal}</MessageBarBody>
        </MessageBar>
      )}
      <div className={styles.addRow}>
        <Dropdown
          className={styles.picker}
          size="small"
          value={TICKET_LINK_VOCABULARY[type].outward}
          selectedOptions={[type]}
          disabled={disabled}
          onOptionSelect={(_e, d) => {
            if (d.optionValue) setType(d.optionValue as TicketLinkType);
          }}
        >
          {TICKET_LINK_TYPES.map((t) => (
            <Option key={t} value={t}>
              {TICKET_LINK_VOCABULARY[t].outward}
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
            if (d.optionValue) setOtherId(d.optionValue);
          }}
        >
          {others.map((c) => (
            <Option key={c.id} value={c.id} text={labelFor(c)}>
              {labelFor(c)}
            </Option>
          ))}
        </Dropdown>
        <Button size="small" disabled={disabled || busy || !otherId} onClick={() => void add()}>
          Add link
        </Button>
      </div>
    </div>
  );
}

export function TicketLinksEditor({ ticket, candidates }: TicketLinksEditorProps): JSX.Element {
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

  const views = linksFor(links, ticket.id);

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

      <TicketLinkAddRow ticket={ticket} candidates={candidates} disabled={busy} />
    </div>
  );
}
