/**
 * A small markdown reader for the agent's turns (Phase 12, phase 5) — pure and tested.
 *
 * **Why not `react-markdown`?** The plan allowed for it (MIT, and it clears the
 * dependency rule in `docs/06`), but the renderer has taken no runtime dependency so
 * far and this is a card-scoped chat, not a document viewer: what an agent actually
 * writes is prose, bullet lists, headings, inline code and fenced blocks. That is the
 * whole grammar below — about a hundred lines, no supply chain, no bundle cost, and no
 * highlighter to argue about. Tables and images fall back to their source text, which
 * is legible; if that stops being enough, swapping this module for `react-markdown`
 * touches exactly one component.
 *
 * Deliberately NOT supported: HTML (never parsed — an agent's output is untrusted text
 * and this app has no need to render markup it was handed), reference links, footnotes.
 */

export type Block =
  | { kind: 'code'; lang: string | null; code: string }
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'list'; ordered: boolean; items: string[] }
  | { kind: 'quote'; text: string }
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

  const flushPara = (): void => {
    const text = para.join('\n').trim();
    if (text) blocks.push({ kind: 'para', text });
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
