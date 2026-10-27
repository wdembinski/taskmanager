/**
 * Static-markup coverage for the Changes pane's **Open in review workspace** button
 * (F15.14b): drawn in the wide toolbar only when the host passed `onOpenInWorkspace` (its
 * `ReviewWorkspaceOpener`), and never in the compact pane — the phone keeps its own Changes
 * tab. The loaded state is seeded through `reviewState.ts`'s real transitions, so the toolbar
 * rendered here is the one a real summary would draw.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { DiffFileEntry, DiffSummary } from '@tm/shared/review';
import { EMPTY_REVIEW, summaryArrived, summaryLoadStarted, type ReviewState } from './reviewState';
import { ReviewPaneView, type ReviewPaneViewProps } from './ReviewPaneView';

function entry(path: string): DiffFileEntry {
  return {
    path,
    status: 'modified',
    additions: 1,
    deletions: 0,
    binary: false,
    image: false,
    bytes: 10,
  };
}

const summary: DiffSummary = {
  diffId: 'd1',
  baseRef: 'development',
  baseSha: 'base000',
  headSha: 'head000',
  includesWorkingTree: false,
  files: [entry('src/a.ts'), entry('src/b.ts')],
  truncated: false,
};

const loaded: ReviewState = summaryArrived(summaryLoadStarted(EMPTY_REVIEW, 't1', 1), 't1', 1, {
  status: 'ok',
  summary,
});

function render(over: Partial<ReviewPaneViewProps> = {}): string {
  const noop = (): void => {};
  return renderToStaticMarkup(
    <ReviewPaneView
      taskId="t1"
      state={loaded}
      error={null}
      onReload={noop}
      onSelectFile={noop}
      onToggleExpanded={noop}
      onClickLine={noop}
      onTapLine={noop}
      onCancelSelection={noop}
      onCommentSelection={noop}
      onEditDraft={noop}
      onSave={noop}
      onCancel={noop}
      onEdit={noop}
      onDelete={noop}
      onEditNote={noop}
      onSend={noop}
      {...over}
    />,
  );
}

describe('ReviewPaneView: Open in review workspace', () => {
  it('draws the button in the toolbar when the host provides an opener', () => {
    const html = render({ onOpenInWorkspace: () => {} });
    expect(html).toContain('data-open-review-workspace');
    expect(html).toContain('aria-label="Open in review workspace"');
  });

  it('draws no button without an opener', () => {
    const html = render();
    // The toolbar itself is there — only the button is missing.
    expect(html).toContain('aria-label="Refresh the diff"');
    expect(html).not.toContain('data-open-review-workspace');
  });

  it('draws no button in the compact pane, even with an opener', () => {
    const html = render({ layout: 'compact', onOpenInWorkspace: () => {} });
    expect(html).toContain('aria-label="Refresh the diff"');
    expect(html).not.toContain('data-open-review-workspace');
  });
});
