import { describe, expect, it } from 'vitest';
import {
  CARD_SECTIONS,
  DEFAULT_COMPACT_ROUTE,
  formatCompactRoute,
  parseCompactRoute,
  routeForTab,
  tabForRoute,
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
