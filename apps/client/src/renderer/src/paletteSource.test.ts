/**
 * `buildDesktopCommands` (F9.4): the pure build of the desktop's own command sources, with
 * every host effect injected so it needs no DOM and no `window.api` mock. Covers the
 * acceptance cases named in the design — a running card offers Stop not Start, a card with no
 * agent project offers no Start, and a card removed between the palette opening and a command
 * running resolves to the engine's own unknown-task sentence instead of throwing something
 * else.
 */
import { describe, expect, it, vi } from 'vitest';
import { PERSONAL_PROJECT_ID, type Project, type Task } from '@shared/model';
import { RUN_REFUSAL_MESSAGE } from '@shared/scheduler';
import { LOCAL_TARGET } from '@shared/execTarget';
import { buildDesktopCommands, type DesktopPaletteSnapshot } from './paletteSource';

const task = (over: Partial<Task>): Task => ({
  id: 't',
  projectId: PERSONAL_PROJECT_ID,
  phase: '',
  title: 'x',
  status: 'pending',
  sessionId: null,
  order: 0,
  dependsOn: [],
  source: 'jira',
  isContract: false,
  isScaffold: false,
  externalSource: 'jira',
  ...over,
});

const project = (over: Partial<Project> = {}): Project => ({
  id: 'p1',
  name: 'Project one',
  path: '/tmp/p1',
  planPath: '',
  defaultModel: 'sonnet',
  planningModel: null,
  defaultPermissionMode: 'acceptEdits',
  concurrency: 1,
  useWorktrees: true,
  baseBranch: '',
  writeBackPlan: false,
  autoRelease: false,
  autoCreatePr: false,
  autoIntegrate: null,
  planAligned: true,
  jiraEpicKeys: [],
  ticketPrefix: '',
  target: LOCAL_TARGET,
  instructions: '',
  color: '',
  createdAt: 0,
  ...over,
});

const snapshot = (over: Partial<DesktopPaletteSnapshot> = {}): DesktopPaletteSnapshot => ({
  tasks: [],
  agentProjects: [],
  liveRunTaskIds: new Set(),
  selectedTaskId: null,
  getTask: () => undefined,
  onNavigate: vi.fn(),
  onOpenTask: vi.fn(),
  onOpenSettingsSection: vi.fn(),
  onAddTask: vi.fn(),
  runTask: vi.fn().mockResolvedValue(undefined),
  stopTask: vi.fn().mockResolvedValue(undefined),
  ...over,
});

describe('buildDesktopCommands', () => {
  it('always offers Add task', () => {
    const commands = buildDesktopCommands(snapshot());
    expect(commands.find((c) => c.id === 'add-task')).toBeDefined();
  });

  it('lists every screen and every Settings section in the navigate group', () => {
    const commands = buildDesktopCommands(snapshot());
    expect(commands.find((c) => c.id === 'nav:mytasks')).toBeDefined();
    expect(commands.find((c) => c.id === 'nav:settings')).toBeDefined();
    expect(commands.find((c) => c.id === 'settings:jira')?.title).toBe('Settings: JIRA');
  });

  it('a nav command calls onNavigate with its tab', () => {
    const onNavigate = vi.fn();
    const commands = buildDesktopCommands(snapshot({ onNavigate }));
    // `tickets` rather than F13.11's own `projects` — SHELL_NAV (and so DESKTOP_SCREENS) no
    // longer carries a `projects` tile; see the dedicated Scratch run test below for the one
    // navigate command this module still adds on top of DESKTOP_SCREENS.
    void commands.find((c) => c.id === 'nav:tickets')?.run();
    expect(onNavigate).toHaveBeenCalledWith('tickets');
  });

  it('offers Scratch run even though F13.11 dropped its rail tile', () => {
    const onNavigate = vi.fn();
    const commands = buildDesktopCommands(snapshot({ onNavigate }));
    const scratch = commands.find((c) => c.id === 'nav:scratch');
    expect(scratch?.title).toBe('Scratch run');
    void scratch?.run();
    expect(onNavigate).toHaveBeenCalledWith('scratch');
  });

  it('a Settings section command calls onOpenSettingsSection', () => {
    const onOpenSettingsSection = vi.fn();
    const commands = buildDesktopCommands(snapshot({ onOpenSettingsSection }));
    void commands.find((c) => c.id === 'settings:board')?.run();
    expect(onOpenSettingsSection).toHaveBeenCalledWith('board');
  });

  it('lists a board card, keyed by its tracker key and id, but not a step or a variant row', () => {
    const card = task({ id: 'c1', title: 'Fix the thing', externalKey: 'PROJ-767' });
    const step = task({ id: 's1', title: 'Step one', parentTaskId: 'c1' });
    const variant = task({ id: 'v1', title: 'Attempt 2', variantOf: 'c1' });
    const commands = buildDesktopCommands(snapshot({ tasks: [card, step, variant] }));
    const cardIds = commands.filter((c) => c.group === 'cards').map((c) => c.id);
    expect(cardIds).toEqual(['card:c1']);
    expect(commands.find((c) => c.id === 'card:c1')?.keywords).toContain('PROJ-767');
  });

  it('opening a card resolves it live and calls onOpenTask', () => {
    const card = task({ id: 'c1', title: 'Fix the thing' });
    const onOpenTask = vi.fn();
    const commands = buildDesktopCommands(
      snapshot({ tasks: [card], getTask: (id) => (id === 'c1' ? card : undefined), onOpenTask }),
    );
    void commands.find((c) => c.id === 'card:c1')?.run();
    expect(onOpenTask).toHaveBeenCalledWith('c1');
  });

  it('a deleted card open command refuses with the unknown-task sentence instead of opening it', async () => {
    const card = task({ id: 'c1', title: 'Fix the thing' });
    const onOpenTask = vi.fn();
    const commands = buildDesktopCommands(
      snapshot({ tasks: [card], getTask: () => undefined, onOpenTask }),
    );
    const open = commands.find((c) => c.id === 'card:c1');
    await expect(Promise.resolve().then(() => open?.run())).rejects.toThrow(
      RUN_REFUSAL_MESSAGE['unknown-task'],
    );
    expect(onOpenTask).not.toHaveBeenCalled();
  });

  it('lists every agent project in the projects group', () => {
    const commands = buildDesktopCommands(snapshot({ agentProjects: [project()] }));
    expect(commands.find((c) => c.id === 'project:p1')?.title).toBe('Project one');
  });

  it('offers no Start for a card with no agent project', () => {
    const card = task({ id: 'c1', status: 'pending', agentProjectId: null });
    const commands = buildDesktopCommands(snapshot({ tasks: [card], selectedTaskId: 'c1' }));
    expect(commands.find((c) => c.id === 'start-selected')).toBeUndefined();
  });

  it('offers Start for a card assigned but never run', () => {
    const card = task({ id: 'c1', status: 'pending', agentProjectId: 'p1' });
    const commands = buildDesktopCommands(snapshot({ tasks: [card], selectedTaskId: 'c1' }));
    expect(commands.find((c) => c.id === 'start-selected')).toBeDefined();
    expect(commands.find((c) => c.id === 'stop-selected')).toBeUndefined();
  });

  it('a running card offers Stop, not Start', () => {
    const card = task({ id: 'c1', status: 'running', agentProjectId: 'p1' });
    const commands = buildDesktopCommands(snapshot({ tasks: [card], selectedTaskId: 'c1' }));
    expect(commands.find((c) => c.id === 'stop-selected')).toBeDefined();
    expect(commands.find((c) => c.id === 'start-selected')).toBeUndefined();
  });

  it('offers neither Start nor Stop when no card is selected', () => {
    const card = task({ id: 'c1', status: 'pending', agentProjectId: 'p1' });
    const commands = buildDesktopCommands(snapshot({ tasks: [card], selectedTaskId: null }));
    expect(commands.find((c) => c.id === 'start-selected')).toBeUndefined();
    expect(commands.find((c) => c.id === 'stop-selected')).toBeUndefined();
  });

  it('a card removed between opening the palette and pressing Start refuses with the unknown-task sentence', async () => {
    const card = task({ id: 'c1', status: 'pending', agentProjectId: 'p1' });
    const runTask = vi.fn().mockResolvedValue(undefined);
    const commands = buildDesktopCommands(
      snapshot({ tasks: [card], selectedTaskId: 'c1', getTask: () => undefined, runTask }),
    );
    const start = commands.find((c) => c.id === 'start-selected');
    await expect(start?.run()).rejects.toThrow(RUN_REFUSAL_MESSAGE['unknown-task']);
    expect(runTask).not.toHaveBeenCalled();
  });

  it('pressing Stop on a still-live card calls stopTask with its id', async () => {
    const card = task({ id: 'c1', status: 'running', agentProjectId: 'p1' });
    const stopTask = vi.fn().mockResolvedValue(undefined);
    const commands = buildDesktopCommands(
      snapshot({ tasks: [card], selectedTaskId: 'c1', getTask: () => card, stopTask }),
    );
    await commands.find((c) => c.id === 'stop-selected')?.run();
    expect(stopTask).toHaveBeenCalledWith('c1');
  });
});
