import { describe, expect, it } from 'vitest';
import type { AttentionKind } from '@tm/shared/attention';
import { INBOX_CHIPS, KIND_CHIP, chipIncludes, filterInbox } from './inboxFilter';

/**
 * Every `AttentionKind`, spelled out independently of `KIND_CHIP`. The `satisfies` makes
 * `pnpm typecheck` fail the moment a kind is added to `AttentionKind` and not listed here —
 * and once it is listed, the runtime checks below fail until `KIND_CHIP` maps it too.
 */
const ALL_KINDS = Object.keys({
  permission: true,
  question: true,
  'merge-conflict': true,
  'task-failed': true,
  proposal: true,
  'plan-approval': true,
  'agent-question': true,
} satisfies Record<AttentionKind, true>) as AttentionKind[];

const NARROW_CHIPS = INBOX_CHIPS.map((c) => c.id).filter((id) => id !== 'needs-you');

describe('inboxFilter', () => {
  it('maps every AttentionKind', () => {
    for (const kind of ALL_KINDS) expect(KIND_CHIP[kind], kind).toBeDefined();
    expect(Object.keys(KIND_CHIP).sort()).toEqual([...ALL_KINDS].sort());
  });

  it('puts each kind in exactly one chip other than "Needs you"', () => {
    for (const kind of ALL_KINDS) {
      const homes = NARROW_CHIPS.filter((chip) => chipIncludes(chip, kind));
      expect(homes, kind).toHaveLength(1);
    }
  });

  it('shows every kind under "Needs you"', () => {
    for (const kind of ALL_KINDS) expect(chipIncludes('needs-you', kind)).toBe(true);
  });

  it('renders the four chips in order, without Mentions or Reviews', () => {
    expect(INBOX_CHIPS.map((c) => c.label)).toEqual([
      'Needs you',
      'Questions',
      'Plans',
      'Failures',
    ]);
  });

  it('filters items by chip and keeps their order', () => {
    const items = [
      { id: 'a', kind: 'task-failed' as const },
      { id: 'b', kind: 'agent-question' as const },
      { id: 'c', kind: 'plan-approval' as const },
      { id: 'd', kind: 'permission' as const },
    ];
    expect(filterInbox(items, 'needs-you').map((i) => i.id)).toEqual(['a', 'b', 'c', 'd']);
    expect(filterInbox(items, 'questions').map((i) => i.id)).toEqual(['b', 'd']);
    expect(filterInbox(items, 'plans').map((i) => i.id)).toEqual(['c']);
    expect(filterInbox(items, 'failures').map((i) => i.id)).toEqual(['a']);
  });
});
