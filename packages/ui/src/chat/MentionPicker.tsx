/**
 * MentionPicker — the list that appears while you are typing `@someone`.
 *
 * Anchored above the composer rather than at the caret: a `<textarea>` will not tell you
 * where its caret is on screen without a mirror-element hack, and this pane is narrow
 * enough that a list pinned to the top edge of the box is unambiguous anyway.
 *
 * Keyboard-first, because the whole point is to not take your hands off the keys:
 * Up/Down move, Enter/Tab accept, Escape dismisses. The composer owns those keys while
 * this is open — see `Composer.onKeyDown`.
 */
import { Caption1, Spinner, makeStyles, tokens } from '@fluentui/react-components';
import type { JiraUserOption } from '@tm/shared/ipc';

const useStyles = makeStyles({
  root: {
    display: 'flex',
    flexDirection: 'column',
    maxHeight: '180px',
    overflowY: 'auto',
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    boxShadow: tokens.shadow8,
  },
  row: {
    display: 'flex',
    alignItems: 'baseline',
    gap: '8px',
    padding: '4px 8px',
    cursor: 'pointer',
    border: 'none',
    background: 'none',
    textAlign: 'left',
    color: tokens.colorNeutralForeground1,
    ':hover': { backgroundColor: tokens.colorNeutralBackground1Hover },
  },
  active: { backgroundColor: tokens.colorNeutralBackground1Selected },
  name: { fontWeight: tokens.fontWeightSemibold },
  muted: { color: tokens.colorNeutralForeground3, minWidth: 0, overflow: 'hidden' },
  status: { padding: '6px 8px', color: tokens.colorNeutralForeground3 },
});

export interface MentionPickerProps {
  people: readonly JiraUserOption[];
  /** Index of the row Enter would accept. */
  activeIndex: number;
  loading: boolean;
  onPick: (person: JiraUserOption) => void;
  onHover: (index: number) => void;
}

export function MentionPicker({
  people,
  activeIndex,
  loading,
  onPick,
  onHover,
}: MentionPickerProps): React.JSX.Element | null {
  const styles = useStyles();
  if (!loading && !people.length) return null;

  return (
    <div className={styles.root} role="listbox" aria-label="People to mention">
      {loading && !people.length && (
        <div className={styles.status}>
          <Spinner size="tiny" label="Looking people up…" labelPosition="after" />
        </div>
      )}
      {people.map((person, i) => (
        <button
          key={`${person.id ?? person.displayName}-${i}`}
          type="button"
          role="option"
          aria-selected={i === activeIndex}
          className={i === activeIndex ? `${styles.row} ${styles.active}` : styles.row}
          // `onMouseDown` with preventDefault, not `onClick`: a click would blur the
          // textarea first, which closes the picker before the pick is applied.
          onMouseDown={(e) => {
            e.preventDefault();
            onPick(person);
          }}
          onMouseEnter={() => onHover(i)}
        >
          <Caption1 className={styles.name}>{person.displayName}</Caption1>
          {person.email && <Caption1 className={styles.muted}>{person.email}</Caption1>}
        </button>
      ))}
    </div>
  );
}
