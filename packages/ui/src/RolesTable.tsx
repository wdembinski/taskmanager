/**
 * RolesTable — a card's (or a project's) four roles, each with a model and an effort (F28.1,
 * mockup v11-4): `Role / Model / Effort`, then Lead, Planner, Workers and Reviewer.
 *
 * Shared by the Start dialog (`AssignAgentDialog`) and the project form, which is why it is
 * dumb: the caller decides what each row shows and what "follow the next rung" names, and the
 * pure rules for that live in `rolesTableModel.ts`. A model left on the default is `null`; an
 * effort always shows a value, because the ladder always resolves to one.
 *
 * No accent colour anywhere (the board's colour budget): the picked effort is a neutral pill
 * with semibold text, nothing more.
 */
import { useRef, type KeyboardEvent } from 'react';
import { makeStyles, mergeClasses, tokens } from '@fluentui/react-components';
import { AGENT_ROLES, EFFORTS, ROLE_CAPTIONS } from '@tm/shared/model';
import type { AgentRole, Effort } from '@tm/shared/model';
import type { ClaudeModel } from '@tm/shared/session';
import { ModelField } from './ModelField';
import { ROLE_DEFAULT, roleModelFromOption, roleModelOption } from './rolesTableModel';

const ROLE_NAMES: Record<AgentRole, string> = {
  lead: 'Lead',
  planner: 'Planner',
  workers: 'Workers',
  reviewer: 'Reviewer',
};

const useStyles = makeStyles({
  /** Three columns on the mockup's x = 358 / 538 / 738 grid: 180, 200 and the 350 pill. */
  table: {
    display: 'grid',
    gridTemplateColumns: '180px 200px 350px',
    alignItems: 'center',
    rowGap: 0,
  },
  head: {
    fontSize: '11.5px',
    fontWeight: tokens.fontWeightSemibold,
    color: tokens.colorNeutralForeground4,
    paddingBottom: '8px',
  },
  /** A row's three cells sit straight on the table's grid. */
  row: { display: 'contents' },
  /** One role per 52px row, as v11-4 pitches them. */
  cell: { height: '52px', display: 'flex', alignItems: 'center', minWidth: 0 },
  role: {
    flexDirection: 'column',
    alignItems: 'flex-start',
    justifyContent: 'center',
    gap: '1px',
  },
  name: {
    fontSize: tokens.fontSizeBase300,
    fontWeight: tokens.fontWeightSemibold,
    color: tokens.colorNeutralForeground1,
  },
  caption: { fontSize: '11.5px', color: tokens.colorNeutralForeground3 },
  /** Fluent's Dropdown hard-codes a 250px minimum — the 170px the mockup draws needs it gone. */
  /** v11-4's 170×28 box: radius 6, the pill's own thin stroke and 12.5px muted text — not
   *  Fluent's 32px outline with its darker underline. */
  model: {
    width: '170px',
    minWidth: 0,
    height: '28px',
    boxSizing: 'border-box',
    borderRadius: '6px',
    border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
    ':hover': {
      border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke1}`,
    },
    '& .fui-Dropdown__button': {
      minHeight: 0,
      height: '26px',
      paddingTop: 0,
      paddingBottom: 0,
      fontSize: '12.5px',
      color: tokens.colorNeutralForeground2,
    },
    /** v11-4's chevron is a small 10px mark, not Fluent's 20px glyph. */
    '& .fui-Dropdown__expandIcon': { fontSize: '16px' },
  },
  /** The 350×26 pill, five equal segments. */
  effort: {
    display: 'flex',
    width: '350px',
    height: '26px',
    boxSizing: 'border-box',
    padding: '1px',
    borderRadius: '13px',
    border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
  },
  segment: {
    flex: 1,
    minWidth: 0,
    border: 'none',
    borderRadius: '11px',
    margin: '1px',
    padding: 0,
    background: 'none',
    cursor: 'pointer',
    fontFamily: 'inherit',
    fontSize: '11.5px',
    color: tokens.colorNeutralForeground3,
    ':hover': { color: tokens.colorNeutralForeground1 },
    ':focus-visible': {
      outline: `${tokens.strokeWidthThick} solid ${tokens.colorStrokeFocus2}`,
      outlineOffset: '-2px',
    },
  },
  picked: {
    backgroundColor: tokens.colorNeutralBackground3,
    fontWeight: tokens.fontWeightSemibold,
    color: tokens.colorNeutralForeground1,
  },
});

export interface RoleRow {
  role: AgentRole;
  /** The row's own model; `null` = the sentinel ("follow the next rung"). */
  model: ClaudeModel | null;
  /**
   * What the sentinel option reads — normally the model it falls back to. Absent, the row
   * offers no sentinel at all: the project's Workers model IS the bottom rung, so it has no
   * next one to follow and `model` is never `null`.
   */
  sentinelLabel?: string;
  /** The effort shown picked — the resolved one, whether or not it is the row's own. */
  effort: Effort;
}

export interface RolesTableProps {
  rows: readonly RoleRow[];
  onModelChange: (role: AgentRole, model: ClaudeModel | null) => void;
  onEffortChange: (role: AgentRole, effort: Effort) => void;
  disabled?: boolean;
}

export function RolesTable({
  rows,
  onModelChange,
  onEffortChange,
  disabled,
}: RolesTableProps): JSX.Element {
  const styles = useStyles();
  const byRole = new Map(rows.map((row) => [row.role, row]));
  return (
    <div className={styles.table} data-roles-table role="group" aria-label="Roles">
      <div className={styles.head}>Role</div>
      <div className={styles.head}>Model</div>
      <div className={styles.head}>Effort</div>
      {AGENT_ROLES.map((role) => {
        const row = byRole.get(role);
        if (!row) return null;
        const name = ROLE_NAMES[role];
        return (
          <div key={role} className={styles.row} data-role={role}>
            <div className={mergeClasses(styles.cell, styles.role)}>
              <span className={styles.name}>{name}</span>
              <span className={styles.caption}>{ROLE_CAPTIONS[role]}</span>
            </div>
            <div className={styles.cell}>
              <ModelField
                dropdownClassName={styles.model}
                value={
                  row.sentinelLabel === undefined ? (row.model ?? '') : roleModelOption(row.model)
                }
                onChange={(v) => onModelChange(role, roleModelFromOption(v))}
                sentinel={
                  row.sentinelLabel === undefined
                    ? undefined
                    : { value: ROLE_DEFAULT, label: row.sentinelLabel }
                }
                allowCustom={false}
                labelOnly
                title={`${name} model`}
              />
            </div>
            <div className={styles.cell}>
              <EffortSegmented
                label={`${name} effort`}
                value={row.effort}
                disabled={disabled}
                onChange={(effort) => onEffortChange(role, effort)}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

interface EffortSegmentedProps {
  label: string;
  value: Effort;
  onChange: (effort: Effort) => void;
  disabled?: boolean;
}

/**
 * The five efforts as one radiogroup: a roving tab stop on the picked segment, and the arrow
 * keys (plus Home/End) move AND pick, the way a native radio group does.
 */
export function EffortSegmented({
  label,
  value,
  onChange,
  disabled,
}: EffortSegmentedProps): JSX.Element {
  const styles = useStyles();
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);

  function move(e: KeyboardEvent<HTMLDivElement>): void {
    const at = EFFORTS.indexOf(value);
    const last = EFFORTS.length - 1;
    const next =
      e.key === 'ArrowRight' || e.key === 'ArrowDown'
        ? Math.min(last, at + 1)
        : e.key === 'ArrowLeft' || e.key === 'ArrowUp'
          ? Math.max(0, at - 1)
          : e.key === 'Home'
            ? 0
            : e.key === 'End'
              ? last
              : null;
    if (next === null) return;
    e.preventDefault();
    if (next === at) return;
    onChange(EFFORTS[next]);
    buttons.current[next]?.focus();
  }

  return (
    <div
      className={styles.effort}
      role="radiogroup"
      aria-label={label}
      aria-disabled={disabled || undefined}
      onKeyDown={disabled ? undefined : move}
    >
      {EFFORTS.map((effort, i) => {
        const picked = effort === value;
        return (
          <button
            key={effort}
            ref={(el) => {
              buttons.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={picked}
            tabIndex={picked ? 0 : -1}
            disabled={disabled}
            className={mergeClasses(styles.segment, picked && styles.picked)}
            onClick={() => onChange(effort)}
          >
            {effort}
          </button>
        );
      })}
    </div>
  );
}
