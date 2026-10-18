import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Project, Task } from '@shared/model';
import type { AppSettings } from '@shared/settings';
import { openPullRequest, prBody, prTitle, rowFor, type CreatePrDeps } from './createPr';

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

// Step 5 of "Show the screenshot comparisons on the card and the PR, not on a hidden step":
// the PR body is the one other place a pending visual sign-off has to surface, so a human
// reviewing the pull request knows to go look at the card before merging rather than finding
// the shots by accident.
describe('prBody — visual sign-off section', () => {
  const task = {
    description: 'Fixes the thing.',
    externalDescription: null,
    externalSource: null,
    externalKey: null,
    ticketKey: 'TM-461',
  };

  it('names how many screens were compared, the card to review them on, and each verdict', () => {
    const body = prBody(task, 'github', ['fix: the one change'], {
      cardKey: 'TM-461',
      screens: [
        { name: 'board-light', verdict: 'the header drifted' },
        { name: 'board-dark', verdict: 'matched the mockup' },
      ],
    });
    expect(body).toContain('Visual sign-off: 2 screens compared');
    expect(body.replace(/\n/g, ' ')).toContain('review them on TM-461 in VIPPER before merging.');
    expect(body).toContain('- board-light: the header drifted');
    expect(body).toContain('- board-dark: matched the mockup');
  });

  it('uses the singular for one screen', () => {
    const body = prBody(task, 'github', ['fix: the one change'], {
      cardKey: 'TM-461',
      screens: [{ name: 'board-light', verdict: 'matched the mockup' }],
    });
    expect(body).toContain('Visual sign-off: 1 screen compared');
  });

  it('names a screen with no verdict yet, rather than inventing one', () => {
    const body = prBody(task, 'github', ['fix: the one change'], {
      cardKey: 'TM-461',
      screens: [{ name: 'board-light' }],
    });
    expect(body).toContain('- board-light');
    expect(body).not.toContain('- board-light:');
  });

  it('falls back to the card title when it has no ticket or external key', () => {
    const body = prBody(task, 'github', ['fix: the one change'], {
      cardKey: 'Add the export dialog',
      screens: [{ name: 'board-light' }],
    });
    expect(body.replace(/\n/g, ' ')).toContain(
      'review them on Add the export dialog in VIPPER before merging.',
    );
  });

  it('is unchanged when there is no sign-off to report', () => {
    const without = prBody(task, 'github', ['fix: the one change']);
    expect(without).not.toContain('Visual sign-off');
  });

  it('is unchanged when the sign-off names no screens', () => {
    const without = prBody(task, 'github', ['fix: the one change']);
    const empty = prBody(task, 'github', ['fix: the one change'], {
      cardKey: 'TM-461',
      screens: [],
    });
    expect(empty).toBe(without);
  });

  it('wraps every line within 72 columns even with a long verdict', () => {
    const body = prBody(task, 'github', ['fix: the one change'], {
      cardKey: 'TM-461',
      screens: [
        {
          name: 'board-light',
          verdict:
            'the header background drifted from the mockup and the spacing around the ' +
            'search box looks off too',
        },
      ],
    });
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

/**
 * F10.6: a leader's own pull request routes through `variantWorkOwner`, exactly as the
 * merge button does — refusing before a pick, and pushing the picked ROW's branch
 * afterwards, the same `worktreeOwner` rule a step's own PR already follows for its parent.
 */
describe('openPullRequest — routed through a variant pick (F10.6)', () => {
  const originalFetch = globalThis.fetch;
  const originalGitConfig = process.env.GIT_CONFIG_GLOBAL;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalGitConfig === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = originalGitConfig;
  });

  /** One `git` invocation, synchronous — nothing here needs to be concurrent. */
  const git = (cwd: string, ...args: string[]) => {
    const res = spawnSync('git', args, { cwd, encoding: 'utf8' });
    return { code: res.status ?? 1, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
  };

  const leader = {
    id: 'leader-1',
    projectId: 'personal',
    title: 'Fix the parser',
    type: null,
    issueType: null,
    externalType: null,
    description: null,
    externalDescription: null,
    externalSource: null,
    externalKey: null,
    ticketKey: null,
    agentProjectId: 'agent-1',
    agentBranch: null,
    parentTaskId: null,
    pickedVariantId: null,
  } as unknown as Task;

  it('refuses an unpicked leader with "pick a variant first", before touching a worktree', async () => {
    const row = { id: 'row-A', variantOf: leader.id } as unknown as Task;
    const inspect = async () => null;
    const deps: CreatePrDeps = {
      getTask: (id) => (id === leader.id ? leader : id === row.id ? row : undefined),
      getProject: () => undefined,
      getSettings: () => ({}) as unknown as AppSettings,
      listMergeRequests: () => [],
      upsertMergeRequest: () => undefined,
      listVariantRows: () => [row],
      listAttachments: () => [],
      listActivity: () => [],
      inspect,
      syncOntoRemoteBase: async () => ({ status: 'up-to-date' }),
      tokenFor: () => 'tok',
      note: () => undefined,
      now: () => 0,
    };

    await expect(openPullRequest(deps, leader.id)).rejects.toThrow(/pick a variant first/i);
  });

  it("pushes the picked ROW's branch, not the leader's (which never had one)", async () => {
    const ROW_BRANCH = 'feat/variant-a';
    const work = mkdtempSync(join(tmpdir(), 'tm-createpr-variant-'));
    try {
      const bare = join(work, 'origin.git');
      const repo = join(work, 'repo');
      git(work, 'init', '--bare', bare);
      git(work, 'init', repo);
      git(repo, 'config', 'user.email', 'verify@example.com');
      git(repo, 'config', 'user.name', 'Verify');
      git(repo, 'config', 'commit.gpgsign', 'false');
      writeFileSync(join(repo, 'README.md'), '# demo\n');
      git(repo, 'add', '-A');
      git(repo, 'commit', '--no-verify', '-m', 'initial');
      const base = git(repo, 'rev-parse', '--abbrev-ref', 'HEAD').stdout.trim();
      git(repo, 'remote', 'add', 'origin', 'https://github.com/acme/checkout.git');

      git(repo, 'checkout', '-b', ROW_BRANCH);
      writeFileSync(join(repo, 'variant-a.ts'), 'export const a = true;\n');
      git(repo, 'add', '-A');
      git(repo, 'commit', '--no-verify', '-m', 'variant A work');
      const head = git(repo, 'rev-parse', 'HEAD').stdout.trim();

      // Redirect the tokenized URL to the bare repo, in a config of our own — never the
      // user's own global one — the same trick `scripts/verify-create-pr.mjs` uses.
      const TOKEN = 'ghp_variantpick0000';
      const gitConfig = join(work, 'harness.gitconfig');
      writeFileSync(
        gitConfig,
        `[url "file://${bare.replace(/\\/g, '/')}"]\n` +
          `\tinsteadOf = https://x-access-token:${TOKEN}@github.com/acme/checkout.git\n`,
        'utf8',
      );
      process.env.GIT_CONFIG_GLOBAL = gitConfig;

      const row = {
        id: 'row-A',
        projectId: 'personal',
        variantOf: leader.id,
        title: leader.title,
        type: null,
        issueType: null,
        externalType: null,
        description: null,
        externalDescription: null,
        externalSource: null,
        externalKey: null,
        ticketKey: null,
        agentProjectId: 'agent-1',
        agentBranch: ROW_BRANCH,
        parentTaskId: null,
      } as unknown as Task;
      const picked = { ...leader, pickedVariantId: row.id } as unknown as Task;
      const project = { id: 'agent-1', path: repo, baseBranch: base } as unknown as Project;

      globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
        const sent = JSON.parse(init?.body ?? '{}');
        const body = {
          id: 900,
          number: 12,
          title: sent.title,
          state: 'open',
          draft: false,
          html_url: 'https://github.com/acme/checkout/pull/12',
          head: { ref: sent.head, repo: { id: 555 } },
          base: { ref: sent.base },
        };
        return {
          ok: true,
          status: 201,
          statusText: 'Created',
          json: async () => body,
          text: async () => JSON.stringify(body),
          headers: { get: () => null },
        };
      }) as unknown as typeof fetch;

      const inspectCalls: Array<{ ownerTaskId: string; branch?: string }> = [];
      const upserts: Array<{ taskId: string; sourceBranch: string }> = [];
      const deps: CreatePrDeps = {
        getTask: (id) => (id === picked.id ? picked : id === row.id ? row : undefined),
        getProject: (id) => (id === 'agent-1' ? project : undefined),
        getSettings: () =>
          ({
            github: { enabled: true, baseUrl: 'https://api.github.com' },
          }) as unknown as AppSettings,
        listMergeRequests: () => [],
        upsertMergeRequest: (mr) => {
          upserts.push(mr as unknown as { taskId: string; sourceBranch: string });
        },
        listVariantRows: (leaderId) => (!leaderId || leaderId === picked.id ? [row] : []),
        listAttachments: () => [],
        listActivity: () => [],
        inspect: async (_p, ownerTaskId, branch) => {
          inspectCalls.push({ ownerTaskId, branch });
          return { cwd: repo, branch: branch ?? ROW_BRANCH, base };
        },
        syncOntoRemoteBase: async () => ({ status: 'up-to-date' }),
        tokenFor: () => TOKEN,
        note: () => undefined,
        now: () => 1_760_000_000_000,
      };

      const opened = await openPullRequest(deps, picked.id);

      expect(opened.existed).toBe(false);
      // Resolved — and asked `inspect` — through the picked ROW, never the leader.
      expect(inspectCalls).toEqual([{ ownerTaskId: row.id, branch: ROW_BRANCH }]);
      // The row's own branch landed on the far side, at the commit the row actually made.
      const landed = git(bare, 'rev-parse', `refs/heads/${ROW_BRANCH}`);
      expect(landed.code).toBe(0);
      expect(landed.stdout.trim()).toBe(head);
      // The merge request is filed under the row, the same `worktreeOwner` rule a step's PR
      // already follows for its parent.
      expect(upserts[0]?.taskId).toBe(row.id);
      expect(upserts[0]?.sourceBranch).toBe(ROW_BRANCH);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });
});
