import { describe, expect, it } from 'vitest';
import { commitType, prSubject, wrapHanging, wrapPlainText } from './commitMessage';

describe('commitType', () => {
  it('reads the human-picked TaskType first', () => {
    expect(commitType({ title: 'anything', taskType: 'bug' })).toBe('fix');
    expect(commitType({ title: 'anything', taskType: 'feature' })).toBe('feat');
  });

  it('falls back to the title verb when nothing else decides it', () => {
    expect(commitType({ title: 'Refactor the merge gate' })).toBe('refactor');
    expect(commitType({ title: 'Document the merge gate' })).toBe('docs');
    expect(commitType({ title: 'Bump a dependency' })).toBe('chore');
  });

  it('maps build/ci/style branch types onto chore, which CONTRIBUTING.md has no row for', () => {
    expect(commitType({ title: 'Package the client for release' })).toBe('chore');
    expect(commitType({ title: 'Format the codebase' })).toBe('chore');
  });

  it('defaults to feat when nothing matches', () => {
    expect(commitType({ title: 'Something nobody can classify' })).toBe('feat');
  });
});

describe('prSubject', () => {
  it('produces type: summary, lower case, no trailing punctuation', () => {
    expect(prSubject({ title: 'Add the merge switch on cards', taskType: 'feature' })).toBe(
      'feat: add the merge switch on cards',
    );
  });

  it('strips a leading ticket key, since it belongs in the Ticket ID trailer instead', () => {
    expect(
      prSubject({ title: 'TM-15: Implement the catch-up age rule', taskType: 'feature' }),
    ).toBe('feat: implement the catch-up age rule');
  });

  it('never exceeds the 50-character subject budget', () => {
    const subject = prSubject({
      title:
        'Implement a genuinely very long title that could never fit any reasonable commit subject line budget',
      taskType: 'feature',
    });
    expect(subject.length).toBeLessThanOrEqual(50);
  });

  it('cuts on a word boundary rather than mid-word', () => {
    const subject = prSubject({
      title: 'Implement a genuinely very long title that will not fit',
      taskType: 'feature',
    });
    expect(subject.endsWith(' ')).toBe(false);
    expect(/\S$/.test(subject)).toBe(true);
  });
});

describe('wrapHanging', () => {
  it('passes short text through on one line', () => {
    expect(wrapHanging('a short line', 72, 2)).toBe('a short line');
  });

  it('wraps long text and indents continuation lines', () => {
    const text =
      'this sentence is deliberately long enough that it must wrap at least once across lines';
    const wrapped = wrapHanging(text, 40, 2);
    const lines = wrapped.split('\n');
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines.slice(1)) {
      expect(line.startsWith('  ')).toBe(true);
    }
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(40);
    }
  });
});

describe('wrapPlainText', () => {
  it('collapses a soft-wrapped paragraph and rewraps it flat', () => {
    const input = 'This is a paragraph\nwritten with soft\nline breaks in the source.';
    const result = wrapPlainText(input, 72);
    expect(result).toBe('This is a paragraph written with soft line breaks in the source.');
  });

  it('keeps blank-line-separated paragraphs apart', () => {
    const input = 'First paragraph.\n\nSecond paragraph.';
    expect(wrapPlainText(input, 72)).toBe('First paragraph.\n\nSecond paragraph.');
  });

  it('keeps a bullet list as one item per line, normalizing the marker to "-"', () => {
    const input = '* first point\n* second point\n* third point';
    expect(wrapPlainText(input, 72)).toBe('- first point\n- second point\n- third point');
  });

  it('merges an unmarked continuation line into the bullet above it', () => {
    const input =
      '- a paused step never restarted\n- the next card in the queue was never\n  reached';
    const result = wrapPlainText(input, 72);
    expect(result).toBe(
      '- a paused step never restarted\n- the next card in the queue was never reached',
    );
  });

  it('strips bold, inline code and markdown links down to plain text', () => {
    const input = 'Calls **decideFire** in `automationFire.ts`, see [the plan](docs/plan.md).';
    expect(wrapPlainText(input, 72)).toBe(
      'Calls decideFire in automationFire.ts, see the plan (docs/plan.md).',
    );
  });

  it('wraps a long paragraph at the given width with no hanging indent', () => {
    const input =
      'This paragraph is deliberately long enough that it needs to wrap across more than one line of output.';
    const result = wrapPlainText(input, 40);
    const lines = result.split('\n');
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(40);
      expect(line.startsWith(' ')).toBe(false);
    }
  });
});
