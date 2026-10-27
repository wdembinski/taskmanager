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
 *
 * Since the v10 mockup (TM-458), every command also carries an `icon` — a nav row's own
 * `SHELL_NAV` entry, `SignOutRegular` for Sign out — and a card row carries a `prefix` (its
 * tracker key) in place of the old key `subtitle`, so the key is not shown twice.
 *
 * The review workspace's rows (F15.14b) come from the shared `reviewWorkspaceCommands`, the same
 * list the desktop mixes in, each naming `review:queues` — the read the workspace cannot open
 * without — so a policy that ever stops relaying it takes every one of them off the palette.
 */
import type { IpcApi } from '@tm/shared/ipc';
import { RELAY_POLICY, type RelayPolicy } from '@tm/shared/ipcRelay';
import type { Project, Task } from '@tm/shared/model';
import { taskSubjectId } from '@tm/shared/review';
import {
  reviewCommandKeyAction,
  reviewWorkspaceCommands,
  type PaletteCommand,
  type PaletteSource,
  type ReviewWorkspaceCommandId,
} from '@tm/ui/palette/paletteModel';
import type { ReviewKeyAction } from '@tm/ui/review/reviewKeys';
import { SHELL_NAV } from '@tm/ui/shell/shellNav';
import { AddRegular, SignOutRegular, type FluentIcon } from '@fluentui/react-icons';
import type { Screen } from '../App';

/** A `PaletteCommand` that also names the IPC channels its `run` calls — the web-only extra
 *  `relayableCommands` reads and the shared model never does. */
export type WebCommand = PaletteCommand & { channels: readonly (keyof IpcApi)[] };

/** What `buildWebCommands` needs from the cloud board store to build every group. */
export interface WebPaletteSnapshot {
  tasks: Record<string, Task>;
  projects: Record<string, Project>;
  /** Whether the review workspace is the screen on show — its key-action rows are offered
   *  only then (F15.14b). Absent reads as `false`. */
  reviewsOpen?: boolean;
  /** The card open on the board, which "Open … in review workspace" acts on. Absent or `null`
   *  offers no such row. */
  selectedTaskId?: string | null;
}

/** The host calls these rather than `webPaletteSource` touching navigation, the transport or
 *  `App.tsx`'s own state directly — same shape as the desktop source will take (F9.4). */
export interface WebPaletteActions {
  goTo: (screen: Screen) => void;
  openCard: (taskId: string) => void;
  addTask: () => void;
  signOut: () => void;
  /** Switch to the review workspace, with `subjectId` selected when one is given. */
  openReviews: (subjectId?: string) => void;
  /** Run one workspace key action as if its key were pressed (the workspace's
   *  `actionRequest`). */
  reviewAction: (action: ReviewKeyAction) => void;
}

/** Every rail destination `goTo` can reach — `SHELL_NAV` (F13.8), which since F13.11 no
 *  longer carries Scratch run at all (desktop-only, a palette command there with no rail
 *  tile — see `shellNav.ts`'s own header), so no filter is needed here any more. */
const NAV_SCREENS: readonly { id: Screen; title: string; icon: FluentIcon }[] = SHELL_NAV.map(
  (entry) => ({ id: entry.id as Screen, title: entry.label, icon: entry.icon }),
);

/** `keywords` a card command is searchable by, beyond its title — its tracker key under
 *  whichever name it carries, and its id for the uuid-paste case `paletteModel.ts` already
 *  ranks below a title hit. */
function cardKeywords(task: Task): string[] {
  return [task.ticketKey, task.externalKey, task.id].filter(
    (keyword): keyword is string => !!keyword,
  );
}

/** The short label shown ahead of a card row's title — its tracker key, or `undefined` for a
 *  card with neither. */
function cardPrefix(task: Task): string | undefined {
  return task.ticketKey ?? task.externalKey ?? undefined;
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
  const navigate: WebCommand[] = NAV_SCREENS.map(({ id, title, icon }) => ({
    id: `nav:${id}`,
    group: 'navigate',
    title,
    icon,
    channels: [],
    run: () => actions.goTo(id),
  }));

  const cards: WebCommand[] = Object.values(snapshot.tasks)
    .filter((task) => !task.archivedAt)
    .map((task) => ({
      id: `card:${task.id}`,
      group: 'cards',
      title: task.title,
      prefix: cardPrefix(task),
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
      icon: AddRegular,
      channels: ['task:create', 'ticket:create'],
      run: () => actions.addTask(),
    },
    {
      id: 'action:sign-out',
      group: 'actions',
      title: 'Sign out',
      icon: SignOutRegular,
      channels: [],
      run: () => actions.signOut(),
    },
  ];

  return [
    ...navigate,
    ...cards,
    ...projects,
    ...actionCommands,
    ...reviewCommands(snapshot, actions),
  ];
}

/** Every channel a review workspace row needs relayed — see the module header. */
const REVIEW_CHANNELS: readonly (keyof IpcApi)[] = ['review:queues'];

/** The shared review workspace rows (F15.14b), mapped onto this host's actions. */
function reviewCommands(snapshot: WebPaletteSnapshot, actions: WebPaletteActions): WebCommand[] {
  const selected =
    snapshot.selectedTaskId != null ? snapshot.tasks[snapshot.selectedTaskId] : undefined;
  return reviewWorkspaceCommands({
    open: snapshot.reviewsOpen ?? false,
    selection: selected ? { label: cardPrefix(selected) ?? null } : null,
    onAction: (id: ReviewWorkspaceCommandId) => {
      if (id === 'nav:reviews') {
        actions.openReviews();
        return;
      }
      if (id === 'review:openSelected') {
        if (selected) actions.openReviews(taskSubjectId(selected.id));
        return;
      }
      const action = reviewCommandKeyAction(id);
      if (action) actions.reviewAction(action);
    },
  }).map((command) => ({ ...command, channels: REVIEW_CHANNELS }));
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
