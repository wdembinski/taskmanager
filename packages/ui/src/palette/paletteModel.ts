/**
 * The command palette's pure model — no React. A "command" is anything the palette can list
 * and run (navigate somewhere, open a card, jump to a project, fire an action); a "source"
 * (`PaletteSource`) is a function that produces a fresh list of commands for the current
 * `PaletteContext`, so the host can mix together e.g. a static navigate list with a dynamic
 * per-card list without the model knowing where any of it came from.
 *
 * `paletteScore` and `rankCommands` decide what a query shows and in what order; `paletteReduce`
 * is the `useReducer` transition function the palette component (F9.3) drives.
 */

/** Fixed section order the palette always renders in, independent of source order. */
export const PALETTE_GROUP_ORDER = ['navigate', 'cards', 'projects', 'actions'] as const;

export type PaletteGroup = (typeof PALETTE_GROUP_ORDER)[number];

/**
 * One row the palette can show. `projectId` is a locality hint, not a filter — a command that
 * belongs to a card or project names it so {@link rankCommands} can surface the current
 * project's own commands first. `hostOnly` is carried through untouched; the host-vs-web split
 * (F9.5) is the only thing that reads it.
 */
export interface PaletteCommand {
  id: string;
  group: PaletteGroup;
  title: string;
  subtitle?: string;
  keywords?: string[];
  projectId?: string | null;
  run: () => void | Promise<void>;
  hostOnly?: boolean;
}

/** What a source needs to decide which commands it offers — just the current project for now. */
export interface PaletteContext {
  currentProjectId: string | null;
}

/** Produces a fresh command list for `ctx`, called every time the palette opens. */
export type PaletteSource = (ctx: PaletteContext) => PaletteCommand[];

/** Every source's commands, concatenated in source order. */
export function collectCommands(
  sources: readonly PaletteSource[],
  ctx: PaletteContext,
): PaletteCommand[] {
  return sources.flatMap((source) => source(ctx));
}

/** Index of `index - 1` in `text`, or `0`, is a word boundary when not alphanumeric. */
function isBoundary(text: string, index: number): boolean {
  if (index === 0) return true;
  return !/[a-z0-9]/i.test(text[index - 1]);
}

/**
 * The best score a single `token` earns against `haystack`'s occurrences of it:
 * `boundaryScore` if any occurrence starts at a word boundary, else `midScore` if it occurs
 * at all, else `0`.
 */
function bestSubstringScore(
  haystack: string,
  token: string,
  boundaryScore: number,
  midScore: number,
): number {
  let index = haystack.indexOf(token);
  let foundMid = false;
  while (index !== -1) {
    if (isBoundary(haystack, index)) return boundaryScore;
    foundMid = true;
    index = haystack.indexOf(token, index + 1);
  }
  return foundMid ? midScore : 0;
}

/**
 * One token's score against `text`/`keywords` (already lower-cased): the best of a text hit
 * (100 at a boundary, 40 mid-word) and a keyword hit (30 at a boundary, 10 mid-word), plus 20
 * when `text` starts with the token. `0` means the token matched neither — the whole query
 * fails, per {@link paletteScore}.
 */
function tokenScore(text: string, keywords: readonly string[], token: string): number {
  const textScore = bestSubstringScore(text, token, 100, 40);
  let keywordScore = 0;
  for (const keyword of keywords) {
    const score = bestSubstringScore(keyword, token, 30, 10);
    if (score > keywordScore) keywordScore = score;
  }

  const best = Math.max(textScore, keywordScore);
  if (best === 0) return 0;
  return text.startsWith(token) ? best + 20 : best;
}

/**
 * How well `query` matches `text` (a command's title) given its `keywords` (subtitle, id, and
 * whatever else the caller wants searchable). `0` means hide the row: every whitespace-split
 * token of `query` must hit `text` or some keyword as a substring, case-insensitively, or the
 * whole thing fails. A blank query matches everything with score `1`, so an empty palette
 * still lists every command in its default order.
 */
export function paletteScore(text: string, query: string, keywords: readonly string[] = []): number {
  const tokens = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return 1;

  const lowerText = text.toLowerCase();
  const lowerKeywords = keywords.map((keyword) => keyword.toLowerCase());

  let total = 0;
  for (const token of tokens) {
    const score = tokenScore(lowerText, lowerKeywords, token);
    if (score === 0) return 0;
    total += score;
  }
  return total;
}

/**
 * `commands` scored against `query` and ordered for display: grouped by
 * {@link PALETTE_GROUP_ORDER}, then by score descending, then a command local to
 * `ctx.currentProjectId` before a non-local one (only meaningful once `projectId` and
 * `currentProjectId` are both set), then original source order. With a blank query every
 * score ties, so the local-before-non-local rule alone decides order within a group — the
 * current project's own cards first, otherwise whatever order the sources produced them in.
 */
export function rankCommands(
  commands: readonly PaletteCommand[],
  query: string,
  ctx: PaletteContext,
): PaletteCommand[] {
  const scored = commands
    .map((command, index) => {
      const keywords = [command.subtitle, ...(command.keywords ?? []), command.id].filter(
        (keyword): keyword is string => keyword !== undefined,
      );
      return { command, index, score: paletteScore(command.title, query, keywords) };
    })
    .filter((entry) => entry.score > 0);

  scored.sort((a, b) => {
    const groupDiff = PALETTE_GROUP_ORDER.indexOf(a.command.group) - PALETTE_GROUP_ORDER.indexOf(b.command.group);
    if (groupDiff !== 0) return groupDiff;
    if (a.score !== b.score) return b.score - a.score;

    const aLocal = a.command.projectId != null && a.command.projectId === ctx.currentProjectId;
    const bLocal = b.command.projectId != null && b.command.projectId === ctx.currentProjectId;
    if (aLocal !== bLocal) return aLocal ? -1 : 1;

    return a.index - b.index;
  });

  return scored.map((entry) => entry.command);
}

/** The palette's whole UI-facing state. `commands` is the snapshot taken when it opened — a
 *  new query re-ranks that snapshot rather than re-collecting from sources. */
export interface PaletteState {
  open: boolean;
  query: string;
  commands: PaletteCommand[];
  ctx: PaletteContext;
  rows: PaletteCommand[];
  activeIndex: number;
  selected: PaletteCommand | null;
}

export const initialPaletteState: PaletteState = {
  open: false,
  query: '',
  commands: [],
  ctx: { currentProjectId: null },
  rows: [],
  activeIndex: -1,
  selected: null,
};

export type PaletteEvent =
  | { type: 'open'; commands: PaletteCommand[]; ctx: PaletteContext }
  | { type: 'close' }
  | { type: 'query'; query: string }
  | { type: 'move'; delta: number }
  | { type: 'select' };

/** First row's index, or `-1` when `rows` is empty — shared by `open` and `query`. */
function firstActiveIndex(rows: readonly PaletteCommand[]): number {
  return rows.length > 0 ? 0 : -1;
}

/**
 * The palette's `useReducer` transition. Any event other than `open` while closed is a no-op
 * (returns `state` unchanged) — the component can dispatch freely without checking `open`
 * itself first.
 */
export function paletteReduce(state: PaletteState, event: PaletteEvent): PaletteState {
  if (!state.open && event.type !== 'open') return state;

  switch (event.type) {
    case 'open': {
      const rows = rankCommands(event.commands, '', event.ctx);
      return {
        open: true,
        query: '',
        commands: event.commands,
        ctx: event.ctx,
        rows,
        activeIndex: firstActiveIndex(rows),
        selected: null,
      };
    }

    case 'close':
      return initialPaletteState;

    case 'query': {
      const rows = rankCommands(state.commands, event.query, state.ctx);
      return {
        ...state,
        query: event.query,
        rows,
        activeIndex: firstActiveIndex(rows),
        selected: null,
      };
    }

    case 'move': {
      const n = state.rows.length;
      if (n === 0) return state;
      return { ...state, activeIndex: (((state.activeIndex + event.delta) % n) + n) % n };
    }

    case 'select': {
      if (state.rows.length === 0) return state;
      return { ...state, selected: state.rows[state.activeIndex] };
    }
  }
}
