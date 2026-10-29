/**
 * Proves the canvas wash (`--tm-page-wash`, painted on `#root` by `useGlobalStyles`) is not
 * covered back up by anything between `#root` and a screen: neither Fluent's own provider
 * root — which paints `colorNeutralBackground1` unless told otherwise — nor `AppShell`'s frame.
 * Both covered it until TM-200's follow-up, and every screenshot read as a flat canvas.
 *
 * No DOM in this package (see `palette/shortcut.test.ts`), so there is no `getComputedStyle`
 * to ask. Instead the test does the cascade itself, for the only two things it decides here:
 * a Griffel renderer that just records every rule it is handed (static and atomic, in
 * insertion order, bucketed the way the real DOM renderer orders its sheets), the markup from
 * `renderToStaticMarkup` for the element chain, and a small selector matcher with
 * specificity. That is deliberately enough to catch the trap that matters: a global
 * `.fui-FluentProvider` rule inserted BEFORE the provider's own atomic class, at equal
 * specificity, loses — order alone would decide it.
 *
 * `theme` is imported dynamically, with `NODE_ENV` briefly not `test`: Griffel's React
 * `makeStaticStyles` returns a no-op under `NODE_ENV === 'test'`, decided when the module is
 * evaluated, which would leave the very sheet under test uninserted.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { FluentProvider, RendererProvider, type GriffelRenderer } from '@fluentui/react-components';
import { beforeAll, describe, expect, it } from 'vitest';
import { AppShell } from './shell/AppShell';
import type { ColorScheme } from './theme';

let theme: typeof import('./theme');

beforeAll(async () => {
  const env = process.env.NODE_ENV;
  process.env.NODE_ENV = 'development';
  try {
    theme = await import('./theme');
  } finally {
    process.env.NODE_ENV = env;
  }
});

/** Griffel's sheet order (`getStyleSheetForBucket.ts`): a later bucket wins a tie. */
const BUCKETS = ['r', 'd', 'l', 'v', 'w', 'f', 'i', 'h', 'a', 's', 'k', 't', 'm', 'c'];

interface Rule {
  css: string;
  bucket: number;
  seq: number;
}

let rendererSeq = 0;

/** Every CSS rule one render inserts, in the order the browser would see them. */
function collectingRenderer(rules: Rule[]): GriffelRenderer {
  return {
    id: `canvas-wash-${rendererSeq++}`,
    insertionCache: {},
    stylesheets: {},
    compareMediaQueries: (a, b) => (a < b ? -1 : a > b ? 1 : 0),
    compareContainerQueries: (a, b) => (a < b ? -1 : a > b ? 1 : 0),
    insertCSSRules(cssRules) {
      for (const [bucket, entries] of Object.entries(cssRules)) {
        for (const entry of entries ?? []) {
          const css = typeof entry === 'string' ? entry : entry[0];
          rules.push({ css, bucket: BUCKETS.indexOf(bucket), seq: rules.length });
        }
      }
    },
  };
}

function Host({ scheme }: { scheme: ColorScheme }): JSX.Element {
  theme.useGlobalStyles();
  return (
    <FluentProvider theme={theme.themeFor(scheme)}>
      <AppShell nav={<nav />} status={<footer />}>
        <div data-testid="slot" />
      </AppShell>
    </FluentProvider>
  );
}

interface El {
  tag: string;
  id?: string;
  classes: string[];
  attrs: Record<string, string>;
}

/** The open elements around `data-testid="slot"` in `html`, outermost first. */
function ancestorsOfSlot(html: string): El[] {
  const stack: El[] = [];
  const withoutStyles = html.replace(/<style[^>]*>[\s\S]*?<\/style>/g, '');
  for (const m of withoutStyles.matchAll(/<(\/?)([a-z][a-z0-9]*)([^>]*?)(\/?)>/g)) {
    const [, closing, tag, rawAttrs, selfClosing] = m;
    if (closing) {
      stack.pop();
      continue;
    }
    const attrs: Record<string, string> = {};
    for (const a of rawAttrs.matchAll(/([a-zA-Z-]+)="([^"]*)"/g)) attrs[a[1]] = a[2];
    if (attrs['data-testid'] === 'slot') return stack;
    if (!selfClosing) {
      stack.push({ tag, id: attrs.id, classes: (attrs.class ?? '').split(/\s+/), attrs });
    }
  }
  throw new Error('slot not rendered');
}

type Compound = {
  tag?: string;
  id?: string;
  classes: string[];
  attrs: [string, string][];
  root: boolean;
  other: boolean;
};

function parseCompound(text: string): Compound {
  const c: Compound = { classes: [], attrs: [], root: false, other: false };
  for (const m of text.matchAll(
    /(\.[\w-]+)|(#[\w-]+)|(\[[\w-]+="[^"]*"\])|(::?[\w-]+(?:\([^)]*\))?)|([a-z][\w-]*|\*)/g,
  )) {
    if (m[1]) c.classes.push(m[1].slice(1));
    else if (m[2]) c.id = m[2].slice(1);
    else if (m[3]) {
      const [, k, v] = /\[([\w-]+)="([^"]*)"\]/.exec(m[3])!;
      c.attrs.push([k, v]);
    } else if (m[4]) {
      if (m[4] === ':root') c.root = true;
      else c.other = true; // :hover, ::after, … never match a resting element
    } else if (m[5] && m[5] !== '*') c.tag = m[5];
  }
  return c;
}

function matchesCompound(c: Compound, el: El, isRoot: boolean): boolean {
  if (c.other || (c.root && !isRoot)) return false;
  if (c.tag && c.tag !== el.tag) return false;
  if (c.id && c.id !== el.id) return false;
  return (
    c.classes.every((k) => el.classes.includes(k)) && c.attrs.every(([k, v]) => el.attrs[k] === v)
  );
}

/** `[ids, classes+attrs+pseudo-classes, tags]` for one complex selector. */
function specificity(parts: Compound[]): number {
  let s = 0;
  for (const c of parts) {
    s += (c.id ? 1 : 0) * 10_000 + (c.classes.length + c.attrs.length + (c.root ? 1 : 0)) * 100;
    s += c.tag ? 1 : 0;
  }
  return s;
}

/** Descendant combinators only — all this test's chain needs. */
function selectorSpecificityIfMatches(selector: string, chain: El[], index: number): number | null {
  const parts = selector.trim().split(/\s+/).map(parseCompound);
  if (!matchesCompound(parts[parts.length - 1], chain[index], index === 0)) return null;
  let at = index - 1;
  for (let p = parts.length - 2; p >= 0; p--) {
    while (at >= 0 && !matchesCompound(parts[p], chain[at], at === 0)) at--;
    if (at < 0) return null;
    at--;
  }
  return specificity(parts);
}

/** The winning declaration of `props` (default: either background longhand or shorthand —
 *  both set the colour) on `chain[index]`, if any. */
function winningBackground(
  rules: Rule[],
  chain: El[],
  index: number,
  props = /(background(?:-color)?)\s*:\s*([^;]+)/g,
): string | undefined {
  let best: { spec: number; bucket: number; seq: number; value: string } | undefined;
  for (const rule of rules) {
    if (rule.css.startsWith('@')) continue; // media/at-rules: none apply at rest in the test
    const m = /^([^{]+)\{([^}]*)\}$/.exec(rule.css.trim());
    if (!m) continue;
    const decls = [...m[2].matchAll(props)];
    if (decls.length === 0) continue;
    for (const selector of m[1].split(',')) {
      const spec = selectorSpecificityIfMatches(selector, chain, index);
      if (spec === null) continue;
      const better =
        !best ||
        spec > best.spec ||
        (spec === best.spec &&
          (rule.bucket > best.bucket || (rule.bucket === best.bucket && rule.seq > best.seq)));
      if (better)
        best = { spec, bucket: rule.bucket, seq: rule.seq, value: decls.at(-1)![2].trim() };
    }
  }
  return best?.value;
}

const TRANSPARENT = new Set(['', 'transparent', 'rgba(0, 0, 0, 0)', 'rgba(0,0,0,0)']);

function render(scheme: ColorScheme, glass: string): { rules: Rule[]; chain: El[] } {
  const rules: Rule[] = [];
  const html = renderToStaticMarkup(
    <RendererProvider renderer={collectingRenderer(rules)}>
      <Host scheme={scheme} />
    </RendererProvider>,
  );
  const docRoot: El[] = [
    { tag: 'html', classes: [], attrs: { 'data-scheme': scheme, 'data-glass': glass } },
    { tag: 'body', classes: [], attrs: {} },
    { tag: 'div', id: 'root', classes: [], attrs: { id: 'root' } },
  ];
  return { rules, chain: [...docRoot, ...ancestorsOfSlot(html)] };
}

describe('the canvas wash shows behind the panes', () => {
  for (const scheme of ['light', 'dark'] as const) {
    for (const glass of ['css', 'opaque', 'native'] as const) {
      it(`nothing between #root and a screen paints over it (${scheme}, ${glass})`, () => {
        const { rules, chain } = render(scheme, glass);
        const provider = chain.findIndex((el) => el.classes.includes('fui-FluentProvider'));
        expect(provider).toBe(3); // directly inside #root: the walk below covers it

        const painted = chain
          .slice(3)
          .map((el, i) => ({
            el: el.classes.join(' '),
            bg: winningBackground(rules, chain, i + 3),
          }))
          .filter(({ bg }) => !TRANSPARENT.has(bg ?? ''));
        // Names the layer that covers it — the provider root, or AppShell's frame.
        expect(painted).toEqual([]);

        expect(winningBackground(rules, chain, 2, /(background)\s*:\s*([^;]+)/g)).toContain(
          'var(--tm-page-wash)',
        );
      });
    }

    // Native glass: the OS material is the canvas, so only the translucent wash is laid over
    // it — once, on #root, with no canvas colour anywhere beneath it.
    it(`paints no canvas colour under native glass, and the wash once (${scheme})`, () => {
      const { rules, chain } = render(scheme, 'native');
      expect(winningBackground(rules, chain, 0)).toBe('transparent'); // html
      expect(winningBackground(rules, chain, 1)).toBe('transparent'); // body
      expect(winningBackground(rules, chain, 0, /(background)\s*:\s*([^;]+)/g)).toBe('transparent');
      expect(winningBackground(rules, chain, 1, /(background)\s*:\s*([^;]+)/g)).toBe('transparent');
      expect(winningBackground(rules, chain, 2, /(background-color)\s*:\s*([^;]+)/g)).toBe(
        'transparent',
      );
      expect(winningBackground(rules, chain, 2, /(background)\s*:\s*([^;]+)/g)).toBe(
        'var(--tm-page-wash)',
      );
    });
  }

  for (const glass of ['css', 'opaque', 'native'] as const) {
    it(`drops the wash image in forced colours (${glass})`, () => {
      const { rules, chain } = render('dark', glass);
      const forced = rules.find((r) => r.css.startsWith('@media (forced-colors: active)'));
      const inner = /\{\s*([^{}]+)\{\s*background-image\s*:\s*none\s*;?\s*\}\s*\}$/.exec(
        forced?.css.trim() ?? '',
      );
      expect(inner).not.toBeNull();
      // The forced rule comes after the wash rules, so it wins #root as long as one of its
      // selectors is at least as specific as the one painting the wash in this mode.
      const forcedSpec = Math.max(
        ...inner![1].split(',').map((s) => selectorSpecificityIfMatches(s, chain, 2) ?? -1),
      );
      const washSpecs = rules
        .filter((r) => !r.css.startsWith('@') && r.css.includes('var(--tm-page-wash)'))
        .flatMap((r) => /^([^{]+)\{/.exec(r.css.trim())![1].split(','))
        .map((s) => selectorSpecificityIfMatches(s, chain, 2))
        .filter((s): s is number => s !== null);
      expect(washSpecs.length).toBeGreaterThan(0);
      expect(forcedSpec).toBeGreaterThanOrEqual(Math.max(...washSpecs));
      const forcedIndex = rules.indexOf(forced!);
      for (const r of rules.filter((r) => r.css.includes('var(--tm-page-wash)'))) {
        expect(rules.indexOf(r)).toBeLessThan(forcedIndex);
      }
    });
  }
});
