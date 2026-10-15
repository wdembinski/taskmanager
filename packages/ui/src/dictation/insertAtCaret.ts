/**
 * Splicing a dictated transcript into a text field (F9.9) — the same caret/selection shape
 * `insertTemplate` (`@tm/shared/promptTemplates`) takes, but a different seam rule: a
 * template is inserted verbatim, while dictation has to glue onto whatever prose already
 * sits on either side of it, so this adds a space wherever the neighboring character isn't
 * already whitespace rather than leaving that to the speaker.
 */
import { shiftMentions, type ComposerValue } from '../chat/mentions';

/** A bare caret (insert) or a `{ start, end }` range (replace) — a textarea's own shape. */
export type CaretSelection = number | { start: number; end: number };

/**
 * Replace `selection` in `text` with `insert`, clamped to `[0, text.length]` and normalized
 * if reversed (same as `insertTemplate`).
 *
 * `insert` is trimmed first, so a transcript's own leading/trailing whitespace never decides
 * the seam — the neighboring character does: a space is added before it when the character
 * just before the (clamped) selection isn't whitespace, and after it when the character just
 * after isn't, so dictating into the middle of "helloworld" yields "hello there world" and
 * dictating next to an existing space never doubles it.
 *
 * An empty or blank `insert` is a no-op: `text` is returned unchanged, with `caret` at the
 * (clamped) start of `selection` — nothing was inserted, so nothing moved.
 */
export function insertAtCaret(
  text: string,
  selection: CaretSelection,
  insert: string,
): { text: string; caret: number } {
  const raw = typeof selection === 'number' ? { start: selection, end: selection } : selection;
  const lo = Math.min(raw.start, raw.end);
  const hi = Math.max(raw.start, raw.end);
  const clamp = (n: number): number => Math.max(0, Math.min(n, text.length));
  const start = clamp(lo);
  const end = clamp(hi);

  const trimmed = insert.trim();
  if (!trimmed) {
    return { text, caret: start };
  }

  const before = start > 0 ? text[start - 1] : '';
  const after = end < text.length ? text[end] : '';
  const leading = before && !/\s/.test(before) ? ' ' : '';
  const trailing = after && !/\s/.test(after) ? ' ' : '';
  const seamed = `${leading}${trimmed}${trailing}`;

  const next = text.slice(0, start) + seamed + text.slice(end);
  return { text: next, caret: start + seamed.length };
}

/**
 * Chat's wrapper, same pattern as `applyTemplateToComposer` in `templateInsert.ts`: splice
 * the transcript into `value.text` via `insertAtCaret`, then carry `mentions` across the edit
 * with `shiftMentions`. The delta is read off the actual before/after text lengths rather than
 * re-derived from `insert`, since the seam spacing and trimming above mean the inserted span
 * is rarely the same length as `insert` itself. `attachments` are left untouched — dictation
 * never attaches anything.
 */
export function insertDictationIntoComposer(
  value: ComposerValue,
  selection: CaretSelection,
  insert: string,
): { value: ComposerValue; caret: number } {
  const { text, caret } = insertAtCaret(value.text, selection, insert);

  const raw = typeof selection === 'number' ? { start: selection, end: selection } : selection;
  const from = Math.min(raw.start, raw.end);
  const to = Math.max(raw.start, raw.end);
  const mentions = shiftMentions(value.mentions, from, to, text.length - value.text.length);

  return { value: { ...value, text, mentions }, caret };
}
