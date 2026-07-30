/**
 * Ask main what a project folder's git looks like, while the add/edit form is still open.
 *
 * Debounced, because the agent-project drawer's path field is TYPEABLE and a `git` call per
 * keystroke over a WSL bridge is not free. Late answers are dropped rather than applied: the
 * path can change while a call is in flight, and showing the previous folder's verdict against
 * the current folder's path is worse than showing nothing.
 */
import { useEffect, useState } from 'react';
import type { GitPreflight } from '@shared/model';
import type { ExecTarget } from '@shared/execTarget';
import { formatExecTarget } from '@shared/execTarget';

/** Long enough to cover typing a path, short enough to feel like the form is answering. */
const DEBOUNCE_MS = 400;

export function useGitPreflight(
  path: string,
  target: ExecTarget,
  /** Skip entirely while the dialog is closed — no probing folders nobody is looking at. */
  active: boolean,
): GitPreflight | null {
  const [pre, setPre] = useState<GitPreflight | null>(null);
  // The target is an object rebuilt on every render, so it is depended on by VALUE — the
  // formatted string — or the effect would re-run forever.
  const targetKey = formatExecTarget(target);

  useEffect(() => {
    if (!active || !path.trim()) {
      setPre(null);
      return;
    }
    let live = true;
    const timer = setTimeout(() => {
      void window.api
        .invoke('project:gitPreflight', path, target)
        .then((result) => {
          if (live) setPre(result);
        })
        .catch(() => {
          // Advisory only: a preflight that fails must never disturb the form.
          if (live) setPre(null);
        });
    }, DEBOUNCE_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `target` via `targetKey`, see above
  }, [path, targetKey, active]);

  return pre;
}
