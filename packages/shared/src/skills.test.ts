import { describe, expect, it } from 'vitest';
import {
  formatSkillRef,
  isValidSkillName,
  parseSkillMarkdown,
  parseSkillRef,
  serializeSkillMarkdown,
  skillNameFromFileName,
  SKILL_BODY_MAX,
  type SkillRef,
} from './skills';

describe('SKILL_BODY_MAX', () => {
  it('is 64 KiB', () => {
    expect(SKILL_BODY_MAX).toBe(65536);
  });
});

describe('isValidSkillName', () => {
  it('accepts a lower-case slug within the length bound', () => {
    expect(isValidSkillName('a')).toBe(true);
    expect(isValidSkillName('tdd')).toBe(true);
    expect(isValidSkillName('write-failing-test-first')).toBe(true);
    expect(isValidSkillName('a'.repeat(64))).toBe(true);
  });

  it('rejects an empty string or one over the length bound', () => {
    expect(isValidSkillName('')).toBe(false);
    expect(isValidSkillName('a'.repeat(65))).toBe(false);
  });

  it('rejects characters outside lower-case ASCII, digits and hyphens', () => {
    expect(isValidSkillName('Tdd')).toBe(false);
    expect(isValidSkillName('write failing')).toBe(false);
    expect(isValidSkillName('write_failing')).toBe(false);
    expect(isValidSkillName('write.failing')).toBe(false);
  });

  it('rejects non-strings', () => {
    expect(isValidSkillName(undefined)).toBe(false);
    expect(isValidSkillName(null)).toBe(false);
    expect(isValidSkillName(42)).toBe(false);
    expect(isValidSkillName({})).toBe(false);
  });
});

describe('skillNameFromFileName', () => {
  it('drops a trailing .md case-insensitively', () => {
    expect(skillNameFromFileName('tdd.md')).toBe('tdd');
    expect(skillNameFromFileName('tdd.MD')).toBe('tdd');
  });

  it('slugs spaces, punctuation and mixed case', () => {
    expect(skillNameFromFileName('My Skill.md')).toBe('my-skill');
    expect(skillNameFromFileName('write_failing.test!.md')).toBe('write-failing-test');
  });

  it('trims leading and trailing hyphens left over after slugging', () => {
    expect(skillNameFromFileName('-- Skill --.md')).toBe('skill');
  });

  it('caps the result at 64 characters, trimming a trailing hyphen the cap exposes', () => {
    const long = `${'a'.repeat(64)}-overflow.md`;
    expect(skillNameFromFileName(long)).toBe('a'.repeat(64));
  });

  it('returns an empty string when nothing usable survives', () => {
    expect(skillNameFromFileName('***.md')).toBe('');
    expect(skillNameFromFileName('.md')).toBe('');
  });
});

describe('formatSkillRef', () => {
  it('formats a library ref as lib:<id>', () => {
    expect(formatSkillRef({ kind: 'library', id: 'abc-123' })).toBe('lib:abc-123');
  });

  it('formats a repo ref as repo:<name>', () => {
    expect(formatSkillRef({ kind: 'repo', name: 'tdd' })).toBe('repo:tdd');
  });
});

describe('parseSkillRef', () => {
  it('round-trips a library ref', () => {
    const ref: SkillRef = { kind: 'library', id: 'abc-123' };
    expect(parseSkillRef(formatSkillRef(ref))).toEqual(ref);
  });

  it('round-trips a repo ref', () => {
    const ref: SkillRef = { kind: 'repo', name: 'write-failing-test-first' };
    expect(parseSkillRef(formatSkillRef(ref))).toEqual(ref);
  });

  it('rejects an unknown prefix', () => {
    expect(parseSkillRef('skill:x')).toBeNull();
    expect(parseSkillRef('user:x')).toBeNull();
    expect(parseSkillRef('library:x')).toBeNull();
  });

  it('rejects a string with no colon', () => {
    expect(parseSkillRef('nocolon')).toBeNull();
  });

  it('rejects an empty library id', () => {
    expect(parseSkillRef('lib:')).toBeNull();
  });

  it('rejects a repo ref with an invalid name', () => {
    expect(parseSkillRef('repo:Bad Name')).toBeNull();
  });

  it('trims only surrounding junk, not internal content', () => {
    expect(parseSkillRef('  lib:abc-123  ')).toEqual({ kind: 'library', id: 'abc-123' });
    expect(parseSkillRef('  repo:tdd  ')).toEqual({ kind: 'repo', name: 'tdd' });
  });
});

describe('parseSkillMarkdown / serializeSkillMarkdown round trip', () => {
  it('round-trips a multi-paragraph body with headings, fenced code and a lone "---" line', () => {
    const body = [
      '# Heading',
      '',
      'A paragraph of prose.',
      '',
      '```ts',
      'const x = 1;',
      '```',
      '',
      '---',
      '',
      'More prose after a horizontal rule.',
    ].join('\n');
    const skill = { name: 'tdd', description: 'Write the test first', body };

    const text = serializeSkillMarkdown(skill);
    const parsed = parseSkillMarkdown(text);

    expect(parsed.name).toBe(skill.name);
    expect(parsed.description).toBe(skill.description);
    expect(parsed.body).toBe(skill.body);
    expect(parsed.warnings).toEqual([]);
  });

  it.each([
    ['a colon', 'Bug: reproduce first'],
    ['a hash and a quote', 'Has # and "quotes"'],
    ['empty', ''],
  ])('round-trips a description that is %s', (_label, description) => {
    const skill = { name: 'tdd', description, body: 'Body text.' };
    const parsed = parseSkillMarkdown(serializeSkillMarkdown(skill));

    expect(parsed.description).toBe(description);
    expect(parsed.name).toBe(skill.name);
    expect(parsed.body).toBe(skill.body);
    expect(parsed.warnings).toEqual([]);
  });

  it('parses CRLF line endings identically to LF', () => {
    const lf =
      '---\nname: tdd\ndescription: Write the test first\n---\n\nBody line one.\nBody line two.\n';
    const crlf = lf.replace(/\n/g, '\r\n');

    const parsedLf = parseSkillMarkdown(lf);
    const parsedCrlf = parseSkillMarkdown(crlf);

    expect(parsedCrlf.name).toBe(parsedLf.name);
    expect(parsedCrlf.description).toBe(parsedLf.description);
    expect(parsedCrlf.body).toBe(parsedLf.body);
  });

  it('never emits a carriage return from the serializer', () => {
    const text = serializeSkillMarkdown({
      name: 'tdd',
      description: 'Write the test first',
      body: 'Line one.\nLine two.',
    });
    expect(text).not.toContain('\r');
  });
});

describe('parseSkillMarkdown: missing frontmatter', () => {
  it('uses the whole text as the body and the fallback name', () => {
    const text = 'Just plain markdown.\n\nNo frontmatter here.';
    const parsed = parseSkillMarkdown(text, 'tdd');

    expect(parsed.name).toBe('tdd');
    expect(parsed.body).toBe(text);
    expect(parsed.warnings).toHaveLength(1);
    expect(parsed.warnings[0]).toMatch(/frontmatter/i);
  });
});

describe('parseSkillMarkdown: malformed frontmatter', () => {
  it('treats an unclosed opening "---" as the whole body, with one warning', () => {
    const text = '---\nname: tdd\ndescription: Write the test first\n\nNo closing delimiter.';
    const parsed = parseSkillMarkdown(text);

    expect(parsed.body).toBe(text);
    expect(parsed.warnings).toHaveLength(1);
    expect(parsed.warnings[0]).toMatch(/never closed/i);
  });

  it('skips a list/nested line inside the frontmatter block with a warning, keeping valid keys', () => {
    const text = [
      '---',
      'name: tdd',
      'tags:',
      '  - one',
      '  - two',
      'description: Write the test first',
      '---',
      '',
      'Body.',
    ].join('\n');
    const parsed = parseSkillMarkdown(text);

    expect(parsed.name).toBe('tdd');
    expect(parsed.description).toBe('Write the test first');
    expect(parsed.warnings).toHaveLength(2);
    for (const warning of parsed.warnings) {
      expect(warning).toMatch(/ignored a frontmatter line/i);
    }
  });
});

describe('parseSkillMarkdown: invalid name in frontmatter', () => {
  it('falls back to a valid fallbackName, with a warning', () => {
    const text = '---\nname: Bad Name\ndescription: d\n---\n\nBody.';
    const parsed = parseSkillMarkdown(text, 'tdd');

    expect(parsed.name).toBe('tdd');
    expect(parsed.warnings).toHaveLength(1);
    expect(parsed.warnings[0]).toMatch(/not a valid skill name/i);
  });

  it('falls back to an empty name when there is no valid fallbackName, with a warning', () => {
    const text = '---\nname: Bad Name\ndescription: d\n---\n\nBody.';
    const parsed = parseSkillMarkdown(text);

    expect(parsed.name).toBe('');
    expect(parsed.warnings).toHaveLength(1);
    expect(parsed.warnings[0]).toMatch(/not a valid skill name/i);
  });
});

describe('parseSkillMarkdown: unknown frontmatter keys', () => {
  it('ignores an unknown key with no warning', () => {
    const text = '---\nname: tdd\ndescription: d\nallowed-tools: Read\n---\n\nBody.';
    const parsed = parseSkillMarkdown(text);

    expect(parsed.name).toBe('tdd');
    expect(parsed.description).toBe('d');
    expect(parsed.warnings).toEqual([]);
  });
});

describe('parseSkillMarkdown: quoted values', () => {
  it('unquotes a double-quoted value', () => {
    const text = '---\nname: tdd\ndescription: "Has: a colon"\n---\n\nBody.';
    const parsed = parseSkillMarkdown(text);
    expect(parsed.description).toBe('Has: a colon');
  });

  it('unquotes a single-quoted value', () => {
    const text = "---\nname: tdd\ndescription: 'single quoted'\n---\n\nBody.";
    const parsed = parseSkillMarkdown(text);
    expect(parsed.description).toBe('single quoted');
  });
});

describe('parseSkillMarkdown: missing description', () => {
  it('yields an empty description with a warning', () => {
    const text = '---\nname: tdd\n---\n\nBody.';
    const parsed = parseSkillMarkdown(text);

    expect(parsed.description).toBe('');
    expect(parsed.warnings).toHaveLength(1);
    expect(parsed.warnings[0]).toMatch(/no description/i);
  });
});
