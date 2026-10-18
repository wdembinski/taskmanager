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

/**
 * Merges every reason a `ui-shots.mjs` run should not be trusted enough to attach into one
 * flat list: a row that failed outright, a row whose `expect` selector never showed up
 * (`result.selectorMissed`), and any shots that came out byte-identical despite different
 * names. `results` is the same array `ui-shots.mjs`'s own loop builds, each entry already
 * carrying `row`, `ok`, `error`, `selectorMissed`, `shotPath` and (once hashed) `hash`.
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
