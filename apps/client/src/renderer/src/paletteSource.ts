/**
 * The desktop's own command palette source (F9.4) — a pure `buildDesktopCommands(snapshot)`
 * that turns a snapshot of the app's state into `PaletteCommand[]`, with no React and no
 * `window.api` call inside it: every effect the commands have (navigating, starting a card,
 * opening the Add task dialog, …) is a function the snapshot carries in, so the whole thing is
 * unit-testable (`paletteSource.test.ts`) without a DOM or a mocked IPC transport. `App.tsx`
 * builds the snapshot from its own state and wraps this in a `PaletteSource` for
 * `CommandPalette` (F9.3) to call.
 *
 * Three groups, per the design in `docs/plan/feature-roadmap/F9-command-palette-and-dictation.md`:
 * `navigate` (screens plus a deep link into each Settings section), `cards` (every board card,
 * searchable by title, tracker key and id) and `projects`. `actions` holds Add task and
 * Start/Stop for whichever card is currently selected on the board — gated by
 * {@link canStartWork}/{@link canStopWork} (`@shared/board`), never re-derived here, so the
 * palette can never offer a button `TaskAgentPanel` itself would refuse.
 *
 * Since the v10 mockup (TM-458), every command also carries an `icon`: a nav row's own
 * `SHELL_NAV` entry, `SettingsRegular` for a Settings section, and a per-action icon below. A
 * card row additionally carries a `prefix` — its tracker key — shown ahead of its title.
 */
import { canStartWork, canStopWork, isBoardCard } from '@shared/board';
import { RUN_REFUSAL_MESSAGE } from '@shared/scheduler';
import type { Project, Task } from '@shared/model';
import type { PaletteCommand } from '@ui/palette/paletteModel';
import { SHELL_NAV, type ShellNavId } from '@ui/shell/shellNav';
import {
  AddRegular,
  BeakerRegular,
  PlayRegular,
  SettingsRegular,
  StopRegular,
  type FluentIcon,
} from '@fluentui/react-icons';
import type { SettingsSection } from './Settings';

/** Every destination the desktop can route `tab` to (`App.tsx`'s `TabId`) — every `ShellNavId`
 *  except `fleet`, the one destination the desktop does not have (F13.8: it moved from each
 *  host hand-keeping its own list to `SHELL_NAV`/`ShellNavId`, the one list both read).
 *  `App.tsx` defines its `TabId` as this type, so the two can never drift apart. Wider than
 *  `SHELL_NAV` itself since F13.11: `SHELL_NAV` is only the RAIL's tiles, and `attention`/
 *  `projects`/`issues`/`scratch` are still real tabs here, reached from the sidebar or (for
 *  `scratch` alone) the palette command below rather than a rail tile. */
export type DesktopPaletteTab = Exclude<ShellNavId, 'fleet'>;

/** The nav rail, in palette order — the single source `App.tsx`'s own rail reads its labels
 *  from, so the rail and the palette can never list a different set of screens. Every
 *  `SHELL_NAV` entry is a desktop tab (fleet is the only `ShellNavId` the rail could ever carry
 *  that this host does not have, and F13.11 already dropped it from `SHELL_NAV` itself), so no
 *  filter is needed here any more. */
export const DESKTOP_SCREENS: ReadonlyArray<{
  id: DesktopPaletteTab;
  title: string;
  icon: FluentIcon;
}> = SHELL_NAV.map((entry) => ({
  id: entry.id as DesktopPaletteTab,
  title: entry.label,
  icon: entry.icon,
}));

/** `Settings.tsx`'s own tabs, in the order its `TabList` renders them — the single source
 *  it reads its `<Tab>` list from, so a section added here is a section Settings already
 *  shows. */
export const SETTINGS_SECTIONS: ReadonlyArray<{ id: SettingsSection; title: string }> = [
  { id: 'general', title: 'General' },
  { id: 'appearance', title: 'Appearance' },
  { id: 'board', title: 'Board' },
  { id: 'features', title: 'Features' },
  { id: 'jira', title: 'JIRA' },
  { id: 'gitlab', title: 'GitLab' },
  { id: 'github', title: 'GitHub' },
  { id: 'linear', title: 'Linear' },
  { id: 'cloud', title: 'Cloud' },
  { id: 'people', title: 'People' },
  { id: 'agentProfiles', title: 'Agent profiles' },
  { id: 'skills', title: 'Skills' },
  { id: 'workflows', title: 'Workflows' },
  { id: 'promptTemplates', title: 'Prompt templates' },
  { id: 'shortcuts', title: 'Shortcuts' },
];

/**
 * Everything `buildDesktopCommands` needs, supplied by `App.tsx`. The host-facing functions
 * (`onNavigate`, `onOpenTask`, …) are the ONLY way this file touches the outside world — kept
 * that way so the whole module stays testable with plain mocks.
 *
 * `getTask` is deliberately NOT `tasks.find`: `tasks` is the list this snapshot was built
 * from, taken once when the palette opened, while `getTask` is read fresh at the moment a
 * command actually runs. The palette can stay open for a while after that — long enough for a
 * sync to remove a card the snapshot still lists — and a Start/Stop/open-card command must
 * fail soft on that card rather than act on one that is already gone (the "stale rows" failure
 * mode in F9's design doc).
 */
export interface DesktopPaletteSnapshot {
  tasks: readonly Task[];
  agentProjects: readonly Project[];
  liveRunTaskIds: ReadonlySet<string>;
  selectedTaskId: string | null;
  getTask: (taskId: string) => Task | undefined;
  onNavigate: (tab: DesktopPaletteTab) => void;
  onOpenTask: (taskId: string) => void;
  onOpenSettingsSection: (section: SettingsSection) => void;
  onAddTask: () => void;
  runTask: (taskId: string) => Promise<void>;
  stopTask: (taskId: string) => Promise<void>;
}

/** `taskId` re-resolved through `getTask` at run time, or a throw carrying the same sentence
 *  the engine itself would refuse with — see {@link DesktopPaletteSnapshot.getTask}. */
function resolveTask(taskId: string, getTask: (taskId: string) => Task | undefined): Task {
  const task = getTask(taskId);
  if (!task) throw new Error(RUN_REFUSAL_MESSAGE['unknown-task']);
  return task;
}

/** Keywords a card's row is searchable by, beyond its title: its tracker key(s) and its own
 *  id — ranked below a title hit by {@link paletteScore}, which is the whole reason that
 *  scorer exists (a numeric ticket id should not outrank a title that merely contains it). */
function cardKeywords(task: Task): string[] {
  return [task.externalKey, task.ticketKey, task.id].filter(
    (k): k is string => k != null && k !== '',
  );
}

/** The short label shown ahead of a card row's title — its tracker key, or `undefined` for a
 *  card with neither. */
function cardPrefix(task: Task): string | undefined {
  return task.ticketKey ?? task.externalKey ?? undefined;
}

/** The `navigate` group: one row per rail screen, Scratch run (F13.11 — the one destination
 *  the sidebar does not carry a row for, see this module's header), plus one per Settings
 *  section. */
function navigateCommands(snapshot: DesktopPaletteSnapshot): PaletteCommand[] {
  const screens = DESKTOP_SCREENS.map((tab): PaletteCommand => ({
    id: `nav:${tab.id}`,
    group: 'navigate',
    title: tab.title,
    icon: tab.icon,
    run: () => snapshot.onNavigate(tab.id),
  }));
  const scratchRun: PaletteCommand = {
    id: 'nav:scratch',
    group: 'navigate',
    title: 'Scratch run',
    icon: BeakerRegular,
    run: () => snapshot.onNavigate('scratch'),
  };
  const settingsSections = SETTINGS_SECTIONS.map((section): PaletteCommand => ({
    id: `settings:${section.id}`,
    group: 'navigate',
    title: `Settings: ${section.title}`,
    keywords: ['Settings'],
    icon: SettingsRegular,
    run: () => snapshot.onOpenSettingsSection(section.id),
  }));
  return [...screens, scratchRun, ...settingsSections];
}

/** The `cards` group: every board card (steps and variant rows excluded — see
 *  `isBoardCard`), searchable by title, tracker key and id. */
function cardCommands(snapshot: DesktopPaletteSnapshot): PaletteCommand[] {
  return snapshot.tasks.filter(isBoardCard).map((task): PaletteCommand => ({
    id: `card:${task.id}`,
    group: 'cards',
    title: task.title,
    keywords: cardKeywords(task),
    prefix: cardPrefix(task),
    projectId: task.projectId,
    run: () => {
      resolveTask(task.id, snapshot.getTask);
      snapshot.onOpenTask(task.id);
    },
  }));
}

/** The `projects` group: every repo a card can be delegated to. */
function projectCommands(snapshot: DesktopPaletteSnapshot): PaletteCommand[] {
  return snapshot.agentProjects.map((project): PaletteCommand => ({
    id: `project:${project.id}`,
    group: 'projects',
    title: project.name,
    projectId: project.id,
    run: () => snapshot.onNavigate('projects'),
  }));
}

/**
 * The `actions` group: Add task, plus Start/Stop for whichever card is selected on the board.
 *
 * Start/Stop are gated at BUILD time from `snapshot.tasks` (so the row simply isn't offered
 * when it wouldn't be legal), but act through `resolveTask` at RUN time, so a card selected
 * when the palette opened and removed before the row is clicked refuses with the same
 * sentence the engine would rather than throwing something else.
 */
function actionCommands(snapshot: DesktopPaletteSnapshot): PaletteCommand[] {
  const commands: PaletteCommand[] = [
    {
      id: 'add-task',
      group: 'actions',
      title: 'Add task',
      icon: AddRegular,
      run: () => snapshot.onAddTask(),
    },
  ];

  const selected = snapshot.tasks.find((t) => t.id === snapshot.selectedTaskId);
  if (!selected) return commands;

  const ownSteps = snapshot.tasks.filter((t) => t.parentTaskId === selected.id);

  if (canStartWork(selected, ownSteps, snapshot.liveRunTaskIds)) {
    commands.push({
      id: 'start-selected',
      group: 'actions',
      title: 'Start selected card',
      subtitle: selected.title,
      icon: PlayRegular,
      run: async () => {
        const task = resolveTask(selected.id, snapshot.getTask);
        await snapshot.runTask(task.id);
      },
    });
  }

  if (canStopWork(selected, ownSteps, snapshot.liveRunTaskIds)) {
    commands.push({
      id: 'stop-selected',
      group: 'actions',
      title: 'Stop selected card',
      subtitle: selected.title,
      icon: StopRegular,
      run: async () => {
        const task = resolveTask(selected.id, snapshot.getTask);
        await snapshot.stopTask(task.id);
      },
    });
  }

  return commands;
}

/** Every desktop command for the given snapshot, in no particular order — `CommandPalette`
 *  groups and ranks them itself. */
export function buildDesktopCommands(snapshot: DesktopPaletteSnapshot): PaletteCommand[] {
  return [
    ...navigateCommands(snapshot),
    ...cardCommands(snapshot),
    ...projectCommands(snapshot),
    ...actionCommands(snapshot),
  ];
}
