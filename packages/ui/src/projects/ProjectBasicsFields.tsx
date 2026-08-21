/**
 * The tickets-or-personal choice every project form makes, and the prefix field that choice
 * unlocks — the one part of a project's identity `ProjectForm.tsx` does not draw inline,
 * since the guarantee it sits on top of (`store.addProject`/`updateProject` deriving a
 * prefix for any plan-less project that does not opt out) belongs to a plan-less project
 * only. `ProjectForm` renders this in place of its own "Ticket key prefix" field for exactly
 * that case, and keeps its legacy inline field — always shown, never required — for editing
 * a plan-driven project, which this choice was never about.
 *
 * Fully controlled, including `ticketPrefix`: the name-driven suggestion and the
 * `prefixTouched` bookkeeping it depends on both live in `ProjectForm.tsx` already (it needs
 * them regardless of which prefix field is on screen), so this component does not duplicate
 * either — it only renders what the two already-computed values (`mode`, `ticketPrefix`) and
 * their setters ask for.
 */
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
import { ticketPrefixError, type TicketMode } from './projectBasics';

const useStyles = makeStyles({
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
  mode: TicketMode;
  onModeChange: (mode: TicketMode) => void;
  ticketPrefix: string;
  onTicketPrefixChange: (prefix: string) => void;
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
  mode,
  onModeChange,
  ticketPrefix,
  onTicketPrefixChange,
  projects,
  editingId,
  hasIssuedTickets,
}: ProjectBasicsFieldsProps): JSX.Element {
  const styles = useStyles();

  const prefixError = ticketPrefixError({ mode, prefix: ticketPrefix, projects, editingId });

  return (
    <>
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
            onChange={(_e, d) => onTicketPrefixChange(d.value)}
            placeholder="TM"
          />
        </Field>
      )}
    </>
  );
}
