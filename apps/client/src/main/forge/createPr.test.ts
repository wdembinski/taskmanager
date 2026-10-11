import { execFileSync } from 'node:child_process';
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

  // F1.10's own two real commits (c5a8c40, 21e6896) — see commitMessage.test.ts's own copy of
  // this worked example for why this pair: more than one commit, each with a distinct Tested
  // trailer, and a Co-Authored-By trailer that must never reach the rendered body.
  const f1_10First =
    'feat(tray): add background-mode decision logic\n\n' +
    'Pure decision tables for F1.10: what closing the window should\n' +
    'do, and the tray menu it can now show while kept open.\n\n' +
    'Ticket ID: F1.10\n' +
    'Tested: pnpm format, pnpm typecheck, pnpm test (1847 passed, 11\n' +
    '        skipped) all green.\n' +
    'Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>';
  const f1_10Second =
    'feat(app): keep running in the tray on close\n\n' +
    'Adds the runInBackground setting and wires it into window close\n' +
    'handling.\n\n' +
    'Ticket ID: F1.10\n' +
    'Tested: pnpm format:check, pnpm typecheck, pnpm test (3814 passed,\n' +
    '        11 skipped), pnpm build --force all green.\n' +
    'Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>';

  it('renders the F1.10 two-commit example: both subjects, both Tested values, no commit-count fallback, no Co-Authored-By, every line within 72 columns', () => {
    const body = prBody(
      {
        description: null,
        externalDescription: null,
        externalSource: null,
        externalKey: null,
        ticketKey: 'F1.10',
      },
      'github',
      [f1_10First, f1_10Second],
    );

    expect(body).toContain('- feat(tray): add background-mode decision logic');
    expect(body).toContain('- feat(app): keep running in the tray on close');
    expect(body).toContain('Ticket ID: F1.10');

    // The two Tested values are joined onto one logical trailer and may wrap across several
    // continuation lines, so collapse those back onto one line before matching the sentences.
    const collapsed = body.replace(/\n {2,}/g, ' ');
    expect(collapsed).toContain(
      'pnpm format, pnpm typecheck, pnpm test (1847 passed, 11 skipped) all green',
    );
    expect(collapsed).toContain(
      'pnpm format:check, pnpm typecheck, pnpm test (3814 passed, 11 skipped), pnpm build --force all green',
    );

    expect(body).not.toContain('Co-Authored-By');
    expect(body).not.toContain("see this branch's");

    for (const line of body.split('\n')) {
      expect(line.length).toBeLessThanOrEqual(72);
    }
  });
});

// CONTRIBUTING.md §2 says "`Ticket ID:` and `Tested:` are trailers; git only recognises
// them as such if they sit in the final paragraph" — worth checking against the REAL `git
// interpret-trailers` rather than our own looser `parseCommitMessage`, since a squash merge
// turns this exact rendered body into a real commit message (the parent ticket's whole
// complaint). It only holds for `Tested:`: git's trailer token syntax has no room for a
// space, so "Ticket ID" is never a token it recognises — and, because trailer detection is
// all-or-nothing over the final paragraph (the same rule `parseTrailerBlock` above applies),
// that one unrecognised line keeps git from seeing `Tested:` either whenever a ticket key is
// present, which is the common case. See the step's own notes for this discrepancy against
// CONTRIBUTING.md's claim.
describe("the rendered body through git's own interpret-trailers", () => {
  /** The trailer keys real `git interpret-trailers` recognises in `body`, read as if it were
   *  a commit message (`Subject`, blank line, then `body` verbatim). */
  function trailerKeysSeenByGit(body: string): string[] {
    const out = execFileSync('git', ['interpret-trailers', '--only-trailers', '--unfold'], {
      input: `Subject\n\n${body}`,
      encoding: 'utf8',
    });
    return out
      .split('\n')
      .filter(Boolean)
      .map((line) => line.split(':')[0].trim());
  }

  const commits = [
    'fix: first part\n\nTested: pnpm test',
    'fix: second part\n\nTested: pnpm build',
  ];

  it('recognises Tested as a real git trailer when no Ticket ID line sits beside it', () => {
    const body = prBody(
      {
        description: 'Fixes the thing.',
        externalDescription: null,
        externalSource: null,
        externalKey: null,
        ticketKey: null,
      },
      'github',
      commits,
    );
    expect(trailerKeysSeenByGit(body)).toContain('Tested');
  });

  it('does not recognise Ticket ID — its key contains a space — and that unrecognised line keeps git from recognising Tested too', () => {
    const body = prBody(
      {
        description: 'Fixes the thing.',
        externalDescription: null,
        externalSource: null,
        externalKey: null,
        ticketKey: 'TM-15',
      },
      'github',
      commits,
    );
    const seen = trailerKeysSeenByGit(body);
    expect(seen).not.toContain('Ticket ID');
    expect(seen).not.toContain('Tested');
  });
});
