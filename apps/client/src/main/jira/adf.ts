/**
 * ADF — Atlassian Document Format, in both directions.
 *
 * Two problems live here.
 *
 * **Writing.** `addComment` used to wrap a string in a one-paragraph document, which is
 * fine until the comment has to carry an @mention. A mention is a NODE, not a piece of
 * text, so it cannot be spliced in after the fact — the document has to be built with
 * the mention ranges already known. They arrive as real `{start, end}` offsets from the
 * composer, which owns them, rather than as a `@[Name](id)` micro-syntax: a syntax is a
 * thing users can type by accident and a thing we would then have to escape.
 *
 * **Reading.** The old flattener collected `text` leaves only. A mention's label lives
 * in `attrs.text`, not in a text leaf, so "@Alice can you look at this" arrived as
 * " can you look at this" — the app quietly deleted the most important word in the
 * sentence. Media and inline cards vanished the same way.
 *
 * So: `buildAdf` writes a document, `parseAdf` reads one into structured blocks, and
 * `blocksToText` flattens those blocks back to the plain string every existing caller
 * (the issue description, the agent briefing) still wants. v2 instances have no ADF at
 * all — they take wiki markup — so `buildWikiBody` is the same job in the other dialect.
 *
 * Pure: no fetch, no Electron, no DB.
 */
import type { AdfBlock, AdfSpan } from '@shared/adf';

/** A person the composer resolved, with the range of `text` their name occupies. */
export interface AdfMention {
  /** Inclusive start offset into the plain text. */
  start: number;
  /** Exclusive end offset into the plain text. */
  end: number;
  /** Cloud account id, or a Server/DC username. Null means "render as plain text". */
  accountId: string | null;
  displayName: string;
}

/** A file already uploaded to the issue, cited from the comment body. */
export interface AdfAttachmentRef {
  filename: string;
  /** Browser-openable URL, when the caller knows one. */
  url?: string;
}

// The parsed shapes live in `@shared/adf`: they cross the IPC boundary, so per
// `docs/02` their types belong to the contract rather than to this module.
export type { AdfBlock, AdfSpan } from '@shared/adf';

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/** Mentions that are in range and non-overlapping, earliest first. */
function usableMentions(text: string, mentions: readonly AdfMention[]): AdfMention[] {
  const sorted = [...mentions]
    .filter((m) => m.start >= 0 && m.end <= text.length && m.end > m.start)
    .sort((a, b) => a.start - b.start);
  const out: AdfMention[] = [];
  let cursor = 0;
  for (const m of sorted) {
    if (m.start < cursor) continue; // overlaps one we already took — drop it
    out.push(m);
    cursor = m.end;
  }
  return out;
}

/** Inline nodes for one line of text, splicing in the mentions that fall inside it. */
function inlineNodes(line: string, offset: number, mentions: readonly AdfMention[]): unknown[] {
  const nodes: unknown[] = [];
  let at = 0;
  for (const m of mentions) {
    const start = m.start - offset;
    const end = m.end - offset;
    if (start < 0 || end > line.length) continue;
    if (start > at) nodes.push({ type: 'text', text: line.slice(at, start) });
    // A mention with no id is a name we never resolved — emit it as text rather than an
    // ADF node JIRA would reject.
    nodes.push(
      m.accountId
        ? { type: 'mention', attrs: { id: m.accountId, text: `@${m.displayName}` } }
        : { type: 'text', text: line.slice(start, end) },
    );
    at = end;
  }
  if (at < line.length) nodes.push({ type: 'text', text: line.slice(at) });
  return nodes;
}

/**
 * Build an ADF document from plain text plus resolved mention ranges.
 *
 * One paragraph per line, which is what the composer's newlines mean to the person who
 * typed them. Attachments are cited as a trailing paragraph of links rather than inline
 * `media` nodes: a true inline media node needs an Atlassian media-services token
 * exchange that a plain REST client cannot do, so "attach a file to a comment" is really
 * "attach it to the issue and reference it from the comment".
 */
export function buildAdf(
  text: string,
  mentions: readonly AdfMention[] = [],
  attachments: readonly AdfAttachmentRef[] = [],
): unknown {
  const usable = usableMentions(text, mentions);
  const content: unknown[] = [];
  let offset = 0;
  for (const line of text.split('\n')) {
    const nodes = inlineNodes(line, offset, usable);
    // An empty paragraph is legal ADF and is what a blank line means.
    content.push(nodes.length ? { type: 'paragraph', content: nodes } : { type: 'paragraph' });
    offset += line.length + 1; // +1 for the newline we split on
  }
  if (attachments.length) {
    content.push({
      type: 'paragraph',
      content: attachments.flatMap((a, i) => {
        const label = a.filename;
        const node = a.url
          ? { type: 'text', text: label, marks: [{ type: 'link', attrs: { href: a.url } }] }
          : { type: 'text', text: label };
        return i === 0
          ? [{ type: 'text', text: '📎 ' }, node]
          : [{ type: 'text', text: ', ' }, node];
      }),
    });
  }
  return { type: 'doc', version: 1, content };
}

/**
 * The same comment for a v2 instance, in wiki markup. `[~id]` is how Server/DC and the
 * v2 Cloud API name a person, and `!file!` is its attachment reference.
 */
export function buildWikiBody(
  text: string,
  mentions: readonly AdfMention[] = [],
  attachments: readonly AdfAttachmentRef[] = [],
): string {
  const usable = usableMentions(text, mentions);
  let out = '';
  let at = 0;
  for (const m of usable) {
    out += text.slice(at, m.start);
    out += m.accountId ? `[~${m.accountId}]` : text.slice(m.start, m.end);
    at = m.end;
  }
  out += text.slice(at);
  if (attachments.length) {
    out += `\n\n${attachments.map((a) => `!${a.filename}!`).join(' ')}`;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

function childrenOf(node: Record<string, unknown>): unknown[] {
  return Array.isArray(node.content) ? node.content : [];
}

function attrString(node: Record<string, unknown>, key: string): string | null {
  const attrs = asRecord(node.attrs);
  const value = attrs?.[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** Collect the inline spans under a block node. */
function readSpans(nodes: readonly unknown[]): AdfSpan[] {
  const spans: AdfSpan[] = [];
  const push = (span: AdfSpan): void => {
    const last = spans[spans.length - 1];
    // Merge adjacent plain text so a run split by marks doesn't render as fragments.
    if (span.kind === 'text' && last?.kind === 'text') last.text += span.text;
    else spans.push(span);
  };

  const walk = (raw: unknown): void => {
    const node = asRecord(raw);
    if (!node) return;
    switch (node.type) {
      case 'text': {
        const text = typeof node.text === 'string' ? node.text : '';
        if (!text) return;
        const marks = Array.isArray(node.marks) ? node.marks : [];
        const link = marks.map(asRecord).find((m) => m?.type === 'link');
        const href = link ? attrString(link, 'href') : null;
        if (href) push({ kind: 'link', text, href });
        else if (marks.map(asRecord).some((m) => m?.type === 'code')) push({ kind: 'code', text });
        else push({ kind: 'text', text });
        return;
      }
      case 'mention': {
        // `attrs.text` carries the display label ("@Alice"). Fall back to the id, which
        // is ugly but is still infinitely better than dropping the word entirely.
        const id = attrString(node, 'id');
        const label = attrString(node, 'text') ?? (id ? `@${id}` : '@unknown');
        push({ kind: 'mention', text: label, id });
        return;
      }
      case 'hardBreak':
        push({ kind: 'text', text: '\n' });
        return;
      case 'inlineCard':
      case 'embedCard': {
        const url = attrString(node, 'url');
        if (url) push({ kind: 'link', text: url, href: url });
        return;
      }
      case 'emoji': {
        push({
          kind: 'text',
          text: attrString(node, 'text') ?? attrString(node, 'shortName') ?? '',
        });
        return;
      }
      default:
        for (const child of childrenOf(node)) walk(child);
    }
  };

  for (const raw of nodes) walk(raw);
  return spans;
}

/** The spans of every list item under a bulletList/orderedList node. */
function readListItems(node: Record<string, unknown>): AdfSpan[][] {
  return childrenOf(node)
    .map(asRecord)
    .filter((item): item is Record<string, unknown> => item !== null)
    .map((item) => readSpans(childrenOf(item)));
}

/**
 * Parse a comment/description body into blocks.
 *
 * Accepts a v2 plain string (one paragraph per line) as well as a v3 document, so
 * callers never have to know which API version answered. Anything unrecognised
 * degrades to a paragraph of whatever text it contained rather than disappearing.
 */
export function parseAdf(body: unknown): AdfBlock[] {
  if (typeof body === 'string') {
    return body.split('\n').map((line) => ({
      kind: 'paragraph' as const,
      spans: [{ kind: 'text' as const, text: line }],
    }));
  }
  const doc = asRecord(body);
  if (!doc) return [];

  const blocks: AdfBlock[] = [];
  const walk = (raw: unknown): void => {
    const node = asRecord(raw);
    if (!node) return;
    switch (node.type) {
      case 'paragraph': {
        const spans = readSpans(childrenOf(node));
        if (spans.length) blocks.push({ kind: 'paragraph', spans });
        return;
      }
      case 'heading': {
        const attrs = asRecord(node.attrs);
        const level = typeof attrs?.level === 'number' ? attrs.level : 1;
        blocks.push({ kind: 'heading', level, spans: readSpans(childrenOf(node)) });
        return;
      }
      case 'blockquote':
        blocks.push({ kind: 'quote', spans: readSpans(childrenOf(node)) });
        return;
      case 'codeBlock': {
        const text = readSpans(childrenOf(node))
          .map((s) => s.text)
          .join('');
        blocks.push({ kind: 'codeBlock', text });
        return;
      }
      case 'bulletList':
      case 'orderedList':
        blocks.push({
          kind: 'list',
          ordered: node.type === 'orderedList',
          items: readListItems(node),
        });
        return;
      case 'media':
        blocks.push({ kind: 'media', filename: attrString(node, 'alt') });
        return;
      case 'rule':
        return;
      default:
        for (const child of childrenOf(node)) walk(child);
    }
  };

  for (const child of childrenOf(doc)) walk(child);
  return blocks;
}

/** Flatten blocks back to the plain text the description and briefing paths still use. */
export function blocksToText(blocks: readonly AdfBlock[]): string {
  const lines: string[] = [];
  for (const block of blocks) {
    switch (block.kind) {
      case 'paragraph':
      case 'heading':
      case 'quote':
        lines.push(block.spans.map((s) => s.text).join(''));
        break;
      case 'codeBlock':
        lines.push(block.text);
        break;
      case 'list':
        for (const item of block.items) lines.push(item.map((s) => s.text).join(''));
        break;
      case 'media':
        if (block.filename) lines.push(block.filename);
        break;
    }
  }
  return lines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
