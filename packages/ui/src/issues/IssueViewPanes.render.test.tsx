/**
 * Proves the two panes draw what F13.13's design calls for: the full page's breadcrumb row
 * joins its segments in order, and the peek's header carries both icon buttons with their own
 * labels. `renderToStaticMarkup` rather than a DOM testing library — this package has none —
 * the same approach `TaskDetailHostView.render.test.tsx` uses.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { IssueFullPage, IssuePeek } from './IssueViewPanes';

describe('IssueFullPage', () => {
  it('renders the breadcrumb segments in order', () => {
    const html = renderToStaticMarkup(
      <IssueFullPage
        breadcrumb={['Task Manager', 'M4 Reach', 'F4 Linear integration']}
        onBack={() => {}}
      >
        <div>detail</div>
      </IssueFullPage>,
    );

    const manager = html.indexOf('Task Manager');
    const milestone = html.indexOf('M4 Reach');
    const epic = html.indexOf('F4 Linear integration');

    expect(manager).toBeGreaterThanOrEqual(0);
    expect(milestone).toBeGreaterThan(manager);
    expect(epic).toBeGreaterThan(milestone);
  });

  it('renders the Back to list button and the children', () => {
    const html = renderToStaticMarkup(
      <IssueFullPage breadcrumb={['Task Manager']} onBack={() => {}}>
        <div>detail pane</div>
      </IssueFullPage>,
    );

    expect(html).toContain('Back to list');
    expect(html).toContain('detail pane');
  });
});

describe('IssuePeek', () => {
  it('renders both header buttons with their labels', () => {
    const html = renderToStaticMarkup(
      <IssuePeek onExpand={() => {}} onClose={() => {}}>
        <div>detail</div>
      </IssuePeek>,
    );

    expect(html).toContain('aria-label="Open full screen"');
    expect(html).toContain('title="Open full screen (Enter)"');
    expect(html).toContain('aria-label="Close"');
    expect(html).toContain('title="Close (Esc)"');
  });

  it('renders the children', () => {
    const html = renderToStaticMarkup(
      <IssuePeek onExpand={() => {}} onClose={() => {}}>
        <div>peek detail</div>
      </IssuePeek>,
    );

    expect(html).toContain('peek detail');
  });
});
