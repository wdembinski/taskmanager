/**
 * A row of colour chips — the app's one way of choosing a colour.
 *
 * A fixed palette rather than a free picker, everywhere it is used (a project's board
 * stripe, a status keyword). These colours are read at a glance across a whole column
 * of cards, so the useful property is that they are distinguishable from each other
 * and legible on the card's fill — neither of which an arbitrary hex guarantees. Eight
 * is enough to tell a handful of projects apart and few enough to pick from without
 * thinking.
 *
 * That argument holds for the DEFAULT case, not for every case — so the palette stays
 * the fast path and a custom chip sits beside it, opening Fluent's own colour picker
 * plus a hex field. `onChange` keeps its `(color: string) => void` shape, so every call
 * site gets the picker without changing.
 */
import { useState } from 'react';
import {
  Caption1,
  ColorArea,
  ColorPicker,
  ColorSlider,
  Input,
  Popover,
  PopoverSurface,
  PopoverTrigger,
  makeStyles,
  mergeClasses,
  tokens,
} from '@fluentui/react-components';
import { hexToHsv, hsvToHex, isOnPalette, normalizeHex } from './color';

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
  /** The "any colour" chip, when the current colour is one of the eight above. */
  custom: {
    backgroundColor: tokens.colorNeutralBackground3,
    border: `1px solid ${tokens.colorNeutralStroke1}`,
    color: tokens.colorNeutralForeground2,
    fontSize: '12px',
    lineHeight: '16px',
  },
  picker: { display: 'flex', flexDirection: 'column', gap: '10px' },
  hexRow: { display: 'flex', alignItems: 'center', gap: '8px' },
  preview: {
    width: '24px',
    height: '24px',
    borderRadius: '4px',
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    flexShrink: 0,
  },
  bad: { color: tokens.colorPaletteRedForeground1 },
});

/** Where the picker opens when there is no colour to open on. */
const DEFAULT_CUSTOM = '#0091ff';

export interface ColorSwatchesProps {
  /** The chosen colour, or `''` for none. */
  value: string;
  onChange: (color: string) => void;
  /** Offer a "none" chip. Off where a colour is required. */
  allowNone?: boolean;
}

export function ColorSwatches({ value, onChange, allowNone }: ColorSwatchesProps): JSX.Element {
  const styles = useStyles();
  const [open, setOpen] = useState(false);
  // What the picker is showing. Held separately from `value` so a drag through the
  // colour area doesn't repaint every card on the board on the way.
  const [draft, setDraft] = useState(() => normalizeHex(value) ?? DEFAULT_CUSTOM);
  const custom = Boolean(value) && !isOnPalette(value);

  /** Apply the draft, if it is a colour. A malformed hex simply keeps the old one. */
  function commit(): void {
    const hex = normalizeHex(draft);
    if (hex && hex !== normalizeHex(value)) onChange(hex);
  }

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

      {/* The custom chip, last in the row. It shows the current colour when that colour
          is off-palette (so the row always displays what is actually chosen) and a "+"
          otherwise. `onChange` keeps its signature, so every call site — the project
          dialog, the status-keyword editor — gets the picker without knowing about it. */}
      <Popover
        open={open}
        onOpenChange={(_e, d) => {
          setOpen(d.open);
          // Commit on close. Editing live would repaint every card on the board on each
          // pixel of a drag through the colour area.
          if (!d.open) commit();
          else setDraft(normalizeHex(value) ?? DEFAULT_CUSTOM);
        }}
        trapFocus
      >
        <PopoverTrigger disableButtonEnhancement>
          <button
            type="button"
            title={custom ? `Custom colour ${normalizeHex(value)}` : 'Pick any colour…'}
            aria-label="Pick any colour"
            aria-pressed={custom}
            className={mergeClasses(
              styles.swatch,
              !custom && styles.custom,
              custom && styles.selected,
            )}
            style={custom ? { backgroundColor: normalizeHex(value) ?? undefined } : undefined}
          >
            {custom ? '' : '+'}
          </button>
        </PopoverTrigger>
        <PopoverSurface>
          <div className={styles.picker}>
            <ColorPicker
              color={hexToHsv(draft) ?? { h: 0, s: 0, v: 0 }}
              onColorChange={(_e, d) => setDraft(hsvToHex(d.color))}
            >
              <ColorArea />
              <ColorSlider />
            </ColorPicker>
            <div className={styles.hexRow}>
              <span className={styles.preview} style={{ backgroundColor: draft }} />
              <Input
                size="small"
                value={draft}
                spellCheck={false}
                aria-label="Hex colour"
                // Typed freely, validated on the way out: a half-typed "#ab" is a state
                // to pass through, not one to reject a keystroke over.
                onChange={(_e, d) => setDraft(d.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    setOpen(false);
                    commit();
                  }
                }}
              />
            </div>
            {normalizeHex(draft) === null && (
              <Caption1 className={styles.bad}>
                Not a colour — use #rgb or #rrggbb. Closing now keeps the old one.
              </Caption1>
            )}
          </div>
        </PopoverSurface>
      </Popover>
    </div>
  );
}
