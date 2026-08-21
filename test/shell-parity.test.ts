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
 *
 * The last block is the inverse of all the others and belongs here for that reason: parity
 * has exactly one deliberate hole in it, and a hole nothing asserts is indistinguishable
 * from an omission. See "agent projects: the web reads them and does not configure them" —
 * which now guards the shape of the hole from both sides, since the read-only half of that
 * pane has since been drawn.
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
const MOBILE_APP = 'apps/mobile/src/App.tsx';

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

/**
 * Where each host's own source lives — `dist` and `node_modules` are nobody's source.
 *
 * `apps/mobile/src` joined this list the same commit that created it (Phase 27 step 4), on
 * purpose: the global-CSS guard below is only worth having if it covers a host from its
 * first commit, rather than retroactively blessing whatever landed there before anyone
 * thought to add it.
 *
 * `packages/cloud/src` joined this list here (Phase 27 step 11), to UNDO a coverage hole
 * step 3 opened rather than to add new ground: `SettingsScreen.tsx` moved out of
 * `apps/web/src/settings/` — inside the old `apps/web/src` entry — into
 * `packages/cloud/src/settings/`, which this list did not yet name. Between step 3 and here
 * a scrollbar or colour-scheme rule declared in that file would have compiled, rendered, and
 * gone unnoticed by every assertion below. `packages/cloud` is a shared package like
 * `packages/ui`, not a per-app host — but unlike `packages/ui`, it renders a whole screen
 * rather than components a host assembles, which is exactly the shape of file the global-CSS
 * guard exists to catch.
 */
const HOST_TREES = [
  'apps/web/src',
  'apps/client/src/renderer/src',
  'apps/mobile/src',
  'packages/cloud/src',
];

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

describe('the destinations both the browser and the Android client expose', () => {
  /**
   * The ticket's whole claim for `apps/mobile` (docs/plan/README.md, Phase 27) is "same
   * features" — and a nav rail is the one place that claim can be read off as a literal list.
   * `apps/web/src/App.tsx` and `apps/mobile/src/App.tsx` each declare a `NAV`/destinations
   * array of `{ id: '…', label: '…', icon: … }` objects; this reads the `id`s off both, in
   * the order they're written, so a destination added, dropped, or reordered on one side and
   * not the other goes red here instead of waiting to be noticed by eye on a phone.
   *
   * Not compared against the desktop's own `apps/client/src/renderer/src/App.tsx`: that one
   * already has no counterpart-parity guard today (nothing here enforces `apps/web`'s NAV
   * against the desktop's either), and giving mobile a stricter guard than web already has
   * would be a new rule invented in this step rather than the one asked for — mobile mirrors
   * web's ids, which is what "modelled on apps/web" means for this file.
   */
  /**
   * Scoped to the `NAV` array literal itself, not every `{ id: '…' }` in the file — `NavRail`
   * also takes an `accountItems` prop (`[{ id: 'signout', … }]`) for its Account dropdown,
   * and a whole-file scan would count that entry as a sixth destination that was never one.
   */
  function navIds(source: string): string[] {
    const nav = source.match(/const NAV: readonly NavRailItem\[\] = \[([\s\S]*?)\n\];/);
    if (!nav) return [];
    const ids: string[] = [];
    for (const match of nav[1].matchAll(/\{\s*id:\s*'([a-z]+)'/g)) ids.push(match[1]);
    return ids;
  }

  it('list the same destination ids, in the same order', () => {
    const web = navIds(read(WEB_APP));
    const mobile = navIds(read(MOBILE_APP));

    // A guard that found nothing to compare passes for the wrong reason — same discipline
    // as the global-CSS block's own `toBeGreaterThan` below. Six, since Projects joined the
    // rail post-merge — a count asserted so a destination silently dropped from BOTH sides
    // at once (which `toEqual` below cannot see) still goes red here.
    expect(web.length, `found no NAV ids in ${WEB_APP} — has its destinations moved?`).toBe(6);

    expect(
      mobile,
      `${MOBILE_APP}'s destination ids (${mobile.join(', ')}) must match ${WEB_APP}'s ` +
        `(${web.join(', ')}), in the same order — the two hosts claim the same ` +
        'destinations, and a mismatch here is that claim going false silently.',
    ).toEqual(web);
  });
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

  /** The entry documents, which live above those trees and can carry a <style> block. */
  const HOST_DOCUMENTS = [
    'apps/web/index.html',
    'apps/client/src/renderer/index.html',
    'apps/mobile/index.html',
  ];
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

describe('the shared screens fit a phone', () => {
  /**
   * Phase 27 step 5. There is no DOM harness in this repo (see the file header), so these
   * read the source as text, the same way the theme block above reads for
   * `scaleTheme(appDarkTheme,` — a CSS rule nobody asserts is a rule that silently reverts,
   * and every one of these fixes is exactly the kind of one-line rule a later edit could
   * undo without anything else here noticing.
   */
  const THEME = 'packages/ui/src/theme.ts';
  const PERFORMANCE = 'packages/ui/src/Performance.tsx';
  const ADD_TASK_DIALOG = 'packages/ui/src/AddTaskDialog.tsx';
  const ARCHIVED_CARDS_DIALOG = 'packages/ui/src/board/ArchivedCardsDialog.tsx';
  const SETTINGS_SCREEN = 'packages/cloud/src/settings/SettingsScreen.tsx';
  const PROJECTS = 'packages/ui/src/projects/Projects.tsx';

  it('sizes the document to the visible viewport, not the large one', () => {
    const source = read(THEME);
    expect(
      source,
      `${THEME}'s 'html, body, #root' rule must set height: '100dvh', not '100%'. Before a ` +
        "phone install, '100%' resolves against the LARGE viewport (address bar excluded) " +
        'while the visible area is the SMALL one — body ends up taller than the screen, and ' +
        "since it does not scroll, MobileShell's bottom tab bar sits under the address bar " +
        'and unreachable.',
    ).toMatch(/'html, body, #root':\s*\{\s*margin:\s*0,\s*padding:\s*0,\s*height:\s*'100dvh'/);
  });

  it("stacks Performance's rail below the panel at phone width", () => {
    const source = read(PERFORMANCE);
    expect(
      source,
      `${PERFORMANCE}'s .main grid (gridTemplateColumns: 'minmax(220px, 1fr) minmax(0, 3fr)') ` +
        'leaves the panel beside the rail ~130px wide at a 360px phone. It must collapse to a ' +
        'single column under a max-width media query.',
    ).toMatch(/'@media \(max-width: 599px\)':\s*\{\s*gridTemplateColumns:\s*'1fr',?\s*\}/);
  });

  it('caps AddTaskDialog to the viewport width on a phone', () => {
    const source = read(ADD_TASK_DIALOG);
    expect(
      source,
      `${ADD_TASK_DIALOG}'s dialog body must set minWidth: 'min(440px, calc(100vw - 32px))' — ` +
        'a bare 440px overflows a 360px phone, and the calc side is a no-op once the viewport ' +
        'is wide enough to afford the fixed one.',
    ).toMatch(/minWidth:\s*'min\(440px, calc\(100vw - 32px\)\)'/);
  });

  it('caps ArchivedCardsDialog to the viewport width on a phone', () => {
    const source = read(ARCHIVED_CARDS_DIALOG);
    expect(
      source,
      `${ARCHIVED_CARDS_DIALOG}'s dialog body must set minWidth: 'min(520px, calc(100vw - ` +
        "32px))' — a bare 520px overflows a 360px phone even worse than AddTaskDialog's own " +
        '440px does.',
    ).toMatch(/minWidth:\s*'min\(520px, calc\(100vw - 32px\)\)'/);
  });

  it("stacks SettingsScreen's two-column split under a breakpoint", () => {
    const source = read(SETTINGS_SCREEN);
    expect(
      source,
      `${SETTINGS_SCREEN}'s .row must switch to flexDirection: 'column' under a max-width ` +
        'media query — its 160px nav beside a pane that wants up to 1100px has nowhere to go ' +
        'on a phone.',
    ).toMatch(/'@media \(max-width: 599px\)':\s*\{\s*flexDirection:\s*'column',?\s*\}/);
  });

  it("stacks Projects' admin rail above the backlog at phone width", () => {
    // Projects joined the mobile rail after this merge (development's ticket-workspace
    // feature postdates step 5's own sweep, so it never got a phone-fit pass until now).
    const source = read(PROJECTS);
    expect(
      source,
      `${PROJECTS}'s .root must switch to flexDirection: 'column' under a max-width media ` +
        "query — its 320px admin rail beside a backlog table has nowhere to go on a phone.",
    ).toMatch(/'@media \(max-width: 599px\)':\s*\{\s*flexDirection:\s*'column',?\s*\}/);
  });
});

describe('agent projects: the web reads them and does not configure them', () => {
  /**
   * Agent projects are created and edited on the DESKTOP, and that is a decision rather than
   * a piece of the mirror nobody got to (plan doc, "What is deliberately out of scope").
   *
   * **Narrowed since, and narrowed rather than reversed** — which is why this block is no
   * longer titled "the one configuration the web deliberately does not mirror". *Reading* the
   * list is in scope on both hosts, survives a desktop that is not answering (the web falls
   * back to the mirrored `projects` rows, filtered to a repo with no plan file
   * (`hasRepo(project) && !hasPlan(project)`) exactly as `MyTasks.tsx`'s own `seed` filters
   * them; plan doc, "Fix — agent projects when the desktop is asleep"), and has a pane of its
   * own in the web's Settings.
   * So the block now asserts BOTH halves: that the read-only view exists, and that nothing
   * around it writes. Every pattern below still matches a WRITE channel or a native picker,
   * and none of them should ever be read as forbidding a read.
   *
   * **Narrowed a third time, on the writing half.** The project add/edit FORM is shared code
   * now too — `packages/ui/src/projects/ProjectForm.tsx`, used by both the desktop's own
   * `Projects` screen and the Tickets workspace's `ProjectAdmin` (the EDITING-PANE test below
   * still finds only the desktop's copy, because a shared FORM is not a shared PANE — the
   * pane wires up `window.api` and the picker; the form takes an optional capability object
   * instead). `apps/web/src/App.tsx` renders that Tickets workspace bare — `<Projects />`,
   * no `repo` prop — so it reaches `ProjectForm` too. That is not a hole in "creates, edits or
   * removes one" above: a *ticket-only* project has no folder to protect and was already fair
   * game for either host to write, by `ProjectAdmin.tsx`'s own header — this decision was
   * always about the fields a folder makes desktop-only, not about the project row itself.
   * What keeps those fields off the web is that `ProjectForm` renders its folder path,
   * "Runs on", `BaseBranchField` and the three automation switches only when the host passes
   * `repo`, and nothing under `apps/web/src` does. The write-channel/picker regexes above
   * cannot see this — the calls they would need to catch live in `packages/ui`, not
   * `apps/web/src` — so the assertion below checks the capability gate directly instead.
   *
   * An agent project IS a folder on the machine the engine runs on, so making one begins with
   * `project:pickDirectory` — a native picker, `host-only` for the reason every native modal
   * is. What makes this worth a guard is that the WRITE channels are not host-only:
   * `project:add`, `:update` and `:remove` are plain `'relay'`, correctly, because
   * executed on the desktop they are ordinary store writes. So nothing in `RELAY_POLICY`
   * stops a browser calling them, and `pnpm typecheck` never will either. The only thing
   * holding the boundary is that no browser code does — which is exactly the kind of fact
   * that survives right up until somebody adds a form in good faith.
   *
   * The block asserts the decision, not the reasoning: if the decision is ever reversed, the
   * fix is to change it here and in the plan doc, not to delete the assertion.
   */
  // A list, not a single tree: the cloud sync layer moved out of apps/web/src into
  // packages/cloud/src (Phase 27 step 3), so a breach introduced there would sail past a
  // scan that only ever walked apps/web/src again.
  const WEB_TREES = ['apps/web/src', 'packages/cloud/src'];
  const SHARED_UI_TREE = 'packages/ui/src';
  const DESKTOP_PANE = 'apps/client/src/renderer/src/projects/Projects.tsx';
  // Both moved with the rest of the cloud sync layer (Phase 27 step 3) — SettingsScreen and
  // its ProjectsSection tab live in packages/cloud/src/settings now, not apps/web/src/settings.
  /** The web's half: a list, no form. Named here because three assertions below refer to it. */
  const WEB_VIEW = 'packages/cloud/src/settings/ProjectsSection.tsx';
  const WEB_SETTINGS = 'packages/cloud/src/settings/SettingsScreen.tsx';

  /**
   * A CALL, not a mention: both files below discuss these channels in prose, correctly.
   *
   * `project:*` now carries every project write — agent projects and plan projects alike,
   * since `agentProject:*` folded into it — so this guards the whole surface rather than a
   * name that used to be agent-project-specific.
   */
  const PROJECT_WRITE = /invoke\(\s*'project:(?:add|update|remove)'/;
  const NATIVE_PICKER = /invoke\(\s*'project:pick(?:Directory|File)'/;

  it('has no browser code that creates, edits or removes one', () => {
    // Tests are excluded because the web's own suite calls `project:pickDirectory` on purpose
    // (`httpTransport.test.ts`) to assert the transport REFUSES it — the opposite of a breach.
    const sources = WEB_TREES.flatMap((tree) => filesUnder(tree, /\.tsx?$/)).filter(
      (path) => !/\.test\.tsx?$/.test(path),
    );
    expect(
      sources.length,
      `found no non-test sources under ${WEB_TREES.join(', ')} — has a tree moved?`,
    ).toBeGreaterThan(10);

    const writes = sources.filter((path) => PROJECT_WRITE.test(read(path)));
    expect(
      writes,
      `${writes.join(', ')} calls a project write channel. Those relay, so it would even ` +
        'work — and it would leave a browser holding a repo path on a machine it cannot see. ' +
        'Creating and editing projects is desktop-only by decision (plan doc, "What is ' +
        'deliberately out of scope"); reversing it is a plan change, not a patch.',
    ).toEqual([]);

    const pickers = sources.filter((path) => NATIVE_PICKER.test(read(path)));
    expect(
      pickers,
      `${pickers.join(', ')} calls a native file picker. It is host-only, so the transport ` +
        'refuses it before the network — a caller here can only ever produce that refusal.',
    ).toEqual([]);
  });

  it('keeps the EDITING pane in the desktop renderer, and nowhere else', () => {
    const pattern = /^Projects\.tsx?$/;
    // `packages/ui/src/projects/Projects.tsx` is the ticket WORKSPACE, a different pane
    // with the same base filename — excluded here by its known path, or this assertion
    // would trip on its own fixture.
    const TICKET_WORKSPACE = 'packages/ui/src/projects/Projects.tsx';
    const copies = [
      ...WEB_TREES.flatMap((tree) => filesUnder(tree, pattern)),
      ...filesUnder(SHARED_UI_TREE, pattern),
    ].filter((p) => p !== TICKET_WORKSPACE);

    expect(
      copies,
      `${copies.join(', ')} is a projects-EDITING pane outside the desktop renderer. Unlike ` +
        'AddTaskDialog and GitGraphPane above, this one was deliberately NOT moved into ' +
        'packages/ui: it reaches the engine through window.api directly and opens a folder ' +
        "picker, so a shared copy would be a pane only one host could ever run. The web's " +
        `read-only view is ${WEB_VIEW} and is asserted below.`,
    ).toEqual([]);

    // The walk finding nothing must mean "nowhere else", not "walked the wrong trees".
    expect(
      filesUnder('apps/client/src/renderer/src', pattern),
      `${DESKTOP_PANE} is where this pane lives. If it has moved, the two searches above ` +
        'proved nothing rather than passing.',
    ).toContain(DESKTOP_PANE);
  });

  it('says so on the web, where somebody would go looking', () => {
    // The card is the whole of the user-facing answer: a section that is quietly absent reads
    // as a screen that is broken, and the fix for that is text, not a feature.
    const settings = read(WEB_SETTINGS);
    expect(
      settings,
      `${WEB_SETTINGS} must keep an "Adding and editing projects" entry in HOST_ONLY_SECTIONS. ` +
        'Dropping the entry does not remove the limit — it removes the only explanation of it ' +
        'a browser user is ever offered.',
    ).toMatch(/title:\s*'Adding and editing projects'/);
  });

  it('draws the read-only view, and renders it from the web Settings screen', () => {
    // The other half of the decision. Reading the list is in scope, so a silent deletion of
    // the pane that does it should go red here rather than be discovered on the screen — the
    // same argument that put the write guard above in this file.
    expect(
      filesUnder('packages/cloud/src/settings', /^ProjectsSection\.tsx?$/),
      `${WEB_VIEW} is the browser's read-only agent-projects view and is part of this ` +
        'decision, not a convenience. Viewing what is configured is in scope (plan doc, ' +
        '"What is deliberately out of scope"); removing the view narrows the web back without ' +
        'anything saying so.',
    ).toContain(WEB_VIEW);

    expect(
      read(WEB_SETTINGS),
      `${WEB_SETTINGS} must render ProjectsSection. A pane nothing mounts is a file, not a ` +
        'feature, and the tab it sits behind is the only place a browser user can see how a ' +
        'project is configured.',
    ).toMatch(/<ProjectsSection\b/);
  });

  it('keeps that view presentational, which is the whole of "read only"', () => {
    // The cheapest structural statement of the boundary. The write channels RELAY, so the
    // only thing stopping a control being added to this pane is that the pane has no way to
    // send anything — no transport, no window.api. Say so here, so it stays true.
    const source = read(WEB_VIEW);
    for (const [pattern, what] of [
      [/transport\.invoke\(/, 'calls the transport'],
      [/window\.api/, 'reaches window.api'],
    ] as const) {
      expect(
        pattern.test(source),
        `${WEB_VIEW} ${what}. It takes a list of projects and returns markup, and that is the ` +
          'whole of what makes it read-only: agentProject:add/update/remove are classified ' +
          "'relay', so neither RELAY_POLICY nor pnpm typecheck would stop a write added here.",
      ).toBe(false);
    }
  });

  it("gates the shared ProjectForm's repo-only fields on the repo capability", () => {
    // ProjectForm is shared code the web reaches through the Tickets workspace (see the
    // block comment's third narrowing, above) with no `repo` prop supplied. Its folder path,
    // "Runs on" target and the git-only switches below them are the whole of what a folder
    // makes desktop-only, so gating them is the one thing standing between "a browser can
    // file a ticket project" and "a browser can point a project at a path on a machine it
    // cannot see" — and neither the write-channel nor the picker regex above can see this
    // file at all, since the calls they match live here, not under apps/web/src.
    const PROJECT_FORM = 'packages/ui/src/projects/ProjectForm.tsx';
    const source = read(PROJECT_FORM);
    const REPO_ONLY_FIELDS: Array<[RegExp, string]> = [
      [/\{repo && \(\s*<Field\s+label="Repository folder"/, 'the repository folder field'],
      [
        /\{repo && path && distros\.length > 0 && \(\s*<Field\s+label="Runs on"/,
        'the "Runs on" target field',
      ],
    ];
    for (const [pattern, what] of REPO_ONLY_FIELDS) {
      expect(
        pattern.test(source),
        `${PROJECT_FORM} must render ${what} only inside a \`{repo && …}\` guard. Ungating it ` +
          'would need no new write channel — `project:add`/`:update` already relay — it would ' +
          'just let a browser type an absolute path into a field the desktop meant to be the ' +
          'only one offering.',
      ).toBe(true);
    }
  });
});
