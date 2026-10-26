/**
 * The peek's conversation draws v9-1's comment shape — initials, name, a compact age, the body
 * underneath — and none of `ChatTurns`' bubbles. `ChatTurns` is rendered alongside as the
 * control: the same turns there DO carry the bubble marker, so its absence here means something.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ChatTurns } from '../chat/ChatTurns';
import type { Turn } from '../chat/turns';
import { PeekTimeline } from './PeekTimeline';

const NOW = new Date(2026, 9, 26, 12, 0, 0).getTime();
const MINUTE = 60_000;

const them: Turn = {
  key: 'c1',
  kind: 'them',
  author: 'Marta Nowak',
  body: 'Can we keep the Linear labels too?',
  createdAt: NOW - 12 * MINUTE,
  tracker: 'linear',
};

const agent: Turn = {
  key: 'a1',
  kind: 'agent',
  text: 'Mapped the **status** field.',
  createdAt: NOW - 3 * 60 * MINUTE,
};

/** Text content only, tags stripped — so checks read what a human reads. */
function text(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
}

describe('PeekTimeline', () => {
  it("draws someone's comment as initials, name, age and the body underneath", () => {
    const html = renderToStaticMarkup(<PeekTimeline turns={[them]} now={NOW} />);
    const words = text(html);
    const order = ['MN', 'Marta Nowak', '12m', 'Can we keep the Linear labels too?'].map((s) =>
      words.indexOf(s),
    );
    for (const at of order) expect(at).toBeGreaterThan(-1);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('draws no ChatTurns bubble', () => {
    const control = renderToStaticMarkup(<ChatTurns turns={[them]} />);
    expect(control).toContain('data-chat-bubble');
    const html = renderToStaticMarkup(<PeekTimeline turns={[them, agent]} now={NOW} />);
    expect(html).not.toContain('data-chat-bubble');
  });

  it('names an agent turn "Agent" and renders its markdown', () => {
    const html = renderToStaticMarkup(<PeekTimeline turns={[agent]} now={NOW} />);
    expect(text(html)).toContain('Agent 3h');
    expect(html).not.toContain('**status**');
    expect(text(html)).toContain('status');
  });

  it('folds tool runs and transcript lines to one muted caption each', () => {
    const html = renderToStaticMarkup(
      <PeekTimeline
        turns={[
          { key: 't1', kind: 'tools', count: 3, labels: [], createdAt: NOW },
          { key: 's1', kind: 'system', text: 'Run finished', tone: 'meta', createdAt: NOW },
        ]}
        now={NOW}
      />,
    );
    expect(text(html)).toContain('Worked with 3 tools');
    expect(text(html)).toContain('Run finished');
  });
});
