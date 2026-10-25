/**
 * Colour comes from the theme, never from a literal. F13.16 moved every screen, dialog and the
 * title bar onto `tokens`/`theme` values; nothing but this file stops the next change from
 * quietly putting a `'#fff'` or an `rgba(…)` back into a `makeStyles` block, where it ignores
 * dark mode, high contrast and every later retune of the token table. This test walks the UI
 * sources and fails on any hex, `rgb()`/`rgba()` or `hsl()`/`hsla()` colour literal outside a
 * short allow-list, each entry of which carries its reason.
 *
 * Lives at the repo root, beside `glass-single-implementation.test.ts`, for the same reason that
 * file does: the root `vitest.config.ts` sets no `include`, so vitest's default glob collects
 * this, which puts the guard on `pnpm test` — every gate anyone actually runs (CONTRIBUTING.md
 * §5, RELEASE.md §1). And the rule spans `apps/client`'s renderer and `apps/web` as much as
 * `packages/ui`; a workspace test only has its own workspace in scope. `backdrop-filter` is not
 * covered here — `glass-single-implementation.test.ts` owns it.
 *
 * Only comments are stripped, never strings. In `makeStyles` a colour IS a string literal
 * (`color: '#fff'`), so stripping strings would blind the test to the exact thing it guards.
 * Stripping comments is what lets prose mention a colour, and it is also what removes every
 * `#123` issue reference the sources cite in comments (`tracker.tsx`, `TaskDetail.tsx`, …).
 *
 * The hex regex's lookbehind keeps out what is left in code: `(?<![\w&/}])#` refuses a `#`
 * preceded by a word character (`repo#123`), by `}` (the same reference built as
 * `${owner}/${repo}#123` in a template literal), by `&` (an `&#123;` entity) or by `/` (a
 * URL fragment). The alternation tries 8 and 6 digits before
 * 3–4, and the trailing `\b` refuses a run of 5 or 7 hex digits, or a `#` followed by a longer
 * word such as `#addTask`. Functional colours match on the call itself, `\b(?:rgba?|hsla?)\s*\(`,
 * which is enough: nothing else in UI source is named `rgb(` or `hsl(`.
 *
 * Proved red first: temporarily adding `color: '#fff',` inside a `makeStyles` block in
 * `packages/ui/src/board/TaskCard.tsx` turned the first `it` red, naming
 * `packages/ui/src/board/TaskCard.tsx:112: #fff` — the real line, because a stripped block
 * comment keeps its newlines; replacing it with a `// #fff` comment
 * turned it green again; then `TaskCard.tsx` was reverted. The third `it` keeps both of those
 * cases proven permanently, on inline fixtures.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The repo root, derived from this file rather than from cwd, so the run directory is free. */
const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

/** Every tree that renders UI. */
const UI_TREES = ['packages/ui/src', 'apps/client/src/renderer/src', 'apps/web/src'];

/** The files allowed to spell a colour out, and why. Anything else uses `tokens`/`theme`. */
const ALLOWED: Record<string, string> = {
  'packages/ui/src/theme.ts': 'builds the Fluent themes from raw ramps; the source of tokens',
  'packages/ui/src/tokens.ts': 'the token table itself',
  'packages/ui/src/shell/GlassPane.tsx':
    'the one glass implementation (tint/rim/forced-colors fallbacks)',
  'packages/ui/src/ColorSwatches.tsx': 'user-pickable project colours are data, not theme',
  'packages/ui/src/JiraMark.tsx': "brand mark keeps the owner's exact colours",
  'packages/ui/src/GitHubMark.tsx': "brand mark keeps the owner's exact colours",
  'packages/ui/src/LinearMark.tsx': "brand mark keeps the owner's exact colours",
};

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

/** Strips `/* … *\/` block comments (JSX `{/* … *\/}` included) and `//` line comments. Strings
 *  are deliberately kept — see this file's header comment. A block comment keeps its newlines,
 *  so every line after it keeps its number and a failure points at the real line. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, ''))
    .replace(/\/\/.*$/gm, '');
}

/** A hex colour or a functional colour call — see this file's header comment for each choice. */
const COLOUR_LITERAL =
  /(?<![\w&/}])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})\b|\b(?:rgba?|hsla?)\s*\(/g;

/** Every colour literal left in `source` once comments are gone, as `line: literal`. */
function colourLiterals(source: string): string[] {
  const hits: string[] = [];
  stripComments(source)
    .split('\n')
    .forEach((line, index) => {
      for (const match of line.matchAll(COLOUR_LITERAL)) hits.push(`${index + 1}: ${match[0]}`);
    });
  return hits;
}

function offendingLiterals(): string[] {
  const offenders: string[] = [];
  for (const tree of UI_TREES) {
    for (const path of filesUnder(tree)) {
      if (path in ALLOWED) continue;
      const source = readFileSync(join(repoRoot, ...path.split('/')), 'utf8');
      for (const hit of colourLiterals(source)) offenders.push(`${path}:${hit}`);
    }
  }
  return offenders;
}

describe('colour comes from the theme', () => {
  it('spells out no hex/rgb()/hsl() colour outside the allow-list', () => {
    expect(
      offendingLiterals(),
      'A colour literal outside the theme ignores dark mode, high contrast and every later ' +
        'retune of the token table. Use a `tokens` / `theme` value instead — or, if the colour ' +
        'genuinely is not theme (a brand mark, user data), add the file to ALLOWED in ' +
        'test/theme-tokens.test.ts with a one-line reason.',
    ).toEqual([]);
  });

  it('allow-lists only files that still exist', () => {
    const missing = Object.keys(ALLOWED).filter(
      (path) => !existsSync(join(repoRoot, ...path.split('/'))),
    );
    expect(
      missing,
      'An allow-listed file is gone — drop its entry from ALLOWED rather than let it rot.',
    ).toEqual([]);
  });

  it('tells a colour literal from a comment, an issue reference and an entity', () => {
    expect(colourLiterals("color: '#fff',")).toEqual(['1: #fff']);
    expect(colourLiterals("boxShadow: '0 0 0 1px rgba(0,0,0,.1)',")).toEqual(['1: rgba(']);
    expect(colourLiterals("background: 'hsl(0 0% 100%)',")).toEqual(['1: hsl(']);
    expect(colourLiterals("border: '1px solid #11223344',")).toEqual(['1: #11223344']);
    expect(colourLiterals("/**\n * prose\n */\nconst a = 1;\ncolor: '#fff',")).toEqual(['5: #fff']);
    expect(colourLiterals('// #fff')).toEqual([]);
    expect(colourLiterals('/* rgba(0,0,0,.5) */')).toEqual([]);
    expect(colourLiterals('{/* #abc */}')).toEqual([]);
    expect(colourLiterals('const ref = `${owner}/${repo}#123`;')).toEqual([]);
    expect(colourLiterals("const brace = '&#123;';")).toEqual([]);
    expect(colourLiterals("const id = '#addTask';")).toEqual([]);
  });
});
