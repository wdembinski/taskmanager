import { laterActivityCursor, type ActivityCursor } from '@tm/shared/activity';

/**
 * The localStorage key holding one desktop's last-seen cursor, namespaced per desktop so
 * switching the target Client (`ClientPicker`) reads THAT desktop's own baseline rather
 * than whichever desktop this tab was pointed at last.
 */
export function webLastSeenKey(desktopId: string): string {
  return `tm.activity.lastSeen.${desktopId}`;
}

function isActivityCursor(value: unknown): value is ActivityCursor {
  return (
    typeof value === 'object' &&
    value !== null &&
    Number.isFinite((value as { at: unknown }).at) &&
    Number.isFinite((value as { id: unknown }).id)
  );
}

/**
 * Reads the persisted cursor for one desktop, or null — on a first visit, a corrupt stored
 * value, or a null `desktopId` (nothing to key the lookup against yet, the same reading
 * `activityGate` gives a tab with no target Client). Never throws: a `Storage` that throws
 * on `getItem` (private browsing, a disabled store) reads exactly like an empty one.
 */
export function readWebLastSeen(storage: Storage, desktopId: string | null): ActivityCursor | null {
  if (desktopId === null) return null;
  try {
    const raw = storage.getItem(webLastSeenKey(desktopId));
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    return isActivityCursor(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Persists `reported` for one desktop, forward-only — `laterActivityCursor` is the same
 * `max(stored, reported)` rule the desktop's own `activity:setLastSeen` applies (F2.13), so
 * a feed narrowed by a filter can never regress a cursor a wider view already advanced.
 * Returns the cursor that is now current, which `useWebLastSeen`'s `onSeen` stores directly
 * rather than re-deriving it.
 *
 * A null `desktopId` never writes — there is no per-desktop key to write to — but still
 * returns `reported`, since `laterActivityCursor(null, reported)` is `reported` anyway. A
 * `Storage` whose `setItem` throws loses the persistence, not the return value: the caller's
 * in-memory cursor still advances.
 */
export function saveWebLastSeen(
  storage: Storage,
  desktopId: string | null,
  reported: ActivityCursor,
): ActivityCursor {
  if (desktopId === null) return reported;
  const next = laterActivityCursor(readWebLastSeen(storage, desktopId), reported);
  try {
    storage.setItem(webLastSeenKey(desktopId), JSON.stringify(next));
  } catch {
    // Swallowed on purpose — see this function's own docstring.
  }
  return next;
}
