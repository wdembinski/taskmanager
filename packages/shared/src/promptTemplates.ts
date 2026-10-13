/**
 * Prompt templates — canned briefs a human can drop into the Add-task dialog, the assign
 * prompt, or the chat pane, then edit before sending. Global, like `statusKeywords`: the list
 * lives in `AppSettings` and is the same on every surface, not a per-project or per-card thing.
 *
 * Imports nothing from `settings.ts` on purpose — `settings.ts` imports the type and the
 * defaults FROM here, and the other direction would be a cycle.
 */

/** Where a template may be offered. */
export type PromptTemplateSurface = 'add-task' | 'assign' | 'chat';

/** Every {@link PromptTemplateSurface}, in the order a picker should list them. */
export const PROMPT_TEMPLATE_SURFACES: readonly PromptTemplateSurface[] = [
  'add-task',
  'assign',
  'chat',
] as const;

/** One saved template. */
export interface PromptTemplate {
  /** Stable id — a default's never changes, so a user's own edit to it still applies. */
  id: string;
  name: string;
  /** The raw text, `{{variable}}`s and all — see {@link renderTemplate}. */
  body: string;
  /** Which surfaces offer this template; see {@link templatesFor}. */
  surfaces: PromptTemplateSurface[];
}

/**
 * The three templates a fresh install ships with. `review-only` is deliberately left off
 * `add-task`: there is no card yet to review at that point, so the one surface it would
 * never make sense on is the one it skips.
 */
export const DEFAULT_PROMPT_TEMPLATES: PromptTemplate[] = [
  {
    id: 'default-bug-reproduce-first',
    name: 'Bug: reproduce first',
    body:
      'Reproduce {{title}} ({{key}}) first: write a failing test that captures the bug before ' +
      'touching any implementation code.',
    surfaces: ['add-task', 'assign', 'chat'],
  },
  {
    id: 'default-test-first-feature',
    name: 'Test-first feature',
    body:
      'Implement {{title}} ({{key}}) test-first: write the failing tests first, then the ' +
      'minimal code to make them pass.',
    surfaces: ['add-task', 'assign', 'chat'],
  },
  {
    id: 'default-review-only',
    name: 'Review only — change nothing',
    body: 'Review {{title}} ({{key}}) only. Do not change any code — report findings instead.',
    surfaces: ['assign', 'chat'],
  },
];

/** What {@link renderTemplate} substitutes — only what the caller actually knows yet. */
export interface TemplateVars {
  title?: string;
  key?: string;
  project?: string;
}

const VARIABLE_PATTERN = /\{\{\s*([\w.]+)\s*\}\}/g;

/**
 * Substitute `{{title}}`/`{{key}}`/`{{project}}` in `body` from `vars`.
 *
 * An absent value becomes `''` — the same rule `renderAutomationTemplate` applies to an
 * automation run with no linked ticket — rather than leaving the placeholder, because a
 * template is meant to read as prose once filled in, not as a form with blanks still
 * showing. Any OTHER `{{name}}` (a typo, or a variable this function doesn't know) is left
 * exactly as written, and an unclosed `{{title` is not a match at all, so it is untouched
 * too — both for the reason {@link renderAutomationTemplate} gives: a mistake in a template
 * should be visible, not silently swallowed.
 */
export function renderTemplate(body: string, vars: TemplateVars): string {
  const values: Record<string, string> = {
    title: vars.title ?? '',
    key: vars.key ?? '',
    project: vars.project ?? '',
  };
  return body.replace(VARIABLE_PATTERN, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(values, name) ? values[name] : match,
  );
}

/** Where a rendered template is inserted: a caret, or a range to replace. */
export type TemplateSelection = number | { start: number; end: number };

/**
 * Insert `rendered` into `text` at `selection`, clamped to `[0, text.length]`.
 *
 * `selection` is a bare caret (insert) or a `{ start, end }` range (replace) — the same
 * shape a textarea's own `selectionStart`/`selectionEnd` already come in, so a caller never
 * has to normalize one into the other first. A reversed range (`start > end`, which a
 * backwards drag-select produces) is swapped before anything else runs, and the caret
 * lands just after the inserted text either way — so continuing to type picks up right
 * where the template ended.
 */
export function insertTemplate(
  text: string,
  selection: TemplateSelection,
  rendered: string,
): { text: string; caret: number } {
  const raw = typeof selection === 'number' ? { start: selection, end: selection } : selection;
  const lo = Math.min(raw.start, raw.end);
  const hi = Math.max(raw.start, raw.end);
  const clamp = (n: number): number => Math.max(0, Math.min(n, text.length));
  const start = clamp(lo);
  const end = clamp(hi);
  const next = text.slice(0, start) + rendered + text.slice(end);
  return { text: next, caret: start + rendered.length };
}

/**
 * The templates offered on `surface`, in `templates`' own order.
 *
 * Takes the list as a parameter rather than reading `AppSettings` itself — the list lives
 * in `settings.ts`, and this file imports nothing from there — so a caller with the
 * settings in hand applies it as `templatesFor(settings.promptTemplates, surface)`.
 */
export function templatesFor(
  templates: readonly PromptTemplate[],
  surface: PromptTemplateSurface,
): PromptTemplate[] {
  return templates.filter((t) => t.surfaces.includes(surface));
}
