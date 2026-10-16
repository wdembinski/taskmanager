/**
 * The web's own `PaletteSource` (F9.5) — built from `CloudBoardState.tasks`/`projects` rather
 * than an IPC read, since the browser already mirrors both locally. The one rule this module
 * exists to enforce: a web command can only be excluded by NAMING the channel that makes it
 * so, never by a hand-set flag — see `RELAY_POLICY`'s own header for why that exhaustiveness
 * matters.
 *
 * `buildWebCommands` is pure and declares every command's `channels` up front (`[]` for
 * navigation and card/project selection, which touch no IPC at all); `relayableCommands` then
 * drops any command naming a channel `policy` does not mark `'relay'`. `policy` is a parameter
 * rather than a closed-over import so a test can flip one channel on a *copy* without mutating
 * the singleton the engine side also reads (`support-all-interactions-in-the-web`).
 *
 * Scratch run — the one rail destination the web never offers — needs no exception here at
 * all: `goTo`'s parameter is `Screen`, which has no `'scratch'` member, so there is no way to
 * even construct a command that targets it.
 */
import type { IpcApi } from '@tm/shared/ipc';
import { RELAY_POLICY, type RelayPolicy } from '@tm/shared/ipcRelay';
import type { Project, Task } from '@tm/shared/model';
import type { PaletteCommand, PaletteSource } from '@tm/ui/palette/paletteModel';
import type { Screen } from '../App';

/** A `PaletteCommand` that also names the IPC channels its `run` calls — the web-only extra
 *  `relayableCommands` reads and the shared model never does. */
export type WebCommand = PaletteCommand & { channels: readonly (keyof IpcApi)[] };

/** What `buildWebCommands` needs from the cloud board store to build every group. */
export interface WebPaletteSnapshot {
  tasks: Record<string, Task>;
  projects: Record<string, Project>;
}

/** The host calls these rather than `webPaletteSource` touching navigation, the transport or
 *  `App.tsx`'s own state directly — same shape as the desktop source will take (F9.4). */
export interface WebPaletteActions {
  goTo: (screen: Screen) => void;
  openCard: (taskId: string) => void;
  addTask: () => void;
  signOut: () => void;
}

/** Every rail destination `goTo` can reach — the same ten `App.tsx`'s own `NAV` renders,
 *  Scratch run excepted (it is not a `Screen` at all, see this module's header). */
const NAV_SCREENS: readonly { id: Screen; title: string }[] = [
  { id: 'mytasks', title: 'My Tasks' },
  { id: 'projects', title: 'Projects' },
  { id: 'tickets', title: 'Tickets' },
  { id: 'issues', title: 'Issues' },
  { id: 'automations', title: 'Automations' },
  { id: 'fleet', title: 'Fleet' },
  { id: 'performance', title: 'Performance' },
  { id: 'activity', title: 'Activity' },
  { id: 'attention', title: 'Attention' },
  { id: 'settings', title: 'Settings' },
];

/** `keywords` a card command is searchable by, beyond its title — its tracker key under
 *  whichever name it carries, and its id for the uuid-paste case `paletteModel.ts` already
 *  ranks below a title hit. */
function cardKeywords(task: Task): string[] {
  return [task.ticketKey, task.externalKey, task.id].filter(
    (keyword): keyword is string => !!keyword,
  );
}

/**
 * The web's full v1 command list, every one of them declaring the channels its `run` calls —
 * `[]` for navigation and card/project selection, which only touch local state. Not yet
 * filtered: `relayableCommands` is the one thing that decides what the palette actually shows.
 */
export function buildWebCommands(
  snapshot: WebPaletteSnapshot,
  actions: WebPaletteActions,
): WebCommand[] {
  const navigate: WebCommand[] = NAV_SCREENS.map(({ id, title }) => ({
    id: `nav:${id}`,
    group: 'navigate',
    title,
    channels: [],
    run: () => actions.goTo(id),
  }));

  const cards: WebCommand[] = Object.values(snapshot.tasks)
    .filter((task) => !task.archivedAt)
    .map((task) => ({
      id: `card:${task.id}`,
      group: 'cards',
      title: task.title,
      subtitle: task.ticketKey ?? task.externalKey ?? undefined,
      keywords: cardKeywords(task),
      projectId: task.projectId,
      channels: [],
      run: () => actions.openCard(task.id),
    }));

  const projects: WebCommand[] = Object.values(snapshot.projects).map((project) => ({
    id: `project:${project.id}`,
    group: 'projects',
    title: project.name,
    subtitle: 'Project',
    channels: [],
    run: () => actions.goTo('tickets'),
  }));

  const actionCommands: WebCommand[] = [
    {
      id: 'action:add-task',
      group: 'actions',
      title: 'Add task',
      channels: ['task:create', 'ticket:create'],
      run: () => actions.addTask(),
    },
    {
      id: 'action:sign-out',
      group: 'actions',
      title: 'Sign out',
      channels: [],
      run: () => actions.signOut(),
    },
  ];

  return [...navigate, ...cards, ...projects, ...actionCommands];
}

/**
 * `commands` with `hostOnly` derived from `policy` — true the instant any one of a command's
 * `channels` is not `'relay'` there — keeping only the ones that come back false. `policy`
 * defaults to the real singleton but takes a parameter so a test can flip one channel on a
 * clone without mutating what the engine side reads too.
 */
export function relayableCommands(
  commands: readonly WebCommand[],
  policy: Record<keyof IpcApi, RelayPolicy> = RELAY_POLICY,
): WebCommand[] {
  return commands
    .map((command) => ({
      ...command,
      hostOnly: command.channels.some((channel) => policy[channel] !== 'relay'),
    }))
    .filter((command) => !command.hostOnly);
}

/** `buildWebCommands` and `relayableCommands`, composed into the `PaletteSource` the palette
 *  itself takes — `getSnapshot` is read fresh every time the palette opens, same as any other
 *  source (`CommandPalette.tsx`'s own `collectCommands` call). */
export function webPaletteSource(
  getSnapshot: () => WebPaletteSnapshot,
  actions: WebPaletteActions,
): PaletteSource {
  return () => relayableCommands(buildWebCommands(getSnapshot(), actions));
}
