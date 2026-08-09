import { describe, expect, it } from 'vitest';
import { parseClaudeUsageText } from './claudeUsage';

describe('parseClaudeUsageText', () => {
  it('reads both percentages out of a real /usage reply', () => {
    const text =
      'You are currently using your subscription to power your Claude Code usage\n\n' +
      'Current session: 19% used · resets Aug 7, 2:39pm (Europe/Warsaw)\n' +
      'Current week (all models): 3% used · resets Aug 13, 7:59pm (Europe/Warsaw)\n' +
      'Current week (Fable): 0% used\n\n' +
      "What's contributing to your limits usage?";
    expect(parseClaudeUsageText(text)).toEqual({ sessionPct: 19, weeklyPct: 3 });
  });

  it('is null for a percentage the text does not contain', () => {
    expect(parseClaudeUsageText('Current session: 5% used')).toEqual({
      sessionPct: 5,
      weeklyPct: null,
    });
  });

  it('is null for both when the text is not a /usage reply at all', () => {
    expect(parseClaudeUsageText('It looks like you typed `/usage`...')).toEqual({
      sessionPct: null,
      weeklyPct: null,
    });
  });

  it('does not confuse the per-skill/subagent breakdown lines for the headline percentages', () => {
    const text =
      'Current session: 19% used · resets Aug 7, 2:39pm (Europe/Warsaw)\n' +
      'Current week (all models): 3% used · resets Aug 13, 7:59pm (Europe/Warsaw)\n\n' +
      'Last 24h · 280 requests · 8 sessions\n' +
      '  19% of your usage was at >150k context\n' +
      '  Top MCP servers: orchestrator-permissions 52%';
    expect(parseClaudeUsageText(text)).toEqual({ sessionPct: 19, weeklyPct: 3 });
  });
});
