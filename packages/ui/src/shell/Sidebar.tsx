/**
 * Sidebar — the milestone/epic/ticket tree plus the fixed rows around it (Inbox, My issues,
 * Reviews, Archived, "This machine"), both hosts render from `sidebarModel.ts`'s
 * `buildSidebar` output (F13.11). Transparent, sitting directly on the canvas the same way
 * `NavRail` does — no pane of its own, per F13's design doc (only a *pane* gets glass; see
 * `GlassPane.tsx`'s own restraint rules).
 *
 * The tree is a hand-rolled `role="tree"`/`"treeitem"` with roving tabindex, driven by
 * `sidebarTree.ts`'s pure `flattenVisible`/`treeKeyReducer` — not Fluent's own `Tree`, because
 * Home/End/type-ahead/the exact Arrow-key rules are the whole point and `sidebarTree.ts` is
 * what is actually tested against them. A plain `div`, not a `<button>`: the keyboard handling
 * below owns Enter/Space itself (an `activate`), and a native button would fire its own click
 * synthesis from the same keystroke before this component's handler ever saw it stopped.
 *
 * `onNavigate`'s targets are the destinations F13.11 moved out of the rail's own `interim`
 * group (`shellNav.ts`'s own header): Inbox/My issues/Reviews from the fixed `views` section,
 * Issues/Fleet/Projects from the small icon row in the team header (revealed on hover or
 * focus — the v9 header shows only its label at rest), and a `This machine` project row. A
 * ticket node opens through `onOpenTicket` instead — it is a card, not a screen.
 *
 * The tree is windowed (F29.3): `SidebarTree` mounts only the rows in view of `styles.scroll`,
 * plus an overscan, the roving-focus row and the selected one. Its box keeps the height every
 * row would take, so Archived and "This machine" below it sit where they always did.
 */
import {
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import {
  Body1,
  Button,
  Caption1,
  Menu,
  MenuButton,
  MenuItemRadio,
  MenuList,
  MenuPopover,
  MenuTrigger,
  makeStyles,
  mergeClasses,
  tokens,
} from '@fluentui/react-components';
import {
  AddRegular,
  ArchiveRegular,
  BotRegular,
  BranchRegular,
  ChevronDownRegular,
  ChevronRightRegular,
  FlagRegular,
  FolderRegular,
  LaptopRegular,
  MailInboxRegular,
  SearchRegular,
  TaskListSquareLtrRegular,
  TicketDiagonalRegular,
} from '@fluentui/react-icons';
import { columnForStatus } from '@tm/shared/board';
import { STATUS_GLYPH } from '../issues/IssueRow';
import { useGlobalShortcut } from '../palette/shortcut';
import { shortcutLabel } from '../palette/shortcutLabel';
import { issueTypeGlyph } from '../projects/issueTypeGlyph';
import { STATUS_LABEL } from '../taskStatus';
import type {
  SidebarSection,
  SidebarTreeNode,
  SidebarView as ViewRow,
  SidebarWorkspace,
} from './sidebarModel';
import {
  flattenVisible,
  focusIndexOf,
  pinnedTreeRows,
  treeKeyReducer,
  type SidebarVisibleRow,
  type TreeKeyState,
} from './sidebarTree';
import type { TrackerProjectOption } from './useTrackerProject';
import { useStableCallback } from '../useStableCallback';
import { useWindowedList } from '../virtual/useWindowedList';

/** Everywhere `onNavigate` can send a host — every destination `shellNav.ts`'s now-deleted
 *  `interim` group used to carry a rail tile for, reached from the sidebar instead. */
export type SidebarNavTarget =
  | { kind: 'inbox' }
  | { kind: 'myIssues' }
  | { kind: 'reviews' }
  | { kind: 'issues' }
  | { kind: 'fleet' }
  | { kind: 'projects' }
  | { kind: 'archived' }
  | { kind: 'machineProject'; projectId: string };

/** `onNavigate`'s targets, plus the one more thing a row can be selected FOR that is not a
 *  navigation at all — the open ticket, highlighted in the tree. */
export type SidebarSelection = SidebarNavTarget | { kind: 'ticket'; taskId: string };

export interface SidebarProps {
  sections: SidebarSection[];
  /** Which row reads as the current one — `null` while nothing here is the active screen. */
  selectedView: SidebarSelection | null;
  onNavigate: (target: SidebarNavTarget) => void;
  onOpenTicket: (taskId: string) => void;
  onNewIssue: () => void;
  /** Toggles a node's fold state against its own default (`node.defaultFolded`) — the
   *  caller (`useDeviceFolds`'s own `toggleFold`) only records an id when the new state
   *  differs from that default. */
  onToggleFold: (id: string, defaultFolded?: boolean) => void;
  /** The web's cross-project destination the desktop does not have at all (`shellNav.ts`'s
   *  own F13.8 header) — off by default, so the desktop need not pass anything to hide it. */
  showFleet?: boolean;
  /** The ticket projects a switcher can offer in place of the team header's plain caption —
   *  `useTrackerProject`'s own `projectOptions`. */
  projectOptions?: TrackerProjectOption[];
  /** Which of `projectOptions` is checked in the switcher. */
  selectedProjectId?: string | null;
  /** Switches the tracker project; the switcher only renders once this is passed AND
   *  `projectOptions` is non-empty — otherwise the team header keeps its plain caption. */
  onSelectProject?: (id: string) => void;
  /** True while the project list has not loaded yet — holds off the "no tickets" empty
   *  state so a still-loading tree does not flash it first. */
  loading?: boolean;
  /** Opens the command palette from v9-1's header search icon — the icon only renders once
   *  this is passed. */
  onSearch?: () => void;
}

const useStyles = makeStyles({
  root: {
    display: 'flex',
    flexDirection: 'column',
    width: '260px',
    flexShrink: 0,
    overflow: 'hidden',
    // Transparent, on the canvas — see this file's own header.
    backgroundColor: 'transparent',
    borderRight: `1px solid var(--tm-text-faint)`,
    paddingTop: '8px',
  },
  workspace: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    padding: '4px 8px 12px 12px',
    color: 'var(--tm-text)',
  },
  /** v9-1's 26px neutral initial tile, radius 7 — the workspace's first letter. */
  workspaceTile: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '26px',
    height: '26px',
    flexShrink: 0,
    borderRadius: '7px',
    backgroundColor: tokens.colorNeutralBackground3,
    color: tokens.colorNeutralForeground2,
    fontSize: '12px',
    fontWeight: tokens.fontWeightSemibold,
  },
  workspaceText: { display: 'flex', flexDirection: 'column', minWidth: 0, flex: 1 },
  workspaceName: {
    fontSize: '13px',
    lineHeight: '17px',
    fontWeight: tokens.fontWeightSemibold,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  /** v9-1's 10.5px muted line — "Cloud" or "Local". */
  workspaceSub: { color: 'var(--tm-text-muted)', fontSize: '10.5px', lineHeight: '14px' },
  workspaceSwitch: { flexShrink: 0, color: 'var(--tm-text-muted)' },
  scroll: { flex: 1, minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column' },
  section: { display: 'flex', flexDirection: 'column', padding: '2px 8px' },
  row: {
    position: 'relative',
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    width: '100%',
    boxSizing: 'border-box',
    padding: '6px 8px',
    border: 'none',
    background: 'none',
    borderRadius: tokens.borderRadiusMedium,
    color: 'var(--tm-text)',
    cursor: 'pointer',
    textAlign: 'left',
    font: 'inherit',
    '& svg': { fontSize: '16px', flexShrink: 0, color: 'var(--tm-text-muted)' },
    ':hover': { backgroundColor: 'var(--tm-selected-tint)' },
  },
  /** Tint plus the 3px accent bar at 60% of the row's height — `IssueRow.tsx`'s own
   *  `selected`, shared by every row here (views, tree, Archived, This machine). */
  rowSelected: {
    backgroundColor: `var(--tm-selected-tint, ${tokens.colorBrandBackground2})`,
    '& svg': { color: `var(--tm-brand, ${tokens.colorBrandForeground1})` },
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
  rowLabel: {
    flex: 1,
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  rowLabelSelected: {
    fontWeight: tokens.fontWeightSemibold,
    color: `var(--tm-brand, ${tokens.colorBrandForeground1})`,
  },
  rowLabelMilestone: { fontWeight: tokens.fontWeightSemibold },
  rowCount: { color: 'var(--tm-text-muted)' },
  /** A "This machine" row's trailing location — right-aligned like the Archived count. */
  rowLocation: { color: `var(--tm-text-faint, ${tokens.colorNeutralForeground3})` },
  /** The Archived row's own label — muted throughout, mockup-kept, unlike the other fixed
   *  view rows above it which read in the ordinary (darker) row text colour. */
  rowLabelMuted: { color: 'var(--tm-text-muted)' },
  teamHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '10px 8px 4px',
    // The quick links stay in the DOM and the tab order, only revealed on hover or once
    // focus is inside the header — the label is all the v9 header shows at rest.
    '&:hover [data-team-links]': { opacity: 1 },
    '&:focus-within [data-team-links]': { opacity: 1 },
  },
  teamName: {
    color: `var(--tm-text-muted, ${tokens.colorNeutralForeground2})`,
    fontSize: '11px',
    fontWeight: tokens.fontWeightSemibold,
  },
  teamSwitcher: {
    minWidth: 0,
    color: `var(--tm-text-muted, ${tokens.colorNeutralForeground2})`,
    fontSize: '11px',
    fontWeight: tokens.fontWeightSemibold,
    padding: 0,
  },
  emptyTree: { padding: '6px 8px', color: 'var(--tm-text-muted)' },
  teamLinks: {
    display: 'flex',
    gap: '2px',
    opacity: 0,
    transitionProperty: 'opacity',
    transitionDuration: tokens.durationFast,
  },
  linkButton: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '22px',
    height: '22px',
    border: 'none',
    background: 'none',
    borderRadius: tokens.borderRadiusSmall,
    cursor: 'pointer',
    color: 'var(--tm-text-muted)',
    '& svg': { fontSize: '14px' },
    ':hover': { backgroundColor: 'var(--tm-selected-tint)', color: 'var(--tm-brand)' },
  },
  // Windowed, its rows are out of flow: the box keeps the height they would take, and
  // `flexShrink: 0` stops the scroller's flex column squashing it to the rows it holds.
  tree: {
    position: 'relative',
    flexShrink: 0,
    display: 'flex',
    flexDirection: 'column',
    outline: 'none',
  },
  windowRow: { position: 'absolute', top: 0, left: 0, right: 0 },
  chevronSlot: { width: '16px', flexShrink: 0, display: 'flex', alignItems: 'center' },
  chevronPlaceholder: { width: '16px', flexShrink: 0 },
  sectionDivider: {
    height: '1px',
    margin: '8px 12px',
    backgroundColor: 'var(--tm-text-faint)',
    flexShrink: 0,
  },
  machineHeader: {
    padding: '10px 8px 4px',
    color: `var(--tm-text-muted, ${tokens.colorNeutralForeground2})`,
    fontSize: '11px',
    fontWeight: tokens.fontWeightSemibold,
  },
  footer: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '8px 12px',
    flexShrink: 0,
  },
  footerButton: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    border: 'none',
    background: 'none',
    cursor: 'pointer',
    font: 'inherit',
    color: `var(--tm-brand, ${tokens.colorBrandForeground1})`,
    fontWeight: tokens.fontWeightSemibold,
    padding: 0,
    '& svg': { fontSize: '16px', color: `var(--tm-brand, ${tokens.colorBrandForeground1})` },
  },
  footerHint: {
    fontFamily: `var(--tm-mono, ${tokens.fontFamilyMonospace})`,
    color: `var(--tm-text-faint, ${tokens.colorNeutralForeground3})`,
  },
  statusGlyph: {
    display: 'flex',
    alignItems: 'center',
    flexShrink: 0,
  },
  statusGlyphRunning: { '& svg': { color: 'var(--tm-brand)' } },
  statusGlyphWaitingInput: { '& svg': { color: 'var(--tm-attention)' } },
  doneLabel: { color: 'var(--tm-text-muted)' },
});

const VIEW_ICON: Record<ViewRow['id'], ReactNode> = {
  inbox: <MailInboxRegular />,
  myIssues: <TaskListSquareLtrRegular />,
  reviews: <BranchRegular />,
};

const VIEW_TARGET: Record<ViewRow['id'], SidebarNavTarget> = {
  inbox: { kind: 'inbox' },
  myIssues: { kind: 'myIssues' },
  reviews: { kind: 'reviews' },
};

function sameSelection(a: SidebarSelection | null, b: SidebarNavTarget): boolean {
  if (!a || a.kind !== b.kind) return false;
  if (a.kind === 'machineProject' && b.kind === 'machineProject') {
    return a.projectId === b.projectId;
  }
  return true;
}

function indexTree(nodes: readonly SidebarTreeNode[], out: Map<string, SidebarTreeNode>): void {
  for (const node of nodes) {
    out.set(node.id, node);
    indexTree(node.children, out);
  }
}

/** Every node id the model itself resolved to folded — a node's own `folded` already weighs
 *  `defaultFolded` against the device's stored overrides (`sidebarFolds.ts`'s `isFolded`), so
 *  this, not the raw stored list, is what {@link flattenVisible} must hide behind. */
function collectFolded(
  nodes: readonly SidebarTreeNode[],
  out: Set<string> = new Set(),
): Set<string> {
  for (const node of nodes) {
    if (node.folded) out.add(node.id);
    collectFolded(node.children, out);
  }
  return out;
}

function treeIcon(node: SidebarTreeNode, styles: ReturnType<typeof useStyles>): ReactNode {
  if (node.kind === 'milestone') return <FlagRegular />;
  if (node.kind === 'epic') return issueTypeGlyph('epic');
  const status = node.status ?? 'pending';
  const column = columnForStatus(status);
  const tone =
    status === 'running'
      ? styles.statusGlyphRunning
      : status === 'waiting-input'
        ? styles.statusGlyphWaitingInput
        : undefined;
  return (
    <span
      className={mergeClasses(styles.statusGlyph, tone)}
      aria-label={STATUS_LABEL[status]}
      title={STATUS_LABEL[status]}
    >
      {STATUS_GLYPH[column]}
    </span>
  );
}

export function Sidebar({
  sections,
  selectedView,
  onNavigate,
  onOpenTicket,
  onNewIssue,
  onToggleFold,
  showFleet = false,
  projectOptions,
  selectedProjectId,
  onSelectProject,
  loading = false,
  onSearch,
}: SidebarProps): JSX.Element {
  const styles = useStyles();

  const workspace = sections.find((s) => s.kind === 'workspace');
  const views = sections.find((s) => s.kind === 'views');
  const team = sections.find((s) => s.kind === 'team');
  const archived = sections.find((s) => s.kind === 'archived');
  const machine = sections.find((s) => s.kind === 'machine');
  const newIssue = sections.find((s) => s.kind === 'newIssue');

  const treeNodes = team?.kind === 'team' ? team.tree : [];
  const foldSet = useMemo(() => collectFolded(treeNodes), [treeNodes]);
  const rows = useMemo(() => flattenVisible(treeNodes, foldSet), [treeNodes, foldSet]);
  const nodesById = useMemo(() => {
    const map = new Map<string, SidebarTreeNode>();
    indexTree(treeNodes, map);
    return map;
  }, [treeNodes]);

  // The open ticket's row, unless a fold hides it — drawn selected, and pinned by the tree.
  const selectedTaskId = selectedView?.kind === 'ticket' ? selectedView.taskId : null;
  const selectedRowId = useMemo(() => {
    if (selectedTaskId === null) return null;
    const row = rows.find((r) => {
      const node = nodesById.get(r.id);
      return node?.kind === 'ticket' && node.taskId === selectedTaskId;
    });
    return row?.id ?? null;
  }, [rows, nodesById, selectedTaskId]);

  // State, not a ref: the tree windows against it, and its arrival switches windowing on.
  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null);

  return (
    <nav className={styles.root} aria-label="Sidebar">
      {workspace?.kind === 'workspace' && (
        <WorkspaceHeader
          workspaces={workspace.workspaces}
          active={workspace.workspaces.find((w) => w.id === workspace.activeWorkspaceId)}
          onSearch={onSearch}
        />
      )}

      <div ref={setScrollEl} className={styles.scroll}>
        {views?.kind === 'views' && (
          <div className={styles.section}>
            {views.views.map((view) => {
              const target = VIEW_TARGET[view.id];
              const selected = sameSelection(selectedView, target);
              return (
                <button
                  key={view.id}
                  type="button"
                  className={mergeClasses(styles.row, selected && styles.rowSelected)}
                  aria-current={selected || undefined}
                  onClick={() => onNavigate(target)}
                >
                  {VIEW_ICON[view.id]}
                  <span
                    className={mergeClasses(styles.rowLabel, selected && styles.rowLabelSelected)}
                  >
                    {view.label}
                  </span>
                  {!!view.count && <Caption1 className={styles.rowCount}>{view.count}</Caption1>}
                </button>
              );
            })}
          </div>
        )}

        {team?.kind === 'team' && (
          <div className={styles.section}>
            <div className={styles.teamHeader}>
              {onSelectProject && projectOptions && projectOptions.length > 0 ? (
                <Menu>
                  <MenuTrigger disableButtonEnhancement>
                    <MenuButton
                      appearance="subtle"
                      size="small"
                      className={styles.teamSwitcher}
                      aria-label="Switch ticket project"
                    >
                      {team.name ?? 'Team'}
                    </MenuButton>
                  </MenuTrigger>
                  <MenuPopover>
                    <MenuList
                      checkedValues={{ project: selectedProjectId ? [selectedProjectId] : [] }}
                      onCheckedValueChange={(_e, { checkedItems }) => {
                        const next = checkedItems.find((id) => id !== selectedProjectId);
                        if (next) onSelectProject(next);
                      }}
                    >
                      {projectOptions.map((project) => (
                        <MenuItemRadio key={project.id} name="project" value={project.id}>
                          {project.name}
                        </MenuItemRadio>
                      ))}
                    </MenuList>
                  </MenuPopover>
                </Menu>
              ) : (
                <Caption1 className={styles.teamName}>{team.name ?? 'Team'}</Caption1>
              )}
              <div className={styles.teamLinks} data-team-links="">
                <button
                  type="button"
                  className={styles.linkButton}
                  title="Issues"
                  aria-label="Issues"
                  onClick={() => onNavigate({ kind: 'issues' })}
                >
                  <TicketDiagonalRegular />
                </button>
                {showFleet && (
                  <button
                    type="button"
                    className={styles.linkButton}
                    title="Fleet"
                    aria-label="Fleet"
                    onClick={() => onNavigate({ kind: 'fleet' })}
                  >
                    <BotRegular />
                  </button>
                )}
                <button
                  type="button"
                  className={styles.linkButton}
                  title="Projects"
                  aria-label="Projects"
                  onClick={() => onNavigate({ kind: 'projects' })}
                >
                  <FolderRegular />
                </button>
              </div>
            </div>

            {treeNodes.length === 0 && !loading ? (
              <Caption1 className={styles.emptyTree}>
                {team.name ? `${team.name} has no tickets yet` : 'No ticket project yet'}
              </Caption1>
            ) : (
              <SidebarTree
                label={team.name ?? 'Team'}
                rows={rows}
                nodesById={nodesById}
                selectedRowId={selectedRowId}
                scrollEl={scrollEl}
                onOpenTicket={onOpenTicket}
                onToggleFold={onToggleFold}
              />
            )}
          </div>
        )}

        {archived?.kind === 'archived' && (
          <div className={styles.section}>
            <button
              type="button"
              className={mergeClasses(
                styles.row,
                sameSelection(selectedView, { kind: 'archived' }) && styles.rowSelected,
              )}
              aria-current={sameSelection(selectedView, { kind: 'archived' }) || undefined}
              onClick={() => onNavigate({ kind: 'archived' })}
            >
              <ArchiveRegular />
              <span
                className={mergeClasses(
                  styles.rowLabel,
                  styles.rowLabelMuted,
                  sameSelection(selectedView, { kind: 'archived' }) && styles.rowLabelSelected,
                )}
              >
                Archived
              </span>
              <Caption1 className={styles.rowCount}>{archived.count}</Caption1>
            </button>
          </div>
        )}

        {machine?.kind === 'machine' && machine.projects.length > 0 && (
          <div className={styles.section}>
            <Caption1 className={styles.machineHeader}>{machine.label}</Caption1>
            {machine.projects.map((project) => {
              const selected = sameSelection(selectedView, {
                kind: 'machineProject',
                projectId: project.id,
              });
              return (
                <button
                  key={project.id}
                  type="button"
                  className={mergeClasses(styles.row, selected && styles.rowSelected)}
                  aria-current={selected || undefined}
                  onClick={() => onNavigate({ kind: 'machineProject', projectId: project.id })}
                >
                  <LaptopRegular />
                  <span
                    className={mergeClasses(styles.rowLabel, selected && styles.rowLabelSelected)}
                  >
                    {project.name}
                  </span>
                  <Caption1 className={styles.rowLocation}>{machine.location}</Caption1>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {newIssue?.kind === 'newIssue' && (
        <NewIssueFooter shortcut={newIssue.shortcut} onNewIssue={onNewIssue} />
      )}
    </nav>
  );
}

/** A row's 20px line plus 6px padding above and below — measured once drawn. */
const ROW_ESTIMATE = 32;
const ROW_OVERSCAN = 10;
/** Drawn in flow for the one render before the scroller is known — more than a screenful,
 *  and gone before the first paint: the scroller's ref re-renders it windowed. */
const FIRST_RENDER_ROWS = 60;

interface SidebarTreeProps {
  label: string;
  rows: SidebarVisibleRow[];
  nodesById: ReadonlyMap<string, SidebarTreeNode>;
  /** The open ticket's row — drawn selected, and kept mounted off screen. */
  selectedRowId: string | null;
  /** `styles.scroll`, which also holds the views above the tree and the rows below it. */
  scrollEl: HTMLElement | null;
  onOpenTicket: (taskId: string) => void;
  onToggleFold: (id: string, defaultFolded?: boolean) => void;
}

/**
 * The `role="tree"`, windowed against the sidebar's scroller (F29.3) — a component of its
 * own, so a scroll redraws the tree and not the sections around it. It owns the roving
 * tabindex: the focus row is pinned, and a key that moves it scrolls it into view, so an
 * arrow key never lands on a row that is not mounted. `scrollMargin` (the tree's offset
 * inside the scroller, below the views) is `useWindowedList`'s to keep.
 */
function SidebarTree({
  label,
  rows,
  nodesById,
  selectedRowId,
  scrollEl,
  onOpenTicket,
  onToggleFold,
}: SidebarTreeProps): JSX.Element {
  const styles = useStyles();
  const [keyState, setKeyState] = useState<TreeKeyState>({
    focusId: null,
    typeahead: { buffer: '' },
  });
  const typeaheadTimer = useRef<ReturnType<typeof setTimeout>>();

  // Roving tabindex always has a stop once the tree has any rows — picks the first one the
  // first time there is anything to focus, same as any other roving-tabindex widget.
  useEffect(() => {
    if (keyState.focusId !== null) return;
    if (rows.length === 0) return;
    setKeyState((state) => ({ ...state, focusId: rows[0].id }));
  }, [rows, keyState.focusId]);

  useEffect(() => () => clearTimeout(typeaheadTimer.current), []);

  const pinned = useMemo(
    () => pinnedTreeRows(rows, keyState.focusId, selectedRowId),
    [rows, keyState.focusId, selectedRowId],
  );
  const win = useWindowedList({
    count: rows.length,
    keyOf: (i) => rows[i].id,
    getScrollElement: () => scrollEl,
    estimateSize: () => ROW_ESTIMATE,
    overscan: ROW_OVERSCAN,
    pinned,
    enabled: scrollEl !== null,
  });
  const drawn = win.windowed ? win.rows : win.rows.slice(0, FIRST_RENDER_ROWS);

  function scheduleTypeaheadReset(buffer: string): void {
    clearTimeout(typeaheadTimer.current);
    if (!buffer) return;
    typeaheadTimer.current = setTimeout(() => {
      setKeyState((state) => ({ ...state, typeahead: { buffer: '' } }));
    }, 600);
  }

  function activate(id: string): void {
    const node = nodesById.get(id);
    if (!node) return;
    if (node.kind === 'ticket') {
      if (node.taskId) onOpenTicket(node.taskId);
      return;
    }
    onToggleFold(node.id, node.defaultFolded ?? false);
  }

  function onTreeKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    const isPrintable = event.key.length === 1 && event.key !== ' ';
    const isNavKey = [
      'ArrowDown',
      'ArrowUp',
      'ArrowRight',
      'ArrowLeft',
      'Home',
      'End',
      'Enter',
      ' ',
    ].includes(event.key);
    if (!isPrintable && !isNavKey) return;
    event.preventDefault();

    const result = treeKeyReducer(keyState, event.key, rows);
    setKeyState({ focusId: result.focusId, typeahead: result.typeahead });
    if (result.focusId !== keyState.focusId) {
      win.scrollToIndex(focusIndexOf(rows, result.focusId), { align: 'auto' });
    }
    if (result.toggle) {
      onToggleFold(result.toggle.id, nodesById.get(result.toggle.id)?.defaultFolded ?? false);
    }
    if (result.activate) activate(result.activate);
    scheduleTypeaheadReset(result.typeahead.buffer);
  }

  // Stable, so a memoised row is not redrawn for a fresh closure on every scroll.
  const onRowClick = useStableCallback((id: string): void => {
    setKeyState((state) => ({ ...state, focusId: id }));
    activate(id);
  });

  return (
    <div
      ref={win.listRef}
      role="tree"
      aria-label={label}
      className={styles.tree}
      // Windowed, the rows are out of flow: the box keeps the height they would take.
      style={win.windowed ? { height: win.totalSize } : undefined}
      tabIndex={0}
      onKeyDown={onTreeKeyDown}
    >
      {drawn.map(({ index, key, start }) => {
        const row = rows[index];
        const node = nodesById.get(row.id);
        if (!node) return null;
        return (
          <SidebarRow
            key={key}
            index={index}
            row={row}
            node={node}
            focused={row.id === keyState.focusId}
            selected={row.id === selectedRowId}
            start={win.windowed ? start : null}
            measureElement={win.measureElement}
            onRowClick={onRowClick}
          />
        );
      })}
    </div>
  );
}

interface SidebarRowProps {
  index: number;
  row: SidebarVisibleRow;
  node: SidebarTreeNode;
  focused: boolean;
  selected: boolean;
  /** Offset from the tree's top when windowed; `null` draws the row in normal flow. */
  start: number | null;
  measureElement: (el: Element | null) => void;
  onRowClick: (id: string) => void;
}

/** One `treeitem` — memoised, so a scroll redraws only the rows whose own props changed. The
 *  count stays the last child: `perf-board.mjs`'s expand-group reads it from there. */
const SidebarRow = memo(function SidebarRow({
  index,
  row,
  node,
  focused,
  selected,
  start,
  measureElement,
  onRowClick,
}: SidebarRowProps): JSX.Element {
  const styles = useStyles();
  const done =
    node.kind === 'ticket' ? columnForStatus(node.status ?? 'pending') === 'done' : !!node.finished;
  return (
    <div
      ref={measureElement}
      data-index={index}
      role="treeitem"
      id={`sidebar-tree-${row.id}`}
      aria-level={row.depth + 1}
      aria-expanded={row.hasChildren ? row.expanded : undefined}
      aria-selected={selected || undefined}
      tabIndex={focused ? 0 : -1}
      className={mergeClasses(
        styles.row,
        start !== null && styles.windowRow,
        selected && styles.rowSelected,
      )}
      style={{
        paddingLeft: `${8 + row.depth * 16}px`,
        ...(start !== null ? { transform: `translateY(${start}px)` } : {}),
      }}
      onClick={() => onRowClick(row.id)}
    >
      {row.hasChildren ? (
        <span className={styles.chevronSlot}>
          {row.expanded ? <ChevronDownRegular /> : <ChevronRightRegular />}
        </span>
      ) : (
        <span className={styles.chevronPlaceholder} />
      )}
      {treeIcon(node, styles)}
      <span
        className={mergeClasses(
          styles.rowLabel,
          node.kind === 'milestone' && styles.rowLabelMilestone,
          done && styles.doneLabel,
          selected && styles.rowLabelSelected,
        )}
      >
        {node.label}
      </span>
      {node.kind !== 'ticket' && (
        <Caption1 className={styles.rowCount}>
          {node.kind === 'milestone' && node.openCount !== undefined
            ? `${node.openCount}/${node.count}`
            : node.count}
        </Caption1>
      )}
    </div>
  );
});

/** The workspace switcher row (v9-1): an initial tile, the cloud team or "Personal" over its
 *  "Cloud"/"Local" line, and a chevron menu of the workspaces the sidebar data already holds,
 *  the active one checked. It has no switch action: until F19 there is only ever the one
 *  workspace. Only the `machine` section below still says "This machine". v9-1's search icon
 *  opens the command palette; its collapse icon has no feature behind it yet, so it is not
 *  drawn. */
function WorkspaceHeader({
  workspaces,
  active,
  onSearch,
}: {
  workspaces: readonly SidebarWorkspace[];
  active: SidebarWorkspace | undefined;
  onSearch?: () => void;
}): JSX.Element {
  const styles = useStyles();
  const name = active?.name ?? 'Personal';
  return (
    <div className={styles.workspace}>
      <span className={styles.workspaceTile} aria-hidden="true">
        {name.charAt(0).toUpperCase()}
      </span>
      <div className={styles.workspaceText}>
        <Body1 className={styles.workspaceName}>{name}</Body1>
        {active?.sub && <span className={styles.workspaceSub}>{active.sub}</span>}
      </div>
      {onSearch && (
        <Button
          appearance="subtle"
          size="small"
          className={styles.workspaceSwitch}
          icon={<SearchRegular />}
          aria-label="Search"
          title="Search"
          onClick={onSearch}
        />
      )}
      <Menu>
        <MenuTrigger disableButtonEnhancement>
          <Button
            appearance="subtle"
            size="small"
            className={styles.workspaceSwitch}
            icon={<ChevronDownRegular />}
            aria-label="Switch workspace"
            title="Switch workspace"
          />
        </MenuTrigger>
        <MenuPopover>
          <MenuList checkedValues={{ workspace: active ? [active.id] : [] }}>
            {workspaces.map((w) => (
              <MenuItemRadio key={w.id} name="workspace" value={w.id} secondaryContent={w.sub}>
                {w.name}
              </MenuItemRadio>
            ))}
          </MenuList>
        </MenuPopover>
      </Menu>
    </div>
  );
}

/** Its own component only so {@link useGlobalShortcut} runs every time `Sidebar` mounts — the
 *  footer is always present once `newIssue` is, so this is equivalent to inlining the hook,
 *  just without the eslint complaint about calling it inside a conditional render. */
function NewIssueFooter({
  shortcut,
  onNewIssue,
}: {
  shortcut: string;
  onNewIssue: () => void;
}): JSX.Element {
  const styles = useStyles();
  useGlobalShortcut(shortcut.toLowerCase(), onNewIssue, { ignoreInFields: true });
  const label = shortcutLabel(
    shortcut.toLowerCase(),
    typeof window === 'undefined' ? undefined : window,
  );
  return (
    <div className={styles.footer}>
      <button type="button" className={styles.footerButton} onClick={onNewIssue}>
        <AddRegular />
        New issue
      </button>
      <Caption1 className={styles.footerHint}>{label}</Caption1>
    </div>
  );
}
