/**
 * windowState — deciding where the window should open, as a pure function.
 *
 * Restoring a saved rectangle is only trivial while the monitors stay put. The cases
 * that matter are the ones where they don't: a window saved on a second display that
 * has since been unplugged, a window dragged half off the edge of its screen, a screen
 * that shrank between runs. Electron will happily honour any of those and put the app
 * somewhere the user cannot see or grab it — so the saved value is treated as a
 * *suggestion* and reconciled against the work areas that actually exist right now.
 *
 * The size and the position are restored independently on purpose. Undocking a laptop
 * should not cost you the window size you chose; it should only cost you the position,
 * which no longer refers to anything. So a rejected position returns `bounds: null`
 * with `size` still filled in, and the caller resizes but lets Electron centre.
 *
 * Deliberately Electron-free (it takes plain rectangles) so it can be unit-tested;
 * `ipc.ts` supplies `screen.getAllDisplays().map(d => d.workArea)`.
 */

/** The same shape as Electron's `Rectangle`, restated so this module imports nothing. */
export interface WindowRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WindowSize {
  width: number;
  height: number;
}

/** What the window was doing when we last looked. Stored under `app_state`. */
export interface SavedWindowState {
  bounds: WindowRect | null;
  maximized: boolean;
}

/** The reconciled answer: what to apply to a freshly created window. */
export interface RestoredWindowState {
  /** Position + size to apply, or null when the position could not be trusted. */
  bounds: WindowRect | null;
  /** Size to apply even when `bounds` is null, or null when nothing was saved. */
  size: WindowSize | null;
  maximized: boolean;
}

export interface WindowStateDefaults {
  minWidth: number;
  minHeight: number;
}

/**
 * How much of the window has to land on a real work area, on each axis, before we
 * accept the saved position. A window peeking out by a few pixels is fine; one with
 * 40px on screen is not draggable in practice on any platform we ship to.
 */
const MIN_VISIBLE = 96;

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function readRect(value: unknown): WindowRect | null {
  if (!value || typeof value !== 'object') return null;
  const r = value as Record<string, unknown>;
  if (!isFiniteNumber(r.x) || !isFiniteNumber(r.y)) return null;
  if (!isFiniteNumber(r.width) || !isFiniteNumber(r.height)) return null;
  if (r.width <= 0 || r.height <= 0) return null;
  return { x: r.x, y: r.y, width: r.width, height: r.height };
}

/** Overlap of two 1-D spans, in pixels (0 when they don't touch). */
function overlap(aStart: number, aSize: number, bStart: number, bSize: number): number {
  return Math.max(0, Math.min(aStart + aSize, bStart + bSize) - Math.max(aStart, bStart));
}

/** Reconcile a saved window state with the displays that exist now. */
export function sanitizeWindowState(
  saved: unknown,
  workAreas: readonly WindowRect[],
  defaults: WindowStateDefaults,
): RestoredWindowState {
  if (!saved || typeof saved !== 'object') return { bounds: null, size: null, maximized: false };
  const raw = saved as Record<string, unknown>;
  const maximized = raw.maximized === true;
  const rect = readRect(raw.bounds);
  if (!rect) return { bounds: null, size: null, maximized };

  // Clamp the size: never below the window's own minimums, never bigger than the
  // largest work area available (a 4K-sized window restored onto a laptop panel is
  // unusable, and the WM's own clamping happens too late to keep the position sane).
  const widest = workAreas.length ? Math.max(...workAreas.map((a) => a.width)) : rect.width;
  const tallest = workAreas.length ? Math.max(...workAreas.map((a) => a.height)) : rect.height;
  const width = Math.round(
    Math.min(Math.max(rect.width, defaults.minWidth), Math.max(widest, defaults.minWidth)),
  );
  const height = Math.round(
    Math.min(Math.max(rect.height, defaults.minHeight), Math.max(tallest, defaults.minHeight)),
  );
  const size: WindowSize = { width, height };
  if (workAreas.length === 0) return { bounds: null, size, maximized };

  // Pick the work area the window overlaps most; that's the display it "belongs" to.
  let best: WindowRect | null = null;
  let bestArea = 0;
  for (const area of workAreas) {
    const covered =
      overlap(rect.x, width, area.x, area.width) * overlap(rect.y, height, area.y, area.height);
    if (covered > bestArea) {
      bestArea = covered;
      best = area;
    }
  }

  // Nothing meaningful on screen — most often the display it was saved on is gone.
  // Keep the size, drop the position, and let Electron centre it.
  if (!best) return { bounds: null, size, maximized };
  const visibleX = overlap(rect.x, width, best.x, best.width);
  const visibleY = overlap(rect.y, height, best.y, best.height);
  if (visibleX < Math.min(MIN_VISIBLE, width) || visibleY < Math.min(MIN_VISIBLE, height)) {
    return { bounds: null, size, maximized };
  }

  // It overlaps enough to keep, but may still hang off an edge — translate it back in.
  // `Math.max` after `Math.min` so a window wider than its work area still starts at the
  // area's own origin rather than being pushed left of it.
  const x = Math.round(Math.max(best.x, Math.min(rect.x, best.x + best.width - width)));
  const y = Math.round(Math.max(best.y, Math.min(rect.y, best.y + best.height - height)));
  return { bounds: { x, y, width, height }, size, maximized };
}
