/**
 * The two hosts draw the same UI — asserted the only way this repo can assert it.
 *
 * `apps/web` was rebuilt on the desktop's own shell, board and detail pane (docs/plan
 * README, "The web client that looks exactly like the desktop"). The ticket's claim is
 * that *these two look the same*, and nothing here can test that: there is no DOM harness
 * in this workspace — no jsdom, no `@testing-library` — and adding one is a workspace-wide
 * decision that the v0.82.0 branch deliberately left outside its scope, as does this file.
 *
 * **So be clear about what this proves and what it does not.** It proves the two hosts
 * render through the SAME MODULES: the same `AppShell`/`NavRail`/`StatusBar`, the same
 * board frame, the same global rules, the same theme mounted the same way. It cannot see a
 * single rendered pixel. A divergence made INSIDE `@tm/ui` — the shared shell growing a
 * `compact` prop that only one host passes, say — sails straight past every assertion
 * below, because both hosts still import the same module.
 *
 * What it does catch is the realistic regression, and the one the ticket's own reviewer
 * worried about: somebody in a hurry adds a local `makeStyles` shell to one side, or
 * re-declares the scrollbar CSS in one host's stylesheet, and the two drift apart one
 * plausible commit at a time with nothing red anywhere. That is a *structural* property,
 * and structure is exactly what reading the sources as text can check.
 *
 * It lives at the repo root beside `repo-invariants.test.ts` for the same reason that one
 * does: the root `vitest.config.ts` sets no `include`, so vitest's default glob collects
 * this, which puts the guard inside `pnpm test` — and `pnpm test` is on every gate anyone
 * actually runs (CONTRIBUTING.md §5, RELEASE.md §1). It is also the only place it *can*
 * live: it reads files from both `apps/web` and `apps/client`, and neither package's own
 * vitest run has the other in scope.
 *
 * Written red-first. Each assertion was confirmed to fail against a host mutated to break
 * it before any of it was relied on — step 5 of the same branch found its `webPrefs`
 * fixtures coerced to the same answer as the defaults, so the suite passed against a
 * mutant and proved nothing.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The repo root, derived from this file rather than from cwd, so the run directory is free. */
const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * The six files that are the parity, three per host. Posix-separated and joined per
 * platform, so the names below read like the paths a commit message would use.
 */
const WEB_APP = 'apps/web/src/App.tsx';
const DESKTOP_APP = 'apps/client/src/renderer/src/App.tsx';
const WEB_BOARD = 'apps/web/src/board/BoardScreen.tsx';
const DESKTOP_BOARD = 'apps/client/src/renderer/src/MyTasks.tsx';
const WEB_MAIN = 'apps/web/src/main.tsx';
const DESKTOP_MAIN = 'apps/client/src/renderer/src/main.tsx';

function read(path: string): string {
  return readFileSync(join(repoRoot, ...path.split('/')), 'utf8');
}

/**
 * The shared UI package under both of its names. `apps/web` imports it as the real
 * workspace package `@tm/ui`, resolved through `exports` to its built `dist`;
 * `apps/client`'s renderer imports it as `@ui`, the source alias electron-vite and
 * `tsconfig.base.json` define. Same package, and neither spelling is wrong — so every
 * import assertion here accepts both rather than picking a winner the hosts have not.
 */
const SHARED_UI = '(?:@tm/ui|@ui)';

/**
 * The names a file imports from one subpath of the shared UI package — `[]` when it does
 * not import from there at all, which is the failure this file exists to catch.
 *
 * A regex rather than a parse: the repo is prettier-formatted, so an import clause is a
 * `{ … }` on one specifier with single quotes, and a real parser would be a dependency
 * bought for one shape of one line.
 */
function importedFrom(source: string, subpath: string): string[] {
  const pattern = new RegExp(
    `import\\s+(?:type\\s+)?\\{([^}]*)\\}\\s+from\\s+'${SHARED_UI}/${subpath}'`,
    'g',
  );
  const names: string[] = [];
  for (const match of source.matchAll(pattern)) {
    for (const clause of match[1].split(',')) {
      // `type Foo`, `Foo as Bar` and plain `Foo` all name `Foo` for our purposes.
      const name = clause
        .trim()
        .replace(/^type\s+/, '')
        .split(/\s+as\s+/)[0]
        .trim();
      if (name) names.push(name);
    }
  }
  return names;
}

/**
 * The object literal that follows `from` — returned with every comment and string blanked
 * out, so a rule NAME can never be something written inside either one.
 *
 * The scan starts at a `makeStyles(` and stops the moment its braces balance, which is why
 * it can afford to be this simple: everything between those two points is style code, and
 * it never has to survive the JSX further down the file (where an apostrophe in prose
 * would look exactly like the start of a string).
 */
function objectLiteralAfter(source: string, from: number): string | null {
  let i = from;
  // Skip whatever sits between the `(` and the `{` — whitespace, or a comment.
  while (i < source.length) {
    if (source.startsWith('//', i)) {
      while (i < source.length && source[i] !== '\n') i++;
      continue;
    }
    if (source.startsWith('/*', i)) {
      const end = source.indexOf('*/', i + 2);
      if (end === -1) return null;
      i = end + 2;
      continue;
    }
    if (/\s/.test(source[i])) {
      i++;
      continue;
    }
    break;
  }
  if (source[i] !== '{') return null;

  const out: string[] = [];
  let depth = 0;
  for (; i < source.length; i++) {
    const ch = source[i];
    if (source.startsWith('//', i)) {
      while (i < source.length && source[i] !== '\n') i++;
      out.push('\n');
      continue;
    }
    if (source.startsWith('/*', i)) {
      const end = source.indexOf('*/', i + 2);
      if (end === -1) return null;
      i = end + 1;
      out.push(' ');
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      out.push(' ');
      i++;
      while (i < source.length && source[i] !== ch) {
        if (source[i] === '\\') i++;
        i++;
      }
      continue;
    }
    out.push(ch);
    if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return out.join('');
  }
  return null;
}

/** The keys of an object literal's own top level — its nested values are not rules. */
function topLevelKeys(literal: string): string[] {
  const keys: string[] = [];
  let depth = 0;
  let expectKey = false;
  for (let i = 0; i < literal.length; i++) {
    const ch = literal[i];
    if (ch === '{' || ch === '[' || ch === '(') {
      depth++;
      if (depth === 1) expectKey = true;
      continue;
    }
    if (ch === '}' || ch === ']' || ch === ')') {
      depth--;
      continue;
    }
    if (depth !== 1) continue;
    if (ch === ',') {
      expectKey = true;
      continue;
    }
    if (/\s/.test(ch) || !expectKey) continue;
    const named = /^([A-Za-z_$][\w$]*)\s*:/.exec(literal.slice(i));
    if (named) keys.push(named[1]);
    expectKey = false;
  }
  return keys;
}

/** Where each host's own source lives — `dist` and `node_modules` are nobody's source. */
const HOST_TREES = ['apps/web/src', 'apps/client/src/renderer/src'];

/**
 * Every file under a tree whose name `matches`, recursively and repo-relative.
 *
 * At module scope rather than inside one `describe` because two of them walk the host trees
 * now: the global-CSS rules look for a re-declaration, and the shared-component check looks
 * for a re-implementation. Same walk, different filter.
 */
function filesUnder(tree: string, matches: RegExp): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(join(repoRoot, ...tree.split('/')), { withFileTypes: true })) {
    const path = `${tree}/${entry.name}`;
    if (entry.isDirectory()) found.push(...filesUnder(path, matches));
    else if (matches.test(entry.name)) found.push(path);
  }
  return found;
}

/** Every CSS rule a file declares for itself, across all of its `makeStyles` blocks. */
function localRuleNames(source: string): string[] {
  const names: string[] = [];
  for (const match of source.matchAll(/\bmakeStyles\s*\(/g)) {
    const literal = objectLiteralAfter(source, (match.index ?? 0) + match[0].length);
    if (literal !== null) names.push(...topLevelKeys(literal));
  }
  return names;
}

describe('the shell both hosts render through', () => {
  /**
   * The three pieces of the frame. `AppShell` is the flex shell itself, and the other two
   * are the rail and the bar it arranges — a host that kept one of the three and hand-rolled
   * the others would still look like a different application.
   */
  const SHELL = [
    { name: 'AppShell', subpath: 'shell/AppShell' },
    { name: 'NavRail', subpath: 'shell/NavRail' },
    { name: 'StatusBar', subpath: 'shell/StatusBar' },
  ] as const;

  for (const [label, path] of [
    ['the browser client', WEB_APP],
    ['the desktop renderer', DESKTOP_APP],
  ] as const) {
    it(`draws ${label}'s frame with the shared shell`, () => {
      const source = read(path);
      for (const piece of SHELL) {
        expect(
          importedFrom(source, piece.subpath),
          `${path} must import ${piece.name} from @tm/ui/${piece.subpath} (or its @ui alias). ` +
            'Both hosts render through the same shell so the browser tab and the app window ' +
            'are one UI; a local replacement here is how they stop being one.',
        ).toContain(piece.name);
      }
    });
  }
});

describe('the board frame both hosts render through', () => {
  /**
   * The four rules that ARE the board's frame — the flex row, the board half, the scrolling
   * column grid and the 40% detail pane. They live in `@tm/ui/board/boardLayout` and a host
   * that re-declares one has forked the board's proportions.
   *
   * `toolbar` and `grow` are in that same shared block but deliberately not listed: the web's
   * toolbar is a fork on purpose (`BoardToolbar.tsx`), and `toolbar` is too ordinary a name
   * for a local rule to make a rule out of.
   */
  const FRAME_RULES = ['root', 'board', 'columns', 'right'];

  for (const [label, path] of [
    ['the browser client', WEB_BOARD],
    ['the desktop renderer', DESKTOP_BOARD],
  ] as const) {
    it(`lays ${label}'s board out with the shared frame`, () => {
      const source = read(path);

      expect(
        importedFrom(source, 'board/boardLayout'),
        `${path} must import useBoardLayoutStyles from @tm/ui/board/boardLayout (or its @ui ` +
          'alias) — the insets, the single scroll container and the exact 40% pane basis are ' +
          'shared so the two boards have the same proportions.',
      ).toContain('useBoardLayoutStyles');

      const local = localRuleNames(source);
      const forked = FRAME_RULES.filter((rule) => local.includes(rule));
      expect(
        forked,
        `${path} declares its own ${forked.join('/')} rule in a makeStyles block. Those four ` +
          'are the board frame and belong in packages/ui/src/board/boardLayout.ts — a local ' +
          'copy is a fork of the layout that nothing else will ever notice.',
      ).toEqual([]);
    });
  }
});

describe("the app's global CSS rules", () => {
  /**
   * The rules that apply to the whole document rather than to a component. They moved into
   * `useGlobalStyles` (`packages/ui/src/theme.ts`) so neither host can change them alone;
   * before that the desktop's `index.css` and the web's own copy were free to disagree, and
   * a scrollbar is the kind of thing nobody notices has drifted until both are open.
   *
   * Both patterns want the rule as it is WRITTEN — a selector or a property, ending in the
   * `:`, `{`, `,` or quote that follows one — rather than the words anywhere in the file. A
   * comment is allowed to name what moved and where it went, which the two files these rules
   * left both do; only re-declaring one is the drift.
   */
  const GLOBAL_RULES: ReadonlyArray<{ pattern: RegExp; what: string }> = [
    { pattern: /::-webkit-scrollbar[a-z-]*\s*(?=[,'"{:])/, what: 'the scrollbar treatment' },
    { pattern: /\bcolor-scheme\s*:|\bcolorScheme\s*:/, what: 'the dark colour-scheme' },
  ];

  /** The two entry documents, which live above those trees and can carry a <style> block. */
  const HOST_DOCUMENTS = ['apps/web/index.html', 'apps/client/src/renderer/index.html'];
  const STYLE_BEARING = /\.(ts|tsx|css|html)$/;

  it('are declared in packages/ui and nowhere else', () => {
    const hostFiles = [
      ...HOST_TREES.flatMap((tree) => filesUnder(tree, STYLE_BEARING)),
      ...HOST_DOCUMENTS,
    ];
    // A guard over an empty list passes for the wrong reason: if a tree is ever moved or
    // renamed, that must read as a broken test rather than as a clean board.
    expect(hostFiles.length, 'found no host sources to scan — has a tree moved?').toBeGreaterThan(
      10,
    );

    for (const rule of GLOBAL_RULES) {
      const offenders = hostFiles.filter((path) => rule.pattern.test(read(path)));
      expect(
        offenders,
        `${offenders.join(', ')} declares ${rule.what}, which is a GLOBAL rule and belongs in ` +
          'useGlobalStyles (packages/ui/src/theme.ts). Declared in a host, it applies to that ' +
          'host alone and the other one silently keeps the old look.',
      ).toEqual([]);
    }
  });
});

describe('the controls that moved into the shared package', () => {
  /**
   * Two components the mirror round lifted out of `apps/client/src/renderer/src` and into
   * `packages/ui`, because a browser now needs each of them.
   *
   * They are a different kind of parity from the shell above, and worth their own block for
   * it. `AppShell` was always shared; these two were the DESKTOP'S, and were moved on the
   * argument that making a card and reading a commit graph are the same act on either host.
   * The way that argument gets quietly abandoned is not by editing the shared file — it is by
   * one host growing a local copy "just for now", which nothing else in this repo would go
   * red about, since both hosts would still compile and still render something.
   *
   * `filesEnabled` on the dialog is the shape of divergence that is FINE and is deliberately
   * not asserted against: a prop the shared component owns, with both hosts passing what is
   * true of them. The fork this catches is a second implementation.
   */
  const MOVED = [
    { name: 'AddTaskDialog', subpath: 'AddTaskDialog' },
    { name: 'GitGraphPane', subpath: 'GitGraphPane' },
  ] as const;

  for (const [label, path] of [
    ['the browser client', WEB_BOARD],
    ['the desktop renderer', DESKTOP_BOARD],
  ] as const) {
    it(`renders ${label}'s add-task dialog and commit graph from @tm/ui`, () => {
      const source = read(path);
      for (const piece of MOVED) {
        expect(
          importedFrom(source, piece.subpath),
          `${path} must import ${piece.name} from @tm/ui/${piece.subpath} (or its @ui alias). ` +
            'It was moved into packages/ui precisely so both hosts get the same one; an ' +
            'import from anywhere else is the fork.',
        ).toContain(piece.name);
      }
    });
  }

  it('leaves no local copy of either behind in a host tree', () => {
    // The realistic regression is a FILE, not an import: somebody re-adds
    // `apps/web/src/board/AddTaskDialog.tsx` (which is exactly where this one lived until the
    // mirror round deleted it) and points one host at it. Both hosts still typecheck, both
    // still render a dialog, and the two drift from that commit onward.
    const names = MOVED.map((piece) => piece.name);
    const pattern = new RegExp(`^(?:${names.join('|')})\\.tsx?$`);
    const copies = HOST_TREES.flatMap((tree) => filesUnder(tree, pattern));

    expect(
      copies,
      `${copies.join(', ')} re-implements a component that lives in packages/ui. Delete it ` +
        'and import from @tm/ui — a host-local copy is a second implementation that only ' +
        'diverges, and nothing else in this repo can see it happen.',
    ).toEqual([]);
  });
});

describe('the theme both hosts mount', () => {
  for (const [label, path] of [
    ['The browser entry point', WEB_MAIN],
    ['The renderer entry point', DESKTOP_MAIN],
  ] as const) {
    it(`${label} mounts appDarkTheme through scaleTheme and emits the global rules`, () => {
      const source = read(path);
      const imported = importedFrom(source, 'theme');

      for (const name of ['appDarkTheme', 'scaleTheme', 'useGlobalStyles']) {
        expect(
          imported,
          `${path} must import ${name} from @tm/ui/theme (or its @ui alias). The palette, its ` +
            'type ramp and the global rules are one shared set; a host that supplies its own ' +
            'is a second palette, and two copies of a palette are a palette that drifts.',
        ).toContain(name);
      }

      // The provider's theme is the SCALED shared palette. Passing `appDarkTheme` raw would
      // still import both names and still be wrong: every `fontPx()` in the shared components
      // reads the ramp this produces.
      expect(
        source,
        `${path} must pass the theme as scaleTheme(appDarkTheme, …) — the desktop scales by the ` +
          'font-size setting and the browser by BASE_FONT_PX, so the two differ in the value ' +
          'and never in the shape.',
      ).toMatch(/scaleTheme\(\s*appDarkTheme\s*,/);

      // `makeStaticStyles` emits on first use, so an import nobody calls emits nothing at all.
      expect(
        source,
        `${path} must CALL useGlobalStyles() — it is makeStaticStyles under the hood and emits ` +
          'its CSS on first use, so an unused import leaves the page with no global rules and ' +
          'no error either.',
      ).toMatch(/useGlobalStyles\(\)/);
    });
  }
});
