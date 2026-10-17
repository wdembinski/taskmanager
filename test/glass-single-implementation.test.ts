/**
 * Glass is one CSS implementation, not a pattern every pane repeats — `GlassPane`'s own header
 * comment (`packages/ui/src/shell/GlassPane.tsx`) explains why: starting every pane from its
 * own `@supports`/`data-glass`/`forced-colors` trio is how "reduce transparency" quietly stops
 * covering a pane somebody added later, one `backdropFilter` at a time, with nothing red
 * anywhere. This file is the enforcement, not the explanation — it walks every workspace's own
 * sources and asserts that `GlassPane` is the only file in the repo that declares
 * `backdropFilter`/`backdrop-filter` at all.
 *
 * Lives at the repo root, beside `repo-invariants.test.ts` and `shell-parity.test.ts`, for the
 * same reason both of those do: the root `vitest.config.ts` sets no `include`, so vitest's
 * default glob collects this, which puts the guard on `pnpm test` — every gate anyone actually
 * runs (CONTRIBUTING.md §5, RELEASE.md §1). It is also the only place it *can* live: the rule
 * is about `apps/*` as much as `packages/ui`, and a `packages/ui` test only has its own
 * workspace in scope.
 *
 * The regex's colon is load-bearing. `\b(?:Webkit)?[Bb]ackdropFilter\s*:` matches a
 * `backdropFilter:`/`WebkitBackdropFilter:` object-literal declaration, but NOT
 * `appearance.ts`'s `backdropFilterSupported` flag — there's no colon immediately after
 * `Filter`, "Supported" is in the way. `backdrop-filter\s*:` matches the CSS property
 * declaration, but NOT the string literal inside `appearance.ts`'s
 * `CSS.supports('backdrop-filter', 'blur(1px)')` probe — a quote and a comma follow
 * `'backdrop-filter'`, never a colon. Comments are stripped before the regex ever runs, which
 * is what keeps `tokens.ts`'s doc comment (`backdrop-filter: blur(24px)`, prose about the
 * token table) from counting as a declaration.
 *
 * Proved red first: temporarily adding `backdropFilter: 'blur(2px)'` to an unrelated
 * `makeStyles` block elsewhere in `packages/ui/src` turned the first `it` red, naming that
 * file; reverting turned it green again.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The repo root, derived from this file rather than from cwd, so the run directory is free. */
const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

/** Every workspace that has its own sources — app and library alike. */
const SOURCE_TREES = [
  'apps/client/src',
  'apps/server/src',
  'apps/web/src',
  'packages/protocol/src',
  'packages/shared/src',
  'packages/ui/src',
];

/** The one file allowed to declare `backdropFilter`/`backdrop-filter`. */
const GLASS_PANE = 'packages/ui/src/shell/GlassPane.tsx';

const SOURCE_FILE = /\.(ts|tsx|css)$/;
const TEST_FILE = /\.test\./;

/** Every non-test `.ts`/`.tsx`/`.css` file under a tree, recursively and repo-relative. */
function filesUnder(tree: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(join(repoRoot, ...tree.split('/')), { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const path = `${tree}/${entry.name}`;
    if (entry.isDirectory()) {
      found.push(...filesUnder(path));
    } else if (SOURCE_FILE.test(entry.name) && !TEST_FILE.test(entry.name)) {
      found.push(path);
    }
  }
  return found;
}

/** Strips `/* … *\/` block comments and `//` line comments, so prose mentioning the property
 *  name can never read as a declaration. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

/** A `backdropFilter:`/`WebkitBackdropFilter:`/`backdrop-filter:` declaration — see this file's
 *  header comment for why the trailing colon excludes `backdropFilterSupported` and the
 *  `CSS.supports('backdrop-filter', …)` probe without naming either one specially. */
const DECLARES_BACKDROP_FILTER = /\b(?:Webkit)?[Bb]ackdropFilter\s*:|backdrop-filter\s*:/;

function filesDeclaringBackdropFilter(): string[] {
  const offenders: string[] = [];
  for (const tree of SOURCE_TREES) {
    for (const path of filesUnder(tree)) {
      const code = stripComments(readFileSync(join(repoRoot, ...path.split('/')), 'utf8'));
      if (DECLARES_BACKDROP_FILTER.test(code)) offenders.push(path);
    }
  }
  return offenders;
}

describe('glass stays one implementation', () => {
  it('declares backdropFilter/backdrop-filter nowhere but GlassPane', () => {
    expect(
      filesDeclaringBackdropFilter(),
      `Only ${GLASS_PANE} may declare backdropFilter/backdrop-filter — see useGlassStyles and ` +
        'its header comment for why glass is one CSS implementation. A match anywhere else is ' +
        'a second implementation that "reduce transparency" (data-glass="opaque") and ' +
        "forced-colors won't know to switch off.",
    ).toEqual([GLASS_PANE]);
  });

  it('keeps the fallback machinery in GlassPane: @supports, data-glass="opaque", forced-colors', () => {
    const source = readFileSync(join(repoRoot, ...GLASS_PANE.split('/')), 'utf8');

    expect(
      source,
      'GlassPane lost its @supports guard around backdrop-filter — see the file header for why ' +
        'the fallback must come first.',
    ).toMatch(/@supports/);

    expect(
      source,
      'GlassPane lost its `data-glass="opaque"` selector — "reduce transparency" would stop ' +
        'switching panes off.',
    ).toMatch(/data-glass="opaque"/);

    expect(
      source,
      'GlassPane lost its forced-colors fallback — Windows High Contrast would lose the pane rim.',
    ).toMatch(/forced-colors:\s*active/);
  });
});
