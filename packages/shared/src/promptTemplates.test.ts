import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PROMPT_TEMPLATES,
  insertTemplate,
  PROMPT_TEMPLATE_SURFACES,
  renderTemplate,
  templatesFor,
  type PromptTemplate,
} from './promptTemplates';
import { DEFAULT_SETTINGS } from './settings';

describe('renderTemplate', () => {
  it('renders all three placeholders', () => {
    expect(
      renderTemplate('{{title}} / {{key}} / {{project}}', {
        title: 'Fix the login redirect',
        key: 'ABC-123',
        project: 'Website',
      }),
    ).toBe('Fix the login redirect / ABC-123 / Website');
  });

  it('accepts whitespace inside the braces', () => {
    expect(renderTemplate('{{ title }}', { title: 'Fix it' })).toBe('Fix it');
  });

  it('replaces every occurrence of a repeated placeholder', () => {
    expect(renderTemplate('{{title}} and {{title}} again', { title: 'X' })).toBe('X and X again');
  });

  it('renders an absent value as empty', () => {
    expect(renderTemplate('[{{title}}][{{key}}][{{project}}]', {})).toBe('[][][]');
  });

  it('leaves an unknown placeholder verbatim', () => {
    expect(renderTemplate('{{branch}}', { title: 'X' })).toBe('{{branch}}');
  });

  it('leaves an unclosed placeholder verbatim', () => {
    expect(renderTemplate('{{title', { title: 'X' })).toBe('{{title');
  });
});

describe('insertTemplate', () => {
  it('inserts at a caret at the start', () => {
    expect(insertTemplate('world', 0, 'hello ')).toEqual({ text: 'hello world', caret: 6 });
  });

  it('inserts at a caret in the middle', () => {
    expect(insertTemplate('ac', 1, 'b')).toEqual({ text: 'abc', caret: 2 });
  });

  it('inserts at a caret at the end', () => {
    expect(insertTemplate('abc', 3, 'd')).toEqual({ text: 'abcd', caret: 4 });
  });

  it('replaces a selection range', () => {
    expect(insertTemplate('hello world', { start: 6, end: 11 }, 'there')).toEqual({
      text: 'hello there',
      caret: 11,
    });
  });

  it('normalises a reversed selection range', () => {
    expect(insertTemplate('hello world', { start: 11, end: 6 }, 'there')).toEqual({
      text: 'hello there',
      caret: 11,
    });
  });

  it('clamps an out-of-range caret to the text length', () => {
    expect(insertTemplate('abc', 99, 'x')).toEqual({ text: 'abcx', caret: 4 });
  });

  it('clamps a negative caret to the start', () => {
    expect(insertTemplate('abc', -5, 'x')).toEqual({ text: 'xabc', caret: 1 });
  });

  it('honours the caret/range behaviour when untouched is false', () => {
    expect(insertTemplate('ac', 1, 'b', false)).toEqual({ text: 'abc', caret: 2 });
    expect(insertTemplate('hello world', { start: 6, end: 11 }, 'there', false)).toEqual({
      text: 'hello there',
      caret: 11,
    });
  });

  it('appends below an untouched reference regardless of the caret', () => {
    const text = 'A-1\nhttps://example.test/A-1';
    expect(insertTemplate(text, 0, 'Do the thing', true)).toEqual({
      text: 'A-1\nhttps://example.test/A-1\n\nDo the thing',
      caret: 'A-1\nhttps://example.test/A-1\n\nDo the thing'.length,
    });
    expect(insertTemplate(text, 2, 'Do the thing', true)).toEqual({
      text: 'A-1\nhttps://example.test/A-1\n\nDo the thing',
      caret: 'A-1\nhttps://example.test/A-1\n\nDo the thing'.length,
    });
  });

  it('does not double a blank line already trailing the untouched reference', () => {
    expect(insertTemplate('KEY\nurl\n', 0, 'rendered', true)).toEqual({
      text: 'KEY\nurl\n\nrendered',
      caret: 'KEY\nurl\n\nrendered'.length,
    });
  });

  it('ignores a selection range when untouched', () => {
    expect(insertTemplate('A-1\nurl', { start: 0, end: 3 }, 'rendered', true)).toEqual({
      text: 'A-1\nurl\n\nrendered',
      caret: 'A-1\nurl\n\nrendered'.length,
    });
  });

  it('returns rendered outright for empty text, untouched false', () => {
    expect(insertTemplate('', 0, 'rendered', false)).toEqual({ text: 'rendered', caret: 8 });
  });

  it('returns rendered outright for empty text, untouched true', () => {
    expect(insertTemplate('', 0, 'rendered', true)).toEqual({ text: 'rendered', caret: 8 });
  });

  it('treats whitespace-only text as empty, regardless of untouched', () => {
    expect(insertTemplate('   \n  ', 3, 'rendered', false)).toEqual({
      text: 'rendered',
      caret: 8,
    });
    expect(insertTemplate('   \n  ', 3, 'rendered', true)).toEqual({
      text: 'rendered',
      caret: 8,
    });
  });
});

describe('templatesFor', () => {
  const templates: PromptTemplate[] = [
    { id: 'a', name: 'A', body: 'a', surfaces: ['add-task', 'chat'] },
    { id: 'b', name: 'B', body: 'b', surfaces: ['assign'] },
    { id: 'c', name: 'C', body: 'c', surfaces: ['add-task', 'assign', 'chat'] },
  ];

  it('filters to the templates offered on a surface', () => {
    expect(templatesFor(templates, 'assign').map((t) => t.id)).toEqual(['b', 'c']);
  });

  it('keeps the input order', () => {
    expect(templatesFor(templates, 'chat').map((t) => t.id)).toEqual(['a', 'c']);
  });

  it('returns empty for an empty list', () => {
    expect(templatesFor([], 'chat')).toEqual([]);
  });
});

describe('DEFAULT_PROMPT_TEMPLATES', () => {
  it('ships exactly three templates', () => {
    expect(DEFAULT_PROMPT_TEMPLATES).toHaveLength(3);
  });

  it('has unique, stable ids', () => {
    const ids = DEFAULT_PROMPT_TEMPLATES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual([
      'default-bug-reproduce-first',
      'default-test-first-feature',
      'default-review-only',
    ]);
  });

  it('only names valid surfaces', () => {
    for (const template of DEFAULT_PROMPT_TEMPLATES) {
      for (const surface of template.surfaces) {
        expect(PROMPT_TEMPLATE_SURFACES).toContain(surface);
      }
    }
  });

  it('is what DEFAULT_SETTINGS.promptTemplates holds', () => {
    expect(DEFAULT_SETTINGS.promptTemplates).toBe(DEFAULT_PROMPT_TEMPLATES);
  });
});
