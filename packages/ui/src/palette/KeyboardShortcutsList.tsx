/**
 * The read-only "Keyboard shortcuts" list F9.6 adds to Settings — each host passes its own
 * `items` (the desktop offers only `mod+k`; the web adds its `/` opener), and this component
 * holds no shortcut knowledge of its own beyond rendering `shortcutLabel` per row.
 */
import { Caption1, makeStyles, tokens } from '@fluentui/react-components';
import { shortcutLabel } from './shortcutLabel';

const useStyles = makeStyles({
  list: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalS,
  },
  row: {
    display: 'flex',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: tokens.spacingHorizontalM,
  },
  keys: {
    color: tokens.colorNeutralForeground3,
    whiteSpace: 'nowrap',
  },
});

export interface KeyboardShortcutItem {
  id: string;
  /** What the shortcut does, e.g. "Open command palette". */
  label: string;
  /** A `shortcutMatches`/`useGlobalShortcut` spec — see `shortcut.ts`'s header comment. */
  spec: string;
}

export interface KeyboardShortcutsListProps {
  items: readonly KeyboardShortcutItem[];
  /** Passed through to `shortcutLabel` for platform-aware rendering; omit to render for a
   *  non-macOS platform (the `shortcutLabel(spec, undefined)` default). */
  win?: object;
}

export function KeyboardShortcutsList({ items, win }: KeyboardShortcutsListProps): JSX.Element {
  const styles = useStyles();
  return (
    <div className={styles.list}>
      {items.map((item) => (
        <div key={item.id} className={styles.row}>
          <Caption1>{item.label}</Caption1>
          <Caption1 className={styles.keys}>{shortcutLabel(item.spec, win)}</Caption1>
        </div>
      ))}
    </div>
  );
}
