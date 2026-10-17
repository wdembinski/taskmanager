/**
 * The one shell navigation both hosts render (F13.8) — replaces the desktop's
 * `DESKTOP_SCREENS` (`apps/client/src/renderer/src/paletteSource.ts`) and the web's own `NAV`
 * literal (`apps/web/src/App.tsx`), which until now each hand-kept their own list of the same
 * ten-odd destinations and had already drifted (the web's extra `fleet`, the desktop's extra
 * `scratch`). Each host still owns which entries it can actually reach — `NavRail`'s
 * `unavailable` — and which carry a live count — `badges` — but the identity, label, icon and
 * group of every destination now live here once.
 *
 * `group` answers "where does this tile sit in the rail", not "what screen does it open":
 * - `'bar'` — the activity bar's permanent destinations, per F13's design doc open question 2:
 *   Issues (`tickets`, the Tickets screen reborn as the list), Board (`mytasks`), Activity,
 *   Performance (its own tile for now — open question 2 folds it into Activity as a second tab,
 *   but that screen-level merge has no card of its own yet, so it keeps a bar slot rather than
 *   riding along with `interim`'s sidebar-bound entries) and Automations.
 * - `'interim'` — destinations open question 2 moves elsewhere (`attention` → the sidebar's
 *   Inbox, `projects` → Settings → Projects, `issues` → a sidebar entry under "This machine",
 *   `fleet` → a sidebar entry, `scratch` → a palette command) but that only happens once F13.11
 *   ships the sidebar those moves depend on. Until then they stay reachable here. **F13.11
 *   deletes the `interim` group** — every entry in it either moves into the sidebar it renders
 *   or, for `scratch`, becomes a palette-only command with no rail tile at all.
 * - `'foot'` — pinned to the rail's bottom, below the spacer: Settings today; **F15 adds a
 *   `reviews` entry** to `'bar'`, once the review workspace ships (F13's design doc lists
 *   Reviews among the bar's permanent destinations, ahead of its own card).
 */
import type { FluentIcon } from '@fluentui/react-icons';
import {
  AlertRegular,
  AppsListDetailRegular,
  BotRegular,
  DataTrendingRegular,
  FlashRegular,
  FolderRegular,
  PlayRegular,
  PulseRegular,
  SettingsRegular,
  TaskListSquareLtrRegular,
  TicketDiagonalRegular,
} from '@fluentui/react-icons';

export type ShellNavId =
  | 'tickets'
  | 'mytasks'
  | 'activity'
  | 'performance'
  | 'automations'
  | 'attention'
  | 'projects'
  | 'issues'
  | 'fleet'
  | 'scratch'
  | 'settings';

export interface ShellNavEntry {
  id: ShellNavId;
  /** The tooltip and the accessible name — the rail has no visible labels. */
  label: string;
  /** A thin `*Regular` Fluent icon component, not an element — `NavRail` instantiates it. */
  icon: FluentIcon;
  group: 'bar' | 'interim' | 'foot';
}

/** The shell's one navigation list, in rail order — grouped `bar` → `interim` → `foot`, per
 *  this module's own header. Each host maps it onto `NavRail`'s `items`, supplying only its own
 *  `unavailable` reasons and `badges`. */
export const SHELL_NAV: readonly ShellNavEntry[] = [
  { id: 'tickets', label: 'Tickets', icon: AppsListDetailRegular, group: 'bar' },
  { id: 'mytasks', label: 'My Tasks', icon: TaskListSquareLtrRegular, group: 'bar' },
  { id: 'activity', label: 'Activity', icon: PulseRegular, group: 'bar' },
  { id: 'performance', label: 'Performance', icon: DataTrendingRegular, group: 'bar' },
  { id: 'automations', label: 'Automations', icon: FlashRegular, group: 'bar' },
  { id: 'attention', label: 'Attention', icon: AlertRegular, group: 'interim' },
  { id: 'projects', label: 'Projects', icon: FolderRegular, group: 'interim' },
  { id: 'issues', label: 'Issues', icon: TicketDiagonalRegular, group: 'interim' },
  { id: 'fleet', label: 'Fleet', icon: BotRegular, group: 'interim' },
  { id: 'scratch', label: 'Scratch run', icon: PlayRegular, group: 'interim' },
  { id: 'settings', label: 'Settings', icon: SettingsRegular, group: 'foot' },
];
