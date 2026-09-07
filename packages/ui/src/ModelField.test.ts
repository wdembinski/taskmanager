/**
 * The pure logic behind the shared model picker: how the catalog is grouped, how one row's
 * caption reads before/after a probe answers for it, which values count as "custom", and what
 * the custom box's live caption says.
 *
 * The rendering itself (Dropdown/Input/debounced `model:resolve`) is exercised end to end in
 * a later step; these are the decisions that would fail silently inside it — a row dropped
 * from the wrong group, a caption that claims a probe answer it never got, a value the
 * control fails to recognize as "already pinned, just not in the static catalog".
 */
import { describe, expect, it } from 'vitest';
import type { ModelCatalogEntry, ModelResolution } from '@tm/shared/model';
import {
  CUSTOM_MODEL,
  customCaption,
  groupCatalog,
  isCustomValue,
  optionCaption,
} from './ModelField';

const CATALOG: ModelCatalogEntry[] = [
  { id: 'haiku', family: 'haiku', kind: 'alias' },
  { id: 'claude-haiku-4-5', family: 'haiku', kind: 'version' },
  { id: 'sonnet', family: 'sonnet', kind: 'alias' },
  { id: 'claude-sonnet-4-5', family: 'sonnet', kind: 'version' },
  { id: 'claude-sonnet-5', family: 'sonnet', kind: 'version' },
  { id: 'opus', family: 'opus', kind: 'alias' },
  { id: 'claude-opus-4-7', family: 'opus', kind: 'version' },
];

describe('groupCatalog', () => {
  it('puts every alias first, regardless of family', () => {
    const { aliases } = groupCatalog(CATALOG);
    expect(aliases.map((e) => e.id)).toEqual(['haiku', 'sonnet', 'opus']);
  });

  it('groups pinned versions by family, in the order each family first appears', () => {
    const { versionGroups } = groupCatalog(CATALOG);
    expect(versionGroups.map((g) => g.family)).toEqual(['haiku', 'sonnet', 'opus']);
    expect(versionGroups.find((g) => g.family === 'sonnet')?.entries.map((e) => e.id)).toEqual([
      'claude-sonnet-4-5',
      'claude-sonnet-5',
    ]);
  });

  it('never puts an alias in a version group', () => {
    const { versionGroups } = groupCatalog(CATALOG);
    for (const group of versionGroups) {
      expect(group.entries.every((e) => e.kind === 'version')).toBe(true);
    }
  });
});

describe('optionCaption', () => {
  it('reads the bare id before any resolution has come back — the transport-tier fallback', () => {
    expect(optionCaption('opus', undefined)).toBe('opus');
  });

  it('names what the CLI calls it once the probe confirms it knows the id', () => {
    const resolution: ModelResolution = { id: 'opus', label: 'Opus 5', known: true };
    expect(optionCaption('opus', resolution)).toBe('opus — Opus 5');
  });

  it('annotates rather than hides a row the probe says this CLI does not recognize', () => {
    const resolution: ModelResolution = {
      id: 'claude-opus-9',
      label: 'claude-opus-9',
      known: false,
    };
    expect(optionCaption('claude-opus-9', resolution)).toBe(
      'claude-opus-9 — unrecognized by this CLI',
    );
  });
});

describe('isCustomValue', () => {
  it('is false for a catalog id', () => {
    expect(isCustomValue('sonnet', '..sentinel', CATALOG)).toBe(false);
  });

  it('is false for the sentinel value', () => {
    expect(isCustomValue('..sentinel', '..sentinel', CATALOG)).toBe(false);
  });

  it('is false for an empty value — nothing chosen yet is not a custom choice', () => {
    expect(isCustomValue('', '..sentinel', CATALOG)).toBe(false);
  });

  it('is true for a value the catalog has never heard of — a project already pinned to it', () => {
    expect(isCustomValue('claude-opus-4-99', '..sentinel', CATALOG)).toBe(true);
  });

  it('has a sentinel no model id can collide with', () => {
    expect(CUSTOM_MODEL.startsWith('..')).toBe(true);
    expect(CATALOG.some((e) => e.id === CUSTOM_MODEL)).toBe(false);
  });
});

describe('customCaption', () => {
  it('says nothing while there is no answer yet', () => {
    expect(customCaption(null)).toBeNull();
  });

  it('quotes the CLI’s own name once it confirms the id', () => {
    expect(customCaption({ id: 'claude-opus-4-7', label: 'Opus 4.7', known: true })).toBe(
      'Runs as: Opus 4.7',
    );
  });

  it('warns rather than refuses when the CLI does not recognize a well-formed id', () => {
    expect(
      customCaption({ id: 'claude-future-model', label: 'claude-future-model', known: false }),
    ).toBe("The installed CLI doesn't recognize this model.");
  });
});
