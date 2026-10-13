import { describe, expect, it } from 'vitest';
import type { PromptTemplate } from '@tm/shared/promptTemplates';
import type { ComposerValue, MentionRange } from './chat/mentions';
import {
  applyTemplateToComposer,
  applyTemplateToText,
  templateVarsForNewTask,
  templateVarsForTask,
} from './templateInsert';

function template(body: string): PromptTemplate {
  return { id: 't', name: 'T', body, surfaces: ['add-task', 'assign', 'chat'] };
}

function mention(overrides: Partial<MentionRange> = {}): MentionRange {
  return { start: 0, end: 0, accountId: 'u1', displayName: 'Ann', ...overrides };
}

describe('templateVarsForNewTask', () => {
  it('carries title and project, with no key', () => {
    expect(templateVarsForNewTask({ title: 'Fix login', projectName: 'Website' })).toEqual({
      title: 'Fix login',
      project: 'Website',
    });
  });
});

describe('templateVarsForTask', () => {
  it('prefers ticketKey over externalKey', () => {
    const vars = templateVarsForTask(
      { title: 'Fix login', ticketKey: 'TM-7', externalKey: 'ABC-123' },
      { name: 'Website' },
    );
    expect(vars).toEqual({ title: 'Fix login', key: 'TM-7', project: 'Website' });
  });

  it('falls back to externalKey when there is no ticketKey', () => {
    const vars = templateVarsForTask(
      { title: 'Fix login', ticketKey: null, externalKey: 'ABC-123' },
      { name: 'Website' },
    );
    expect(vars.key).toBe('ABC-123');
  });

  it('leaves key and project undefined when there is neither a key nor a project', () => {
    const vars = templateVarsForTask(
      { title: 'Fix login', ticketKey: null, externalKey: null },
      null,
    );
    expect(vars).toEqual({ title: 'Fix login', key: undefined, project: undefined });
  });
});

describe('applyTemplateToText (add-task)', () => {
  it('keeps the text before and after the caret, and renders {{key}} empty', () => {
    const result = applyTemplateToText(
      'before  after',
      7,
      template('{{title}} ({{key}})'),
      templateVarsForNewTask({ title: 'Fix login', projectName: 'Website' }),
    );
    expect(result.text).toBe('before Fix login () after');
    expect(result.caret).toBe('before Fix login ()'.length);
  });

  it('replaces a selection', () => {
    const result = applyTemplateToText('hello world', { start: 6, end: 11 }, template('there'), {});
    expect(result).toEqual({ text: 'hello there', caret: 11 });
  });
});

describe('applyTemplateToText (assign)', () => {
  it('renders the ticket vars at the caret', () => {
    const vars = templateVarsForTask(
      { title: 'Fix login', ticketKey: 'TM-7', externalKey: null },
      { name: 'Website' },
    );
    const result = applyTemplateToText('', 0, template('{{title}} ({{key}}) — {{project}}'), vars);
    expect(result).toEqual({ text: 'Fix login (TM-7) — Website', caret: 26 });
  });
});

describe('applyTemplateToComposer (chat)', () => {
  function composer(text: string, mentions: MentionRange[] = []): ComposerValue {
    return { text, mentions, attachments: ['/tmp/screenshot.png'] };
  }

  it('inserts at the caret, keeping text before and after verbatim', () => {
    const before = mention({ start: 0, end: 4 }); // "@Ann"
    const value = composer('@Ann is here', [before]);

    const result = applyTemplateToComposer(value, 8, template('now '), {});

    expect(result.value.text).toBe('@Ann is now here');
    expect(result.caret).toBe(12);
    expect(result.value.mentions).toEqual([before]);
  });

  it('shifts a mention after the caret by the inserted length', () => {
    const after = mention({ start: 5, end: 9 }); // "@Ann" in "look @Ann"
    const value = composer('look @Ann', [after]);

    const result = applyTemplateToComposer(value, 0, template('hey '), {});

    expect(result.value.text).toBe('hey look @Ann');
    expect(result.value.mentions).toEqual([{ ...after, start: 9, end: 13 }]);
  });

  it('leaves a mention entirely before the edit untouched', () => {
    const before = mention({ start: 0, end: 4 }); // "@Ann"
    const value = composer('@Ann said hi', [before]);

    const result = applyTemplateToComposer(value, 12, template(' there'), {});

    expect(result.value.mentions).toEqual([before]);
    expect(result.value.text).toBe('@Ann said hi there');
  });

  it('drops a mention inside a replaced selection', () => {
    const inside = mention({ start: 5, end: 9 }); // "@Ann" in "ping @Ann now"
    const value = composer('ping @Ann now', [inside]);

    const result = applyTemplateToComposer(value, { start: 5, end: 9 }, template('@Bob'), {});

    expect(result.value.mentions).toEqual([]);
    expect(result.value.text).toBe('ping @Bob now');
  });

  it('renders vars and leaves attachments untouched', () => {
    const value = composer('', []);

    const result = applyTemplateToComposer(
      value,
      0,
      template('{{title}} ({{key}})'),
      templateVarsForTask({ title: 'Fix login', ticketKey: 'TM-7', externalKey: null }, null),
    );

    expect(result.value.text).toBe('Fix login (TM-7)');
    expect(result.value.attachments).toEqual(['/tmp/screenshot.png']);
  });
});
