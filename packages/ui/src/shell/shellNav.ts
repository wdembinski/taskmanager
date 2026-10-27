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
 *   but that screen-level merge has no card of its own yet, so it keeps a bar slot) and
 *   Automations.
 * - `'foot'` — pinned to the rail's bottom, below the spacer: Settings.
 *
 * **`reviews` (F15.14b) is a destination with no rail tile**: it joins `ShellNavId` so both
 * hosts' `TabId`/`Screen` route to the review workspace, but not `SHELL_NAV` — the sidebar's
 * Reviews row (with its *Requested from me* count) is the entry, the same way `attention` and
 * `issues` work since F13.11.
 *
 * **F13.11 deleted the `'interim'` group** that used to sit between the two above (`attention`,
 * `projects`, `issues`, `fleet`, `scratch`) — every one of those five now reaches its screen
 * through the sidebar `Sidebar.tsx` renders instead of a rail tile: `attention` → the sidebar's
 * Inbox row, `issues`/`fleet`/`projects` → the small icon row under the team header, `scratch`
 * → a palette-only command (`paletteSource.ts`) with no rail tile at all. `ShellNavId` keeps
 * all five as valid destinations — both hosts' `TabId`/`Screen` still route to them, exactly as
 * before — only `SHELL_NAV` itself, the RAIL's own list, no longer carries a tile for any of
 * them.
 */
import type { FluentIcon } from '@fluentui/react-icons';
import {
  BoardRegular,
  DataTrendingRegular,
  FlashRegular,
  MailInboxRegular,
  SettingsRegular,
  TaskListSquareLtrRegular,
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
  | 'reviews'
  | 'settings';

export interface ShellNavEntry {
  id: ShellNavId;
  /** The tooltip and the accessible name — the rail has no visible labels. */
  label: string;
  /** A thin `*Regular` Fluent icon component, not an element — `NavRail` instantiates it. */
  icon: FluentIcon;
  group: 'bar' | 'foot';
}

/** The shell's one navigation list, in rail order — grouped `bar` → `foot`, per this module's
 *  own header. Each host maps it onto `NavRail`'s `items`, supplying only its own
 *  `unavailable` reasons and `badges`. */
export const SHELL_NAV: readonly ShellNavEntry[] = [
  { id: 'tickets', label: 'Tickets', icon: TaskListSquareLtrRegular, group: 'bar' },
  { id: 'mytasks', label: 'My Tasks', icon: BoardRegular, group: 'bar' },
  { id: 'activity', label: 'Activity', icon: MailInboxRegular, group: 'bar' },
  { id: 'performance', label: 'Performance', icon: DataTrendingRegular, group: 'bar' },
  { id: 'automations', label: 'Automations', icon: FlashRegular, group: 'bar' },
  { id: 'settings', label: 'Settings', icon: SettingsRegular, group: 'foot' },
];
