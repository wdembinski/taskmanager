/**
 * The chevron that folds a section of the detail pane away.
 *
 * Extracted because there are now three of them — Description, Steps, and a step's Brief —
 * and the third copy is where a hand-rolled `<button>` with a chevron and its own
 * `background: none` reset starts drifting: one of them ends up a pixel taller, or keeps
 * its hover colour when the others lost theirs.
 *
 * The label is `children` rather than a string on purpose. Description is a `Caption1` and
 * the other two are semibold `Text`; the sections differ in weight deliberately, and a
 * component that decided their typography for them would flatten that.
 */
import { Caption1, makeStyles, tokens } from '@fluentui/react-components';
import { ChevronDownRegular, ChevronRightRegular } from '@fluentui/react-icons';

const useStyles = makeStyles({
  toggle: {
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
    background: 'none',
    border: 'none',
    padding: 0,
    cursor: 'pointer',
    color: tokens.colorNeutralForeground2,
    // The whole header reads as one control, so the label inherits the button's colour
    // rather than fighting it.
    textAlign: 'left',
    ':hover': { color: tokens.colorNeutralForeground1 },
  },
});

export interface FoldToggleProps {
  open: boolean;
  onToggle: () => void;
  /** The section's own heading, in the section's own typography. */
  children: React.ReactNode;
  /**
   * A word or two that stays readable while the section is folded — "3/5", "empty". The
   * point of a fold is that the header still tells you whether opening it is worth it.
   */
  summary?: string;
}

export function FoldToggle({ open, onToggle, children, summary }: FoldToggleProps): JSX.Element {
  const styles = useStyles();
  return (
    <button
      type="button"
      className={styles.toggle}
      onClick={onToggle}
      aria-expanded={open}
      title={open ? 'Collapse' : 'Expand'}
    >
      {open ? <ChevronDownRegular /> : <ChevronRightRegular />}
      {children}
      {!open && summary && <Caption1>· {summary}</Caption1>}
    </button>
  );
}
