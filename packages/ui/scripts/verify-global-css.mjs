/**
 * The global rules survive the build — checked against the CSS Griffel actually emits.
 *
 * `useGlobalStyles` (`src/theme.ts`) is the one place the app's document-level look is
 * written: the dark `color-scheme`, the `#1f1f1f` page, the shell that never scrolls, the
 * fade-in scrollbars. Both hosts call it, so a rule that goes missing on the way out of this
 * package goes missing in the desktop window and the browser tab at once — silently, because
 * a stylesheet that is a few rules short still renders.
 *
 * There are two ways for that to happen and neither raises an error:
 *
 *  - **`tsup` drops it.** The rules are a plain object literal, so this has no reason to
 *    happen, but "no reason to" is not a check. Reading `dist` is.
 *  - **Griffel drops it.** The real risk. `makeStaticStyles` compiles each key as a literal
 *    selector, which is why `*::-webkit-scrollbar` works here at all — but that is a property
 *    of the current implementation, not a promise, and a selector it declined to emit would
 *    leave the web looking exactly as it did before any of this moved.
 *
 * So this loads the BUILT `dist/theme.cjs` with `makeStaticStyles` stubbed to capture the
 * object it was handed, puts that object through Griffel's own `resolveStaticStyleRules` —
 * the same function the hook calls at runtime — and prints the CSS that would reach the
 * document. Then it checks two different things: that every selector the module declared
 * came out the far side (Griffel dropped nothing), and that the selectors and declarations
 * this app cannot do without are among them (nobody deleted one).
 *
 * Run it by hand after touching `useGlobalStyles`, or after a Fluent/Griffel bump:
 *
 *     pnpm --filter @tm/ui build && node packages/ui/scripts/verify-global-css.mjs
 *
 * Deliberately NOT part of `pnpm test`: it needs `dist`, and the parity guard that IS on the
 * gates (`test/shell-parity.test.ts`) checks a different thing — that neither host re-declares
 * these rules for itself. That one reads sources; this one reads the build.
 */
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const themeCjs = join(packageRoot, 'dist', 'theme.cjs');

if (!existsSync(themeCjs)) {
  console.error(`No build to check: ${themeCjs} does not exist.`);
  console.error('Run `pnpm --filter @tm/ui build` first — this script reads dist, not src.');
  process.exit(1);
}

/**
 * Griffel, reached through Fluent rather than named as a dependency of this package: it is
 * `@fluentui/react-components`'s own copy that runs in both apps, and resolving it any other
 * way risks checking a different version from the one that will do the work.
 */
const require = createRequire(join(packageRoot, 'package.json'));
const fluentRequire = createRequire(require.resolve('@fluentui/react-components'));
const { resolveStaticStyleRules } = fluentRequire('@griffel/core');

/**
 * The built module, evaluated with `makeStaticStyles` swapped for a recorder. A Proxy over
 * the real Fluent namespace rather than a hand-written stub, so everything else the module
 * reaches for — `tokens`, `webDarkTheme` — is the genuine article.
 */
function captureGlobalStyles() {
  const moduleRequire = createRequire(themeCjs);
  let captured = null;

  const stubRequire = (id) => {
    if (id !== '@fluentui/react-components') return moduleRequire(id);
    const real = moduleRequire(id);
    return new Proxy(real, {
      get: (target, prop) =>
        prop === 'makeStaticStyles'
          ? (styles) => {
              captured = styles;
              return () => undefined;
            }
          : target[prop],
    });
  };

  const source = readFileSync(themeCjs, 'utf8');
  const shell = { exports: {} };
  vm.runInNewContext(
    `(function (exports, require, module, __filename, __dirname) {${source}\n})`,
    { console },
    { filename: themeCjs },
  )(shell.exports, stubRequire, shell, themeCjs, dirname(themeCjs));

  return captured;
}

/**
 * The rules this app is not this app without. Not the whole set — the point is to notice a
 * deletion, and these are the ones whose absence is invisible until both hosts are open side
 * by side, which is the one check nobody working on this repo is allowed to run.
 */
const REQUIRED_SELECTORS = [
  ':root',
  'body',
  '*::-webkit-scrollbar',
  '*::-webkit-scrollbar-thumb',
  ':hover::-webkit-scrollbar-thumb',
];

/** Written the way Griffel emits them: no space after the colon. */
const REQUIRED_DECLARATIONS = [
  'color-scheme:dark',
  'background-color:#1f1f1f',
  'overflow:hidden',
  'scrollbar-width:thin',
  'scrollbar-color:transparent transparent',
  'background-clip:padding-box',
];

const captured = captureGlobalStyles();
if (!captured) {
  console.error('FAIL: the built theme never called makeStaticStyles — did useGlobalStyles move?');
  process.exit(1);
}

// The runtime hook passes an array; `makeStaticStyles` takes one object or several.
const rules = resolveStaticStyleRules([captured]);
const css = rules.join('\n');
const emitted = css.replace(/\s*:\s*/g, ':');
const selectors = Object.keys(captured);

console.log('--- selectors the built module handed Griffel ---');
for (const selector of selectors) console.log(`  ${JSON.stringify(selector)}`);
console.log('--- the CSS Griffel emits from them ---');
console.log(css);

// A grouped key ("a, b") is emitted as written, so every part of it must appear.
const dropped = selectors.filter((selector) =>
  selector
    .split(',')
    .map((part) => part.trim())
    .some((part) => !css.includes(part)),
);
const missingSelectors = REQUIRED_SELECTORS.filter((s) => !selectors.includes(s));
const missingDeclarations = REQUIRED_DECLARATIONS.filter((d) => !emitted.includes(d));

console.log('--- verdict ---');
console.log(`selectors in: ${selectors.length}   rules out: ${rules.length}`);
console.log(`dropped by Griffel: ${dropped.length ? dropped.join(' | ') : '(none)'}`);
console.log(`missing selectors:  ${missingSelectors.length ? missingSelectors.join(' | ') : '(none)'}`);
console.log(
  `missing declarations: ${missingDeclarations.length ? missingDeclarations.join(' | ') : '(none)'}`,
);

const failed = dropped.length + missingSelectors.length + missingDeclarations.length;
console.log(failed ? 'FAIL' : 'OK — the global rules survive the build intact.');
process.exit(failed ? 1 : 0);
