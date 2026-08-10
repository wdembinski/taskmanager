import { describe, expect, it } from 'vitest';
import { restingStatus } from '@shared/board';
import { PERSONAL_PROJECT_ID, type Task } from '@shared/model';
import type { LinkGate, TaskLink } from '@shared/taskChain';
import { guardCardStatus, humanStatusPatch } from './cardStatusGuard';
import { ChainRunner, type ChainRunnerDeps, type ChainTrigger } from './chainRunner';

const task = (over: Partial<Task> & { id: string }): Task => ({
  projectId: PERSONAL_PROJECT_ID,
  phase: '',
  title: over.id,
  status: 'pending',
  sessionId: null,
  order: 0,
  dependsOn: [],
  source: 'adhoc',
  isContract: false,
  isScaffold: false,
  ...over,
});

/** `a → b`: b runs after a. The id doubles as the pair, so a failure names the arrow. */
const link = (from: string, to: string, gate: LinkGate = 'after-merge'): TaskLink => ({
  id: `${from}->${to}`,
  fromTaskId: from,
  toTaskId: to,
  gate,
  createdAt: 0,
});

/**
 * A runner over a fake board. Everything it did is readable afterwards: which cards were
 * started, what was written on whose timeline, and what `landedAt` it stamped.
 *
 * Two details mirror the real engine rather than simplifying it, because the re-ask's
 * whole safety argument rests on them:
 *
 *  - `runTask` **reserves**. `Scheduler.startTask` adds the task to `inFlight` before it
 *    does anything else, so a second pass over the same card sees it as busy. A fake that
 *    only recorded the call would let "re-asking twice starts once" pass vacuously.
 *  - the usage limit can be **lifted** mid-test, which is the one moment step 3 is about.
 *  - `markInProgress` writes through the REAL `humanStatusPatch`, the same function the
 *    scheduler wires in, so a test can ask where the card actually ended up rather than
 *    only whether the runner meant to move it.
 */
function harness(
  tasks: Task[],
  links: TaskLink[],
  opts: { limit?: boolean; inFlight?: string[]; refuseRun?: boolean } = {},
) {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const started: string[] = [];
  const notes: Array<{ taskId: string; body: string }> = [];
  let limit = opts.limit ?? false;
  const reserved = new Set<string>(opts.inFlight ?? []);
  const deps: ChainRunnerDeps = {
    links: () => links,
    getTask: (id) => byId.get(id),
    setLandedAt: (id, at) => {
      const t = byId.get(id);
      if (t) t.landedAt = at;
    },
    addComment: (_projectId, taskId, body) => notes.push({ taskId, body }),
    runTask: (id) => {
      if (opts.refuseRun) return false;
      started.push(id);
      reserved.add(id);
      return true;
    },
    markInProgress: (id) => {
      const t = byId.get(id);
      if (!t) return;
      Object.assign(t, humanStatusPatch(t, 'in-progress'));
    },
    limitActive: () => limit,
    inFlight: (id) => reserved.has(id),
    branchOf: (t) => t.agentBranch || `orch/${t.id}`,
    now: () => 1_000,
  };
  return {
    runner: new ChainRunner(deps),
    byId,
    started,
    notes,
    setLimit: (on: boolean) => {
      limit = on;
    },
    /**
     * What the engine does a moment after `runTask`: the CLI reports `started`, and the run
     * borrows `status` through `guardCardStatus`. The gap between the two writes is where
     * this step's whole ordering argument lives, so a test that asks where a card rests has
     * to cross it rather than assume it.
     */
    runStarts: (id: string) => {
      const t = byId.get(id);
      if (t) Object.assign(t, guardCardStatus(t, { status: 'running' }));
    },
    /** And the moment it settles: the guard hands the borrowed field back. */
    runSettles: (id: string) => {
      const t = byId.get(id);
      if (t) Object.assign(t, guardCardStatus(t, { status: 'done' }));
    },
  };
}

/** The shape a chained successor has to be in for the engine to start it by itself. */
const successor = (id: string): Task => task({ id, status: 'pending', agentProjectId: 'agent-1' });

describe('ChainRunner — a card lands', () => {
  it('stamps landedAt and starts the card chained behind it', () => {
    const { runner, byId, started, notes } = harness(
      [task({ id: 'a' }), successor('b')],
      [link('a', 'b')],
    );
    runner.landed('a');
    expect(byId.get('a')?.landedAt).toBe(1_000);
    expect(started).toEqual(['b']);
    expect(notes[0].taskId).toBe('b');
    expect(notes[0].body).toContain('Started automatically');
    expect(notes[0].body).toContain('a');
  });

  it('names the ticket rather than the title when the card has a key', () => {
    const { runner, notes } = harness(
      [task({ id: 'a', title: 'Rework the parser', externalKey: 'VIP-3' }), successor('b')],
      [link('a', 'b')],
    );
    runner.landed('a');
    expect(notes[0].body).toContain('VIP-3');
  });

  it('is idempotent: a second landing neither restamps nor re-releases', () => {
    const { runner, byId, started, notes } = harness(
      [task({ id: 'a' }), successor('b')],
      [link('a', 'b')],
    );
    runner.landed('a');
    // The GitLab sync repeats "merged" on every poll for as long as the MR is retained.
    byId.get('b')!.sessionId = 'session-1';
    runner.landed('a');
    expect(started).toEqual(['b']);
    expect(notes).toHaveLength(1);
  });

  it('waits for every arm of a diamond — an AND-join, not a race', () => {
    const { runner, started } = harness(
      [task({ id: 'a' }), task({ id: 'b' }), successor('d')],
      [link('a', 'd'), link('b', 'd')],
    );
    runner.landed('a');
    expect(started).toEqual([]);
    runner.landed('b');
    expect(started).toEqual(['d']);
  });

  it('releases nothing from a card the human stopped', () => {
    const { runner, started, notes } = harness(
      [task({ id: 'a', status: 'stopped' }), successor('b')],
      [link('a', 'b')],
    );
    runner.landed('a');
    expect(started).toEqual([]);
    expect(notes).toEqual([]);
  });

  it('holds the release while a usage limit holds all scheduling', () => {
    const { runner, byId, started } = harness(
      [task({ id: 'a' }), successor('b')],
      [link('a', 'b')],
      { limit: true },
    );
    runner.landed('a');
    // The LANDING is still recorded — it is a fact about the world, and it is what lets
    // the re-ask made when the limit lifts pick this release up.
    expect(byId.get('a')?.landedAt).toBe(1_000);
    expect(started).toEqual([]);
  });

  it('never starts a card the human is already running', () => {
    const { runner, started } = harness([task({ id: 'a' }), successor('b')], [link('a', 'b')], {
      inFlight: ['b'],
    });
    runner.landed('a');
    expect(started).toEqual([]);
  });

  it('says a card is ready but leaves it alone when no agent is assigned', () => {
    const { runner, started, notes } = harness(
      [task({ id: 'a' }), task({ id: 'b' })],
      [link('a', 'b')],
    );
    runner.landed('a');
    expect(started).toEqual([]);
    expect(notes[0].body).toContain('Ready to start');
    expect(notes[0].body).toContain('no agent assigned');
  });

  it('leaves a card the human has moved on from where it is', () => {
    const { runner, started, notes } = harness(
      [task({ id: 'a' }), task({ id: 'b', status: 'blocked', agentProjectId: 'agent-1' })],
      [link('a', 'b')],
    );
    runner.landed('a');
    expect(started).toEqual([]);
    expect(notes[0].body).toContain('Ready to start');
  });
});

describe('ChainRunner — a successor that has run before', () => {
  it('starts a card that has only been planned — a session is not the work', () => {
    // The reported stall. `b` was assigned in plan mode and planned, so it has a session
    // and a plan and has changed nothing; every reason it was chained behind `a` still
    // stands, and refusing it left the chain dead with no note anywhere saying why.
    const { runner, started, notes } = harness(
      [task({ id: 'a' }), { ...successor('b'), sessionId: 'session-1', agentPlan: '## Plan' }],
      [link('a', 'b')],
    );
    runner.landed('a');
    expect(started).toEqual(['b']);
    expect(notes[0].body).toContain('Started automatically');
  });

  it('starts a card the human had begun by hand', () => {
    const { runner, started } = harness(
      [task({ id: 'a' }), { ...successor('b'), status: 'in-progress', sessionId: 'session-1' }],
      [link('a', 'b')],
    );
    runner.landed('a');
    expect(started).toEqual(['b']);
  });

  it('leaves a card whose own work has already landed, and says so', () => {
    const { runner, started, notes } = harness(
      [task({ id: 'a' }), { ...successor('b'), sessionId: 'session-1', landedAt: 7 }],
      [link('a', 'b')],
    );
    runner.landed('a');
    expect(started).toEqual([]);
    expect(notes[0].body).toContain('Not started');
    expect(notes[0].body).toContain('already landed');
  });

  it.each([['in-review'], ['done']] as const)(
    'leaves a card resting in %s — its work is finished with',
    (resting) => {
      const { runner, started, notes } = harness(
        [task({ id: 'a' }), { ...successor('b'), status: resting, sessionId: 'session-1' }],
        [link('a', 'b')],
      );
      runner.landed('a');
      expect(started).toEqual([]);
      expect(notes[0].body).toContain('Not started');
      expect(notes[0].body).toContain(resting);
    },
  );

  it('refuses a card parked in Blocked WITH a note, and starts it once it moves back', () => {
    // The whole of the rule that the release is not idempotent, only the landing is: the
    // GitLab poll repeats "merged" for as long as the MR is retained, and between two of
    // those passes the human answered the note by dragging the card back to TO DO.
    const { runner, byId, started, notes } = harness(
      [task({ id: 'a' }), { ...successor('b'), status: 'blocked' }],
      [link('a', 'b')],
    );
    runner.landed('a');
    expect(started).toEqual([]);
    expect(notes).toHaveLength(1);
    expect(notes[0].body).toContain('Ready to start');
    expect(notes[0].body).toContain('blocked');

    // The poll repeating itself changes nothing and, above all, says nothing twice.
    runner.landed('a');
    expect(started).toEqual([]);
    expect(notes).toHaveLength(1);

    byId.get('b')!.status = 'pending';
    runner.landed('a');
    expect(started).toEqual(['b']);
    expect(notes[1].body).toContain('Started automatically');
  });

  it('does not start the same card twice however often the landing is repeated', () => {
    const { runner, started, notes } = harness(
      [task({ id: 'a' }), successor('b')],
      [link('a', 'b')],
    );
    runner.landed('a');
    runner.landed('a');
    runner.landed('a');
    expect(started).toEqual(['b']);
    expect(notes).toHaveLength(1);
  });

  it('names the reason when a card is already running', () => {
    const { runner, started, notes } = harness(
      [task({ id: 'a' }), successor('b')],
      [link('a', 'b')],
      {
        inFlight: ['b'],
      },
    );
    runner.landed('a');
    expect(started).toEqual([]);
    expect(notes[0].body).toContain('already has a run under way');
  });

  it('names the reason when the engine itself refuses the run', () => {
    const { runner, started, notes } = harness(
      [task({ id: 'a' }), successor('b')],
      [link('a', 'b')],
      {
        refuseRun: true,
      },
    );
    runner.landed('a');
    expect(started).toEqual([]);
    expect(notes[0].body).toContain('Not started');
    expect(notes[0].body).toContain('engine refused');
  });

  it('re-asks the chain and starts a planned card the app was restarted around', () => {
    const { runner, started } = harness(
      [task({ id: 'a', landedAt: 5 }), { ...successor('b'), sessionId: 'session-1' }],
      [link('a', 'b')],
    );
    runner.reconsider('boot');
    expect(started).toEqual(['b']);
  });
});

describe('ChainRunner — a card finishes writing (the `stacked` gate)', () => {
  it('starts a stacked successor before anything is merged', () => {
    const { runner, started, notes } = harness(
      [task({ id: 'a', status: 'running' }), successor('b')],
      [link('a', 'b', 'stacked')],
    );
    runner.workWritten('a');
    expect(started).toEqual(['b']);
    // The catch the loose gate buys, said where the person reading card B will see it.
    expect(notes[0].body).toContain('orch/a');
    expect(notes[0].body).toContain('merge');
  });

  it('leaves an after-merge successor waiting for the merge', () => {
    const { runner, started, notes } = harness(
      [task({ id: 'a', status: 'running' }), successor('b')],
      [link('a', 'b')],
    );
    runner.workWritten('a');
    expect(started).toEqual([]);
    expect(notes).toEqual([]);
  });

  it('still waits for the other arm of a diamond', () => {
    const { runner, started } = harness(
      [task({ id: 'a', status: 'running' }), task({ id: 'b' }), successor('d')],
      [link('a', 'd', 'stacked'), link('b', 'd')],
    );
    runner.workWritten('a');
    expect(started).toEqual([]);
  });

  it('does not re-announce when the predecessor runs a second time', () => {
    const { runner, byId, started, notes } = harness(
      [task({ id: 'a', status: 'running' }), successor('b')],
      [link('a', 'b', 'stacked')],
    );
    runner.workWritten('a');
    byId.get('b')!.sessionId = 'session-1';
    runner.workWritten('a');
    expect(started).toEqual(['b']);
    expect(notes).toHaveLength(1);
  });

  it('gives a stacked card that could not start then a second chance when it lands', () => {
    // No agent when the work was written, one by the time it merged.
    const { runner, byId, started } = harness(
      [task({ id: 'a', status: 'running' }), task({ id: 'b' })],
      [link('a', 'b', 'stacked')],
    );
    runner.workWritten('a');
    expect(started).toEqual([]);
    byId.get('b')!.agentProjectId = 'agent-1';
    runner.landed('a');
    expect(started).toEqual(['b']);
  });
});

describe('ChainRunner — the start point for a stacked card', () => {
  it('cuts the successor from the predecessor’s branch', () => {
    const { runner, byId } = harness(
      [
        task({ id: 'a', agentProjectId: 'agent-1', agentBranch: 'feat/parser' }),
        task({ id: 'b', agentProjectId: 'agent-1' }),
      ],
      [link('a', 'b', 'stacked')],
    );
    expect(runner.startPointFor(byId.get('b')!)).toBe('feat/parser');
  });

  it('answers nothing for an after-merge link — that one starts from base', () => {
    const { runner, byId } = harness(
      [
        task({ id: 'a', agentProjectId: 'agent-1', agentBranch: 'feat/parser' }),
        task({ id: 'b', agentProjectId: 'agent-1' }),
      ],
      [link('a', 'b')],
    );
    expect(runner.startPointFor(byId.get('b')!)).toBeUndefined();
  });

  it('answers nothing when the two cards run in different repos', () => {
    const { runner, byId } = harness(
      [
        task({ id: 'a', agentProjectId: 'agent-1', agentBranch: 'feat/parser' }),
        task({ id: 'b', agentProjectId: 'agent-2' }),
      ],
      [link('a', 'b', 'stacked')],
    );
    expect(runner.startPointFor(byId.get('b')!)).toBeUndefined();
  });

  it('answers nothing for a step — it works in its parent’s worktree', () => {
    const step = task({ id: 'b', parentTaskId: 'card', agentProjectId: 'agent-1' });
    const { runner } = harness(
      [task({ id: 'a', agentProjectId: 'agent-1' }), step],
      [link('a', 'b', 'stacked')],
    );
    expect(runner.startPointFor(step)).toBeUndefined();
  });
});

describe('ChainRunner — restart recovery', () => {
  it('starts a card whose predecessor landed while the app was closed', () => {
    const { runner, started, notes } = harness(
      [task({ id: 'a', landedAt: 5 }), successor('b')],
      [link('a', 'b')],
    );
    runner.reconsider('boot');
    expect(started).toEqual(['b']);
    expect(notes[0].body).toContain('startup');
  });

  it('leaves a card whose own work has landed — the release plainly happened', () => {
    const { runner, started } = harness(
      [task({ id: 'a', landedAt: 5 }), task({ ...successor('b'), landedAt: 6 })],
      [link('a', 'b')],
    );
    runner.reconsider('boot');
    expect(started).toEqual([]);
  });

  it('leaves a card still waiting on something', () => {
    const { runner, started } = harness([task({ id: 'a' }), successor('b')], [link('a', 'b')]);
    runner.reconsider('boot');
    expect(started).toEqual([]);
  });

  it('does nothing at all while a usage limit is in force', () => {
    const { runner, started } = harness(
      [task({ id: 'a', landedAt: 5 }), successor('b')],
      [link('a', 'b')],
      { limit: true },
    );
    runner.reconsider('boot');
    expect(started).toEqual([]);
  });
});

describe('ChainRunner — re-asking the chain', () => {
  /** A card whose only predecessor landed: releasable the moment anybody asks. */
  const overdue = () => harness([task({ id: 'a', landedAt: 5 }), successor('b')], [link('a', 'b')]);

  it('starts the card once and notes it once, however often it is asked', () => {
    const { runner, started, notes } = overdue();
    runner.reconsider('links-changed');
    runner.reconsider('links-changed');
    runner.reconsider('card-changed');
    // The reservation `runTask` made on the first pass is what refuses the rest — no
    // bookkeeping in the runner, and so nothing that can drift out of step with the board.
    expect(started).toEqual(['b']);
    expect(notes).toHaveLength(1);
  });

  it('never re-runs a card whose work is finished with', () => {
    // A session alone no longer counts — the card has to have gone somewhere with it. Here
    // the human filed it under IN REVIEW, which is as plain a "leave this one" as there is.
    const { runner, started, notes } = harness(
      [
        task({ id: 'a', landedAt: 5 }),
        task({ ...successor('b'), status: 'in-review', sessionId: 'session-1' }),
      ],
      [link('a', 'b')],
    );
    runner.reconsider('card-changed');
    expect(started).toEqual([]);
    expect(notes).toEqual([]);
  });

  it('is still an AND-join: a diamond waits for both arms', () => {
    const { runner, byId, started } = harness(
      [task({ id: 'a', landedAt: 5 }), task({ id: 'b' }), successor('d')],
      [link('a', 'd'), link('b', 'd')],
    );
    runner.reconsider('links-changed');
    expect(started).toEqual([]);
    byId.get('b')!.landedAt = 6;
    runner.reconsider('links-changed');
    expect(started).toEqual(['d']);
  });

  it('does nothing while a limit is live, and everything once it lifts', () => {
    const { runner, started, setLimit } = harness(
      [task({ id: 'a', landedAt: 5 }), successor('b')],
      [link('a', 'b')],
      { limit: true },
    );
    runner.reconsider('limit-lifted');
    expect(started).toEqual([]);
    setLimit(false);
    runner.reconsider('limit-lifted');
    expect(started).toEqual(['b']);
  });

  it('releases a card the moment an arrow is drawn from a landed predecessor', () => {
    // The arrow arrives ALREADY satisfied, which is the ordinary way a chain is built after
    // the fact. Nothing about either card changes, so the drawing is the only event there is.
    const links: TaskLink[] = [];
    const { runner, started } = harness([task({ id: 'a', landedAt: 5 }), successor('b')], links);
    runner.reconsider('links-changed');
    expect(started).toEqual([]);
    links.push(link('a', 'b'));
    runner.reconsider('links-changed');
    expect(started).toEqual(['b']);
  });

  it('releases when a gate is loosened from after-merge to stacked', () => {
    // `a` wrote its work hours ago and simply has not merged. Loosening the gate is the
    // whole of what `b` was waiting for — and it is a change to the LINK, so no card-level
    // event will ever mention it.
    const links = [link('a', 'b')];
    const { runner, started } = harness(
      [
        task({ id: 'a', status: 'in-review', sessionId: 'session-1', agentBranch: 'feat/a' }),
        successor('b'),
      ],
      links,
    );
    runner.reconsider('links-changed');
    expect(started).toEqual([]);
    // Mutated in place, exactly as `store.setTaskLinkGate` re-reads it: same link id, new gate.
    links[0].gate = 'stacked';
    runner.reconsider('links-changed');
    expect(started).toEqual(['b']);
  });

  it('starts a released card the human has put back in To Do', () => {
    // The reported gap, end to end. `b` was Blocked when `a` landed, so the chain could only
    // file "Ready to start … start it whenever you like" and leave it there. Dragging it to
    // To Do is the human answering that note — and it is the LAST such moment there is,
    // because the landing has already happened and will never be announced again.
    const { runner, byId, started, notes } = harness(
      [task({ id: 'a' }), task({ id: 'b', status: 'blocked', agentProjectId: 'agent-1' })],
      [link('a', 'b')],
    );
    runner.landed('a');
    expect(started).toEqual([]);
    expect(notes[0].body).toContain('Ready to start');

    byId.get('b')!.status = 'pending';
    runner.reconsider('card-changed');
    expect(started).toEqual(['b']);
    // A SECOND note: `announced` guards the release's own note about a non-event, and must
    // not silence this one — the card has not had a note saying it started.
    expect(notes).toHaveLength(2);
    expect(notes[1].body).toContain('To Do');
  });

  it('names the cause on the timeline — each trigger its own sentence', () => {
    const triggers: ChainTrigger[] = ['boot', 'limit-lifted', 'links-changed', 'card-changed'];
    const said = triggers.map((trigger) => {
      const { runner, notes } = overdue();
      runner.reconsider(trigger);
      return notes[0].body;
    });
    // "Started automatically" with no subject is what sends a human hunting; every one of
    // these has to say what did it, and no two may say the same thing.
    expect(new Set(said).size).toBe(triggers.length);
    expect(said[0]).toContain('startup');
    expect(said[1]).toContain('usage limit');
    expect(said[2]).toContain('chain changed');
    expect(said[3]).toContain('To Do');
  });
});

describe('ChainRunner — what a pending merge is holding', () => {
  it('names the cards chained behind an unmerged branch', () => {
    const { runner } = harness(
      [task({ id: 'a' }), successor('b'), successor('c')],
      [link('a', 'b'), link('a', 'c')],
    );
    expect(runner.heldByMerge('a')).toEqual(['b', 'c']);
  });

  it('holds nothing once the branch has landed', () => {
    const { runner } = harness([task({ id: 'a', landedAt: 5 }), successor('b')], [link('a', 'b')]);
    expect(runner.heldByMerge('a')).toEqual([]);
  });

  it('ignores a stacked successor — the merge is not what it waits for', () => {
    const { runner } = harness([task({ id: 'a' }), successor('b')], [link('a', 'b', 'stacked')]);
    expect(runner.heldByMerge('a')).toEqual([]);
  });

  it('ignores a successor whose work is finished with, or that is running now', () => {
    const { runner } = harness(
      [
        task({ id: 'a' }),
        task({ ...successor('b'), status: 'done', sessionId: 'session-1' }),
        successor('c'),
      ],
      [link('a', 'b'), link('a', 'c')],
      { inFlight: ['c'] },
    );
    expect(runner.heldByMerge('a')).toEqual([]);
  });

  it('still names a successor that has only been planned — the merge is what it waits for', () => {
    const { runner } = harness(
      [task({ id: 'a' }), task({ ...successor('b'), sessionId: 'session-1' })],
      [link('a', 'b')],
    );
    expect(runner.heldByMerge('a')).toEqual(['b']);
  });

  it('names the ticket rather than the title when the card has a key', () => {
    const { runner } = harness(
      [task({ id: 'a' }), { ...successor('b'), title: 'Rework the parser', externalKey: 'VIP-3' }],
      [link('a', 'b')],
    );
    expect(runner.heldByMerge('a')).toEqual(['VIP-3 — Rework the parser']);
  });
});

describe('ChainRunner — Release now (the human override)', () => {
  it('starts a blocked card and records that it went ahead of its chain', () => {
    const { runner, started, notes } = harness(
      [task({ id: 'a', title: 'Rework the parser' }), successor('b')],
      [link('a', 'b')],
    );
    expect(runner.releaseNow('b')).toBeNull();
    expect(started).toEqual(['b']);
    expect(notes[0].body).toContain('Released by hand');
    expect(notes[0].body).toContain('Rework the parser');
  });

  it('refuses a card with no agent, and says why', () => {
    const { runner, started } = harness([task({ id: 'a' }), task({ id: 'b' })], [link('a', 'b')]);
    expect(runner.releaseNow('b')).toContain('not assigned');
    expect(started).toEqual([]);
  });

  it('refuses while a usage limit is in force', () => {
    const { runner } = harness([task({ id: 'a' }), successor('b')], [link('a', 'b')], {
      limit: true,
    });
    expect(runner.releaseNow('b')).toContain('usage limit');
  });

  it('refuses a card that is already running', () => {
    const { runner } = harness([task({ id: 'a' }), successor('b')], [link('a', 'b')], {
      inFlight: ['b'],
    });
    expect(runner.releaseNow('b')).toContain('already running');
  });

  it('reports the engine’s own refusal rather than claiming it started', () => {
    const { runner, notes } = harness([task({ id: 'a' }), successor('b')], [link('a', 'b')], {
      refuseRun: true,
    });
    expect(runner.releaseNow('b')).toContain('could not start');
    expect(notes).toEqual([]);
  });
});

describe('ChainRunner — an automatic start moves the card', () => {
  it('lands a released successor in In Progress, and leaves it there when the run settles', () => {
    const { runner, byId, notes, runStarts, runSettles } = harness(
      [task({ id: 'a' }), successor('b')],
      [link('a', 'b')],
    );
    runner.landed('a');
    // Written before the run borrows `status`, so it is a plain column move, not a parked one.
    expect(byId.get('b')?.status).toBe('in-progress');
    expect(byId.get('b')?.preRunStatus).toBeUndefined();
    expect(notes[0].body).toContain('In Progress');

    // The CLI reports `started` a moment later and the run takes the field over — parking
    // the column this just wrote, which is the whole reason the order matters.
    runStarts('b');
    expect(byId.get('b')?.status).toBe('running');
    expect(restingStatus(byId.get('b')!)).toBe('in-progress');

    runSettles('b');
    expect(byId.get('b')?.status).toBe('in-progress');
  });

  it('moves a card a re-ask started, whatever re-asked', () => {
    const { runner, byId, notes } = harness(
      [task({ id: 'a', landedAt: 5 }), successor('b')],
      [link('a', 'b')],
    );
    runner.reconsider('boot');
    expect(byId.get('b')?.status).toBe('in-progress');
    expect(notes[0].body).toContain('startup');
    expect(notes[0].body).toContain('In Progress');
  });

  it('leaves the card where the human put it when they pressed Release now', () => {
    // Somebody is looking at the board and chose that column a second ago. The whole point
    // of the automatic move is that nobody was there — here they are.
    const { runner, byId, started } = harness(
      [task({ id: 'a' }), task({ id: 'b', status: 'blocked', agentProjectId: 'agent-1' })],
      [link('a', 'b')],
    );
    expect(runner.releaseNow('b')).toBeNull();
    expect(started).toEqual(['b']);
    expect(byId.get('b')?.status).toBe('blocked');
  });

  it('moves nothing for a card the release declined', () => {
    const { runner, byId, started } = harness(
      [task({ id: 'a' }), task({ id: 'b', status: 'blocked', agentProjectId: 'agent-1' })],
      [link('a', 'b')],
    );
    runner.landed('a');
    expect(started).toEqual([]);
    expect(byId.get('b')?.status).toBe('blocked');
  });

  it('leaves a successor already resting in In Progress exactly as it was', () => {
    const { runner, byId, started } = harness(
      [task({ id: 'a' }), task({ ...successor('b'), status: 'in-progress' })],
      [link('a', 'b')],
    );
    runner.landed('a');
    expect(started).toEqual(['b']);
    expect(byId.get('b')?.status).toBe('in-progress');
    expect(byId.get('b')?.preRunStatus).toBeUndefined();
  });
});
