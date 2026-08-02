import { describe, expect, it } from 'vitest';
import { PERSONAL_PROJECT_ID, type Task } from '@shared/model';
import type { LinkGate, TaskLink } from '@shared/taskChain';
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

  it('leaves a card that has already run — the release plainly happened', () => {
    const { runner, started } = harness(
      [task({ id: 'a', landedAt: 5 }), task({ ...successor('b'), sessionId: 'session-1' })],
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

  it('never re-runs a card that has a session behind it', () => {
    const { runner, started, notes } = harness(
      [task({ id: 'a', landedAt: 5 }), task({ ...successor('b'), sessionId: 'session-1' })],
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
