/**
 * The Prompt templates settings section's editor state (F7.10) — a pure `saved`/`draft` pair
 * so the section can let a human reorder, edit, and toggle surfaces freely, then either Save
 * or discard, without ever mutating `AppSettings.promptTemplates` until Save actually commits.
 *
 * Every op below returns a NEW `draft` (or, for {@link markSaved}, a new `saved`) built from
 * deep clones of {@link PromptTemplate} — a template's own `surfaces` array is never shared
 * between `saved` and `draft`, or between either of those and {@link DEFAULT_PROMPT_TEMPLATES},
 * so toggling a surface on a draft template can never be observed from anywhere else.
 */
import {
  DEFAULT_PROMPT_TEMPLATES,
  PROMPT_TEMPLATE_SURFACES,
  type PromptTemplate,
  type PromptTemplateSurface,
} from '@tm/shared/promptTemplates';

export interface PromptTemplatesEditor {
  /** What `AppSettings.promptTemplates` holds as of the last {@link markSaved}. */
  saved: PromptTemplate[];
  /** What the section is showing right now; diverges from `saved` until Save or discard. */
  draft: PromptTemplate[];
}

function cloneTemplate(template: PromptTemplate): PromptTemplate {
  return { ...template, surfaces: [...template.surfaces] };
}

function cloneTemplates(templates: readonly PromptTemplate[]): PromptTemplate[] {
  return templates.map(cloneTemplate);
}

/** Opens the editor on `saved`; `draft` starts as an independent copy of it. */
export function openEditor(saved: readonly PromptTemplate[]): PromptTemplatesEditor {
  return { saved: cloneTemplates(saved), draft: cloneTemplates(saved) };
}

/** Patches the `name`/`body` of the draft template `id`; see {@link toggleSurface} for surfaces. */
export function editTemplate(
  state: PromptTemplatesEditor,
  id: string,
  patch: Partial<Pick<PromptTemplate, 'name' | 'body'>>,
): PromptTemplatesEditor {
  return {
    ...state,
    draft: state.draft.map((t) => (t.id === id ? { ...t, ...patch } : t)),
  };
}

/** Adds `surface` to the draft template `id` if it is missing, removes it otherwise. */
export function toggleSurface(
  state: PromptTemplatesEditor,
  id: string,
  surface: PromptTemplateSurface,
): PromptTemplatesEditor {
  return {
    ...state,
    draft: state.draft.map((t) => {
      if (t.id !== id) return t;
      const surfaces = t.surfaces.includes(surface)
        ? t.surfaces.filter((s) => s !== surface)
        : PROMPT_TEMPLATE_SURFACES.filter((s) => s === surface || t.surfaces.includes(s));
      return { ...t, surfaces };
    }),
  };
}

/** Appends a blank template — empty name and body, every surface — with id `newId`. */
export function addTemplate(state: PromptTemplatesEditor, newId: string): PromptTemplatesEditor {
  const blank: PromptTemplate = {
    id: newId,
    name: '',
    body: '',
    surfaces: [...PROMPT_TEMPLATE_SURFACES],
  };
  return { ...state, draft: [...state.draft, blank] };
}

/** Removes the draft template `id`. */
export function removeTemplate(state: PromptTemplatesEditor, id: string): PromptTemplatesEditor {
  return { ...state, draft: state.draft.filter((t) => t.id !== id) };
}

/** Moves the draft template `id` one slot earlier (`-1`) or later (`1`); a no-op at either end. */
export function moveTemplate(
  state: PromptTemplatesEditor,
  id: string,
  direction: -1 | 1,
): PromptTemplatesEditor {
  const index = state.draft.findIndex((t) => t.id === id);
  if (index === -1) return state;
  const target = index + direction;
  if (target < 0 || target >= state.draft.length) return state;

  const draft = [...state.draft];
  [draft[index], draft[target]] = [draft[target], draft[index]];
  return { ...state, draft };
}

/** Replaces `draft` with a fresh copy of {@link DEFAULT_PROMPT_TEMPLATES}; `saved` still needs Save. */
export function resetToDefaults(state: PromptTemplatesEditor): PromptTemplatesEditor {
  return { ...state, draft: cloneTemplates(DEFAULT_PROMPT_TEMPLATES) };
}

/** Throws away draft edits, restoring `draft` to a fresh copy of `saved`. */
export function discard(state: PromptTemplatesEditor): PromptTemplatesEditor {
  return { ...state, draft: cloneTemplates(state.saved) };
}

/** Commits `draft` as the new `saved`, each as independent copies. */
export function markSaved(state: PromptTemplatesEditor): PromptTemplatesEditor {
  return { saved: cloneTemplates(state.draft), draft: cloneTemplates(state.draft) };
}

function sameTemplate(a: PromptTemplate, b: PromptTemplate): boolean {
  return (
    a.id === b.id &&
    a.name === b.name &&
    a.body === b.body &&
    a.surfaces.length === b.surfaces.length &&
    a.surfaces.every((s, i) => s === b.surfaces[i])
  );
}

/** Whether `draft` differs from `saved` — order-sensitive, on both the list and each template. */
export function isDirty(state: PromptTemplatesEditor): boolean {
  if (state.saved.length !== state.draft.length) return true;
  return state.saved.some((t, i) => !sameTemplate(t, state.draft[i]));
}

/**
 * Every rule the section enforces, as human-readable messages keyed by template id — an id
 * with no errors is absent from the result, so `Object.keys(validateTemplates(draft)).length`
 * is the at-a-glance "is any of this invalid" check. Checked per-draft-array call (not
 * incrementally) since a duplicate name only exists in relation to the OTHER templates in the
 * same draft.
 */
export function validateTemplates(draft: readonly PromptTemplate[]): Record<string, string[]> {
  const nameCounts = new Map<string, number>();
  for (const t of draft) {
    const key = t.name.trim().toLowerCase();
    if (!key) continue;
    nameCounts.set(key, (nameCounts.get(key) ?? 0) + 1);
  }

  const errors: Record<string, string[]> = {};
  for (const t of draft) {
    const issues: string[] = [];
    if (!t.name.trim()) issues.push('Name is required.');
    if (!t.body.trim()) issues.push('Body is required.');
    if (t.surfaces.length === 0) issues.push('At least one surface is required.');
    const key = t.name.trim().toLowerCase();
    if (key && (nameCounts.get(key) ?? 0) > 1) {
      issues.push('Name is already used by another template.');
    }
    if (issues.length > 0) errors[t.id] = issues;
  }
  return errors;
}

/** Whether Save should be enabled: there is something to save, and none of it is invalid. */
export function canSave(state: PromptTemplatesEditor): boolean {
  return isDirty(state) && Object.keys(validateTemplates(state.draft)).length === 0;
}
