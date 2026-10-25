/**
 * The review workspace's pure rendering half (F15.14): the queues snapshot, the selected row
 * and a `ReviewState` in, Fluent JSX out — no `useTransport`, no effects beyond measuring the
 * diff column, the same split `ReviewPaneView` makes for the Changes pane. `ReviewWorkspace`
 * owns the loading; a headless test seeds a `ReviewState` through `reviewState.ts`'s own
 * transitions and renders exactly what a human would see.
 *
 * Layout (the v9-6 mockup): a header across the top, then three columns — the queues (≈280px),
 * the file tree with its viewed boxes (≈248px) and the diff (`1fr`). The two narrow columns are
 * panes, so they paint through `GlassPane` (the only thing allowed to paint glass); the diff is
 * a code surface and stays fully opaque, because translucent text backgrounds hurt reading.
 *
 * `data-state` reads `loading` while the queues or the selected subject's summary are still on
 * their way, `empty` with nothing selected, and `loaded` once there is a summary to draw.
 *
 * The header's actions follow the subject's kind: a card (`subject.kind === 'task'`) gets *Send
 * to agent* (the F6 path); a PR gets *Copy review as Markdown* and *Open on forge* — never both.
 * Commenting needs a `taskId` (comments are still task-keyed), so a PR row without one is read
 * only. `data-slot="ai-review"` is the empty slot F16's *Ask AI to review* fills.
 *
 * Colour budget (memory *board-colour-budget*): the source badge, counts and refs are static
 * facts, so the chrome stays on neutral tokens; the only colour is the diff's own +/−.
 */
import type { JSX } from 'react';
import {
  Badge,
  Body1,
  Button,
  Caption1,
  Dialog,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  MessageBar,
  MessageBarActions,
  MessageBarBody,
  Spinner,
  Subtitle2,
  ToggleButton,
  Tooltip,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import {
  ArrowClockwiseRegular,
  CopyRegular,
  OpenRegular,
  SendRegular,
} from '@fluentui/react-icons';
import type {
  DiffSide,
  ReviewComment,
  ReviewQueue,
  ReviewQueueItem,
  ReviewQueuesSnapshot,
} from '@tm/shared/review';
import { KeyboardShortcutsList } from '../palette/KeyboardShortcutsList';
import { GlassPane } from '../shell/GlassPane';
import { MONO } from '../theme';
import { DiffView } from './DiffView';
import { FileTree } from './FileTree';
import { ReviewQueueList } from './ReviewQueueList';
import { useWidePaneWidth } from './ReviewPaneView';
import { REVIEW_KEYS } from './reviewKeys';
import { canComment, canSend, unsentCount, viewedStatuses, type ReviewState } from './reviewState';
import { buildFileTree, effectiveDiffLayout, summaryTotals, type DiffLayout } from './reviewView';
import { sourceBadge, subjectLabel, viewedLabel } from './reviewWorkspaceModel';

const useStyles = makeStyles({
  root: {
    display: 'grid',
    gridTemplateColumns: '280px 248px 1fr',
    gridTemplateRows: 'auto 1fr',
    gap: '10px',
    height: '100%',
    minHeight: 0,
    padding: '10px',
    boxSizing: 'border-box',
  },
  // The header and any error bar share the grid's first row, so an error never adds a row.
  top: { gridColumn: '1 / -1', display: 'flex', flexDirection: 'column', gap: '8px' },
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
    flexWrap: 'wrap',
    minHeight: '32px',
  },
  title: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 },
  mono: { fontFamily: MONO, color: tokens.colorNeutralForeground2 },
  faint: { color: tokens.colorNeutralForeground3 },
  added: { color: tokens.colorPaletteGreenForeground1 },
  deleted: { color: tokens.colorPaletteRedForeground1 },
  spacer: { flex: 1 },
  layoutPill: { display: 'flex', gap: '2px' },
  aiSlot: { display: 'contents' },
  column: {
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
    padding: '10px',
    minHeight: 0,
    overflowY: 'auto',
  },
  columnHeader: { display: 'flex', alignItems: 'center', gap: '6px' },
  // The code surface: opaque, never glass.
  diff: {
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
    minWidth: 0,
    minHeight: 0,
    overflow: 'auto',
    padding: '10px',
    borderRadius: '12px',
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  notice: { color: tokens.colorNeutralForeground3 },
});

/** What `data-state` reads; see the module header. */
export type ReviewWorkspaceState = 'empty' | 'loading' | 'loaded';

export interface ReviewWorkspaceViewProps {
  /** `null` until the first `review:queues` answer. */
  queues: ReviewQueuesSnapshot | null;
  selected: ReviewQueueItem | null;
  /** Keyed on the subject: `state.taskId` holds the selected row's `subjectId`. */
  state: ReviewState;
  /** A failed summary/file/queue call — not part of `ReviewState` itself. */
  error: string | null;
  /** The viewer's preferred layout; narrower than `SPLIT_MIN_WIDTH_PX` still draws unified. */
  layout: DiffLayout;
  monochrome: boolean;
  collapsedGroups: readonly ReviewQueue[];
  /** Whether *Copy review as Markdown* has anything to copy (a PR subject only). */
  copyEnabled: boolean;
  /** Where *Open on forge* goes; `null` disables it (a GitLab row carries no host). */
  forgeUrl: string | null;
  /** The `?` key list. */
  keysOpen: boolean;
  onSelectSubject: (item: ReviewQueueItem) => void;
  onToggleGroup: (queue: ReviewQueue) => void;
  /** Re-reads the queues from the forge. */
  onRefresh: () => void;
  /** Re-reads the selected subject's diff. */
  onReload: () => void;
  onSelectFile: (path: string) => void;
  onToggleExpanded: (path: string) => void;
  onToggleViewed: (path: string) => void;
  onLayoutChange: (layout: DiffLayout) => void;
  onSend: () => void;
  onCopyMarkdown: () => void;
  onCloseKeys: () => void;
  onClickLine: (path: string, side: DiffSide, line: number, shift: boolean) => void;
  onEditDraft: (text: string) => void;
  onSave: () => void;
  onCancel: () => void;
  onEdit: (comment: ReviewComment) => void;
  onDelete: (id: string) => void;
}

/** See the module header for what each state means. */
export function workspaceState(
  queues: ReviewQueuesSnapshot | null,
  selected: ReviewQueueItem | null,
  state: ReviewState,
): ReviewWorkspaceState {
  if (queues === null) return 'loading';
  if (selected === null) return 'empty';
  return state.summary === null ? 'loading' : 'loaded';
}

export function ReviewWorkspaceView(props: ReviewWorkspaceViewProps): JSX.Element {
  const {
    queues,
    selected,
    state,
    error,
    collapsedGroups,
    keysOpen,
    onSelectSubject,
    onToggleGroup,
    onRefresh,
    onReload,
    onCloseKeys,
  } = props;
  const styles = useStyles();
  const status = workspaceState(queues, selected, state);

  return (
    <div className={styles.root} data-review-workspace data-state={status}>
      <div className={styles.top}>
        <div className={styles.header}>
          {selected ? (
            <SubjectHeader {...props} selected={selected} />
          ) : (
            <Subtitle2>Reviews</Subtitle2>
          )}
        </div>
        {error && (
          <MessageBar intent="error">
            <MessageBarBody>{error}</MessageBarBody>
            <MessageBarActions>
              <Button size="small" onClick={selected ? onReload : onRefresh}>
                Retry
              </Button>
            </MessageBarActions>
          </MessageBar>
        )}
      </div>

      <GlassPane className={styles.column} data-column="queues">
        <div className={styles.columnHeader}>
          <Subtitle2>Queues</Subtitle2>
          <span className={styles.spacer} />
          <Button
            size="small"
            appearance="subtle"
            icon={<ArrowClockwiseRegular />}
            aria-label="Refresh the queues"
            title="Re-read the queues from the forge"
            onClick={onRefresh}
          />
        </div>
        {queues === null ? (
          <Spinner size="tiny" label="Loading reviews…" labelPosition="after" />
        ) : (
          <ReviewQueueList
            snapshot={queues}
            selectedSubjectId={selected?.subjectId ?? null}
            collapsed={collapsedGroups}
            onToggleGroup={onToggleGroup}
            onSelect={onSelectSubject}
          />
        )}
      </GlassPane>

      <GlassPane className={styles.column} data-column="files">
        <FilesColumn {...props} />
      </GlassPane>

      <DiffColumn {...props} status={status} />

      <Dialog open={keysOpen} onOpenChange={(_e, data) => !data.open && onCloseKeys()}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>Keyboard shortcuts</DialogTitle>
            <DialogContent>
              <KeyboardShortcutsList items={REVIEW_KEYS} />
            </DialogContent>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </div>
  );
}

function SubjectHeader({
  selected,
  state,
  layout,
  copyEnabled,
  forgeUrl,
  onLayoutChange,
  onSend,
  onCopyMarkdown,
}: ReviewWorkspaceViewProps & { selected: ReviewQueueItem }): JSX.Element {
  const styles = useStyles();
  const summary = state.summary?.status === 'ok' ? state.summary.summary : null;
  const badge = summary ? sourceBadge(summary) : null;
  const isTask = selected.subject.kind === 'task';
  const drafts = selected.taskId !== null ? unsentCount(state) : selected.draftCount;

  return (
    <>
      <Caption1 className={styles.mono}>{subjectLabel(selected)}</Caption1>
      <Subtitle2 className={styles.title} title={selected.title}>
        {selected.title}
      </Subtitle2>
      {summary && (
        <Caption1 className={styles.mono}>
          {summary.baseRef} ← {summary.headSha.slice(0, 7)}
        </Caption1>
      )}
      {badge && (
        <Badge appearance="outline" color="informative" data-source-badge title={badge.title}>
          {badge.text}
        </Badge>
      )}
      <span className={styles.spacer} />
      <div className={styles.layoutPill} role="group" aria-label="Diff layout">
        <ToggleButton
          size="small"
          appearance="subtle"
          checked={layout === 'unified'}
          onClick={() => onLayoutChange('unified')}
        >
          Unified
        </ToggleButton>
        <ToggleButton
          size="small"
          appearance="subtle"
          checked={layout === 'split'}
          onClick={() => onLayoutChange('split')}
        >
          Split
        </ToggleButton>
      </div>
      <span className={styles.aiSlot} data-slot="ai-review" />
      <Caption1 className={styles.faint} data-drafts={drafts}>
        {drafts} draft{drafts === 1 ? '' : 's'}
      </Caption1>
      {isTask ? (
        <Button
          size="small"
          appearance="primary"
          icon={state.sending ? <Spinner size="tiny" /> : <SendRegular />}
          disabled={!canSend(state)}
          onClick={onSend}
        >
          {state.sending ? 'Sending…' : 'Send to agent'}
        </Button>
      ) : (
        <>
          <Button
            size="small"
            appearance="primary"
            icon={<CopyRegular />}
            disabled={!copyEnabled}
            onClick={onCopyMarkdown}
          >
            Copy review as Markdown
          </Button>
          <Tooltip
            content={forgeUrl ?? 'This forge’s host is not known here'}
            relationship="description"
          >
            {forgeUrl ? (
              <Button
                size="small"
                appearance="subtle"
                icon={<OpenRegular />}
                as="a"
                href={forgeUrl}
                target="_blank"
                rel="noreferrer noopener"
              >
                Open on forge
              </Button>
            ) : (
              <Button size="small" appearance="subtle" icon={<OpenRegular />} disabledFocusable>
                Open on forge
              </Button>
            )}
          </Tooltip>
        </>
      )}
    </>
  );
}

function FilesColumn({
  state,
  onSelectFile,
  onToggleViewed,
}: ReviewWorkspaceViewProps): JSX.Element {
  const styles = useStyles();
  const summary = state.summary?.status === 'ok' ? state.summary.summary : null;
  const { byPath, viewedCount } = viewedStatuses(state);

  return (
    <>
      <div className={styles.columnHeader}>
        <Subtitle2>Files</Subtitle2>
        <span className={styles.spacer} />
        {summary && (
          <Caption1 className={styles.faint} data-viewed-count={viewedCount}>
            {viewedLabel(viewedCount, summary.files.length)}
          </Caption1>
        )}
      </div>
      {summary && (
        <FileTree
          nodes={buildFileTree(summary.files)}
          selectedPath={state.selectedPath}
          onSelectFile={onSelectFile}
          viewed={byPath}
          onToggleViewed={onToggleViewed}
        />
      )}
    </>
  );
}

function DiffColumn({
  selected,
  state,
  layout,
  monochrome,
  onReload,
  onToggleExpanded,
  onClickLine,
  onEditDraft,
  onSave,
  onCancel,
  onEdit,
  onDelete,
  status,
}: ReviewWorkspaceViewProps & { status: ReviewWorkspaceState }): JSX.Element {
  const styles = useStyles();
  const { containerRef, widthPx } = useWidePaneWidth();
  const result = state.summary;

  let body: JSX.Element | null;
  if (selected === null) {
    body =
      status === 'loading' ? null : (
        <Body1 className={styles.notice}>Pick a pull request or a card to review.</Body1>
      );
  } else if (result === null) {
    body = <Spinner size="tiny" label="Loading changes…" labelPosition="after" />;
  } else if (result.status === 'no-branch') {
    body = <Body1 className={styles.notice}>This card hasn&apos;t produced a branch yet.</Body1>;
  } else if (result.status === 'landed') {
    body = (
      <Body1 className={styles.notice}>
        This work has already merged — there is no diff left to review.
      </Body1>
    );
  } else if (result.status === 'conflicted') {
    body = (
      <Body1 className={styles.notice}>
        This worktree is mid-rebase or has conflicts: {result.files.join(', ')}
      </Body1>
    );
  } else {
    const { summary } = result;
    const totals = summaryTotals(summary);
    body = (
      <>
        <div className={styles.columnHeader}>
          <Caption1 className={styles.faint}>
            {totals.files} file{totals.files === 1 ? '' : 's'} ·{' '}
            <span className={styles.added}>+{totals.additions}</span>{' '}
            <span className={styles.deleted}>−{totals.deletions}</span>
          </Caption1>
          <span className={styles.spacer} />
          {state.loading ? (
            <Spinner size="extra-tiny" />
          ) : (
            <Button
              size="small"
              appearance="subtle"
              icon={<ArrowClockwiseRegular />}
              aria-label="Refresh the diff"
              title="Re-read this subject's changes"
              onClick={onReload}
            />
          )}
        </div>
        {state.staleDiffId !== null && (
          <MessageBar intent="warning">
            <MessageBarBody>The changes moved on since you opened this.</MessageBarBody>
            <MessageBarActions>
              <Button size="small" appearance="primary" onClick={onReload}>
                Reload
              </Button>
            </MessageBarActions>
          </MessageBar>
        )}
        <DiffView
          taskId={selected.taskId ?? selected.subjectId}
          diffId={summary.diffId}
          summary={summary}
          files={state.files}
          expanded={state.expanded}
          selectedPath={state.selectedPath}
          comments={selected.taskId !== null ? state.comments : []}
          editor={state.editor}
          canComment={selected.taskId !== null && canComment(state)}
          layout={effectiveDiffLayout(layout, widthPx, false)}
          monochrome={monochrome}
          onToggleExpanded={onToggleExpanded}
          onClickLine={onClickLine}
          onEditDraft={onEditDraft}
          onSave={onSave}
          onCancel={onCancel}
          onEdit={onEdit}
          onDelete={onDelete}
        />
      </>
    );
  }

  return (
    <div ref={containerRef} className={styles.diff} data-column="diff">
      {body}
    </div>
  );
}
