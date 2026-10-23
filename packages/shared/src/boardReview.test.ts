import { describe, expect, it } from 'vitest';
import {
  BOARD_REVIEW_RUBRIC,
  BOARD_REVIEW_VERDICTS,
  boardReviewRecommendations,
  parseBoardReviewReport,
} from './boardReview';

const refs = { 'TM-9': 't9', 'TM-12': 't12', 'TM-14': 't14', '#3': 't3' };

function fence(report: unknown): string {
  return `Here is my review.\n\n\`\`\`json\n${JSON.stringify(report, null, 2)}\n\`\`\`\n`;
}

const valid = {
  summary: 'Two overlaps, one stale ticket.',
  tickets: [
    { ref: 'TM-9', verdict: 'OK', reason: 'clear', evidence: [] },
    {
      ref: 'TM-12',
      verdict: 'SPLIT',
      reason: 'two features',
      evidence: ['src/a.ts:40 — both live here'],
      parts: [
        { title: 'Part one', description: 'first' },
        { title: 'Part two', description: 'second' },
      ],
    },
    { ref: 'TM-14', verdict: 'REORDER', reason: 'same file', after: ['TM-9'] },
    { ref: '#3', verdict: 'DECIDE', reason: 'unclear', question: 'Keep the old API?' },
  ],
  hotFiles: [{ path: 'src/a.ts', refs: ['TM-12', 'TM-14'], note: 'both edit it' }],
  waves: [{ refs: ['TM-9', 'TM-12'], note: 'first' }, { refs: ['TM-14'] }],
};

function parse(report: unknown, cap = 3) {
  const result = parseBoardReviewReport(fence(report), refs, cap);
  if (!result.ok) throw new Error(result.error);
  return result.report;
}

describe('BOARD_REVIEW_RUBRIC', () => {
  it('has one line per verdict', () => {
    const lines = BOARD_REVIEW_RUBRIC.split('\n');
    expect(lines).toHaveLength(BOARD_REVIEW_VERDICTS.length);
    BOARD_REVIEW_VERDICTS.forEach((v, i) => expect(lines[i]).toMatch(new RegExp(`^- ${v} — `)));
  });
});

describe('parseBoardReviewReport', () => {
  it('reads a valid report and maps refs to task ids', () => {
    const report = parse(valid);
    expect(report.summary).toBe('Two overlaps, one stale ticket.');
    expect(report.warnings).toEqual([]);
    expect(report.tickets.map((t) => [t.ref, t.taskId, t.verdict])).toEqual([
      ['TM-9', 't9', 'OK'],
      ['TM-12', 't12', 'SPLIT'],
      ['TM-14', 't14', 'REORDER'],
      ['#3', 't3', 'DECIDE'],
    ]);
    expect(report.tickets[1].parts).toHaveLength(2);
    expect(report.tickets[1].evidence).toEqual(['src/a.ts:40 — both live here']);
    expect(report.tickets[2].after).toEqual(['TM-9']);
    expect(report.tickets[3].question).toBe('Keep the old API?');
    expect(report.hotFiles).toEqual([
      { path: 'src/a.ts', refs: ['TM-12', 'TM-14'], note: 'both edit it' },
    ]);
    expect(report.waves).toEqual([
      { refs: ['TM-9', 'TM-12'], note: 'first' },
      { refs: ['TM-14'], note: '' },
    ]);
  });

  it('reads the last fenced json block', () => {
    const draft = fence({ summary: 'draft', tickets: [] });
    const final = fence({ summary: 'final', tickets: [{ ref: 'TM-9', verdict: 'DROP' }] });
    const result = parseBoardReviewReport(draft + '\nCorrection:\n' + final, refs, 3);
    expect(result.ok && result.report.summary).toBe('final');
    expect(result.ok && result.report.tickets[0].verdict).toBe('DROP');
  });

  it('fails with no fence', () => {
    const result = parseBoardReviewReport('All good, nothing to change.', refs, 3);
    expect(result.ok).toBe(false);
  });

  it('fails on bad JSON', () => {
    const result = parseBoardReviewReport('```json\n{"summary": \n```', refs, 3);
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('not valid JSON') });
  });

  it('fails on a shape error', () => {
    expect(parseBoardReviewReport(fence({ tickets: {} }), refs, 3).ok).toBe(false);
    expect(parseBoardReviewReport(fence([]), refs, 3).ok).toBe(false);
    expect(
      parseBoardReviewReport(
        fence({ tickets: [{ ref: 'TM-9', verdict: 'OK', evidence: 'x' }] }),
        refs,
        3,
      ).ok,
    ).toBe(false);
  });

  it('fails on an unknown verdict', () => {
    const result = parseBoardReviewReport(
      fence({ tickets: [{ ref: 'TM-9', verdict: 'POSTPONE' }] }),
      refs,
      3,
    );
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('POSTPONE') });
  });

  it('downgrades a SPLIT with fewer than 2 parts to OK, with a warning', () => {
    const report = parse({
      tickets: [{ ref: 'TM-12', verdict: 'SPLIT', parts: [{ title: 'only one' }] }],
    });
    expect(report.tickets[0].verdict).toBe('OK');
    expect(report.tickets[0].parts).toBeUndefined();
    expect(report.warnings).toEqual([expect.stringContaining('TM-12: SPLIT needs at least 2')]);
  });

  it('downgrades every other verdict missing its field', () => {
    const report = parse({
      tickets: [
        { ref: 'TM-9', verdict: 'REWRITE' },
        { ref: 'TM-12', verdict: 'MERGE', mergeInto: 'TM-99' },
        { ref: 'TM-14', verdict: 'REORDER', after: [] },
        { ref: '#3', verdict: 'DECIDE', question: '  ' },
      ],
    });
    expect(report.tickets.map((t) => t.verdict)).toEqual(['OK', 'OK', 'OK', 'OK']);
    expect(report.warnings).toHaveLength(4);
  });

  it('drops an unknown ref with a warning', () => {
    const report = parse({
      tickets: [
        { ref: 'TM-404', verdict: 'DROP' },
        { ref: 'TM-9', verdict: 'DROP' },
      ],
      hotFiles: [{ path: 'src/b.ts', refs: ['TM-9', 'TM-404'] }],
    });
    expect(report.tickets.map((t) => t.ref)).toEqual(['TM-9']);
    expect(report.hotFiles[0].refs).toEqual(['TM-9']);
    expect(report.warnings).toEqual([
      'Unknown ticket TM-404 dropped.',
      'Hot file src/b.ts: unknown ref TM-404 dropped.',
    ]);
  });

  it('warns on a wave over the cap and keeps it', () => {
    const report = parse({ tickets: [], waves: [{ refs: ['TM-9', 'TM-12', 'TM-14', '#3'] }] }, 3);
    expect(report.waves[0].refs).toHaveLength(4);
    expect(report.warnings).toEqual(['Wave 1 has 4 tickets, more than the ready-lane cap of 3.']);
  });

  it('never warns about wave size with a cap of 0', () => {
    const report = parse({ tickets: [], waves: [{ refs: ['TM-9', 'TM-12', 'TM-14', '#3'] }] }, 0);
    expect(report.warnings).toEqual([]);
  });
});

describe('boardReviewRecommendations', () => {
  it('lists one recommendation per non-OK ticket', () => {
    const report = parse(valid);
    expect(boardReviewRecommendations(report)).toEqual([
      { id: 'TM-12', taskId: 't12', verdict: 'SPLIT', label: 'Split TM-12 into 2 tickets' },
      { id: 'TM-14', taskId: 't14', verdict: 'REORDER', label: 'Run TM-14 after TM-9' },
      { id: '#3', taskId: 't3', verdict: 'DECIDE', label: 'Ask on #3: Keep the old API?' },
    ]);
  });

  it('labels a rewrite, a merge and a drop', () => {
    const report = parse({
      tickets: [
        { ref: 'TM-9', verdict: 'REWRITE', rewrite: { title: 'Clearer', description: 'x' } },
        { ref: 'TM-12', verdict: 'MERGE', mergeInto: 'TM-14' },
        { ref: 'TM-14', verdict: 'DROP' },
      ],
    });
    expect(boardReviewRecommendations(report).map((r) => r.label)).toEqual([
      'Rewrite TM-9 as "Clearer"',
      'Merge TM-12 into TM-14',
      'Drop TM-14',
    ]);
  });
});
