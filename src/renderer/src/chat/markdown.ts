/**
 * A small markdown reader for the agent's turns (Phase 12, phase 5) — pure and tested.
 *
 * **Why not `react-markdown`?** The plan allowed for it (MIT, and it clears the
 * dependency rule in `docs/06`), but the renderer has taken no runtime dependency so
 * far and this is a card-scoped chat, not a document viewer: what an agent actually
 * writes is prose, bullet lists, headings, inline code and fenced blocks. That is the
 * whole grammar below — about a hundred lines, no supply chain, no bundle cost, and no
 * highlighter to argue about. Images fall back to their source text, which is legible; if
 * that stops being enough, swapping this module for `react-markdown` touches exactly one
 * component.
 *
 * Deliberately NOT supported: HTML (never parsed — an agent's output is untrusted text
 * and this app has no need to render markup it was handed), reference links, footnotes.
 *
 * **Anything whose meaning is its layout must reach the renderer as `pre`.** Tables used to
 * fall through to a paragraph and drawings still do; a paragraph keeps its whitespace but is
 * set in a PROPORTIONAL face, so every column in an ASCII table or a box diagram landed a
 * little further out than the last and the picture came apart. Preserving the spaces is only
 * half of it — the glyphs have to be the same width too.
 */

export type Block =
  | { kind: 'code'; lang: string | null; code: string }
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'list'; ordered: boolean; items: string[] }
  | { kind: 'quote'; text: string }
  /** A markdown pipe table, rendered as a real table. */
  | { kind: 'table'; header: string[]; rows: string[][] }
  /**
   * Text whose layout IS its content: an indented code block, or a drawing an agent wrote
   * without fencing it. Shown monospaced and verbatim, with no inline markdown applied —
   * a `*` in a diagram is part of the diagram.
   */
  | { kind: 'pre'; text: string }
  | { kind: 'para'; text: string };

export type Inline =
  | { kind: 'text'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'strong'; text: string }
  | { kind: 'em'; text: string }
  | { kind: 'link'; text: string; href: string };

const FENCE = /^\s*```(.*)$/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const BULLET = /^\s*[-*+]\s+(.*)$/;
const NUMBERED = /^\s*\d+[.)]\s+(.*)$/;
const QUOTE = /^\s*>\s?(.*)$/;
/** A table's second line: `|---|:--:|`. What distinguishes a table from prose with pipes. */
const TABLE_RULE = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;
/** An indented code block — four spaces or a tab, CommonMark's rule. */
const INDENTED = /^(?: {4}|\t)(.*)$/;
/**
 * Box-drawing and block-element characters (U+2500–U+259F). Unambiguous: nothing writes
 * `└` or `│` in prose, so one of these anywhere in a block settles that it is a picture.
 */
const BOX_CHARS = /[─-▟]/;
/** An ASCII table's edge: `+----+` or `| a | b |`. Needs corroboration — see `looksDrawn`. */
const ASCII_GRID = /^\s*[+|]/;

/** Split `| a | b |` into its cells, tolerating the outer pipes being absent. */
function tableCells(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());
}

/**
 * Whether a run of lines is a drawing rather than prose.
 *
 * Two signals, and the second needs corroboration because a single `|` is ordinary in a
 * sentence: a box-drawing character anywhere, or at least two lines that open like a grid.
 * One `| foo` line on its own stays prose.
 */
export function looksDrawn(lines: readonly string[]): boolean {
  if (lines.some((line) => BOX_CHARS.test(line))) return true;
  return lines.filter((line) => ASCII_GRID.test(line)).length >= 2;
}

/**
 * Split markdown into blocks. Fenced code is taken first and verbatim — everything
 * inside a fence is code, including lines that would otherwise look like headings —
 * and an unterminated fence runs to the end of the text rather than swallowing the
 * rest as prose (a truncated stream is exactly when that happens).
 */
export function parseMarkdown(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let para: string[] = [];

  /**
   * Close the paragraph being gathered. A paragraph that turns out to be a drawing becomes
   * `pre` instead — the decision has to happen here, once every line of it is known, since
   * a diagram's first line often looks like ordinary text.
   */
  const flushPara = (): void => {
    if (para.length > 0) {
      if (looksDrawn(para)) {
        // Trailing blank lines go; interior spacing is part of the picture.
        const text = para.join('\n').replace(/\s+$/, '');
        if (text) blocks.push({ kind: 'pre', text });
      } else {
        const text = para.join('\n').trim();
        if (text) blocks.push({ kind: 'para', text });
      }
    }
    para = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = FENCE.exec(line);
    if (fence) {
      flushPara();
      const lang = fence[1].trim() || null;
      const body: string[] = [];
      i++;
      while (i < lines.length && !FENCE.test(lines[i])) body.push(lines[i++]);
      blocks.push({ kind: 'code', lang, code: body.join('\n') });
      continue; // the loop's i++ steps over the closing fence (or past the end)
    }

    const heading = HEADING.exec(line);
    if (heading) {
      flushPara();
      blocks.push({ kind: 'heading', level: heading[1].length, text: heading[2].trim() });
      continue;
    }

    // A table is a header line followed by a rule. The rule is the whole test: without it
    // `a | b` is just a sentence with a pipe in it.
    if (line.includes('|') && i + 1 < lines.length && TABLE_RULE.test(lines[i + 1])) {
      flushPara();
      const header = tableCells(line);
      i++; // step over the rule
      const rows: string[][] = [];
      while (i + 1 < lines.length && lines[i + 1].includes('|')) {
        rows.push(tableCells(lines[++i]));
      }
      blocks.push({ kind: 'table', header, rows });
      continue;
    }

    // An indented block, but only where CommonMark allows one: at the start of a block,
    // never mid-paragraph, so a wrapped sentence or a list continuation is left alone.
    if (para.length === 0 && INDENTED.test(line) && line.trim() !== '') {
      const body: string[] = [INDENTED.exec(line)![1]];
      // A blank line continues the block only when another indented line follows it —
      // a diagram may breathe internally, but two blank lines end it.
      while (i + 1 < lines.length) {
        const next = lines[i + 1];
        if (INDENTED.test(next)) body.push(INDENTED.exec(next)![1]);
        else if (next.trim() === '' && INDENTED.test(lines[i + 2] ?? '')) body.push('');
        else break;
        i++;
      }
      blocks.push({ kind: 'pre', text: body.join('\n').replace(/\s+$/, '') });
      continue;
    }

    const bullet = BULLET.exec(line);
    const numbered = NUMBERED.exec(line);
    if (bullet || numbered) {
      flushPara();
      const ordered = Boolean(numbered);
      const items: string[] = [(bullet ?? numbered)![1].trim()];
      while (i + 1 < lines.length) {
        const next = ordered ? NUMBERED.exec(lines[i + 1]) : BULLET.exec(lines[i + 1]);
        if (!next) break;
        items.push(next[1].trim());
        i++;
      }
      blocks.push({ kind: 'list', ordered, items });
      continue;
    }

    const quote = QUOTE.exec(line);
    if (quote) {
      flushPara();
      const parts: string[] = [quote[1]];
      while (i + 1 < lines.length && QUOTE.test(lines[i + 1])) {
        parts.push(QUOTE.exec(lines[++i])![1]);
      }
      blocks.push({ kind: 'quote', text: parts.join('\n').trim() });
      continue;
    }

    if (line.trim() === '') flushPara();
    else para.push(line);
  }
  flushPara();
  return blocks;
}

/** `` `code` ``, `**strong**`, `*em*`/`_em_`, `[text](href)` — in that precedence. */
const INLINE =
  /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\n]+\*)|(_[^_\n]+_)|(\[[^\]]+\]\((?:https?:\/\/|mailto:)[^\s)]+\))/;

/**
 * Split one line of markdown into inline runs. Only `http(s)` and `mailto` links are
 * recognised: a rendered link is clickable, and `javascript:`/`file:` in agent output
 * has no business being one.
 */
export function parseInline(source: string): Inline[] {
  const out: Inline[] = [];
  let rest = source;
  for (;;) {
    const match = INLINE.exec(rest);
    if (!match || match.index === undefined) break;
    if (match.index > 0) out.push({ kind: 'text', text: rest.slice(0, match.index) });
    const token = match[0];
    if (token.startsWith('`')) out.push({ kind: 'code', text: token.slice(1, -1) });
    else if (token.startsWith('**')) out.push({ kind: 'strong', text: token.slice(2, -2) });
    else if (token.startsWith('*')) out.push({ kind: 'em', text: token.slice(1, -1) });
    else if (token.startsWith('_')) out.push({ kind: 'em', text: token.slice(1, -1) });
    else {
      const split = token.indexOf('](');
      out.push({
        kind: 'link',
        text: token.slice(1, split),
        href: token.slice(split + 2, -1),
      });
    }
    rest = rest.slice(match.index + token.length);
  }
  if (rest) out.push({ kind: 'text', text: rest });
  return out;
}
