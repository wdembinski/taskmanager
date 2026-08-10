/**
 * Unit tests for the mechanical half of "Align plan" — the edit the app makes to the
 * user's own plan file without spending a session on it.
 *
 * The plan is a file the human wrote and keeps reading, so the tests are mostly about
 * what the edit must NOT do: reorder, re-check, reword, or reflow anything.
 */
import { describe, expect, it } from 'vitest';
import { buildContractScaffold, CONTRACT_TASK_TITLE, insertContractTasks } from './planAlign';
import { parsePlan } from './planParser';
import { validatePlan } from './planValidate';
import { parseFileOwnership } from './attention';

/** A plan whose first milestone fans out and whose second one does not. */
const PLAN = [
  '# Phase 1 — Foundations',
  '',
  'Some prose that is not a task and must survive untouched.',
  '',
  '- [x] Set up the repo',
  '- [ ] Build the API @needs: Set up the repo',
  '- [ ] Build the UI @needs: Set up the repo',
  '',
  '# Phase 2 — Ship',
  '',
  '- [ ] Release @needs: Build the API',
  '',
].join('\n');

const CONTRACT_LINE = `- [ ] ${CONTRACT_TASK_TITLE}`;

describe('insertContractTasks', () => {
  it('inserts the contract task as the first task of a milestone that fans out', () => {
    const { markdown, phases } = insertContractTasks(PLAN);

    expect(phases).toEqual(['Phase 1 — Foundations']);
    const lines = markdown.split('\n');
    expect(lines.indexOf(CONTRACT_LINE)).toBe(lines.indexOf('- [x] Set up the repo') - 1);
    // The milestone that is a single task gets nothing.
    expect(markdown.split(CONTRACT_LINE).length - 1).toBe(1);
  });

  it('inserts the exact line the parser reads back as a contract task', () => {
    const inserted = parsePlan(insertContractTasks(PLAN).markdown).find((t) => t.isContract);
    expect(inserted).toMatchObject({
      phase: 'Phase 1 — Foundations',
      title: 'Define shared contract in CONTRACT.md',
      done: false,
      needs: [],
    });
  });

  it('answers the validator that asked for it — the contract advisory goes quiet', () => {
    expect(validatePlan(parsePlan(PLAN)).issues.map((i) => i.message)).toEqual([
      expect.stringContaining('shared contract'),
    ]);
    expect(validatePlan(parsePlan(insertContractTasks(PLAN).markdown)).issues).toEqual([]);
  });

  it('is idempotent — a second run inserts nothing', () => {
    const once = insertContractTasks(PLAN);
    const twice = insertContractTasks(once.markdown);
    expect(twice.phases).toEqual([]);
    expect(twice.markdown).toBe(once.markdown);
  });

  it('leaves a plan that needs no contract byte-identical', () => {
    const sequential = ['# Only', '', '- [ ] a', '- [ ] b @needs: a', ''].join('\n');
    const result = insertContractTasks(sequential);
    expect(result.phases).toEqual([]);
    expect(result.markdown).toBe(sequential);
  });

  it('preserves CRLF line endings', () => {
    const crlf = PLAN.replace(/\n/g, '\r\n');
    const { markdown } = insertContractTasks(crlf);

    expect(markdown).toContain(`\r\n${CONTRACT_LINE}\r\n`);
    expect(markdown).not.toMatch(/(^|[^\r])\n/); // no lone LF survived
    expect(markdown.replace(/\r\n/g, '\n')).toBe(insertContractTasks(PLAN).markdown);
  });

  it('reorders, re-checks and rewords nothing that was already there', () => {
    const before = parsePlan(PLAN);
    const after = parsePlan(insertContractTasks(PLAN).markdown).filter((t) => !t.isContract);
    expect(after).toEqual(before);
  });

  it('touches no line other than the one it inserts', () => {
    const before = PLAN.split('\n');
    const after = insertContractTasks(PLAN).markdown.split('\n');
    expect(after).toHaveLength(before.length + 1);
    expect(after.filter((line) => line !== CONTRACT_LINE)).toEqual(before);
  });

  it('matches the indentation and bullet marker of the task it sits above', () => {
    const starred = ['## Sub-milestone', '', '  * [ ] one', '  * [ ] two', ''].join('\n');
    expect(insertContractTasks(starred).markdown.split('\n')[2]).toBe(
      `  * [ ] ${CONTRACT_TASK_TITLE}`,
    );
  });

  it('gives every fanning-out milestone its own contract task', () => {
    const two = ['# A', '- [ ] a1', '- [ ] a2', '', '# B', '- [ ] b1', '- [ ] b2', ''].join('\n');
    const { markdown, phases } = insertContractTasks(two);

    expect(phases).toEqual(['A', 'B']);
    const lines = markdown.split('\n');
    // Both inserts land above their own milestone's first task, not shifted by the other.
    expect(lines.indexOf(CONTRACT_LINE)).toBe(lines.indexOf('- [ ] a1') - 1);
    expect(lines.lastIndexOf(CONTRACT_LINE)).toBe(lines.indexOf('- [ ] b1') - 1);
  });

  it('handles tasks written before any heading', () => {
    const headless = ['- [ ] a', '- [ ] b', ''].join('\n');
    const { markdown, phases } = insertContractTasks(headless);
    expect(phases).toEqual(['']);
    expect(markdown.split('\n')[0]).toBe(CONTRACT_LINE);
  });

  it('does nothing to an empty plan', () => {
    expect(insertContractTasks('')).toEqual({ markdown: '', phases: [] });
  });
});

describe('buildContractScaffold', () => {
  it('names the milestones it was written for and leaves the sections to fill in', () => {
    const scaffold = buildContractScaffold(['Phase 1 — Foundations', 'Phase 2 — Ship']);
    expect(scaffold).toContain('- Phase 1 — Foundations');
    expect(scaffold).toContain('- Phase 2 — Ship');
    expect(scaffold).toContain('## File ownership');
  });

  it('claims no file ownership — an empty map degrades safely, a fake row would not', () => {
    // `siblingsAffectedByProposal` treats a parsed row as a real claim, so a placeholder
    // like "- src/example/** — a task" would mis-route the proposal votes.
    expect(parseFileOwnership(buildContractScaffold(['Phase 1']))).toEqual([]);
  });

  it('still reads sensibly for tasks that live before any heading', () => {
    expect(buildContractScaffold([''])).toContain('before the first heading');
  });
});
