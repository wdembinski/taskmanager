import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { TaskActivityEntry } from './model';
import { autoMergeAwaitAiReviewNote, autoMergeDecision } from './autoMerge';
import { formatSignOff, latestVisualState } from './visualSignOff';
import {
  AI_REVIEW_RUBRIC,
  aiReviewGaveUpNote,
  aiReviewInboxQuestion,
  aiReviewInvalidNote,
  aiReviewNeedsChangesNote,
  aiReviewNext,
  aiReviewOutcome,
  aiReviewRoundLine,
  aiReviewRoundsSoFar,
  aiReviewStartedNote,
  aiReviewSuperseded,
  clampAiReviewMaxRounds,
  DEFAULT_AI_REVIEW_MAX_ROUNDS,
  parseAiReviewVerdict,
  type AiReviewVerdict,
} from './aiVisualReview';

function comment(body: string, createdAt: number): TaskActivityEntry {
  return { kind: 'comment', id: createdAt, body, createdAt };
}

const approve: AiReviewVerdict = {
  verdict: 'approve',
  screens: [{ screen: 'board-light', status: 'ok', reason: '' }],
  outOfScope: [],
};

const needsChanges: AiReviewVerdict = {
  verdict: 'needs-changes',
  screens: [
    { screen: 'board-light', status: 'ok', reason: '' },
    { screen: 'board-dark', status: 'mismatch', reason: 'the badge is unreadable' },
  ],
  outOfScope: ['the sidebar is the older layout'],
};

describe('aiReviewNext', () => {
  it('waits for a human when the setting is off', () => {
    expect(aiReviewNext({ enabled: false, maxRounds: 2, activity: [] })).toBe('await-human');
  });

  it('reviews when the setting is on and the card has no AI notes yet', () => {
    expect(aiReviewNext({ enabled: true, maxRounds: 2, activity: [] })).toBe('review');
  });

  it('keeps reviewing until the fix rounds are used up — the last review is still owed', () => {
    const activity = [
      comment(aiReviewNeedsChangesNote(1, 2, needsChanges), 1),
      comment(aiReviewNeedsChangesNote(2, 2, needsChanges), 2),
    ];
    expect(aiReviewRoundsSoFar(activity)).toBe(2);
    expect(aiReviewNext({ enabled: true, maxRounds: 2, activity })).toBe('review');
  });

  it('is exhausted once more fix rounds ran than the setting now allows', () => {
    const activity = [
      comment(aiReviewNeedsChangesNote(1, 2, needsChanges), 1),
      comment(aiReviewNeedsChangesNote(2, 2, needsChanges), 2),
    ];
    expect(aiReviewNext({ enabled: true, maxRounds: 1, activity })).toBe('exhausted');
  });

  it('waits for a human after the gave-up note, so the Inbox is raised once', () => {
    const activity = [
      comment(aiReviewNeedsChangesNote(1, 1, needsChanges), 1),
      comment(aiReviewGaveUpNote(2, needsChanges), 2),
    ];
    expect(aiReviewNext({ enabled: true, maxRounds: 1, activity })).toBe('await-human');
  });

  it('counts only the AI notes newer than the latest sign-off comment', () => {
    const activity = [
      comment(aiReviewNeedsChangesNote(1, 1, needsChanges), 1),
      comment(aiReviewGaveUpNote(2, needsChanges), 2),
      // A human approved, then needs-changes'd and approved again — a fresh count.
      comment(formatSignOff('approved'), 3),
      comment(aiReviewNeedsChangesNote(1, 1, needsChanges), 4),
    ];
    expect(aiReviewRoundsSoFar(activity)).toBe(1);
    expect(aiReviewNext({ enabled: true, maxRounds: 1, activity })).toBe('review');
  });

  it('does not count an invalid verdict as a round', () => {
    const activity = [comment(aiReviewInvalidNote(), 1)];
    expect(aiReviewRoundsSoFar(activity)).toBe(0);
    expect(aiReviewNext({ enabled: true, maxRounds: 0, activity })).toBe('review');
  });

  it('ignores non-comment entries and unrelated comments', () => {
    const activity: TaskActivityEntry[] = [
      comment('Pushed the branch.', 1),
      { kind: 'chat', id: 2, body: aiReviewGaveUpNote(1, needsChanges), createdAt: 2 },
    ];
    expect(aiReviewNext({ enabled: true, maxRounds: 0, activity })).toBe('review');
  });
});

describe('aiReviewOutcome', () => {
  it('approves a clean approve verdict', () => {
    expect(aiReviewOutcome(approve, 0, 2)).toBe('approve');
  });

  it('treats an approve with a mismatched screen as needs-changes', () => {
    const sneaky: AiReviewVerdict = { ...needsChanges, verdict: 'approve' };
    expect(aiReviewOutcome(sneaky, 0, 2)).toBe('fix-step');
  });

  it('adds a fix step while rounds are left', () => {
    expect(aiReviewOutcome(needsChanges, 0, 2)).toBe('fix-step');
    expect(aiReviewOutcome(needsChanges, 1, 2)).toBe('fix-step');
  });

  it('is exhausted once the fix rounds are used up, and at once with max 0', () => {
    expect(aiReviewOutcome(needsChanges, 2, 2)).toBe('exhausted');
    expect(aiReviewOutcome(needsChanges, 0, 0)).toBe('exhausted');
  });

  it('is invalid for an unparseable verdict', () => {
    expect(aiReviewOutcome(null, 0, 2)).toBe('invalid');
    expect(aiReviewOutcome(parseAiReviewVerdict('I think it looks fine.'), 0, 2)).toBe('invalid');
  });
});

describe('aiReviewSuperseded', () => {
  it('is true when a sign-off comment landed after the review started', () => {
    const activity = [
      comment(aiReviewStartedNote(1, 2), 10),
      comment(formatSignOff('approved'), 20),
    ];
    expect(aiReviewSuperseded(activity, 10)).toBe(true);
  });

  it('is false when the only sign-off predates the review, or there is none', () => {
    expect(aiReviewSuperseded([comment(formatSignOff('approved'), 5)], 10)).toBe(false);
    expect(aiReviewSuperseded([comment(aiReviewStartedNote(1, 2), 10)], 10)).toBe(false);
  });
});

describe('parseAiReviewVerdict', () => {
  it('reads the LAST fenced json block', () => {
    const text = [
      'First draft:',
      '```json',
      '{"verdict":"needs-changes","screens":[],"outOfScope":[]}',
      '```',
      'On reflection:',
      '```json',
      JSON.stringify(approve),
      '```',
    ].join('\n');
    expect(parseAiReviewVerdict(text)).toEqual(approve);
  });

  it('fills a missing reason and outOfScope with empties', () => {
    const text = '```json\n{"verdict":"approve","screens":[{"screen":"a","status":"ok"}]}\n```';
    expect(parseAiReviewVerdict(text)).toEqual({
      verdict: 'approve',
      screens: [{ screen: 'a', status: 'ok', reason: '' }],
      outOfScope: [],
    });
  });

  it('is null for no block, bad JSON, or the wrong shape', () => {
    expect(parseAiReviewVerdict('')).toBeNull();
    expect(parseAiReviewVerdict('```json\n{not json}\n```')).toBeNull();
    expect(parseAiReviewVerdict('```json\n{"verdict":"maybe","screens":[]}\n```')).toBeNull();
    expect(parseAiReviewVerdict('```json\n{"verdict":"approve"}\n```')).toBeNull();
    expect(
      parseAiReviewVerdict(
        '```json\n{"verdict":"approve","screens":[{"screen":"a","status":"fine"}]}\n```',
      ),
    ).toBeNull();
  });
});

describe('the notes', () => {
  it('formats the started note as round n of max+1', () => {
    expect(aiReviewStartedNote(1, 2)).toBe('AI visual review started (round 1 of 3).');
  });

  it('formats the needs-changes note with one line per mismatched screen', () => {
    expect(aiReviewNeedsChangesNote(1, 2, needsChanges)).toBe(
      [
        'AI visual review: needs changes (round 1 of 2)',
        '',
        '- board-dark: the badge is unreadable',
        '',
        'Out of scope (not a mismatch):',
        '- the sidebar is the older layout',
      ].join('\n'),
    );
  });

  it('formats the gave-up note and the Inbox question', () => {
    expect(aiReviewGaveUpNote(3, needsChanges).split('\n')[0]).toBe(
      'AI visual review: stopped after 3 rounds — a human has to look.',
    );
    expect(aiReviewGaveUpNote(1, needsChanges).split('\n')[0]).toBe(
      'AI visual review: stopped after 1 round — a human has to look.',
    );
    expect(aiReviewInboxQuestion(3)).toBe(
      'AI visual review could not approve after 3 rounds — check the shots and press Approve or Needs changes.',
    );
  });

  it('never formats a note the human sign-off parser would read', () => {
    for (const body of [
      aiReviewStartedNote(1, 2),
      aiReviewNeedsChangesNote(1, 2, needsChanges),
      aiReviewGaveUpNote(3, needsChanges),
      aiReviewInvalidNote(),
    ]) {
      expect(latestVisualState([comment(body, 1)], []).human).toBe('pending');
    }
  });

  it('has the four rubric bullets', () => {
    expect(AI_REVIEW_RUBRIC.split('\n').filter((l) => l.startsWith('- '))).toHaveLength(4);
    expect(AI_REVIEW_RUBRIC).toContain(
      'judge ONLY what this ticket adds or changes; the mockup is the intent for that part, not a pixel spec;',
    );
  });
});

describe('the AI approval arms auto-merge through the human gate', () => {
  it('reads an AI approve comment as approved, which enables', () => {
    const state = latestVisualState([comment(formatSignOff('approved', [], 'ai'), 1)], []);
    expect(autoMergeDecision({ enabled: true, isUiCard: true, human: state.human })).toBe('enable');
  });

  it('lets a human approval after an AI needs-changes note win', () => {
    const activity = [
      comment(aiReviewNeedsChangesNote(1, 2, needsChanges), 1),
      comment(formatSignOff('approved'), 2),
    ];
    const state = latestVisualState(activity, []);
    expect(state.human).toBe('approved');
    expect(state.signedOffBy).toBe('human');
    expect(autoMergeDecision({ enabled: true, isUiCard: true, human: state.human })).toBe('enable');
  });

  it('keeps the gate pending after an AI needs-changes note, so the next push reviews again', () => {
    const state = latestVisualState([comment(aiReviewNeedsChangesNote(1, 2, needsChanges), 1)], []);
    expect(autoMergeDecision({ enabled: true, isUiCard: true, human: state.human })).toBe(
      'await-sign-off',
    );
  });

  it('names the reviewer in the await note, under the same prefix', () => {
    expect(autoMergeAwaitAiReviewNote('#12')).toBe(
      'Auto-merge is waiting for visual sign-off on #12 — the AI reviewer is checking the shots.',
    );
  });
});

describe('clampAiReviewMaxRounds', () => {
  it('keeps 0..10, rounds a fraction, clamps the rest and defaults a non-number to 2', () => {
    expect(clampAiReviewMaxRounds(0)).toBe(0);
    expect(clampAiReviewMaxRounds(10)).toBe(10);
    expect(clampAiReviewMaxRounds(2.6)).toBe(3);
    expect(clampAiReviewMaxRounds(-4)).toBe(0);
    expect(clampAiReviewMaxRounds(99)).toBe(10);
    expect(clampAiReviewMaxRounds(undefined)).toBe(DEFAULT_AI_REVIEW_MAX_ROUNDS);
    expect(clampAiReviewMaxRounds(Number.NaN)).toBe(2);
  });
});

describe('aiReviewRoundLine', () => {
  it('is null with no AI note', () => {
    expect(aiReviewRoundLine([])).toBeNull();
    expect(aiReviewRoundLine([comment(formatSignOff('approved', [], 'ai'), 1)])).toBeNull();
  });

  it('reads the latest needs-changes note as round n of max', () => {
    const activity = [
      comment(aiReviewNeedsChangesNote(1, 2, needsChanges), 1),
      comment(aiReviewNeedsChangesNote(2, 2, needsChanges), 2),
    ];
    expect(aiReviewRoundLine(activity)).toBe('AI review: round 2 of 2');
  });

  it('keeps the round line under an AI approval that followed it', () => {
    const activity = [
      comment(aiReviewNeedsChangesNote(1, 2, needsChanges), 1),
      comment(formatSignOff('approved', [], 'ai'), 2),
    ];
    expect(aiReviewRoundLine(activity)).toBe('AI review: round 1 of 2');
  });

  it('reads the gave-up note', () => {
    const activity = [
      comment(aiReviewNeedsChangesNote(2, 2, needsChanges), 1),
      comment(aiReviewGaveUpNote(3, needsChanges), 2),
    ];
    expect(aiReviewRoundLine(activity)).toBe('AI review: stopped after 3 rounds');
  });

  it("is null once a human's own sign-off is newer", () => {
    const activity = [
      comment(aiReviewGaveUpNote(3, needsChanges), 1),
      comment(formatSignOff('approved'), 2),
    ];
    expect(aiReviewRoundLine(activity)).toBeNull();
  });
});

describe("CONTRIBUTING.md's copy of the rubric", () => {
  const contributing = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'CONTRIBUTING.md'),
    'utf8',
  ).replace(/\r\n/g, '\n');
  const heading = "### Verification — the AI reviewer's rubric";
  const start = contributing.indexOf(heading);
  // The subsection runs to the next `## ` heading, or to the end of the file.
  const next = contributing.indexOf('\n## ', start + 1);
  const section = contributing.slice(start, next === -1 ? undefined : next);
  const bullets = section.split('\n').filter((l) => l.startsWith('- '));
  const rubric = AI_REVIEW_RUBRIC.split('\n');

  it('has the subsection under §6', () => {
    expect(start).toBeGreaterThan(contributing.indexOf('## 6. UI changes'));
  });

  it('carries every rubric bullet word for word, and no other', () => {
    expect(bullets).toEqual(rubric);
    for (const bullet of bullets) expect(rubric).toContain(bullet);
  });

  it('documents the verdict json and that a human always wins', () => {
    expect(section).toContain('```json');
    expect(section).toContain('"outOfScope"');
    expect(section).toContain("A human's Approve or Needs changes always wins");
  });
});
