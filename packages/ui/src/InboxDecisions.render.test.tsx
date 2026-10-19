/**
 * Static-markup coverage for the Inbox's decisions list — the hook-free `InboxDecisionsView`
 * driven directly, the same way `DecisionBanner.render.test.tsx` drives its own view.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { DecisionGroup } from './decisionsIndex';
import { InboxDecisionsView } from './InboxDecisions';

const NOW = new Date(2026, 9, 19, 12, 0, 0).getTime();

const GROUPS: DecisionGroup[] = [
  {
    projectId: 'billing',
    projectName: 'Billing',
    decisions: [
      {
        taskId: 't1',
        title: 'Pick a hosting plan',
        question: 'Which hosting plan do we pay for?',
        askedAt: NOW - 2 * 86_400_000,
      },
    ],
  },
  {
    projectId: 'mobile',
    projectName: 'Mobile',
    decisions: [
      {
        taskId: 't2',
        title: 'Ship to the stores',
        question: 'Whose developer account publishes the app?',
        askedAt: null,
      },
    ],
  },
];

function view(groups: DecisionGroup[], onOpen?: (taskId: string) => void): string {
  return renderToStaticMarkup(
    <InboxDecisionsView
      groups={groups}
      onAnswer={() => Promise.resolve()}
      onOpen={onOpen}
      now={NOW}
    />,
  );
}

describe('InboxDecisionsView', () => {
  it('lists each project under its own heading, with its question and an answer box', () => {
    const html = view(GROUPS);
    expect(html).toContain('data-inbox-decisions');
    expect(html).toContain('>Decisions<');
    expect(html).toContain('>Billing<');
    expect(html).toContain('>Mobile<');
    expect(html.indexOf('>Billing<')).toBeLessThan(html.indexOf('Which hosting plan'));
    expect(html.indexOf('Which hosting plan')).toBeLessThan(html.indexOf('>Mobile<'));
    expect(html.indexOf('>Mobile<')).toBeLessThan(html.indexOf('Whose developer account'));
    expect(html).toContain('Pick a hosting plan');
    expect(html).toContain('Ship to the stores');
    expect(html.match(/<textarea/g)?.length).toBe(2);
    expect(html.match(/>Answer</g)?.length).toBe(2);
    expect(html).toContain('Asked 2 days ago');
  });

  it('keeps Answer disabled until something is typed', () => {
    expect(view(GROUPS)).toMatch(/<button[^>]*disabled=""[^>]*>Answer</);
  });

  it('links the title only when the host can open a card', () => {
    expect(view(GROUPS)).not.toContain('fui-Link');
    expect(view(GROUPS, () => {})).toContain('fui-Link');
  });

  it('renders nothing with zero decisions', () => {
    expect(view([])).toBe('');
  });
});
