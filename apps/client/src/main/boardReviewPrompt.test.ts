import { describe, expect, it } from 'vitest';
import { BOARD_REVIEW_RUBRIC, parseBoardReviewReport } from '@shared/boardReview';
import {
  BOARD_REVIEW_EXAMPLE,
  DESCRIPTION_LIMIT,
  buildBoardReviewPrompt,
  type BoardReviewPromptInput,
  type BoardReviewPromptTicket,
} from './boardReviewPrompt';

function ticket(over: Partial<BoardReviewPromptTicket> & { id: string }): BoardReviewPromptTicket {
  return {
    title: `Ticket ${over.id}`,
    status: 'pending',
    ticketKey: null,
    externalKey: null,
    externalDescription: null,
    epicTaskId: null,
    milestoneId: null,
    ...over,
  };
}

const input: BoardReviewPromptInput = {
  projectName: 'Task Manager',
  cap: 3,
  openTickets: [
    ticket({
      id: 'a',
      ticketKey: 'TM-1',
      title: 'Add the merge switch',
      externalDescription: 'Show a switch on the board header.',
      epicTaskId: 'e1',
      milestoneId: 'm1',
    }),
    ticket({ id: 'b', externalKey: 'EE-7', title: 'Fix the sidebar' }),
    ticket({ id: 'c', title: 'A ticket with no key' }),
  ],
  doneTickets: [{ id: 'd', ticketKey: 'TM-0', externalKey: null, title: 'Ship the board' }],
  epics: [{ id: 'e1', ticketKey: 'TM-100', externalKey: null, title: 'Board polish' }],
  milestones: [{ id: 'm1', name: 'M5 — Calm board' }],
  ticketLinks: [{ fromTaskId: 'b', toTaskId: 'a', type: 'relates' }],
  taskLinks: [
    { fromTaskId: 'd', toTaskId: 'a', gate: 'after-merge' },
    { fromTaskId: 'a', toTaskId: 'c', gate: 'stacked' },
  ],
};

describe('buildBoardReviewPrompt', () => {
  const { prompt, refs } = buildBoardReviewPrompt(input);
  const section = (heading: string): string => {
    const start = prompt.indexOf(heading);
    const next = prompt.indexOf('\n## ', start + heading.length);
    return prompt.slice(start, next < 0 ? undefined : next);
  };

  it('maps refs of open tickets only, by ticketKey ?? externalKey ?? #n', () => {
    expect(refs).toEqual({ 'TM-1': 'a', 'EE-7': 'b', '#1': 'c' });
  });

  it("lists each open ticket's ref, title, description, epic, milestone and arrows", () => {
    const open = section('## Open tickets');
    expect(open).toContain('### TM-1 — Add the merge switch');
    expect(open).toContain('Show a switch on the board header.');
    expect(open).toContain('- Epic: Board polish');
    expect(open).toContain('- Milestone: M5 — Calm board');
    expect(open).toContain('- Arrows in (runs after): TM-0 "Ship the board" [after-merge]');
    expect(open).toContain('- Arrows out (runs before): #1 "A ticket with no key" [stacked]');
    expect(open).toContain('- Ticket links: EE-7 "Fix the sidebar" relates this');
    expect(open).toContain('- Ticket links: relates TM-1 "Add the merge switch"');
    expect(open).toContain('### EE-7 — Fix the sidebar');
    expect(open).toContain('### #1 — A ticket with no key');
    expect(open).toContain('(no description)');
  });

  it('lists done tickets title-only', () => {
    const done = section('## Done tickets');
    expect(done).toContain('- TM-0 — Ship the board');
    expect(prompt).not.toContain('### TM-0');
  });

  it('lists epics and milestones', () => {
    expect(section('## Epics')).toContain('- TM-100 — Board polish');
    expect(section('## Milestones')).toContain('- M5 — Calm board');
  });

  it('carries the read-only rule, how a card runs, the rubric and the evidence rule', () => {
    expect(prompt).toContain('You are read-only: do not edit');
    expect(prompt).toContain('## How this orchestrator runs a card');
    expect(prompt).toContain(
      'Steps never see the ticket or the document — only their own section and the framing ' +
        '(Context/Facts/Decisions).',
    );
    expect(prompt).toContain(BOARD_REVIEW_RUBRIC);
    expect(section('## Hot files')).toContain('"hotFiles"');
    expect(prompt).toContain('Back every verdict with evidence from the code (path:line)');
  });

  it('states the cap number in the wave rule', () => {
    expect(section('## Waves')).toContain('no wave may hold more than 3 tickets');
  });

  it('says "no cap" when the cap is 0', () => {
    const waves = buildBoardReviewPrompt({ ...input, cap: 0 }).prompt;
    expect(waves).toContain('(no cap)');
    expect(waves).not.toContain('no wave may hold more than');
  });

  it('ends with the json block instruction and the example', () => {
    expect(prompt).toContain('END your answer with exactly one fenced json block of this shape');
    expect(prompt.trimEnd().indexOf(BOARD_REVIEW_EXAMPLE)).toBeGreaterThan(
      prompt.indexOf('## Your answer'),
    );
  });

  it(`cuts a description longer than ${DESCRIPTION_LIMIT} characters`, () => {
    const long = `${'x'.repeat(DESCRIPTION_LIMIT)}TAIL-NEVER-SHOWN`;
    const out = buildBoardReviewPrompt({
      ...input,
      openTickets: [ticket({ id: 'a', ticketKey: 'TM-1', externalDescription: long })],
    }).prompt;
    expect(out).toContain('x'.repeat(DESCRIPTION_LIMIT));
    expect(out).not.toContain('TAIL-NEVER-SHOWN');
    expect(out).toContain('[… cut: 16 more characters]');
  });

  it('gives duplicate keys distinct refs, open tickets keeping the bare key', () => {
    const out = buildBoardReviewPrompt({
      ...input,
      openTickets: [
        ticket({ id: 'a', ticketKey: 'TM-1', title: 'First' }),
        ticket({ id: 'b', ticketKey: 'TM-1', title: 'Second' }),
        ticket({ id: 'c', title: 'Keyless one' }),
        ticket({ id: 'f', title: 'Keyless two' }),
      ],
      doneTickets: [{ id: 'd', ticketKey: 'TM-1', externalKey: null, title: 'Done twin' }],
      taskLinks: [],
      ticketLinks: [],
    });
    expect(out.refs).toEqual({ 'TM-1': 'a', 'TM-1/2': 'b', '#1': 'c', '#2': 'f' });
    expect(out.prompt).toContain('- TM-1/3 — Done twin');
  });

  it('lists only the latest 40 done tickets', () => {
    const doneTickets = Array.from({ length: 45 }, (_, i) => ({
      id: `d${i}`,
      ticketKey: `OLD-${i}`,
      externalKey: null,
      title: `Done ${i}`,
    }));
    const out = buildBoardReviewPrompt({ ...input, doneTickets, taskLinks: [] }).prompt;
    expect(out).toContain('- OLD-39 — Done 39');
    expect(out).not.toContain('OLD-40');
  });
});

describe('BOARD_REVIEW_EXAMPLE', () => {
  it('round-trips through parseBoardReviewReport with every verdict kept', () => {
    const refs = Object.fromEntries(
      ['TM-9', 'TM-10', 'TM-11', 'TM-12', 'TM-13', 'TM-14', 'TM-15'].map((r) => [r, `id-${r}`]),
    );
    const parsed = parseBoardReviewReport(
      `Here is the review.\n\n${BOARD_REVIEW_EXAMPLE}`,
      refs,
      3,
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.report.warnings).toEqual([]);
    expect(parsed.report.tickets.map((t) => t.verdict)).toEqual([
      'OK',
      'REWRITE',
      'SPLIT',
      'MERGE',
      'DROP',
      'REORDER',
      'DECIDE',
    ]);
    expect(parsed.report.hotFiles).toHaveLength(1);
    expect(parsed.report.waves).toHaveLength(2);
  });
});
