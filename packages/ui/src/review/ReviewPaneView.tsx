/**
 * The Changes pane's pure rendering half: a `ReviewState` in, Fluent JSX out — no
 * `useTransport`, no effects, no fetch loop. {@link ReviewPane} is the thin wrapper that
 * owns those and feeds this one a `state` it already has the answer for, which is what
 * lets a headless script seed a `ReviewState` by hand (through `reviewState.ts`'s own
 * transitions) and render exactly what a human would see, with no engine behind it at all.
 *
 * Word-level highlights are computed per HUNK, never across the whole file: `pairWordDiffs`
 * pairs a del run with the add run immediately after it, and two hunks are themselves
 * separated by lines neither hunk carries, so pairing across that gap would highlight two
 * lines that were never adjacent in the real file.
 *
 * Colour budget (memory *board-colour-budget*, and F6's own design doc): the ONLY colour
 * here is added/removed content — a line's own tint at its subtlest step, and the inner
 * word highlight one step stronger so it reads against that tint, plus the same green/red
 * reused (never a third hue) for the +/− counts. Everything else stays on neutral tokens.
 *
 * **Compact layout** (`layout === 'compact'`, from `TaskDetail`'s own per-section tab, F3.8):
 * the same `ReviewState` drives a different body. A **Files (n)** button and a **Wrap**
 * `Switch` stand in for the wide file tree sitting beside the diff — picking a file from the
 * `Files` sheet closes it and lets `DiffView`'s own scroll-to-selected do the rest. A sticky
 * footer carries Cancel/Comment for the active tap `selection` plus an always-present
 * Note/Send review row, so neither ever scrolls out of reach on a phone; the overall note
 * moves from the wide pane's `Popover` into its own bottom sheet for the same reason a
 * `Popover` anchored to a toolbar button stops working once the toolbar itself is this
 * cramped. The comment editor never renders inline here — `DiffView`'s own `touch` mode
 * suppresses that — it opens in a bottom sheet instead, shared by a brand new comment and an
 * Edit on an existing draft alike (`state.editor !== null` either way).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { JSX } from 'react';
import {
  Body1,
  Button,
  Caption1,
  DrawerBody,
  DrawerHeader,
  DrawerHeaderTitle,
  MessageBar,
  MessageBarActions,
  MessageBarBody,
  OverlayDrawer,
  Popover,
  PopoverSurface,
  PopoverTrigger,
  Spinner,
  Switch,
  Textarea,
  makeStyles,
  mergeClasses,
  tokens,
} from '@fluentui/react-components';
import {
  ArrowClockwiseRegular,
  NoteEditRegular,
  SendRegular,
  WindowNewRegular,
} from '@fluentui/react-icons';
import type { DiffLine, DiffSide, ReviewComment, ReviewSendRefusal } from '@tm/shared/review';
import { MONO } from '../theme';
import { CommentEditorCard, DismissedToggle } from './CommentThread';
import { DiffView } from './DiffView';
import { FileTree } from './FileTree';
import {
  canComment,
  canSend,
  dismissedCount,
  rangeLines,
  unsentCount,
  visibleComments,
  type CommentEditor,
  type FileLoad,
  type ReviewState,
} from './reviewState';
import {
  buildFileTree,
  effectiveDiffLayout,
  selectionLabel,
  sendRefusalText,
  summaryTotals,
} from './reviewView';
import { useDiffLayout } from './useDiffLayout';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: '8px' },
  header: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
  refs: { fontFamily: MONO, color: tokens.colorNeutralForeground2 },
  totals: { color: tokens.colorNeutralForeground3 },
  added: { color: tokens.colorPaletteGreenForeground1 },
  deleted: { color: tokens.colorPaletteRedForeground1 },
  uncommitted: { color: tokens.colorNeutralForeground3 },
  spacer: { flex: 1 },
  notice: { color: tokens.colorNeutralForeground3 },
  link: { color: tokens.colorBrandForegroundLink },
  body: { display: 'flex', gap: '10px', minHeight: 0 },
  // The wide pane's own width (excluding the file tree) — what `effectiveDiffLayout` checks
  // against `SPLIT_MIN_WIDTH_PX` — shares `DiffView`'s own flex basis so wrapping it here
  // changes nothing about the layout `styles.body` already produces.
  diffContainer: { flex: '2 1 480px', minWidth: 0 },
  layoutPill: { display: 'flex', gap: '2px' },
  unsent: { color: tokens.colorNeutralForeground3 },
  note: { width: '320px', display: 'flex', flexDirection: 'column', gap: '6px', padding: '4px' },
  // Compact layout (F3.8): a single-column body, no file tree beside the diff — `Files (n)`
  // opens it as a sheet instead.
  compactBody: { display: 'flex', flexDirection: 'column', gap: '8px', minHeight: 0 },
  reloadCompact: { minWidth: '44px', minHeight: '44px' },
  sheetBody: { display: 'flex', flexDirection: 'column', gap: '6px', padding: '4px' },
  // Sticky over the diff rather than scrolling away with it — the one thing that keeps
  // Comment/Send review reachable while a phone's own keyboard is already eating half the
  // screen.
  stickyFooter: {
    position: 'sticky',
    bottom: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: '6px',
    padding: '8px',
    backgroundColor: tokens.colorNeutralBackground1,
    borderTop: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  footerRow: { display: 'flex', alignItems: 'center', gap: '8px' },
  footerButton: { minHeight: '44px' },
  selectionCaption: { fontFamily: MONO, color: tokens.colorNeutralForeground2 },
  // The comment sheet's own excerpt of the lines it is anchored to — the same green/red
  // tint `DiffView`'s own lines use, never a third colour (board-colour-budget).
  excerpt: {
    display: 'flex',
    flexDirection: 'column',
    fontFamily: MONO,
    fontSize: '12px',
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    overflow: 'hidden',
    marginBottom: '8px',
  },
  excerptLine: { padding: '2px 8px', whiteSpace: 'pre-wrap' },
  excerptAdd: { backgroundColor: tokens.colorPaletteGreenBackground1 },
  excerptDel: { backgroundColor: tokens.colorPaletteRedBackground1 },
});

export interface ReviewPaneViewProps {
  taskId: string;
  state: ReviewState;
  /** A failed `task:diffSummary`/`task:diffFile` call — not part of `ReviewState` itself. */
  error: string | null;
  /**
   * Set when the desktop host cannot be reached — `TaskDetail`'s own `hostUnreachable`, carried
   * all the way down. The pane keeps whatever `state` it last loaded on screen, shows a warning
   * bar in its place, and disables commenting and Send review (`canComment`/`canSend`'s own
   * `readOnly`) rather than looking live over a channel that cannot answer (F6.13).
   */
  unreachable?: string;
  /** `'compact'` for the compact full-screen card screen's own Changes tab (F3.8); `undefined`
   * (wide) everywhere else. */
  layout?: 'wide' | 'compact';
  /** Whether the diff shows syntax colour at all — `ReviewPane`'s own live read of
   * `AppSettings.monochromeCode` (F15.11), carried straight through to {@link DiffView}. */
  monochrome?: boolean;
  onReload: () => void;
  /**
   * Opens this card's diff in the review workspace — `ReviewPane`'s own wiring of the host's
   * `ReviewWorkspaceOpener` (F15.14b). `undefined` (no opener mounted) draws no button; the
   * compact pane never draws it either, since the phone keeps its own Changes tab.
   */
  onOpenInWorkspace?: () => void;
  onSelectFile: (path: string) => void;
  onToggleExpanded: (path: string) => void;
  onClickLine: (path: string, side: DiffSide, line: number, shift: boolean) => void;
  /** A gutter button tap in compact mode — `tapLine`'s own stand-in for `onClickLine`. */
  onTapLine: (path: string, side: DiffSide, line: number) => void;
  /** Dismisses the compact pane's own tap `selection` without starting a comment. */
  onCancelSelection: () => void;
  /** Starts a comment from the compact pane's own tap `selection`. */
  onCommentSelection: () => void;
  onEditDraft: (text: string) => void;
  onSave: () => void;
  onCancel: () => void;
  onEdit: (comment: ReviewComment) => void;
  onDelete: (id: string) => void;
  /** Keep · Dismiss · Restore on an AI draft (Edit is `onEdit`). */
  onAccept?: (id: string) => void;
  onDismiss?: (id: string) => void;
  onRestore?: (id: string) => void;
  /** Flips "show dismissed (N)" beside the unsent count. */
  onToggleShowDismissed?: () => void;
  onEditNote: (text: string) => void;
  onSend: () => void;
}

/** The lines `range` covers in `path`'s loaded file, or `[]` while it is not loaded — the
 * compact pane's own comment sheet shows these as a read-only excerpt above the editor. */
function excerptLines(
  files: Readonly<Record<string, FileLoad>>,
  path: string,
  range: Pick<CommentEditor, 'anchor' | 'start'>,
): readonly DiffLine[] {
  const load = files[path];
  if (load === undefined || load.status !== 'loaded') return [];
  return rangeLines(load.file, range);
}

/**
 * The wide pane's own diff container width, for `effectiveDiffLayout`'s `SPLIT_MIN_WIDTH_PX`
 * check — modeled on `useCardAnchors`' own measure loop: a `ResizeObserver` schedules a single
 * rAF-debounced remeasure, and a width that did not change triggers no re-render. Starts
 * `null` (not measured yet) rather than `0`, so a first render before the observer reports in
 * never reads as "too narrow for split". Also measures the review workspace's diff column.
 */
export function useWidePaneWidth(): {
  containerRef: (el: HTMLDivElement | null) => void;
  widthPx: number | null;
} {
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  const [widthPx, setWidthPx] = useState<number | null>(null);
  const frame = useRef<number | null>(null);

  const measure = useCallback(() => {
    if (!container) return;
    const next = container.clientWidth;
    setWidthPx((prev) => (prev === next ? prev : next));
  }, [container]);

  const schedule = useCallback(() => {
    if (frame.current !== null) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      measure();
    });
  }, [measure]);

  useEffect(() => {
    if (!container) return;
    const ro = new ResizeObserver(schedule);
    ro.observe(container);
    schedule();
    return () => {
      ro.disconnect();
      if (frame.current !== null) {
        cancelAnimationFrame(frame.current);
        frame.current = null;
      }
    };
  }, [container, schedule]);

  return { containerRef: setContainer, widthPx };
}

export function ReviewPaneView({
  taskId,
  state,
  error,
  unreachable,
  layout,
  monochrome,
  onReload,
  onOpenInWorkspace,
  onSelectFile,
  onToggleExpanded,
  onClickLine,
  onTapLine,
  onCancelSelection,
  onCommentSelection,
  onEditDraft,
  onSave,
  onCancel,
  onEdit,
  onDelete,
  onAccept,
  onDismiss,
  onRestore,
  onToggleShowDismissed,
  onEditNote,
  onSend,
}: ReviewPaneViewProps): JSX.Element {
  const styles = useStyles();
  const { summary } = state;
  const readOnly = unreachable !== undefined;
  const compact = layout === 'compact';
  const [wrap, setWrap] = useState(true);
  const [filesOpen, setFilesOpen] = useState(false);
  const [noteOpen, setNoteOpen] = useState(false);
  const [preferredDiffLayout, setPreferredDiffLayout] = useDiffLayout();
  const { containerRef: diffContainerRef, widthPx: diffWidthPx } = useWidePaneWidth();

  let body: JSX.Element | null = null;
  if (summary === null) {
    body = state.loading ? (
      <Spinner size="tiny" label="Loading changes…" labelPosition="after" />
    ) : null;
  } else if (summary.status === 'no-branch') {
    body = <Body1 className={styles.notice}>This card hasn&apos;t produced a branch yet.</Body1>;
  } else if (summary.status === 'landed') {
    body = (
      <Body1 className={styles.notice}>
        This work has already merged — its branch is gone, so there is no diff to review here
        anymore.{' '}
        {summary.forgeUrl && (
          <a
            className={styles.link}
            href={summary.forgeUrl}
            target="_blank"
            rel="noreferrer noopener"
          >
            View the merge request
          </a>
        )}
      </Body1>
    );
  } else if (summary.status === 'conflicted') {
    body = (
      <Body1 className={styles.notice}>
        This worktree is mid-rebase or has conflicts, so its diff can&apos;t be shown yet:{' '}
        {summary.files.join(', ')}
      </Body1>
    );
  } else {
    const totals = summaryTotals(summary.summary);
    const diff = compact ? (
      <DiffView
        taskId={taskId}
        diffId={summary.summary.diffId}
        summary={summary.summary}
        files={state.files}
        expanded={state.expanded}
        selectedPath={state.selectedPath}
        comments={visibleComments(state)}
        editor={state.editor}
        canComment={canComment(state, readOnly)}
        touch
        wrap={wrap}
        monochrome={monochrome}
        selection={state.selection}
        onToggleExpanded={onToggleExpanded}
        onClickLine={onClickLine}
        onTapLine={onTapLine}
        onEditDraft={onEditDraft}
        onSave={onSave}
        onCancel={onCancel}
        onEdit={onEdit}
        onDelete={onDelete}
        onAccept={onAccept}
        onDismiss={onDismiss}
        onRestore={onRestore}
      />
    ) : (
      <div ref={diffContainerRef} className={styles.diffContainer}>
        <DiffView
          taskId={taskId}
          diffId={summary.summary.diffId}
          summary={summary.summary}
          files={state.files}
          expanded={state.expanded}
          selectedPath={state.selectedPath}
          comments={visibleComments(state)}
          editor={state.editor}
          canComment={canComment(state, readOnly)}
          layout={effectiveDiffLayout(preferredDiffLayout, diffWidthPx, compact)}
          monochrome={monochrome}
          onToggleExpanded={onToggleExpanded}
          onClickLine={onClickLine}
          onEditDraft={onEditDraft}
          onSave={onSave}
          onCancel={onCancel}
          onEdit={onEdit}
          onDelete={onDelete}
          onAccept={onAccept}
          onDismiss={onDismiss}
          onRestore={onRestore}
        />
      </div>
    );

    body = compact ? (
      <>
        <div className={styles.header}>
          <Caption1 className={styles.refs}>
            {summary.summary.baseRef} → {summary.summary.headSha.slice(0, 7)}
          </Caption1>
          <Caption1 className={styles.totals}>
            {totals.files} file{totals.files === 1 ? '' : 's'} ·{' '}
            <span className={styles.added}>+{totals.additions}</span>{' '}
            <span className={styles.deleted}>-{totals.deletions}</span>
          </Caption1>
          {summary.summary.includesWorkingTree && (
            <Caption1 className={styles.uncommitted}>Includes uncommitted changes</Caption1>
          )}
          <span className={styles.spacer} />
          <Button size="small" appearance="subtle" onClick={() => setFilesOpen(true)}>
            Files ({totals.files})
          </Button>
          <Switch label="Wrap" checked={wrap} onChange={(_e, d) => setWrap(d.checked)} />
          {state.loading ? (
            <Spinner size="extra-tiny" />
          ) : (
            <Button
              className={styles.reloadCompact}
              appearance="subtle"
              icon={<ArrowClockwiseRegular />}
              title="Re-read this card's changes"
              aria-label="Refresh the diff"
              onClick={onReload}
            />
          )}
        </div>
        <OverlayDrawer
          open={filesOpen}
          position="bottom"
          onOpenChange={(_e, d) => setFilesOpen(d.open)}
        >
          <DrawerHeader>
            <DrawerHeaderTitle>Files</DrawerHeaderTitle>
          </DrawerHeader>
          <DrawerBody>
            <FileTree
              nodes={buildFileTree(summary.summary.files)}
              selectedPath={state.selectedPath}
              onSelectFile={(path) => {
                onSelectFile(path);
                setFilesOpen(false);
              }}
            />
          </DrawerBody>
        </OverlayDrawer>
        <div className={styles.compactBody}>{diff}</div>
        <div className={styles.stickyFooter}>
          {state.selection !== null && (
            <div className={styles.footerRow}>
              <Caption1 className={styles.selectionCaption}>
                {selectionLabel(state.selection)}
              </Caption1>
              <span className={styles.spacer} />
              <Button
                className={styles.footerButton}
                size="large"
                appearance="subtle"
                onClick={onCancelSelection}
              >
                Cancel
              </Button>
              <Button
                className={styles.footerButton}
                size="large"
                appearance="primary"
                disabled={!canComment(state, readOnly)}
                onClick={onCommentSelection}
              >
                Comment
              </Button>
            </div>
          )}
          <div className={styles.footerRow}>
            <Button
              className={styles.footerButton}
              size="large"
              appearance="subtle"
              icon={<NoteEditRegular />}
              onClick={() => setNoteOpen(true)}
            >
              Note
            </Button>
            <Caption1 className={styles.unsent}>{unsentCount(state)} unsent</Caption1>
            {onToggleShowDismissed && (
              <DismissedToggle
                count={dismissedCount(state)}
                shown={state.showDismissed}
                onToggle={onToggleShowDismissed}
              />
            )}
            <span className={styles.spacer} />
            <Button
              className={styles.footerButton}
              size="large"
              appearance="primary"
              icon={state.sending ? <Spinner size="tiny" /> : <SendRegular />}
              disabled={!canSend(state, readOnly)}
              onClick={onSend}
            >
              {state.sending ? 'Sending…' : 'Send review'}
            </Button>
          </div>
        </div>
        <OverlayDrawer
          open={noteOpen}
          position="bottom"
          onOpenChange={(_e, d) => setNoteOpen(d.open)}
        >
          <DrawerHeader>
            <DrawerHeaderTitle>Overall note</DrawerHeaderTitle>
          </DrawerHeader>
          <DrawerBody>
            <div className={styles.sheetBody}>
              <Textarea
                value={state.note}
                placeholder="Add an overall note…  (optional)"
                resize="vertical"
                onChange={(_e, data) => onEditNote(data.value)}
              />
            </div>
          </DrawerBody>
        </OverlayDrawer>
      </>
    ) : (
      <>
        <div className={styles.header}>
          <Caption1 className={styles.refs}>
            {summary.summary.baseRef} → {summary.summary.headSha.slice(0, 7)}
          </Caption1>
          <Caption1 className={styles.totals}>
            {totals.files} file{totals.files === 1 ? '' : 's'} ·{' '}
            <span className={styles.added}>+{totals.additions}</span>{' '}
            <span className={styles.deleted}>-{totals.deletions}</span>
          </Caption1>
          {summary.summary.includesWorkingTree && (
            <Caption1 className={styles.uncommitted}>Includes uncommitted changes</Caption1>
          )}
          <div className={styles.layoutPill} role="group" aria-label="Diff layout">
            <Button
              size="small"
              appearance={preferredDiffLayout === 'unified' ? 'primary' : 'subtle'}
              onClick={() => setPreferredDiffLayout('unified')}
            >
              Unified
            </Button>
            <Button
              size="small"
              appearance={preferredDiffLayout === 'split' ? 'primary' : 'subtle'}
              onClick={() => setPreferredDiffLayout('split')}
            >
              Split
            </Button>
          </div>
          <span className={styles.spacer} />
          <Caption1 className={styles.unsent}>{unsentCount(state)} unsent</Caption1>
          {onToggleShowDismissed && (
            <DismissedToggle
              count={dismissedCount(state)}
              shown={state.showDismissed}
              onToggle={onToggleShowDismissed}
            />
          )}
          <Popover trapFocus positioning="below-end">
            <PopoverTrigger disableButtonEnhancement>
              <Button
                size="small"
                appearance="subtle"
                icon={<NoteEditRegular />}
                title="Add an overall note to send alongside the comments"
                aria-label="Edit the review's overall note"
              />
            </PopoverTrigger>
            <PopoverSurface>
              <div className={styles.note}>
                <Textarea
                  value={state.note}
                  placeholder="Add an overall note…  (optional)"
                  resize="vertical"
                  onChange={(_e, data) => onEditNote(data.value)}
                />
              </div>
            </PopoverSurface>
          </Popover>
          <Button
            size="small"
            appearance="primary"
            icon={state.sending ? <Spinner size="tiny" /> : <SendRegular />}
            disabled={!canSend(state, readOnly)}
            onClick={onSend}
          >
            {state.sending ? 'Sending…' : 'Send review'}
          </Button>
          {state.loading ? (
            <Spinner size="extra-tiny" />
          ) : (
            <Button
              size="small"
              appearance="subtle"
              icon={<ArrowClockwiseRegular />}
              title="Re-read this card's changes"
              aria-label="Refresh the diff"
              onClick={onReload}
            />
          )}
          {onOpenInWorkspace && (
            <Button
              size="small"
              appearance="subtle"
              icon={<WindowNewRegular />}
              data-open-review-workspace=""
              onClick={onOpenInWorkspace}
            >
              Open in review workspace
            </Button>
          )}
        </div>
        <div className={styles.body}>
          <FileTree
            nodes={buildFileTree(summary.summary.files)}
            selectedPath={state.selectedPath}
            onSelectFile={onSelectFile}
          />
          {diff}
        </div>
      </>
    );
  }

  return (
    <div className={styles.root}>
      {unreachable !== undefined && (
        <MessageBar intent="warning">
          <MessageBarBody>
            The desktop app is unreachable — showing what was last loaded. Comments and Send review
            are paused.
          </MessageBarBody>
        </MessageBar>
      )}
      {error && (
        <MessageBar intent="error">
          <MessageBarBody>{error}</MessageBarBody>
          <MessageBarActions>
            <Button size="small" onClick={onReload}>
              Retry
            </Button>
          </MessageBarActions>
        </MessageBar>
      )}
      {state.sendError !== null && (
        <MessageBar intent="warning">
          <MessageBarBody>{sendRefusalText(state.sendError as ReviewSendRefusal)}</MessageBarBody>
        </MessageBar>
      )}
      {state.staleDiffId !== null && (
        <MessageBar intent="warning">
          <MessageBarBody>The agent changed the files since you opened this.</MessageBarBody>
          <MessageBarActions>
            <Button size="small" appearance="primary" onClick={onReload}>
              Reload
            </Button>
          </MessageBarActions>
        </MessageBar>
      )}
      {body}
      {compact && state.editor !== null && (
        <OverlayDrawer open position="bottom" onOpenChange={(_e, d) => !d.open && onCancel()}>
          <DrawerHeader>
            <DrawerHeaderTitle>{selectionLabel(state.editor)}</DrawerHeaderTitle>
          </DrawerHeader>
          <DrawerBody>
            <div className={styles.sheetBody}>
              <CommentExcerpt files={state.files} editor={state.editor} />
              <CommentEditorCard
                editor={state.editor}
                onEditDraft={onEditDraft}
                onSave={onSave}
                onCancel={onCancel}
              />
            </div>
          </DrawerBody>
        </OverlayDrawer>
      )}
    </div>
  );
}

/** The comment sheet's own read-only excerpt of the lines `editor` is anchored to — the
 * editor itself opens with no diff context on screen behind it, unlike the wide pane's
 * inline one. */
function CommentExcerpt({
  files,
  editor,
}: {
  files: Readonly<Record<string, FileLoad>>;
  editor: CommentEditor;
}): JSX.Element | null {
  const styles = useStyles();
  const lines = excerptLines(files, editor.path, editor);
  if (lines.length === 0) return null;
  return (
    <div className={styles.excerpt}>
      {lines.map((line, i) => (
        <div
          key={i}
          className={mergeClasses(
            styles.excerptLine,
            line.kind === 'add' && styles.excerptAdd,
            line.kind === 'del' && styles.excerptDel,
          )}
        >
          {line.text || ' '}
        </div>
      ))}
    </div>
  );
}
