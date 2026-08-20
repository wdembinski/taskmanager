/**
 * A project's milestones — dated goals its tickets are planned against (Phase 24), drawn on
 * the Gantt (step 7) whether or not any ticket points at one yet. Embedded in `TicketDrawer`
 * behind a "Manage milestones" popover, for the same reason `LabelRegistry` is there: the
 * drawer's milestone field is the one place this registry needs an edit surface.
 */
import { useState } from 'react';
import {
  Button,
  Caption1,
  Checkbox,
  Input,
  MessageBar,
  MessageBarBody,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { AddRegular, DeleteRegular } from '@fluentui/react-icons';
import type { Milestone } from '@tm/shared/model';
import { ColorSwatches } from '../ColorSwatches';
import { useTransport } from '../transport';
import { dateToInput, inputToDate } from './ticketFields';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: '8px', minWidth: '360px' },
  row: { display: 'flex', alignItems: 'center', gap: '6px' },
  name: { flex: 1, minWidth: 0 },
  date: { width: '150px', flexShrink: 0 },
  hint: { color: tokens.colorNeutralForeground3 },
});

export interface MilestoneListProps {
  projectId: string;
  milestones: Milestone[];
}

/** What a save may change — always resent alongside the milestone's other fields, since
 *  `MilestoneInput.name` is required on every `milestone:save` call, edit or create alike. */
type MilestonePatch = { name?: string; dueAt?: number | null; color?: string; closed?: boolean };

export function MilestoneList({ projectId, milestones }: MilestoneListProps): JSX.Element {
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
      await transport.invoke('milestone:save', projectId, { name });
      setDraftName('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function save(milestone: Milestone, patch: MilestonePatch): Promise<void> {
    setError(null);
    try {
      await transport.invoke('milestone:save', projectId, {
        id: milestone.id,
        name: milestone.name,
        description: milestone.description,
        dueAt: milestone.dueAt,
        color: milestone.color,
        closed: milestone.closed,
        ...patch,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function remove(milestone: Milestone): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await transport.invoke('milestone:remove', milestone.id);
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

      {milestones.length === 0 ? (
        <Caption1 className={styles.hint}>No milestones yet.</Caption1>
      ) : (
        milestones.map((milestone) => (
          <div key={milestone.id} className={styles.row}>
            <Input
              className={styles.name}
              size="small"
              defaultValue={milestone.name}
              aria-label="Milestone name"
              onBlur={(e) => {
                const name = e.target.value.trim();
                if (name && name !== milestone.name) void save(milestone, { name });
              }}
            />
            <Input
              className={styles.date}
              size="small"
              type="date"
              defaultValue={dateToInput(milestone.dueAt)}
              aria-label="Due date"
              onBlur={(e) => void save(milestone, { dueAt: inputToDate(e.target.value) })}
            />
            <ColorSwatches
              value={milestone.color}
              onChange={(color) => void save(milestone, { color })}
              allowNone
            />
            <Checkbox
              label="Closed"
              checked={milestone.closed}
              onChange={(_e, d) => void save(milestone, { closed: Boolean(d.checked) })}
            />
            <Button
              size="small"
              appearance="subtle"
              icon={<DeleteRegular />}
              disabled={busy}
              aria-label={`Delete ${milestone.name}`}
              title="Delete this milestone"
              onClick={() => void remove(milestone)}
            />
          </div>
        ))
      )}

      <div className={styles.row}>
        <Input
          className={styles.name}
          size="small"
          placeholder="New milestone"
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
