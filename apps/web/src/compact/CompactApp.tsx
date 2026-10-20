/**
 * The compact shell's own root (F3.2) — what `SignedInBoard` (`../App.tsx`) renders instead
 * of its wide `AppShell` tree once `useLayoutMode()` says `'compact'`. Not a new data layer:
 * every prop here is a value `SignedInBoard` already computes for the wide layout (the same
 * `board`, `presence`, `skew`, `attentionCount`, `now`, `busy`, auth/config deps and
 * `onSignOut`), so the two layouts stay two views of one set of facts rather than two
 * independent readings of the board that could disagree.
 *
 * ## Design decisions fixed here (do not re-derive in later edits)
 *
 * - **Four tabs**: Inbox (a danger `CounterBadge` carrying `attentionCount`, the same badge
 *   `App.tsx`'s `NavRail` shows today), Board, Search, Settings. `useHashRoute()` is this
 *   component's only navigation state — `tabForRoute`/`routeForTab` (`compactRoute.ts`)
 *   translate between the active route and which tab reads as selected in `BottomTabBar`.
 * - **Screens are placeholders where a later step owns the real one**:
 *   - `inbox` → `<CompactInbox />` (F3.3): its own urgency-sorted list and tap-to-open detail,
 *     not the wide `<Attention />` list.
 *   - `board` and `card` routes both render `BoardScreen` (gated by `boardIsReady`,
 *     `<SyncCurtain>` otherwise), with its `compact` prop set (F3.5) — one `ColumnSwitcher`
 *     tab's worth of cards instead of the wide layout's five side-by-side columns.
 *     `activeCompactColumn` resolves which column that is: a `board` route's own column, or
 *     a `card` route's card's column with that card selected on it (used for the column
 *     this screen falls back to, both as `compact.onOpenCard`'s board-tab tile and as the
 *     Back fallback below). A `card` route additionally sets `compact.card` (F3.7):
 *     `BoardScreen` renders `CompactCardScreen` full-screen in place of the column — Chat,
 *     Steps, Changes, Details as top tabs over `TaskDetail`'s own sections — rather than
 *     this board-with-a-card-highlighted stand-in. A tab change on that screen calls
 *     `navigate` with `{replace: true}` (the same open card, a new section — never a push,
 *     so tapping through all four tabs does not grow history by four); Back calls
 *     `goBackFromCard` with the board route for `activeColumn` as its fallback. The bottom
 *     tab bar is omitted for a `card` route (`CompactShell`'s `tabBar` is optional for
 *     exactly this) — the card screen draws its own Back + title bar in its place, and
 *     `tabForRoute` still folds `card` onto `board` for the one case a tab bar IS showing
 *     (there is none to highlight here, but `useHashRoute`'s route still answers the same
 *     way if something else asks).
 *   - `search` → a Fluent `Input` plus result rows from `searchCards(Object.values(
 *     board.state.tasks), query)` (`CloudBoardState.tasks` is keyed by id, not an array);
 *     tapping a row navigates to `#/card/<id>/chat` (the `chat` section is the default
 *     `parseCompactRoute` already gives a bare card id).
 *   - `settings` → a **Sign out** button above the unchanged `SettingsScreen` — the wide
 *     rail's Account dropdown (where sign-out lives today) has no compact equivalent, so this
 *     is its only other home. No gate of any kind in front of it: a signed-in tab can always
 *     reach the control that signs it out.
 * - **No `transport.invoke` anywhere in this file or in `StatusStrip`.** The only relayed
 *   read in the compact tree is `attentionCount`'s existing `attention:list` effect, which
 *   already lives in `SignedInBoard` and is passed in rather than re-fetched here — this
 *   component gates nothing on a relay of its own.
 */
import { useState } from 'react';
import { Button, CounterBadge, Input, makeStyles } from '@fluentui/react-components';
import {
  AlertRegular,
  SearchRegular,
  SettingsRegular,
  TaskListSquareLtrRegular,
} from '@fluentui/react-icons';
import type { ClientPresence } from '@tm/protocol/wire';
import { BOARD_COLUMNS } from '@tm/shared/model';
import { columnForTask } from '@tm/shared/board';
import { activeCompactColumn } from '@tm/ui/board/compactColumns';
import { BottomTabBar, type BottomTabBarItem } from '@tm/ui/shell/BottomTabBar';
import { CompactShell } from '@tm/ui/shell/CompactShell';
import { CompactInbox } from '@tm/ui/CompactInbox';
import { SyncCurtain } from '@tm/ui/SyncCurtain';
import { routeForTab, tabForRoute, type CompactTab } from '@tm/ui/layout/compactRoute';
import { activityGate } from '../activity/activityGate';
import { BoardScreen } from '../board/BoardScreen';
import { worstConnectionState } from '../board/connectionState';
import type { DesktopPresence } from '../board/desktopPresence';
import { boardIsReady, syncBusyLabel, syncCurtainText, syncStatusLabel } from '../board/syncGate';
import type { VersionSkew } from '../board/targetClient';
import type { CloudBoardApi } from '../board/useCloudBoard';
import { SettingsScreen } from '../settings/SettingsScreen';
import { searchCards } from './searchCards';
import { StatusStrip } from './StatusStrip';
import { useHashRoute } from './useHashRoute';

const useStyles = makeStyles({
  search: { display: 'flex', flexDirection: 'column', gap: '8px', padding: '12px' },
  results: { display: 'flex', flexDirection: 'column', gap: '4px' },
  resultRow: { justifyContent: 'flex-start', textAlign: 'left' },
  settings: { display: 'flex', flexDirection: 'column' },
  signOut: { alignSelf: 'flex-end', margin: '8px' },
});

export interface CompactAppProps {
  board: CloudBoardApi;
  /** This tab's own read of whether a desktop Client is out there — see
   *  `desktopPresence.ts`. */
  presence: DesktopPresence;
  /** `versionSkew(board.targetClient)` — `null` when there is no mismatch to report. */
  skew: VersionSkew | null;
  attentionCount: number;
  /** The slow tick `App.tsx` already runs, so the strip's "synced Ns ago" keeps counting up
   *  between polls without this component starting a second timer. */
  now: number;
  /** The same delayed busy flag `App.tsx`'s status bar reads — a relay or a draining page
   *  still in flight. */
  busy: boolean;
  /** Where `SettingsScreen`'s token section and `Fleet`-style REST calls post to — this
   *  tab's `config.cloudApiBase`. */
  apiBase: string;
  /** This tab's own bearer — `AuthedApp`'s `auth.getAccessToken`. */
  getAccessToken: () => Promise<string | null>;
  /** Already clears the stored refresh token and flips `useCloudAuth`'s own state — see
   *  `App.tsx`'s identical prop on `SignedInBoard`. */
  onSignOut: () => void;
}

export function CompactApp({
  board,
  presence,
  skew,
  attentionCount,
  now,
  busy,
  apiBase,
  getAccessToken,
  onSignOut,
}: CompactAppProps): JSX.Element {
  const styles = useStyles();
  const client: ClientPresence | null = board.targetClient;
  const [route, navigate, goBackFromCard] = useHashRoute();
  const [query, setQuery] = useState('');

  // The column a `card` route's own card sits on — undefined when the route carries no
  // card, or the id names no task this tab has a mirrored row for yet (`activeCompactColumn`
  // falls back to the first column either way). No `hiddenBoardColumns` filtering here: this
  // tab has no settings of its own (`useBoardExtras` is `BoardScreen`'s alone), so the full
  // column order stands in for "visible" — a column hidden on the desktop simply never gets
  // picked by a `board` route's own column either, since `routeForTab`/`BottomTabBar` never
  // offer one.
  const routeTask = route.kind === 'card' ? board.state.tasks[route.id] : undefined;
  const activeColumn = activeCompactColumn(
    route,
    BOARD_COLUMNS,
    routeTask && columnForTask(routeTask),
  );

  const connection = worstConnectionState(
    board.pollError,
    presence === 'offline' ? { everSeenClient: board.targetClientId !== null } : null,
    skew && client ? { skew, client } : null,
  );

  // The Changes pane's own read of the same three signals (F6.13) — see `App.tsx`'s identical
  // computation for the wide layout.
  const reviewGate = activityGate({
    pollError: board.pollError,
    presence,
    targetClientId: board.targetClientId,
  });
  const hostUnreachable = reviewGate.kind === 'unreachable' ? reviewGate.message : undefined;
  // A relay or draining page still in flight outranks the plain poll age here too, same as
  // the wide status bar's separate `StatusBusy` — the strip has no second line to put it on.
  const busyLabel = busy ? syncBusyLabel(board.syncProgress, board.pendingRelays) : null;
  const syncLabel = board.pollError
    ? 'not syncing'
    : (busyLabel ?? syncStatusLabel(board.syncProgress, board.lastPolledAt, now));

  const tabs: readonly BottomTabBarItem[] = [
    {
      id: 'inbox',
      label: 'Inbox',
      icon: <AlertRegular />,
      badge: attentionCount > 0 && (
        <CounterBadge count={attentionCount} color="danger" size="small" appearance="filled" />
      ),
    },
    { id: 'board', label: 'Board', icon: <TaskListSquareLtrRegular /> },
    { id: 'search', label: 'Search', icon: <SearchRegular /> },
    { id: 'settings', label: 'Settings', icon: <SettingsRegular /> },
  ];

  return (
    <CompactShell
      strip={<StatusStrip connection={connection} client={client} syncLabel={syncLabel} />}
      // Omitted entirely for a full-screen card route — `CompactCardScreen` draws its own
      // Back + title bar in its place, and there is no tab to highlight behind it anyway.
      tabBar={
        route.kind === 'card' ? undefined : (
          <BottomTabBar
            items={tabs}
            selected={tabForRoute(route)}
            onSelect={(id) => navigate(routeForTab(id as CompactTab))}
            attention={attentionCount > 0}
          />
        )
      }
    >
      {route.kind === 'inbox' && <CompactInbox />}

      {(route.kind === 'board' || route.kind === 'card') &&
        (boardIsReady(board.syncProgress) ? (
          <BoardScreen
            state={board.state}
            onMoveTask={(taskId, column) => board.moveTask(taskId, column)}
            onStatusNoted={board.noteStatus}
            compact={{
              column: activeColumn,
              onColumnChange: (column) => navigate({ kind: 'board', column }),
              onOpenCard: (id) => navigate({ kind: 'card', id, section: 'chat' }),
              card:
                route.kind === 'card'
                  ? {
                      id: route.id,
                      section: route.section,
                      // The same open card, a new section — a push here would let four
                      // taps across the tabs grow history by four, and Back would have to
                      // walk back through each one instead of leaving the card.
                      onSectionChange: (section) =>
                        navigate({ kind: 'card', id: route.id, section }, { replace: true }),
                      onBack: () =>
                        goBackFromCard({
                          kind: 'board',
                          column: activeColumn ?? BOARD_COLUMNS[0],
                        }),
                    }
                  : undefined,
            }}
            hostUnreachable={hostUnreachable}
          />
        ) : (
          <SyncCurtain
            {...syncCurtainText(board.syncProgress)}
            error={board.syncProgress.lastError}
          />
        ))}

      {route.kind === 'search' && (
        <div className={styles.search}>
          <Input
            value={query}
            onChange={(_e, d) => setQuery(d.value)}
            placeholder="Search title or ticket key"
          />
          <div className={styles.results}>
            {searchCards(Object.values(board.state.tasks), query).map((task) => (
              <Button
                key={task.id}
                appearance="subtle"
                className={styles.resultRow}
                onClick={() => navigate({ kind: 'card', id: task.id, section: 'chat' })}
              >
                {task.ticketKey ? `${task.ticketKey} · ${task.title}` : task.title}
              </Button>
            ))}
          </div>
        </div>
      )}

      {route.kind === 'settings' && (
        <div className={styles.settings}>
          <Button className={styles.signOut} onClick={onSignOut}>
            Sign out
          </Button>
          <SettingsScreen
            projects={board.state.projects}
            apiBase={apiBase}
            getAccessToken={getAccessToken}
          />
        </div>
      )}
    </CompactShell>
  );
}
