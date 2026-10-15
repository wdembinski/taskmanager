/**
 * The unified diff: every changed file, stacked in the order the summary listed them, each
 * either collapsed to its own header row or showing the patch `ReviewPane` lazily fetched
 * for it. One component rather than "one file at a time" on screen, because {@link
 * FileTree}'s "selecting a file scrolls to it" only makes sense if every expanded file is
 * already on the page to scroll to.
 *
 * Word-level highlights are computed per HUNK, never across the whole file: `pairWordDiffs`
 * pairs a del run with the add run immediately after it, and two hunks are themselves
 * separated by lines neither hunk carries, so pairing across that gap would highlight two
 * lines that were never adjacent in the real file.
 *
 * Colour budget (memory *board-colour-budget*, and F6's own design doc): the ONLY colour
 * here is added/removed content — a line's own tint at its subtlest step, and the inner
 * word highlight one step stronger so it reads against that tint. Everything else
 * (gutters, headers, notices) stays on neutral tokens.
 *
 * **Touch mode** (`touch`, wired from `ReviewPaneView`'s compact layout): the hover-only "+"
 * button has no equivalent on a touchscreen, so it is dropped entirely and the whole
 * line-number gutter becomes a real, always-visible `button` instead — reaching the same
 * canonical `target` the wide "+" already computes, just a different way to tap it. The
 * inline `CommentThread` is always handed `editor={null}` here, even while one is open,
 * because touch's editor lives in `ReviewPaneView`'s own bottom sheet, not inline; the
 * comment cards themselves need no change, since they already have no hover-only controls.
 * `wrap === false` (the compact pane's own `Switch`) switches a line's `white-space` from
 * `pre-wrap` to `pre` and lets the file scroll sideways instead of folding.
 */
import { useEffect, useRef, useState } from 'react';
import type { JSX } from 'react';
import {
  Body1,
  Button,
  Caption1,
  Spinner,
  makeStyles,
  mergeClasses,
  tokens,
} from '@fluentui/react-components';
import { AddRegular } from '@fluentui/react-icons';
import { parseOversizedAnswer } from '@tm/shared/ipcRelay';
import { isCollapsedByDefault } from '@tm/shared/review';
import type {
  DiffFileEntry,
  DiffHunk,
  DiffImage,
  DiffImageSide,
  DiffLine,
  DiffSide,
  DiffSummary,
  ReviewComment,
  WordSegment,
} from '@tm/shared/review';
import { MONO, fontPx } from '../theme';
import { useTransport } from '../transport';
import { CommentThread } from './CommentThread';
import {
  rangeLines,
  renderedIndex,
  type CommentEditor,
  type FileLoad,
  type LineSelection,
} from './reviewState';
import { fileLoadNotice, pairWordDiffs, statusLetter } from './reviewView';

const useStyles = makeStyles({
  root: {
    flex: '2 1 480px',
    minWidth: 0,
    overflowY: 'auto',
    display: 'flex',
    flexDirection: 'column',
    gap: '10px',
  },
  file: {
    backgroundColor: tokens.colorNeutralBackground3,
    borderRadius: tokens.borderRadiusMedium,
    overflow: 'hidden',
  },
  fileHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    padding: '6px 8px',
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  letter: {
    fontFamily: MONO,
    color: tokens.colorNeutralForeground3,
    flexShrink: 0,
  },
  path: {
    flex: 1,
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontFamily: MONO,
    fontSize: fontPx(12),
  },
  added: { color: tokens.colorPaletteGreenForeground1, flexShrink: 0 },
  deleted: { color: tokens.colorPaletteRedForeground1, flexShrink: 0 },
  notice: { padding: '10px', color: tokens.colorNeutralForeground3 },
  hunkHeader: {
    padding: '4px 8px',
    color: tokens.colorNeutralForeground3,
    fontFamily: MONO,
    fontSize: fontPx(11),
    backgroundColor: tokens.colorNeutralBackground4,
  },
  line: {
    display: 'flex',
    fontFamily: MONO,
    fontSize: fontPx(12),
    whiteSpace: 'pre-wrap',
    // The "+" costs nothing at rest and appears when you reach for it — same trick as
    // `TaskCard`'s own chain handle (memory *board-colour-budget*'s neighbour: no colour
    // here either, just an affordance that shows up on hover).
    '&:hover [data-add-comment]': { opacity: 1, pointerEvents: 'auto' },
  },
  lineNoWrap: { whiteSpace: 'pre' },
  lineAdd: { backgroundColor: tokens.colorPaletteGreenBackground1 },
  lineDel: { backgroundColor: tokens.colorPaletteRedBackground1 },
  // The open editor's range, applied LAST in `mergeClasses` so it wins over the add/del tint —
  // the human is looking at what they selected, not at what changed.
  lineSelected: { backgroundColor: tokens.colorNeutralBackground1Selected },
  addCell: { position: 'relative', width: '20px', flexShrink: 0 },
  addButton: {
    position: 'absolute',
    top: '1px',
    left: '0',
    minWidth: 'unset',
    padding: 0,
    opacity: 0,
    pointerEvents: 'none',
  },
  gutter: {
    flexShrink: 0,
    width: '44px',
    textAlign: 'right',
    paddingRight: '8px',
    color: tokens.colorNeutralForeground4,
    userSelect: 'none',
  },
  // Touch's stand-in for `addButton`: the whole gutter is the tap target, so it needs to
  // clear the 44px touch-target floor (`board-colour-budget`'s neighbour, *MoveToSheet*'s
  // own `option` style) in both directions, not just the font-sized row height.
  gutterButton: {
    flexShrink: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: '6px',
    minWidth: '44px',
    minHeight: '44px',
    padding: '0 8px',
    border: 'none',
    background: 'none',
    fontFamily: MONO,
    fontSize: fontPx(12),
    color: tokens.colorNeutralForeground4,
    cursor: 'pointer',
    userSelect: 'none',
    '&:disabled': { cursor: 'default', opacity: 0.5 },
  },
  text: { flex: 1, minWidth: 0, paddingRight: '8px' },
  wordAdd: { backgroundColor: tokens.colorPaletteGreenBackground2 },
  wordDel: { backgroundColor: tokens.colorPaletteRedBackground2 },
  images: { display: 'flex', gap: '12px', padding: '10px', flexWrap: 'wrap' },
  imageFigure: { margin: 0, display: 'flex', flexDirection: 'column', gap: '4px' },
  imagePreview: { maxWidth: '320px', maxHeight: '320px', borderRadius: tokens.borderRadiusSmall },
  unanchored: {
    borderTop: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground2,
  },
  unanchoredLabel: { padding: '6px 8px 0', color: tokens.colorNeutralForeground3 },
  orphanSection: {
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
    padding: '10px',
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground3,
  },
  orphanTitle: { color: tokens.colorNeutralForeground3 },
  orphanPath: { fontFamily: MONO, color: tokens.colorNeutralForeground2 },
  // Harmless while `wrap` is true (there is nothing to scroll); the one thing that lets
  // `lineNoWrap`'s `white-space: pre` actually overflow sideways instead of clipping.
  fileBody: { overflowX: 'auto' },
});

export interface DiffViewProps {
  taskId: string;
  diffId: string;
  summary: DiffSummary;
  files: Readonly<Record<string, FileLoad>>;
  expanded: readonly string[];
  selectedPath: string | null;
  /** Every draft and sent comment on this card's review, in no particular order. */
  comments: readonly ReviewComment[];
  /** The open editor, or `null` — only one is ever open at a time. */
  editor: CommentEditor | null;
  /** Whether a new comment can be started at all (loaded ok, diff not stale). */
  canComment: boolean;
  /** Compact mode's gutter-becomes-a-button rendering (F3.8) — see the module header. */
  touch?: boolean;
  /** Whether a line wraps (`pre-wrap`, the default — wide rendering is unchanged) or scrolls
   * sideways instead (`pre`, `false`). */
  wrap?: boolean;
  /** Compact mode's tap-selected line/range, before a comment is started on it. */
  selection?: LineSelection | null;
  onToggleExpanded: (path: string) => void;
  onClickLine: (path: string, side: DiffSide, line: number, shift: boolean) => void;
  /** A gutter button tap in touch mode — `tapLine`'s own stand-in for `onClickLine`. */
  onTapLine?: (path: string, side: DiffSide, line: number) => void;
  onEditDraft: (text: string) => void;
  onSave: () => void;
  onCancel: () => void;
  onEdit: (comment: ReviewComment) => void;
  onDelete: (id: string) => void;
}

export function DiffView({
  taskId,
  diffId,
  summary,
  files,
  expanded,
  selectedPath,
  comments,
  editor,
  canComment,
  touch = false,
  wrap = true,
  selection = null,
  onToggleExpanded,
  onClickLine,
  onTapLine,
  onEditDraft,
  onSave,
  onCancel,
  onEdit,
  onDelete,
}: DiffViewProps): JSX.Element {
  const styles = useStyles();
  const rows = useRef<Record<string, HTMLDivElement | null>>({});

  useEffect(() => {
    if (!selectedPath) return;
    rows.current[selectedPath]?.scrollIntoView({ block: 'nearest' });
  }, [selectedPath]);

  const knownPaths = new Set(summary.files.map((entry) => entry.path));
  const orphaned = comments.filter((c) => !knownPaths.has(c.path));

  return (
    <div className={styles.root}>
      {summary.files.map((entry) => (
        <div
          key={entry.path}
          ref={(el) => {
            rows.current[entry.path] = el;
          }}
        >
          <FileSection
            taskId={taskId}
            diffId={diffId}
            entry={entry}
            expanded={expanded.includes(entry.path)}
            load={files[entry.path]}
            comments={comments.filter((c) => c.path === entry.path)}
            // Touch's editor lives in `ReviewPaneView`'s own bottom sheet, never inline —
            // see the module header.
            editor={touch ? null : editor?.path === entry.path ? editor : null}
            selection={selection?.path === entry.path ? selection : null}
            canComment={canComment}
            touch={touch}
            wrap={wrap}
            onToggleExpanded={onToggleExpanded}
            onClickLine={onClickLine}
            onTapLine={onTapLine}
            onEditDraft={onEditDraft}
            onSave={onSave}
            onCancel={onCancel}
            onEdit={onEdit}
            onDelete={onDelete}
          />
        </div>
      ))}
      {orphaned.length > 0 && (
        <OrphanedComments
          comments={orphaned}
          editor={touch || editor === null || knownPaths.has(editor.path) ? null : editor}
          onEditDraft={onEditDraft}
          onSave={onSave}
          onCancel={onCancel}
          onEdit={onEdit}
          onDelete={onDelete}
        />
      )}
    </div>
  );
}

/** Comments on a path the current diff no longer has at all — a rename, a revert, a path
 * that fell out of the summary. There is no file header left to list them under, so they
 * get their own section instead of being silently dropped. */
function OrphanedComments({
  comments,
  editor,
  onEditDraft,
  onSave,
  onCancel,
  onEdit,
  onDelete,
}: {
  comments: readonly ReviewComment[];
  editor: CommentEditor | null;
  onEditDraft: (text: string) => void;
  onSave: () => void;
  onCancel: () => void;
  onEdit: (comment: ReviewComment) => void;
  onDelete: (id: string) => void;
}): JSX.Element {
  const styles = useStyles();
  const byPath = new Map<string, ReviewComment[]>();
  for (const c of comments) {
    const group = byPath.get(c.path) ?? [];
    group.push(c);
    byPath.set(c.path, group);
  }
  return (
    <div className={styles.orphanSection}>
      <Caption1 className={styles.orphanTitle}>Comments on files no longer in the diff</Caption1>
      {[...byPath.entries()].map(([path, group]) => (
        <div key={path}>
          <Caption1 className={styles.orphanPath}>{path}</Caption1>
          <CommentThread
            comments={group}
            editor={editor?.path === path ? editor : null}
            onEditDraft={onEditDraft}
            onSave={onSave}
            onCancel={onCancel}
            onEdit={onEdit}
            onDelete={onDelete}
          />
        </div>
      ))}
    </div>
  );
}

interface CommentHandlers {
  onClickLine: (path: string, side: DiffSide, line: number, shift: boolean) => void;
  onTapLine?: (path: string, side: DiffSide, line: number) => void;
  onEditDraft: (text: string) => void;
  onSave: () => void;
  onCancel: () => void;
  onEdit: (comment: ReviewComment) => void;
  onDelete: (id: string) => void;
}

function FileSection({
  taskId,
  diffId,
  entry,
  expanded,
  load,
  comments,
  editor,
  selection,
  canComment,
  touch,
  wrap,
  onToggleExpanded,
  ...handlers
}: {
  taskId: string;
  diffId: string;
  entry: DiffFileEntry;
  expanded: boolean;
  load: FileLoad | undefined;
  comments: readonly ReviewComment[];
  editor: CommentEditor | null;
  selection: LineSelection | null;
  canComment: boolean;
  touch: boolean;
  wrap: boolean;
  onToggleExpanded: (path: string) => void;
} & CommentHandlers): JSX.Element {
  const styles = useStyles();
  const renamed = entry.oldPath !== undefined && entry.oldPath !== entry.path;
  const collapsedByDefault = isCollapsedByDefault(entry);

  // Only a LOADED text file has rendered rows to anchor against — everything else (not yet
  // fetched, binary, too large, stale) answers every one of this path's comments as
  // unanchored, so they are never silently missing while the human hasn't expanded yet.
  const loadedFile = load?.status === 'loaded' ? load.file : null;
  const unanchored = loadedFile
    ? comments.filter((c) => renderedIndex(loadedFile, c.side, c.line) === null)
    : comments;
  const anchored = loadedFile ? comments.filter((c) => !unanchored.includes(c)) : [];
  const editorAnchored =
    editor !== null &&
    loadedFile !== null &&
    renderedIndex(loadedFile, editor.anchor.side, editor.anchor.line) !== null;
  const unanchoredEditor = editor !== null && !editorAnchored ? editor : null;

  return (
    <div className={styles.file}>
      <div className={styles.fileHeader}>
        <Caption1 className={styles.letter}>{statusLetter(entry.status)}</Caption1>
        <Caption1 className={styles.path} title={entry.path}>
          {renamed ? `${entry.oldPath} → ${entry.path}` : entry.path}
        </Caption1>
        {entry.additions > 0 && <Caption1 className={styles.added}>+{entry.additions}</Caption1>}
        {entry.deletions > 0 && <Caption1 className={styles.deleted}>-{entry.deletions}</Caption1>}
        <Button size="small" appearance="subtle" onClick={() => onToggleExpanded(entry.path)}>
          {expanded ? 'Collapse' : collapsedByDefault ? 'Load anyway' : 'Expand'}
        </Button>
      </div>
      {(unanchored.length > 0 || unanchoredEditor !== null) && (
        <div className={styles.unanchored}>
          <Caption1 className={styles.unanchoredLabel}>
            {loadedFile ? 'Outdated — no longer in this diff' : 'Comments on this file'}
          </Caption1>
          <CommentThread
            comments={unanchored}
            editor={unanchoredEditor}
            onEditDraft={handlers.onEditDraft}
            onSave={handlers.onSave}
            onCancel={handlers.onCancel}
            onEdit={handlers.onEdit}
            onDelete={handlers.onDelete}
          />
        </div>
      )}
      {expanded && (
        <FileBody
          taskId={taskId}
          diffId={diffId}
          entry={entry}
          load={load}
          comments={anchored}
          editor={editorAnchored ? editor : null}
          selection={selection}
          canComment={canComment}
          touch={touch}
          wrap={wrap}
          {...handlers}
        />
      )}
    </div>
  );
}

function FileBody({
  taskId,
  diffId,
  entry,
  load,
  comments,
  editor,
  selection,
  canComment,
  touch,
  wrap,
  ...handlers
}: {
  taskId: string;
  diffId: string;
  entry: DiffFileEntry;
  load: FileLoad | undefined;
  comments: readonly ReviewComment[];
  editor: CommentEditor | null;
  selection: LineSelection | null;
  canComment: boolean;
  touch: boolean;
  wrap: boolean;
} & CommentHandlers): JSX.Element {
  const styles = useStyles();

  if (entry.image) {
    return <ImageDiffBody taskId={taskId} diffId={diffId} path={entry.path} />;
  }
  if (entry.binary) {
    return (
      <Caption1 className={styles.notice}>
        Binary file · {entry.bytes.toLocaleString()} bytes
      </Caption1>
    );
  }
  if (load === undefined || load.status === 'idle') {
    const notice = fileLoadNotice(load);
    return notice !== null ? (
      <Caption1 className={styles.notice}>{notice}</Caption1>
    ) : (
      <div className={styles.notice}>
        <Spinner size="tiny" label="Loading…" labelPosition="after" />
      </div>
    );
  }
  if (load.status === 'loading') {
    return (
      <div className={styles.notice}>
        <Spinner size="tiny" label="Loading…" labelPosition="after" />
      </div>
    );
  }
  if (
    load.status === 'tooLarge' ||
    load.status === 'stale' ||
    load.status === 'tooLargeForBrowser'
  ) {
    return <Caption1 className={styles.notice}>{fileLoadNotice(load)}</Caption1>;
  }

  // The editor's own range in wide mode, or touch's tap `selection` in compact — never both
  // at once (`commentOnSelection` clears `selection` the same transition it opens `editor`).
  const range = editor ?? selection;
  const highlighted = range ? new Set(rangeLines(load.file, range)) : null;

  return (
    <div className={styles.fileBody}>
      {load.file.hunks.map((hunk, i) => (
        <Hunk
          key={i}
          path={entry.path}
          hunk={hunk}
          comments={comments}
          editor={editor}
          canComment={canComment}
          touch={touch}
          wrap={wrap}
          highlighted={highlighted}
          {...handlers}
        />
      ))}
    </div>
  );
}

/** For an `add`/`context` row, a comment anchors to the NEW side; a `del` row has no new side
 * to anchor to, so it is the OLD side instead — whichever side still carries the line. */
function canonicalTarget(line: DiffLine): { side: DiffSide; line: number } | null {
  if (line.kind === 'del') {
    return line.oldLine !== undefined ? { side: 'old', line: line.oldLine } : null;
  }
  return line.newLine !== undefined ? { side: 'new', line: line.newLine } : null;
}

function commentsForLine(
  comments: readonly ReviewComment[],
  line: DiffLine,
): readonly ReviewComment[] {
  return comments.filter(
    (c) =>
      (c.side === 'old' && line.oldLine === c.line) ||
      (c.side === 'new' && line.newLine === c.line),
  );
}

function Hunk({
  path,
  hunk,
  comments,
  editor,
  canComment,
  touch,
  wrap,
  highlighted,
  onClickLine,
  onTapLine,
  onEditDraft,
  onSave,
  onCancel,
  onEdit,
  onDelete,
}: {
  path: string;
  hunk: DiffHunk;
  comments: readonly ReviewComment[];
  editor: CommentEditor | null;
  canComment: boolean;
  touch: boolean;
  wrap: boolean;
  highlighted: ReadonlySet<DiffLine> | null;
} & CommentHandlers): JSX.Element {
  const styles = useStyles();
  const words = pairWordDiffs(hunk.lines);
  return (
    <div>
      <Caption1 className={styles.hunkHeader}>{hunk.header}</Caption1>
      {hunk.lines.map((line, i) => {
        const target = canonicalTarget(line);
        const rowEditor =
          editor !== null &&
          target !== null &&
          editor.anchor.side === target.side &&
          editor.anchor.line === target.line
            ? editor
            : null;
        return (
          <div key={i}>
            <DiffLineRow
              path={path}
              line={line}
              words={words[i]}
              target={target}
              canComment={canComment}
              touch={touch}
              wrap={wrap}
              selected={highlighted?.has(line) ?? false}
              onClickLine={onClickLine}
              onTapLine={onTapLine}
            />
            <CommentThread
              comments={commentsForLine(comments, line)}
              editor={rowEditor}
              onEditDraft={onEditDraft}
              onSave={onSave}
              onCancel={onCancel}
              onEdit={onEdit}
              onDelete={onDelete}
            />
          </div>
        );
      })}
    </div>
  );
}

function DiffLineRow({
  path,
  line,
  words,
  target,
  canComment,
  touch,
  wrap,
  selected,
  onClickLine,
  onTapLine,
}: {
  path: string;
  line: DiffLine;
  words: readonly WordSegment[] | null;
  target: { side: DiffSide; line: number } | null;
  canComment: boolean;
  touch: boolean;
  wrap: boolean;
  selected: boolean;
  onClickLine: (path: string, side: DiffSide, line: number, shift: boolean) => void;
  onTapLine?: (path: string, side: DiffSide, line: number) => void;
}): JSX.Element {
  const styles = useStyles();
  return (
    <div
      className={mergeClasses(
        styles.line,
        !wrap && styles.lineNoWrap,
        line.kind === 'add' && styles.lineAdd,
        line.kind === 'del' && styles.lineDel,
        selected && styles.lineSelected,
      )}
    >
      {touch ? (
        <button
          type="button"
          className={styles.gutterButton}
          disabled={!canComment || target === null}
          aria-label={target ? `Select line ${target.line}` : undefined}
          onClick={() => target && onTapLine?.(path, target.side, target.line)}
        >
          <span>{line.oldLine ?? ''}</span>
          <span>{line.newLine ?? ''}</span>
        </button>
      ) : (
        <>
          <span className={styles.addCell}>
            {target && (
              <Button
                className={styles.addButton}
                data-add-comment=""
                size="small"
                appearance="subtle"
                icon={<AddRegular />}
                disabled={!canComment}
                aria-label={`Comment on line ${target.line}`}
                onClick={(e) => onClickLine(path, target.side, target.line, e.shiftKey)}
              />
            )}
          </span>
          <span className={styles.gutter}>{line.oldLine ?? ''}</span>
          <span className={styles.gutter}>{line.newLine ?? ''}</span>
        </>
      )}
      <span className={styles.text}>
        {words
          ? words.map((segment, i) => (
              <span
                key={i}
                data-word={segment.kind}
                className={mergeClasses(
                  segment.kind === 'add' && styles.wordAdd,
                  segment.kind === 'del' && styles.wordDel,
                )}
              >
                {segment.text}
              </span>
            ))
          : line.text || ' '}
      </span>
    </div>
  );
}

type ImageLoad =
  | { status: 'loading' }
  | { status: 'loaded'; image: DiffImage }
  | { status: 'stale' }
  | { status: 'error'; message: string };

function ImageDiffBody({
  taskId,
  diffId,
  path,
}: {
  taskId: string;
  diffId: string;
  path: string;
}): JSX.Element {
  const styles = useStyles();
  const transport = useTransport();
  const [state, setState] = useState<ImageLoad>({ status: 'loading' });

  useEffect(() => {
    let live = true;
    setState({ status: 'loading' });
    void transport.invoke('task:diffImage', taskId, diffId, path).then(
      (result) => {
        if (!live) return;
        setState(
          result.status === 'ok' ? { status: 'loaded', image: result.image } : { status: 'stale' },
        );
      },
      (e: unknown) => {
        if (!live) return;
        setState({ status: 'error', message: e instanceof Error ? e.message : String(e) });
      },
    );
    return () => {
      live = false;
    };
  }, [transport, taskId, diffId, path]);

  if (state.status === 'loading') {
    return (
      <div className={styles.notice}>
        <Spinner size="tiny" label="Loading image…" labelPosition="after" />
      </div>
    );
  }
  if (state.status === 'error') {
    const bytes = parseOversizedAnswer(state.message);
    return (
      <Caption1 className={styles.notice}>
        {bytes === null
          ? `Couldn't load this image: ${state.message}`
          : fileLoadNotice({ status: 'tooLargeForBrowser', bytes })}
      </Caption1>
    );
  }
  if (state.status === 'stale') {
    return (
      <Caption1 className={styles.notice}>
        The files changed since this was loaded — reload to see the latest.
      </Caption1>
    );
  }

  return (
    <div className={styles.images}>
      <ImageSide label="Before" side={state.image.old} />
      <ImageSide label="After" side={state.image.new} />
    </div>
  );
}

function ImageSide({ label, side }: { label: string; side: DiffImageSide | null }): JSX.Element {
  const styles = useStyles();
  if (side === null) {
    return <Body1 className={styles.notice}>{label}: none</Body1>;
  }
  if ('tooLarge' in side) {
    return (
      <Body1 className={styles.notice}>
        {label}: too large to preview ({side.bytes.toLocaleString()} bytes)
      </Body1>
    );
  }
  return (
    <figure className={styles.imageFigure}>
      <figcaption>
        <Caption1>{label}</Caption1>
      </figcaption>
      <img
        className={styles.imagePreview}
        src={`data:${side.mime};base64,${side.base64}`}
        alt={`${label} version`}
      />
    </figure>
  );
}
