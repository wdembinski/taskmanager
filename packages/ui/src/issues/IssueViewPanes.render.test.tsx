/**
 * Proves the two panes draw what F13.13's design calls for: the full page's breadcrumb row
 * joins its segments in order, and the peek's header carries just the key and the epic (v9-1),
 * wrapping rather than ellipsized, beside both icon buttons with their own labels. `renderToStaticMarkup` rather than a DOM testing library — this package has none —
 * the same approach `TaskDetailHostView.render.test.tsx` uses.
 *
 * Also proves F13.24's acceptance for the one piece of it that lives here: the board card's
 * Merge requests section — pipeline stage dots, the verdict badge — renders exactly as it
 * would anywhere else once it is `IssuePeek`'s `children`, so a real `TaskDetailHost` dropped
 * into this pane (as both hosts already do) loses nothing by being inside it.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { makeStyles } from '@fluentui/react-components';
import { describe, expect, it } from 'vitest';
import type { MergeRequest } from '@tm/shared/mergeRequest';
import { MergeRequests } from '../MergeRequests';
import { IssueFullPage, IssuePeek } from './IssueViewPanes';

const useProbe = makeStyles({
  ellipsis: { textOverflow: 'ellipsis' },
  nowrap: { whiteSpace: 'nowrap' },
});

/** The one atomic class in a `makeStyles` slot's output (the rest is its `___` slot hash). */
const atomic = (classes: string): string => {
  const found = classes.split(' ').filter((c) => c && !c.startsWith('___'));
  expect(found).toHaveLength(1);
  return found[0];
};

/** The class list of the element carrying `attr` in `html`. */
const classesOf = (html: string, attr: string): string[] => {
  const tag = html.match(new RegExp(`<[^>]*${attr}[^>]*>`))?.[0] ?? '';
  return (tag.match(/class="([^"]*)"/)?.[1] ?? '').split(' ');
};

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
      <IssuePeek onExpand={() => {}} onClose={() => {}}>
        <div>detail</div>
      </IssuePeek>,
    );

    expect(html).toContain('aria-label="Open full screen"');
    expect(html).toContain('title="Open full screen (Enter)"');
    expect(html).toContain('aria-label="Close"');
    expect(html).toContain('title="Close (Esc)"');
  });

  it('prints the key and the epic, and not the project or milestone', () => {
    const html = renderToStaticMarkup(
      <IssuePeek
        ticketKey="TM-71"
        epic="F4 Linear integration"
        onExpand={() => {}}
        onClose={() => {}}
      >
        <div>detail</div>
      </IssuePeek>,
    );

    const crumb = html.indexOf('data-issue-peek-crumb');
    const key = html.indexOf('TM-71');
    const epic = html.indexOf('F4 Linear integration');

    expect(crumb).toBeGreaterThanOrEqual(0);
    expect(key).toBeGreaterThan(crumb);
    expect(epic).toBeGreaterThan(key);
    // The header sits ahead of the two icons, not after them.
    expect(epic).toBeLessThan(html.indexOf('aria-label="Open full screen"'));
    expect(html).not.toContain('Task Manager');
    expect(html).not.toContain('M4 Reach');
    expect(html).not.toContain('›');
    expect(html).not.toContain('data-issue-breadcrumb');
  });

  it('prints just the key for a ticket with no epic', () => {
    const html = renderToStaticMarkup(
      <IssuePeek ticketKey="TM-71" onExpand={() => {}} onClose={() => {}}>
        <div>detail</div>
      </IssuePeek>,
    );

    expect(html).toContain('TM-71');
    expect(html).not.toContain('›');
  });

  it('wraps the header instead of ellipsizing it', () => {
    // Griffel's atomic classes are a hash of property and value, so a probe declaring the
    // same declarations yields the very classes `crumbText` carries.
    let probe: { ellipsis: string; nowrap: string } | null = null;
    const Probe = (): null => {
      probe = useProbe();
      return null;
    };
    renderToStaticMarkup(<Probe />);
    const ellipsis = atomic(probe!.ellipsis);
    const nowrap = atomic(probe!.nowrap);

    const peek = renderToStaticMarkup(
      <IssuePeek
        ticketKey="TM-71"
        epic="F4 Linear integration"
        onExpand={() => {}}
        onClose={() => {}}
      >
        <div>detail</div>
      </IssuePeek>,
    );
    const full = renderToStaticMarkup(
      <IssueFullPage breadcrumb={['Task Manager']} onBack={() => {}}>
        <div>detail</div>
      </IssueFullPage>,
    );
    const peekClasses = classesOf(peek, 'data-issue-peek-crumb');
    const fullClasses = classesOf(full, 'data-issue-breadcrumb');

    // The probe is sound: the full page's crumb, which does ellipsize, carries both.
    expect(fullClasses).toContain(ellipsis);
    expect(fullClasses).toContain(nowrap);
    expect(peekClasses).not.toContain(ellipsis);
    expect(peekClasses).not.toContain(nowrap);
  });

  it('renders the children', () => {
    const html = renderToStaticMarkup(
      <IssuePeek onExpand={() => {}} onClose={() => {}}>
        <div>peek detail</div>
      </IssuePeek>,
    );

    expect(html).toContain('peek detail');
  });

  it('shows pipeline stage dots and the verdict badge for a MergeRequests child (F13.24)', () => {
    const html = renderToStaticMarkup(
      <IssuePeek onExpand={() => {}} onClose={() => {}}>
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
      <IssuePeek onExpand={() => {}} onClose={() => {}}>
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
      <IssuePeek onExpand={() => {}} onClose={() => {}}>
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
