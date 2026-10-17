/**
 * Syntax highlighting for the review pane's diff, built on `highlight.js` core plus one
 * dynamically-imported grammar per language — nothing else in this module touches the
 * network or has side effects. `loadLanguage` is the one impure step (it mutates the
 * module-private `hljs` instance); `highlightHunk`/`highlightFile` are pure functions over
 * an ALREADY-loaded language, which is what makes them straightforward to unit test without
 * mocking a loader.
 *
 * The `LOADERS` map below is written as literal `import('highlight.js/lib/languages/…')`
 * calls — one per language — on purpose: a bundler (apps/web's Vite, and eventually
 * apps/client's) can only split a dynamic import into its own chunk when the specifier is a
 * string literal it can see at build time. A computed path (`` `...languages/${id}` ``)
 * would make every grammar land in one chunk, defeating the entire point of lazy-loading
 * languages. `packages/ui/tsup.config.ts` externalizes `highlight.js` for the same reason —
 * this package's own build must not inline what the HOST app's bundler is supposed to split.
 *
 * `toLines` parses `highlight.js`'s own HTML output by hand rather than ever touching the
 * DOM (`dangerouslySetInnerHTML` or an `innerHTML` parse): that output is a narrow, known
 * grammar — `<span class="hljs-…">`, `</span>`, and five escaped entities — not arbitrary
 * HTML, so a small hand-rolled tokenizer is both safe and enough.
 */
import hljs from 'highlight.js/lib/core';
import type { LanguageFn } from 'highlight.js';
import type { DiffFile, DiffHunk, DiffSide, WordSegment, WordSegmentKind } from '@tm/shared/review';

export type LanguageId =
  | 'typescript'
  | 'javascript'
  | 'json'
  | 'css'
  | 'scss'
  | 'less'
  | 'xml'
  | 'markdown'
  | 'python'
  | 'go'
  | 'rust'
  | 'java'
  | 'kotlin'
  | 'csharp'
  | 'c'
  | 'cpp'
  | 'ruby'
  | 'php'
  | 'bash'
  | 'powershell'
  | 'yaml'
  | 'sql'
  | 'swift'
  | 'dockerfile'
  | 'ini'
  | 'diff';

/**
 * Extension (no leading dot) or bare filename, lowercase, → language id. A bare filename
 * (`dockerfile`) and an extension live in the same map because `languageForPath` checks the
 * whole final path segment before it ever looks for a dot.
 */
export const LANGUAGE_BY_EXTENSION: Record<string, LanguageId> = {
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  json: 'json',
  css: 'css',
  scss: 'scss',
  less: 'less',
  xml: 'xml',
  html: 'xml',
  htm: 'xml',
  svg: 'xml',
  // highlight.js has no dedicated Vue grammar — a `.vue` SFC's tags/attrs still highlight
  // sanely under the XML/HTML grammar, which is the closest thing it ships.
  vue: 'xml',
  md: 'markdown',
  markdown: 'markdown',
  py: 'python',
  go: 'go',
  rs: 'rust',
  java: 'java',
  kt: 'kotlin',
  kts: 'kotlin',
  cs: 'csharp',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  hh: 'cpp',
  rb: 'ruby',
  php: 'php',
  sh: 'bash',
  bash: 'bash',
  ps1: 'powershell',
  psm1: 'powershell',
  yaml: 'yaml',
  yml: 'yaml',
  sql: 'sql',
  swift: 'swift',
  dockerfile: 'dockerfile',
  ini: 'ini',
  toml: 'ini',
  diff: 'diff',
  patch: 'diff',
};

/** The language for a repo-relative path, or `null` for anything not in {@link LANGUAGE_BY_EXTENSION}. */
export function languageForPath(path: string): LanguageId | null {
  const base = path.split(/[\\/]/).pop() ?? path;
  const lower = base.toLowerCase();
  const wholeName = LANGUAGE_BY_EXTENSION[lower];
  if (wholeName !== undefined) return wholeName;
  const dot = lower.lastIndexOf('.');
  if (dot === -1) return null;
  return LANGUAGE_BY_EXTENSION[lower.slice(dot + 1)] ?? null;
}

/**
 * One literal dynamic import per language — see the module header for why this cannot be a
 * computed path. `Record<LanguageId, …>` also means TypeScript catches a language added to
 * the union above without a loader here.
 */
const LOADERS: Record<LanguageId, () => Promise<{ default: LanguageFn }>> = {
  typescript: () => import('highlight.js/lib/languages/typescript'),
  javascript: () => import('highlight.js/lib/languages/javascript'),
  json: () => import('highlight.js/lib/languages/json'),
  css: () => import('highlight.js/lib/languages/css'),
  scss: () => import('highlight.js/lib/languages/scss'),
  less: () => import('highlight.js/lib/languages/less'),
  xml: () => import('highlight.js/lib/languages/xml'),
  markdown: () => import('highlight.js/lib/languages/markdown'),
  python: () => import('highlight.js/lib/languages/python'),
  go: () => import('highlight.js/lib/languages/go'),
  rust: () => import('highlight.js/lib/languages/rust'),
  java: () => import('highlight.js/lib/languages/java'),
  kotlin: () => import('highlight.js/lib/languages/kotlin'),
  csharp: () => import('highlight.js/lib/languages/csharp'),
  c: () => import('highlight.js/lib/languages/c'),
  cpp: () => import('highlight.js/lib/languages/cpp'),
  ruby: () => import('highlight.js/lib/languages/ruby'),
  php: () => import('highlight.js/lib/languages/php'),
  bash: () => import('highlight.js/lib/languages/bash'),
  powershell: () => import('highlight.js/lib/languages/powershell'),
  yaml: () => import('highlight.js/lib/languages/yaml'),
  sql: () => import('highlight.js/lib/languages/sql'),
  swift: () => import('highlight.js/lib/languages/swift'),
  dockerfile: () => import('highlight.js/lib/languages/dockerfile'),
  ini: () => import('highlight.js/lib/languages/ini'),
  diff: () => import('highlight.js/lib/languages/diff'),
};

const registered = new Map<LanguageId, Promise<void>>();

/**
 * Loads and registers `id` on the module-private `hljs` instance, exactly once — concurrent
 * callers for the same id share one in-flight promise, and a language `hljs` already knows
 * (registered under this same id by an earlier call) is never re-imported.
 */
export function loadLanguage(id: LanguageId): Promise<void> {
  const inFlight = registered.get(id);
  if (inFlight) return inFlight;
  const promise = LOADERS[id]().then((mod) => {
    if (!hljs.getLanguage(id)) hljs.registerLanguage(id, mod.default);
  });
  registered.set(id, promise);
  return promise;
}

/** The five-hue bucket every hljs scope collapses into — or `null` for "render as plain text". */
export type SyntaxScope = 'keyword' | 'string' | 'comment' | 'number' | 'title';

export interface SyntaxSegment {
  text: string;
  scope: SyntaxScope | null;
}

const HLJS_PREFIX = 'hljs-';

/**
 * `highlight.js`'s own scope vocabulary, collapsed into the five hues this pane renders —
 * see `scopeToCSSClass` in `highlight.js/lib/core.js`: a tiered scope like `title.function`
 * becomes the two classes `hljs-title function_`, which {@link resolveScope} turns back into
 * the dotted string `title.function` before it looks here. Anything not listed (operators,
 * punctuation, plain variables/params/properties, template interpolation, markdown
 * emphasis…) renders as plain text — the budget is for the handful of things worth a reader
 * scanning a diff, not a full editor theme.
 */
const SCOPE_MAP: Record<string, SyntaxScope> = {
  keyword: 'keyword',
  built_in: 'keyword',
  type: 'keyword',
  literal: 'keyword',
  'variable.language': 'keyword',
  'variable.constant': 'keyword',

  string: 'string',
  'char.escape': 'string',
  regexp: 'string',
  symbol: 'string',
  link: 'string',

  comment: 'comment',
  doctag: 'comment',
  quote: 'comment',

  number: 'number',

  title: 'title',
  'title.class': 'title',
  'title.class.inherited': 'title',
  'title.function': 'title',
  'title.function.invoke': 'title',
  section: 'title',
  name: 'title',
  'selector-tag': 'title',
  'selector-id': 'title',
  'selector-class': 'title',
  'selector-attr': 'title',
  'selector-pseudo': 'title',
};

/**
 * `classAttr` is the full `class="…"` value of one `<span>` hljs emitted — one `hljs`-prefixed
 * class for the scope's first dotted piece, plus one underscore-suffixed class per remaining
 * piece (see the `SCOPE_MAP` doc comment). This rebuilds the original dotted scope name and
 * maps it, falling back to just the first piece when the full dotted name isn't listed.
 */
function resolveScope(classAttr: string): SyntaxScope | null {
  const tokens = classAttr.split(' ').filter((t) => t.length > 0);
  if (tokens.length === 0) return null;
  const head = tokens[0].startsWith(HLJS_PREFIX) ? tokens[0].slice(HLJS_PREFIX.length) : tokens[0];
  const rest = tokens.slice(1).map((t) => t.replace(/_+$/, ''));
  const full = [head, ...rest].join('.');
  return SCOPE_MAP[full] ?? SCOPE_MAP[head] ?? null;
}

const ENTITY_RE = /&(lt|gt|amp|quot|#x27);/g;
const ENTITIES: Record<string, string> = {
  lt: '<',
  gt: '>',
  amp: '&',
  quot: '"',
  '#x27': "'",
};

function decodeEntities(text: string): string {
  return text.replace(ENTITY_RE, (_, name: string) => ENTITIES[name]);
}

const TOKEN_RE = /<span class="([^"]*)">|<\/span>|[^<]+/g;

/**
 * Parses one `highlight.js` `.value` string — only ever `<span class="hljs-…">`, `</span>`
 * and the five escaped entities, per the module header — into one segment array per line.
 * The open-scope stack is never reset on a `\n`: a multi-line comment is one `<span>` whose
 * text happens to contain newlines, so every line inside it keeps the same scope without a
 * tag of its own.
 */
export function toLines(hljsHtml: string): SyntaxSegment[][] {
  const lines: SyntaxSegment[][] = [];
  let current: SyntaxSegment[] = [];
  const stack: Array<SyntaxScope | null> = [];

  const append = (text: string): void => {
    if (text.length === 0) return;
    const scope = stack.length > 0 ? stack[stack.length - 1] : null;
    const last = current[current.length - 1];
    if (last && last.scope === scope) {
      last.text += text;
    } else {
      current.push({ text, scope });
    }
  };

  for (const match of hljsHtml.matchAll(TOKEN_RE)) {
    const token = match[0];
    if (token === '</span>') {
      stack.pop();
      continue;
    }
    if (token.startsWith('<span class="')) {
      stack.push(resolveScope(match[1] ?? ''));
      continue;
    }
    const decoded = decodeEntities(token);
    const parts = decoded.split('\n');
    for (let i = 0; i < parts.length; i += 1) {
      append(parts[i]);
      if (i < parts.length - 1) {
        lines.push(current);
        current = [];
      }
    }
  }
  lines.push(current);
  return lines;
}

/** A line over this many characters is never handed to hljs — it stays whole-line plain. */
export const MAX_LINE_CHARS = 1000;
/** A file over this many lines is never highlighted at all — the whole thing stays plain. */
export const MAX_FILE_LINES = 20000;

/**
 * Highlights `lines` as one block (so multi-line constructs like block comments resolve
 * correctly), then splits back into one segment array per input line. A line past
 * {@link MAX_LINE_CHARS} is blanked out of the block handed to `hljs` — so one huge line
 * cannot blow up highlighting cost — and its own entry is replaced with a single plain
 * segment holding its real, un-blanked text.
 */
function highlightLines(lang: LanguageId, lines: readonly string[]): SyntaxSegment[][] {
  if (lines.length === 0) return [];
  const safe = lines.map((text) => (text.length > MAX_LINE_CHARS ? '' : text));
  const html = hljs.highlight(safe.join('\n'), { language: lang, ignoreIllegals: true }).value;
  const parsed = toLines(html);
  return lines.map((text, i) =>
    text.length > MAX_LINE_CHARS ? [{ text, scope: null }] : parsed[i],
  );
}

export interface HunkHighlight {
  old: Map<number, SyntaxSegment[]>;
  new: Map<number, SyntaxSegment[]>;
}

/**
 * Highlights one hunk as two blocks — the old side (context + del) and the new side (context
 * + add) — each as a single string, so a construct spanning several context/del (or
 * context/add) lines still resolves as one thing. Returns each side's segments keyed by the
 * line's index into `hunk.lines`, not by old/new line number, so the caller (`DiffView`'s
 * `Hunk`) can look a row up by the same index it already renders with.
 */
export function highlightHunk(lang: LanguageId, hunk: DiffHunk): HunkHighlight {
  const oldIdx: number[] = [];
  const oldText: string[] = [];
  const newIdx: number[] = [];
  const newText: string[] = [];

  hunk.lines.forEach((line, i) => {
    if (line.kind !== 'add') {
      oldIdx.push(i);
      oldText.push(line.text);
    }
    if (line.kind !== 'del') {
      newIdx.push(i);
      newText.push(line.text);
    }
  });

  const oldSegs = highlightLines(lang, oldText);
  const newSegs = highlightLines(lang, newText);

  return {
    old: new Map(oldIdx.map((lineIndex, k) => [lineIndex, oldSegs[k]])),
    new: new Map(newIdx.map((lineIndex, k) => [lineIndex, newSegs[k]])),
  };
}

/** Highlights a whole file's text, indexed by line number − 1. Past {@link MAX_FILE_LINES}, every line stays plain. */
export function highlightFile(lang: LanguageId, text: string): SyntaxSegment[][] {
  const lines = text.split('\n');
  if (lines.length > MAX_FILE_LINES) {
    return lines.map((line) => [{ text: line, scope: null }]);
  }
  return highlightLines(lang, lines);
}

/**
 * The line texts `side` carries across every hunk in `file`, in order — F15.14's adapter for
 * feeding {@link highlightFile} from a diff that only ever has the hunks' own lines, not the
 * whole file. (It is not a substitute for the real file text where F15.14 has access to it —
 * a diff's hunks skip the unchanged stretches between them.)
 */
export function linesFromFile(file: DiffFile, side: DiffSide): string[] {
  const lines: string[] = [];
  for (const hunk of file.hunks) {
    for (const line of hunk.lines) {
      if (side === 'old' ? line.kind !== 'add' : line.kind !== 'del') {
        lines.push(line.text);
      }
    }
  }
  return lines;
}

export interface MergedSegment {
  text: string;
  scope: SyntaxScope | null;
  word: WordSegmentKind;
}

/**
 * Intersects a line's syntax segments with its word-diff segments — both must cover exactly
 * the same text — into one run of segments carrying both facts, so `DiffView` can render a
 * single `<span>` per run instead of nesting two independent sets of boundaries.
 */
export function mergeSegments(
  syntax: readonly SyntaxSegment[],
  words: readonly WordSegment[],
): MergedSegment[] {
  const result: MergedSegment[] = [];
  let si = 0;
  let wi = 0;
  let sOffset = 0;
  let wOffset = 0;

  while (si < syntax.length && wi < words.length) {
    const sSeg = syntax[si];
    const wSeg = words[wi];
    const take = Math.min(sSeg.text.length - sOffset, wSeg.text.length - wOffset);
    if (take > 0) {
      result.push({
        text: sSeg.text.slice(sOffset, sOffset + take),
        scope: sSeg.scope,
        word: wSeg.kind,
      });
    }
    sOffset += take;
    wOffset += take;
    if (sOffset >= sSeg.text.length) {
      si += 1;
      sOffset = 0;
    }
    if (wOffset >= wSeg.text.length) {
      wi += 1;
      wOffset = 0;
    }
  }
  return result;
}

type IdleDeadline = { timeRemaining: () => number; didTimeout: boolean };
type IdleJob = () => void;

const MIN_IDLE_SLICE_MS = 2;

/**
 * Runs `work` through `requestIdleCallback`, one idle slice at a time, stopping the moment
 * `signal` aborts. Falls back to the standard `setTimeout` idle-callback polyfill shape where
 * `requestIdleCallback` doesn't exist (Node, Safari): a budget that starts at 50ms and
 * depletes with wall-clock time, so the fallback still yields instead of running every job in
 * one tick.
 */
export function scheduleIdle(work: readonly IdleJob[], signal: AbortSignal): void {
  const queue = work.slice();

  const runChunk = (deadline: IdleDeadline): void => {
    while (queue.length > 0 && !signal.aborted && deadline.timeRemaining() > MIN_IDLE_SLICE_MS) {
      const job = queue.shift();
      job?.();
    }
    if (queue.length > 0 && !signal.aborted) scheduleNext();
  };

  const scheduleNext = (): void => {
    const ric = (globalThis as { requestIdleCallback?: (cb: (d: IdleDeadline) => void) => number })
      .requestIdleCallback;
    if (typeof ric === 'function') {
      ric(runChunk);
      return;
    }
    const start = Date.now();
    setTimeout(() => {
      runChunk({ timeRemaining: () => Math.max(0, 50 - (Date.now() - start)), didTimeout: false });
    }, 0);
  };

  scheduleNext();
}
