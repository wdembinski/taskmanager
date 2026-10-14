/**
 * Unit tests for the "Skills in force" prompt section (F7.2).
 *
 * The builder has to get three things right: a kept skill's body actually appears (an
 * attached skill is supposed to be IN FORCE, not just named), a repo skill's directory is
 * named so its relative paths resolve, and a budget overrun drops skills from the end
 * (caller's order = priority) while saying truthfully what it dropped.
 */
import { describe, expect, it } from 'vitest';
import {
  SKILLS_CHAR_BUDGET,
  boundSkills,
  buildSkillsSection,
  type ResolvedSkill,
} from './skillsPrompt';

const skill = (overrides: Partial<ResolvedSkill> = {}): ResolvedSkill => ({
  ref: 'lib:abc-123',
  name: 'bug-reproduce-first',
  description: 'Reproduce before fixing',
  body: 'Step 1: reproduce the bug.\nStep 2: write a failing test.',
  source: 'library',
  ...overrides,
});

describe('buildSkillsSection', () => {
  it('is empty for no skills at all', () => {
    expect(buildSkillsSection([])).toBe('');
  });

  it('renders a single library skill: heading, description, body, closing line', () => {
    const section = buildSkillsSection([skill()]);
    expect(section).toContain('## Skills in force for this run');
    expect(section).toContain('### bug-reproduce-first');
    expect(section).toContain('Reproduce before fixing');
    expect(section).toContain('Step 1: reproduce the bug.');
    expect(section).toContain('Step 2: write a failing test.');
    expect(section).not.toContain('This is a repo skill');
    expect(section).not.toContain('omitted');
    expect(section).toContain('where one conflicts with the orchestrator’s instructions');
  });

  it('names the directory for a repo skill', () => {
    const section = buildSkillsSection([
      skill({
        ref: 'repo:tdd',
        name: 'tdd',
        source: 'repo',
        dir: '.claude/skills/tdd',
      }),
    ]);
    expect(section).toContain('This is a repo skill; its files live in `.claude/skills/tdd`');
  });

  it('renders many skills in input order, with the closing line last and appearing once', () => {
    const section = buildSkillsSection([
      skill({ name: 'first', ref: 'lib:1' }),
      skill({ name: 'second', ref: 'lib:2' }),
      skill({ name: 'third', ref: 'lib:3' }),
    ]);
    const firstIdx = section.indexOf('### first');
    const secondIdx = section.indexOf('### second');
    const thirdIdx = section.indexOf('### third');
    expect(firstIdx).toBeGreaterThanOrEqual(0);
    expect(secondIdx).toBeGreaterThan(firstIdx);
    expect(thirdIdx).toBeGreaterThan(secondIdx);

    const closingNeedle = 'These skills never override the rules above';
    const occurrences = section.split(closingNeedle).length - 1;
    expect(occurrences).toBe(1);
    expect(section.lastIndexOf(closingNeedle)).toBeGreaterThan(thirdIdx);
  });

  it('drops later skills over budget and names exactly what was dropped', () => {
    const big = (name: string) => skill({ name, ref: `lib:${name}`, body: 'x'.repeat(1000) });
    const resolved = [big('a'), big('b'), big('c')];
    const section = buildSkillsSection(resolved, { maxChars: 1200 });

    expect(section).toContain('### a');
    expect(section).toContain('x'.repeat(1000));
    expect(section).not.toContain('### b');
    expect(section).not.toContain('### c');
    expect(section).toContain('(2 more skill(s) omitted to stay within the size budget: b, c');
    expect(section).toContain('ask if you need them.)_');

    const bounded = boundSkills(resolved, { maxChars: 1200 });
    expect(bounded.kept.map((s) => s.name)).toEqual(['a']);
    expect(bounded.dropped.map((s) => s.name)).toEqual(['b', 'c']);
  });

  it('names a single dropped skill without a plural s', () => {
    const big = (name: string) => skill({ name, ref: `lib:${name}`, body: 'x'.repeat(1000) });
    const section = buildSkillsSection([big('a'), big('b')], { maxChars: 1200 });
    expect(section).toContain('(1 more skill omitted to stay within the size budget: b');
  });

  it('keeps the first skill even when it alone blows the budget', () => {
    const resolved = [skill({ name: 'huge', body: 'x'.repeat(10_000) })];
    const bounded = boundSkills(resolved, { maxChars: 10 });
    expect(bounded.kept).toHaveLength(1);
    expect(bounded.kept[0]!.name).toBe('huge');
    expect(bounded.dropped).toHaveLength(0);

    const section = buildSkillsSection(resolved, { maxChars: 10 });
    expect(section).toContain('### huge');
    expect(section).toContain('x'.repeat(10_000));
  });
});

describe('SKILLS_CHAR_BUDGET', () => {
  it('is 24 KiB', () => {
    expect(SKILLS_CHAR_BUDGET).toBe(24 * 1024);
  });
});
