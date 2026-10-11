import { describe, expect, it } from 'vitest';
import {
  aggregateTested,
  branchChangesBody,
  commitType,
  parseCommitMessage,
  prSubject,
  wrapHanging,
  wrapPlainText,
} from './commitMessage';

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

describe('parseCommitMessage', () => {
  it('splits a worked-example commit into subject, body and trailers', () => {
    const raw =
      'feat(merge): put the auto-merge switch on cards\n\n' +
      'Three switches, in the three places the question actually gets\n' +
      'asked.\n\n' +
      'Ticket ID: TM-412\n' +
      'Tested: pnpm typecheck, pnpm test (168 green), then pnpm dev and\n' +
      '        toggled the switch at all three levels.';
    const parsed = parseCommitMessage(raw);
    expect(parsed.subject).toBe('feat(merge): put the auto-merge switch on cards');
    expect(parsed.body).toBe(
      'Three switches, in the three places the question actually gets\nasked.',
    );
    expect(parsed.trailers).toEqual({
      'Ticket ID': 'TM-412',
      Tested:
        'pnpm typecheck, pnpm test (168 green), then pnpm dev and toggled the switch at all three levels.',
    });
  });

  it('is total: a bare subject with no body or trailers still parses', () => {
    expect(parseCommitMessage('chore: bump a dependency')).toEqual({
      subject: 'chore: bump a dependency',
      body: '',
      trailers: {},
    });
    expect(parseCommitMessage('')).toEqual({ subject: '', body: '', trailers: {} });
  });

  it('leaves a trailing paragraph as body when not every line fits the trailer shape', () => {
    const raw =
      'fix: a bug\n\nNote: here is one line.\nAnd a second plain line with no colon at all.';
    const parsed = parseCommitMessage(raw);
    expect(parsed.body).toBe(
      'Note: here is one line.\nAnd a second plain line with no colon at all.',
    );
    expect(parsed.trailers).toEqual({});
  });

  it('has no trailers when the body ends in prose with no colon at all', () => {
    const raw = 'fix: a bug\n\nJust an ordinary paragraph of explanation.';
    expect(parseCommitMessage(raw).trailers).toEqual({});
  });
});

describe('branchChangesBody', () => {
  it("uses the single commit's own body verbatim (reflowed) when there is only one", () => {
    const raw =
      'fix(limit): resume steps when the limit resets\n\nThe gate forgot the chain.\n\nTested: pnpm test';
    expect(branchChangesBody([raw])).toBe('The gate forgot the chain.');
  });

  it('falls back to the subject when a single commit has no body', () => {
    expect(branchChangesBody(['chore: bump a dependency'])).toBe('chore: bump a dependency');
  });

  it('lists every commit by subject, bulleted, when there is more than one', () => {
    const commits = [
      'fix(a): first fix\n\nTested: pnpm test',
      'fix(b): second fix\n\nTested: pnpm test',
    ];
    expect(branchChangesBody(commits)).toBe('- fix(a): first fix\n- fix(b): second fix');
  });

  it('is empty on an empty branch, so the caller can fall back to the card description', () => {
    expect(branchChangesBody([])).toBe('');
  });

  it("strips a Generated-with / robot-marker line out of a single commit's body", () => {
    const raw =
      'feat: add the thing\n\n' +
      'The real explanation.\n' +
      '🤖 Generated with Some Tool\n\n' +
      'Tested: pnpm test';
    expect(branchChangesBody([raw])).toBe('The real explanation.');
  });

  it('caps the bullet list and names how many more commits there were', () => {
    const commits = Array.from({ length: 25 }, (_, i) => `fix: change number ${i + 1}`);
    const body = branchChangesBody(commits);
    const lines = body.split('\n');
    expect(lines).toHaveLength(21);
    expect(lines[20]).toBe('- …and 5 more commits.');
  });
});

describe('aggregateTested', () => {
  it('is empty when no commit on the branch carries a Tested trailer', () => {
    expect(aggregateTested(['feat: add the thing', 'fix: a bug'])).toBe('');
  });

  it('collapses identical Tested values from several commits into one', () => {
    const commits = ['fix(a): first\n\nTested: pnpm test', 'fix(b): second\n\nTested: pnpm test'];
    expect(aggregateTested(commits)).toBe('pnpm test');
  });

  it('joins distinct Tested values from several commits', () => {
    const commits = ['fix(a): first\n\nTested: pnpm test', 'fix(b): second\n\nTested: pnpm build'];
    expect(aggregateTested(commits)).toBe('pnpm test; pnpm build');
  });

  it('caps the number of distinct Tested values and names how many more there were', () => {
    const commits = Array.from(
      { length: 10 },
      (_, i) => `fix: change ${i}\n\nTested: ran scenario ${i}`,
    );
    const result = aggregateTested(commits);
    expect(result).toContain('and 2 more commits tested');
    expect(result.split('; ')).toHaveLength(9); // 8 shown + the "and N more" tail
  });
});
