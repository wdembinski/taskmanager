import { describe, expect, it } from 'vitest';
import type { Task } from './model';
import {
  renderAutomationTemplate,
  TEMPLATE_VARIABLES,
  type TemplateContext,
} from './automationTemplate';

const AT = new Date('2026-03-15T23:30:00.000Z').getTime();

const SCHEDULE_CTX: TemplateContext = {
  automation: { name: 'Nightly triage', timeZone: 'UTC' },
  at: AT,
  ticket: null,
};

const TRACKER_TICKET: Pick<Task, 'title' | 'externalKey' | 'externalUrl' | 'ticketKey'> = {
  title: 'Fix the login redirect',
  externalKey: 'ABC-123',
  externalUrl: 'https://example.atlassian.net/browse/ABC-123',
  ticketKey: null,
};

const TRACKER_CTX: TemplateContext = {
  automation: { name: 'JIRA sync', timeZone: 'UTC' },
  at: AT,
  ticket: TRACKER_TICKET,
};

describe('TEMPLATE_VARIABLES', () => {
  it('lists six variables, each with a description', () => {
    expect(TEMPLATE_VARIABLES).toHaveLength(6);
    for (const v of TEMPLATE_VARIABLES) {
      expect(v.name.length).toBeGreaterThan(0);
      expect(v.description.length).toBeGreaterThan(0);
    }
  });
});

describe('renderAutomationTemplate', () => {
  it.each([
    ['{{automation.name}}', SCHEDULE_CTX, 'Nightly triage'],
    ['{{date}}', SCHEDULE_CTX, '2026-03-15'],
    ['{{time}}', SCHEDULE_CTX, '23:30'],
    ['{{ticket.title}}', SCHEDULE_CTX, ''],
    ['{{ticket.key}}', SCHEDULE_CTX, ''],
    ['{{ticket.url}}', SCHEDULE_CTX, ''],
    ['{{automation.name}}', TRACKER_CTX, 'JIRA sync'],
    ['{{date}}', TRACKER_CTX, '2026-03-15'],
    ['{{time}}', TRACKER_CTX, '23:30'],
    ['{{ticket.title}}', TRACKER_CTX, 'Fix the login redirect'],
    ['{{ticket.key}}', TRACKER_CTX, 'ABC-123'],
    ['{{ticket.url}}', TRACKER_CTX, 'https://example.atlassian.net/browse/ABC-123'],
  ])('renders %s (%#)', (template, ctx, expected) => {
    expect(renderAutomationTemplate(template, ctx)).toBe(expected);
  });

  it.each([
    ['Europe/Warsaw', '2026-03-16', '00:30'],
    ['America/Los_Angeles', '2026-03-15', '16:30'],
  ])('reads date/time in the automation zone %s', (timeZone, date, time) => {
    const ctx: TemplateContext = { automation: { name: 'x', timeZone }, at: AT, ticket: null };
    expect(renderAutomationTemplate('{{date}} {{time}}', ctx)).toBe(`${date} ${time}`);
  });

  it('renders ticket variables as empty on a schedule firing with no ticket', () => {
    expect(
      renderAutomationTemplate('[{{ticket.title}}][{{ticket.key}}][{{ticket.url}}]', SCHEDULE_CTX),
    ).toBe('[][][]');
  });

  it('renders ticket.url as empty when the ticket has a null externalUrl', () => {
    const ctx: TemplateContext = {
      ...TRACKER_CTX,
      ticket: { ...TRACKER_TICKET, externalUrl: null },
    };
    expect(renderAutomationTemplate('{{ticket.url}}', ctx)).toBe('');
  });

  it('prefers ticketKey over externalKey for {{ticket.key}}', () => {
    const ctx: TemplateContext = {
      ...TRACKER_CTX,
      ticket: { ...TRACKER_TICKET, ticketKey: 'TM-7', externalKey: 'ABC-123' },
    };
    expect(renderAutomationTemplate('{{ticket.key}}', ctx)).toBe('TM-7');
  });

  it('leaves an unknown variable verbatim rather than blanking it', () => {
    expect(renderAutomationTemplate('{{nope}}', SCHEDULE_CTX)).toBe('{{nope}}');
  });

  it('leaves an unknown dotted variable verbatim', () => {
    expect(renderAutomationTemplate('{{ticket.nope}}', TRACKER_CTX)).toBe('{{ticket.nope}}');
  });

  it('leaves an unclosed variable untouched', () => {
    expect(renderAutomationTemplate('{{date', SCHEDULE_CTX)).toBe('{{date');
  });

  it('accepts the whitespace form {{ date }}', () => {
    expect(renderAutomationTemplate('{{ date }}', SCHEDULE_CTX)).toBe('2026-03-15');
  });

  it('replaces every occurrence of a repeated variable', () => {
    expect(renderAutomationTemplate('{{date}} / {{date}} / {{date}}', SCHEDULE_CTX)).toBe(
      '2026-03-15 / 2026-03-15 / 2026-03-15',
    );
  });

  it('falls back to UTC when the time zone is not one Intl recognizes', () => {
    const ctx: TemplateContext = {
      automation: { name: 'x', timeZone: 'Not/AZone' },
      at: AT,
      ticket: null,
    };
    expect(renderAutomationTemplate('{{date}} {{time}}', ctx)).toBe('2026-03-15 23:30');
  });
});
