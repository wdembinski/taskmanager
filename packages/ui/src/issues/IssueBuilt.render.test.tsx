/**
 * Proves the full-screen issue's Built and Tested sections draw what the card carries and
 * NOTHING when it carries nothing — never a heading over an empty line.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { MergeRequest } from '@tm/shared/mergeRequest';
import { IssueBuilt, IssueTested, testedMergeRequest } from './IssueBuilt';

const mr = (over: Partial<MergeRequest> = {}): MergeRequest =>
  ({
    id: 'gl-1-191',
    taskId: 't1',
    provider: 'gitlab',
    number: 191,
    state: 'opened',
    draft: false,
    pipelineStatus: 'success',
    pipelineStages: [],
    updatedAt: 1,
    ...over,
  }) as MergeRequest;

describe('IssueBuilt', () => {
  it('shows the branch and one line per open or merged MR', () => {
    const html = renderToStaticMarkup(
      <IssueBuilt
        task={{ agentBranch: 'tm-71-milestone-archiving' }}
        mergeRequests={[
          mr(),
          mr({ id: 'gl-1-124', number: 124, state: 'merged', pipelineStatus: 'none' }),
          mr({ id: 'gl-1-90', number: 90, state: 'closed' }),
        ]}
      />,
    );
    expect(html).toContain('>Built<');
    expect(html).toContain('tm-71-milestone-archiving');
    expect(html).toContain('!191 open · pipeline passed');
    // A merged MR with no pipeline verdict says only that it merged.
    expect(html).toContain('>!124 merged<');
    // A closed MR built nothing that stands.
    expect(html).not.toContain('!90');
    // Nothing supplies a commits-ahead count, so no such line is drawn.
    expect(html).not.toContain('ahead of');
  });

  it('shows the commits-ahead line when a caller supplies one', () => {
    const html = renderToStaticMarkup(
      <IssueBuilt
        task={{ agentBranch: 'b' }}
        mergeRequests={[]}
        commitsAhead={{ count: 2, base: 'development' }}
      />,
    );
    expect(html).toContain('2 commits ahead of development');
  });

  it('renders nothing with no branch and no MR', () => {
    expect(renderToStaticMarkup(<IssueBuilt task={{}} mergeRequests={[]} />)).toBe('');
    expect(
      renderToStaticMarkup(
        <IssueBuilt task={{ agentBranch: null }} mergeRequests={[mr({ state: 'closed' })]} />,
      ),
    ).toBe('');
  });
});

describe('IssueTested', () => {
  it("shows the newest pipeline's status and its stages", () => {
    const html = renderToStaticMarkup(
      <IssueTested
        mergeRequests={[
          mr({ id: 'old', number: 1, pipelineStatus: 'success', updatedAt: 1 }),
          mr({
            id: 'new',
            number: 2,
            pipelineStatus: 'failed',
            updatedAt: 5,
            pipelineStages: [
              { name: 'build', status: 'success' },
              { name: 'test', status: 'failed' },
            ],
          }),
        ]}
      />,
    );
    expect(html).toContain('>Tested<');
    expect(html).toContain('!2 pipeline failed');
    expect(html).toContain('build passed');
    expect(html).toContain('test failed');
    expect(html).not.toContain('!1 pipeline');
  });

  it('renders nothing when no MR has a pipeline', () => {
    const none = [mr({ pipelineStatus: 'none' }), mr({ id: 'x', pipelineStatus: 'unknown' })];
    expect(renderToStaticMarkup(<IssueTested mergeRequests={none} />)).toBe('');
    expect(renderToStaticMarkup(<IssueTested mergeRequests={[]} />)).toBe('');
    expect(testedMergeRequest(none)).toBeNull();
  });
});
