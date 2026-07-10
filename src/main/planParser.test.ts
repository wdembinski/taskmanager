/**
 * Unit tests for the pure plan parser. No files, no Electron — markdown in,
 * tasks out. Covers the grammar documented in planParser.ts.
 */
import { describe, expect, it } from 'vitest';
import { parsePlan, tickPlanCheckbox } from './planParser';

describe('parsePlan', () => {
  it('assigns each checkbox to the heading above it', () => {
    const tasks = parsePlan(
      ['# Project', '', '## Phase 1 — Setup', '- [ ] install deps', '- [ ] configure lint'].join(
        '\n',
      ),
    );
    expect(tasks).toEqual([
      { phase: 'Phase 1 — Setup', title: 'install deps', done: false, needs: [] },
      { phase: 'Phase 1 — Setup', title: 'configure lint', done: false, needs: [] },
    ]);
  });

  it('reads checked items as done, case-insensitively', () => {
    const tasks = parsePlan(
      ['## P', '- [x] lower done', '- [X] upper done', '- [ ] not done'].join('\n'),
    );
    expect(tasks.map((t) => t.done)).toEqual([true, true, false]);
  });

  it('accepts -, *, and + as list markers at any indent', () => {
    const tasks = parsePlan(
      ['## P', '- [ ] dash', '* [ ] star', '+ [ ] plus', '    - [ ] nested'].join('\n'),
    );
    expect(tasks.map((t) => t.title)).toEqual(['dash', 'star', 'plus', 'nested']);
  });

  it('ignores plain bullets and prose — only checkboxes are tasks', () => {
    const tasks = parsePlan(
      ['## P', 'Some explanation.', '- a plain bullet', '- [ ] a real task'].join('\n'),
    );
    expect(tasks).toEqual([{ phase: 'P', title: 'a real task', done: false, needs: [] }]);
  });

  it('folds wrapped continuation lines into the task title', () => {
    const tasks = parsePlan(
      ['## P', '- [ ] a long task that', '      wraps across', '      three lines'].join('\n'),
    );
    expect(tasks).toEqual([
      { phase: 'P', title: 'a long task that wraps across three lines', done: false, needs: [] },
    ]);
  });

  it('stops folding at a blank line', () => {
    const tasks = parsePlan(
      ['## P', '- [ ] first', '      continued', '', '      orphan prose', '- [ ] second'].join(
        '\n',
      ),
    );
    expect(tasks).toEqual([
      { phase: 'P', title: 'first continued', done: false, needs: [] },
      { phase: 'P', title: 'second', done: false, needs: [] },
    ]);
  });

  it('assigns phase "" to tasks before any heading', () => {
    const tasks = parsePlan(['- [ ] orphan'].join('\n'));
    expect(tasks).toEqual([{ phase: '', title: 'orphan', done: false, needs: [] }]);
  });

  it('handles CRLF line endings', () => {
    const tasks = parsePlan('## P\r\n- [ ] windows\r\n');
    expect(tasks).toEqual([{ phase: 'P', title: 'windows', done: false, needs: [] }]);
  });

  it('returns [] for empty or checkbox-free input', () => {
    expect(parsePlan('')).toEqual([]);
    expect(parsePlan('# Title\n\nJust prose, no tasks.')).toEqual([]);
  });

  it('extracts a trailing @needs clause into deps and strips it from the title', () => {
    const tasks = parsePlan(
      ['## P', '- [ ] Set up DB', '- [ ] Build API @needs: Set up DB'].join('\n'),
    );
    expect(tasks).toEqual([
      { phase: 'P', title: 'Set up DB', done: false, needs: [] },
      { phase: 'P', title: 'Build API', done: false, needs: ['Set up DB'] },
    ]);
  });

  it('parses multiple comma-separated dependencies (trimmed, case-insensitive key)', () => {
    const tasks = parsePlan(['## P', '- [ ] Deploy @NEEDS: Build API ,  Build UI'].join('\n'));
    expect(tasks[0]).toEqual({
      phase: 'P',
      title: 'Deploy',
      done: false,
      needs: ['Build API', 'Build UI'],
    });
  });

  it('honors @needs on a wrapped continuation line (folded before extraction)', () => {
    const tasks = parsePlan(['## P', '- [ ] A big task', '      @needs: Prereq'].join('\n'));
    expect(tasks[0]).toEqual({ phase: 'P', title: 'A big task', done: false, needs: ['Prereq'] });
  });

  it('write-back still ticks a task whose line carries a @needs clause', () => {
    const md = ['## P', '- [ ] Build API @needs: Set up DB'].join('\n');
    expect(tickPlanCheckbox(md, 'P', 'Build API')).toBe(
      ['## P', '- [x] Build API @needs: Set up DB'].join('\n'),
    );
  });
});

describe('tickPlanCheckbox', () => {
  it('ticks the matching unchecked box and leaves other lines byte-identical', () => {
    const md = ['## P', '- [ ] first', '- [ ] second'].join('\n');
    expect(tickPlanCheckbox(md, 'P', 'second')).toBe(
      ['## P', '- [ ] first', '- [x] second'].join('\n'),
    );
  });

  it('matches a folded multi-line task and flips only its first line', () => {
    const md = ['## P', '- [ ] a task that', '      wraps here'].join('\n');
    expect(tickPlanCheckbox(md, 'P', 'a task that wraps here')).toBe(
      ['## P', '- [x] a task that', '      wraps here'].join('\n'),
    );
  });

  it('disambiguates same title under different phases', () => {
    const md = ['## P1', '- [ ] a', '## P2', '- [ ] a'].join('\n');
    expect(tickPlanCheckbox(md, 'P2', 'a')).toBe(
      ['## P1', '- [ ] a', '## P2', '- [x] a'].join('\n'),
    );
  });

  it('returns null when the task is missing or already checked', () => {
    const md = ['## P', '- [x] done', '- [ ] other'].join('\n');
    expect(tickPlanCheckbox(md, 'P', 'done')).toBeNull(); // already ticked
    expect(tickPlanCheckbox(md, 'P', 'nope')).toBeNull(); // no such task
  });

  it('preserves CRLF line endings', () => {
    const md = '## P\r\n- [ ] win\r\n';
    expect(tickPlanCheckbox(md, 'P', 'win')).toBe('## P\r\n- [x] win\r\n');
  });

  it('keeps the list marker and indentation intact', () => {
    const md = ['## P', '  * [ ] indented star'].join('\n');
    expect(tickPlanCheckbox(md, 'P', 'indented star')).toBe(
      ['## P', '  * [x] indented star'].join('\n'),
    );
  });
});
