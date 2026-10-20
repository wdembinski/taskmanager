/**
 * `createAiVisualReviewer` against fake deps: the timeline is a plain array every note and
 * sign-off lands on, and the session is a handle the test answers by hand — so each case
 * proves what the reviewer does with a verdict, not what a real CLI happens to say.
 */
import { describe, expect, it } from 'vitest';
import type { TaskAttachment } from '@shared/attachments';
import {
  AI_REVIEW_GAVE_UP_PREFIX,
  AI_REVIEW_INVALID_PREFIX,
  AI_REVIEW_NEEDS_CHANGES_PREFIX,
  AI_REVIEW_STARTED_PREFIX,
} from '@shared/aiVisualReview';
import type { Project, Task, TaskActivityEntry } from '@shared/model';
import type { StartSessionRequest } from '@shared/session';
import { formatSignOff, formatVisualSignOffComment } from '@shared/visualSignOff';
import { createAiVisualReviewer, type AiVisualReviewerDeps } from './aiVisualReviewer';

const OWNER = 'owner-1';
const PROJECT = 'agent-1';

function attachment(name: string): TaskAttachment {
  return {
    id: `att-${name}`,
    taskId: OWNER,
    name,
    fileName: name,
    mimeType: 'image/png',
    size: 0,
    createdAt: 0,
  };
}

function verdictBlock(
  verdict: 'approve' | 'needs-changes',
  screens: Array<{ screen: string; status: 'ok' | 'mismatch'; reason?: string }>,
): string {
  return `Looked at both.\n\n\`\`\`json\n${JSON.stringify({ verdict, screens, outOfScope: [] })}\n\`\`\``;
}

interface Session {
  projectId: string;
  request: StartSessionRequest;
  runId: string;
  respond(text: string): Promise<void>;
  exit(): void;
}

function harness(opts: { enabled?: boolean; maxRounds?: number } = {}) {
  let clock = 1_000;
  const activity: TaskActivityEntry[] = [];
  const comment = (body: string) => {
    clock += 1;
    activity.push({ kind: 'comment', id: activity.length + 1, body, createdAt: clock });
  };
  comment(formatVisualSignOffComment([{ screen: 'board-light', status: 'ok', note: '' }], 'Build'));

  const project = {
    id: PROJECT,
    path: 'C:/repo',
    target: { kind: 'local' },
    defaultModel: 'sonnet',
    planningModel: 'opus',
    autoVisualSignOff: opts.enabled ?? true,
    autoVisualSignOffMaxRounds: opts.maxRounds ?? 2,
  } as unknown as Project;
  const owner = {
    id: OWNER,
    projectId: 'personal',
    title: 'Add the merge switch',
    description: 'local text',
    externalDescription: 'Show a switch on the board.',
    agentBranch: 'feat/x',
  } as unknown as Task;

  const sessions: Session[] = [];
  const stopped: string[] = [];
  const signOffs: string[] = [];
  const fixSteps: Array<{ title: string; description: string }> = [];
  const ran: string[] = [];
  const inbox: string[] = [];
  let pending: Promise<void> = Promise.resolve();

  const deps: AiVisualReviewerDeps = {
    getTask: (id) => (id === OWNER ? owner : undefined),
    getProject: (id) => (id === PROJECT ? project : undefined),
    listSubtasks: () => [{ title: 'Build the switch' } as Task],
    listAttachments: () => [attachment('board-light.png'), attachment('board-light-mockup.png')],
    listActivity: () => [...activity],
    attachmentPath: (_project, a) => `C:/attachments/${a.taskId}/${a.name}`,
    cwdFor: async () => 'C:/worktrees/owner-1',
    note: (_projectId, _taskId, body) => comment(body),
    now: () => clock + 1,
    startSession: (projectId, request, onResult, onExit) => {
      const runId = `run-${sessions.length + 1}`;
      sessions.push({
        projectId,
        request,
        runId,
        respond: async (text) => {
          onResult(text);
          await pending;
          onExit?.();
        },
        exit: () => onExit?.(),
      });
      return { runId };
    },
    stopRun: (runId) => {
      stopped.push(runId);
    },
    signOffApproved: async () => {
      comment(formatSignOff('approved', [], 'ai'));
      signOffs.push('ai');
    },
    addFixStep: (_ownerId, title, description) => {
      fixSteps.push({ title, description });
    },
    runCard: (ownerId) => {
      ran.push(ownerId);
    },
    raiseInbox: (_ownerId, question) => {
      inbox.push(question);
    },
  };
  const reviewer = createAiVisualReviewer(deps);
  return {
    reviewer,
    project,
    activity,
    comment,
    sessions,
    stopped,
    signOffs,
    fixSteps,
    ran,
    inbox,
    bodies: () => activity.map((e) => (e.kind === 'comment' ? e.body : '')),
    push: () => reviewer.onAwaitSignOff(PROJECT, OWNER),
    settle: (p: Promise<void>) => {
      pending = p;
    },
  };
}

/** Let the reviewer's fire-and-forget result handler finish. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('createAiVisualReviewer', () => {
  it('starts no session when the project setting is off', async () => {
    const h = harness({ enabled: false });
    await h.push();
    expect(h.sessions).toHaveLength(0);
    expect(h.bodies().some((b) => b.startsWith(AI_REVIEW_STARTED_PREFIX))).toBe(false);
  });

  it('starts a fresh, read-only plan-mode session with every shot as an absolute path', async () => {
    const h = harness();
    await h.push();
    expect(h.sessions).toHaveLength(1);
    const { request, projectId } = h.sessions[0];
    expect(projectId).toBe(PROJECT);
    expect(request.permissionMode).toBe('plan');
    expect(request.disallowedTools).toEqual(expect.arrayContaining(['Edit', 'Write', 'Bash']));
    expect(request.cwd).toBe('C:/worktrees/owner-1');
    expect(request.model).toBe('opus');
    // Fresh: nothing on the request names an earlier session to resume.
    expect(Object.keys(request)).not.toContain('resumeSessionId');
    expect(Object.keys(request)).not.toContain('sessionId');
    expect(request.prompt).toContain('C:/attachments/owner-1/board-light.png');
    expect(request.prompt).toContain('C:/attachments/owner-1/board-light-mockup.png');
    expect(request.prompt).toContain('Show a switch on the board.');
    expect(h.bodies()).toContain('AI visual review started (round 1 of 3).');
  });

  it('posts the AI sign-off on approve', async () => {
    const h = harness();
    await h.push();
    await h.sessions[0].respond(verdictBlock('approve', [{ screen: 'board-light', status: 'ok' }]));
    await flush();
    expect(h.signOffs).toEqual(['ai']);
    expect(h.bodies()).toContain(formatSignOff('approved', [], 'ai'));
    expect(h.fixSteps).toHaveLength(0);
    expect(h.inbox).toHaveLength(0);
    expect(h.reviewer.isReviewing(OWNER)).toBe(false);
  });

  it('adds and runs one fix step carrying the reasons on needs-changes', async () => {
    const h = harness();
    await h.push();
    await h.sessions[0].respond(
      verdictBlock('needs-changes', [
        { screen: 'board-light', status: 'mismatch', reason: 'the switch is clipped' },
      ]),
    );
    await flush();
    expect(h.fixSteps).toHaveLength(1);
    expect(h.fixSteps[0].title).toBe('Fix the visual review findings (round 1)');
    expect(h.fixSteps[0].description).toContain('- board-light: the switch is clipped');
    expect(h.fixSteps[0].description).toContain('node scripts/ui-shots.mjs --attach');
    expect(h.fixSteps[0].description).toContain('verdicts.txt');
    expect(h.ran).toEqual([OWNER]);
    expect(h.signOffs).toHaveLength(0);
    // A note, never a `Visual sign-off:` comment — the human gate stays pending.
    expect(
      h.bodies().some((b) => b.startsWith(`${AI_REVIEW_NEEDS_CHANGES_PREFIX} (round 1 of 2)`)),
    ).toBe(true);
    expect(h.bodies().some((b) => b.startsWith('Visual sign-off:'))).toBe(false);
  });

  it('gives up after the max rounds: the gave-up note, the Inbox once, and no re-raise', async () => {
    const h = harness({ maxRounds: 1 });
    const mismatch = verdictBlock('needs-changes', [
      { screen: 'board-light', status: 'mismatch', reason: 'still clipped' },
    ]);
    await h.push();
    await h.sessions[0].respond(mismatch);
    await flush();
    expect(h.fixSteps).toHaveLength(1);

    // The fix step's push: review 2 of 2 is the last one the setting allows.
    await h.push();
    expect(h.sessions).toHaveLength(2);
    await h.sessions[1].respond(mismatch);
    await flush();
    expect(h.fixSteps).toHaveLength(1);
    expect(h.bodies().some((b) => b.startsWith(`${AI_REVIEW_GAVE_UP_PREFIX} 2 rounds`))).toBe(true);
    expect(h.inbox).toHaveLength(1);
    expect(h.inbox[0]).toContain('could not approve after 2 rounds');

    // Another push: no session, and the Inbox is not raised again.
    await h.push();
    expect(h.sessions).toHaveLength(2);
    expect(h.inbox).toHaveLength(1);
  });

  it('gives up without reviewing when the rounds already exceed a lowered setting', async () => {
    const h = harness({ maxRounds: 0 });
    h.comment(`${AI_REVIEW_NEEDS_CHANGES_PREFIX} (round 1 of 2)`);
    await h.push();
    expect(h.sessions).toHaveLength(0);
    expect(h.bodies().some((b) => b.startsWith(AI_REVIEW_GAVE_UP_PREFIX))).toBe(true);
    expect(h.inbox).toHaveLength(1);
    await h.push();
    expect(h.inbox).toHaveLength(1);
  });

  it('stops the session on a human verdict mid-review and ignores its late result', async () => {
    const h = harness();
    await h.push();
    h.reviewer.cancel(OWNER);
    expect(h.stopped).toEqual(['run-1']);
    h.comment(formatSignOff('needs-changes', ['board-light']));
    await h.sessions[0].respond(verdictBlock('approve', [{ screen: 'board-light', status: 'ok' }]));
    await flush();
    expect(h.signOffs).toHaveLength(0);
    expect(h.fixSteps).toHaveLength(0);
    expect(h.inbox).toHaveLength(0);
  });

  it('discards a result when a sign-off landed after the review started, even uncancelled', async () => {
    const h = harness();
    await h.push();
    h.comment(formatSignOff('approved'));
    await h.sessions[0].respond(
      verdictBlock('needs-changes', [{ screen: 'board-light', status: 'mismatch', reason: 'x' }]),
    );
    await flush();
    expect(h.fixSteps).toHaveLength(0);
    expect(h.signOffs).toHaveLength(0);
  });

  it('starts no second session while one is running for the card', async () => {
    const h = harness();
    await Promise.all([h.push(), h.push()]);
    await h.push();
    expect(h.sessions).toHaveLength(1);
  });

  it('notes an unreadable verdict and raises the Inbox, counting no round', async () => {
    const h = harness();
    await h.push();
    await h.sessions[0].respond('I could not decide.');
    await flush();
    expect(h.bodies().some((b) => b.startsWith(AI_REVIEW_INVALID_PREFIX))).toBe(true);
    expect(h.inbox).toHaveLength(1);
    expect(h.fixSteps).toHaveLength(0);
  });

  it('treats a session that exits with no result as unreadable', async () => {
    const h = harness();
    await h.push();
    h.sessions[0].exit();
    expect(h.inbox).toHaveLength(1);
    expect(h.reviewer.isReviewing(OWNER)).toBe(false);
  });
});
