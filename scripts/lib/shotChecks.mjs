/**
 * Pure checks over a `ui-shots.mjs` run's results — kept out of that script because its
 * `main()` runs on import (see its own header), so importing it from a test would also build
 * both apps and launch headless Chrome. Collected by `shotChecks.test.mjs`.
 */

/**
 * Groups shots whose bytes are identical (same sha256) but whose names differ — most often a
 * `setup` step that silently did nothing, so the "after" shot is byte-for-byte the "before"
 * shot under a different name.
 *
 * `shots` is `[{ name, hash }]`. Returns one `{ hash, names }` per hash shared by two or more
 * differently-named shots, `names` in the order first seen; a hash that only one name produced
 * is not a duplicate of anything and is dropped.
 */
export function findDuplicateShots(shots) {
  const namesByHash = new Map();
  for (const { name, hash } of shots) {
    const names = namesByHash.get(hash) ?? [];
    if (!names.includes(name)) names.push(name);
    namesByHash.set(hash, names);
  }
  return [...namesByHash.entries()]
    .filter(([, names]) => names.length > 1)
    .map(([hash, names]) => ({ hash, names }));
}

/** How far past an edge still counts as "on" it, in CSS px — see `layoutProblems`. */
export const LAYOUT_TOLERANCE_PX = 0.5;

function describeRect({ top, left, bottom, right }) {
  return `{ top: ${top}, left: ${left}, bottom: ${bottom}, right: ${right} }`;
}

/**
 * Why a row's `layoutCheck` target is not laid out in full — empty when it is. Rects are
 * `{ top, left, bottom, right }` in CSS px, the shape `getBoundingClientRect()` answers.
 *
 * `target` must sit fully inside every rect in `clips` (each overflow-clipping ancestor, plus
 * the viewport): any part past one of them is cut off on screen. It must also not overlap any
 * rect in `avoid` (an element drawn over or under it) — sharing an edge is not an overlap, so
 * a heading sitting directly on top of the conversation is fine. Each `clips`/`avoid` entry may
 * carry a `label` naming it in the reason. Anything within `LAYOUT_TOLERANCE_PX` counts as
 * fitting — sub-pixel rounding of fractional layout is not a clipped heading.
 */
export function layoutProblems({ target, clips = [], avoid = [] }) {
  const reasons = [];
  const past = (a, b) => a - b > LAYOUT_TOLERANCE_PX;
  const px = (n) => `${Math.round(n * 10) / 10}px`;
  for (const clip of clips) {
    const cut = [];
    if (past(clip.top, target.top)) cut.push(`top by ${px(clip.top - target.top)}`);
    if (past(target.bottom, clip.bottom)) cut.push(`bottom by ${px(target.bottom - clip.bottom)}`);
    if (past(clip.left, target.left)) cut.push(`left by ${px(clip.left - target.left)}`);
    if (past(target.right, clip.right)) cut.push(`right by ${px(target.right - clip.right)}`);
    if (cut.length > 0) {
      reasons.push(`clipped by ${clip.label ?? describeRect(clip)} (${cut.join(', ')})`);
    }
  }
  for (const other of avoid) {
    const overlaps =
      past(target.right, other.left) &&
      past(other.right, target.left) &&
      past(target.bottom, other.top) &&
      past(other.bottom, target.top);
    if (overlaps) reasons.push(`overlaps ${other.label ?? describeRect(other)}`);
  }
  return reasons;
}

/**
 * Merges every reason a `ui-shots.mjs` run should not be trusted enough to attach into one
 * flat list: a row that failed outright, a row whose `expect` selector never showed up
 * (`result.selectorMissed`), a row whose `layoutCheck` target is clipped or overlapped
 * (`result.layoutProblem`, `layoutProblems`' own reasons), and any shots that came out
 * byte-identical despite different names. `results` is the same array `ui-shots.mjs`'s own
 * loop builds, each entry already carrying `row`, `ok`, `error`, `selectorMissed`,
 * `layoutProblem`, `shotPath` and (once hashed) `hash`.
 */
export function shotProblems(results) {
  const problems = [];

  for (const result of results) {
    if (!result.ok) {
      problems.push({
        kind: 'failed',
        name: result.row.name,
        message: result.error ? String(result.error.message ?? result.error) : 'failed',
      });
    }
    if (result.selectorMissed) {
      problems.push({
        kind: 'selectorMissed',
        name: result.row.name,
        selector: result.selectorMissed,
      });
    }
    if (result.layoutProblem && result.layoutProblem.length > 0) {
      problems.push({
        kind: 'layout',
        name: result.row.name,
        message: result.layoutProblem.join('; '),
      });
    }
  }

  const shots = results
    .filter((r) => r.shotPath && r.hash)
    .map((r) => ({ name: r.row.name, hash: r.hash }));
  for (const { names } of findDuplicateShots(shots)) {
    for (let i = 1; i < names.length; i++) {
      problems.push({ kind: 'duplicate', name: names[i], otherName: names[0] });
    }
  }

  return problems;
}
