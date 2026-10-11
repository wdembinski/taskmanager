/**
 * What the board's automation-origin glyph says when you hover it.
 *
 * `task.originAutomationId` only tells the card THAT an automation started it, not which
 * one or when — the name and (for a catch-up firing) the timestamp are resolved separately
 * and handed in as {@link AutomationOrigin}, which is why this is a lookup result rather
 * than something derived from the task alone. Nothing fills that lookup until the
 * automation list reaches the renderer (F1.11/F1.15), so every caller before then gets
 * `null`/`undefined` here and the tooltip falls back to the generic sentence.
 *
 * The catch-up time is rendered with {@link renderAutomationTemplate}'s `{{time}}` — the
 * same formatter the runner's own timeline note (`startedNote` in `automationRunner.ts`)
 * uses — so the card and the note never disagree about what time a skipped firing stands
 * in for, and a bad time zone falls back to UTC the same way in both places.
 *
 * Pure, no React — same shape as `doneSwitchLabel.ts`.
 */
import { renderAutomationTemplate } from '@tm/shared/automationTemplate';

/** What the board knows about the automation that started a card, for the glyph's tooltip. */
export interface AutomationOrigin {
  /** The automation's name, or `null` when it is not known (e.g. the automation was deleted). */
  name: string | null;
  /** The automation's time zone, for rendering a catch-up's wall-clock time. */
  timeZone?: string | null;
  /** `occurrenceAt` of a catch-up firing, epoch ms — `null`/absent outside a catch-up. */
  catchUpAt?: number | null;
}

/** The glyph's tooltip text. `origin` is `null`/`undefined` before the lookup exists. */
export function automationOriginTitle(origin: AutomationOrigin | null | undefined): string {
  const name = origin?.name;
  const started = name ? `Started by ${name}` : 'Started by an automation';
  if (origin?.catchUpAt == null) return started;
  const time = renderAutomationTemplate('{{time}}', {
    automation: { name: name ?? '', timeZone: origin.timeZone ?? 'UTC' },
    at: origin.catchUpAt,
  });
  return `${started} · catch-up for ${time}`;
}
