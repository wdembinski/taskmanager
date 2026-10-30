/**
 * IssueRow — one line of the shared issues list, shared by both hosts (F13.13's `peek`/
 * `full` panel sits beside it; F13.15 moves the Tickets list onto it). Draws exactly what
 * `issueRowParts` decided: a key, a status glyph, the title, and up to four optional parts
 * on the right — a run pill, an MR/PR reference, a due date, an avatar.
 *
 * Selection is two rules, not one combined style: the tint + title recolour apply whenever
 * `selected`, and the left bar (`::before`) is shown only alongside that same tint — there is
 * no "bar without tint" state. Hover is a second, non-exclusive rule that still applies when
 * selected, the mockups showing no third "hover while selected" treatment.
 *
 * Every colour is `var(--tm-…, <fluent-fallback>)` — `--tm-*` is already stamped on both
 * hosts' provider roots (`tokenCssVars`), just hard-coded to dark until F13.4 makes it
 * follow the resolved scheme.
 */
import { Link, Text, makeStyles, mergeClasses, tokens } from '@fluentui/react-components';
import { memo, type KeyboardEvent, type MouseEvent } from 'react';
import {
  CheckmarkCircleFilled,
  CircleHalfFillRegular,
  CircleHintRegular,
  CircleRegular,
  PresenceBlockedRegular,
} from '@fluentui/react-icons';
import type { BoardColumn } from '@tm/shared/model';
import type { TaskSummary } from '@tm/shared/taskSummary';
import { AssigneeDisplay } from '../projects/AssigneeDisplay';
import { issueRowParts, type IssueRowContext } from './issueRowParts';

/** One icon per column, every one in `textMuted` — the glyph's SHAPE carries the state,
 *  not a second colour spent on something that isn't moving. Exported so `Sidebar.tsx`'s own
 *  ticket rows draw the exact same shapes, rather than a second lookup table that could drift. */
export const STATUS_GLYPH: Record<BoardColumn, JSX.Element> = {
  todo: <CircleRegular />,
  'in-progress': <CircleHalfFillRegular />,
  'in-review': <CircleHintRegular />,
  blocked: <PresenceBlockedRegular />,
  done: <CheckmarkCircleFilled />,
};

const useStyles = makeStyles({
  row: {
    position: 'relative',
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
    height: '34px',
    padding: '0 10px',
    borderRadius: '7px',
    cursor: 'pointer',
    minWidth: 0,
    ':hover': {
      backgroundColor: tokens.colorNeutralBackground1Hover,
    },
  },
  selected: {
    backgroundColor: `var(--tm-selected-tint, ${tokens.colorBrandBackground2})`,
    '::before': {
      content: '""',
      position: 'absolute',
      left: 0,
      top: '20%',
      height: '60%',
      width: '3px',
      borderRadius: '2px',
      backgroundColor: `var(--tm-accent-bar, ${tokens.colorBrandForeground1})`,
    },
  },
  key: {
    flexShrink: 0,
    // A list with longer keys widens the column via `--tm-key-width` (see `keyColumnWidth`);
    // a key never wraps onto a second line.
    width: 'var(--tm-key-width, 52px)',
    whiteSpace: 'nowrap',
    fontFamily: `var(--tm-mono, ${tokens.fontFamilyMonospace})`,
    fontSize: tokens.fontSizeBase200,
    color: `var(--tm-text-faint, ${tokens.colorNeutralForeground3})`,
  },
  glyph: {
    display: 'flex',
    flexShrink: 0,
    alignItems: 'center',
    fontSize: '14px',
    color: `var(--tm-text-faint, ${tokens.colorNeutralForeground3})`,
  },
  title: {
    flex: 1,
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  titleSelected: {
    color: `var(--tm-brand, ${tokens.colorBrandForeground1})`,
    fontWeight: tokens.fontWeightSemibold,
  },
  cluster: {
    display: 'flex',
    flexShrink: 0,
    alignItems: 'center',
    gap: '10px',
  },
  run: {
    display: 'inline-flex',
    alignItems: 'center',
    // v9-1: the dot's left edge 7px in, the label 18px in.
    gap: '5px',
    height: '20px',
    padding: '0 10px 0 7px',
    borderRadius: '10px',
    fontSize: tokens.fontSizeBase200,
    whiteSpace: 'nowrap',
    backgroundColor: `var(--tm-run-pill, ${tokens.colorNeutralBackground3})`,
    color: `var(--tm-run-ink, ${tokens.colorNeutralForeground2})`,
  },
  runDot: {
    flexShrink: 0,
    width: '6px',
    height: '6px',
    borderRadius: '50%',
    backgroundColor: 'var(--tm-run-dot, currentColor)',
  },
  mr: {
    flexShrink: 0,
    fontFamily: `var(--tm-mono, ${tokens.fontFamilyMonospace})`,
    fontSize: tokens.fontSizeBase200,
    color: `var(--tm-text-faint, ${tokens.colorNeutralForeground3})`,
  },
  due: {
    flexShrink: 0,
    fontSize: tokens.fontSizeBase200,
    color: `var(--tm-text-faint, ${tokens.colorNeutralForeground3})`,
  },
  dueFlagged: {
    fontWeight: tokens.fontWeightSemibold,
    color: `var(--tm-attention, ${tokens.colorPaletteDarkOrangeForeground1})`,
  },
  archived: {
    flexShrink: 0,
    fontSize: tokens.fontSizeBase200,
    color: `var(--tm-text-faint, ${tokens.colorNeutralForeground3})`,
  },
});

export interface IssueRowProps {
  task: TaskSummary;
  ctx: IssueRowContext;
  selected?: boolean;
  /** Whether this row is hidden by default (F14.6) — the caller already decided this with
   *  `archivedBy`, so the row only draws the quiet "Archived" tag rather than re-deriving it. */
  archived?: boolean;
  onSelect?: (id: string) => void;
  onOpen?: (id: string) => void;
  /** A windowed list's option count and this row's place in it, from 1 (F29.3) — most of
   *  the options are not in the DOM, so a screen reader cannot count them itself. */
  setSize?: number;
  posInSet?: number;
}

/**
 * Memoised (F29.3): a list redraws only the rows whose props changed, so the caller keeps
 * `ctx` and the callbacks stable across renders for a row that did not.
 */
export const IssueRow = memo(function IssueRow({
  task,
  ctx,
  selected = false,
  archived = false,
  onSelect,
  onOpen,
  setSize,
  posInSet,
}: IssueRowProps): JSX.Element {
  const styles = useStyles();
  const parts = issueRowParts(task, ctx);

  return (
    <div
      className={mergeClasses(styles.row, selected && styles.selected)}
      role="option"
      aria-selected={selected}
      aria-setsize={setSize}
      aria-posinset={posInSet}
      tabIndex={selected ? 0 : -1}
      onClick={() => onSelect?.(task.id)}
      onDoubleClick={() => onOpen?.(task.id)}
      onKeyDown={(e: KeyboardEvent<HTMLDivElement>) => {
        if (e.key === 'Enter') onOpen?.(task.id);
      }}
    >
      <Text className={styles.key}>{parts.key}</Text>
      <span className={styles.glyph}>{STATUS_GLYPH[parts.column]}</span>
      <Text className={mergeClasses(styles.title, selected && styles.titleSelected)}>
        {parts.title}
      </Text>
      <span className={styles.cluster}>
        {archived && <Text className={styles.archived}>Archived</Text>}
        {parts.run && (
          <span className={styles.run}>
            <span className={styles.runDot} aria-hidden="true" />
            {parts.run.label}
          </span>
        )}
        {parts.mr && (
          <Link
            appearance="subtle"
            href={parts.mr.url}
            target="_blank"
            rel="noreferrer"
            className={styles.mr}
            onClick={(e: MouseEvent<HTMLAnchorElement>) => e.stopPropagation()}
          >
            {parts.mr.ref}
          </Link>
        )}
        {parts.due && (
          <Text className={mergeClasses(styles.due, parts.due.flagged && styles.dueFlagged)}>
            {parts.due.label}
          </Text>
        )}
        {parts.avatar && (
          <AssigneeDisplay
            assignee={parts.avatar.assignee}
            agentName={parts.avatar.agentName}
            title={parts.avatar.title}
            size={20}
            hideAgentName
          />
        )}
      </span>
    </div>
  );
});
