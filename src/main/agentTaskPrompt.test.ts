/**
 * Unit tests for the delegated-card prompt. It is pure, so the whole contract —
 * single-ticket focus, the ticket brief, the worktree rule, the never-write-to-JIRA
 * rule, and the question sentinel — is checkable without a process or a DB.
 */
import { describe, expect, it } from 'vitest';
import {
  buildAgentSubtaskPrompt,
  buildAgentTaskPrompt,
  buildReplanPrompt,
} from './agentTaskPrompt';
import { NEEDS_INPUT_SENTINEL } from './attention';
import { NOTES_CHAR_BUDGET, TICKET_COMMENT_CHAR_BUDGET } from './promptHistory';
import type { Task } from '@shared/model';

const jiraTask = {
  id: 't1',
  projectId: 'personal',
  phase: '',
  title: 'Fix the export dialog',
  status: 'pending',
  sessionId: null,
  order: 0,
  source: 'jira',
  dependsOn: [],
  isContract: false,
  isScaffold: false,
  externalSource: 'jira',
  externalKey: 'ABC-42',
  externalUrl: 'https://jira.example.com/browse/ABC-42',
  externalDescription: 'The export dialog closes without writing the file.',
  agentProjectId: 'agent-1',
} as Task;

const internalTask = {
  id: 't2',
  projectId: 'personal',
  phase: '',
  title: 'Tidy the release script',
  status: 'pending',
  sessionId: null,
  order: 1,
  source: 'adhoc',
  dependsOn: [],
  isContract: false,
  isScaffold: false,
  agentProjectId: 'agent-1',
} as Task;

describe('buildAgentTaskPrompt', () => {
  it('focuses the agent on one ticket and names the repo', () => {
    const prompt = buildAgentTaskPrompt('Checkout service', jiraTask);
    expect(prompt).toContain('Checkout service');
    expect(prompt).toContain('ONE ticket');
    expect(prompt).toContain('ABC-42 — Fix the export dialog');
    expect(prompt).toContain('https://jira.example.com/browse/ABC-42');
    expect(prompt).toContain('The export dialog closes without writing the file.');
  });

  it('never mentions a plan or a task queue (an agent project has neither)', () => {
    const prompt = buildAgentTaskPrompt('Checkout service', jiraTask, { branch: 'orch/abc' });
    expect(prompt).not.toContain('plan file');
    expect(prompt).toContain('there is none');
  });

  it('reuses the question sentinel verbatim so detection cannot drift', () => {
    const prompt = buildAgentTaskPrompt('Checkout service', jiraTask);
    expect(prompt).toContain(NEEDS_INPUT_SENTINEL);
  });

  it('lists the ticket comments in the order given, and the human’s notes', () => {
    const prompt = buildAgentTaskPrompt('Checkout service', jiraTask, {
      comments: [
        { author: 'Ada', body: 'Only on Windows.' },
        { author: 'Grace', body: 'Repro attached.' },
      ],
      notes: ['Start with the file-picker path.'],
    });
    expect(prompt).toContain('- Ada: Only on Windows.');
    expect(prompt).toContain('- Grace: Repro attached.');
    expect(prompt.indexOf('Ada')).toBeLessThan(prompt.indexOf('Grace'));
    expect(prompt).toContain('- Start with the file-picker path.');
  });

  it('drops empty comments/notes rather than emitting blank bullets', () => {
    const prompt = buildAgentTaskPrompt('Checkout service', jiraTask, {
      comments: [{ author: 'Ada', body: '   ' }],
      notes: ['', '  '],
    });
    expect(prompt).not.toContain('Comments on the ticket');
    expect(prompt).not.toContain('Notes from the human');
  });

  it('tells a worktree run to commit on its own branch', () => {
    const prompt = buildAgentTaskPrompt('Checkout service', jiraTask, { branch: 'orch/abc123' });
    expect(prompt).toContain('orch/abc123');
    expect(prompt).toContain('Commit your');
    expect(prompt).toContain('merges it back');
  });

  it('forbids writing back to the tracker for a linked ticket', () => {
    expect(buildAgentTaskPrompt('Checkout service', jiraTask)).toContain('Do NOT update ABC-42');
  });

  it('says nothing about a tracker for an internal task', () => {
    const prompt = buildAgentTaskPrompt('Checkout service', internalTask);
    expect(prompt).toContain('Task: Tidy the release script');
    expect(prompt).not.toContain('tracker');
    expect(prompt).not.toContain('Link:');
  });

  it('hands over a previous failure on an AI-assisted retry', () => {
    const prompt = buildAgentTaskPrompt('Checkout service', jiraTask, {
      failureNote: 'the build broke',
    });
    expect(prompt).toContain('the build broke');
    expect(prompt).toContain('Diagnose why it failed');
  });

  it('never leaves a double blank line', () => {
    const prompt = buildAgentTaskPrompt('Checkout service', internalTask, { branch: 'orch/x' });
    expect(prompt).not.toContain('\n\n\n');
  });
});

describe('buildAgentSubtaskPrompt (one step of an approved plan)', () => {
  const step = {
    id: 's2',
    projectId: 'personal',
    phase: '',
    title: 'Wire the save path',
    status: 'pending',
    sessionId: null,
    order: 1,
    source: 'adhoc',
    dependsOn: [],
    isContract: false,
    isScaffold: false,
    parentTaskId: 't1',
    description: 'Write the chosen file to disk and surface errors in the dialog.',
    agentProjectId: 'agent-1',
    agentMode: 'bypassPermissions',
  } as Task;

  const base = {
    stepNumber: 2,
    stepCount: 3,
    stepTitles: ['Reproduce the bug', 'Wire the save path', 'Add a regression test'],
  };

  it('scopes the agent to this step and names its place in the chain', () => {
    const prompt = buildAgentSubtaskPrompt('Checkout service', jiraTask, step, base);
    expect(prompt).toContain('step 2 of 3');
    expect(prompt).toContain('Your step: Wire the save path');
    expect(prompt).toContain('Write the chosen file to disk');
    expect(prompt).toContain('Do ONLY this step');
    expect(prompt).toContain('do not re-plan');
  });

  it('orients the step in the plan by title only — never the parent’s ticket brief', () => {
    const prompt = buildAgentSubtaskPrompt('Checkout service', jiraTask, step, base);
    expect(prompt).toContain('1. Reproduce the bug');
    expect(prompt).toContain('2. Wire the save path  ← you');
    expect(prompt).toContain('3. Add a regression test');
    // The token saving: the ticket's own description and comment thread stay out.
    expect(prompt).not.toContain('The export dialog closes without writing the file.');
  });

  it('names the parent ticket for context and still forbids tracker writes', () => {
    const prompt = buildAgentSubtaskPrompt('Checkout service', jiraTask, step, base);
    expect(prompt).toContain('Parent ticket: ABC-42 — Fix the export dialog');
    expect(prompt).toContain('Do NOT update ABC-42');
  });

  it('protects the SHARED branch: commit, never reset/rebase/switch', () => {
    const prompt = buildAgentSubtaskPrompt('Checkout service', jiraTask, step, {
      ...base,
      branch: 'orch/t1',
    });
    expect(prompt).toContain('orch/t1');
    expect(prompt).toContain('SHARED by every step');
    expect(prompt).toContain('do NOT reset, rebase, merge, or switch branches');
  });

  it('carries the human’s notes from the card and the question contract', () => {
    const prompt = buildAgentSubtaskPrompt('Checkout service', jiraTask, step, {
      ...base,
      notes: ['Start with the file-picker path.'],
    });
    expect(prompt).toContain('Start with the file-picker path.');
    expect(prompt).toContain(NEEDS_INPUT_SENTINEL);
  });

  it('hands over a previous failure on an AI-assisted retry of the step', () => {
    const prompt = buildAgentSubtaskPrompt('Checkout service', jiraTask, step, {
      ...base,
      failureNote: 'the build broke',
    });
    expect(prompt).toContain('the build broke');
    expect(prompt).toContain('Diagnose why it failed');
  });

  it('omits the plan listing for a single-step plan, and leaves no double blank line', () => {
    const prompt = buildAgentSubtaskPrompt('Checkout service', internalTask, step, {
      stepNumber: 1,
      stepCount: 1,
      stepTitles: ['Wire the save path'],
      branch: 'orch/t2',
    });
    expect(prompt).not.toContain('for orientation only');
    expect(prompt).toContain('Parent task: Tidy the release script');
    expect(prompt).not.toContain('\n\n\n');
  });
});

/**
 * Standing project instructions and the worktree's identity. Both exist to stop the
 * agent operating on the wrong thing: instructions carry setup knowledge the agent
 * cannot infer (an environment to source, a wrapper to use), and naming the working
 * directory stops an external build being pointed at the project's main checkout —
 * which would compile unmodified source and *succeed*.
 */
describe('project setup notes and worktree identity', () => {
  const base = { stepNumber: 1, stepCount: 2, stepTitles: ['a', 'b'] };

  it('injects standing instructions into a delegated-card prompt', () => {
    const prompt = buildAgentTaskPrompt('Checkout service', jiraTask, {
      instructions: 'Source /opt/poky/oe-init-build-env before any bitbake command.',
    });
    expect(prompt).toContain('Project setup notes you must follow:');
    expect(prompt).toContain('Source /opt/poky/oe-init-build-env');
  });

  it('injects standing instructions into a subtask prompt', () => {
    const prompt = buildAgentSubtaskPrompt('Checkout service', jiraTask, internalTask, {
      ...base,
      instructions: 'Run bitbake through ./scripts/bb-wrapper.sh.',
    });
    expect(prompt).toContain('./scripts/bb-wrapper.sh');
  });

  it('omits the setup-notes block entirely when there are none', () => {
    const prompt = buildAgentTaskPrompt('Checkout service', jiraTask, { instructions: '   ' });
    expect(prompt).not.toContain('Project setup notes');
    expect(prompt).not.toContain('\n\n\n');
  });

  it('names the worktree as the source of truth, against the main checkout', () => {
    const prompt = buildAgentTaskPrompt('Checkout service', jiraTask, {
      branch: 'orch/t1',
      worktreePath: '/home/you/.local/share/claude-orchestrator/worktrees/p/t1',
      projectPath: '/home/you/src/checkout',
    });
    expect(prompt).toContain('/home/you/.local/share/claude-orchestrator/worktrees/p/t1');
    expect(prompt).toContain('/home/you/src/checkout');
    expect(prompt).toContain('point it HERE');
  });

  it('says nothing about directories when the run is not in a worktree', () => {
    const prompt = buildAgentTaskPrompt('Checkout service', jiraTask, {
      worktreePath: '/should/not/appear',
    });
    expect(prompt).not.toContain('/should/not/appear');
  });
});

/**
 * The attachment legend (Phase 22) — what turns `@shot.png` in a brief into a file the
 * agent can open. The paths arrive already native to the run's machine (the scheduler
 * translates for WSL), so what is checked here is only the table and its two rules: every
 * attachment is listed, and none of them may be copied into the repository.
 */
describe('the attachment legend', () => {
  const step = {
    id: 's1',
    projectId: 'personal',
    phase: '',
    title: 'Match the mockup',
    status: 'pending',
    sessionId: null,
    order: 0,
    source: 'adhoc',
    dependsOn: [],
    isContract: false,
    isScaffold: false,
    parentTaskId: 't1',
    description: 'Lay the toolbar out as @mockup.png shows.',
    agentProjectId: 'agent-1',
  } as Task;

  const stepBase = { stepNumber: 1, stepCount: 2, stepTitles: ['Match the mockup', 'Test it'] };

  it('names every attached file and where it is', () => {
    const prompt = buildAgentTaskPrompt('Checkout service', jiraTask, {
      attachments: [
        { name: 'mockup.png', path: '/mnt/c/Users/you/AppData/attachments/t1/mockup.png' },
        { name: 'repro.csv', path: '/mnt/c/Users/you/AppData/attachments/t1/repro.csv' },
      ],
    });
    expect(prompt).toContain('Files attached to this task');
    expect(prompt).toContain('the @name on the left');
    expect(prompt).toContain('- @mockup.png -> /mnt/c/Users/you/AppData/attachments/t1/mockup.png');
    expect(prompt).toContain('- @repro.csv -> /mnt/c/Users/you/AppData/attachments/t1/repro.csv');
    // The description is what cites them, so the legend follows it.
    expect(prompt.indexOf('The export dialog closes')).toBeLessThan(prompt.indexOf('@mockup.png'));
  });

  it('forbids copying the files into the repository', () => {
    const prompt = buildAgentTaskPrompt('Checkout service', jiraTask, {
      attachments: [{ name: 'shot.png', path: '/data/attachments/t1/shot.png' }],
    });
    expect(prompt).toContain('Read them with your file tools');
    expect(prompt).toContain('do not copy them into it');
  });

  it('lists a file the text never cites — a mistyped token is not a missing input', () => {
    const prompt = buildAgentTaskPrompt('Checkout service', jiraTask, {
      attachments: [
        { name: 'never-mentioned.log', path: '/data/attachments/t1/never-mentioned.log' },
      ],
    });
    expect(prompt).toContain('- @never-mentioned.log -> /data/attachments/t1/never-mentioned.log');
  });

  it('is absent entirely when nothing is attached, and leaves no double blank line', () => {
    const withNone = buildAgentTaskPrompt('Checkout service', jiraTask, { attachments: [] });
    expect(withNone).not.toContain('Files attached');
    expect(buildAgentTaskPrompt('Checkout service', jiraTask)).not.toContain('Files attached');
    expect(withNone).not.toContain('\n\n\n');
  });

  it('leaves no double blank around it, with or without a description', () => {
    const attachments = [{ name: 'a.png', path: '/data/attachments/t1/a.png' }];
    expect(
      buildAgentTaskPrompt('Checkout service', jiraTask, { attachments, branch: 'orch/t1' }),
    ).not.toContain('\n\n\n');
    // `internalTask` has no description at all, so the legend lands against the heading.
    expect(buildAgentTaskPrompt('Checkout service', internalTask, { attachments })).not.toContain(
      '\n\n\n',
    );
  });

  it('drops an entry with no name or no path rather than emitting a broken row', () => {
    const prompt = buildAgentTaskPrompt('Checkout service', jiraTask, {
      attachments: [
        { name: '  ', path: '/data/attachments/t1/x.png' },
        { name: 'y.png', path: '   ' },
      ],
    });
    expect(prompt).not.toContain('Files attached');
  });

  it('carries the parent card’s file into a step’s legend, from the card’s directory', () => {
    const prompt = buildAgentSubtaskPrompt('Checkout service', jiraTask, step, {
      ...stepBase,
      attachments: [
        { name: 'own.log', path: '/data/attachments/s1/own.log' },
        { name: 'mockup.png', path: '/data/attachments/t1/mockup.png' },
      ],
    });
    expect(prompt).toContain('Files attached to this step and its card');
    expect(prompt).toContain('- @own.log -> /data/attachments/s1/own.log');
    // The parent's file resolves under the PARENT's task id, not the step's.
    expect(prompt).toContain('- @mockup.png -> /data/attachments/t1/mockup.png');
    expect(prompt).toContain('do not copy them into it');
    // Straight after the brief that cites it, before the plan listing.
    expect(prompt.indexOf('Lay the toolbar out')).toBeLessThan(prompt.indexOf('@mockup.png'));
    expect(prompt.indexOf('@mockup.png')).toBeLessThan(prompt.indexOf('for orientation only'));
    expect(prompt).not.toContain('\n\n\n');
  });

  it('omits a step’s legend when neither it nor its card carries a file', () => {
    const prompt = buildAgentSubtaskPrompt('Checkout service', jiraTask, step, stepBase);
    expect(prompt).not.toContain('Files attached');
    expect(prompt).not.toContain('\n\n\n');
  });
});

/**
 * The history cap (token audit, S1). Notes and the ticket thread are the two blocks of a
 * brief that grow without limit and are re-read on every launch — a chain averages 8.6
 * steps, so a card's history is re-paid once per step.
 *
 * What is checked here is the honesty of the cap rather than its arithmetic (that is
 * `promptHistory.test.ts`): the entries that survive are the newest, and the brief SAYS the
 * older ones are gone. Silently handing an agent half a thread it then treats as the whole
 * thread is the failure mode the whole change exists to avoid.
 */
describe('the notes and comments cap', () => {
  /** `n` notes of ~`size` chars each, numbered so which ones survived is checkable. */
  const notes = (n: number, size: number): string[] =>
    Array.from({ length: n }, (_, i) => `note-${i} `.padEnd(size, 'x'));

  const stepBase = { stepNumber: 1, stepCount: 2, stepTitles: ['Do it', 'Test it'] };

  it('drops the OLDEST notes and keeps the newest, which are about this run', () => {
    const many = notes(20, NOTES_CHAR_BUDGET / 4);
    const prompt = buildAgentTaskPrompt('Checkout service', jiraTask, { notes: many });
    expect(prompt).toContain(`- ${many[19]}`);
    expect(prompt).toContain(`- ${many[18]}`);
    expect(prompt).not.toContain('- note-0 ');
    expect(prompt).not.toContain('- note-9 ');
  });

  it('says how many notes it dropped, and that they can be asked for', () => {
    const prompt = buildAgentTaskPrompt('Checkout service', jiraTask, {
      notes: notes(20, NOTES_CHAR_BUDGET / 4),
    });
    expect(prompt).toContain('_(16 earlier notes omitted — ask if you need them.)_');
    // Under the heading, because the kept entries render oldest-first.
    expect(prompt.indexOf('Notes from the human')).toBeLessThan(prompt.indexOf('earlier notes'));
    expect(prompt.indexOf('earlier notes')).toBeLessThan(prompt.indexOf('- note-19'));
  });

  it('bounds the ticket thread the same way, and says so', () => {
    // Rendered as `Ada: <body>`, so a quarter of the budget is the body minus that prefix —
    // the cap measures the line the prompt writes, not the body alone.
    const thread = Array.from({ length: 20 }, (_, i) => ({
      author: 'Ada',
      body: `c${i} `.padEnd(TICKET_COMMENT_CHAR_BUDGET / 4 - 'Ada: '.length, 'x'),
    }));
    const prompt = buildAgentTaskPrompt('Checkout service', jiraTask, { comments: thread });
    expect(prompt).toContain(`- Ada: ${thread[19]!.body}`);
    expect(prompt).not.toContain('- Ada: c0 ');
    expect(prompt).toContain('_(16 earlier comments omitted — ask if you need them.)_');
  });

  it('says nothing about omissions when nothing was dropped', () => {
    const prompt = buildAgentTaskPrompt('Checkout service', jiraTask, {
      notes: ['Start with the file-picker path.'],
      comments: [{ author: 'Ada', body: 'Only on Windows.' }],
    });
    expect(prompt).not.toContain('omitted');
    expect(prompt).not.toContain('\n\n\n');
  });

  it('adds what the CALLER already dropped to what it drops itself', () => {
    // The scheduler bounds at source so it is not hauling a 70 KB thread around; the count
    // has to survive that trip or the total the agent is told is a lie.
    const prompt = buildAgentTaskPrompt('Checkout service', jiraTask, {
      notes: notes(20, NOTES_CHAR_BUDGET / 4),
      notesOmitted: 80,
      comments: [{ author: 'Ada', body: 'Only on Windows.' }],
      commentsOmitted: 7,
    });
    expect(prompt).toContain('_(96 earlier notes omitted');
    expect(prompt).toContain('_(7 earlier comments omitted');
  });

  it('still renders the block when the caller kept nothing but dropped something', () => {
    const prompt = buildAgentTaskPrompt('Checkout service', jiraTask, {
      notes: [],
      notesOmitted: 3,
    });
    expect(prompt).toContain('Notes from the human who assigned this');
    expect(prompt).toContain('_(3 earlier notes omitted');
    expect(prompt).not.toContain('\n\n\n');
  });

  it('caps a step’s copy of the parent card’s notes too — every step re-pays them', () => {
    const many = notes(20, NOTES_CHAR_BUDGET / 4);
    const prompt = buildAgentSubtaskPrompt('Checkout service', jiraTask, internalTask, {
      ...stepBase,
      notes: many,
      notesOmitted: 5,
    });
    expect(prompt).toContain(`- ${many[19]}`);
    expect(prompt).not.toContain('- note-0 ');
    expect(prompt).toContain('_(21 earlier notes omitted — ask if you need them.)_');
    expect(prompt).not.toContain('\n\n\n');
  });
});

/**
 * What a plan may contain. Every heading becomes a step, and every step becomes its own
 * agent session in the card's worktree — so a plan written as a document gets executed as
 * if its table of contents were a work breakdown.
 *
 * One real card's plan opened with "Shape of the design", "Verified facts this rests on" and
 * "Sequencing" — three prose sections that each burned a full session restating the plan —
 * and closed with "Release", which spent seven minutes re-running the gates and then
 * correctly refused, because a step is on the feature branch and that is the one place a
 * release must not be cut from. Two seconds after the merge the orchestrator released it
 * properly, which is what should have happened alone.
 */
describe('the plan scope rules', () => {
  const planned = () => buildAgentTaskPrompt('Checkout service', jiraTask, { planMode: true });

  it('tells a planning run that merging and releasing are the tool’s, not a step’s', () => {
    const prompt = planned();
    expect(prompt).toMatch(/Merging or releasing/);
    expect(prompt).toMatch(/orchestrator merges this branch/);
    expect(prompt).toMatch(/Plan the work; the tool ships it/);
  });

  it('tells it that prose sections are not steps, while verification still is', () => {
    const prompt = planned();
    expect(prompt).toMatch(/Sections that are not work/);
    expect(prompt).toMatch(/Verification IS work and does belong/);
  });

  it('says none of it to an ordinary run — only a planning turn writes steps', () => {
    const prompt = buildAgentTaskPrompt('Checkout service', jiraTask, { branch: 'orch/abc' });
    expect(prompt).not.toMatch(/Merging or releasing/);
    expect(prompt).not.toMatch(/Sections that are not work/);
    expect(prompt).not.toContain('\n\n\n');
  });

  it('repeats the rules for a re-plan, where finished work most invites a release step', () => {
    const prompt = buildReplanPrompt('Fix the export dialog', ['Add the guard'], {
      slotsLeft: 3,
    });
    expect(prompt).toMatch(/Merging or releasing/);
    expect(prompt).toMatch(/Sections that are not work/);
    expect(prompt).not.toContain('\n\n\n');
  });
});
