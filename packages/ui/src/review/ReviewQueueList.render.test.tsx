/**
 * Static-markup coverage for `ReviewQueueList`: the three groups and their counts, a collapsed
 * group dropping its rows, the selected row and the draft badge appearing only with drafts.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ReviewQueue, ReviewQueueItem, ReviewQueuesSnapshot } from '@tm/shared/review';
import { ReviewQueueList } from './ReviewQueueList';

function item(over: Partial<ReviewQueueItem> & { subjectId: string }): ReviewQueueItem {
  return {
    queue: 'requested',
    subject: { kind: 'pr', provider: 'github', repoId: 7, repoPath: 'acme/up', number: 1 },
    title: `Title ${over.subjectId}`,
    author: 'Marta',
    repoPath: 'acme/up',
    ref: `!${over.subjectId}`,
    headSha: null,
    draft: false,
    updatedAt: 1,
    projectId: null,
    taskId: null,
    draftCount: 0,
    viewedCount: 0,
    fileCount: null,
    ...over,
  };
}

const snapshot: ReviewQueuesSnapshot = {
  items: [
    item({ subjectId: 'r1', queue: 'requested', draftCount: 3 }),
    item({ subjectId: 'r2', queue: 'requested' }),
    item({ subjectId: 'm1', queue: 'mine' }),
    item({ subjectId: 'a1', queue: 'agent' }),
    item({ subjectId: 'a2', queue: 'agent' }),
  ],
  asOf: { requested: null, mine: null, agent: null },
  partial: [],
};

function render(collapsed: ReviewQueue[] = [], selectedSubjectId: string | null = null): string {
  return renderToStaticMarkup(
    <ReviewQueueList
      snapshot={snapshot}
      selectedSubjectId={selectedSubjectId}
      collapsed={collapsed}
      onToggleGroup={() => {}}
      onSelect={() => {}}
    />,
  );
}

/** The markup of one group's `<section>`. */
function section(html: string, queue: ReviewQueue): string {
  const start = html.indexOf(`data-queue="${queue}"`);
  return html.slice(start, html.indexOf('</section>', start));
}

/** The text of a group's count. */
function count(html: string, queue: ReviewQueue): string | undefined {
  return /data-count="[^"]*">(\d+)</.exec(section(html, queue))?.[1];
}

describe('ReviewQueueList', () => {
  it('draws the three groups in order, each with its count', () => {
    const html = render();
    const at = ['Requested from me', 'My PRs / MRs', 'Agent cards'].map((l) => html.indexOf(l));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(count(html, 'requested')).toBe('2');
    expect(count(html, 'mine')).toBe('1');
    expect(count(html, 'agent')).toBe('2');
    expect(html.match(/role="option"/g)).toHaveLength(5);
  });

  it("hides a collapsed group's rows but keeps its header and count", () => {
    const html = render(['agent']);
    const agent = section(html, 'agent');
    expect(agent).toContain('Agent cards');
    expect(count(html, 'agent')).toBe('2');
    expect(agent).toContain('aria-expanded="false"');
    expect(agent).not.toContain('role="option"');
    expect(html).not.toContain('data-subject-id="a1"');
    expect(html).toContain('data-subject-id="r1"');
  });

  it('shows the draft badge only on a row with drafts', () => {
    const html = render();
    expect(html.match(/data-drafts/g)).toHaveLength(1);
    const r1 = html.slice(
      html.indexOf('data-subject-id="r1"'),
      html.indexOf('data-subject-id="r2"'),
    );
    expect(r1).toContain('data-drafts');
    expect(r1).toContain('>3<');
  });

  it('marks the selected row', () => {
    const html = render([], 'm1');
    expect(html).toMatch(/aria-selected="true"[^>]*data-subject-id="m1"/);
    expect(html.match(/aria-selected="true"/g)).toHaveLength(1);
  });
});
