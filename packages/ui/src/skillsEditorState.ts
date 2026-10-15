/**
 * The Skills settings section's editor state (F7.8) — modelled on
 * `promptTemplatesEditor.ts`'s `saved`/`draft` pair, but widened for a library that is a
 * PICKER (one skill selected at a time, plus a read-only `repo:` entry) rather than a flat
 * list edited in place, and for the two things a single `skill:save` round trip can hand
 * back that a prompt template never does: a `name-taken` clash the human resolves with
 * "Replace", and a whole batch of them from one `skill:import` call.
 *
 * Pure and I/O-free like its model: every op below takes a state and returns a new one (or,
 * for {@link validateDraft}/{@link canSave}/{@link replaceDraft}, reads one without writing).
 * Nothing here calls `skill:save`/`skill:import`/etc itself — that IPC round trip, and
 * turning its answer back into a call to {@link applySaveResult}/{@link applyImportResults},
 * is the section component's job.
 */
import {
  isValidSkillName,
  skillBodyBytes,
  skillTooLargeMessage,
  SKILL_BODY_MAX,
  type RepoSkillDetail,
  type Skill,
  type SkillDraft,
  type SkillImportResult,
  type SkillSaveResult,
} from '@tm/shared/skills';

/** What the editor is showing: one library skill by id, a blank draft for a brand-new one,
 *  or a read-only repo skill (`projectId` + `name`, never a library id) — never a selection
 *  with no target, which is what `null` on {@link SkillsEditorState.selection} means instead. */
export type SkillSelection =
  | { kind: 'library'; id: string }
  | { kind: 'new' }
  | { kind: 'repo'; projectId: string; name: string };

/** A switch the human asked for while {@link SkillsEditorState.draft} was dirty — held here
 *  instead of applied immediately, so the section can show a discard-confirm and let
 *  {@link confirmPendingSelection}/{@link cancelPendingSelection} decide what happens next. */
export interface PendingSelection {
  target: SkillSelection;
}

/** A `name-taken` refusal on save, or on one `skill:import` candidate walked out of
 *  {@link SkillsEditorState.importQueue} — either way the human's only ways out are
 *  {@link replaceDraft} (overwrite `existing`) or {@link dismissClash}/{@link skipImportClash}
 *  (leave `existing` alone). */
export interface SkillClash {
  draft: SkillDraft;
  existing: Skill;
  message: string;
}

export interface SkillsEditorState {
  /** Every library skill, as of the last {@link openSkillsEditor}/{@link reloadLibrary} or
   *  a save/import/delete this state applied itself. */
  library: Skill[];
  selection: SkillSelection | null;
  /** `draft` as of the last time it was clean — `null` exactly when `draft` is (no
   *  selection, or the selection is a read-only `repo:` entry). */
  baseline: SkillDraft | null;
  /** What the open selection's editor fields hold right now; diverges from `baseline` until
   *  a save or {@link discardDraft} settles it. `null` for no selection and for a `repo:`
   *  selection — a repo skill is viewed, not edited, until {@link copyRepoToLibrary} opens
   *  one. */
  draft: SkillDraft | null;
  pendingSelection: PendingSelection | null;
  clash: SkillClash | null;
  /** Clashes from the most recent `skill:import` batch not yet walked by
   *  {@link nextImportReplace}/{@link skipImportClash}, in the order the batch produced
   *  them. */
  importQueue: SkillImportResult[];
  /** Import summaries, warnings and refusals, oldest first — never cleared by this module,
   *  since there is no "this notice was read" signal to clear it on. */
  notices: string[];
}

function blankDraft(): SkillDraft {
  return { name: '', description: '', body: '' };
}

function cloneDraft(draft: SkillDraft): SkillDraft {
  return { ...draft };
}

function draftFromSkill(skill: Skill): SkillDraft {
  return { id: skill.id, name: skill.name, description: skill.description, body: skill.body };
}

function sameDraft(a: SkillDraft, b: SkillDraft): boolean {
  return a.id === b.id && a.name === b.name && a.description === b.description && a.body === b.body;
}

function upsertSkill(library: readonly Skill[], skill: Skill): Skill[] {
  const index = library.findIndex((s) => s.id === skill.id);
  if (index === -1) return [...library, skill];
  const next = [...library];
  next[index] = skill;
  return next;
}

function findByName(library: readonly Skill[], name: string): Skill | undefined {
  return library.find((s) => s.name === name);
}

/** Opens the editor on `library`, with nothing selected. */
export function openSkillsEditor(library: readonly Skill[]): SkillsEditorState {
  return {
    library: [...library],
    selection: null,
    baseline: null,
    draft: null,
    pendingSelection: null,
    clash: null,
    importQueue: [],
    notices: [],
  };
}

/** Replaces `library` wholesale — the section's answer to a `task:changed`-style refresh.
 *  Leaves the open selection/draft/clash/queue/notices untouched. */
export function reloadLibrary(
  state: SkillsEditorState,
  library: readonly Skill[],
): SkillsEditorState {
  return { ...state, library: [...library] };
}

function draftsForTarget(
  target: SkillSelection,
  library: readonly Skill[],
): { baseline: SkillDraft | null; draft: SkillDraft | null } {
  if (target.kind === 'new') {
    const blank = blankDraft();
    return { baseline: cloneDraft(blank), draft: cloneDraft(blank) };
  }
  if (target.kind === 'library') {
    const skill = library.find((s) => s.id === target.id);
    if (!skill) return { baseline: null, draft: null };
    const draft = draftFromSkill(skill);
    return { baseline: cloneDraft(draft), draft: cloneDraft(draft) };
  }
  return { baseline: null, draft: null };
}

function applySelection(state: SkillsEditorState, target: SkillSelection): SkillsEditorState {
  const { baseline, draft } = draftsForTarget(target, state.library);
  return { ...state, selection: target, baseline, draft, pendingSelection: null, clash: null };
}

function switchSelection(state: SkillsEditorState, target: SkillSelection): SkillsEditorState {
  if (isDirty(state)) return { ...state, pendingSelection: { target } };
  return applySelection(state, target);
}

/** Selects library skill `id`; asks for a discard confirm first if the open draft is dirty. */
export function selectLibrary(state: SkillsEditorState, id: string): SkillsEditorState {
  return switchSelection(state, { kind: 'library', id });
}

/** Selects repo skill `name` under `projectId` (read-only — see
 *  {@link SkillsEditorState.draft}); asks for a discard confirm first if the open draft is
 *  dirty. */
export function selectRepo(
  state: SkillsEditorState,
  projectId: string,
  name: string,
): SkillsEditorState {
  return switchSelection(state, { kind: 'repo', projectId, name });
}

/** Opens a blank draft for a brand-new skill; asks for a discard confirm first if the open
 *  draft is dirty. */
export function startNew(state: SkillsEditorState): SkillsEditorState {
  return switchSelection(state, { kind: 'new' });
}

/** Applies the switch {@link PendingSelection} was holding; a no-op if there is none. */
export function confirmPendingSelection(state: SkillsEditorState): SkillsEditorState {
  if (!state.pendingSelection) return state;
  return applySelection(state, state.pendingSelection.target);
}

/** Drops the pending switch, leaving the current selection/draft exactly as they were. */
export function cancelPendingSelection(state: SkillsEditorState): SkillsEditorState {
  if (!state.pendingSelection) return state;
  return { ...state, pendingSelection: null };
}

/** Patches `name`/`description`/`body` on the open draft; a no-op with no draft open (no
 *  selection, or a read-only `repo:` one). */
export function editDraft(
  state: SkillsEditorState,
  patch: Partial<Pick<SkillDraft, 'name' | 'description' | 'body'>>,
): SkillsEditorState {
  if (!state.draft) return state;
  return { ...state, draft: { ...state.draft, ...patch } };
}

/** Restores the open draft to a fresh copy of `baseline`. */
export function discardDraft(state: SkillsEditorState): SkillsEditorState {
  if (!state.baseline) return state;
  return { ...state, draft: cloneDraft(state.baseline) };
}

/** Whether `draft` differs from `baseline` — `false` whenever either is `null` (no draft
 *  open has nothing to be dirty about). */
export function isDirty(state: SkillsEditorState): boolean {
  if (!state.draft || !state.baseline) return false;
  return !sameDraft(state.draft, state.baseline);
}

/**
 * Every rule the section enforces on `draft` before it offers Save, as human-readable
 * messages keyed by field (`name`/`body`) — a field with no error is absent from the result.
 *
 * The duplicate-name check only fires for an EXISTING skill's edit (`draft.id` set):
 * renaming it to collide with some other library skill is just invalid, since there is no
 * other skill here to "replace". A brand-new draft (or an edit left at its own name) sharing
 * a name with an existing skill is not flagged here — that is what `skill:save`'s
 * `'name-taken'` answer and {@link applySaveResult}'s `clash` are for, since there the human
 * may actually want to replace the other skill.
 */
export function validateDraft(
  draft: SkillDraft,
  library: readonly Skill[],
): Record<'name' | 'body', string> {
  const errors: Partial<Record<'name' | 'body', string>> = {};

  if (!isValidSkillName(draft.name)) {
    errors.name =
      'Skill names must be lower-case letters, numbers and hyphens, 1 to 64 characters.';
  } else if (draft.id) {
    const clash = library.find((s) => s.name === draft.name && s.id !== draft.id);
    if (clash) errors.name = `A skill named "${draft.name}" already exists.`;
  }

  if (!draft.body.trim()) {
    errors.body = 'Body is required.';
  } else {
    const bytes = skillBodyBytes(draft.body);
    if (bytes > SKILL_BODY_MAX) errors.body = skillTooLargeMessage(bytes);
  }

  return errors as Record<'name' | 'body', string>;
}

/** Whether Save should be enabled: a draft is open, it differs from `baseline`, and
 *  {@link validateDraft} finds nothing wrong with it. */
export function canSave(state: SkillsEditorState): boolean {
  if (!state.draft || !isDirty(state)) return false;
  return Object.keys(validateDraft(state.draft, state.library)).length === 0;
}

/**
 * Folds a `skill:save` answer back into the state. `ok` upserts the saved skill into
 * `library`, re-baselines the draft from it (so Save immediately goes clean), and points
 * `selection` at its id — the way a brand-new draft's selection becomes a library one the
 * moment it is first saved. `'name-taken'` sets {@link SkillsEditorState.clash} (looking
 * `existing` up in `library` by name, since the result itself does not carry it). Any other
 * refusal becomes a notice instead — there is nothing for the human to resolve beyond reading
 * why.
 */
export function applySaveResult(
  state: SkillsEditorState,
  result: SkillSaveResult,
): SkillsEditorState {
  if (result.ok) {
    const draft = draftFromSkill(result.skill);
    return {
      ...state,
      library: upsertSkill(state.library, result.skill),
      selection: { kind: 'library', id: result.skill.id },
      baseline: cloneDraft(draft),
      draft: cloneDraft(draft),
      pendingSelection: null,
      clash: null,
    };
  }

  if (result.reason === 'name-taken' && state.draft) {
    const existing = findByName(state.library, state.draft.name);
    if (existing) {
      return {
        ...state,
        clash: { draft: cloneDraft(state.draft), existing, message: result.message },
      };
    }
  }

  return { ...state, notices: [...state.notices, result.message] };
}

/** The draft to hand `skill:save` to resolve `clash` by overwriting `existing` — same
 *  fields, carrying `existing.id` so the handler edits it in place instead of minting a new
 *  skill. Does not itself clear `clash`; a save that comes back `ok` does that through
 *  {@link applySaveResult}. */
export function replaceDraft(state: SkillsEditorState): SkillDraft | null {
  if (!state.clash) return null;
  return { ...state.clash.draft, id: state.clash.existing.id };
}

/** Drops `clash` without replacing or saving anything. */
export function dismissClash(state: SkillsEditorState): SkillsEditorState {
  if (!state.clash) return state;
  return { ...state, clash: null };
}

/** Opens a new draft pre-filled from a repo skill's full body — F7.8's "Copy to library".
 *  The draft starts clean (its own content IS the baseline), same as {@link startNew}'s
 *  blank one; it only goes dirty once the human edits it further. */
export function copyRepoToLibrary(
  state: SkillsEditorState,
  repoSkill: RepoSkillDetail,
): SkillsEditorState {
  const draft: SkillDraft = {
    name: repoSkill.name,
    description: repoSkill.description,
    body: repoSkill.body,
  };
  return {
    ...state,
    selection: { kind: 'new' },
    baseline: cloneDraft(draft),
    draft: cloneDraft(draft),
    pendingSelection: null,
    clash: null,
  };
}

/**
 * Folds a `skill:import` batch back into the state: an `'imported'` candidate is upserted
 * into `library` with a notice (plus one more notice per parse warning it carried); a
 * `'clash'` candidate is queued onto {@link SkillsEditorState.importQueue} rather than
 * resolved here, since replacing `existing` is the human's call; a `'refused'` candidate
 * becomes a notice. Notices and queued clashes both append to whatever this state already
 * held, so folding in a second batch never loses the first one's leftovers.
 */
export function applyImportResults(
  state: SkillsEditorState,
  results: readonly SkillImportResult[],
): SkillsEditorState {
  let library = state.library;
  const notices: string[] = [];
  const importQueue = [...state.importQueue];

  for (const result of results) {
    if (result.status === 'imported') {
      library = upsertSkill(library, result.skill);
      notices.push(`Imported "${result.skill.name}".`);
      for (const warning of result.warnings) notices.push(`"${result.skill.name}": ${warning}`);
    } else if (result.status === 'clash') {
      importQueue.push(result);
    } else {
      notices.push(result.message);
    }
  }

  return { ...state, library, importQueue, notices: [...state.notices, ...notices] };
}

/**
 * Walks the head clash off {@link SkillsEditorState.importQueue} and opens it as an editable
 * draft against `existing.id` — dirty from the moment it opens, since the candidate's
 * content is what the human is choosing to replace `existing` with, so the section's normal
 * Save (`canSave` → `skill:save(draft)` → {@link applySaveResult}) carries it the rest of the
 * way. A no-op if the queue is empty.
 */
export function nextImportReplace(state: SkillsEditorState): SkillsEditorState {
  const [head, ...rest] = state.importQueue;
  if (!head || head.status !== 'clash') return state;

  const draft: SkillDraft = { id: head.existing.id, ...head.candidate };
  return {
    ...state,
    importQueue: rest,
    selection: { kind: 'library', id: head.existing.id },
    baseline: cloneDraft(draftFromSkill(head.existing)),
    draft: cloneDraft(draft),
    pendingSelection: null,
    clash: null,
  };
}

/** Drops the head clash off {@link SkillsEditorState.importQueue} without touching
 *  `library`, leaving a notice behind. A no-op if the queue is empty. */
export function skipImportClash(state: SkillsEditorState): SkillsEditorState {
  const [head, ...rest] = state.importQueue;
  if (!head || head.status !== 'clash') return state;
  return {
    ...state,
    importQueue: rest,
    notices: [...state.notices, `Skipped "${head.candidate.name}": already exists.`],
  };
}

/** Removes skill `id` from `library`, clearing the open selection/draft/clash if `id` was
 *  the one selected. */
export function applyDelete(state: SkillsEditorState, id: string): SkillsEditorState {
  const library = state.library.filter((s) => s.id !== id);
  const wasSelected = state.selection?.kind === 'library' && state.selection.id === id;
  if (!wasSelected) return { ...state, library };
  return {
    ...state,
    library,
    selection: null,
    baseline: null,
    draft: null,
    pendingSelection: null,
    clash: null,
  };
}
