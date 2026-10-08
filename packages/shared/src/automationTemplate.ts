/**
 * `{{variable}}` substitution for a card an automation creates.
 *
 * An automation's title and brief are written once, at design time, before anyone knows
 * which ticket will be linked or when the rule will actually fire. The template is how
 * that gap is bridged: six variables stand in for the things only known at fire time —
 * the automation's own name, the moment it fired (in ITS time zone, not the machine's),
 * and the ticket it was triggered for, when there is one.
 *
 * Pure and total: no React, no Electron, no DB, no clock of its own. The caller supplies
 * `at` (so a scheduled run and a "preview this now" render identically) and the ticket
 * (so a schedule firing with no ticket and a tracker-triggered automation share one
 * code path rather than two).
 */

import type { Task } from './model';

/** One substitutable variable, for the editor's palette and live preview (F1.14). */
export interface TemplateVariable {
  readonly name: string;
  readonly description: string;
}

/**
 * Every name {@link renderAutomationTemplate} resolves. Order is the order the editor
 * lists them in.
 */
export const TEMPLATE_VARIABLES: readonly TemplateVariable[] = [
  { name: 'automation.name', description: 'The name of the automation that fired this run.' },
  { name: 'date', description: "Today's date in the automation's time zone (YYYY-MM-DD)." },
  { name: 'time', description: "The current time in the automation's time zone (24-hour HH:mm)." },
  { name: 'ticket.title', description: "The linked ticket's title, or empty when there is none." },
  { name: 'ticket.key', description: "The linked ticket's key, or empty when there is none." },
  {
    name: 'ticket.url',
    description: "The linked ticket's deep link, or empty when there is none.",
  },
] as const;

/** Everything {@link renderAutomationTemplate} reads. */
export interface TemplateContext {
  automation: { name: string; timeZone: string };
  /** The instant the automation fired, epoch ms — so a preview and a real run agree. */
  at: number;
  /** The ticket this run was triggered for or linked to, or null/absent when there is none. */
  ticket?: Pick<Task, 'title' | 'externalKey' | 'externalUrl' | 'ticketKey'> | null;
}

const VARIABLE_PATTERN = /\{\{\s*([\w.]+)\s*\}\}/g;

/** `date`/`time` parts of `at`, read out in `timeZone`. */
function wallClockParts(at: number, timeZone: string): { date: string; time: string } {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts = Object.fromEntries(
    formatter.formatToParts(new Date(at)).map((p) => [p.type, p.value]),
  );
  // Some ICU builds render midnight as "24:00" rather than "00:00" under hour12: false.
  const hour = parts.hour === '24' ? '00' : parts.hour;
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${hour}:${parts.minute}` };
}

/**
 * `date`/`time` for `at` in `timeZone`, falling back to UTC when `timeZone` is not one
 * `Intl` recognizes — a typo in a time zone name must not break every template that uses
 * `{{date}}` or `{{time}}`.
 */
function wallClock(at: number, timeZone: string): { date: string; time: string } {
  try {
    return wallClockParts(at, timeZone);
  } catch (err) {
    if (err instanceof RangeError) return wallClockParts(at, 'UTC');
    throw err;
  }
}

/**
 * Substitute every `{{variable}}` in `template` with its value from `ctx`.
 *
 * Unknown variables (`{{nope}}`, `{{ticket.nope}}`) are left exactly as written rather
 * than blanked — a typo in a template should be visible, not silently swallowed. An
 * unclosed `{{date` is not a match at all, so it is untouched for the same reason the
 * regex requires a closing `}}`.
 */
export function renderAutomationTemplate(template: string, ctx: TemplateContext): string {
  const { date, time } = wallClock(ctx.at, ctx.automation.timeZone);
  const ticket = ctx.ticket ?? null;
  const values: Record<string, string> = {
    'automation.name': ctx.automation.name,
    date,
    time,
    'ticket.title': ticket?.title ?? '',
    'ticket.key': ticket?.ticketKey ?? ticket?.externalKey ?? '',
    'ticket.url': ticket?.externalUrl ?? '',
  };
  return template.replace(VARIABLE_PATTERN, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(values, name) ? values[name] : match,
  );
}
