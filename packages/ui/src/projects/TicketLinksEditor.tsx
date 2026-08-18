/**
 * The documented relationships one ticket has to others — "blocks", "duplicates", … (Phase
 * 24). Reads through `linksFor()` (`@tm/shared/ticketLinks`) so this editor and the store's
 * own handler always phrase the same row identically from whichever end it names — see that
 * module's header for why it is pure and shared rather than reimplemented here.
 *
 * A refusal from `ticketLink:add` — the two are already linked that way, or a link to itself
 * — comes back as DATA (`TicketLinkResult`), not a thrown rejection, and is shown as a
 * message rather than swallowed as an error.
 */
import { useEffect, useState } from 'react';
import {
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
import type { Task, TicketLink, TicketLinkType } from '@tm/shared/model';
import { TICKET_LINK_TYPES } from '@tm/shared/tickets';
import {
  linksFor,
  TICKET_LINK_REFUSAL_MESSAGE,
  TICKET_LINK_VOCABULARY,
} from '@tm/shared/ticketLinks';
import { useTransport } from '../transport';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: '6px' },
  row: { display: 'flex', alignItems: 'center', gap: '6px', justifyContent: 'space-between' },
  addRow: { display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' },
  hint: { color: tokens.colorNeutralForeground3 },
  picker: { minWidth: '130px' },
});

/** A candidate ticket has to name at least what the picker and `labelFor` read. */
type LinkCandidate = Pick<Task, 'id' | 'title' | 'ticketKey'>;

export interface TicketLinksEditorProps {
  ticket: Pick<Task, 'id'>;
  /** Every other ticket this one could be linked to — this project's own backlog. */
  candidates: LinkCandidate[];
}

function labelFor(t: Pick<Task, 'title' | 'ticketKey'>): string {
  return t.ticketKey ? `${t.ticketKey} ${t.title}` : t.title;
}

export function TicketLinksEditor({ ticket, candidates }: TicketLinksEditorProps): JSX.Element {
  const styles = useStyles();
  const transport = useTransport();
  const [links, setLinks] = useState<TicketLink[]>([]);
  const [type, setType] = useState<TicketLinkType>('blocks');
  const [otherId, setOtherId] = useState('');
  const [refusal, setRefusal] = useState<string | null>(null);
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
  const others = candidates.filter((c) => c.id !== ticket.id);

  async function add(): Promise<void> {
    if (!otherId) return;
    setBusy(true);
    setRefusal(null);
    try {
      const result = await transport.invoke('ticketLink:add', ticket.id, otherId, type);
      if (result.status === 'refused') {
        setRefusal(TICKET_LINK_REFUSAL_MESSAGE[result.reason]);
      } else {
        setOtherId('');
      }
    } finally {
      setBusy(false);
    }
  }

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
      {refusal && (
        <MessageBar intent="warning">
          <MessageBarBody>{refusal}</MessageBarBody>
        </MessageBar>
      )}

      {views.length === 0 ? (
        <Caption1 className={styles.hint}>No linked tickets.</Caption1>
      ) : (
        views.map((view) => {
          const other = candidates.find((c) => c.id === view.otherTaskId);
          return (
            <div key={view.link.id} className={styles.row}>
              <Body1>
                {view.phrase} {other ? labelFor(other) : view.otherTaskId}
              </Body1>
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

      {others.length > 0 && (
        <div className={styles.addRow}>
          <Dropdown
            className={styles.picker}
            size="small"
            value={TICKET_LINK_VOCABULARY[type].outward}
            selectedOptions={[type]}
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
          <Button size="small" disabled={busy || !otherId} onClick={() => void add()}>
            Add link
          </Button>
        </div>
      )}
    </div>
  );
}
