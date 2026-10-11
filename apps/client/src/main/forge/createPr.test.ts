import { describe, expect, it } from 'vitest';
import { prBody, prTitle, rowFor } from './createPr';

/** What both forges' creates boil down to — the shape `rowFor` reads from. */
const created = (over: Record<string, unknown> = {}) => ({
  provider: 'github' as const,
  repoId: 42,
  projectPath: 'acme/web',
  number: 7,
  title: 'Add the thing',
  webUrl: 'https://github.com/acme/web/pull/7',
  sourceBranch: 'feat/thing',
  targetBranch: 'main',
  draft: false,
  existed: false,
  updatedAt: 1_700_000_000_000,
  ...over,
});

describe('rowFor', () => {
  // The bug: seeding `updatedAt` from `now` (the app's clock, read after the push and the
  // create both round-tripped) routinely reads later than the forge's own timestamp for the
  // same event, so the row looks already-current on the very next sync and never gets its
  // first real detail read. `updatedAt` has to come from the forge, not from when we happened
  // to look.
  it('stamps updatedAt from the created ref, not from `now`', () => {
    const row = rowFor(created({ updatedAt: 1_700_000_000_000 }), 'task-1', 1_800_000_000_000);
    expect(row.updatedAt).toBe(1_700_000_000_000);
    // `syncedAt` really does mean "when we looked".
    expect(row.syncedAt).toBe(1_800_000_000_000);
  });

  it('falls back to 0 when the forge did not say', () => {
    const row = rowFor(created({ updatedAt: 0 }), 'task-1', 1_800_000_000_000);
    expect(row.updatedAt).toBe(0);
  });

  // Honest empty values: a freshly opened PR has not been read for CI or approvals yet, and
  // must not claim a confident answer it does not have.
  it('seeds pipelineStatus as unknown rather than a guess', () => {
    const row = rowFor(created(), 'task-1', 1_800_000_000_000);
    expect(row.pipelineStatus).toBe('unknown');
    expect(row.approvalsRequired).toBeNull();
    expect(row.pipelineStages).toEqual([]);
  });
});

// CONTRIBUTING.md §1/§2 govern a hand-written pull request's title and description, and —
// since the carve-out CONTRIBUTING.md used to document for this button was removed — an
// automated one too. `prTitle`/`prBody` just feed a card's own fields to
// `@shared/commitMessage`, so these tests are about the wiring (which `Task` fields reach
// it, the Ticket ID/Closes/Tested trailers), not the wrapping itself — that is
// `commitMessage.test.ts`'s job.
describe('prTitle', () => {
  it('is a Conventional Commits subject, not the card title verbatim', () => {
    expect(prTitle({ title: 'Add the merge switch on cards', type: 'feature' })).toBe(
      'feat: add the merge switch on cards',
    );
  });

  it('infers from issueType when there is no internal TaskType', () => {
    expect(
      prTitle({ title: 'Flaky checkout step', type: null, issueType: 'bug', externalType: null }),
    ).toBe('fix: flaky checkout step');
  });
});

describe('prBody', () => {
  it('ends in a Ticket ID trailer for a native ticket, and a Tested trailer aggregated from the commits', () => {
    const body = prBody(
      {
        description: 'Fixes the thing.',
        externalDescription: null,
        externalSource: null,
        externalKey: null,
        ticketKey: 'TM-15',
      },
      'github',
      [
        'fix: first part\n\nTested: pnpm test',
        'fix: second part\n\nTested: pnpm test',
        'fix: third part\n\nTested: pnpm build',
      ],
    );
    expect(body).toContain('Ticket ID: TM-15');
    expect(body).toContain('Tested: pnpm test; pnpm build');
    expect(body).not.toContain('Closes');
  });

  it('falls back to naming the commit count, singular, when none of them carry a Tested trailer', () => {
    const body = prBody(
      {
        description: 'Fixes the thing.',
        externalDescription: null,
        externalSource: null,
        externalKey: null,
        ticketKey: null,
      },
      'github',
      ['fix: the one change'],
    );
    expect(body).toContain("Tested: see this branch's 1 commit,");
    expect(body).not.toContain('1 commits');
  });

  it('falls back to naming the branch generically when there are no commits to read at all', () => {
    const body = prBody(
      {
        description: 'Fixes the thing.',
        externalDescription: null,
        externalSource: null,
        externalKey: null,
        ticketKey: null,
      },
      'github',
      [],
    );
    expect(body).toContain("Tested: see this branch's own commits,");
  });

  it('closes a GitHub issue instead of naming it as a Ticket ID', () => {
    const body = prBody(
      {
        description: 'Fixes the thing.',
        externalDescription: null,
        externalSource: 'github',
        externalKey: 'acme/web#12',
        ticketKey: null,
      },
      'github',
      ['fix: the one change'],
    );
    expect(body).toContain('Closes acme/web#12');
    expect(body).not.toContain('Ticket ID:');
  });

  it("summarises the branch's commits rather than the card's description, when there are commits to read", () => {
    const body = prBody(
      {
        description: 'A step brief, never the PR body.',
        externalDescription: "The card's own brief.",
        externalSource: null,
        externalKey: null,
        ticketKey: null,
      },
      'github',
      ['feat: first change\n\nThe real explanation.', 'feat: second change'],
    );
    expect(body).toContain('- feat: first change');
    expect(body).toContain('- feat: second change');
    expect(body).not.toContain("The card's own brief.");
  });

  it('prefers externalDescription over description as the fallback, when there are no commits to read', () => {
    const body = prBody(
      {
        description: 'A step brief, never the PR body.',
        externalDescription: "The card's own brief.",
        externalSource: null,
        externalKey: null,
        ticketKey: null,
      },
      'github',
      [],
    );
    expect(body).toContain("The card's own brief.");
    expect(body).not.toContain('step brief');
  });
});
