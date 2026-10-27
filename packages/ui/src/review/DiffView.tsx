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
 * word highlight one step stronger so it reads against that tint — plus, now, syntax
 * highlighting (F15.11): five hues on the code's own text (keywords, strings, comments,
 * numbers, titles), which is content INSIDE the code surface, same as the add/del tint it
 * sits on top of. Everything else (gutters, headers, notices) stays on neutral tokens,
 * unchanged.
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
  Checkbox,
  Spinner,
  makeStyles,
  mergeClasses,
  tokens,
} from '@fluentui/react-components';
import { AddRegular } from '@fluentui/react-icons';
import { parseOversizedAnswer } from '@tm/shared/ipcRelay';
import { isCollapsedByDefault, type ViewedStatus } from '@tm/shared/review';
import type {
  DiffFileEntry,
  DiffHunk,
  DiffImage,
  DiffImageSide,
  DiffLine,
  DiffSide,
  DiffSummary,
  ReviewComment,
  SplitRow,
  WordSegment,
} from '@tm/shared/review';
import { MONO, SYNTAX, fontPx } from '../theme';
import { DIFF_VAR } from '../tokens';
import { useTransport } from '../transport';
import { CommentThread } from './CommentThread';
import type { HunkHighlight } from './highlight';
import { mergeSegments, type SyntaxScope, type SyntaxSegment } from './syntaxSegment';
import {
  rangeLines,
  renderedIndex,
  type CommentEditor,
  type FileLoad,
  type LineSelection,
} from './reviewState';
import {
  fileLoadNotice,
  pairWordDiffs,
  splitCellComments,
  splitCellTarget,
  splitRows,
  statusLetter,
} from './reviewView';
import type { DiffLayout } from './reviewView';

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
  // `flat`: no card of its own — the add/del tints are alphas, so the surface under them
  // decides the colour you see, and v9-6/v9-6b draw the diff straight on the pane.
  fileFlat: { backgroundColor: 'transparent' },
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
  viewedBox: { flexShrink: 0 },
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
  // The mockups' muted tints, not Fluent's palette solids — see `DiffTintTokens`.
  lineAdd: { backgroundColor: DIFF_VAR.add },
  lineDel: { backgroundColor: DIFF_VAR.del },
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
  wordAdd: { backgroundColor: DIFF_VAR.addWord },
  wordDel: { backgroundColor: DIFF_VAR.delWord },
  // Syntax highlighting (F15.11) — colour only, never a background: the add/del tint above
  // already owns that, and `DiffLineRow`'s merge rule relies on these never fighting it.
  synKeyword: { color: SYNTAX.keyword },
  synString: { color: SYNTAX.string },
  synComment: { color: SYNTAX.comment },
  synNumber: { color: SYNTAX.number },
  synTitle: { color: SYNTAX.title },
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
  splitRow: { display: 'flex', alignItems: 'stretch' },
  splitColumn: { flex: '1 1 0', minWidth: 0 },
  splitColumnRight: { borderLeft: `1px solid ${tokens.colorNeutralStroke2}` },
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
  /** `'unified'` (the default) renders exactly as before this prop existed; `'split'` draws
   * each hunk as two columns instead (F15.12). The caller decides which — through
   * `effectiveDiffLayout` — so touch mode never reaches here as `'split'`. */
  layout?: DiffLayout;
  /** Whether a line wraps (`pre-wrap`, the default — wide rendering is unchanged) or scrolls
   * sideways instead (`pre`, `false`). */
  wrap?: boolean;
  /** Whether the diff shows syntax colour at all (F15.11, `AppSettings.monochromeCode`
   * inverted) — `false`/unset highlights, same as before this setting existed. */
  monochrome?: boolean;
  /** Draw each file straight on the host's own pane instead of its darker
   * `colorNeutralBackground3` card — the review workspace, whose mockups draw no card. */
  flat?: boolean;
  /** Compact mode's tap-selected line/range, before a comment is started on it. */
  selection?: LineSelection | null;
  /** Each file's viewed status. With `onToggleViewed`, draws a "Viewed" box in every file
   * header — `FileTree`'s own both-or-neither contract; the Changes pane passes neither. */
  viewed?: Readonly<Record<string, ViewedStatus>>;
  onToggleViewed?: (path: string) => void;
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
  layout = 'unified',
  wrap = true,
  monochrome = false,
  flat = false,
  selection = null,
  viewed,
  onToggleViewed,
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
  const viewedProps: ViewedProps | undefined =
    viewed && onToggleViewed ? { viewed, onToggleViewed } : undefined;

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
            layout={layout}
            wrap={wrap}
            monochrome={monochrome}
            flat={flat}
            viewedProps={viewedProps}
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

/** The header box's inputs, present only when the host passed BOTH props. */
interface ViewedProps {
  viewed: Readonly<Record<string, ViewedStatus>>;
  onToggleViewed: (path: string) => void;
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
  layout,
  wrap,
  monochrome,
  flat,
  viewedProps,
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
  layout: DiffLayout;
  wrap: boolean;
  monochrome: boolean;
  flat: boolean;
  viewedProps: ViewedProps | undefined;
  onToggleExpanded: (path: string) => void;
} & CommentHandlers): JSX.Element {
  const styles = useStyles();
  const renamed = entry.oldPath !== undefined && entry.oldPath !== entry.path;
  const collapsedByDefault = isCollapsedByDefault(entry);
  const viewedStatus = viewedProps?.viewed[entry.path] ?? 'unviewed';

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
    <div className={mergeClasses(styles.file, flat && styles.fileFlat)}>
      <div className={styles.fileHeader}>
        <Caption1 className={styles.letter}>{statusLetter(entry.status)}</Caption1>
        <Caption1 className={styles.path} title={entry.path}>
          {renamed ? `${entry.oldPath} → ${entry.path}` : entry.path}
        </Caption1>
        {entry.additions > 0 && <Caption1 className={styles.added}>+{entry.additions}</Caption1>}
        {entry.deletions > 0 && <Caption1 className={styles.deleted}>-{entry.deletions}</Caption1>}
        {viewedProps && (
          <Checkbox
            className={styles.viewedBox}
            label="Viewed"
            aria-label={`Viewed ${entry.path}`}
            title={viewedStatus === 'changed' ? 'Changed since viewed' : undefined}
            checked={viewedStatus === 'viewed'}
            data-diff-viewed={viewedStatus}
            // Its own control: ticking it must never reach the header's collapse toggle.
            onClick={(event) => event.stopPropagation()}
            onChange={() => viewedProps.onToggleViewed(entry.path)}
          />
        )}
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
          layout={layout}
          wrap={wrap}
          monochrome={monochrome}
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
  layout,
  wrap,
  monochrome,
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
  layout: DiffLayout;
  wrap: boolean;
  monochrome: boolean;
} & CommentHandlers): JSX.Element {
  const styles = useStyles();
  const loadedHunks = load?.status === 'loaded' ? load.file.hunks : EMPTY_HUNKS;
  const hunkHighlights = useHunkHighlights(entry.path, loadedHunks, monochrome);

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

  // `effectiveDiffLayout` never hands this `'split'` while `touch` is true, so `SplitHunk`
  // needs no touch branch of its own — see the module header.
  if (layout === 'split') {
    const rowsByHunk = splitRows(load.file);
    return (
      <div className={styles.fileBody}>
        {load.file.hunks.map((hunk, i) => (
          <SplitHunk
            key={i}
            path={entry.path}
            hunk={hunk}
            rows={rowsByHunk[i]}
            comments={comments}
            editor={editor}
            canComment={canComment}
            wrap={wrap}
            highlighted={highlighted}
            {...handlers}
          />
        ))}
      </div>
    );
  }

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
          syntax={hunkHighlights[i]}
          {...handlers}
        />
      ))}
    </div>
  );
}

/** A stable empty array, so `useHunkHighlights` sees the same dependency identity across
 * renders while a file isn't `loaded` yet — a fresh `[]` every render would restart its
 * effect for no reason. */
const EMPTY_HUNKS: readonly DiffHunk[] = [];

/**
 * Resolves `path`'s language, loads its grammar, then highlights each of `hunks` one hunk at a
 * time (through the loaded module's own idle scheduler), so a large file never blocks a frame.
 * Returns each hunk's {@link HunkHighlight} as soon as it lands, indexed by its position in
 * `hunks`; a hunk not yet highlighted (or never going to be) is simply absent.
 *
 * Reaches `./highlight` — `highlight.js/lib/core` plus the per-language grammars — through a
 * dynamic `import()` rather than a top-level one, so that whole module loads as its own chunk
 * instead of landing in the entry bundle (see that module's own header). Skips all of it —
 * returning `[]` and doing no work — when `monochrome` is set, when `path` has no known
 * language, or when the file is over the loaded module's own line-count cap: a file that big
 * is already a lot to render plain, and highlighting it would cost more than a diff this size
 * is ever read for.
 */
function useHunkHighlights(
  path: string,
  hunks: readonly DiffHunk[],
  monochrome: boolean,
): ReadonlyArray<HunkHighlight | undefined> {
  const [highlights, setHighlights] = useState<ReadonlyArray<HunkHighlight | undefined>>([]);

  useEffect(() => {
    setHighlights([]);
    if (monochrome) return;

    const controller = new AbortController();
    void import('./highlight').then((mod) => {
      if (controller.signal.aborted) return;
      const lang = mod.languageForPath(path);
      if (lang === null) return;
      const totalLines = hunks.reduce((sum, hunk) => sum + hunk.lines.length, 0);
      if (totalLines > mod.MAX_FILE_LINES) return;

      void mod.loadLanguage(lang).then(() => {
        if (controller.signal.aborted) return;
        mod.scheduleIdle(
          hunks.map((hunk, i) => () => {
            const result = mod.highlightHunk(lang, hunk);
            setHighlights((prev) => {
              const next = prev.slice();
              next[i] = result;
              return next;
            });
          }),
          controller.signal,
        );
      });
    });

    return () => controller.abort();
  }, [path, hunks, monochrome]);

  return highlights;
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
  syntax,
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
  /** This hunk's own syntax highlight, once {@link useHunkHighlights} has resolved it —
   * `undefined` renders every one of its lines plain. */
  syntax: HunkHighlight | undefined;
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
        // A `del` line only ever exists on the OLD side; everything else (add/context) is
        // read from the NEW side — same side `canonicalTarget` picks, and for context lines
        // the two sides' text (and so segmentation) agree anyway.
        const segments = line.kind === 'del' ? syntax?.old.get(i) : syntax?.new.get(i);
        return (
          <div key={i}>
            <DiffLineRow
              path={path}
              line={line}
              words={words[i]}
              segments={segments}
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

/** `Hunk`'s side-by-side sibling (F15.12): the same hunk header and `pairWordDiffs`, but one
 * two-column {@link SplitRow} per row instead of one line. Each column gets its own
 * `SplitDiffLineRow` and its own `CommentThread` — a context row's two cells share one
 * `DiffLine` but anchor to different sides, so they never share a comment either (see
 * `splitCellTarget`/`splitCellComments` in `reviewView.ts`). Never rendered in touch mode —
 * `effectiveDiffLayout` keeps `layout` at `'unified'` whenever `touch` is true — so unlike
 * `Hunk` this takes no `touch`/`onTapLine` of its own. */
function SplitHunk({
  path,
  hunk,
  rows,
  comments,
  editor,
  canComment,
  wrap,
  highlighted,
  onClickLine,
  onEditDraft,
  onSave,
  onCancel,
  onEdit,
  onDelete,
}: {
  path: string;
  hunk: DiffHunk;
  rows: readonly SplitRow[];
  comments: readonly ReviewComment[];
  editor: CommentEditor | null;
  canComment: boolean;
  wrap: boolean;
  highlighted: ReadonlySet<DiffLine> | null;
  onClickLine: (path: string, side: DiffSide, line: number, shift: boolean) => void;
  onEditDraft: (text: string) => void;
  onSave: () => void;
  onCancel: () => void;
  onEdit: (comment: ReviewComment) => void;
  onDelete: (id: string) => void;
}): JSX.Element {
  const styles = useStyles();
  const words = pairWordDiffs(hunk.lines);
  return (
    <div>
      <Caption1 className={styles.hunkHeader}>{hunk.header}</Caption1>
      {rows.map((row, i) => {
        const leftTarget = splitCellTarget(row, 'old');
        const rightTarget = splitCellTarget(row, 'new');
        const leftEditor =
          editor !== null &&
          leftTarget !== null &&
          editor.anchor.side === leftTarget.anchor.side &&
          editor.anchor.line === leftTarget.anchor.line
            ? editor
            : null;
        const rightEditor =
          editor !== null &&
          rightTarget !== null &&
          editor.anchor.side === rightTarget.anchor.side &&
          editor.anchor.line === rightTarget.anchor.line
            ? editor
            : null;
        return (
          <div key={i} className={styles.splitRow}>
            <div className={styles.splitColumn}>
              <SplitDiffLineRow
                path={path}
                line={row.left}
                words={row.leftIndex !== null ? words[row.leftIndex] : null}
                target={leftTarget?.anchor ?? null}
                canComment={canComment}
                wrap={wrap}
                selected={row.left !== null && (highlighted?.has(row.left) ?? false)}
                onClickLine={onClickLine}
              />
              <CommentThread
                comments={splitCellComments(comments, row, 'old')}
                editor={leftEditor}
                onEditDraft={onEditDraft}
                onSave={onSave}
                onCancel={onCancel}
                onEdit={onEdit}
                onDelete={onDelete}
              />
            </div>
            <div className={mergeClasses(styles.splitColumn, styles.splitColumnRight)}>
              <SplitDiffLineRow
                path={path}
                line={row.right}
                words={row.rightIndex !== null ? words[row.rightIndex] : null}
                target={rightTarget?.anchor ?? null}
                canComment={canComment}
                wrap={wrap}
                selected={row.right !== null && (highlighted?.has(row.right) ?? false)}
                onClickLine={onClickLine}
              />
              <CommentThread
                comments={splitCellComments(comments, row, 'new')}
                editor={rightEditor}
                onEditDraft={onEditDraft}
                onSave={onSave}
                onCancel={onCancel}
                onEdit={onEdit}
                onDelete={onDelete}
              />
            </div>
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
  segments,
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
  /** This line's own syntax segments, once resolved — `undefined` renders plain (or, with
   * `words` present, renders the word diff with no syntax colour on top of it yet). */
  segments: readonly SyntaxSegment[] | undefined;
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
        {words && segments
          ? mergeSegments(segments, words).map((segment, i) => (
              <span
                key={i}
                data-word={segment.word}
                className={mergeClasses(
                  segment.word === 'add' && styles.wordAdd,
                  segment.word === 'del' && styles.wordDel,
                  scopeClass(styles, segment.scope),
                )}
              >
                {segment.text}
              </span>
            ))
          : words
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
            : segments
              ? segments.map((segment, i) => (
                  <span key={i} className={scopeClass(styles, segment.scope)}>
                    {segment.text}
                  </span>
                ))
              : line.text || ' '}
      </span>
    </div>
  );
}

/** `DiffLineRow`'s split-column sibling (F15.12) — one side of one {@link SplitRow}, never
 * both. `line: null` is a padded gap (the other side's del/add run ran longer than this one),
 * drawn as a blank row with no gutter, no add button and no text, so the two columns still
 * line up. Otherwise the same gutter/add-button/word-span rendering and style tokens as
 * `DiffLineRow`, except there is only ever one gutter number — `target.line` already picked
 * this cell's own side (`splitCellTarget` in `reviewView.ts`). Touch mode never reaches here
 * (see `SplitHunk`), so unlike `DiffLineRow` there is no gutter-button branch, and no syntax
 * `segments` yet either — split doesn't wire highlighting in this step. */
function SplitDiffLineRow({
  path,
  line,
  words,
  target,
  canComment,
  wrap,
  selected,
  onClickLine,
}: {
  path: string;
  line: DiffLine | null;
  words: readonly WordSegment[] | null;
  target: { side: DiffSide; line: number } | null;
  canComment: boolean;
  wrap: boolean;
  selected: boolean;
  onClickLine: (path: string, side: DiffSide, line: number, shift: boolean) => void;
}): JSX.Element {
  const styles = useStyles();
  if (line === null) {
    return <div className={mergeClasses(styles.line, !wrap && styles.lineNoWrap)} />;
  }
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
      <span className={styles.gutter}>{target?.line ?? ''}</span>
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

/** The one `makeStyles` class a {@link SyntaxScope} maps to — `null` (and anything
 * `SCOPE_MAP` in `highlight.ts` doesn't bucket) renders with no colour class at all. */
function scopeClass(
  styles: Record<'synKeyword' | 'synString' | 'synComment' | 'synNumber' | 'synTitle', string>,
  scope: SyntaxScope | null,
): string | undefined {
  switch (scope) {
    case 'keyword':
      return styles.synKeyword;
    case 'string':
      return styles.synString;
    case 'comment':
      return styles.synComment;
    case 'number':
      return styles.synNumber;
    case 'title':
      return styles.synTitle;
    default:
      return undefined;
  }
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
