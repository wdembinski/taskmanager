/**
 * The automation-origin glyph's tooltip. The rule under test is that the name and the
 * catch-up time are each independently optional, and that the time renders in the
 * automation's OWN time zone — falling back to UTC when that zone is not one `Intl`
 * recognizes, same as `renderAutomationTemplate` itself.
 */
import { describe, expect, it } from 'vitest';
import { automationOriginTitle } from './automationOrigin';

describe('automationOriginTitle', () => {
  it('says only that an automation started it when nothing more is known', () => {
    expect(automationOriginTitle(null)).toBe('Started by an automation');
    expect(automationOriginTitle(undefined)).toBe('Started by an automation');
    expect(automationOriginTitle({ name: null })).toBe('Started by an automation');
  });

  it('names the automation once its name is known', () => {
    expect(automationOriginTitle({ name: 'Nightly triage' })).toBe('Started by Nightly triage');
  });

  it('appends the catch-up wall time in the automation’s own time zone', () => {
    expect(
      automationOriginTitle({
        name: 'Nightly triage',
        timeZone: 'Europe/Warsaw',
        catchUpAt: Date.parse('2026-03-10T03:00:00Z'),
      }),
    ).toBe('Started by Nightly triage · catch-up for 04:00');
  });

  it('still says catch-up when the automation’s name is not known', () => {
    expect(
      automationOriginTitle({
        name: null,
        timeZone: 'Europe/Warsaw',
        catchUpAt: Date.parse('2026-03-10T03:00:00Z'),
      }),
    ).toBe('Started by an automation · catch-up for 04:00');
  });

  it('falls back to UTC for a time zone Intl does not recognize', () => {
    expect(
      automationOriginTitle({
        name: 'Nightly triage',
        timeZone: 'Not/AZone',
        catchUpAt: Date.parse('2026-03-10T03:00:00Z'),
      }),
    ).toBe('Started by Nightly triage · catch-up for 03:00');
  });

  it('adds no extra part when catchUpAt is null', () => {
    expect(
      automationOriginTitle({ name: 'Nightly triage', timeZone: 'Europe/Warsaw', catchUpAt: null }),
    ).toBe('Started by Nightly triage');
  });
});
