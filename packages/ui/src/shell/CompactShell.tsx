/**
 * The compact shell's own frame (F3.2) — `AppShell`'s counterpart for a phone-width
 * viewport, not a reuse of it: `AppShell` lays a rail beside the content and a status bar
 * across the full width at the bottom, neither of which fits a single narrow column with a
 * tab bar of its own.
 *
 * ## Design decisions fixed here (do not re-derive in later edits)
 *
 * - **Three slots, top to bottom: `strip`, `children`, `tabBar`.** `strip` is the one-line
 *   connection/sync summary (`StatusStrip`) — `AppShell`'s `status` bar shrunk to a single
 *   line because a phone has no room for a second row of captions. `tabBar` is
 *   `BottomTabBar`, replacing `AppShell`'s side `nav`. There is no `banners` slot: the
 *   compact shell folds that into `strip` too (`worstConnectionState`/`connectionStripText`)
 *   rather than stacking a `MessageBar` above the content on a screen this narrow.
 * - **`height: 100%`, not `100dvh` of its own.** The dynamic-viewport sizing and the
 *   safe-area padding are already applied one level up, by `FluentProvider`'s own style in
 *   `apps/web/src/main.tsx` (F3.1) — repeating either here would double-apply the inset.
 * - **`children` is the only slot that scrolls.** `flex: 1; min-height: 0` on its wrapper, the
 *   same `flex`-child-needs-`minHeight: 0`-to-scroll rule `AppShell`'s own `content`/`body`
 *   already follow — `strip` and `tabBar` stay a fixed single line each, pinned top and
 *   bottom.
 * - **`tabBar` is optional (F3.7).** A full-screen card route (`CompactCardScreen`) has its
 *   own Back + title bar in its place, which is its own screen's business, not something
 *   this shell has to know the shape of — absent, the shell simply draws no third slot.
 * - **Bottom padding from `useKeyboardInset()`.** The one slot an on-screen keyboard can
 *   cover that nothing else already protects: `tabBar`, when present, already sits above a
 *   resized viewport; `strip` is pinned at the top where a keyboard never reaches. Applied
 *   to the shell as a whole rather than `tabBar` alone, so it still does its job on the one
 *   screen that renders without a `tabBar` at all — a full-screen card's own composer,
 *   pinned to `children`'s bottom edge with nothing else below it.
 */
import { makeStyles } from '@fluentui/react-components';
import type { ReactNode } from 'react';
import { useKeyboardInset } from '../layout/viewport';

const useStyles = makeStyles({
  shell: { display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' },
  body: { display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, overflow: 'auto' },
});

export interface CompactShellProps {
  /** The one-line connection/sync summary — see the module header. Pinned to the top. */
  strip: ReactNode;
  /** The current screen. The only slot that scrolls. */
  children: ReactNode;
  /** The four-tab bottom bar, pinned to the bottom — absent on a full-screen screen that
   *  draws its own navigation in its place (`CompactCardScreen`'s Back + title bar). */
  tabBar?: ReactNode;
}

export function CompactShell({ strip, children, tabBar }: CompactShellProps): JSX.Element {
  const styles = useStyles();
  const keyboardInset = useKeyboardInset();
  return (
    <div className={styles.shell} style={{ paddingBottom: keyboardInset }}>
      {strip}
      <div className={styles.body}>{children}</div>
      {tabBar}
    </div>
  );
}
