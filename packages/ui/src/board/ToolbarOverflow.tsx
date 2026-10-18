/**
 * The board toolbar's "···" menu (F13.21) — Fluent's own `Overflow` primitive, so a toolbar
 * that no longer fits hides whatever is left over behind one button instead of wrapping onto
 * a second or third row (the 2026-10-18 screenshot review: two rows at 1440, three at 1100).
 *
 * `<Overflow>` clones a SINGLE child (the toolbar row itself) and tracks, via a
 * `ResizeObserver`, which of its `OverflowItem`-wrapped descendants no longer fit — those get
 * `[data-overflowing]` and the Griffel rule `Overflow` injects hides them. It does not touch
 * the row's own CSS (no `flexWrap`/`overflow`), so the host's `layout.toolbar` carries that
 * (`boardLayout.ts`).
 *
 * Both hosts (`MyTasks.tsx`, the web's `BoardScreen.tsx`/`BoardToolbar.tsx`) share this file
 * rather than each rolling its own menu — the two toolbars list the same controls in the same
 * order, and a menu built twice would drift the moment one host changed a label.
 *
 * **Every real control must be an `OverflowItem`, the always-visible ones included — use
 * `pinned`, never leave one unwrapped.** The overflow manager's `occupiedSize()`
 * (`@fluentui/priority-overflow`'s `overflowManager.js`) only ever sums the width of
 * REGISTERED items against the container's full `clientWidth`; a plain child is invisible to
 * that budget, so the row would keep every registered item visible regardless of how much
 * width the unregistered one had already spent, and overflow the viewport instead of hiding
 * behind the menu — this is exactly the bug the first version of this fix shipped with
 * (scope Dropdown/Done switch/Add task left unwrapped "because they're pinned anyway").
 * `pinned` is what actually keeps an item visible while still counting its width; a bare
 * unwrapped child does neither reliably. Only the spacer (`layout.grow`, `flex: 1`) should
 * stay unregistered — its width is not a fixed cost to budget for.
 *
 * **Every `OverflowItem` child must forward its ref to a real DOM node** (a Fluent component,
 * or your own wrapped in `React.forwardRef`) — `OverflowItem` clones its child and attaches a
 * ref to measure and hide it; a plain function component drops that ref silently (no error,
 * no warning worth noticing) and the item just never registers, invisible to both the row and
 * the "···" menu. `LinkModeSwitch` shipped this bug once already — see its own comment.
 *
 * **`occupiedSize()` does not count the row's `gap`, nor the "···" button's own width before
 * it first mounts.** `@fluentui/priority-overflow`'s `overflowManager.js` sums only each
 * registered item's `offsetWidth` against `container.clientWidth - padding` (default `10`) —
 * CSS `gap` between flex items, and the menu button's width before `isOverflowing` first
 * flips true, are both invisible to that sum. With `layout.toolbar`'s `gap: '10px'` and up to
 * ~9 items, that is ~90px the row visibly needs but the manager never budgets for — exactly
 * why nothing ever got marked `[data-overflowing]` despite overflowing by ~50px in testing.
 * `TOOLBAR_OVERFLOW_PADDING` below reserves for the worst case (every optional item visible);
 * pass it to every `<Overflow padding={...}>` in this file's hosts.
 *
 * **`pinned` items are never hidden, full stop — if the ones you pin cannot fit together with
 * the "···" button itself, the row overflows its own box instead.** `padding` only biases the
 * MANAGER's bookkeeping of which items to mark `[data-overflowing]`; it does not shrink what
 * CSS actually lays out. With the detail pane open narrowing the board to ~450px, pinning the
 * scope Dropdown (its own ~250px, by far the widest control) alongside the Done switch and Add
 * task left nothing left to hide once every other control already had — the menu button itself
 * then rendered past the row's right edge and `overflow: hidden` clipped it, invisible rather
 * than offered. Keep `pinned` for controls narrow enough to always coexist with the menu
 * button (Done, Add task); give a wide one like the scope Dropdown a high `priority` instead,
 * so it is the LAST to hide rather than NEVER — with a `ToolbarOverflowMenuGroup` fallback, so
 * losing the row still leaves it reachable.
 *
 * **Some Fluent components forward their ref to an INNER element, not their own outermost
 * node — wrap those in a plain `<div>` before handing them to `OverflowItem`.** `Dropdown`
 * renders a wrapper `<div>` around the actual combobox `<button>` it forwards a ref to;
 * `OverflowItem` clones the element it is GIVEN and attaches `data-overflowing` there, so a
 * bare `<Dropdown>` ends up with the attribute on the button while the wrapper around it —
 * border included — has no idea it is supposed to disappear too, and survives as a stray line
 * once the button inside it collapses to nothing. A `<div>` has no such wrapper of its own to
 * leak.
 */
import type { ReactNode } from 'react';
import {
  Menu,
  MenuButton,
  MenuItem,
  MenuList,
  MenuPopover,
  MenuTrigger,
  useIsOverflowItemVisible,
  useOverflowMenu,
} from '@fluentui/react-components';
import { MoreHorizontalRegular } from '@fluentui/react-icons';

/**
 * `<Overflow padding={...}>` for both hosts — see this file's own doc comment for why the
 * default `10` undercounts: up to 9 toolbar items × `layout.toolbar`'s `10px` gap (8 gaps
 * once the row itself is excluded ≈ 80px) plus the "···" button's own ~36px before it has
 * mounted once, plus a little slack. Sized for the worst case (every optional control
 * present) — once some are already hidden the row has more real room than this reserves,
 * which only means the row hides a control slightly before it strictly had to, never the
 * reverse.
 */
export const TOOLBAR_OVERFLOW_PADDING = 130;

/**
 * One control's fallback inside the "···" menu — rendered only while the toolbar row itself
 * is hiding the `OverflowItem` of the same `id`, so a control is never offered twice.
 */
export function ToolbarOverflowMenuItem({
  id,
  onClick,
  children,
}: {
  id: string;
  onClick: () => void;
  children: ReactNode;
}): JSX.Element | null {
  const isVisible = useIsOverflowItemVisible(id);
  if (isVisible) return null;
  return <MenuItem onClick={onClick}>{children}</MenuItem>;
}

/**
 * The same gate as `ToolbarOverflowMenuItem`, for a control whose fallback needs more than one
 * `MenuItem` — the board-scope Dropdown's own options, one `MenuItem` per board, rather than a
 * single click target.
 */
export function ToolbarOverflowMenuGroup({
  id,
  children,
}: {
  id: string;
  children: ReactNode;
}): JSX.Element | null {
  const isVisible = useIsOverflowItemVisible(id);
  if (isVisible) return null;
  return <>{children}</>;
}

/** The "···" button itself — absent while every control still fits in the row. */
export function ToolbarOverflowMenu({ children }: { children: ReactNode }): JSX.Element | null {
  const { ref, isOverflowing, overflowCount } = useOverflowMenu<HTMLButtonElement>();
  if (!isOverflowing) return null;
  return (
    <Menu>
      <MenuTrigger disableButtonEnhancement>
        <MenuButton
          ref={ref}
          size="small"
          appearance="subtle"
          icon={<MoreHorizontalRegular />}
          aria-label={`${overflowCount} more toolbar controls`}
        />
      </MenuTrigger>
      <MenuPopover>
        <MenuList>{children}</MenuList>
      </MenuPopover>
    </Menu>
  );
}
