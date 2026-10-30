/**
 * The pieces of `ui-shots.mjs`'s driver a second headless script also needs — moved here from
 * that file because importing it runs its own `main()` (and its top-level `loadScreens()`).
 * `perf-board.mjs` (F29.1) drives the same renderer through the same clicks, so both import
 * these instead of each keeping a copy that drifts.
 */
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * `window.__tm.clickText`/`findByText`, copied from `verify-mobile.mjs`'s own `PAGE_HELPERS_SRC`
 * rather than imported — that file keeps its copy private (it is a `*.mjs` script, not a
 * module either side imports), and the two have drifted apart before (`verify-mobile.mjs` also
 * tracks touch-target size, which this driver has no use for).
 */
export const PAGE_HELPERS_SRC = `
window.__tm = {
  visible(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && !!el.offsetParent;
  },
  candidates() {
    // 'label' added for a Fluent Switch (projects-merge-on-green): it renders an
    // <input type="checkbox" role="switch"> with its visible text in a sibling <label
    // htmlFor>, not in a button — clicking the label is how a real click toggles it too,
    // via the browser's own label-forwarding, so no Switch-specific click expression is
    // needed the way issue-row/board-card have their own.
    return Array.from(document.querySelectorAll('button, [role="menuitem"], [role="tab"], label'));
  },
  textOf(el) {
    const clone = el.cloneNode(true);
    clone.querySelectorAll('.fui-Tab__content--reserved-space').forEach((n) => n.remove());
    return (clone.textContent || '').trim();
  },
  namesOf(el) {
    return [this.textOf(el), el.getAttribute('aria-label') || '', el.getAttribute('title') || ''];
  },
  findByText(text, exact) {
    const matches = (el) =>
      this.visible(el) && this.namesOf(el).some((t) => (exact ? t === text : t.includes(text)));
    // An open Dropdown's <Option>s (role="option", project-form-merge-by) are tried only after
    // every other candidate missed — IssueRow rows are options too, and searched first they
    // would steal a click meant for a button whose text a row title happens to contain.
    return (
      this.candidates().find(matches) ||
      Array.from(document.querySelectorAll('[role="option"]')).find(matches)
    );
  },
  clickText(text, exact) {
    const el = this.findByText(text, exact);
    if (!el) return false;
    el.scrollIntoView({ block: 'center' });
    el.click();
    return true;
  },
};
`;

/** `{ click: 'treeitem:N' }` — the Nth visible `[role="treeitem"]` in the sidebar tree (0-based,
 *  document order, folded children excluded because they are never rendered). A tree ticket's
 *  title also appears on the board and in the issue list, so plain text matching lands there
 *  first; see `ui-shots.mjs`'s `SCREENS` doc comment. The tree is windowed (F29.3), so the
 *  Nth MOUNTED row is not the Nth row once the top has scrolled away: a row's own
 *  `data-index` (its place in the fold-aware flat list) is read first. */
export function treeItemClickExprs(index) {
  const find = `(document.querySelector('[role="treeitem"][data-index="${index}"]') ?? Array.from(document.querySelectorAll('[role="treeitem"]')).filter((el) => window.__tm.visible(el))[${index}])`;
  return {
    ready: `!!${find}`,
    click: `(() => {
      const el = ${find};
      if (!el) return false;
      el.scrollIntoView({ block: 'center' });
      el.click();
      return true;
    })()`,
  };
}

/** `{ click: 'board-card:ID' }` — see `ui-shots.mjs`'s `SCREENS` doc comment on why a board card
 *  is addressed by `TaskCard.tsx`'s own `[data-task-id]`, not by its title text. */
export function boardCardClickExprs(taskId) {
  const selector = JSON.stringify(`[data-task-id=${JSON.stringify(taskId)}]`);
  return {
    ready: `!!document.querySelector(${selector})`,
    click: `(() => {
      const el = document.querySelector(${selector});
      if (!el) return false;
      el.scrollIntoView({ block: 'center' });
      el.click();
      return true;
    })()`,
  };
}

/** `shots-board.mjs`'s own `buildClientRenderer`, generalized to a caller-supplied `outDir`. */
export function buildClientRenderer(requireFromClient, outDir) {
  const electronViteBin = join(
    dirname(requireFromClient.resolve('electron-vite/package.json')),
    'bin',
    'electron-vite.js',
  );
  const res = spawnSync(process.execPath, [electronViteBin, 'build', '--outDir', outDir], {
    cwd: join(root, 'apps', 'client'),
    stdio: 'inherit',
  });
  if (res.status !== 0) throw new Error('electron-vite build failed for @tm/client');
}
