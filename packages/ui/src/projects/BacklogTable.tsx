/**
 * BacklogTable — every ticket in one native ticket project, grouped by STATUS (the default,
 * F13.15), EPIC or MILESTONE (the toolbar's "Group by" menu, remembered per device) and drawn
 * with `IssueRow` — the same row the mockups' Issues list uses, under one foldable `textMuted`
 * header per group instead of a Fluent `Table`'s header/group rows. Milestone mode nests epic
 * sub-headers the way the sidebar does; folds are per device under `tm.backlog.folds`.
 *
 * A row click opens the ticket in `Projects.tsx`'s own shared detail pane (F12.8) — this
 * component's job stays what it always was: the search box, the sort and group toggles, and
 * rendering `backlogGrouping`'s sections with `IssueRow`. Loading the project's tickets itself moved
 * to `useProjectTickets` (F13.13), so `Projects.tsx` can feed the same list into the issue
 * view reducer without a second fetch; this component takes the result as a `tickets` prop.
 *
 * Keyed by `projectId` at the call site (`Projects.tsx`) rather than reacting to it changing
 * in place: switching the selected project is rare enough that a remount — a fresh search and
 * sort state — is simpler than reconciling this component's state to a new project mid-life.
 */
import { type CSSProperties, type KeyboardEvent, type ReactNode, useMemo, useState } from 'react';
import {
  Button,
  Input,
  Menu,
  MenuButton,
  MenuItemRadio,
  MenuList,
  MenuPopover,
  MenuTrigger,
  ToggleButton,
  Body1,
  mergeClasses,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import {
  AddRegular,
  ChevronDownRegular,
  ChevronRightRegular,
  GroupListRegular,
  SearchRegular,
} from '@fluentui/react-icons';
import type { Milestone, Person, Project, Task } from '@tm/shared/model';
import { delegatedAgentName } from '@tm/shared/tickets';
import { archivedBy, type ArchiveIndex } from '@tm/shared/trackerArchive';
import { IssueRow } from '../issues/IssueRow';
import { indexIssueRows, type IssueRowContext, keyColumnWidth } from '../issues/issueRowParts';
import { useIssueRowFeeds } from '../issues/useIssueRowFeeds';
import { PaneLoading } from '../PaneLoading';
import { useDeviceFolds } from '../shell/sidebarFolds';
import {
  type BacklogGroupMode,
  type BacklogSection,
  backlogGroups,
  useBacklogGroupMode,
} from './backlogGrouping';
import { type BacklogSortKey } from './backlogView';
import { NewTicketDialog } from './NewTicketDialog';

/** The "Group by" menu's modes, in menu order — also the button's own visible text. */
const GROUP_MODE_LABEL: Record<BacklogGroupMode, string> = {
  status: 'Status',
  epic: 'Epic',
  milestone: 'Milestone',
};

const useStyles = makeStyles({
  // `minWidth: 0`: a flex item's default `min-width: auto` holds it to its content's
  // min-content size, which is exactly what let the toolbar below overflow this column's
  // own box — undetected, because nothing here clips — and bleed into the peek pane opening
  // beside it (`Projects.tsx`'s `.backlog` already shrinks; this is what refused to follow).
  root: { display: 'flex', flexDirection: 'column', gap: '10px', minHeight: 0, minWidth: 0 },
  // `flexWrap: 'wrap'`: once the column has actually shrunk, the toolbar's own buttons wrap
  // onto a second line rather than clipping — "Sort by due date" and "New ticket" staying
  // reachable instead of sitting, unreachable, under the peek.
  toolbar: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '8px' },
  search: { flex: 1, minWidth: '160px', maxWidth: '320px' },
  // The default flex-shrink let each button narrow past its own text's width before the row
  // ever wrapped — "Sort by due date" breaking word-by-word into an unreadable column rather
  // than moving to a second line as a whole. `flexShrink: 0` makes the wrap decision (above)
  // the only thing a tight column can do to these; shrinking the search box is still fine.
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
}: BacklogTableProps): JSX.Element {
  const styles = useStyles();
  const [query, setQuery] = useState('');
  const [sortKey, setSortKey] = useState<BacklogSortKey>('key');
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

  const sections = useMemo(
    () =>
      tickets
        ? backlogGroups(groupMode, {
            tickets,
            milestones,
            query,
            sortKey,
            archive: { index: archiveIndex, includeArchived },
          })
        : [],
    [groupMode, tickets, milestones, query, sortKey, archiveIndex, includeArchived],
  );
  const keyWidth = useMemo(
    () => ({ '--tm-key-width': keyColumnWidth(sectionKeys(sections)) }) as CSSProperties,
    [sections],
  );

  if (tickets === null) {
    return (
      <PaneLoading label="Loading backlog…" error={loadError} onRetry={loadRetry} shape="rows" />
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
      <div className={styles.toolbar}>
        <Input
          className={styles.search}
          contentBefore={<SearchRegular />}
          value={query}
          onChange={(_e, d) => setQuery(d.value)}
          placeholder="Search title, key or label…"
        />
        <ToggleButton
          className={styles.toolbarButton}
          size="small"
          appearance="subtle"
          checked={includeArchived}
          onClick={() => onIncludeArchivedChange(!includeArchived)}
        >
          Include archived
        </ToggleButton>
        <ToggleButton
          className={styles.toolbarButton}
          size="small"
          appearance="subtle"
          checked={sortKey === 'key'}
          onClick={() => setSortKey('key')}
        >
          Sort by key
        </ToggleButton>
        <ToggleButton
          className={styles.toolbarButton}
          size="small"
          appearance="subtle"
          checked={sortKey === 'due'}
          onClick={() => setSortKey('due')}
        >
          Sort by due date
        </ToggleButton>
        {/* One icon-only menu button, not a caption and three toggles: with the peek open at
            1440 those pushed "New ticket" onto a second toolbar line, and so did a button that
            still spelled out the current mode. The mode is in its `aria-label` and checked item. */}
        <Menu>
          <MenuTrigger disableButtonEnhancement>
            <MenuButton
              className={styles.toolbarButton}
              size="small"
              appearance="subtle"
              icon={<GroupListRegular />}
              title="Group by"
              aria-label={`Group by: ${GROUP_MODE_LABEL[groupMode]}`}
            />
          </MenuTrigger>
          <MenuPopover>
            <MenuList
              checkedValues={{ group: [groupMode] }}
              onCheckedValueChange={(_e, { checkedItems }) => {
                const next = checkedItems[0] as BacklogGroupMode | undefined;
                if (next && next !== groupMode) setGroupMode(next);
              }}
            >
              {(Object.keys(GROUP_MODE_LABEL) as BacklogGroupMode[]).map((mode) => (
                <MenuItemRadio key={mode} name="group" value={mode}>
                  {GROUP_MODE_LABEL[mode]}
                </MenuItemRadio>
              ))}
            </MenuList>
          </MenuPopover>
        </Menu>
        <Button
          className={styles.toolbarButton}
          size="small"
          appearance="primary"
          icon={<AddRegular />}
          onClick={() => setNewTicketDialog({ epicTaskId: null })}
        >
          New ticket
        </Button>
      </div>

      {tickets.length === 0 ? (
        <Body1 className={styles.empty}>No tickets in this project yet.</Body1>
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
