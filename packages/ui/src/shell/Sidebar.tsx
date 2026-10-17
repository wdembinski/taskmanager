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
 * Issues/Fleet/Projects from the small icon row under the team header (the mockup's own
 * quick-link row), and a `This machine` project row. A ticket node opens through
 * `onOpenTicket` instead — it is a card, not a screen.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Body1, Caption1, makeStyles, mergeClasses, tokens } from '@fluentui/react-components';
import {
  AddRegular,
  ArchiveRegular,
  BotRegular,
  BranchRegular,
  ChevronDownRegular,
  ChevronRightRegular,
  CircleSmallRegular,
  DesktopRegular,
  FlagRegular,
  FolderRegular,
  MailInboxRegular,
  TaskListSquareLtrRegular,
  TicketDiagonalRegular,
} from '@fluentui/react-icons';
import { useGlobalShortcut } from '../palette/shortcut';
import { shortcutLabel } from '../palette/shortcutLabel';
import { issueTypeGlyph } from '../projects/issueTypeGlyph';
import type { SidebarSection, SidebarTreeNode, SidebarView as ViewRow } from './sidebarModel';
import { flattenVisible, treeKeyReducer, type TreeKeyState } from './sidebarTree';

/** Everywhere `onNavigate` can send a host — every destination `shellNav.ts`'s now-deleted
 *  `interim` group used to carry a rail tile for, reached from the sidebar instead. */
export type SidebarNavTarget =
  | { kind: 'inbox' }
  | { kind: 'myIssues' }
  | { kind: 'reviews' }
  | { kind: 'issues' }
  | { kind: 'fleet' }
  | { kind: 'projects' }
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
  /** This device's folded tree-node ids (`useDeviceFolds`'s own `folds`). */
  folds: readonly string[];
  onToggleFold: (id: string) => void;
  /** The web's cross-project destination the desktop does not have at all (`shellNav.ts`'s
   *  own F13.8 header) — off by default, so the desktop need not pass anything to hide it. */
  showFleet?: boolean;
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
    padding: '4px 12px 12px',
    color: 'var(--tm-text)',
  },
  workspaceName: { fontWeight: tokens.fontWeightSemibold },
  workspaceSub: { color: 'var(--tm-text-muted)' },
  scroll: { flex: 1, minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column' },
  section: { display: 'flex', flexDirection: 'column', padding: '2px 8px' },
  row: {
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
  rowSelected: {
    backgroundColor: 'var(--tm-selected-tint)',
    '& svg': { color: 'var(--tm-brand)' },
  },
  rowLabel: {
    flex: 1,
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  rowCount: { color: 'var(--tm-text-muted)' },
  teamHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '10px 8px 4px',
  },
  teamName: { color: 'var(--tm-text-muted)', textTransform: 'uppercase', fontSize: '11px' },
  teamLinks: { display: 'flex', gap: '2px' },
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
  tree: { display: 'flex', flexDirection: 'column', outline: 'none' },
  chevronSlot: { width: '16px', flexShrink: 0, display: 'flex', alignItems: 'center' },
  chevronPlaceholder: { width: '16px', flexShrink: 0 },
  sectionDivider: {
    height: '1px',
    margin: '8px 12px',
    backgroundColor: 'var(--tm-text-faint)',
    flexShrink: 0,
  },
  machineHeader: { padding: '10px 8px 4px', color: 'var(--tm-text-muted)', fontSize: '11px' },
  footer: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '8px 12px',
    borderTop: `1px solid var(--tm-text-faint)`,
    flexShrink: 0,
  },
  footerButton: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    border: 'none',
    background: 'none',
    cursor: 'pointer',
    color: 'var(--tm-text)',
    font: 'inherit',
    padding: 0,
    '& svg': { fontSize: '16px', color: 'var(--tm-text-muted)' },
  },
  footerHint: { color: 'var(--tm-text-faint)' },
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

function treeIcon(node: SidebarTreeNode): ReactNode {
  if (node.kind === 'milestone') return <FlagRegular />;
  if (node.kind === 'epic') return issueTypeGlyph('epic');
  return <CircleSmallRegular />;
}

export function Sidebar({
  sections,
  selectedView,
  onNavigate,
  onOpenTicket,
  onNewIssue,
  folds,
  onToggleFold,
  showFleet = false,
}: SidebarProps): JSX.Element {
  const styles = useStyles();

  const workspace = sections.find((s) => s.kind === 'workspace');
  const views = sections.find((s) => s.kind === 'views');
  const team = sections.find((s) => s.kind === 'team');
  const archived = sections.find((s) => s.kind === 'archived');
  const machine = sections.find((s) => s.kind === 'machine');
  const newIssue = sections.find((s) => s.kind === 'newIssue');

  const treeNodes = team?.kind === 'team' ? team.tree : [];
  const foldSet = useMemo(() => new Set(folds), [folds]);
  const rows = useMemo(() => flattenVisible(treeNodes, foldSet), [treeNodes, foldSet]);
  const nodesById = useMemo(() => {
    const map = new Map<string, SidebarTreeNode>();
    indexTree(treeNodes, map);
    return map;
  }, [treeNodes]);

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
    onToggleFold(node.id);
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
    if (result.toggle) onToggleFold(result.toggle.id);
    if (result.activate) activate(result.activate);
    scheduleTypeaheadReset(result.typeahead.buffer);
  }

  function onRowClick(id: string): void {
    setKeyState((state) => ({ ...state, focusId: id }));
    activate(id);
  }

  return (
    <nav className={styles.root} aria-label="Sidebar">
      {workspace?.kind === 'workspace' && (
        <div className={styles.workspace}>
          <DesktopRegular />
          <div>
            <div className={styles.workspaceName}>
              <Body1>
                {workspace.workspaces.find((w) => w.id === workspace.activeWorkspaceId)?.name ??
                  'This machine'}
              </Body1>
            </div>
          </div>
        </div>
      )}

      <div className={styles.scroll}>
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
                  <span className={styles.rowLabel}>{view.label}</span>
                  {!!view.count && <Caption1 className={styles.rowCount}>{view.count}</Caption1>}
                </button>
              );
            })}
          </div>
        )}

        {team?.kind === 'team' && (
          <div className={styles.section}>
            <div className={styles.teamHeader}>
              <Caption1 className={styles.teamName}>{team.name ?? 'Team'}</Caption1>
              <div className={styles.teamLinks}>
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

            <div
              role="tree"
              aria-label={team.name ?? 'Team'}
              className={styles.tree}
              tabIndex={0}
              onKeyDown={onTreeKeyDown}
            >
              {rows.map((row) => {
                const node = nodesById.get(row.id);
                if (!node) return null;
                const focused = row.id === keyState.focusId;
                const selected =
                  node.kind === 'ticket' &&
                  node.taskId !== undefined &&
                  selectedView?.kind === 'ticket' &&
                  selectedView.taskId === node.taskId;
                return (
                  <div
                    key={row.id}
                    role="treeitem"
                    id={`sidebar-tree-${row.id}`}
                    aria-level={row.depth + 1}
                    aria-expanded={row.hasChildren ? row.expanded : undefined}
                    aria-selected={selected || undefined}
                    tabIndex={focused ? 0 : -1}
                    className={mergeClasses(styles.row, selected && styles.rowSelected)}
                    style={{ paddingLeft: `${8 + row.depth * 16}px` }}
                    onClick={() => onRowClick(row.id)}
                  >
                    {row.hasChildren ? (
                      <span className={styles.chevronSlot}>
                        {row.expanded ? <ChevronDownRegular /> : <ChevronRightRegular />}
                      </span>
                    ) : (
                      <span className={styles.chevronPlaceholder} />
                    )}
                    {treeIcon(node)}
                    {node.ticketKey && (
                      <Caption1 className={styles.rowCount}>{node.ticketKey}</Caption1>
                    )}
                    <span className={styles.rowLabel}>{node.label}</span>
                    {node.kind !== 'ticket' && (
                      <Caption1 className={styles.rowCount}>{node.count}</Caption1>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {archived?.kind === 'archived' && (
          <div className={styles.section}>
            <div className={styles.row}>
              <ArchiveRegular />
              <span className={styles.rowLabel}>Archived</span>
              <Caption1 className={styles.rowCount}>{archived.count}</Caption1>
            </div>
          </div>
        )}

        {machine?.kind === 'machine' && machine.projects.length > 0 && (
          <div className={styles.section}>
            <Caption1 className={styles.machineHeader}>This machine</Caption1>
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
                  onClick={() => onNavigate({ kind: 'machineProject', projectId: project.id })}
                >
                  <DesktopRegular />
                  <span className={styles.rowLabel}>{project.name}</span>
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
