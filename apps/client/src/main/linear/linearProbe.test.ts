import { describe, expect, it } from 'vitest';
import { describeLinearProbe } from './linearProbe';

const viewer = { displayName: 'Ada' };
const organization = { name: 'Acme', urlKey: 'acme' };
const teams = [
  { id: '1', key: 'ENG', name: 'Engineering' },
  { id: '2', key: 'DES', name: 'Design' },
];

describe('describeLinearProbe', () => {
  it('reports success with every configured team found', () => {
    const result = describeLinearProbe({
      viewer,
      organization,
      teams,
      teamKeys: ['ENG', 'DES'],
      enabled: true,
    });
    expect(result).toEqual({
      ok: true,
      displayName: 'Ada',
      message: 'Connected as Ada to Acme — ENG, DES found.',
    });
  });

  it("matches team keys case-insensitively and reports the workspace's own casing", () => {
    const result = describeLinearProbe({
      viewer,
      organization,
      teams,
      teamKeys: ['eng'],
      enabled: true,
    });
    expect(result).toEqual({
      ok: true,
      displayName: 'Ada',
      message: 'Connected as Ada to Acme — ENG found.',
    });
  });

  it('nudges to switch Linear on when a success lands while it is still off', () => {
    const result = describeLinearProbe({
      viewer,
      organization,
      teams,
      teamKeys: ['ENG'],
      enabled: false,
    });
    expect(result.ok).toBe(true);
    expect(result.message).toContain('Switch Linear on above to start syncing.');
  });

  it('reports ok with a nudge when no teams are chosen yet', () => {
    const result = describeLinearProbe({
      viewer,
      organization,
      teams,
      teamKeys: [],
      enabled: true,
    });
    expect(result).toEqual({
      ok: true,
      displayName: 'Ada',
      message: 'Connected as Ada to Acme — pick the teams to mirror below.',
    });
  });

  it('treats blank-only team keys the same as none chosen', () => {
    const result = describeLinearProbe({
      viewer,
      organization,
      teams,
      teamKeys: ['   ', ''],
      enabled: true,
    });
    expect(result.ok).toBe(true);
    expect(result.message).toContain('pick the teams to mirror below');
  });

  it('fails and names a single missing team key, listing what does exist', () => {
    const result = describeLinearProbe({
      viewer,
      organization,
      teams,
      teamKeys: ['OPS'],
      enabled: true,
    });
    expect(result).toEqual({
      ok: false,
      displayName: 'Ada',
      message: "Connected as Ada (Acme), but team OPS isn't in this workspace — teams: ENG, DES.",
    });
  });

  it('fails and names every missing team key when more than one is absent', () => {
    const result = describeLinearProbe({
      viewer,
      organization,
      teams,
      teamKeys: ['ENG', 'OPS', 'QA'],
      enabled: true,
    });
    expect(result.ok).toBe(false);
    expect(result.message).toBe(
      "Connected as Ada (Acme), but teams OPS, QA aren't in this workspace — teams: ENG, DES.",
    );
  });

  it('lists "none" when the workspace has no teams at all', () => {
    const result = describeLinearProbe({
      viewer,
      organization,
      teams: [],
      teamKeys: ['OPS'],
      enabled: true,
    });
    expect(result.message).toContain('teams: none.');
  });

  it('dedupes configured team keys before matching', () => {
    const result = describeLinearProbe({
      viewer,
      organization,
      teams,
      teamKeys: ['ENG', 'eng', ' ENG '],
      enabled: true,
    });
    expect(result).toEqual({
      ok: true,
      displayName: 'Ada',
      message: 'Connected as Ada to Acme — ENG found.',
    });
  });
});
