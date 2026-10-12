/**
 * The compact shell's own router (F3.2): a tiny hash grammar covering all four bottom tabs
 * plus a card's detail sections, so the phone's back button works everywhere rather than
 * only inside the board. Shared out of `@tm/ui` rather than kept in `apps/web` because
 * F3.5/F3.6's compact board/card components will navigate with it too, and a route parser
 * two hosts both need is exactly the kind of thing that drifts if it is copied instead of
 * imported.
 *
 * ## Design decisions fixed here (do not re-derive in later edits)
 *
 * - **Grammar**, with or without the leading `#` (a caller may pass `location.hash`, which
 *   always has one, or a bare path):
 *   - `''` / `'#'` / `'#/'` → `{kind:'inbox'}` — the home tab has no segment of its own.
 *   - `'#/board'` → `{kind:'board', column: BOARD_COLUMNS[0]}` (`'todo'`); `'#/board/<col>'`
 *     → that column, when `<col>` is one of `BOARD_COLUMNS`.
 *   - `'#/card/<id>'` → `{kind:'card', id, section:'chat'}`; `'#/card/<id>/<section>'` → that
 *     section, when `<section>` is one of `CARD_SECTIONS`.
 *   - `'#/search'` → `{kind:'search'}`; `'#/settings'` → `{kind:'settings'}`.
 *   - Every other shape is malformed. That includes: an unknown first segment (`'inbox'` is
 *     never itself a valid segment — the home route has NO segment, so `'#/inbox'` is just as
 *     invalid as `'#/nope'`); an unknown column or section; an empty id (`'#/card/'`); a bad
 *     percent-encoding in the id; and trailing segments beyond what each kind accepts
 *     (`'#/card/x/chat/extra'`, `'#/inbox/extra'`, `'#/board/todo/extra'`).
 * - **`parseCompactRoute` returns `null` for anything malformed** rather than a default —
 *   the caller decides what "unknown" means (`DEFAULT_COMPACT_ROUTE`, below) and whether to
 *   rewrite history over it. An id segment is `decodeURIComponent`'d inside a `try`/`catch`;
 *   a throw (a lone `%`, a truncated escape) is one more reason to return `null`.
 * - **`DEFAULT_COMPACT_ROUTE = {kind:'inbox'}`.** Callers do `parse(hash) ?? DEFAULT`, never
 *   their own fallback literal, so the one place that decides "what does nonsense resolve
 *   to" stays this file.
 * - **`formatCompactRoute` is the exact inverse of the valid grammar above** — it always
 *   emits the fully-qualified form (`'#/board/todo'`, never the bare `'#/board'`; `'#/card/<id>/chat'`,
 *   never the bare two-segment form), and `encodeURIComponent`s the id, so
 *   `parseCompactRoute(formatCompactRoute(r))` round-trips `r` for every column, every
 *   section, and an id containing `/` or spaces.
 * - **Tab mapping.** `tabForRoute` folds `card` onto `board` (a card is drawn over the board,
 *   so its tab stays highlighted) and is the identity on the other three kinds.
 *   `routeForTab` is its rough inverse for the three tabs that are a single screen each
 *   (`inbox`/`search`/`settings`); `routeForTab('board')` is `{kind:'board', column:
 *   BOARD_COLUMNS[0]}` — tapping the Board tab always lands on the first column, never on
 *   whatever column a previous card route happened to carry.
 */
import { BOARD_COLUMNS, type BoardColumn } from '@tm/shared/model';

/** The four panes a card's detail view is split into in the compact shell. */
export type CardSection = 'chat' | 'steps' | 'changes' | 'details';

/** Every {@link CardSection}, in the order its own tab strip draws them. */
export const CARD_SECTIONS: readonly CardSection[] = ['chat', 'steps', 'changes', 'details'];

/**
 * Every screen the compact shell's hash can address. `board` and `card` carry just enough
 * state to restore the right column/section on a reload or a back-navigation; `search` and
 * `settings` carry none because each is a single screen with no sub-state of its own.
 */
export type CompactRoute =
  | { kind: 'inbox' }
  | { kind: 'board'; column: BoardColumn }
  | { kind: 'card'; id: string; section: CardSection }
  | { kind: 'search' }
  | { kind: 'settings' };

/** What an empty, missing, or malformed hash resolves to. See the module header. */
export const DEFAULT_COMPACT_ROUTE: CompactRoute = { kind: 'inbox' };

/** The four bottom tabs. A `card` route has no tab of its own — see {@link tabForRoute}. */
export type CompactTab = 'inbox' | 'board' | 'search' | 'settings';

/**
 * Parses a hash (with or without its leading `#`) into a {@link CompactRoute}, or `null` for
 * anything the grammar in the module header does not cover. Never throws — a bad
 * percent-escape in an id is one more malformed shape, not an exception the caller must
 * handle.
 */
export function parseCompactRoute(hash: string): CompactRoute | null {
  const path = hash.startsWith('#') ? hash.slice(1) : hash;
  const segments = path.split('/').filter((s) => s.length > 0);

  if (segments.length === 0) return { kind: 'inbox' };

  const [first, ...rest] = segments;
  switch (first) {
    case 'board': {
      if (rest.length === 0) return { kind: 'board', column: BOARD_COLUMNS[0] };
      if (rest.length === 1 && (BOARD_COLUMNS as readonly string[]).includes(rest[0])) {
        return { kind: 'board', column: rest[0] as BoardColumn };
      }
      return null;
    }
    case 'card': {
      if (rest.length < 1 || rest.length > 2 || rest[0].length === 0) return null;
      let id: string;
      try {
        id = decodeURIComponent(rest[0]);
      } catch {
        return null;
      }
      if (rest.length === 1) return { kind: 'card', id, section: 'chat' };
      if ((CARD_SECTIONS as readonly string[]).includes(rest[1])) {
        return { kind: 'card', id, section: rest[1] as CardSection };
      }
      return null;
    }
    case 'search':
      return rest.length === 0 ? { kind: 'search' } : null;
    case 'settings':
      return rest.length === 0 ? { kind: 'settings' } : null;
    default:
      return null;
  }
}

/**
 * The exact inverse of {@link parseCompactRoute} — always the fully-qualified form (an
 * explicit column, an explicit section), with the id `encodeURIComponent`'d. Round-trips
 * through {@link parseCompactRoute} for every {@link BoardColumn}/{@link CardSection} and any
 * id, including one containing `/` or spaces.
 */
export function formatCompactRoute(route: CompactRoute): string {
  switch (route.kind) {
    case 'inbox':
      return '#/';
    case 'board':
      return `#/board/${route.column}`;
    case 'card':
      return `#/card/${encodeURIComponent(route.id)}/${route.section}`;
    case 'search':
      return '#/search';
    case 'settings':
      return '#/settings';
  }
}

/** Which bottom tab should read as selected while `route` is showing — folds `card` onto
 *  `board`, identity otherwise. */
export function tabForRoute(route: CompactRoute): CompactTab {
  return route.kind === 'card' ? 'board' : route.kind;
}

/** The route a tap on `tab` navigates to — `board` always resets to `BOARD_COLUMNS[0]`,
 *  never a column left over from a previous card route. */
export function routeForTab(tab: CompactTab): CompactRoute {
  if (tab === 'board') return { kind: 'board', column: BOARD_COLUMNS[0] };
  return { kind: tab };
}
