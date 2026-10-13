/**
 * The cross-board, chronological activity feed (F2.11) — a thin driver over `feedState`'s
 * pure state machine and `activityFeedModel`'s pure mapping helpers. This file owns only
 * three things neither of those can: the IPC calls, the `issued`/`seq` race guard around
 * them (same pattern as `TaskDetail.tsx`'s timeline load, `TaskDetail.tsx:444`), and the
 * poll's visibility-aware cadence.
 *
 * The filter is controlled by the host (F2.10's tiles set it; F2.13's screen owns it) —
 * this component never holds its own copy, only drives `activity:list` from whatever it is
 * handed. Last-seen is controlled too, for the same reason: F2.13 persists it to desktop
 * `app_state`, F2.14 to the browser's own localStorage, and this file has no business
 * knowing which.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { JSX, UIEvent } from 'react';
import {
  Body1,
  Button,
  Caption1,
  Dropdown,
  Option,
  Tooltip,
  makeStyles,
  mergeClasses,
  tokens,
} from '@fluentui/react-components';
import {
  ArrowClockwiseRegular,
  ArrowRightRegular,
  CheckmarkCircleRegular,
  ClipboardTaskRegular,
  DismissCircleRegular,
  FlashRegular,
  MergeRegular,
  PauseCircleRegular,
  PlayCircleRegular,
  PresenceBlockedRegular,
  QuestionCircleRegular,
  RocketRegular,
} from '@fluentui/react-icons';
import { CADENCE_MS } from '@tm/protocol/cadence';
import {
  ACTIVITY_OUTCOMES,
  type ActivityCursor,
  type ActivityKind,
  type ActivityOutcome,
  type ActivityRow,
} from '@tm/shared/activity';
import { PaneLoading } from '../PaneLoading';
import { relativeAge } from '../gitGraphView';
import { useTransport } from '../transport';
import {
  EMPTY_FEED_FILTER,
  type FeedFilter,
  type FeedKindGroup,
  type FixedOrigin,
  feedFilterIsEmpty,
  feedFilterKey,
  feedQueryFor,
  formatCost,
  groupRowsByDay,
  originLabel,
  rowSentence,
  rowTarget,
} from './activityFeedModel';
import {
  EMPTY_FEED,
  feedDividerIndex,
  feedLoadStarted,
  feedNewestCursor,
  feedPageArrived,
  feedScrolled,
  feedShowNew,
  feedStagedCount,
  type FeedState,
} from './feedState';

export interface ActivityFeedProps {
  sinceMs: number;
  filter: FeedFilter;
  onFilterChange: (filter: FeedFilter) => void;
  lastSeen: ActivityCursor | null;
  onNewestSeen?: (cursor: ActivityCursor) => void;
  onOpenTask?: (taskId: string) => void;
}

/** Past this scroll offset the reader counts as "away from the top" (see `feedState.ts`). */
const SCROLL_AWAY_THRESHOLD = 24;

const KIND_GROUP_OPTIONS: readonly { value: FeedKindGroup; label: string }[] = [
  { value: 'runs', label: 'Runs' },
  { value: 'merges', label: 'Merges' },
  { value: 'gates', label: 'Gates' },
  { value: 'moves', label: 'Moves' },
];

const OUTCOME_OPTION_LABEL: Record<ActivityOutcome, string> = {
  done: 'Done',
  failed: 'Failed',
  stopped: 'Stopped',
  empty: 'Empty',
  'needs-input': 'Needs input',
};

const ORIGIN_OPTIONS: readonly FixedOrigin[] = ['human', 'chain', 'resume', 'auto-release'];

type IconComponent = typeof PlayCircleRegular;

/** Monochrome by design — see `board-colour-budget`. A row is a settled fact, not a move. */
const KIND_ICON: Record<ActivityKind, IconComponent> = {
  'run-started': PlayCircleRegular,
  'run-finished': CheckmarkCircleRegular,
  'trigger-fired': FlashRegular,
  'merge-landed': MergeRegular,
  'merge-conflict': PresenceBlockedRegular,
  'merge-failed': DismissCircleRegular,
  'release-published': RocketRegular,
  parked: PauseCircleRegular,
  resumed: ArrowClockwiseRegular,
  'plan-presented': ClipboardTaskRegular,
  'question-raised': QuestionCircleRegular,
  'status-moved': ArrowRightRegular,
};

interface ProjectOption {
  id: string;
  name: string;
}

type RenderItem =
  | { type: 'day'; key: string; label: string }
  | { type: 'row'; key: string; row: ActivityRow }
  | { type: 'divider'; key: string };

/** Splices the "New since you were away" divider into day-grouped rows at `dividerIndex`. */
function buildRenderItems(
  rows: readonly ActivityRow[],
  dividerIndex: number | null,
  now: number,
  tzOffsetMinutes: number,
): RenderItem[] {
  const groups = groupRowsByDay(rows, { now, tzOffsetMinutes });
  const items: RenderItem[] = [];
  let count = 0;
  let dividerPlaced = dividerIndex === null;

  groups.forEach((group, groupIndex) => {
    items.push({ type: 'day', key: `day-${groupIndex}`, label: group.label });
    for (const row of group.rows) {
      if (!dividerPlaced && count === dividerIndex) {
        items.push({ type: 'divider', key: 'divider' });
        dividerPlaced = true;
      }
      items.push({ type: 'row', key: String(row.id), row });
      count++;
    }
  });

  if (!dividerPlaced) items.push({ type: 'divider', key: 'divider' });
  return items;
}

function isStaleCursorMessage(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('out of date');
}

const useStyles = makeStyles({
  root: {
    display: 'flex',
    flexDirection: 'column',
    minHeight: 0,
    minWidth: 0,
    width: '100%',
    gap: '8px',
  },
  toolbar: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: '8px',
  },
  picker: { minWidth: '140px' },
  scroll: { flex: 1, minHeight: 0, overflowY: 'auto', position: 'relative' },
  dayHeader: {
    display: 'block',
    position: 'sticky',
    top: 0,
    zIndex: 1,
    padding: '6px 4px',
    backgroundColor: tokens.colorNeutralBackground2,
    color: tokens.colorNeutralForeground3,
    fontWeight: 600,
  },
  divider: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    padding: '6px 4px',
    color: tokens.colorBrandForeground1,
  },
  dividerLine: { flex: 1, height: '1px', backgroundColor: tokens.colorBrandStroke1 },
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    width: '100%',
    padding: '6px 4px',
    boxSizing: 'border-box',
    border: 'none',
    background: 'none',
    font: 'inherit',
    textAlign: 'left',
    color: 'inherit',
    cursor: 'default',
    ':hover': { backgroundColor: tokens.colorNeutralBackground1Hover },
  },
  rowButton: { cursor: 'pointer' },
  rowDeleted: { opacity: 0.6, cursor: 'default' },
  /** Monochrome — a kind icon is a standing label on a settled row, not a moving thing. */
  kindIcon: { fontSize: '16px', flexShrink: 0, color: tokens.colorNeutralForeground3 },
  title: {
    flex: 1,
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  sentence: {
    color: tokens.colorNeutralForeground3,
    whiteSpace: 'nowrap',
    flexShrink: 0,
  },
  chip: {
    flexShrink: 0,
    maxWidth: '140px',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    padding: '0 6px',
    borderRadius: tokens.borderRadiusSmall,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    color: tokens.colorNeutralForeground2,
    fontSize: '11px',
    lineHeight: '16px',
  },
  meta: { color: tokens.colorNeutralForeground3, whiteSpace: 'nowrap', flexShrink: 0 },
  cost: {
    color: tokens.colorNeutralForeground3,
    whiteSpace: 'nowrap',
    flexShrink: 0,
    minWidth: '56px',
    textAlign: 'right',
  },
  newPill: {
    position: 'sticky',
    top: '4px',
    zIndex: 2,
    alignSelf: 'center',
  },
  footer: {
    display: 'block',
    padding: '8px 4px',
    color: tokens.colorNeutralForeground4,
    textAlign: 'center',
  },
  empty: { padding: '24px 4px', color: tokens.colorNeutralForeground3, textAlign: 'center' },
});

export function ActivityFeed({
  sinceMs,
  filter,
  onFilterChange,
  lastSeen,
  onNewestSeen,
  onOpenTask,
}: ActivityFeedProps): JSX.Element {
  const styles = useStyles();
  const transport = useTransport();

  const [state, setState] = useState<FeedState>(EMPTY_FEED);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [projectOptions, setProjectOptions] = useState<ProjectOption[]>([]);
  const [projectNames, setProjectNames] = useState<ReadonlyMap<string, string>>(new Map());
  // Null means "unknown" — never known to have deleted anything, so every task reads live
  // until the first successful `project:list` answer says otherwise.
  const [liveTaskIds, setLiveTaskIds] = useState<ReadonlySet<string> | null>(null);

  const issued = useRef(0);
  const latestFilter = useRef(filter);
  latestFilter.current = filter;
  const latestSinceMs = useRef(sinceMs);
  latestSinceMs.current = sinceMs;
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const lastReportedCursor = useRef<ActivityCursor | null>(null);

  const loadProjects = useCallback(() => {
    transport.invoke('project:list').then(
      (list) => {
        setProjectOptions(list.map((p) => ({ id: p.project.id, name: p.project.name })));
        setProjectNames(new Map(list.map((p) => [p.project.id, p.project.name])));
        setLiveTaskIds(new Set(list.flatMap((p) => p.tasks.map((t) => t.id))));
      },
      // A failed read never marks anything deleted — it just leaves the last known-good
      // set (or the initial "unknown" null) in place.
      () => undefined,
    );
  }, [transport]);

  const runLoad = useCallback(
    (opts: { reset: boolean; cursor?: string; mode: 'older' | 'head' }) => {
      const seq = ++issued.current;
      setState((prev) => feedLoadStarted(prev, seq, { reset: opts.reset }));
      const query = feedQueryFor(latestFilter.current, {
        sinceMs: latestSinceMs.current,
        cursor: opts.cursor,
      });
      transport.invoke('activity:list', query).then(
        (page) => {
          setState((prev) => feedPageArrived(prev, seq, page, opts.mode));
          setLoadError(null);
        },
        (error: unknown) => {
          if (isStaleCursorMessage(error)) {
            runLoad({ reset: true, mode: 'older' });
            return;
          }
          setState((prev) => (seq >= prev.applied ? { ...prev, loading: false } : prev));
          setLoadError(error instanceof Error ? error.message : String(error));
        },
      );
    },
    [transport],
  );

  const filterKey = feedFilterKey(filter);

  // The feed's first open, and every later filter or window change, starts a fresh page one.
  useEffect(() => {
    runLoad({ reset: true, mode: 'older' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterKey, sinceMs, runLoad]);

  useEffect(() => {
    loadProjects();
  }, [loadProjects]);

  // Re-reads page one on a cadence that speeds up while the window is visible — never a
  // fixed interval, since an idle background tab has no reason to poll every 2.5s.
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;

    const schedule = (): void => {
      const delay = document.visibilityState === 'visible' ? CADENCE_MS.active : CADENCE_MS.idle;
      timer = setTimeout(tick, delay);
    };
    const tick = (): void => {
      if (cancelled) return;
      runLoad({ reset: false, mode: 'head' });
      loadProjects();
      schedule();
    };

    schedule();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [runLoad, loadProjects]);

  useEffect(() => {
    const newest = feedNewestCursor(state);
    if (!newest) return;
    const prev = lastReportedCursor.current;
    if (prev && prev.at === newest.at && prev.id === newest.id) return;
    lastReportedCursor.current = newest;
    onNewestSeen?.(newest);
  }, [state, onNewestSeen]);

  const retry = useCallback(() => runLoad({ reset: true, mode: 'older' }), [runLoad]);

  const loadOlder = useCallback(() => {
    if (!state.nextCursor) return;
    runLoad({ reset: false, cursor: state.nextCursor, mode: 'older' });
  }, [runLoad, state.nextCursor]);

  const onScroll = useCallback((e: UIEvent<HTMLDivElement>) => {
    setState((prev) => feedScrolled(prev, e.currentTarget.scrollTop > SCROLL_AWAY_THRESHOLD));
  }, []);

  const showNew = useCallback(() => {
    setState((prev) => feedShowNew(prev));
    scrollRef.current?.scrollTo({ top: 0 });
  }, []);

  const resolveTarget = useCallback(
    (row: ActivityRow) => {
      if (liveTaskIds === null) {
        return row.taskId === null
          ? ({ kind: 'none' } as const)
          : ({ kind: 'open', taskId: row.taskId } as const);
      }
      return rowTarget(row, liveTaskIds);
    },
    [liveTaskIds],
  );

  if (state.loading && state.rows.length === 0) {
    return <PaneLoading label="Loading activity…" error={loadError} onRetry={retry} shape="rows" />;
  }

  const dividerIndex = feedDividerIndex(state.rows, lastSeen);
  const items = buildRenderItems(
    state.rows,
    dividerIndex,
    Date.now(),
    -new Date().getTimezoneOffset(),
  );
  const staged = feedStagedCount(state);

  return (
    <div className={styles.root}>
      <div className={styles.toolbar}>
        <Dropdown
          className={styles.picker}
          multiselect
          size="small"
          placeholder="Project"
          value={filter.projectIds.map((id) => projectNames.get(id) ?? id).join(', ')}
          selectedOptions={filter.projectIds}
          onOptionSelect={(_e, data) =>
            onFilterChange({ ...filter, projectIds: data.selectedOptions })
          }
        >
          {projectOptions.map((p) => (
            <Option key={p.id} value={p.id}>
              {p.name}
            </Option>
          ))}
        </Dropdown>
        <Dropdown
          className={styles.picker}
          multiselect
          size="small"
          placeholder="Kind"
          value={filter.kindGroups
            .map((g) => KIND_GROUP_OPTIONS.find((o) => o.value === g)?.label ?? g)
            .join(', ')}
          selectedOptions={filter.kindGroups}
          onOptionSelect={(_e, data) =>
            onFilterChange({ ...filter, kindGroups: data.selectedOptions as FeedKindGroup[] })
          }
        >
          {KIND_GROUP_OPTIONS.map((o) => (
            <Option key={o.value} value={o.value}>
              {o.label}
            </Option>
          ))}
        </Dropdown>
        <Dropdown
          className={styles.picker}
          multiselect
          size="small"
          placeholder="Outcome"
          value={filter.outcomes.map((o) => OUTCOME_OPTION_LABEL[o]).join(', ')}
          selectedOptions={filter.outcomes}
          onOptionSelect={(_e, data) =>
            onFilterChange({ ...filter, outcomes: data.selectedOptions as ActivityOutcome[] })
          }
        >
          {ACTIVITY_OUTCOMES.map((o) => (
            <Option key={o} value={o}>
              {OUTCOME_OPTION_LABEL[o]}
            </Option>
          ))}
        </Dropdown>
        <Dropdown
          className={styles.picker}
          multiselect
          size="small"
          placeholder="Origin"
          value={filter.origins.map((o) => originLabel(o) ?? o).join(', ')}
          selectedOptions={filter.origins}
          onOptionSelect={(_e, data) =>
            onFilterChange({ ...filter, origins: data.selectedOptions as FixedOrigin[] })
          }
        >
          {ORIGIN_OPTIONS.map((o) => (
            <Option key={o} value={o} text={originLabel(o) ?? o}>
              {originLabel(o)}
            </Option>
          ))}
        </Dropdown>
        <Button
          size="small"
          appearance="subtle"
          disabled={feedFilterIsEmpty(filter)}
          onClick={() => onFilterChange(EMPTY_FEED_FILTER)}
        >
          Clear filters
        </Button>
      </div>

      {staged > 0 && (
        <Button className={styles.newPill} size="small" shape="rounded" onClick={showNew}>
          {staged} new
        </Button>
      )}

      <div ref={scrollRef} className={styles.scroll} onScroll={onScroll}>
        {items.length === 0 ? (
          <Body1 className={styles.empty}>
            {feedFilterIsEmpty(filter)
              ? 'Nothing happened in this period'
              : 'No activity matches these filters'}
          </Body1>
        ) : (
          <>
            {items.map((item) => {
              if (item.type === 'day') {
                return (
                  <Caption1 key={item.key} className={styles.dayHeader}>
                    {item.label}
                  </Caption1>
                );
              }
              if (item.type === 'divider') {
                return (
                  <div key={item.key} className={styles.divider}>
                    <span className={styles.dividerLine} />
                    <Caption1>New since you were away</Caption1>
                    <span className={styles.dividerLine} />
                  </div>
                );
              }
              return (
                <FeedRowView
                  key={item.key}
                  row={item.row}
                  projectNames={projectNames}
                  target={resolveTarget(item.row)}
                  onOpenTask={onOpenTask}
                  className={styles.row}
                  styles={styles}
                />
              );
            })}
            {state.nextCursor ? (
              <Button appearance="subtle" size="small" onClick={loadOlder}>
                Load older
              </Button>
            ) : (
              <Caption1 className={styles.footer}>
                This is as far back as recorded history goes — activity from before the one-time
                backfill may be incomplete.
              </Caption1>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function FeedRowView({
  row,
  projectNames,
  target,
  onOpenTask,
  className,
  styles,
}: {
  row: ActivityRow;
  projectNames: ReadonlyMap<string, string>;
  target: ReturnType<typeof rowTarget>;
  onOpenTask?: (taskId: string) => void;
  className: string;
  styles: ReturnType<typeof useStyles>;
}): JSX.Element {
  const Icon = KIND_ICON[row.kind];
  const projectLabel = row.projectId ? (projectNames.get(row.projectId) ?? row.projectId) : null;
  const origin = originLabel(row.origin);
  const absolute = new Date(row.at).toLocaleString();

  const content = (
    <>
      <Icon className={styles.kindIcon} />
      <span className={styles.title}>{row.title}</span>
      <Caption1 className={styles.sentence}>{rowSentence(row)}</Caption1>
      {projectLabel && <span className={styles.chip}>{projectLabel}</span>}
      {origin && <span className={styles.chip}>{origin}</span>}
      <Tooltip content={absolute} relationship="label">
        <Caption1 className={styles.meta}>
          {relativeAge(Math.floor(row.at / 1000), Date.now())}
        </Caption1>
      </Tooltip>
      <Caption1 className={styles.cost}>{formatCost(row.costUsd)}</Caption1>
    </>
  );

  if (target.kind === 'open') {
    return (
      <button
        type="button"
        className={mergeClasses(className, styles.rowButton)}
        onClick={() => onOpenTask?.(target.taskId)}
      >
        {content}
      </button>
    );
  }

  if (target.kind === 'deleted') {
    return (
      <div className={mergeClasses(className, styles.rowDeleted)} aria-disabled="true">
        {content}
        <Caption1 className={styles.sentence}>This card no longer exists</Caption1>
      </div>
    );
  }

  return <div className={className}>{content}</div>;
}
