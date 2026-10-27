import { describe, expect, it } from 'vitest';
import {
  CARD_SECTIONS,
  DEFAULT_COMPACT_ROUTE,
  IN_APP_HISTORY_MARK,
  cardBackAction,
  formatCompactRoute,
  openCardId,
  parseCompactRoute,
  routeForTab,
  tabForRoute,
  wideSelectionRoute,
  type CompactRoute,
  type CompactTab,
} from './compactRoute';

describe('parseCompactRoute', () => {
  it('reads an empty, bare-hash, or rooted hash as inbox', () => {
    expect(parseCompactRoute('')).toEqual({ kind: 'inbox' });
    expect(parseCompactRoute('#')).toEqual({ kind: 'inbox' });
    expect(parseCompactRoute('#/')).toEqual({ kind: 'inbox' });
  });

  it('works with or without the leading #', () => {
    expect(parseCompactRoute('/board')).toEqual(parseCompactRoute('#/board'));
  });

  it('reads a bare board route as the first column', () => {
    expect(parseCompactRoute('#/board')).toEqual({ kind: 'board', column: 'todo' });
  });

  it('reads an explicit board column', () => {
    expect(parseCompactRoute('#/board/in-review')).toEqual({
      kind: 'board',
      column: 'in-review',
    });
  });

  it('rejects an unknown board column', () => {
    expect(parseCompactRoute('#/board/nope')).toBeNull();
  });

  it('reads a bare card route as the chat section', () => {
    expect(parseCompactRoute('#/card/abc')).toEqual({ kind: 'card', id: 'abc', section: 'chat' });
  });

  it('reads an explicit card section', () => {
    for (const section of CARD_SECTIONS) {
      expect(parseCompactRoute(`#/card/abc/${section}`)).toEqual({
        kind: 'card',
        id: 'abc',
        section,
      });
    }
  });

  it('rejects an unknown card section', () => {
    expect(parseCompactRoute('#/card/abc/nope')).toBeNull();
  });

  it('rejects an empty card id', () => {
    expect(parseCompactRoute('#/card/')).toBeNull();
  });

  it('decodes a percent-encoded card id', () => {
    expect(parseCompactRoute('#/card/a%2Fb')).toEqual({
      kind: 'card',
      id: 'a/b',
      section: 'chat',
    });
  });

  it('rejects a bad percent-escape in the id rather than throwing', () => {
    expect(() => parseCompactRoute('#/card/%')).not.toThrow();
    expect(parseCompactRoute('#/card/%')).toBeNull();
  });

  it('reads search and settings', () => {
    expect(parseCompactRoute('#/search')).toEqual({ kind: 'search' });
    expect(parseCompactRoute('#/settings')).toEqual({ kind: 'settings' });
  });

  it('rejects an inbox segment — the home route has none', () => {
    expect(parseCompactRoute('#/inbox')).toBeNull();
  });

  it('rejects an unknown first segment', () => {
    expect(parseCompactRoute('#/nope')).toBeNull();
  });

  it('rejects trailing segments beyond what each kind accepts', () => {
    expect(parseCompactRoute('#/card/x/chat/extra')).toBeNull();
    expect(parseCompactRoute('#/inbox/extra')).toBeNull();
    expect(parseCompactRoute('#/board/todo/extra')).toBeNull();
    expect(parseCompactRoute('#/search/extra')).toBeNull();
    expect(parseCompactRoute('#/settings/extra')).toBeNull();
  });
});

describe('DEFAULT_COMPACT_ROUTE', () => {
  it('is inbox', () => {
    expect(DEFAULT_COMPACT_ROUTE).toEqual({ kind: 'inbox' });
  });
});

describe('formatCompactRoute', () => {
  it('always emits the fully-qualified board form', () => {
    expect(formatCompactRoute({ kind: 'board', column: 'todo' })).toBe('#/board/todo');
  });

  it('always emits the fully-qualified card form', () => {
    expect(formatCompactRoute({ kind: 'card', id: 'abc', section: 'chat' })).toBe(
      '#/card/abc/chat',
    );
  });

  it('encodes an id containing / or spaces', () => {
    expect(formatCompactRoute({ kind: 'card', id: 'a/b c', section: 'chat' })).toBe(
      `#/card/${encodeURIComponent('a/b c')}/chat`,
    );
  });

  it('formats inbox, search, and settings', () => {
    expect(formatCompactRoute({ kind: 'inbox' })).toBe('#/');
    expect(formatCompactRoute({ kind: 'search' })).toBe('#/search');
    expect(formatCompactRoute({ kind: 'settings' })).toBe('#/settings');
  });

  it('round-trips every column, every section, and an id with / or spaces', () => {
    const routes: CompactRoute[] = [
      { kind: 'inbox' },
      { kind: 'board', column: 'todo' },
      { kind: 'board', column: 'in-progress' },
      { kind: 'board', column: 'in-review' },
      { kind: 'board', column: 'blocked' },
      { kind: 'board', column: 'done' },
      ...CARD_SECTIONS.map((section): CompactRoute => ({ kind: 'card', id: 'abc', section })),
      { kind: 'card', id: 'a/b c', section: 'chat' },
      { kind: 'search' },
      { kind: 'settings' },
    ];
    for (const route of routes) {
      expect(parseCompactRoute(formatCompactRoute(route))).toEqual(route);
    }
  });
});

describe('tabForRoute', () => {
  it('folds card onto board', () => {
    expect(tabForRoute({ kind: 'card', id: 'abc', section: 'chat' })).toBe('board');
  });

  it('is the identity on the other three kinds', () => {
    expect(tabForRoute({ kind: 'inbox' })).toBe('inbox');
    expect(tabForRoute({ kind: 'board', column: 'todo' })).toBe('board');
    expect(tabForRoute({ kind: 'search' })).toBe('search');
    expect(tabForRoute({ kind: 'settings' })).toBe('settings');
  });
});

describe('routeForTab', () => {
  it('resets board to the first column, never a leftover one', () => {
    expect(routeForTab('board')).toEqual({ kind: 'board', column: 'todo' });
  });

  it('is the obvious single-screen route for the other three tabs', () => {
    const cases: [CompactTab, CompactRoute][] = [
      ['inbox', { kind: 'inbox' }],
      ['search', { kind: 'search' }],
      ['settings', { kind: 'settings' }],
    ];
    for (const [tab, expected] of cases) {
      expect(routeForTab(tab)).toEqual(expected);
    }
  });
});

describe('cardBackAction', () => {
  // A deep link, a restored tab, or a plain reload all land on a card route with no mark
  // of this router's own in `history.state` — there is nothing of this app's own behind the
  // card, so Back must replace over it with the fallback (the card's own column — or, for
  // a card this tab has no row for, `activeCompactColumn`'s first-column fallback) rather
  // than leave the hardware/gesture back button to exit the tab entirely.
  it("replaces with the fallback on an unmarked (deep-link) state — the card's own column", () => {
    const fallback: CompactRoute = { kind: 'board', column: 'in-progress' };
    expect(cardBackAction(null, fallback)).toEqual({ kind: 'replace', route: fallback });
    expect(cardBackAction(undefined, fallback)).toEqual({ kind: 'replace', route: fallback });
    expect(cardBackAction({}, fallback)).toEqual({ kind: 'replace', route: fallback });
  });

  it('replaces with the first column when the card itself is unknown', () => {
    const fallback: CompactRoute = { kind: 'board', column: 'todo' };
    expect(cardBackAction(null, fallback)).toEqual({ kind: 'replace', route: fallback });
  });

  it('goes through history on a marked (in-app navigation) state', () => {
    const fallback: CompactRoute = { kind: 'board', column: 'todo' };
    expect(cardBackAction({ [IN_APP_HISTORY_MARK]: true }, fallback)).toEqual({ kind: 'history' });
  });

  it('never throws on a malformed state', () => {
    const fallback: CompactRoute = { kind: 'board', column: 'todo' };
    expect(() => cardBackAction('nonsense', fallback)).not.toThrow();
    expect(cardBackAction('nonsense', fallback)).toEqual({ kind: 'replace', route: fallback });
    expect(cardBackAction({ [IN_APP_HISTORY_MARK]: 'yes' }, fallback)).toEqual({
      kind: 'replace',
      route: fallback,
    });
  });
});

describe('openCardId', () => {
  it("reads a card route's own id", () => {
    expect(openCardId({ kind: 'card', id: 'abc', section: 'chat' })).toBe('abc');
  });

  it('is null for every other route kind', () => {
    expect(openCardId({ kind: 'inbox' })).toBeNull();
    expect(openCardId({ kind: 'board', column: 'todo' })).toBeNull();
    expect(openCardId({ kind: 'search' })).toBeNull();
    expect(openCardId({ kind: 'settings' })).toBeNull();
  });
});

describe('wideSelectionRoute', () => {
  it('is the board route for column when nothing is selected', () => {
    expect(wideSelectionRoute({ kind: 'inbox' }, null, 'in-review')).toEqual({
      kind: 'board',
      column: 'in-review',
    });
  });

  it('keeps the current section when the selected id is unchanged', () => {
    const current: CompactRoute = { kind: 'card', id: 'abc', section: 'steps' };
    expect(wideSelectionRoute(current, 'abc', 'todo')).toEqual(current);
  });

  it('resets to chat for a different id', () => {
    const current: CompactRoute = { kind: 'card', id: 'abc', section: 'steps' };
    expect(wideSelectionRoute(current, 'xyz', 'todo')).toEqual({
      kind: 'card',
      id: 'xyz',
      section: 'chat',
    });
  });

  it('resets to chat for a different id even from a non-card current route', () => {
    expect(wideSelectionRoute({ kind: 'board', column: 'todo' }, 'xyz', 'todo')).toEqual({
      kind: 'card',
      id: 'xyz',
      section: 'chat',
    });
  });

  // The rotation round trip (F3.7): a card opened compact survives into wide
  // (`openCardId`), and the wide board's own selection written back through
  // `wideSelectionRoute` round-trips to the SAME card and section rather than resetting —
  // the whole point of carrying the section forward at all.
  it('round-trips a compact card route through openCardId and back unchanged', () => {
    for (const section of CARD_SECTIONS) {
      const compactRoute: CompactRoute = { kind: 'card', id: 'abc', section };
      const selectedId = openCardId(compactRoute);
      const wideWroteBack = wideSelectionRoute(compactRoute, selectedId, 'todo');
      expect(wideWroteBack).toEqual(compactRoute);
    }
  });
});

describe('the reviews route (F15.14b)', () => {
  it('reads a bare reviews route and one naming a subject', () => {
    expect(parseCompactRoute('#/reviews')).toEqual({ kind: 'reviews' });
    expect(parseCompactRoute('#/reviews/task%3At1')).toEqual({
      kind: 'reviews',
      subjectId: 'task:t1',
    });
  });

  it('rejects a trailing segment and a bad percent-escape', () => {
    expect(parseCompactRoute('#/reviews/a/b')).toBeNull();
    expect(parseCompactRoute('#/reviews/%E0%A4%A')).toBeNull();
  });

  it('round-trips the bare route and a subject id with slashes and spaces', () => {
    const routes: CompactRoute[] = [
      { kind: 'reviews' },
      { kind: 'reviews', subjectId: 'pr:github:acme/uploader:412' },
      { kind: 'reviews', subjectId: 'task:a b' },
    ];
    for (const route of routes) {
      expect(parseCompactRoute(formatCompactRoute(route))).toEqual(route);
    }
    expect(formatCompactRoute({ kind: 'reviews' })).toBe('#/reviews');
  });

  it('has no tab of its own — it folds onto inbox', () => {
    expect(tabForRoute({ kind: 'reviews' })).toBe('inbox');
    expect(tabForRoute({ kind: 'reviews', subjectId: 'task:t1' })).toBe('inbox');
  });
});
