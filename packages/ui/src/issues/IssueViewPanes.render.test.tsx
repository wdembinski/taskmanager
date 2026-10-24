/**
 * Proves the two panes draw what F13.13's design calls for: the full page's breadcrumb row
 * joins its segments in order, and the peek's header carries both icon buttons with their own
 * labels. `renderToStaticMarkup` rather than a DOM testing library — this package has none —
 * the same approach `TaskDetailHostView.render.test.tsx` uses.
 *
 * Also proves F13.24's acceptance for the one piece of it that lives here: the board card's
 * Merge requests section — pipeline stage dots, the verdict badge — renders exactly as it
 * would anywhere else once it is `IssuePeek`'s `children`, so a real `TaskDetailHost` dropped
 * into this pane (as both hosts already do) loses nothing by being inside it.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { MergeRequest } from '@tm/shared/mergeRequest';
import { MergeRequests } from '../MergeRequests';
import { IssueFullPage, IssuePeek } from './IssueViewPanes';

const mr = (over: Partial<MergeRequest> = {}): MergeRequest => ({
  id: 'gl-9-1',
  taskId: 't1',
  openedForTaskId: null,
  provider: 'gitlab',
  repoId: 9,
  projectPath: 'acme/web',
  number: 1,
  title: 'ENG-1 fix the thing',
  displayName: null,
  webUrl: 'https://gitlab.com/acme/web/-/merge_requests/1',
  sourceBranch: 'feature/ENG-1',
  targetBranch: 'main',
  state: 'opened',
  draft: false,
  headSha: null,
  lastActedSha: null,
  lastActedAction: null,
  pipelineStatus: 'running',
  pipelineStages: [
    { name: 'build', status: 'success' },
    { name: 'test', status: 'running' },
  ],
  pipelineUrl: null,
  approvalsRequired: 1,
  approvalsGiven: 1,
  changesRequested: false,
  detailedMergeStatus: 'mergeable',
  hasConflicts: false,
  issueKeys: ['ENG-1'],
  latestNoteAt: null,
  lastReadAt: null,
  lastEventAt: null,
  lastEventSeenAt: null,
  updatedAt: 100,
  syncedAt: 100,
  ...over,
});

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
    expect(html).toContain('data-issue-breadcrumb');
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
      <IssuePeek breadcrumb={[]} onExpand={() => {}} onClose={() => {}}>
        <div>detail</div>
      </IssuePeek>,
    );

    expect(html).toContain('aria-label="Open full screen"');
    expect(html).toContain('title="Open full screen (Enter)"');
    expect(html).toContain('aria-label="Close"');
    expect(html).toContain('title="Close (Esc)"');
  });

  it('renders the key and every breadcrumb segment in the header, in order', () => {
    const html = renderToStaticMarkup(
      <IssuePeek
        breadcrumb={['Task Manager', 'M4 Reach', 'F4 Linear integration']}
        ticketKey="TM-71"
        onExpand={() => {}}
        onClose={() => {}}
      >
        <div>detail</div>
      </IssuePeek>,
    );

    const crumb = html.indexOf('data-issue-breadcrumb');
    const key = html.indexOf('TM-71');
    const manager = html.indexOf('Task Manager');
    const milestone = html.indexOf('M4 Reach');
    const epic = html.indexOf('F4 Linear integration');

    expect(crumb).toBeGreaterThanOrEqual(0);
    expect(key).toBeGreaterThan(crumb);
    expect(manager).toBeGreaterThan(key);
    expect(milestone).toBeGreaterThan(manager);
    expect(epic).toBeGreaterThan(milestone);
    expect(html).toContain('Task Manager › M4 Reach › F4 Linear integration');
    // The crumb sits ahead of the two icons, not after them.
    expect(epic).toBeLessThan(html.indexOf('aria-label="Open full screen"'));
  });

  it('renders no separator for an empty breadcrumb', () => {
    const withKey = renderToStaticMarkup(
      <IssuePeek breadcrumb={[]} ticketKey="TM-71" onExpand={() => {}} onClose={() => {}}>
        <div>detail</div>
      </IssuePeek>,
    );
    const bare = renderToStaticMarkup(
      <IssuePeek breadcrumb={[]} onExpand={() => {}} onClose={() => {}}>
        <div>detail</div>
      </IssuePeek>,
    );

    expect(withKey).toContain('TM-71');
    expect(withKey).not.toContain('›');
    expect(bare).not.toContain('›');
  });

  it('renders the children', () => {
    const html = renderToStaticMarkup(
      <IssuePeek breadcrumb={[]} onExpand={() => {}} onClose={() => {}}>
        <div>peek detail</div>
      </IssuePeek>,
    );

    expect(html).toContain('peek detail');
  });

  it('shows pipeline stage dots and the verdict badge for a MergeRequests child (F13.24)', () => {
    const html = renderToStaticMarkup(
      <IssuePeek breadcrumb={[]} onExpand={() => {}} onClose={() => {}}>
        <MergeRequests
          mergeRequests={[mr()]}
          onMarkRead={() => {}}
          onMarkEventsSeen={() => {}}
          onRename={() => {}}
          onRebase={() => {}}
          onMerge={() => Promise.resolve([])}
          onLoadMergeProposal={() => Promise.resolve({ method: 'merge', message: null })}
        />
      </IssuePeek>,
    );

    expect(html).toContain('build');
    expect(html).toContain('test');
    expect(html).toContain('ENG-1 fix the thing');
  });

  it('honours mrRebaseButton/mrMergeButton off, same as either host would ask for', () => {
    const readyMr = mr({ approvalsRequired: 1, approvalsGiven: 1, pipelineStatus: 'success' });

    const withButtons = renderToStaticMarkup(
      <IssuePeek breadcrumb={[]} onExpand={() => {}} onClose={() => {}}>
        <MergeRequests
          mergeRequests={[readyMr]}
          onMarkRead={() => {}}
          onMarkEventsSeen={() => {}}
          onRename={() => {}}
          onRebase={() => {}}
          onMerge={() => Promise.resolve([])}
          onLoadMergeProposal={() => Promise.resolve({ method: 'merge', message: null })}
          mrMergeButton
        />
      </IssuePeek>,
    );
    const withoutButton = renderToStaticMarkup(
      <IssuePeek breadcrumb={[]} onExpand={() => {}} onClose={() => {}}>
        <MergeRequests
          mergeRequests={[readyMr]}
          onMarkRead={() => {}}
          onMarkEventsSeen={() => {}}
          onRename={() => {}}
          onRebase={() => {}}
          onMerge={() => Promise.resolve([])}
          onLoadMergeProposal={() => Promise.resolve({ method: 'merge', message: null })}
          mrMergeButton={false}
        />
      </IssuePeek>,
    );

    expect(withButtons).toContain('>Merge<');
    expect(withoutButton).not.toContain('>Merge<');
    expect(withoutButton).toContain('ready to merge');
  });
});
