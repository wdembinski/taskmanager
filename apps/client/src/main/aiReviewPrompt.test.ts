import { describe, expect, it } from 'vitest';
import { AI_REVIEW_RUBRIC, parseAiReviewVerdict } from '@shared/aiVisualReview';
import { AI_REVIEW_VERDICT_EXAMPLE, buildAiReviewPrompt } from './aiReviewPrompt';

const input = {
  ticketTitle: 'Add the merge switch',
  ticketText: 'Show a switch on the board.',
  stepTitles: ['Add the setting', 'Show the switch'],
  screens: [
    {
      name: 'board-light',
      realPath: 'C:/att/board-light.png',
      mockupPath: 'C:/att/board-light-mockup.png',
      builderStatus: 'mismatch' as const,
      builderNote: 'shell differs',
    },
    {
      name: 'board-dark',
      realPath: 'C:/att/board-dark.png',
      builderStatus: 'unknown' as const,
      builderNote: '',
    },
  ],
  round: 2,
  maxRounds: 2,
};

describe('buildAiReviewPrompt', () => {
  const prompt = buildAiReviewPrompt(input);

  it('carries the ticket, the steps and the builder verdicts', () => {
    expect(prompt).toContain('Add the merge switch');
    expect(prompt).toContain('Show a switch on the board.');
    expect(prompt).toContain('1. Add the setting\n2. Show the switch');
    expect(prompt).toContain('board-light (the builder said mismatch — shell differs)');
    expect(prompt).toContain('board-dark (the builder gave no verdict)');
    expect(prompt).toContain('review 2 of 3');
  });

  it('names every real and mockup PNG as an absolute path to open with Read', () => {
    expect(prompt).toContain('C:/att/board-light.png');
    expect(prompt).toContain('C:/att/board-light-mockup.png');
    expect(prompt).toContain('C:/att/board-dark.png');
    expect(prompt).toContain('open each with Read');
  });

  it('quotes the rubric, says it is read-only, and pins the json block', () => {
    expect(prompt).toContain(AI_REVIEW_RUBRIC);
    expect(prompt).toContain('You are read-only');
    expect(prompt).toContain('do not edit');
    expect(prompt).toContain(AI_REVIEW_VERDICT_EXAMPLE);
  });

  it('shows a verdict block the parser itself reads back', () => {
    expect(parseAiReviewVerdict(AI_REVIEW_VERDICT_EXAMPLE)).not.toBeNull();
  });
});
