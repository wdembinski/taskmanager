/**
 * The wiring `navStack.ts`'s own header points to: turns the pure reducer into an installed
 * PWA's actual Back behaviour.
 *
 * Every `push` calls `history.pushState` carrying the frame's depth (not the frame itself —
 * the frame lives in React state; the history entry only needs to say how deep it is) so a
 * hardware/gesture Back's `popstate` knows how far to unwind the reducer's stack. `back()`
 * itself never touches the reducer directly: it calls `history.back()` and lets the resulting
 * `popstate` do it, so an in-app close button (a dialog's X, a task screen's chevron) and
 * Android's own Back key run through the exact same path and can never fall out of sync with
 * each other.
 *
 * At the root frame, `back()` — and the hardware key itself — fall through to whatever history
 * exists before this app's own first entry, which for an installed PWA launched from the home
 * screen is nothing: the app exits. That is the correct behaviour and needs no code here.
 */
import { useCallback, useEffect, useReducer } from 'react';
import { navStackReducer, type NavFrame, type NavStack } from './navStack';

interface NavHistoryState {
  tmNavDepth: number;
}

function depthOf(stack: NavStack): number {
  return stack.length - 1;
}

export interface BackStack {
  stack: NavStack;
  push: (frame: NavFrame) => void;
  back: () => void;
}

export function useBackStack(root: NavFrame): BackStack {
  const [stack, dispatch] = useReducer(navStackReducer, [root]);

  useEffect(() => {
    history.replaceState({ tmNavDepth: 0 } satisfies NavHistoryState, '');
  }, []);

  useEffect(() => {
    function onPopState(event: PopStateEvent): void {
      const state = event.state as NavHistoryState | null;
      dispatch({ type: 'popTo', depth: state?.tmNavDepth ?? 0 });
    }
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  const push = useCallback(
    (frame: NavFrame) => {
      history.pushState({ tmNavDepth: depthOf(stack) + 1 } satisfies NavHistoryState, '');
      dispatch({ type: 'push', frame });
    },
    [stack],
  );

  const back = useCallback(() => {
    history.back();
  }, []);

  return { stack, push, back };
}
