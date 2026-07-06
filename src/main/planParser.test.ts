/**
 * Unit tests for the pure plan parser. No files, no Electron — markdown in,
 * tasks out. Covers the grammar documented in planParser.ts.
 */
import { describe, expect, it } from 'vitest';
import { parsePlan } from './planParser';

describe('parsePlan', () => {
  it('assigns each checkbox to the heading above it', () => {
    const tasks = parsePlan(
      ['# Project', '', '## Phase 1 — Setup', '- [ ] install deps', '- [ ] configure lint'].join(
        '\n',
      ),
    );
    expect(tasks).toEqual([
      { phase: 'Phase 1 — Setup', title: 'install deps', done: false },
      { phase: 'Phase 1 — Setup', title: 'configure lint', done: false },
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
    expect(tasks).toEqual([{ phase: 'P', title: 'a real task', done: false }]);
  });

  it('folds wrapped continuation lines into the task title', () => {
    const tasks = parsePlan(
      ['## P', '- [ ] a long task that', '      wraps across', '      three lines'].join('\n'),
    );
    expect(tasks).toEqual([
      { phase: 'P', title: 'a long task that wraps across three lines', done: false },
    ]);
  });

  it('stops folding at a blank line', () => {
    const tasks = parsePlan(
      ['## P', '- [ ] first', '      continued', '', '      orphan prose', '- [ ] second'].join(
        '\n',
      ),
    );
    expect(tasks).toEqual([
      { phase: 'P', title: 'first continued', done: false },
      { phase: 'P', title: 'second', done: false },
    ]);
  });

  it('assigns phase "" to tasks before any heading', () => {
    const tasks = parsePlan(['- [ ] orphan'].join('\n'));
    expect(tasks).toEqual([{ phase: '', title: 'orphan', done: false }]);
  });

  it('handles CRLF line endings', () => {
    const tasks = parsePlan('## P\r\n- [ ] windows\r\n');
    expect(tasks).toEqual([{ phase: 'P', title: 'windows', done: false }]);
  });

  it('returns [] for empty or checkbox-free input', () => {
    expect(parsePlan('')).toEqual([]);
    expect(parsePlan('# Title\n\nJust prose, no tasks.')).toEqual([]);
  });
});
