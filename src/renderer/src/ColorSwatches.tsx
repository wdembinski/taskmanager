/**
 * A row of colour chips — the app's one way of choosing a colour.
 *
 * A fixed palette rather than a free picker, everywhere it is used (a project's board
 * stripe, a status keyword). These colours are read at a glance across a whole column
 * of cards, so the useful property is that they are distinguishable from each other
 * and legible on the card's fill — neither of which an arbitrary hex guarantees. Eight
 * is enough to tell a handful of projects apart and few enough to pick from without
 * thinking.
 */
import { makeStyles, mergeClasses, tokens } from '@fluentui/react-components';

/** The palette, in a deliberate order: warm → cool → neutral. */
export const PALETTE = [
  '#E5484D',
  '#F2721E',
  '#F5A623',
  '#30A46C',
  '#0091FF',
  '#8E4EC6',
  '#12836B',
  '#9BA1A6',
] as const;

const useStyles = makeStyles({
  row: { display: 'flex', alignItems: 'center', gap: '4px', flexWrap: 'wrap' },
  /**
   * A bare chip. The selected one grows an OUTLINE rather than a border, so picking a
   * different colour never nudges the row's layout by a pixel.
   */
  swatch: {
    width: '18px',
    height: '18px',
    borderRadius: '4px',
    border: 'none',
    padding: 0,
    cursor: 'pointer',
    outline: '2px solid transparent',
    outlineOffset: '1px',
    flexShrink: 0,
  },
  selected: { outlineColor: tokens.colorNeutralForeground1 },
  /** "No colour": a hollow chip, so the absence of a colour is itself pickable. */
  none: {
    backgroundColor: 'transparent',
    border: `1px dashed ${tokens.colorNeutralStroke1}`,
    color: tokens.colorNeutralForeground3,
    fontSize: '11px',
    lineHeight: '16px',
  },
});

export interface ColorSwatchesProps {
  /** The chosen colour, or `''` for none. */
  value: string;
  onChange: (color: string) => void;
  /** Offer a "none" chip. Off where a colour is required. */
  allowNone?: boolean;
}

export function ColorSwatches({ value, onChange, allowNone }: ColorSwatchesProps): JSX.Element {
  const styles = useStyles();
  return (
    <div className={styles.row}>
      {allowNone && (
        <button
          type="button"
          title="No colour"
          aria-label="No colour"
          aria-pressed={!value}
          className={mergeClasses(styles.swatch, styles.none, !value && styles.selected)}
          onClick={() => onChange('')}
        >
          ×
        </button>
      )}
      {PALETTE.map((color) => (
        <button
          key={color}
          type="button"
          title={color}
          aria-label={color}
          aria-pressed={value.toLowerCase() === color.toLowerCase()}
          className={mergeClasses(
            styles.swatch,
            value.toLowerCase() === color.toLowerCase() && styles.selected,
          )}
          style={{ backgroundColor: color }}
          onClick={() => onChange(color)}
        />
      ))}
    </div>
  );
}
