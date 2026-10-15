import { describe, expect, it } from 'vitest';
import type { ComposerValue, MentionRange } from '../chat/mentions';
import { insertAtCaret, insertDictationIntoComposer } from './insertAtCaret';

function mention(overrides: Partial<MentionRange> = {}): MentionRange {
  return { start: 0, end: 0, accountId: 'u1', displayName: 'Ann', ...overrides };
}

function composer(overrides: Partial<ComposerValue> = {}): ComposerValue {
  return { text: '', mentions: [], attachments: [], ...overrides };
}

describe('insertAtCaret', () => {
  it('inserts at the start of existing text, adding a trailing seam space', () => {
    expect(insertAtCaret('world', 0, 'hello')).toEqual({ text: 'hello world', caret: 6 });
  });

  it('inserts in the middle of existing text, seaming both sides', () => {
    expect(insertAtCaret('helloworld', 5, 'there')).toEqual({
      text: 'hello there world',
      caret: 12,
    });
  });

  it('inserts at the end of existing text, adding a leading seam space', () => {
    expect(insertAtCaret('hello', 5, 'world')).toEqual({ text: 'hello world', caret: 11 });
  });

  it('inserts into empty text verbatim, with no seam on either side', () => {
    expect(insertAtCaret('', 0, 'hello')).toEqual({ text: 'hello', caret: 5 });
  });

  it('does not add a leading space when the preceding character is already whitespace', () => {
    expect(insertAtCaret('hello ', 6, 'world')).toEqual({ text: 'hello world', caret: 11 });
  });

  it('does not add a trailing space when the following character is already whitespace', () => {
    expect(insertAtCaret('hello world', 5, 'there')).toEqual({
      text: 'hello there world',
      caret: 11,
    });
  });

  it('never doubles a space when the insert carries its own leading/trailing whitespace', () => {
    expect(insertAtCaret('hello world', 5, '  there  ')).toEqual({
      text: 'hello there world',
      caret: 11,
    });
  });

  it('replaces a selection outright', () => {
    expect(insertAtCaret('hello world', { start: 6, end: 11 }, 'there')).toEqual({
      text: 'hello there',
      caret: 11,
    });
  });

  it('normalizes a reversed selection before replacing', () => {
    expect(insertAtCaret('hello world', { start: 11, end: 6 }, 'there')).toEqual({
      text: 'hello there',
      caret: 11,
    });
  });

  it('clamps an out-of-range selection to the text bounds', () => {
    expect(insertAtCaret('hi', { start: -5, end: 50 }, 'hello')).toEqual({
      text: 'hello',
      caret: 5,
    });
  });

  it('is a no-op for an empty insert, returning the original caret', () => {
    expect(insertAtCaret('hello', 5, '')).toEqual({ text: 'hello', caret: 5 });
  });

  it('is a no-op for a whitespace-only insert', () => {
    expect(insertAtCaret('hello', 2, '   ')).toEqual({ text: 'hello', caret: 2 });
  });
});

describe('insertDictationIntoComposer', () => {
  it('splices the transcript into text and leaves attachments untouched', () => {
    const value = composer({ text: 'helloworld', attachments: ['/tmp/a.png'] });
    const result = insertDictationIntoComposer(value, 5, 'there');
    expect(result.value.text).toBe('hello there world');
    expect(result.value.attachments).toEqual(['/tmp/a.png']);
    expect(result.caret).toBe(12);
  });

  it('shifts a mention that sits after the caret', () => {
    const value = composer({
      text: 'hi @Ann',
      mentions: [mention({ start: 3, end: 7, displayName: 'Ann' })],
    });
    const result = insertDictationIntoComposer(value, 2, 'there');
    expect(result.value.text).toBe('hi there @Ann');
    expect(result.value.mentions).toEqual([mention({ start: 9, end: 13, displayName: 'Ann' })]);
  });

  it('keeps a mention that sits before the caret unchanged', () => {
    const value = composer({
      text: '@Ann hi',
      mentions: [mention({ start: 0, end: 4, displayName: 'Ann' })],
    });
    const result = insertDictationIntoComposer(value, 7, 'there');
    expect(result.value.text).toBe('@Ann hi there');
    expect(result.value.mentions).toEqual([mention({ start: 0, end: 4, displayName: 'Ann' })]);
  });
});
