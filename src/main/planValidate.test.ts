/**
 * Unit tests for the pure plan validator (Phase C).
 */
import { describe, expect, it } from 'vitest';
import { validatePlan } from './planValidate';
import type { ParsedTask } from './planParser';

const t = (title: string, needs: string[] = []): ParsedTask => ({
  phase: 'P',
  title,
  done: false,
  needs,
});

describe('validatePlan', () => {
  it('accepts a plan whose dependencies all resolve and form no cycle', () => {
    const result = validatePlan([t('a'), t('b', ['a']), t('c', ['a', 'b'])]);
    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([]);
  });

  it('treats a plan with no dependencies as clean', () => {
    const result = validatePlan([t('a'), t('b'), t('c')]);
    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([]);
  });

  it('flags a dangling @needs reference as an error', () => {
    const result = validatePlan([t('a'), t('b', ['Set up DB'])]);
    expect(result.ok).toBe(false);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].severity).toBe('error');
    expect(result.issues[0].message).toContain('Set up DB');
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
});
