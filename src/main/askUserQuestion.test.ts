import { describe, expect, it } from 'vitest';
import {
  describeQuestions,
  formatAnswerMessage,
  isAskUserQuestionTool,
  parseAskUserQuestion,
} from './askUserQuestion';

describe('isAskUserQuestionTool', () => {
  it('matches the bare tool, however it is cased or padded', () => {
    expect(isAskUserQuestionTool('AskUserQuestion')).toBe(true);
    expect(isAskUserQuestionTool('askuserquestion')).toBe(true);
    expect(isAskUserQuestionTool('  AskUserQuestion  ')).toBe(true);
  });

  it('matches the MCP-namespaced form', () => {
    // Re-exported through a server it is the same tool with the same consequence;
    // matching only the bare name would let that variant slip the gate.
    expect(isAskUserQuestionTool('mcp__some-server__AskUserQuestion')).toBe(true);
  });

  it.each(['Bash', 'ExitPlanMode', 'AskUserQuestions', 'Ask', ''])(
    'does not match %s',
    (name) => {
      expect(isAskUserQuestionTool(name)).toBe(false);
    },
  );
});

describe('parseAskUserQuestion', () => {
  it('reads the real shape, options and all', () => {
    expect(
      parseAskUserQuestion({
        questions: [
          {
            header: 'Auth method',
            question: 'Which auth should the service use?',
            multiSelect: false,
            options: [
              { label: 'OAuth', description: 'Delegates to the IdP; needs a redirect URI.' },
              { label: 'JWT', description: 'Self-issued; simpler, no IdP round trip.' },
            ],
          },
        ],
      }),
    ).toEqual([
      {
        header: 'Auth method',
        question: 'Which auth should the service use?',
        multiSelect: false,
        options: [
          { label: 'OAuth', description: 'Delegates to the IdP; needs a redirect URI.' },
          { label: 'JWT', description: 'Self-issued; simpler, no IdP round trip.' },
        ],
      },
    ]);
  });

  it('keeps a question that offers no options — it is still a question', () => {
    const [q] = parseAskUserQuestion({ questions: [{ question: 'What should I name it?' }] });
    expect(q).toEqual({ header: '', question: 'What should I name it?', multiSelect: false, options: [] });
  });

  it('carries multiSelect through', () => {
    const [q] = parseAskUserQuestion({
      questions: [{ question: 'Which features?', multiSelect: true, options: ['auth', 'audit'] }],
    });
    expect(q.multiSelect).toBe(true);
    expect(q.options).toEqual([{ label: 'auth' }, { label: 'audit' }]);
  });

  it('falls back to the header when the question text is missing', () => {
    const [q] = parseAskUserQuestion({ questions: [{ header: 'Database' }] });
    expect(q.question).toBe('Database');
  });

  it('drops an option with no label rather than rendering a blank row', () => {
    const [q] = parseAskUserQuestion({
      questions: [{ question: 'Pick', options: [{ description: 'orphan' }, { label: 'ok' }] }],
    });
    expect(q.options).toEqual([{ label: 'ok' }]);
  });

  it.each([null, undefined, 42, 'nope', {}, { questions: 'nope' }, { questions: [] }])(
    'returns [] for %p rather than throwing',
    (input) => {
      // The caller then raises a free-text item, which still BLOCKS and is still
      // answerable. Degrading to a plainer form is fine; degrading to silence is not.
      expect(parseAskUserQuestion(input)).toEqual([]);
    },
  );

  it('skips entries it cannot read without losing the ones it can', () => {
    expect(
      parseAskUserQuestion({ questions: [null, { question: 'kept' }, 'garbage', {}] }),
    ).toHaveLength(1);
  });
});

describe('describeQuestions', () => {
  it('uses the question itself when there is one', () => {
    expect(describeQuestions(parseAskUserQuestion({ questions: [{ question: 'Which DB?' }] }))).toBe(
      'Which DB?',
    );
  });

  it('counts the rest when there are several', () => {
    const qs = parseAskUserQuestion({
      questions: [{ question: 'Which DB?' }, { question: 'Which ORM?' }, { question: 'Where?' }],
    });
    expect(describeQuestions(qs)).toBe('Which DB? (and 2 more)');
  });

  it('still says something when nothing parsed', () => {
    expect(describeQuestions([])).toBe('The agent has a question for you.');
  });
});

describe('formatAnswerMessage', () => {
  const questions = parseAskUserQuestion({
    questions: [
      { question: 'Which database?', options: ['SQLite', 'Postgres'] },
      { question: 'Which features?', multiSelect: true, options: ['auth', 'audit-log'] },
    ],
  });

  it('reads as an ANSWER, not a refusal', () => {
    // It arrives as a DENIED tool call, i.e. an error — and an agent that reads an error
    // retries. This wording is what turns a refusal into something it acts on.
    const message = formatAnswerMessage(questions, [['SQLite'], ['auth', 'audit-log']]);
    expect(message).toContain('The user answered your question');
    expect(message).toContain('do NOT ask the same question again');
    expect(message).not.toMatch(/denied|refused|not allowed/i);
  });

  it('pairs each question with what was chosen', () => {
    const message = formatAnswerMessage(questions, [['SQLite'], ['auth', 'audit-log']]);
    expect(message).toContain('1. Which database?');
    expect(message).toContain('→ SQLite');
    expect(message).toContain('2. Which features?');
    expect(message).toContain('→ auth, audit-log');
  });

  it('appends typed text to a picked option rather than replacing it', () => {
    // "Postgres, and the staging box is on 14" is ONE answer; dropping either half
    // loses the point of having typed it.
    const message = formatAnswerMessage(
      questions,
      [['Postgres'], []],
      ['the staging box is still on 14', null],
    );
    expect(message).toContain('→ Postgres, the staging box is still on 14');
  });

  it('says so plainly when a question went unanswered', () => {
    const message = formatAnswerMessage(questions, [['SQLite'], []]);
    expect(message).toContain('→ (no preference given)');
  });

  it('carries a free-standing note at the end', () => {
    const message = formatAnswerMessage(questions, [['SQLite'], ['auth']], undefined, 'keep it read-only');
    expect(message).toContain('Additional instruction from the user: keep it read-only');
  });

  it('tolerates more answers than questions without dropping any', () => {
    const message = formatAnswerMessage([], [['yes']]);
    expect(message).toContain('1. Question 1');
    expect(message).toContain('→ yes');
  });
});
