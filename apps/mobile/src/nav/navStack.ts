/**
 * What Android's hardware Back means, given where the app is — the piece of Phase 27 step 8
 * that is worth testing in isolation from the `popstate`/`history.pushState` wiring around it
 * (`useBackStack.ts`, one file over).
 *
 * A screen is not one flat value: it is a tab (`mytasks`/`performance`/`attention`/`settings`,
 * `App.tsx`'s own `Screen`) with, only on `mytasks`, at most one overlay on top of it — a task
 * opened full-screen, or one of the board's sheets/dialogs (`BoardScreen.tsx`: `GitGraphSheet`,
 * `AddTaskDialog`, `ArchivedCardsDialog`) — since each of those, once open, covers the toolbar
 * button that would open one of the others. Every frame the user pushed (a tab switch or an
 * overlay opening) stays in the stack until Back unwinds it, so switching tabs with a task open
 * and then going Back once returns to that same task rather than dropping it — the same "each
 * step is independently undoable" a native Back stack gives for free.
 */

export type Screen = 'mytasks' | 'performance' | 'attention' | 'settings';

export type NavFrame =
  | { type: 'tab'; screen: Screen }
  | { type: 'task'; taskId: string }
  | { type: 'addTask' }
  | { type: 'archived'; openedAt: number }
  | { type: 'graph' };

/** Never empty — the root frame (the initial tab) can be popped to but never off. */
export type NavStack = readonly NavFrame[];

export type NavAction = { type: 'push'; frame: NavFrame } | { type: 'popTo'; depth: number };

export function navStackReducer(stack: NavStack, action: NavAction): NavStack {
  switch (action.type) {
    case 'push':
      return [...stack, action.frame];
    case 'popTo': {
      const length = action.depth + 1;
      if (length < 1 || length > stack.length) return stack;
      return stack.slice(0, length);
    }
  }
}

/** The tab bar's selected value — the nearest `tab` frame at or below the stack's top. */
export function topScreen(stack: NavStack): Screen {
  for (let i = stack.length - 1; i >= 0; i--) {
    const frame = stack[i];
    if (frame.type === 'tab') return frame.screen;
  }
  return 'mytasks';
}

/** A frame that sits on top of the tab rather than being one — `BoardScreen.tsx`'s own overlays. */
export type Overlay = Exclude<NavFrame, { type: 'tab' }>;

/** The board overlay currently showing — `null` once nothing is pushed on top of the tab. */
export function topOverlay(stack: NavStack): Overlay | null {
  const top = stack[stack.length - 1];
  return top.type === 'tab' ? null : top;
}
