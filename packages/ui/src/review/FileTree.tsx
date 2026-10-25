/**
 * The Changes pane's file list: a Fluent `Tree` grouped by directory, built from
 * `buildFileTree` (`reviewView.ts`). Directories are a pure navigation aid — every one of
 * them starts open (`defaultOpenItems`), and Fluent owns their open/closed state from
 * there, uncontrolled; `reviewState.expanded` is a different thing entirely (which FILES'
 * diffs are loaded), never which directories are showing.
 *
 * Monochrome, like the commit graph (`GitGraphPane.tsx`, `theme.ts`'s `GRAPH_INK`): a
 * status letter and a path are facts about a file, not something that moves, so the only
 * colour in this file is the +/− count, which reuses the diff's own green/red rather than
 * inventing a third meaning for either hue.
 *
 * The review workspace adds a viewed box per file: pass both `viewed` and `onToggleViewed`
 * and each file row gets a `Checkbox` (ticked for `'viewed'`; a `'changed'` mark — the
 * file moved on since it was ticked — shows unticked, titled "Changed since viewed"). Leave
 * either out and the tree renders exactly as before, which is what the Changes pane does.
 */
import { useMemo } from 'react';
import type { JSX } from 'react';
import {
  Caption1,
  Checkbox,
  Tree,
  TreeItem,
  TreeItemLayout,
  makeStyles,
  mergeClasses,
  tokens,
} from '@fluentui/react-components';
import { isCollapsedByDefault, type ViewedStatus } from '@tm/shared/review';
import { MONO } from '../theme';
import { statusLetter, type FileTreeDir, type FileTreeNode } from './reviewView';

const useStyles = makeStyles({
  root: { flex: '1 1 220px', minWidth: '180px', maxWidth: '320px', overflowY: 'auto' },
  selected: { backgroundColor: tokens.colorNeutralBackground1Selected },
  aside: { display: 'flex', alignItems: 'center', gap: '6px' },
  added: { color: tokens.colorPaletteGreenForeground1 },
  deleted: { color: tokens.colorPaletteRedForeground1 },
  letter: {
    fontFamily: MONO,
    color: tokens.colorNeutralForeground3,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusSmall,
    padding: '0 4px',
    lineHeight: '16px',
  },
  name: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  collapsedNote: { color: tokens.colorNeutralForeground3 },
  viewedBox: { marginRight: '2px' },
});

/** The viewed box's inputs, present only when the host passed BOTH props. */
interface ViewedProps {
  viewed: Readonly<Record<string, ViewedStatus>>;
  onToggleViewed: (path: string) => void;
}

export interface FileTreeProps {
  nodes: readonly FileTreeNode[];
  selectedPath: string | null;
  onSelectFile: (path: string) => void;
  /** Each file's viewed status. With `onToggleViewed`, draws a viewed box per file. */
  viewed?: Readonly<Record<string, ViewedStatus>>;
  onToggleViewed?: (path: string) => void;
}

/** Every directory's own path, so `defaultOpenItems` starts the whole tree expanded. */
function dirPaths(nodes: readonly FileTreeNode[]): string[] {
  const paths: string[] = [];
  for (const node of nodes) {
    if (node.kind !== 'dir') continue;
    paths.push(node.path, ...dirPaths(node.children));
  }
  return paths;
}

export function FileTree({
  nodes,
  selectedPath,
  onSelectFile,
  viewed,
  onToggleViewed,
}: FileTreeProps): JSX.Element {
  const styles = useStyles();
  const openItems = useMemo(() => dirPaths(nodes), [nodes]);
  const viewedProps: ViewedProps | undefined =
    viewed && onToggleViewed ? { viewed, onToggleViewed } : undefined;

  return (
    <Tree
      aria-label="Changed files"
      size="small"
      defaultOpenItems={openItems}
      className={styles.root}
    >
      {nodes.map((node) => (
        <FileTreeRow
          key={node.kind === 'dir' ? node.path : node.entry.path}
          node={node}
          selectedPath={selectedPath}
          onSelectFile={onSelectFile}
          viewedProps={viewedProps}
        />
      ))}
    </Tree>
  );
}

function FileTreeRow({
  node,
  selectedPath,
  onSelectFile,
  viewedProps,
}: {
  node: FileTreeNode;
  selectedPath: string | null;
  onSelectFile: (path: string) => void;
  viewedProps: ViewedProps | undefined;
}): JSX.Element {
  const styles = useStyles();

  if (node.kind === 'dir') {
    const dir: FileTreeDir = node;
    return (
      <TreeItem itemType="branch" value={dir.path}>
        <TreeItemLayout>{dir.name}</TreeItemLayout>
        <Tree>
          {dir.children.map((child) => (
            <FileTreeRow
              key={child.kind === 'dir' ? child.path : child.entry.path}
              node={child}
              selectedPath={selectedPath}
              onSelectFile={onSelectFile}
              viewedProps={viewedProps}
            />
          ))}
        </Tree>
      </TreeItem>
    );
  }

  const { entry } = node;
  const name = entry.path.split('/').pop() ?? entry.path;
  const collapsed = isCollapsedByDefault(entry);
  const status = viewedProps?.viewed[entry.path] ?? 'unviewed';

  return (
    <TreeItem
      itemType="leaf"
      value={entry.path}
      className={selectedPath === entry.path ? styles.selected : undefined}
      onClick={() => onSelectFile(entry.path)}
    >
      <TreeItemLayout
        iconBefore={
          viewedProps && (
            <Checkbox
              className={styles.viewedBox}
              aria-label={`Viewed ${entry.path}`}
              title={status === 'changed' ? 'Changed since viewed' : undefined}
              checked={status === 'viewed'}
              data-viewed={status}
              // The box is its own control: ticking it must not also select the row.
              onClick={(event) => event.stopPropagation()}
              onChange={() => viewedProps.onToggleViewed(entry.path)}
            />
          )
        }
        aside={
          <span className={styles.aside}>
            {entry.additions > 0 && (
              <Caption1 className={styles.added}>+{entry.additions}</Caption1>
            )}
            {entry.deletions > 0 && (
              <Caption1 className={styles.deleted}>-{entry.deletions}</Caption1>
            )}
            <Caption1 className={styles.letter}>{statusLetter(entry.status)}</Caption1>
          </span>
        }
      >
        <span className={mergeClasses(styles.name)} title={entry.path}>
          {name}
        </span>
        {collapsed && <Caption1 className={styles.collapsedNote}> · collapsed</Caption1>}
      </TreeItemLayout>
    </TreeItem>
  );
}
