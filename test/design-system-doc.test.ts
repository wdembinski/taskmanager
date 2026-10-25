/**
 * The token table in `docs/14-design-system.md` is `tokens.ts`, not a copy of it. A contributor
 * reads that page before adding a screen; a table that drifted from the real values would send
 * them to the wrong colour with full confidence. So the doc carries the table between
 * `<!-- tokens:begin -->` and `<!-- tokens:end -->`, and this test rebuilds it from
 * `tokenCssVars('light')` / `tokenCssVars('dark')` — the projection the renderer itself stamps on
 * the provider root — and requires the doc's block to match byte for byte (CRLF normalised).
 * On a mismatch the failure prints the whole expected block, so updating the doc is a
 * copy-paste; there is no separate generator script to forget to run.
 *
 * Lives at the repo root, beside `theme-tokens.test.ts`, for the same reason that file does:
 * the root `vitest.config.ts` sets no `include`, so vitest's default glob collects this and puts
 * it on `pnpm test` — every gate anyone actually runs (CONTRIBUTING.md §5, RELEASE.md §1). And
 * the doc lives at the root, outside any workspace. Unlike the other root tests it imports
 * `packages/ui/src/tokens.ts` at runtime; its `@tm/shared/*` imports resolve to the built
 * `dist`, which `pnpm test` builds first.
 *
 * Proved red first: with the generated block pasted in, the test was green; temporarily
 * changing `SEMANTIC.light.textFaint` from `#646B74` to `#646B75` turned the first `it` red,
 * the diff naming the `--tm-text-faint` row; reverting it turned it green again.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tokenCssVars } from '../packages/ui/src/tokens';

/** The repo root, derived from this file rather than from cwd, so the run directory is free. */
const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

const DOC = 'docs/14-design-system.md';
const BEGIN = '<!-- tokens:begin -->';
const END = '<!-- tokens:end -->';

const light = tokenCssVars('light');
const dark = tokenCssVars('dark');
const names = Object.keys(light).sort() as (keyof typeof light)[];

/** The block as it must appear in the doc, markers included. */
function renderBlock(): string {
  const rows = names.map((name) => `| \`${name}\` | \`${light[name]}\` | \`${dark[name]}\` |`);
  return [BEGIN, '', '| Variable | Light | Dark |', '| --- | --- | --- |', ...rows, '', END].join(
    '\n',
  );
}

/** The doc's block, markers included, or `''` if the markers are missing. */
function readBlock(): string {
  const doc = readFileSync(join(repoRoot, DOC), 'utf8').replace(/\r\n/g, '\n');
  const start = doc.indexOf(BEGIN);
  const end = doc.indexOf(END);
  if (start < 0 || end < start) return '';
  return doc.slice(start, end + END.length);
}

describe(`${DOC} token table`, () => {
  it('matches tokenCssVars() exactly', () => {
    expect(Object.keys(dark).sort()).toEqual(names);
    const expected = renderBlock();
    expect(
      readBlock(),
      `${DOC}'s token table is out of date with packages/ui/src/tokens.ts. Replace the block ` +
        `between the markers with:\n\n${expected}\n`,
    ).toBe(expected);
  });

  it('lists every --tm-* variable exactly once', () => {
    const block = readBlock();
    for (const name of names) {
      const count = block.split(`| \`${name}\` |`).length - 1;
      expect(count, name).toBe(1);
    }
  });
});
