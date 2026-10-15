/**
 * The shared skill picker (F7.9) — a small Popover `AssignAgentDialog`, `TaskAgentPanel` and
 * each `TaskSteps` row all drive from their own `own`/`inherited` refs, so the three surfaces
 * get one look rather than three. All the row logic (filtering, inherited-wins, missing refs)
 * lives in `skillPicker.ts`; this component only renders `pickerRows` and calls `onChange`
 * with `toggleSkillRef`'s result.
 *
 * The trigger button's own `onClick` stops propagation because a step row is itself a click
 * target (expand/collapse) — without this, opening the popover from inside a row would also
 * fire whatever the row's own click does.
 */
import { useMemo, useState } from 'react';
import {
  Body1,
  Button,
  Caption1,
  Checkbox,
  Popover,
  PopoverSurface,
  PopoverTrigger,
  SearchBox,
  Spinner,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { pickerRows, toggleSkillRef, type SkillOption, type SkillPickerRow } from './skillPicker';

const useStyles = makeStyles({
  surface: {
    display: 'flex',
    flexDirection: 'column',
    gap: '6px',
    width: '320px',
    maxWidth: '90vw',
  },
  list: {
    display: 'flex',
    flexDirection: 'column',
    overflowY: 'auto',
    maxHeight: '280px',
  },
  row: { alignItems: 'flex-start', padding: '4px' },
  rowText: { display: 'flex', flexDirection: 'column', minWidth: 0, gap: '1px' },
  label: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  caption: { color: tokens.colorNeutralForeground3 },
  empty: { color: tokens.colorNeutralForeground3, padding: '8px 4px', maxWidth: '260px' },
});

const CAPTION_TEXT: Record<SkillPickerRow['caption'], string> = {
  'from card': 'from card',
  library: 'library',
  repo: 'repo',
  missing: 'missing',
};

export interface SkillPickerProps {
  /** Every option the library and the current agent project's repo offer — `useSkillOptions`'s
   *  own `options`, already name-sorted library-then-repo. */
  options: SkillOption[];
  /** The open task's own `skillRefs`. */
  own: string[];
  /** A step's parent card refs, shown checked, disabled and captioned "from card". Omitted
   *  (or empty) for a surface with nothing above it — the assign dialog, a card's own panel. */
  inherited?: string[];
  /** Called with the next `own` after a toggle — never fires for an inherited ref. */
  onChange: (nextOwn: string[]) => void;
  disabled?: boolean;
  /** `useSkillOptions`'s own `loading` — shows a spinner instead of the (still empty) list. */
  loading?: boolean;
}

export function SkillPicker({
  options,
  own,
  inherited,
  onChange,
  disabled,
  loading,
}: SkillPickerProps): JSX.Element {
  const styles = useStyles();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');

  const refs = useMemo(() => ({ own, inherited: inherited ?? [] }), [own, inherited]);
  // Unfiltered, so the trigger's count never changes with whatever is currently typed into
  // the search box — only `rows` below is affected by `query`.
  const count = useMemo(
    () => pickerRows(options, refs, '').filter((row) => row.state !== 'available').length,
    [options, refs],
  );
  const rows = useMemo(() => pickerRows(options, refs, query), [options, refs, query]);

  function toggle(ref: string): void {
    onChange(toggleSkillRef(own, refs.inherited, ref));
  }

  return (
    <Popover
      open={open}
      onOpenChange={(_e, data) => {
        setOpen(data.open);
        if (!data.open) setQuery('');
      }}
      positioning="below-start"
    >
      <PopoverTrigger disableButtonEnhancement>
        <Button
          size="small"
          appearance="subtle"
          disabled={disabled}
          onClick={(e) => e.stopPropagation()}
        >
          {count > 0 ? `Skills · ${count}` : 'Skills'}
        </Button>
      </PopoverTrigger>
      <PopoverSurface className={styles.surface}>
        {loading ? (
          <Spinner size="tiny" label="Loading skills…" />
        ) : options.length === 0 ? (
          <Caption1 className={styles.empty}>
            No skills yet — add them in Settings → Skills
          </Caption1>
        ) : (
          <>
            <SearchBox
              size="small"
              placeholder="Filter skills"
              value={query}
              onChange={(_e, data) => setQuery(data.value)}
            />
            <div className={styles.list}>
              {rows.map((row) => (
                <Checkbox
                  key={row.ref}
                  className={styles.row}
                  disabled={disabled || row.state === 'inherited'}
                  checked={row.state === 'inherited' || row.state === 'selected'}
                  onChange={() => toggle(row.ref)}
                  label={
                    <div className={styles.rowText}>
                      <Body1 className={styles.label}>{row.label}</Body1>
                      <Caption1 className={styles.caption}>{CAPTION_TEXT[row.caption]}</Caption1>
                    </div>
                  }
                />
              ))}
            </div>
          </>
        )}
      </PopoverSurface>
    </Popover>
  );
}
