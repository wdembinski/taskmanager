/**
 * The "Assigned to" field, drawn the same way everywhere it appears — the board card's
 * corner, the ticket drawer, the backlog table and the timeline. A native ticket can be
 * assigned to a human, delegated to an agent, both, or neither, and this is the one place
 * that decides what each combination looks like, so no surface reinvents the separator
 * between them.
 *
 * Purely presentational: callers resolve the assignee and the agent's name themselves and
 * pass the results in. Whether an agent name is even meaningful for a given ticket — today,
 * only a native ticket's own delegation counts — is a decision the caller makes before
 * reaching for this; this component draws whatever it is given.
 *
 * "Neither" is not this component's problem: it renders nothing, and the surfaces that
 * already have their own empty/"Unassigned" treatment (`BacklogTable`'s muted caption, a
 * card that shows nothing at all) keep drawing that themselves.
 */
import { Text, makeStyles, tokens } from '@fluentui/react-components';
import { AgentsRegular } from '@fluentui/react-icons';
import type { Person } from '@tm/shared/model';
import { PersonAvatar } from './PersonAvatar';

const useStyles = makeStyles({
  row: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '4px',
    minWidth: 0,
  },
  agentIcon: {
    display: 'flex',
    alignItems: 'center',
    flexShrink: 0,
    // Same treatment as `PriorityGlyph`'s mono chevrons: a static fact about the ticket, not
    // the animated `AgentGlyph` pulse that means "a run is in progress right now".
    color: tokens.colorNeutralForeground2,
  },
  sep: {
    flexShrink: 0,
    color: tokens.colorNeutralForeground3,
  },
  name: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
});

export type AssigneeDisplayVariant = 'compact' | 'text';

export interface AssigneeDisplayProps {
  /** The ticket's human assignee, already resolved from an id to a person. */
  assignee?: Pick<Person, 'name' | 'initials' | 'color'>;
  /**
   * The agent delegated to work the ticket, by name (an agent project's name, today). Pass
   * this only where an agent assignment actually means something for the ticket — deciding
   * that is the caller's job, not this component's.
   */
  agentName?: string;
  /**
   * `'compact'` draws the human as an avatar alone, the way a card's corner always has —
   * `'text'` adds their name beside it, for a row with room to spell it out.
   *
   * The agent's name is shown either way, in both variants: the AI icon alone can't tell two
   * agents apart the way an avatar's initials can two people.
   */
  variant?: AssigneeDisplayVariant;
  /** The avatar/icon size in px, in `PersonAvatar`'s own steps. */
  size?: 16 | 20 | 24 | 28 | 32;
  /**
   * Overrides the plain name-join this draws as a tooltip by default, for a surface that
   * already has its own wording (the board card's "Assigned to …").
   */
  title?: string;
}

export function AssigneeDisplay({
  assignee,
  agentName,
  variant = 'compact',
  size = 20,
  title,
}: AssigneeDisplayProps): JSX.Element | null {
  const styles = useStyles();
  if (!assignee && !agentName) return null;

  const resolvedTitle = title ?? [assignee?.name, agentName].filter(Boolean).join(' / ');

  return (
    <span className={styles.row} title={resolvedTitle}>
      {assignee && (
        <>
          <PersonAvatar person={assignee} size={size} />
          {variant === 'text' && <Text className={styles.name}>{assignee.name}</Text>}
        </>
      )}
      {assignee && agentName && <Text className={styles.sep}>/</Text>}
      {agentName && (
        <>
          <span className={styles.agentIcon} style={{ fontSize: `${size - 4}px` }}>
            <AgentsRegular />
          </span>
          <Text className={styles.name}>{agentName}</Text>
        </>
      )}
    </span>
  );
}
