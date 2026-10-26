/**
 * BacklogTable — every ticket in one native ticket project, grouped by STATUS (the default,
 * F13.15), EPIC or MILESTONE (the toolbar's "Group by" menu, remembered per device) and drawn
 * with `IssueRow` — the same row the mockups' Issues list uses, under one foldable `textMuted`
 * header per group instead of a Fluent `Table`'s header/group rows. Milestone mode nests epic
 * sub-headers the way the sidebar does; folds are per device under `tm.backlog.folds`.
 *
 * A row click opens the ticket in `Projects.tsx`'s own shared detail pane (F12.8) — this
 * component's job stays what it always was: the list's ONE header row (`BacklogHeader`: the
 * project chip `Projects` hands in as `leading`, the "Issues" title, the Active / Backlog / All
 * tabs, a search icon that opens into the box, the "…" menu and "+"), and rendering
 * `backlogGrouping`'s sections with `IssueRow`. Loading the project's tickets itself moved
 * to `useProjectTickets` (F13.13), so `Projects.tsx` can feed the same list into the issue
 * view reducer without a second fetch; this component takes the result as a `tickets` prop.
 *
 * Keyed by `projectId` at the call site (`Projects.tsx`) rather than reacting to it changing
 * in place: switching the selected project is rare enough that a remount — a fresh search
 * state — is simpler than reconciling this component's state to a new project mid-life.
 */
import { type CSSProperties, type KeyboardEvent, type ReactNode, useMemo, useState } from 'react';
import {
  Button,
  Input,
  Body1,
  Text,
  mergeClasses,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import {
  AddRegular,
  ChevronDownRegular,
  ChevronRightRegular,
  SearchRegular,
} from '@fluentui/react-icons';
import type { Milestone, Person, Project, Task } from '@tm/shared/model';
import { delegatedAgentName } from '@tm/shared/tickets';
import { archivedBy, type ArchiveIndex } from '@tm/shared/trackerArchive';
import { IssueRow } from '../issues/IssueRow';
import { indexIssueRows, type IssueRowContext, keyColumnWidth } from '../issues/issueRowParts';
import { useIssueRowFeeds } from '../issues/useIssueRowFeeds';
import { useBoardLayoutStyles } from '../board/boardLayout';
import { PaneLoading } from '../PaneLoading';
import { useDeviceFolds } from '../shell/sidebarFolds';
import {
  type BacklogGroupMode,
  type BacklogSection,
  backlogGroups,
  useBacklogGroupMode,
} from './backlogGrouping';
import { BACKLOG_TAB_LABEL, type BacklogTab, ticketsForTab, useBacklogTab } from './backlogTabs';
import { IssueListMoreMenu, type IssueViewMenu } from './IssueListMoreMenu';
import { NewTicketDialog } from './NewTicketDialog';

const useStyles = makeStyles({
  // `minWidth: 0`: a flex item's default `min-width: auto` holds it to its content's
  // min-content size, which is exactly what let the toolbar below overflow this column's
  // own box — undetected, because nothing here clips — and bleed into the peek pane opening
  // beside it (`Projects.tsx`'s `.backlog` already shrinks; this is what refused to follow).
  root: { display: 'flex', flexDirection: 'column', gap: '10px', minHeight: 0, minWidth: 0 },
  // One row, never two (v9-1/v9-3): the project chip, the title and tabs on the left, a
  // spacer, then search, "…" and "+". `nowrap`, because a wrapped header pushed "+" onto a
  // second line under the peek at 1100px; what gives instead is the open search box, down to
  // its floor. Every other item is `flexShrink: 0`, so nothing narrows past its own text.
  toolbar: {
    display: 'flex',
    flexWrap: 'nowrap',
    alignItems: 'center',
    gap: '6px',
    minWidth: 0,
  },
  title: {
    flexShrink: 0,
    margin: '0 2px 0 0',
    fontSize: tokens.fontSizeBase500,
    lineHeight: tokens.lineHeightBase500,
    fontWeight: tokens.fontWeightSemibold,
    color: `var(--tm-text, ${tokens.colorNeutralForeground1})`,
  },
  spacer: { flex: 1, minWidth: 0 },
  // The floor is what the list card has left with the peek open at 1100px: a 140px floor held
  // the search whole and pushed "…" and "+" out past the card's edge instead.
  search: { flex: '0 1 240px', minWidth: '80px' },
  toolbarButton: { flexShrink: 0 },
  scroll: {
    overflowY: 'auto',
    minHeight: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: '12px',
  },
  group: { display: 'flex', flexDirection: 'column', gap: '2px' },
  // A milestone's epic sub-headers (and their rows) sit one step in from the milestone's own.
  // `marginTop` parts a milestone header from its first epic sub-header, and sub-groups from
  // each other.
  subGroup: { paddingLeft: '16px', marginTop: '6px' },
  groupHeader: { display: 'flex', alignItems: 'center', gap: '4px' },
  // The fold toggle IS the caption: same muted semibold text as the old static caption, now a
  // real `<button>` so it is reachable by Tab and announces `aria-expanded`.
  groupCaption: {
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
    padding: '0 10px 0 6px',
    border: 'none',
    background: 'none',
    cursor: 'pointer',
    borderRadius: tokens.borderRadiusMedium,
    fontFamily: 'inherit',
    fontSize: tokens.fontSizeBase200,
    fontWeight: tokens.fontWeightSemibold,
    color: `var(--tm-text-muted, ${tokens.colorNeutralForeground3})`,
    '& svg': { fontSize: '12px', flexShrink: 0 },
    ':hover': { color: tokens.colorNeutralForeground2 },
  },
  groupCount: { fontWeight: tokens.fontWeightRegular },
  addChild: { minWidth: 0 },
  empty: { color: tokens.colorNeutralForeground3, padding: '8px 0' },
});

/** Every row under `section`, its sub-sections' included — the header's count. */
function sectionRowCount(section: BacklogSection): number {
  return section.sections.reduce((n, s) => n + sectionRowCount(s), section.tickets.length);
}

/** Every row's key under `sections`, sub-sections' included — what `keyColumnWidth` sizes. */
function sectionKeys(sections: readonly BacklogSection[]): string[] {
  return sections.flatMap((s) => [
    ...s.tickets.map((t) => t.ticketKey ?? t.externalKey ?? ''),
    ...sectionKeys(s.sections),
  ]);
}

/**
 * A fold header's own keys: Enter and Space toggle it, and both are `preventDefault()`ed —
 * Space so it never bubbles on to `Projects.tsx`'s pane-level Space-peek (which skips an
 * event already defaulted), Enter so the browser does not ALSO synthesise a click on the
 * button and toggle it straight back. Everything else (Escape, arrows) passes through.
 */
export function onSectionHeaderKeyDown(
  e: Pick<KeyboardEvent, 'key' | 'preventDefault'>,
  toggle: () => void,
): void {
  if (e.key !== ' ' && e.key !== 'Enter') return;
  e.preventDefault();
  toggle();
}

export interface BacklogSectionViewProps {
  section: BacklogSection;
  /** This device's folded section ids (`useDeviceFolds`) — absent means unfolded. */
  folded: ReadonlySet<string>;
  onToggleFold: (id: string) => void;
  /** A real epic header's "Add child" — opens `NewTicketDialog` filed under that epic. */
  onAddChild: (epicId: string) => void;
  renderRow: (ticket: Task) => ReactNode;
}

/** One header and, unless folded, its rows and sub-sections — hook-free, so it renders
 *  statically under test. */
export function BacklogSectionView({
  section,
  folded,
  onToggleFold,
  onAddChild,
  renderRow,
}: BacklogSectionViewProps): JSX.Element {
  const styles = useStyles();
  const isFolded = folded.has(section.id);
  const toggle = (): void => onToggleFold(section.id);
  const addChildEpicId = section.addChildEpicId;
  return (
    <div
      className={mergeClasses(styles.group, section.level === 2 && styles.subGroup)}
      data-backlog-section-level={section.level}
    >
      <div className={styles.groupHeader}>
        <button
          type="button"
          className={styles.groupCaption}
          aria-expanded={!isFolded}
          onClick={toggle}
          onKeyDown={(e) => onSectionHeaderKeyDown(e, toggle)}
        >
          {isFolded ? <ChevronRightRegular /> : <ChevronDownRegular />}
          <span>{section.label}</span>
          <span className={styles.groupCount}>{sectionRowCount(section)}</span>
        </button>
        {addChildEpicId && (
          <Button
            className={styles.addChild}
            size="small"
            appearance="subtle"
            icon={<AddRegular />}
            aria-label={`Add child to ${section.label}`}
            title="Add child"
            onClick={() => onAddChild(addChildEpicId)}
          />
        )}
      </div>
      {!isFolded && (
        <>
          {section.tickets.map(renderRow)}
          {section.sections.map((sub) => (
            <BacklogSectionView
              key={sub.id}
              section={sub}
              folded={folded}
              onToggleFold={onToggleFold}
              onAddChild={onAddChild}
              renderRow={renderRow}
            />
          ))}
        </>
      )}
    </div>
  );
}

export interface BacklogHeaderProps {
  /** Drawn first in the row — `Projects` hands in its project chip (`ProjectSwitcher`). */
  leading?: ReactNode;
  tab: BacklogTab;
  onTabChange: (tab: BacklogTab) => void;
  query: string;
  onQueryChange: (query: string) => void;
  /** The search box is open. It also stays open while `query` holds anything. */
  searchOpen: boolean;
  onSearchOpenChange: (open: boolean) => void;
  groupMode: BacklogGroupMode;
  onGroupModeChange: (mode: BacklogGroupMode) => void;
  includeArchived: boolean;
  onIncludeArchivedChange: (includeArchived: boolean) => void;
  /** `Projects`'s View switch and ticket-panel toggle, folded into the same "…". */
  viewMenu?: IssueViewMenu;
  onNewTicket: () => void;
  /** Test only: render the "…" menu open, in place. */
  menuOpen?: boolean;
}

/**
 * The Backlog's one header row (v9-1/v9-3) — hook-free past its styles, so it renders
 * statically under test. Search is an icon button until it is wanted: the always-open box was
 * the widest thing in the row, for a filter used now and then. Opening it focuses the box;
 * leaving it empty (blur, or Escape) folds it back to the icon.
 */
export function BacklogHeader({
  leading,
  tab,
  onTabChange,
  query,
  onQueryChange,
  searchOpen,
  onSearchOpenChange,
  groupMode,
  onGroupModeChange,
  includeArchived,
  onIncludeArchivedChange,
  viewMenu,
  onNewTicket,
  menuOpen,
}: BacklogHeaderProps): JSX.Element {
  const styles = useStyles();
  const layout = useBoardLayoutStyles();
  const showSearch = searchOpen || query !== '';
  return (
    <div className={styles.toolbar} data-backlog-header="">
      {leading}
      <Text as="h2" className={styles.title}>
        Issues
      </Text>
      <div className={layout.tabs} role="tablist" aria-label="Which issues">
        {(Object.keys(BACKLOG_TAB_LABEL) as BacklogTab[]).map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={t === tab}
            className={mergeClasses(layout.tab, t === tab && layout.tabSelected)}
            onClick={() => onTabChange(t)}
          >
            {BACKLOG_TAB_LABEL[t]}
          </button>
        ))}
      </div>
      <div className={styles.spacer} />
      {showSearch ? (
        <Input
          className={styles.search}
          size="small"
          contentBefore={<SearchRegular />}
          value={query}
          onChange={(_e, d) => onQueryChange(d.value)}
          onBlur={() => {
            if (query === '') onSearchOpenChange(false);
          }}
          onKeyDown={(e) => {
            if (e.key !== 'Escape') return;
            // Defaulted, so `Projects.tsx`'s pane-level Escape does not also close the peek.
            e.preventDefault();
            onQueryChange('');
            onSearchOpenChange(false);
          }}
          placeholder="Search title, key or label…"
          aria-label="Search issues"
          // Opened by a click on the icon a moment ago — the box is what was asked for.
          autoFocus
        />
      ) : (
        <Button
          className={styles.toolbarButton}
          size="small"
          appearance="subtle"
          icon={<SearchRegular />}
          title="Search"
          aria-label="Search issues"
          onClick={() => onSearchOpenChange(true)}
        />
      )}
      <IssueListMoreMenu
        viewMenu={viewMenu}
        groupBy={{ mode: groupMode, onChange: onGroupModeChange }}
        includeArchived={{ checked: includeArchived, onChange: onIncludeArchivedChange }}
        open={menuOpen}
        inline={menuOpen}
      />
      <Button
        className={styles.toolbarButton}
        size="small"
        appearance="primary"
        icon={<AddRegular />}
        title="New ticket"
        aria-label="New ticket"
        onClick={onNewTicket}
      />
    </div>
  );
}

export interface BacklogTableProps {
  projectId: string;
  /** This project's tickets (`useProjectTickets`), or `null` while the seed is still
   *  loading. */
  tickets: Task[] | null;
  /** The seed's own failure, for the loading skeleton's retry — see `loadRetry`. */
  loadError: string | null;
  /** Re-run `useProjectTickets`'s seed — wired to the loading skeleton's Retry button. */
  loadRetry: () => void;
  /** App-wide roster, for the assignee column. */
  people: Person[];
  /** App-wide milestones — the "Group by Milestone" headers and their order. */
  milestones: Milestone[];
  /** The repos a ticket can be delegated to — resolves `agentProjectId` to a name for the
   *  assignee column's `<human> / <agent>` display. */
  agentProjects: Project[];
  /** The ticket open in `Projects.tsx`'s own shared detail pane — highlights its row. */
  selectedTicketId?: string | null;
  /** A row click — opens (or keeps) the ticket as a peek. */
  onSelectTicket: (id: string) => void;
  /** A row's Enter/double-click — opens the ticket straight to full screen. */
  onOpenTicket: (id: string) => void;
  /** `Projects.tsx`'s own archive lookup (F14.6) — built once per project switch, over the
   *  project's milestones, epics and tracker projects. */
  archiveIndex: ArchiveIndex;
  /** Whether archived tickets are shown at all — off by default, the same "Include archived"
   *  switch the Archived view and a direct link already flip. */
  includeArchived: boolean;
  onIncludeArchivedChange: (includeArchived: boolean) => void;
  /** Drawn first in the header row — `Projects`'s project chip. */
  leading?: ReactNode;
  /** `Projects`'s View switch and ticket-panel toggle, for the header's "…". */
  viewMenu?: IssueViewMenu;
}

/** The agent delegated to a ticket, by name — `undefined` for anything not native or
 *  not delegated, the same `delegatedAgentName` gate `TaskCard` applies before showing one. */
function agentNameOf(agentProjects: Project[], ticket: Task): string | undefined {
  return delegatedAgentName(
    ticket,
    agentProjects.find((p) => p.id === ticket.agentProjectId)?.name,
  );
}

export function BacklogTable({
  projectId,
  tickets,
  loadError,
  loadRetry,
  people,
  milestones,
  agentProjects,
  selectedTicketId,
  onSelectTicket,
  onOpenTicket,
  archiveIndex,
  includeArchived,
  onIncludeArchivedChange,
  leading,
  viewMenu,
}: BacklogTableProps): JSX.Element {
  const styles = useStyles();
  const [query, setQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [tab, setTab] = useBacklogTab();
  const [groupMode, setGroupMode] = useBacklogGroupMode();
  const [folds, toggleFold] = useDeviceFolds('tm.backlog.folds');
  const foldedSet = useMemo(() => new Set(folds), [folds]);
  /** `NewTicketDialog`'s own open state — `null` means closed; `epicTaskId: null` is the
   *  toolbar's plain "New ticket", an id is an epic header's "Add child" (Epic and Milestone
   *  grouping only — a status column heads no epic). */
  const [newTicketDialog, setNewTicketDialog] = useState<{ epicTaskId: string | null } | null>(
    null,
  );

  // The board's own run, MR and merge feeds, so a row's "Step n of m" pill and PR ref read
  // exactly what the ticket's card does. See `useIssueRowFeeds`.
  const { liveRunTaskIds, mergeRequests, mergingTaskIds } = useIssueRowFeeds();
  const rowIndex = useMemo(
    () => indexIssueRows(tickets ?? [], mergeRequests),
    [tickets, mergeRequests],
  );

  // The tab first, so whichever grouping is picked only ever sees the tab's tickets. Rows read
  // in key order: the sort strip went with the tabs (v9-1 has none).
  const sections = useMemo(
    () =>
      tickets
        ? backlogGroups(groupMode, {
            tickets: ticketsForTab(tickets, tab),
            milestones,
            query,
            sortKey: 'key',
            archive: { index: archiveIndex, includeArchived },
          })
        : [],
    [groupMode, tickets, tab, milestones, query, archiveIndex, includeArchived],
  );
  const keyWidth = useMemo(
    () => ({ '--tm-key-width': keyColumnWidth(sectionKeys(sections)) }) as CSSProperties,
    [sections],
  );

  // Drawn while the seed loads too: the chip and the view switch live in this row now, so a
  // slow load must not take the way to another project or view away with it.
  const header = (
    <BacklogHeader
      leading={leading}
      tab={tab}
      onTabChange={setTab}
      query={query}
      onQueryChange={setQuery}
      searchOpen={searchOpen}
      onSearchOpenChange={setSearchOpen}
      groupMode={groupMode}
      onGroupModeChange={setGroupMode}
      includeArchived={includeArchived}
      onIncludeArchivedChange={onIncludeArchivedChange}
      viewMenu={viewMenu}
      onNewTicket={() => setNewTicketDialog({ epicTaskId: null })}
    />
  );

  if (tickets === null) {
    return (
      <div className={styles.root}>
        {header}
        <PaneLoading label="Loading backlog…" error={loadError} onRetry={loadRetry} shape="rows" />
      </div>
    );
  }

  const renderRow = (ticket: Task): JSX.Element => {
    const assignee = ticket.assigneeId ? people.find((p) => p.id === ticket.assigneeId) : undefined;
    const ctx: IssueRowContext = {
      now: Date.now(),
      assignee,
      agentName: agentNameOf(agentProjects, ticket),
      subtasks: rowIndex.subtasksByParent.get(ticket.id),
      mergeRequests: rowIndex.mergeRequestsByTask.get(ticket.id),
      liveRunTaskIds,
      mergingTaskIds,
    };
    return (
      <IssueRow
        key={ticket.id}
        task={ticket}
        ctx={ctx}
        selected={ticket.id === selectedTicketId}
        archived={includeArchived && archivedBy(ticket, archiveIndex) !== null}
        onSelect={onSelectTicket}
        onOpen={onOpenTicket}
      />
    );
  };

  return (
    <div className={styles.root}>
      {header}

      {tickets.length === 0 || sections.length === 0 ? (
        <Body1 className={styles.empty}>
          {tickets.length === 0 ? 'No tickets in this project yet.' : 'No tickets here.'}
        </Body1>
      ) : (
        <div
          className={styles.scroll}
          style={keyWidth}
          role="listbox"
          data-backlog-group-mode={groupMode}
        >
          {sections.map((section) => (
            <BacklogSectionView
              key={section.id}
              section={section}
              folded={foldedSet}
              onToggleFold={toggleFold}
              onAddChild={(epicId) => setNewTicketDialog({ epicTaskId: epicId })}
              renderRow={renderRow}
            />
          ))}
        </div>
      )}

      <NewTicketDialog
        open={newTicketDialog !== null}
        projectId={projectId}
        tickets={tickets}
        defaultEpicTaskId={newTicketDialog?.epicTaskId ?? null}
        onClose={() => setNewTicketDialog(null)}
      />
    </div>
  );
}
