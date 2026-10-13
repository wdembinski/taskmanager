/**
 * Inserting a {@link PromptTemplate} into a surface (F7.10) — one function per surface, each
 * a thin wrapper around `renderTemplate`/`insertTemplate` from `@tm/shared/promptTemplates`,
 * so add-task, assign and chat can each get their own view-model test without re-deriving the
 * render-then-insert logic three times.
 *
 * Pure, no React: a surface calls the matching `applyTemplate*` with its own text/selection (or
 * `ComposerValue`) and gets back where the result and the caret land.
 */
import type { Project, Task } from '@tm/shared/model';
import {
  insertTemplate,
  renderTemplate,
  type PromptTemplate,
  type TemplateSelection,
  type TemplateVars,
} from '@tm/shared/promptTemplates';
import { shiftMentions, type ComposerValue } from './chat/mentions';

/** Vars for the add-task dialog: there is no card yet, so `key` is always empty. */
export function templateVarsForNewTask(opts: { title: string; projectName: string }): TemplateVars {
  return { title: opts.title, project: opts.projectName };
}

/**
 * Vars for an existing card: `key` prefers the native ticket key, same as
 * `renderAutomationTemplate`'s `{{ticket.key}}`.
 */
export function templateVarsForTask(
  task: Pick<Task, 'title' | 'ticketKey' | 'externalKey'>,
  project: Pick<Project, 'name'> | null,
): TemplateVars {
  return {
    title: task.title,
    key: task.ticketKey ?? task.externalKey ?? undefined,
    project: project?.name,
  };
}

/** Add-task and assign: a plain text field with a caret or selection. */
export function applyTemplateToText(
  text: string,
  selection: TemplateSelection,
  template: PromptTemplate,
  vars: TemplateVars,
): { text: string; caret: number } {
  return insertTemplate(text, selection, renderTemplate(template.body, vars));
}

/**
 * Chat: a `ComposerValue`, so the inserted text must also carry the existing `mentions`
 * across the edit — via `shiftMentions`, the same rule any other composer edit follows — and
 * leave `attachments` alone, since a template never touches what is attached.
 */
export function applyTemplateToComposer(
  value: ComposerValue,
  selection: TemplateSelection,
  template: PromptTemplate,
  vars: TemplateVars,
): { value: ComposerValue; caret: number } {
  const rendered = renderTemplate(template.body, vars);
  const { text, caret } = insertTemplate(value.text, selection, rendered);

  const raw = typeof selection === 'number' ? { start: selection, end: selection } : selection;
  const from = Math.min(raw.start, raw.end);
  const to = Math.max(raw.start, raw.end);
  const mentions = shiftMentions(value.mentions, from, to, rendered.length - (to - from));

  return { value: { ...value, text, mentions }, caret };
}
