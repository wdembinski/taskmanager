/**
 * Unit tests for the pure plan validator (Phase C).
 */
import { describe, expect, it } from 'vitest';
import { planHasAlignmentMarkers, validatePlan } from './planValidate';
import type { ParsedTask } from './planParser';

const t = (
  title: string,
  needs: string[] = [],
  opts: { phase?: string; done?: boolean; isContract?: boolean; isScaffold?: boolean } = {},
): ParsedTask => ({
  phase: opts.phase ?? 'P',
  title,
  done: opts.done ?? false,
  needs,
  isContract: opts.isContract ?? false,
  isScaffold: opts.isScaffold ?? false,
});

describe('validatePlan', () => {
  it('accepts a plan whose dependencies all resolve and form no cycle', () => {
    const result = validatePlan([t('a'), t('b', ['a']), t('c', ['a', 'b'])]);
    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([]);
  });

  it('advises (does not error) when a multi-task plan declares no dependencies', () => {
    const result = validatePlan([t('a'), t('b'), t('c')]);
    expect(result.ok).toBe(true); // advisory only — never blocks
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].severity).toBe('warning');
    expect(result.issues[0].message).toContain('parallel agents may collide');
  });

  it('does not advise about dependencies once any @needs: is declared', () => {
    // A strict a→b→c chain: dependencies declared and nothing runs in parallel,
    // so neither the "no dependencies" nor the "no shared contract" advisory fires.
    const result = validatePlan([t('a'), t('b', ['a']), t('c', ['b'])]);
    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([]);
  });

  it('does not advise about dependencies for a single-task plan', () => {
    const result = validatePlan([t('only')]);
    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([]);
  });

  it('flags a dangling @needs reference as an error', () => {
    const result = validatePlan([t('a'), t('b', ['Set up DB'])]);
    expect(result.ok).toBe(false);
    expect(
      result.issues.some((i) => i.severity === 'error' && i.message.includes('Set up DB')),
    ).toBe(true);
  });

  it('detects a dependency cycle', () => {
    const result = validatePlan([t('a', ['b']), t('b', ['a'])]);
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.message.startsWith('Dependency cycle'))).toBe(true);
  });

  it('detects a self-dependency as a cycle', () => {
    const result = validatePlan([t('a', ['a'])]);
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.message.startsWith('Dependency cycle'))).toBe(true);
  });

  it('warns (does not error) on an empty plan', () => {
    const result = validatePlan([]);
    expect(result.ok).toBe(true); // warning only
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].severity).toBe('warning');
  });

  it('advises adding a shared contract when a milestone fans out in parallel', () => {
    // Dependencies are declared (so advisory (a) is silent), but under phase M,
    // tasks x and y both depend only on the setup and can run in parallel with no
    // shared contract — advisory (b) fires.
    const result = validatePlan([
      t('setup', [], { phase: 'M' }),
      t('x', ['setup'], { phase: 'M' }),
      t('y', ['setup'], { phase: 'M' }),
    ]);
    expect(result.ok).toBe(true); // advisory only
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].severity).toBe('warning');
    expect(result.issues[0].message).toContain('shared contract');
  });

  it('does not advise about a contract once the milestone has a @contract task', () => {
    const result = validatePlan([
      t('Define shared contract in CONTRACT.md', [], { phase: 'M', isContract: true }),
      t('x', ['Define shared contract in CONTRACT.md'], { phase: 'M' }),
      t('y', ['Define shared contract in CONTRACT.md'], { phase: 'M' }),
    ]);
    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([]);
  });

  it('does not double-advise: only the no-dependencies warning fires for a bare plan', () => {
    // No markers at all → advisory (a) fires; advisory (b) is suppressed (else branch).
    const result = validatePlan([t('a'), t('b'), t('c')]);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].message).toContain('parallel agents may collide');
  });
});

describe('planHasAlignmentMarkers', () => {
  it('is false for a plan with no @needs: clauses', () => {
    expect(planHasAlignmentMarkers([t('a'), t('b')])).toBe(false);
  });

  it('is true as soon as any task declares a dependency', () => {
    expect(planHasAlignmentMarkers([t('a'), t('b', ['a'])])).toBe(true);
  });

  it('is true when a task is marked @contract even with no @needs:', () => {
    expect(planHasAlignmentMarkers([t('a', [], { isContract: true }), t('b')])).toBe(true);
  });

  it('is false for an empty plan', () => {
    expect(planHasAlignmentMarkers([])).toBe(false);
  });
});
