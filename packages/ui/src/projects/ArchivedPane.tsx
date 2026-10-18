/**
 * ArchivedPane — the Archived view (F14.8): every archived milestone, epic and ticket
 * project in one list, a `TabList` switching between the three, each row restorable in one
 * click. Reached from the sidebar's own "Archived" row (`projectId: null`, every project's
 * rows) or from `Projects.tsx`'s own view switcher (scoped to the open ticket project). Named
 * `ArchivedPane` rather than the `ArchivedView` the ticket names: `archivedView.ts` (the pure
 * model this file reads) already owns that name, and the two would collide on any
 * case-insensitive filesystem (confirmed here — `tsc` refuses the pair outright on Windows) —
 * the same `Table`/`Pane` suffix `BacklogTable.tsx`/`TimelinePane.tsx` already use beside
 * their own `backlogView.ts`-shaped modules.
 *
 * Loads `archive:list()` and `board:tasks('all')` itself — UNSCOPED, both of them, regardless
 * of `projectId` — and lets `archivedViewModel` do the narrowing: milestones and epics scope
 * to `projectId` the same way the Backlog/Timeline/Graph do, but the Projects tab always lists
 * every archived ticket project, the same "never scoped" rule `archivedViewModel`'s own doc
 * states. Passing `projectId` to `archive:list` itself would additionally filter the PROJECT
 * rows down to `id = projectId` server-side (`store.ts`'s `selectArchivedProjects`), which
 * would leave the Projects tab showing at most the one project already open — not what the
 * mockup draws.
 *
 * `ArchivedRowView` is deliberately hook-free (no `useState`/`useEffect`/`useContext` of its
 * own) — the same reason `StepRow`/`GateRow` (`TaskSteps.tsx`) are split out from the section
 * that loads their data: `ArchivedPane.render.test.tsx` drives its `expanded`/`busy`/
 * `refusalMessage` props directly through `renderToStaticMarkup`, the same way those two rows
 * are tested, rather than simulating the click or transport round trip that would produce
 * them — this package has no DOM testing library to fire either through.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  Body1,
  Button,
  Caption1,
  MessageBar,
  MessageBarBody,
  Tab,
  TabList,
  Title3,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import {
  ArrowUndoRegular,
  ChevronDownRegular,
  ChevronRightRegular,
  FlagRegular,
  FolderRegular,
  InfoRegular,
} from '@fluentui/react-icons';
import type { ArchiveResult, ArchiveTarget } from '@tm/shared/trackerArchive';
import { IssueRow } from '../issues/IssueRow';
import { PaneLoading } from '../PaneLoading';
import { useTransport } from '../transport';
import { useInitialLoad } from '../useInitialLoad';
import {
  archivedTicketSummary,
  archivedViewModel,
  type ArchivedRow,
  type ArchivedTab,
  type ArchivedViewModel,
} from './archivedView';
import { issueTypeGlyph } from './issueTypeGlyph';

const TAB_LABEL: Record<ArchivedTab, string> = {
  milestone: 'Milestones',
  epic: 'Epics',
  project: 'Projects',
};

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: '10px', minHeight: 0, height: '100%' },
  info: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    color: `var(--tm-text-muted, ${tokens.colorNeutralForeground3})`,
    '& svg': { flexShrink: 0, fontSize: '16px' },
  },
  table: { display: 'flex', flexDirection: 'column', gap: '2px', overflowY: 'auto', minHeight: 0 },
  group: { display: 'flex', flexDirection: 'column' },
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
    padding: '8px 10px',
    borderRadius: tokens.borderRadiusMedium,
  },
  chevron: {
    width: '20px',
    height: '20px',
    flexShrink: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    border: 'none',
    background: 'none',
    padding: 0,
    cursor: 'pointer',
    color: `var(--tm-text-muted, ${tokens.colorNeutralForeground3})`,
  },
  glyph: {
    display: 'flex',
    flexShrink: 0,
    fontSize: '16px',
    color: `var(--tm-text-muted, ${tokens.colorNeutralForeground3})`,
  },
  name: {
    flex: 1,
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  dates: {
    width: '140px',
    flexShrink: 0,
    color: `var(--tm-text-muted, ${tokens.colorNeutralForeground3})`,
  },
  summary: {
    width: '160px',
    flexShrink: 0,
    color: `var(--tm-text-muted, ${tokens.colorNeutralForeground3})`,
  },
  archivedAt: {
    width: '140px',
    flexShrink: 0,
    color: `var(--tm-text-muted, ${tokens.colorNeutralForeground3})`,
  },
  tickets: { display: 'flex', flexDirection: 'column', paddingLeft: '52px' },
  empty: { color: `var(--tm-text-muted, ${tokens.colorNeutralForeground3})`, padding: '8px 4px' },
});

function rowGlyph(kind: ArchivedTab): JSX.Element {
  if (kind === 'milestone') return <FlagRegular />;
  if (kind === 'epic') return issueTypeGlyph('epic');
  return <FolderRegular />;
}

/** A row's own date, formatted for display — `null` (an epic or a project row, or a
 *  milestone with no due date) reads as an em dash rather than an empty cell. */
function dateLabel(epochMs: number | null): string {
  if (epochMs == null) return '—';
  return new Date(epochMs).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

export interface ArchivedPaneProps {
  /** Scopes the Milestones/Epics tabs the same way the Backlog/Timeline/Graph are scoped —
   *  `null` (the sidebar's own "Archived" row) lists every project's. The Projects tab is
   *  never scoped by this, see this file's own header. */
  projectId: string | null;
  onSelectTicket: (id: string) => void;
  selectedTicketId?: string | null;
  /** A project row was restored — the caller's own project list (`Projects.tsx`'s
   *  `initial.retry`) needs a re-read the same way archiving one already does
   *  (`useArchiveAction`'s own `onRestored`). */
  onProjectsChanged?: () => void;
}

export function ArchivedPane({
  projectId,
  onSelectTicket,
  selectedTicketId,
  onProjectsChanged,
}: ArchivedPaneProps): JSX.Element {
  const styles = useStyles();
  const transport = useTransport();
  const [tab, setTab] = useState<ArchivedTab>('milestone');
  const [model, setModel] = useState<ArchivedViewModel | null>(null);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [busyId, setBusyId] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<{ id: string; message: string } | null>(null);

  const seed = useCallback(async () => {
    const [listing, tickets] = await Promise.all([
      transport.invoke('archive:list'),
      transport.invoke('board:tasks', 'all'),
    ]);
    setModel(archivedViewModel(listing, tickets, projectId));
  }, [transport, projectId]);
  const initial = useInitialLoad(seed);

  useEffect(() => {
    const offMilestones = transport.on('milestone:changed', () => void initial.retry());
    const offTasks = transport.on('project:tasksChanged', () => void initial.retry());
    return () => {
      offMilestones();
      offTasks();
    };
  }, [transport, initial.retry]);

  const toggleExpand = useCallback((id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const restore = useCallback(
    async (target: ArchiveTarget) => {
      setBusyId(target.id);
      setRefusal(null);
      try {
        const result: ArchiveResult = await transport.invoke('archive:restore', target);
        if (!result.ok) {
          setRefusal({ id: target.id, message: result.message });
          return;
        }
        await seed();
        if (target.kind === 'project') onProjectsChanged?.();
      } finally {
        setBusyId(null);
      }
    },
    [transport, seed, onProjectsChanged],
  );

  if (model === null) {
    return (
      <PaneLoading
        label="Loading archived items…"
        error={initial.error}
        onRetry={initial.retry}
        shape="rows"
      />
    );
  }

  const rows: ArchivedRow[] =
    tab === 'milestone' ? model.milestones : tab === 'epic' ? model.epics : model.projects;

  return (
    <div className={styles.root}>
      <Title3>Archived</Title3>

      <TabList selectedValue={tab} onTabSelect={(_e, data) => setTab(data.value as ArchivedTab)}>
        {(['milestone', 'epic', 'project'] as const).map((kind) => (
          <Tab key={kind} value={kind}>
            {TAB_LABEL[kind]}
          </Tab>
        ))}
      </TabList>

      <div className={styles.info}>
        <InfoRegular />
        <Caption1>
          Archived items are hidden from the tree, board, timeline and pickers. Links still open
          them, and tickets stay editable.
        </Caption1>
      </div>

      {rows.length === 0 ? (
        <Body1 className={styles.empty}>Nothing archived here yet.</Body1>
      ) : (
        <div className={styles.table} role="table" aria-label={TAB_LABEL[tab]}>
          {rows.map((row) => (
            <ArchivedRowView
              key={row.id}
              row={row}
              expanded={expanded.has(row.id)}
              onToggleExpand={() => toggleExpand(row.id)}
              busy={busyId === row.id}
              refusalMessage={refusal?.id === row.id ? refusal.message : null}
              onRestore={restore}
              onSelectTicket={onSelectTicket}
              selectedTicketId={selectedTicketId}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export interface ArchivedRowViewProps {
  row: ArchivedRow;
  expanded: boolean;
  onToggleExpand: () => void;
  busy: boolean;
  /** Non-null only once THIS row's own restore came back refused — `ArchivedPane` keys its
   *  single `refusal` state by row id so a refusal on one row never bleeds onto another's. */
  refusalMessage: string | null;
  onRestore: (target: ArchiveTarget) => void;
  onSelectTicket: (id: string) => void;
  selectedTicketId?: string | null;
}

/** One archived row, plus its expanded tickets — hook-free, see this file's own header. */
export function ArchivedRowView({
  row,
  expanded,
  onToggleExpand,
  busy,
  refusalMessage,
  onRestore,
  onSelectTicket,
  selectedTicketId,
}: ArchivedRowViewProps): JSX.Element {
  const styles = useStyles();
  const hasTickets = row.tickets.length > 0;

  return (
    <div className={styles.group}>
      <div className={styles.row} role="row">
        <button
          type="button"
          className={styles.chevron}
          aria-label={expanded ? `Collapse ${row.name}` : `Expand ${row.name}`}
          aria-expanded={hasTickets ? expanded : undefined}
          disabled={!hasTickets}
          onClick={onToggleExpand}
        >
          {hasTickets ? expanded ? <ChevronDownRegular /> : <ChevronRightRegular /> : null}
        </button>
        <span className={styles.glyph}>{rowGlyph(row.kind)}</span>
        <span className={styles.name}>{row.name}</span>
        <Caption1 className={styles.dates}>{dateLabel(row.dueAt)}</Caption1>
        <Caption1 className={styles.summary}>{archivedTicketSummary(row)}</Caption1>
        <Caption1 className={styles.archivedAt}>{dateLabel(row.archivedAt)}</Caption1>
        <Button
          size="small"
          appearance="outline"
          icon={<ArrowUndoRegular />}
          disabled={busy}
          onClick={() => onRestore({ kind: row.kind, id: row.id })}
        >
          Restore
        </Button>
      </div>

      {refusalMessage && (
        <MessageBar intent="warning">
          <MessageBarBody>{refusalMessage}</MessageBarBody>
        </MessageBar>
      )}

      {expanded && hasTickets && (
        <div className={styles.tickets}>
          {row.tickets.map((ticket) => (
            <IssueRow
              key={ticket.id}
              task={ticket}
              ctx={{ now: Date.now() }}
              selected={ticket.id === selectedTicketId}
              onSelect={onSelectTicket}
            />
          ))}
        </div>
      )}
    </div>
  );
}
