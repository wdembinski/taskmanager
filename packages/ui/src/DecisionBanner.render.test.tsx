/**
 * Static-markup coverage for `DecisionBanner` — the hook-free `DecisionBannerView` is driven
 * directly for the question/answer box/buttons/refusal cases, the same way
 * `ArchivedTicketBanner.render.test.tsx` drives its own view; the "nothing for an unflagged
 * card" case goes through the full `DecisionBanner` (it is the one that decides `null`),
 * wrapped in `TransportProvider` with a stub.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Task } from '@tm/shared/model';
import { TransportProvider, type Transport } from './transport';
import { DecisionBanner, DecisionBannerView, RaiseDecisionButton } from './DecisionBanner';

const stubTransport: Transport = {
  invoke: () => Promise.resolve(undefined) as never,
  on: () => () => {},
  pathForFile: () => '',
};

const NOW = new Date(2026, 9, 19, 12, 0, 0).getTime();

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: 't1',
    projectId: 'p1',
    phase: '',
    title: 'Pick a hosting plan',
    status: 'pending',
    sessionId: null,
    order: 0,
    dependsOn: [],
    source: 'ticket',
    isContract: false,
    isScaffold: false,
    ...overrides,
  };
}

function view(overrides: Partial<Parameters<typeof DecisionBannerView>[0]> = {}): string {
  return renderToStaticMarkup(
    <DecisionBannerView
      question="Which hosting plan do we pay for?"
      askedAt={NOW - 2 * 86_400_000}
      now={NOW}
      answer=""
      onAnswerChange={() => {}}
      onAnswer={() => {}}
      onWithdraw={() => {}}
      busy={null}
      error={null}
      {...overrides}
    />,
  );
}

function wrap(node: JSX.Element): string {
  return renderToStaticMarkup(
    <TransportProvider transport={stubTransport}>{node}</TransportProvider>,
  );
}

describe('DecisionBannerView', () => {
  it('shows the question, how long ago it was asked, the answer box and both buttons', () => {
    const html = view();
    expect(html).toContain('data-decision-banner');
    expect(html).toContain('Needs a decision');
    expect(html).toContain('Which hosting plan do we pay for?');
    expect(html).toContain('Asked 2 days ago');
    expect(html).toContain('<textarea');
    expect(html).toContain('aria-label="Your answer"');
    expect(html).toContain('>Answer<');
    expect(html).toContain('>Withdraw<');
  });

  it('keeps Answer disabled until something is typed', () => {
    const empty = view();
    expect(empty).toMatch(/<button[^>]*disabled=""[^>]*>Answer</);
    const typed = view({ answer: 'The yearly one' });
    expect(typed).not.toMatch(/<button[^>]*disabled=""[^>]*>Answer</);
    expect(typed).toContain('The yearly one');
  });

  it('hides the answer box and both buttons on a read-only host', () => {
    const html = view({ onAnswer: undefined, onWithdraw: undefined });
    expect(html).toContain('Which hosting plan do we pay for?');
    expect(html).not.toContain('<textarea');
    expect(html).not.toContain('>Answer<');
    expect(html).not.toContain('>Withdraw<');
  });

  it('shows a refusal inside the same bar', () => {
    const html = view({ error: 'This card has no open decision.' });
    expect(html).toContain('This card has no open decision.');
    expect(html.match(/fui-MessageBar /g)?.length ?? 0).toBeLessThanOrEqual(1);
  });

  it('prints no age line without askedAt', () => {
    expect(view({ askedAt: null })).not.toContain('Asked');
  });

  it('is one line with an Answer button and no answer box when compact', () => {
    const html = view({ compact: true });
    expect(html).toContain('data-decision-banner');
    expect(html).toContain('data-compact');
    expect(html).toContain('Decision needed');
    expect(html).toContain('Which hosting plan do we pay for?');
    expect(html).toContain('>Answer<');
    expect(html).not.toContain('<textarea');
    expect(html).not.toContain('>Withdraw<');
    expect(html).not.toContain('Asked 2 days ago');
    expect(html).not.toContain('fui-MessageBar ');
    // The whole question rides in a `title` too, since the line itself ellipsizes.
    expect(html).toContain('title="Which hosting plan do we pay for?"');
  });

  it('offers a Collapse link once an expanded compact bar is open', () => {
    expect(view({ onCollapse: () => {} })).toContain('>Collapse<');
    expect(view()).not.toContain('>Collapse<');
  });
});

describe('DecisionBanner', () => {
  it('renders nothing for a card with no open decision', () => {
    expect(wrap(<DecisionBanner task={task()} />)).toBe('');
    expect(wrap(<DecisionBanner task={task({ decisionQuestion: null })} />)).toBe('');
  });

  it('renders the banner for a flagged card', () => {
    const html = wrap(
      <DecisionBanner
        task={task({ decisionQuestion: 'Which hosting plan?', decisionAskedAt: Date.now() })}
      />,
    );
    expect(html).toContain('Which hosting plan?');
    expect(html).toContain('Asked today');
    expect(html).toContain('>Answer<');
    expect(html).not.toContain('data-compact');
  });

  it('starts collapsed when compact', () => {
    const html = wrap(
      <DecisionBanner task={task({ decisionQuestion: 'Which hosting plan?' })} compact />,
    );
    expect(html).toContain('data-compact');
    expect(html).toContain('Which hosting plan?');
    expect(html).toContain('>Answer<');
    expect(html).not.toContain('<textarea');
  });
});

describe('RaiseDecisionButton', () => {
  it('offers "Needs a decision…" on an unflagged card', () => {
    expect(wrap(<RaiseDecisionButton task={task()} />)).toContain('Needs a decision…');
  });

  it('is gone while a decision is open', () => {
    expect(wrap(<RaiseDecisionButton task={task({ decisionQuestion: 'Which plan?' })} />)).toBe('');
  });
});
