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
 */
import type { JSX } from 'react';
import {
  Body1,
  Button,
  Caption1,
  MessageBar,
  MessageBarActions,
  MessageBarBody,
  Spinner,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { ArrowClockwiseRegular } from '@fluentui/react-icons';
import { MONO } from '../theme';
import { DiffView } from './DiffView';
import { FileTree } from './FileTree';
import type { ReviewState } from './reviewState';
import { buildFileTree, summaryTotals } from './reviewView';

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
});

export interface ReviewPaneViewProps {
  taskId: string;
  state: ReviewState;
  /** A failed `task:diffSummary`/`task:diffFile` call — not part of `ReviewState` itself. */
  error: string | null;
  onReload: () => void;
  onSelectFile: (path: string) => void;
  onToggleExpanded: (path: string) => void;
}

export function ReviewPaneView({
  taskId,
  state,
  error,
  onReload,
  onSelectFile,
  onToggleExpanded,
}: ReviewPaneViewProps): JSX.Element {
  const styles = useStyles();
  const { summary } = state;

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
    body = (
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
        </div>
        <div className={styles.body}>
          <FileTree
            nodes={buildFileTree(summary.summary.files)}
            selectedPath={state.selectedPath}
            onSelectFile={onSelectFile}
          />
          <DiffView
            taskId={taskId}
            diffId={summary.summary.diffId}
            summary={summary.summary}
            files={state.files}
            expanded={state.expanded}
            selectedPath={state.selectedPath}
            onToggleExpanded={onToggleExpanded}
          />
        </div>
      </>
    );
  }

  return (
    <div className={styles.root}>
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
    </div>
  );
}
