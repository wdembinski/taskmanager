/**
 * The half of a project form that is not about a repo — name, the tickets-or-personal
 * choice, the prefix that choice unlocks, and the board colour. Both hosts draw a project
 * form around it: the desktop's `Projects.tsx` adds everything about a repo on top, the
 * browser's `ProjectAdmin.tsx` (step 3) has nothing else to add at all.
 *
 * Fully controlled — every field and its setter is a prop — except for `prefixTouched`,
 * which stays internal because it is a UI-only fact about THIS form session (has the human
 * edited the prefix themselves yet), not a value either host would ever want to read or
 * seed from a project.
 */
import { useEffect, useState } from 'react';
import {
  Caption1,
  Field,
  Input,
  Radio,
  RadioGroup,
  makeStyles,
  mergeClasses,
  tokens,
} from '@fluentui/react-components';
import type { Project } from '@tm/shared/model';
import { ColorSwatches } from '../ColorSwatches';
import { suggestTicketPrefix, ticketPrefixError, type TicketMode } from './projectBasics';

const useStyles = makeStyles({
  form: { display: 'flex', flexDirection: 'column', gap: '12px' },
  options: { display: 'flex', flexDirection: 'column', gap: '6px' },
  option: {
    display: 'flex',
    flexDirection: 'column',
    gap: '1px',
    padding: '6px 8px',
    borderRadius: tokens.borderRadiusMedium,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    cursor: 'pointer',
    ':hover': { backgroundColor: tokens.colorNeutralBackground2Hover },
  },
  // The whole `border`, not `borderColor`: Griffel rejects the four-sided shorthand.
  optionChosen: {
    border: `1px solid ${tokens.colorBrandStroke1}`,
    backgroundColor: tokens.colorNeutralBackground2,
  },
  /** Indented under its control so it reads as belonging to that option. */
  optionWhy: { color: tokens.colorNeutralForeground3, paddingLeft: '28px' },
  optionWarning: { color: tokens.colorPaletteMarigoldForeground1, paddingLeft: '28px' },
  mono: { fontFamily: 'ui-monospace, Consolas, monospace' },
});

export interface ProjectBasicsFieldsProps {
  name: string;
  onNameChange: (name: string) => void;
  mode: TicketMode;
  onModeChange: (mode: TicketMode) => void;
  ticketPrefix: string;
  onTicketPrefixChange: (prefix: string) => void;
  color: string;
  onColorChange: (color: string) => void;
  /** Every other project, so a chosen prefix can be checked against theirs. */
  projects: Project[];
  /** The project being edited, excluded from the prefix collision check against itself. */
  editingId?: string;
  /**
   * The project being edited already owns tickets, so switching it back to Personal can be
   * refused by the store once it has issued any — see `ticketPrefixError` doc and
   * `store.updateProject`. Warns on the Personal option rather than waiting for the refusal.
   */
  hasIssuedTickets?: boolean;
}

export function ProjectBasicsFields({
  name,
  onNameChange,
  mode,
  onModeChange,
  ticketPrefix,
  onTicketPrefixChange,
  color,
  onColorChange,
  projects,
  editingId,
  hasIssuedTickets,
}: ProjectBasicsFieldsProps): JSX.Element {
  const styles = useStyles();

  // Once the human edits the prefix directly, a later name edit must stop overwriting it.
  // An existing project's prefix is never overwritten by editing the name either, so a form
  // that opens already editing one starts touched.
  const [prefixTouched, setPrefixTouched] = useState(() => Boolean(editingId));
  useEffect(() => {
    setPrefixTouched(Boolean(editingId));
  }, [editingId]);

  // Suggest a prefix from the name, until the human types one of their own — and only once
  // there is a prefix to suggest for; a Personal project has nothing to suggest.
  useEffect(() => {
    if (mode !== 'tickets') return;
    if (prefixTouched) return;
    onTicketPrefixChange(suggestTicketPrefix(name));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name, mode, prefixTouched]);

  const prefixError = ticketPrefixError({ mode, prefix: ticketPrefix, projects, editingId });

  return (
    <div className={styles.form}>
      <Field
        label="Display name"
        hint="Defaults to the folder name, or the ticket prefix if there is no folder."
      >
        <Input
          value={name}
          onChange={(_e, d) => onNameChange(d.value)}
          placeholder="(folder name)"
        />
      </Field>

      <Field label="Where its work lives">
        <RadioGroup value={mode} onChange={(_e, d) => onModeChange(d.value as TicketMode)}>
          <div className={styles.options}>
            <label
              className={mergeClasses(styles.option, mode === 'personal' && styles.optionChosen)}
            >
              <Radio value="personal" label="Personal space — no tickets of its own" />
              <Caption1 className={styles.optionWhy}>
                Its cards live on My Tasks, filed under this project. Nothing here is numbered.
              </Caption1>
              {hasIssuedTickets && (
                <Caption1 className={styles.optionWarning}>
                  Switching back only works while this project has issued no tickets.
                </Caption1>
              )}
            </label>
            <label
              className={mergeClasses(styles.option, mode === 'tickets' && styles.optionChosen)}
            >
              <Radio value="tickets" label="Its own ticket board" />
              <Caption1 className={styles.optionWhy}>
                Gets a key prefix and numbers its own tickets (TM-1, TM-2, …), and appears on the
                Tickets tab.
              </Caption1>
            </label>
          </div>
        </RadioGroup>
      </Field>

      {mode === 'tickets' && (
        <Field
          label="Ticket key prefix"
          hint="Tickets filed under this project are numbered TM-1, TM-2, …"
          validationState={prefixError ? 'error' : undefined}
          validationMessage={prefixError ?? undefined}
        >
          <Input
            className={styles.mono}
            value={ticketPrefix}
            onChange={(_e, d) => {
              onTicketPrefixChange(d.value);
              setPrefixTouched(true);
            }}
            placeholder="TM"
          />
        </Field>
      )}

      <Field
        label="Colour"
        hint="A card tagged with this project wears a stripe of this colour, so a mixed column says which project each card is about."
      >
        <ColorSwatches value={color} onChange={onColorChange} allowNone />
      </Field>
    </div>
  );
}
