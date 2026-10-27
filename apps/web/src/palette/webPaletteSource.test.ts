/**
 * `buildWebCommands`'s navigate/cards/projects/actions command list and `relayableCommands`'s
 * policy-driven filter: every command this module builds names only channels `RELAY_POLICY`
 * marks `'relay'` (the baseline the F9.10 mutation proof flips `task:create` against — see
 * CLAUDE-step notes), Scratch run has no way to appear at all (`Screen` has no `'scratch'`
 * member for `goTo` to target), and `relayableCommands` drops a command the instant any one of
 * its channels stops being relayable on whatever policy it is handed — a cloned, mutated copy
 * for a test, the real singleton by default. Since the v10 mockup (TM-458), also covers that a
 * card row's `prefix` is its tracker key (with no `subtitle` duplicating it) and that nav/action
 * rows carry an `icon`. Since F15.14b, also the review workspace's rows: each names
 * `review:queues`, and a policy that stops relaying it drops every one of them.
 */
import { describe, expect, it, vi } from 'vitest';
import { RELAY_POLICY } from '@tm/shared/ipcRelay';
import type { Project, Task } from '@tm/shared/model';
import { AddRegular, SignOutRegular } from '@fluentui/react-icons';
import { SHELL_NAV } from '@tm/ui/shell/shellNav';
import {
  buildWebCommands,
  relayableCommands,
  webPaletteSource,
  type WebPaletteActions,
} from './webPaletteSource';

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: 't1',
    projectId: 'p1',
    phase: '',
    title: 'Fix the thing',
    status: 'todo',
    sessionId: null,
    order: 0,
    dependsOn: [],
    source: 'adhoc',
    isContract: false,
    isScaffold: false,
    ...overrides,
  } as Task;
}

function project(overrides: Partial<Project> = {}): Project {
  return {
    id: 'p1',
    name: 'Alpha',
    path: '',
    planPath: '',
    ticketPrefix: '',
    color: '',
    ...overrides,
  } as Project;
}

function actions(): WebPaletteActions {
  return {
    goTo: () => {},
    openCard: () => {},
    addTask: () => {},
    signOut: () => {},
    openReviews: () => {},
    reviewAction: () => {},
  };
}

describe('buildWebCommands', () => {
  it('builds only channels RELAY_POLICY already marks relay', () => {
    const commands = buildWebCommands({ tasks: {}, projects: {} }, actions());
    for (const command of commands) {
      for (const channel of command.channels) {
        expect(RELAY_POLICY[channel]).toBe('relay');
      }
    }
  });

  it('never offers Scratch run — Screen has no member for goTo to target', () => {
    const commands = buildWebCommands({ tasks: {}, projects: {} }, actions());
    expect(commands.some((c) => c.title.toLowerCase().includes('scratch'))).toBe(false);
  });

  it('makes a card command per task, searchable by ticketKey and externalKey', () => {
    const tasks = {
      t1: task({ id: 't1', title: 'Fix the thing', ticketKey: 'TM-9' }),
      t2: task({ id: 't2', title: 'Ship the other thing', externalKey: 'ABC-1' }),
    };
    const commands = buildWebCommands({ tasks, projects: {} }, actions());
    const byId = (taskId: string) =>
      commands.find((c) => c.group === 'cards' && c.id === `card:${taskId}`);

    expect(byId('t1')?.keywords).toContain('TM-9');
    expect(byId('t2')?.keywords).toContain('ABC-1');
  });

  it("sets a card row's prefix to its tracker key, and carries no subtitle", () => {
    const tasks = {
      t1: task({ id: 't1', title: 'Fix the thing', ticketKey: 'TM-9', externalKey: 'ABC-1' }),
    };
    const commands = buildWebCommands({ tasks, projects: {} }, actions());
    const card = commands.find((c) => c.id === 'card:t1');
    expect(card?.prefix).toBe('TM-9');
    expect(card?.subtitle).toBeUndefined();
  });

  it("carries each nav row's own SHELL_NAV icon", () => {
    const commands = buildWebCommands({ tasks: {}, projects: {} }, actions());
    const mytasksIcon = SHELL_NAV.find((entry) => entry.id === 'mytasks')?.icon;
    expect(commands.find((c) => c.id === 'nav:mytasks')?.icon).toBe(mytasksIcon);
  });

  it('builds an Add task command that calls channels task:create and ticket:create, with an AddRegular icon', () => {
    const commands = buildWebCommands({ tasks: {}, projects: {} }, actions());
    const addTask = commands.find((c) => c.id === 'action:add-task');
    expect(addTask?.channels).toEqual(['task:create', 'ticket:create']);
    expect(addTask?.icon).toBe(AddRegular);
  });

  it('builds a Sign out command with a SignOutRegular icon', () => {
    const commands = buildWebCommands({ tasks: {}, projects: {} }, actions());
    expect(commands.find((c) => c.id === 'action:sign-out')?.icon).toBe(SignOutRegular);
  });
});

describe('the review workspace rows (F15.14b)', () => {
  it('offers exactly one Reviews navigate row, now SHELL_NAV carries a Reviews tile too', () => {
    expect(SHELL_NAV.some((entry) => entry.id === 'reviews')).toBe(true);
    const commands = buildWebCommands({ tasks: {}, projects: {} }, actions());
    const reviews = commands.filter((c) => c.group === 'navigate' && c.title === 'Reviews');
    expect(reviews.map((c) => c.id)).toEqual(['nav:reviews']);
    expect(reviews[0]?.channels).toEqual(['review:queues']);
    expect(new Set(commands.map((c) => c.id)).size).toBe(commands.length);
  });

  it('always offers Reviews, naming review:queues, which opens the workspace with no subject', () => {
    const openReviews = vi.fn();
    const commands = buildWebCommands({ tasks: {}, projects: {} }, { ...actions(), openReviews });
    const reviews = commands.find((c) => c.id === 'nav:reviews');
    expect(reviews?.group).toBe('navigate');
    expect(reviews?.channels).toEqual(['review:queues']);
    void reviews?.run();
    expect(openReviews).toHaveBeenCalledWith();
  });

  it('opens the selected card in the workspace by its task subject, named by its key', () => {
    const openReviews = vi.fn();
    const commands = buildWebCommands(
      { tasks: { t1: task({ ticketKey: 'TM-7' }) }, projects: {}, selectedTaskId: 't1' },
      { ...actions(), openReviews },
    );
    const open = commands.find((c) => c.id === 'review:openSelected');
    expect(open?.title).toBe('Open TM-7 in review workspace');
    void open?.run();
    expect(openReviews).toHaveBeenCalledWith('task:t1');
  });

  it('offers no "Open … in review workspace" with no card open, or one this tab has no row for', () => {
    const none = buildWebCommands({ tasks: { t1: task() }, projects: {} }, actions());
    expect(none.some((c) => c.id === 'review:openSelected')).toBe(false);
    const gone = buildWebCommands({ tasks: {}, projects: {}, selectedTaskId: 't1' }, actions());
    expect(gone.some((c) => c.id === 'review:openSelected')).toBe(false);
  });

  it('offers the key actions only while the workspace is open, each running its action', () => {
    const closed = buildWebCommands({ tasks: {}, projects: {} }, actions());
    expect(closed.some((c) => c.id.startsWith('review:key:'))).toBe(false);
    const reviewAction = vi.fn();
    const commands = buildWebCommands(
      { tasks: {}, projects: {}, reviewsOpen: true },
      { ...actions(), reviewAction },
    );
    const next = commands.find((c) => c.id === 'review:key:nextFile');
    expect(next?.title).toBe('Review: Next file');
    void next?.run();
    expect(reviewAction).toHaveBeenCalledWith('nextFile');
  });

  it('drops every review row, and nothing else, once review:queues is host-only', () => {
    const commands = buildWebCommands(
      { tasks: { t1: task() }, projects: {}, reviewsOpen: true, selectedTaskId: 't1' },
      actions(),
    );
    const mutatedPolicy = { ...RELAY_POLICY, 'review:queues': 'host-only' as const };
    const relayed = relayableCommands(commands, mutatedPolicy);
    expect(relayed.some((c) => c.id === 'nav:reviews' || c.id.startsWith('review:'))).toBe(false);
    expect(relayed.some((c) => c.id === 'card:t1')).toBe(true);
  });
});

describe('relayableCommands', () => {
  it('passes every command through unchanged when every channel is relay', () => {
    const commands = buildWebCommands(
      { tasks: { t1: task() }, projects: { p1: project() } },
      actions(),
    );
    const relayed = relayableCommands(commands);
    expect(relayed.map((c) => c.id).sort()).toEqual(commands.map((c) => c.id).sort());
  });

  it('drops the Add task command, and only that one, once task:create is host-only', () => {
    const commands = buildWebCommands(
      { tasks: { t1: task() }, projects: { p1: project() } },
      actions(),
    );
    const mutatedPolicy = { ...RELAY_POLICY, 'task:create': 'host-only' as const };

    const relayed = relayableCommands(commands, mutatedPolicy);

    expect(relayed.some((c) => c.id === 'action:add-task')).toBe(false);
    expect(relayed.some((c) => c.id === 'nav:mytasks')).toBe(true);
    expect(relayed.some((c) => c.id === 'card:t1')).toBe(true);
  });
});

describe('webPaletteSource', () => {
  it('composes buildWebCommands and relayableCommands into a PaletteSource', () => {
    const source = webPaletteSource(() => ({ tasks: { t1: task() }, projects: {} }), actions());
    const rows = source({ currentProjectId: null });
    expect(rows.some((c) => c.id === 'card:t1')).toBe(true);
    expect(rows.some((c) => c.id === 'action:add-task')).toBe(true);
  });
});
