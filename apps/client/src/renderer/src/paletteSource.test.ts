/**
 * `buildDesktopCommands` (F9.4): the pure build of the desktop's own command sources, with
 * every host effect injected so it needs no DOM and no `window.api` mock. Covers the
 * acceptance cases named in the design — a running card offers Stop not Start, a card with no
 * agent project offers no Start, and a card removed between the palette opening and a command
 * running resolves to the engine's own unknown-task sentence instead of throwing something
 * else. Since the v10 mockup (TM-458), also covers that nav/settings/card/action rows carry an
 * `icon` and that a card row's `prefix` is its tracker key.
 */
import { describe, expect, it, vi } from 'vitest';
import { PERSONAL_PROJECT_ID, type Project, type Task } from '@shared/model';
import { RUN_REFUSAL_MESSAGE } from '@shared/scheduler';
import { LOCAL_TARGET } from '@shared/execTarget';
import { AddRegular, PlayRegular, SettingsRegular, StopRegular } from '@fluentui/react-icons';
import { SHELL_NAV } from '@ui/shell/shellNav';
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
  reviewModel: null,
  leadModel: null,
  leadEffort: null,
  planningEffort: null,
  workerEffort: null,
  reviewEffort: null,
  defaultPermissionMode: 'acceptEdits',
  concurrency: 1,
  useWorktrees: true,
  baseBranch: '',
  writeBackPlan: false,
  autoRelease: false,
  autoCreatePr: false,
  autoMergeOnGreen: false,
  autoMergeMethod: 'squash',
  autoMergeBy: 'forge',
  autoMergeRequiredChecks: [],
  autoIntegrate: null,
  autoApprovePlans: false,
  autoApproveMaxSteps: 6,
  readyLanes: 3,
  autoDoneOnLand: false,
  autoVisualSignOff: false,
  autoVisualSignOffMaxRounds: 2,
  planAligned: true,
  jiraEpicKeys: [],
  ticketPrefix: '',
  target: LOCAL_TARGET,
  instructions: '',
  uiVerifyCommand: '',
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
  reviewsOpen: false,
  onOpenReviews: vi.fn(),
  onReviewAction: vi.fn(),
  ...over,
});

describe('buildDesktopCommands', () => {
  it('always offers Add task, with an AddRegular icon', () => {
    const commands = buildDesktopCommands(snapshot());
    const addTask = commands.find((c) => c.id === 'add-task');
    expect(addTask).toBeDefined();
    expect(addTask?.icon).toBe(AddRegular);
  });

  it('lists every screen and every Settings section in the navigate group', () => {
    const commands = buildDesktopCommands(snapshot());
    expect(commands.find((c) => c.id === 'nav:mytasks')).toBeDefined();
    expect(commands.find((c) => c.id === 'nav:settings')).toBeDefined();
    expect(commands.find((c) => c.id === 'settings:jira')?.title).toBe('Settings: JIRA');
  });

  it('offers the regrouped Settings sections and no longer the old Agent profiles one', () => {
    const commands = buildDesktopCommands(snapshot());
    expect(commands.find((c) => c.id === 'settings:agentsModels')?.title).toBe(
      'Settings: Agents and models',
    );
    expect(commands.find((c) => c.id === 'settings:updates')).toBeDefined();
    expect(commands.find((c) => c.id === 'settings:executionTarget')).toBeDefined();
    expect(commands.find((c) => c.id === 'settings:agentProfiles')).toBeUndefined();
  });

  it("carries each nav row's own SHELL_NAV icon, and SettingsRegular for a Settings section", () => {
    const commands = buildDesktopCommands(snapshot());
    const mytasksIcon = SHELL_NAV.find((entry) => entry.id === 'mytasks')?.icon;
    expect(commands.find((c) => c.id === 'nav:mytasks')?.icon).toBe(mytasksIcon);
    expect(commands.find((c) => c.id === 'settings:jira')?.icon).toBe(SettingsRegular);
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

  it('offers Scratch run even though F13.11 dropped its rail tile, with its own icon', () => {
    const onNavigate = vi.fn();
    const commands = buildDesktopCommands(snapshot({ onNavigate }));
    const scratch = commands.find((c) => c.id === 'nav:scratch');
    expect(scratch?.title).toBe('Scratch run');
    expect(scratch?.icon).toBeDefined();
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

  it("sets a card row's prefix to its tracker key, preferring ticketKey over externalKey", () => {
    const withTicketKey = task({
      id: 'c1',
      title: 'Fix the thing',
      ticketKey: 'TM-9',
      externalKey: 'PROJ-767',
    });
    const withExternalOnly = task({
      id: 'c2',
      title: 'Ship the other thing',
      ticketKey: null,
      externalKey: 'PROJ-9',
    });
    const commands = buildDesktopCommands(snapshot({ tasks: [withTicketKey, withExternalOnly] }));
    expect(commands.find((c) => c.id === 'card:c1')?.prefix).toBe('TM-9');
    expect(commands.find((c) => c.id === 'card:c2')?.prefix).toBe('PROJ-9');
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

  it('offers Start for a card assigned but never run, with a PlayRegular icon', () => {
    const card = task({ id: 'c1', status: 'pending', agentProjectId: 'p1' });
    const commands = buildDesktopCommands(snapshot({ tasks: [card], selectedTaskId: 'c1' }));
    expect(commands.find((c) => c.id === 'start-selected')?.icon).toBe(PlayRegular);
    expect(commands.find((c) => c.id === 'stop-selected')).toBeUndefined();
  });

  it('a running card offers Stop, not Start, with a StopRegular icon', () => {
    const card = task({ id: 'c1', status: 'running', agentProjectId: 'p1' });
    const commands = buildDesktopCommands(snapshot({ tasks: [card], selectedTaskId: 'c1' }));
    expect(commands.find((c) => c.id === 'stop-selected')?.icon).toBe(StopRegular);
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

  describe('the review workspace rows (F15.14b)', () => {
    it('offers exactly one Reviews navigate row, now SHELL_NAV carries a Reviews tile too', () => {
      expect(SHELL_NAV.some((entry) => entry.id === 'reviews')).toBe(true);
      const commands = buildDesktopCommands(snapshot());
      const reviews = commands.filter((c) => c.group === 'navigate' && c.title === 'Reviews');
      expect(reviews.map((c) => c.id)).toEqual(['nav:reviews']);
      expect(new Set(commands.map((c) => c.id)).size).toBe(commands.length);
    });

    it('always offers Reviews, which opens the workspace with no subject', () => {
      const onOpenReviews = vi.fn();
      const commands = buildDesktopCommands(snapshot({ onOpenReviews }));
      const reviews = commands.find((c) => c.id === 'nav:reviews');
      expect(reviews?.group).toBe('navigate');
      void reviews?.run();
      expect(onOpenReviews).toHaveBeenCalledWith();
    });

    it('opens the selected card in the workspace by its task subject, named by its key', () => {
      const card = task({ id: 'c1', ticketKey: 'TM-7' });
      const onOpenReviews = vi.fn();
      const commands = buildDesktopCommands(
        snapshot({ tasks: [card], selectedTaskId: 'c1', getTask: () => card, onOpenReviews }),
      );
      const open = commands.find((c) => c.id === 'review:openSelected');
      expect(open?.title).toBe('Open TM-7 in review workspace');
      void open?.run();
      expect(onOpenReviews).toHaveBeenCalledWith('task:c1');
    });

    it('offers no "Open … in review workspace" with no card selected', () => {
      const commands = buildDesktopCommands(snapshot());
      expect(commands.find((c) => c.id === 'review:openSelected')).toBeUndefined();
    });

    it('a card removed before "Open … in review workspace" runs refuses with the unknown-task sentence', () => {
      const card = task({ id: 'c1' });
      const onOpenReviews = vi.fn();
      const commands = buildDesktopCommands(
        snapshot({ tasks: [card], selectedTaskId: 'c1', getTask: () => undefined, onOpenReviews }),
      );
      expect(() => commands.find((c) => c.id === 'review:openSelected')?.run()).toThrow(
        RUN_REFUSAL_MESSAGE['unknown-task'],
      );
      expect(onOpenReviews).not.toHaveBeenCalled();
    });

    it('offers the key actions only while the workspace is open, each running its action', () => {
      expect(buildDesktopCommands(snapshot()).some((c) => c.id.startsWith('review:key:'))).toBe(
        false,
      );
      const onReviewAction = vi.fn();
      const commands = buildDesktopCommands(snapshot({ reviewsOpen: true, onReviewAction }));
      const next = commands.find((c) => c.id === 'review:key:nextFile');
      expect(next?.title).toBe('Review: Next file');
      void next?.run();
      expect(onReviewAction).toHaveBeenCalledWith('nextFile');
    });
  });
});
