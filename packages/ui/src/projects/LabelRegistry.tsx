/**
 * A project's label registry — what gives a ticket's chip its colour and the label picker
 * its list (Phase 24). Embedded in `TicketDrawer` behind a "Manage labels" popover rather
 * than living as its own section of the Projects screen: the drawer's label field is the one
 * place this registry needs an edit surface, and a rename or recolour here is felt on every
 * ticket wearing the label — `label:save`'s `id` present edits in place, same as
 * `ticketProject:update`.
 */
import { useState } from 'react';
import {
  Button,
  Caption1,
  Input,
  MessageBar,
  MessageBarBody,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { AddRegular, DeleteRegular } from '@fluentui/react-icons';
import type { TicketLabel } from '@tm/shared/model';
import { ColorSwatches } from '../ColorSwatches';
import { useTransport } from '../transport';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: '8px', minWidth: '300px' },
  row: { display: 'flex', alignItems: 'center', gap: '6px' },
  name: { flex: 1, minWidth: 0 },
  hint: { color: tokens.colorNeutralForeground3 },
});

export interface LabelRegistryProps {
  projectId: string;
  labels: TicketLabel[];
}

export function LabelRegistry({ projectId, labels }: LabelRegistryProps): JSX.Element {
  const styles = useStyles();
  const transport = useTransport();
  const [draftName, setDraftName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function add(): Promise<void> {
    const name = draftName.trim();
    if (!name) return;
    setBusy(true);
    setError(null);
    try {
      await transport.invoke('label:save', projectId, { name });
      setDraftName('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function save(label: TicketLabel, patch: { name?: string; color?: string }): Promise<void> {
    setError(null);
    try {
      await transport.invoke('label:save', projectId, {
        id: label.id,
        name: label.name,
        color: label.color,
        ...patch,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function remove(label: TicketLabel): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await transport.invoke('label:remove', label.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={styles.root}>
      {error && (
        <MessageBar intent="error">
          <MessageBarBody>{error}</MessageBarBody>
        </MessageBar>
      )}

      {labels.length === 0 ? (
        <Caption1 className={styles.hint}>No labels yet.</Caption1>
      ) : (
        labels.map((label) => (
          <div key={label.id} className={styles.row}>
            <Input
              className={styles.name}
              size="small"
              defaultValue={label.name}
              aria-label="Label name"
              onBlur={(e) => {
                const name = e.target.value.trim();
                if (name && name !== label.name) void save(label, { name });
              }}
            />
            <ColorSwatches
              value={label.color}
              onChange={(color) => void save(label, { color })}
              allowNone
            />
            <Button
              size="small"
              appearance="subtle"
              icon={<DeleteRegular />}
              disabled={busy}
              aria-label={`Delete ${label.name}`}
              title="Delete this label"
              onClick={() => void remove(label)}
            />
          </div>
        ))
      )}

      <div className={styles.row}>
        <Input
          className={styles.name}
          size="small"
          placeholder="New label"
          value={draftName}
          onChange={(_e, d) => setDraftName(d.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void add();
          }}
        />
        <Button
          size="small"
          icon={<AddRegular />}
          disabled={busy || !draftName.trim()}
          onClick={() => void add()}
        >
          Add
        </Button>
      </div>
    </div>
  );
}
