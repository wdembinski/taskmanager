/**
 * Static-markup coverage for `ReviewWorkspaceView`'s three states. The loaded state seeds a PR
 * subject and a task subject through `reviewState.ts`'s real transitions (summary, viewed
 * marks, one file ticked) rather than a hand-built `ReviewState`, so what renders here is what
 * the effects component would show for the same answers.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type {
  DiffFileEntry,
  DiffSummary,
  ReviewQueueItem,
  ReviewQueuesSnapshot,
  ReviewSource,
} from '@tm/shared/review';
import {
  EMPTY_REVIEW,
  setViewed,
  summaryArrived,
  summaryLoadStarted,
  viewedArrived,
  viewedLoadStarted,
  type ReviewState,
} from './reviewState';
import { ReviewWorkspaceView, type ReviewWorkspaceViewProps } from './ReviewWorkspaceView';

function item(over: Partial<ReviewQueueItem> & { subjectId: string }): ReviewQueueItem {
  return {
    queue: 'requested',
    subject: { kind: 'pr', provider: 'github', repoId: 7, repoPath: 'acme/up', number: 412 },
    title: 'Retry uploads on a dropped link',
    author: 'Marta',
    repoPath: 'acme/up',
    ref: '#412',
    headSha: 'abc1234def',
    draft: false,
    updatedAt: 1,
    projectId: null,
    taskId: null,
    draftCount: 0,
    viewedCount: 0,
    fileCount: 7,
    ...over,
  };
}

const pr = item({ subjectId: 'pr:github:7:412' });
const task = item({
  subjectId: 'task:t1',
  queue: 'agent',
  subject: { kind: 'task', taskId: 't1' },
  title: 'Add the retry loop',
  ref: 'orch/t1',
  taskId: 't1',
});

const queues: ReviewQueuesSnapshot = {
  items: [
    pr,
    item({ subjectId: 'pr:github:7:413', ref: '#413' }),
    item({ subjectId: 'pr:github:7:500', queue: 'mine', ref: '#500' }),
    task,
    item({ subjectId: 'task:t2', queue: 'agent', subject: { kind: 'task', taskId: 't2' } }),
  ],
  asOf: { requested: null, mine: null, agent: null },
  partial: [],
};

const PATHS = [
  'src/upload/retry.ts',
  'src/upload/queue.ts',
  'src/upload/index.ts',
  'src/net/link.ts',
  'test/retry.test.ts',
  'README.md',
  'package.json',
];

function entry(path: string): DiffFileEntry {
  return {
    path,
    status: 'modified',
    additions: 3,
    deletions: 1,
    binary: false,
    image: false,
    bytes: 100,
    newBlobSha: `blob-${path}`,
  };
}

function summary(source: ReviewSource): DiffSummary {
  return {
    diffId: 'd1',
    baseRef: 'development',
    baseSha: 'base000',
    headSha: 'abc1234def',
    includesWorkingTree: false,
    files: PATHS.map(entry),
    truncated: false,
    source,
  };
}

/** `subjectId` as the frontier key (the workspace's own trick), one file ticked viewed. */
function loaded(subjectId: string, source: ReviewSource): ReviewState {
  let s = summaryLoadStarted(EMPTY_REVIEW, subjectId, 1);
  s = summaryArrived(s, subjectId, 1, { status: 'ok', summary: summary(source) });
  s = viewedLoadStarted(s, subjectId, 1);
  s = viewedArrived(s, subjectId, 1, []);
  return setViewed(s, 'src/upload/retry.ts', true, 10);
}

function render(over: Partial<ReviewWorkspaceViewProps> = {}): string {
  const noop = (): void => {};
  return renderToStaticMarkup(
    <ReviewWorkspaceView
      queues={queues}
      selected={null}
      state={EMPTY_REVIEW}
      error={null}
      layout="unified"
      monochrome={false}
      collapsedGroups={[]}
      copyEnabled
      forgeUrl={null}
      keysOpen={false}
      onSelectSubject={noop}
      onToggleGroup={noop}
      onRefresh={noop}
      onReload={noop}
      onSelectFile={noop}
      onToggleExpanded={noop}
      onToggleViewed={noop}
      onLayoutChange={noop}
      onSend={noop}
      onCopyMarkdown={noop}
      onCloseKeys={noop}
      onClickLine={noop}
      onEditDraft={noop}
      onSave={noop}
      onCancel={noop}
      onEdit={noop}
      onDelete={noop}
      {...over}
    />,
  );
}

/** The text of a queue group's count. */
function count(html: string, queue: string): string | undefined {
  const start = html.indexOf(`data-queue="${queue}"`);
  const section = html.slice(start, html.indexOf('</section>', start));
  return /data-count="[^"]*">(\d+)</.exec(section)?.[1];
}

describe('ReviewWorkspaceView', () => {
  it('is loading before the first queues answer', () => {
    const html = render({ queues: null });
    expect(html).toContain('data-review-workspace');
    expect(html).toContain('data-state="loading"');
    expect(html).toContain('Loading reviews…');
    expect(html).not.toContain('data-queue=');
  });

  it('is loading while the selected subject has no summary yet', () => {
    const state = summaryLoadStarted(EMPTY_REVIEW, pr.subjectId, 1);
    const html = render({ selected: pr, state });
    expect(html).toContain('data-state="loading"');
    expect(html).toContain('Loading changes…');
  });

  it('is empty with the queues but nothing selected', () => {
    const html = render();
    expect(html).toContain('data-state="empty"');
    expect(html).toContain('Pick a pull request or a card to review.');
    expect(html).not.toContain('data-viewed-count');
    expect(html).not.toContain('Send to agent');
    expect(html).not.toContain('Copy review as Markdown');
  });

  describe('loaded', () => {
    const prHtml = render({
      selected: pr,
      state: loaded(pr.subjectId, 'local-ref'),
      forgeUrl: 'https://github.com/acme/up/pull/412',
    });
    const taskHtml = render({ selected: task, state: loaded(task.subjectId, 'forge-api') });

    it('reads loaded', () => {
      expect(prHtml).toContain('data-state="loaded"');
      expect(taskHtml).toContain('data-state="loaded"');
    });

    it('draws the three queue groups with their counts', () => {
      expect(prHtml).toContain('Requested from me');
      expect(prHtml).toContain('My PRs / MRs');
      expect(prHtml).toContain('Agent cards');
      expect(count(prHtml, 'requested')).toBe('2');
      expect(count(prHtml, 'mine')).toBe('1');
      expect(count(prHtml, 'agent')).toBe('2');
    });

    it('counts the viewed files and ticks exactly one box', () => {
      expect(prHtml).toContain('data-viewed-count="1"');
      expect(prHtml).toContain('1 / 7 viewed');
      expect(prHtml.match(/type="checkbox"/g)).toHaveLength(7);
      expect(prHtml.match(/<input[^>]*type="checkbox"[^>]*\schecked/g)).toHaveLength(1);
    });

    it('names the diff source', () => {
      expect(prHtml).toMatch(/data-source-badge[^>]*>local clone</);
      expect(taskHtml).toMatch(/data-source-badge[^>]*>forge API · read only</);
    });

    it('offers Copy and Open on forge for a PR, never Send to agent', () => {
      expect(prHtml).toContain('Copy review as Markdown');
      expect(prHtml).toContain('Open on forge');
      expect(prHtml).toContain('href="https://github.com/acme/up/pull/412"');
      expect(prHtml).not.toContain('Send to agent');
    });

    it('offers Send to agent for a task, never Copy or Open on forge', () => {
      expect(taskHtml).toContain('Send to agent');
      expect(taskHtml).not.toContain('Copy review as Markdown');
      expect(taskHtml).not.toContain('Open on forge');
    });

    it('keeps the AI slot present and empty', () => {
      for (const html of [prHtml, taskHtml]) {
        expect(html).toMatch(/<span[^>]*data-slot="ai-review"[^>]*><\/span>/);
      }
    });

    it('paints no glass into the markup itself', () => {
      for (const html of [prHtml, taskHtml]) {
        expect(html.toLowerCase()).not.toContain('backdrop-filter');
      }
    });
  });
});
