/**
 * The review workspace's pure rendering half (F15.14): the queues snapshot, the selected row
 * and a `ReviewState` in, Fluent JSX out — no `useTransport`, no effects beyond measuring the
 * diff column, the same split `ReviewPaneView` makes for the Changes pane. `ReviewWorkspace`
 * owns the loading; a headless test seeds a `ReviewState` through `reviewState.ts`'s own
 * transitions and renders exactly what a human would see.
 *
 * Layout (the v9-6 mockup): ONE pane — a single `GlassPane` (`data-panel="review"`, the only
 * thing allowed to paint glass) holding a `280px 248px 1fr` × `auto 1fr` grid. The queues span
 * both rows on the left; the two-line header spans the files and the diff; 1px hairlines
 * separate the cells, with no inner radii or gaps. The diff cell is a code surface and stays
 * fully opaque, because translucent text backgrounds hurt reading.
 *
 * The header's first line is the ref, the title, then Unified|Split, the AI slot, the drafts
 * and the actions; its second is `head → base · N files · +a −d · ● pipeline · GitLab`, then the
 * source badge.
 *
 * `data-state` reads `loading` while the queues or the selected subject's summary are still on
 * their way, `empty` with nothing selected, and `loaded` once there is a summary to draw.
 *
 * The header's actions follow the subject's kind: a card (`subject.kind === 'task'`) gets *Send
 * to agent* (the F6 path); a PR gets *Copy review as Markdown* and *Open on forge* — never both.
 * Commenting needs a `taskId` (comments are still task-keyed), so a PR row without one is read
 * only. `data-slot="ai-review"` is the empty slot F16's *Ask AI to review* fills.
 *
 * `unreachable` (the web, with its desktop gone) draws a warning bar above the panel and makes
 * the screen read only — no commenting, no *Send to agent* — exactly as `ReviewPaneView` does.
 * `asOfNotice` is the queue column's muted "Queues as of 14:02" caption (`queuesAsOfNotice`).
 *
 * Colour budget (memory *board-colour-budget*): the source badge, counts and refs are static
 * facts, so the chrome stays on neutral tokens; the only colour is the diff's own +/− and the
 * pipeline dot, because a pipeline moves.
 */
import type { JSX } from 'react';
import {
  Badge,
  Body1,
  Button,
  Caption1,
  MessageBar,
  MessageBarActions,
  MessageBarBody,
  Spinner,
  Subtitle2,
  ToggleButton,
  Tooltip,
  makeStyles,
  mergeClasses,
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
import { PIPELINE_WORD } from '../issues/IssueBuilt';
import { GlassPane } from '../shell/GlassPane';
import { MONO } from '../theme';
import { PIPELINE_VAR } from '../tokens';
import { DiffView } from './DiffView';
import { FileTree } from './FileTree';
import { ReviewKeysDialog } from './ReviewKeysDialog';
import { ReviewQueueList } from './ReviewQueueList';
import { useWidePaneWidth } from './ReviewPaneView';
import { canComment, canSend, unsentCount, viewedStatuses, type ReviewState } from './reviewState';
import {
  effectiveDiffLayout,
  summaryTotals,
  WORKSPACE_SPLIT_MIN_WIDTH_PX,
  type DiffLayout,
} from './reviewView';
import {
  branchLine,
  buildDirGroups,
  knownPipeline,
  providerName,
  sourceBadge,
  subjectLabel,
  viewedLabel,
} from './reviewWorkspaceModel';

const HAIRLINE = `1px solid ${tokens.colorNeutralStroke2}`;

const useStyles = makeStyles({
  // The margin the window keeps around the one panel.
  frame: {
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
    height: '100%',
    minHeight: 0,
    padding: '10px',
    boxSizing: 'border-box',
  },
  panel: {
    flex: 1,
    display: 'grid',
    gridTemplateColumns: '280px 248px 1fr',
    gridTemplateRows: 'auto 1fr',
    height: '100%',
    minHeight: 0,
    // Clips the opaque diff cell to the pane's own rounded corner.
    overflow: 'hidden',
  },
  queues: { gridColumn: '1', gridRow: '1 / span 2', borderRight: HAIRLINE },
  // The header and any error bar share the grid's first row, so an error never adds a row.
  top: {
    gridColumn: '2 / span 2',
    gridRow: '1',
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
    padding: '10px 14px',
    borderBottom: HAIRLINE,
    minWidth: 0,
  },
  header: { display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0 },
  line: { display: 'flex', alignItems: 'center', gap: '10px', minWidth: 0, minHeight: '32px' },
  meta: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    minWidth: 0,
    whiteSpace: 'nowrap',
    color: tokens.colorNeutralForeground3,
  },
  title: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 },
  ref: { flexShrink: 0, fontFamily: MONO, color: tokens.colorNeutralForeground3 },
  mono: { fontFamily: MONO, color: tokens.colorNeutralForeground2 },
  faint: { color: tokens.colorNeutralForeground3 },
  added: { color: tokens.colorPaletteGreenForeground1 },
  deleted: { color: tokens.colorPaletteRedForeground1 },
  dot: { width: '6px', height: '6px', borderRadius: '50%', flexShrink: 0 },
  spacer: { flex: 1 },
  layoutPill: { display: 'flex', gap: '2px', flexShrink: 0 },
  aiSlot: { display: 'contents' },
  column: {
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
    padding: '10px',
    minHeight: 0,
    minWidth: 0,
    overflowY: 'auto',
  },
  files: { gridColumn: '2', gridRow: '2', borderRight: HAIRLINE },
  columnHeader: { display: 'flex', alignItems: 'center', gap: '6px' },
  // The code surface: opaque, never glass.
  diff: {
    gridColumn: '3',
    gridRow: '2',
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
    minWidth: 0,
    minHeight: 0,
    overflow: 'auto',
    padding: '10px',
    backgroundColor: tokens.colorNeutralBackground1,
  },
  notice: { color: tokens.colorNeutralForeground3 },
  queuesTitle: { display: 'flex', flexDirection: 'column', minWidth: 0 },
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
  /** The viewer's preferred layout; narrower than `WORKSPACE_SPLIT_MIN_WIDTH_PX` draws unified. */
  layout: DiffLayout;
  monochrome: boolean;
  collapsedGroups: readonly ReviewQueue[];
  /** Whether *Copy review as Markdown* has anything to copy (a PR subject only). */
  copyEnabled: boolean;
  /** Where *Open on forge* goes; `null` disables it (a GitLab row carries no host). */
  forgeUrl: string | null;
  /** The `?` key list. */
  keysOpen: boolean;
  /** Set when the desktop host cannot be reached: a warning bar, and the screen reads only. */
  unreachable?: string;
  /** The queue column's "Queues as of …" caption; nothing drawn when absent or `null`. */
  asOfNotice?: string | null;
  /** The diff column's width until it is first measured — a host that already knows it is on a
   *  phone opens unified with no split frame first. The measured width wins once known. */
  initialWidthPx?: number;
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
    unreachable,
    asOfNotice,
    onSelectSubject,
    onToggleGroup,
    onRefresh,
    onReload,
    onCloseKeys,
  } = props;
  const styles = useStyles();
  const status = workspaceState(queues, selected, state);

  return (
    <div className={styles.frame} data-review-workspace data-state={status}>
      {unreachable !== undefined && (
        <MessageBar intent="warning" data-unreachable>
          <MessageBarBody>
            The desktop app is unreachable — showing what was last loaded. Comments and Send to
            agent are paused.
          </MessageBarBody>
        </MessageBar>
      )}
      <GlassPane className={styles.panel} data-panel="review">
        <div className={mergeClasses(styles.column, styles.queues)} data-column="queues">
          <div className={styles.columnHeader}>
            <div className={styles.queuesTitle}>
              <Subtitle2>Queues</Subtitle2>
              {asOfNotice && (
                <Caption1 className={styles.faint} data-queues-as-of>
                  {asOfNotice}
                </Caption1>
              )}
            </div>
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
        </div>

        <div className={styles.top} data-region="header">
          {selected ? (
            <SubjectHeader {...props} selected={selected} />
          ) : (
            <div className={styles.line}>
              <Subtitle2>Reviews</Subtitle2>
            </div>
          )}
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

        <div className={mergeClasses(styles.column, styles.files)} data-column="files">
          <FilesColumn {...props} />
        </div>

        <DiffColumn {...props} status={status} />
      </GlassPane>

      <ReviewKeysDialog open={keysOpen} onClose={onCloseKeys} />
    </div>
  );
}

function SubjectHeader(
  props: ReviewWorkspaceViewProps & { selected: ReviewQueueItem },
): JSX.Element {
  const { selected, state } = props;
  const styles = useStyles();
  const summary = state.summary?.status === 'ok' ? state.summary.summary : null;
  const badge = summary ? sourceBadge(summary) : null;
  const isTask = selected.subject.kind === 'task';
  const drafts = selected.taskId !== null ? unsentCount(state) : selected.draftCount;
  const ref = subjectLabel(selected);
  const totals = summary ? summaryTotals(summary) : null;
  const pipeline = knownPipeline(selected);
  const provider = providerName(selected);

  return (
    <div className={styles.header}>
      <div className={styles.line}>
        {ref !== '' && (
          <Caption1 className={styles.ref} title={selected.repoPath} data-subject-ref>
            {ref}
          </Caption1>
        )}
        <Subtitle2 className={styles.title} title={selected.title}>
          {selected.title}
        </Subtitle2>
        <span className={styles.spacer} />
        <HeaderActions {...props} selected={selected} drafts={drafts} isTask={isTask} />
      </div>
      {summary && totals && (
        <Caption1 className={styles.meta} data-header-meta>
          <span className={styles.mono} data-branch-line>
            {branchLine(selected, summary)}
          </span>
          <span>
            · {totals.files} file{totals.files === 1 ? '' : 's'} ·{' '}
            <span className={styles.added}>+{totals.additions}</span>{' '}
            <span className={styles.deleted}>−{totals.deletions}</span>
          </span>
          {pipeline && (
            <>
              <span>·</span>
              <span
                className={styles.dot}
                style={{ backgroundColor: PIPELINE_VAR[pipeline] }}
                aria-hidden
              />
              <span data-pipeline={pipeline}>pipeline {PIPELINE_WORD[pipeline]}</span>
            </>
          )}
          {provider && <span>· {provider}</span>}
          {badge && (
            <Badge
              appearance="outline"
              color="informative"
              size="small"
              data-source-badge
              title={badge.title}
            >
              {badge.text}
            </Badge>
          )}
        </Caption1>
      )}
    </div>
  );
}

function HeaderActions({
  state,
  unreachable,
  layout,
  copyEnabled,
  forgeUrl,
  onLayoutChange,
  onSend,
  onCopyMarkdown,
  drafts,
  isTask,
}: ReviewWorkspaceViewProps & { drafts: number; isTask: boolean }): JSX.Element {
  const styles = useStyles();
  return (
    <>
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
          disabled={!canSend(state, unreachable !== undefined)}
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
          nodes={buildDirGroups(summary.files)}
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
  unreachable,
  initialWidthPx,
  onReload,
  onToggleExpanded,
  onToggleViewed,
  onClickLine,
  onEditDraft,
  onSave,
  onCancel,
  onEdit,
  onDelete,
  status,
}: ReviewWorkspaceViewProps & { status: ReviewWorkspaceState }): JSX.Element {
  const styles = useStyles();
  const { containerRef, widthPx: measuredPx } = useWidePaneWidth();
  const result = state.summary;
  const drawn = effectiveDiffLayout(
    layout,
    measuredPx ?? initialWidthPx ?? null,
    false,
    WORKSPACE_SPLIT_MIN_WIDTH_PX,
  );

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
    const { byPath } = viewedStatuses(state);
    // The file count and +/− live on the header's second line; this row only refreshes.
    body = (
      <>
        <div className={styles.columnHeader}>
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
          canComment={selected.taskId !== null && canComment(state, unreachable !== undefined)}
          layout={drawn}
          monochrome={monochrome}
          viewed={byPath}
          onToggleViewed={onToggleViewed}
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
    <div ref={containerRef} className={styles.diff} data-column="diff" data-diff-layout={drawn}>
      {body}
    </div>
  );
}
