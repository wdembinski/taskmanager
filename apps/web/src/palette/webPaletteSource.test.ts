/**
 * `buildWebCommands`'s navigate/cards/projects/actions command list and `relayableCommands`'s
 * policy-driven filter: every command this module builds names only channels `RELAY_POLICY`
 * marks `'relay'` (the baseline the F9.10 mutation proof flips `task:create` against — see
 * CLAUDE-step notes), Scratch run has no way to appear at all (`Screen` has no `'scratch'`
 * member for `goTo` to target), and `relayableCommands` drops a command the instant any one of
 * its channels stops being relayable on whatever policy it is handed — a cloned, mutated copy
 * for a test, the real singleton by default.
 */
import { describe, expect, it } from 'vitest';
import { RELAY_POLICY } from '@tm/shared/ipcRelay';
import type { Project, Task } from '@tm/shared/model';
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

  it('builds an Add task command that calls channels task:create and ticket:create', () => {
    const commands = buildWebCommands({ tasks: {}, projects: {} }, actions());
    const addTask = commands.find((c) => c.id === 'action:add-task');
    expect(addTask?.channels).toEqual(['task:create', 'ticket:create']);
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
