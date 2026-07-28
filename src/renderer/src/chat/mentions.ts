/**
 * mentions — the offset bookkeeping behind the composer's @mention picker.
 *
 * The composer holds plain text plus a list of `{start, end}` ranges naming people. That
 * pairing is the whole design (see `main/jira/adf.ts` for why it isn't an inline
 * syntax), and it has one hazard: **every edit to the text moves the ranges**. Type a
 * word before an existing mention and its offsets are stale; delete across one and it
 * now points at the wrong characters, which would send a comment naming somebody the
 * user never named.
 *
 * So this module owns two jobs — finding the @query under the caret, and keeping the
 * existing ranges honest across an arbitrary edit. It is where the real bugs live, and
 * it is pure, so they can be tested.
 */

/** A person named in the text, with the range their label occupies. */
export interface MentionRange {
  start: number;
  end: number;
  /** Cloud account id or Server username. Null = never resolved; sent as plain text. */
  accountId: string | null;
  displayName: string;
}

/** What the composer holds: text, and who is named in it. */
export interface ComposerValue {
  text: string;
  mentions: MentionRange[];
  /** Absolute paths of files to upload with the comment. */
  attachments: string[];
}

export const EMPTY_COMPOSER: ComposerValue = { text: '', mentions: [], attachments: [] };

/** The half-typed `@name` the caret sits in, if any. */
export interface MentionQuery {
  /** Offset of the `@`. */
  start: number;
  /** Offset just past the last typed character (i.e. the caret). */
  end: number;
  /** What has been typed after the `@`. */
  query: string;
}

/**
 * Find the mention being typed at `caret`.
 *
 * Scans back to the nearest `@` that starts a word (beginning of text, or preceded by
 * whitespace or an opening bracket — so an email address never opens the picker), and
 * stops at whitespace. Two words of query are allowed, because real display names have
 * a space in them and the picker is useless if it closes on the first one.
 */
export function findMentionQuery(text: string, caret: number): MentionQuery | null {
  if (caret < 0 || caret > text.length) return null;
  let at = -1;
  let spaces = 0;
  for (let i = caret - 1; i >= 0; i--) {
    const ch = text[i];
    if (ch === '@') {
      at = i;
      break;
    }
    if (ch === '\n') return null;
    if (ch === ' ') {
      spaces += 1;
      if (spaces > 1) return null; // more than one space back — no longer a name
      continue;
    }
  }
  if (at === -1) return null;
  const before = at > 0 ? text[at - 1] : '';
  if (before && !/[\s([{]/.test(before)) return null; // e.g. "me@example.com"
  return { start: at, end: caret, query: text.slice(at + 1, caret) };
}

/**
 * Replace the query range with a person's label and record the mention.
 *
 * Returns the new value plus where the caret should land — just past the trailing space
 * we add, so the user keeps typing the sentence rather than extending the name.
 */
export function insertMention(
  value: ComposerValue,
  range: { start: number; end: number },
  person: { accountId: string | null; displayName: string },
): { value: ComposerValue; caret: number } {
  const label = `@${person.displayName}`;
  const inserted = `${label} `;
  const text = value.text.slice(0, range.start) + inserted + value.text.slice(range.end);
  const delta = inserted.length - (range.end - range.start);
  const mentions = shiftMentions(value.mentions, range.start, range.end, delta);
  mentions.push({
    start: range.start,
    end: range.start + label.length,
    accountId: person.accountId,
    displayName: person.displayName,
  });
  mentions.sort((a, b) => a.start - b.start);
  return {
    value: { ...value, text, mentions },
    caret: range.start + inserted.length,
  };
}

/**
 * Move existing ranges across an edit that replaced `[from, to)` with `delta` more (or
 * fewer) characters. A mention the edit reached INTO is dropped rather than adjusted:
 * half a name is not a name, and silently keeping the id would send a comment naming
 * someone the text no longer mentions.
 */
export function shiftMentions(
  mentions: readonly MentionRange[],
  from: number,
  to: number,
  delta: number,
): MentionRange[] {
  const out: MentionRange[] = [];
  for (const m of mentions) {
    if (m.end <= from) {
      out.push({ ...m }); // entirely before the edit
    } else if (m.start >= to) {
      out.push({ ...m, start: m.start + delta, end: m.end + delta }); // entirely after
    }
    // else: the edit touched it — drop it.
  }
  return out;
}

/**
 * Reconcile the mention list against text that changed by some unknown edit.
 *
 * A `<textarea>` reports the result, not the operation, so the edit is recovered by
 * comparing the common prefix and suffix of the old and new text. That identifies the
 * one contiguous replaced span for every ordinary edit (typing, pasting, deleting a
 * selection); for a weirder change it identifies a wider span, which just drops more
 * mentions than strictly necessary — the safe direction.
 *
 * Then any range whose text no longer reads as its label is dropped, which is the
 * backstop: whatever the offsets say, a mention has to still be spelled in the text.
 */
export function reconcileMentions(
  mentions: readonly MentionRange[],
  oldText: string,
  newText: string,
): MentionRange[] {
  if (oldText === newText) return mentions.map((m) => ({ ...m }));

  let prefix = 0;
  const maxPrefix = Math.min(oldText.length, newText.length);
  while (prefix < maxPrefix && oldText[prefix] === newText[prefix]) prefix++;

  let suffix = 0;
  const maxSuffix = Math.min(oldText.length, newText.length) - prefix;
  while (
    suffix < maxSuffix &&
    oldText[oldText.length - 1 - suffix] === newText[newText.length - 1 - suffix]
  ) {
    suffix++;
  }

  const from = prefix;
  const to = oldText.length - suffix;
  const delta = newText.length - oldText.length;
  return shiftMentions(mentions, from, to, delta).filter(
    (m) => newText.slice(m.start, m.end) === `@${m.displayName}`,
  );
}
