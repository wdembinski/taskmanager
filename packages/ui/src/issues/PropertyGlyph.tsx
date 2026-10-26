/**
 * The icon before a property's value — Status, Assignee and Milestone only, as the v9 mockups
 * draw them; every other row gets none. Shared by the full page's `IssueProperties` and the
 * peek's `IssuePeekBody`, so the two can never draw a row's glyph differently.
 */
import { makeStyles, tokens } from '@fluentui/react-components';
import { FlagRegular, PersonRegular } from '@fluentui/react-icons';
import { columnForTask } from '@tm/shared/board';
import type { Person, Task } from '@tm/shared/model';
import { AgentGlyph } from '../AgentGlyph';
import { PersonAvatar } from '../projects/PersonAvatar';
import type { PropertyKey } from './issuePropertyRows';
import { STATUS_GLYPH } from './IssueRow';

const useStyles = makeStyles({
  icon: {
    display: 'inline-flex',
    alignItems: 'center',
    height: tokens.lineHeightBase300,
    flexShrink: 0,
    fontSize: '16px',
    color: `var(--tm-text-muted, ${tokens.colorNeutralForeground3})`,
  },
});

export interface PropertyGlyphProps {
  /** The row the glyph belongs to — only `status`, `assignee` and `milestone` draw one. */
  rowKey: PropertyKey;
  task: Task;
  /** App-wide roster — the assignee's avatar. */
  people: readonly Person[];
  /** The delegated agent's name, when the card is delegated — the assignee reads as the agent. */
  agentName?: string;
}

export function PropertyGlyph({
  rowKey,
  task,
  people,
  agentName,
}: PropertyGlyphProps): JSX.Element | null {
  const styles = useStyles();
  if (rowKey === 'status') {
    const column = columnForTask(task);
    return (
      <span className={styles.icon} data-property-icon={`status-${column}`}>
        {STATUS_GLYPH[column]}
      </span>
    );
  }
  if (rowKey === 'assignee') {
    // A delegated card reads as the agent's; a person alone shows their avatar.
    const person = people.find((p) => p.id === task.assigneeId);
    return (
      <span
        className={styles.icon}
        data-property-icon={agentName ? 'agent' : person ? 'person' : 'unassigned'}
      >
        {agentName ? (
          <AgentGlyph />
        ) : person ? (
          <PersonAvatar person={person} size={16} />
        ) : (
          <PersonRegular />
        )}
      </span>
    );
  }
  if (rowKey === 'milestone') {
    return (
      <span className={styles.icon} data-property-icon="milestone">
        <FlagRegular />
      </span>
    );
  }
  return null;
}
