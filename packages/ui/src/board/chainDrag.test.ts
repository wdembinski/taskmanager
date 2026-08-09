import { describe, expect, it } from 'vitest';
import type { LinkEnd, TaskLink } from '@tm/shared/taskChain';
import { CHAIN_LINK_MIME, dropEffectFor, isChainLinkDrag, linkDropStates } from './chainDrag';

const card = (id: string, parentTaskId?: string): LinkEnd => ({ id, parentTaskId });

const link = (id: string, fromTaskId: string, toTaskId: string): TaskLink => ({
  id,
  fromTaskId,
  toTaskId,
  gate: 'after-merge',
  createdAt: 0,
});

describe('isChainLinkDrag', () => {
  it('tells a link being drawn from a card being moved', () => {
    expect(isChainLinkDrag([CHAIN_LINK_MIME])).toBe(true);
    expect(isChainLinkDrag(['text/plain'])).toBe(false);
    expect(isChainLinkDrag([])).toBe(false);
  });

  it('reads an array-LIKE too — `DataTransfer.types` is a DOMStringList per the spec', () => {
    expect(isChainLinkDrag({ length: 1, 0: CHAIN_LINK_MIME } as unknown as DOMStringList)).toBe(
      true,
    );
  });
});

describe('linkDropStates', () => {
  const tasks = [card('a'), card('b'), card('c'), card('step', 'a')];

  it('marks the card the drag started from as the source, not as a refusal', () => {
    expect(linkDropStates([], tasks, 'a').get('a')).toBe('source');
  });

  it('accepts an unrelated card', () => {
    expect(linkDropStates([], tasks, 'a').get('b')).toBe('valid');
  });

  it('separates "already linked" from a refusal', () => {
    const states = linkDropStates([link('l1', 'a', 'b')], tasks, 'a');
    expect(states.get('b')).toBe('linked');
    expect(states.get('c')).toBe('valid');
  });

  it('refuses a step at the far end — its order is a chain already', () => {
    expect(linkDropStates([], tasks, 'b').get('step')).toBe('refused');
  });

  it('refuses every card that would close a loop, not just the immediate predecessor', () => {
    // a → b → c. Dragging from c, both b and a are upstream, so either would loop.
    const links = [link('l1', 'a', 'b'), link('l2', 'b', 'c')];
    const states = linkDropStates(links, tasks, 'c');
    expect(states.get('b')).toBe('refused');
    expect(states.get('a')).toBe('refused');
  });

  it('answers for every card on the board', () => {
    expect([...linkDropStates([], tasks, 'a').keys()].sort()).toEqual(['a', 'b', 'c', 'step']);
  });
});

describe('dropEffectFor', () => {
  it('accepts only a valid target, so everything else refuses in the cursor', () => {
    expect(dropEffectFor('valid')).toBe('link');
    expect(dropEffectFor('linked')).toBe('none');
    expect(dropEffectFor('refused')).toBe('none');
    expect(dropEffectFor('source')).toBe('none');
    // No gesture in flight, or a card the states never heard of.
    expect(dropEffectFor(undefined)).toBe('none');
  });
});
