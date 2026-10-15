/**
 * The Workflow Builder settings screen's editor state (F8.9) — modelled on
 * `skillsEditorState.ts`'s `library`/`baseline`/`draft` triple, but widened for a
 * document that is an ORDERED LIST OF STEPS rather than a flat name/description/body,
 * and for the one thing a workflow step can do that a skill never needs to: point at
 * an EARLIER step by id (`GateStep.onFail.retryFrom`), which a reorder or a removal can
 * leave dangling.
 *
 * That dangling-ref case is the module's one hard rule: nothing here ever rewrites or
 * drops a `retryFrom` on a step's behalf. {@link moveStep}/{@link removeStep} only ever
 * touch the array they're asked to touch; a `retryFrom` that stops resolving to an
 * earlier agent step is left exactly as it was and surfaced through
 * {@link workflowIssues}/{@link stepIssues} instead, same as any other bad document
 * `validateWorkflow` (`@tm/shared/workflow`) would flag.
 *
 * Pure and I/O-free like its model: every op below takes a state and returns a new one.
 * Nothing here calls `workflow:save`/`workflow:import`/etc itself — that IPC round trip,
 * and turning its answer back into a call to {@link applySaveResult}/
 * {@link applyImportResult}, is the section component's job.
 */
import {
  isAgentStep,
  isGateStep,
  validateWorkflow,
  type AgentStep,
  type GateOnFail,
  type GateStep,
  type WorkflowDoc,
  type WorkflowDraft,
  type WorkflowImportResult,
  type WorkflowSaveResult,
  type WorkflowStep,
} from '@tm/shared/workflow';
import type { ClaudeModel, PermissionMode } from '@tm/shared/session';

/** What the editor is showing: one library workflow by id, or a blank/imported/duplicated
 *  draft with no id of its own yet — never a selection with no target, which is what
 *  `null` on {@link WorkflowBuilderState.selection} means instead. */
export type WorkflowSelection = { kind: 'library'; id: string } | { kind: 'new' };

/** What a {@link PendingSelection} resumes once confirmed: either a plain switch to
 *  another selection, or re-running {@link duplicateWorkflow} against `id` — both need
 *  to wait behind the same dirty-draft confirm, but a duplicate mints its draft from the
 *  CURRENT library state at confirm time, not from whatever it looked like when the
 *  human first asked. */
export type PendingSelectionTarget =
  | { kind: 'select'; selection: WorkflowSelection }
  | { kind: 'duplicate'; id: string };

/** A switch the human asked for while {@link WorkflowBuilderState.draft} was dirty — held
 *  here instead of applied immediately, so the section can show a discard-confirm and let
 *  {@link confirmPendingSelection}/{@link cancelPendingSelection} decide what happens next. */
export interface PendingSelection {
  target: PendingSelectionTarget;
}

export interface WorkflowBuilderState {
  /** Every library workflow, as of the last {@link openWorkflowBuilder}/
   *  {@link reloadLibrary} or a save/import/delete this state applied itself. */
  library: WorkflowDoc[];
  selection: WorkflowSelection | null;
  /** `draft` as of the last time it was clean — `null` exactly when `draft` is. */
  baseline: WorkflowDraft | null;
  /** What the open selection's editor fields hold right now; diverges from `baseline`
   *  until a save or {@link discardDraft} settles it. */
  draft: WorkflowDraft | null;
  pendingSelection: PendingSelection | null;
  /** The raw text of each gate step's retry-on-codes box, keyed by step id — kept apart
   *  from the parsed `number[]` that actually lands in `draft` so a half-typed value like
   *  `"1, 2,"` can sit in the box without being reformatted out from under the human on
   *  every keystroke. Only has entries for gate steps currently in `draft`. */
  retryOnText: Record<string, string>;
  /** The issues from the most recent `workflow:import`/{@link importFromText} refusal,
   *  or `null` once {@link dismissImportIssues} or a later import clears them. */
  importIssues: string[] | null;
  /** Import summaries and other notices, oldest first — never cleared by this module,
   *  since there is no "this notice was read" signal to clear it on. */
  notices: string[];
}

function cloneSteps(steps: readonly WorkflowStep[]): WorkflowStep[] {
  return JSON.parse(JSON.stringify(steps)) as WorkflowStep[];
}

function cloneDraft(draft: WorkflowDraft): WorkflowDraft {
  return { ...draft, steps: cloneSteps(draft.steps) };
}

function draftFromDoc(doc: WorkflowDoc): WorkflowDraft {
  return { version: 1, id: doc.id, name: doc.name, steps: cloneSteps(doc.steps) };
}

function blankAgentStep(id: string): AgentStep {
  return { id, kind: 'agent', title: '', brief: '' };
}

function blankDraft(): WorkflowDraft {
  return { version: 1, name: '', steps: [blankAgentStep(nextStepId([], 'agent'))] };
}

function retryOnTextFromCodes(codes: number[] | undefined): string {
  return codes && codes.length > 0 ? codes.join(', ') : '';
}

function retryOnTextFor(draft: WorkflowDraft): Record<string, string> {
  const text: Record<string, string> = {};
  for (const step of draft.steps) {
    if (isGateStep(step)) text[step.id] = retryOnTextFromCodes(step.onFail?.retryOn);
  }
  return text;
}

function upsertWorkflow(library: readonly WorkflowDoc[], doc: WorkflowDoc): WorkflowDoc[] {
  const index = library.findIndex((w) => w.id === doc.id);
  if (index === -1) return [...library, doc];
  const next = [...library];
  next[index] = doc;
  return next;
}

/**
 * The next free step id for a step of `kind`, as `"<kind>-<n>"`, starting from
 * `steps.length + 1` and counting up past any id already in `steps` — so an empty
 * workflow's first two `addStep` calls give `agent-1` then `gate-2` regardless of which
 * kinds they are, but a collision (an import with hand-picked ids, or a step removed and
 * re-added) can never mint a duplicate. Pure: never mutates `steps`.
 */
export function nextStepId(steps: readonly WorkflowStep[], kind: WorkflowStep['kind']): string {
  const existing = new Set(steps.map((s) => s.id));
  let n = steps.length + 1;
  let id = `${kind}-${n}`;
  while (existing.has(id)) {
    n += 1;
    id = `${kind}-${n}`;
  }
  return id;
}

function withOptional<T extends object, K extends keyof T>(obj: T, key: K, value: T[K] | null): T {
  if (value === null) {
    const next = { ...obj };
    delete next[key];
    return next;
  }
  return { ...obj, [key]: value };
}

function moveItem<T>(items: readonly T[], from: number, to: number): T[] {
  if (from < 0 || from >= items.length || to < 0 || to >= items.length) return [...items];
  const next = [...items];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

function updateStep(
  state: WorkflowBuilderState,
  id: string,
  fn: (step: WorkflowStep) => WorkflowStep,
): WorkflowBuilderState {
  if (!state.draft) return state;
  const steps = state.draft.steps.map((step) => (step.id === id ? fn(step) : step));
  return { ...state, draft: { ...state.draft, steps } };
}

/** Opens the builder on `library`, with nothing selected. */
export function openWorkflowBuilder(library: readonly WorkflowDoc[]): WorkflowBuilderState {
  return {
    library: [...library],
    selection: null,
    baseline: null,
    draft: null,
    pendingSelection: null,
    retryOnText: {},
    importIssues: null,
    notices: [],
  };
}

/** Replaces `library` wholesale — the section's answer to a `task:changed`-style
 *  refresh. Leaves the open selection/draft/pendingSelection/retryOnText/notices
 *  untouched. */
export function reloadLibrary(
  state: WorkflowBuilderState,
  library: readonly WorkflowDoc[],
): WorkflowBuilderState {
  return { ...state, library: [...library] };
}

function draftsForTarget(
  target: WorkflowSelection,
  library: readonly WorkflowDoc[],
): { baseline: WorkflowDraft | null; draft: WorkflowDraft | null } {
  if (target.kind === 'new') {
    const blank = blankDraft();
    return { baseline: cloneDraft(blank), draft: cloneDraft(blank) };
  }
  const doc = library.find((w) => w.id === target.id);
  if (!doc) return { baseline: null, draft: null };
  const draft = draftFromDoc(doc);
  return { baseline: cloneDraft(draft), draft: cloneDraft(draft) };
}

function applySelectionTarget(
  state: WorkflowBuilderState,
  target: WorkflowSelection,
): WorkflowBuilderState {
  const { baseline, draft } = draftsForTarget(target, state.library);
  return {
    ...state,
    selection: target,
    baseline,
    draft,
    pendingSelection: null,
    retryOnText: draft ? retryOnTextFor(draft) : {},
    importIssues: null,
  };
}

function buildDuplicateDraft(doc: WorkflowDoc): WorkflowDraft {
  return { version: 1, name: `${doc.name} (copy)`, steps: cloneSteps(doc.steps) };
}

function applyDuplicateTarget(state: WorkflowBuilderState, id: string): WorkflowBuilderState {
  const doc = state.library.find((w) => w.id === id);
  if (!doc) return state;
  const draft = buildDuplicateDraft(doc);
  return {
    ...state,
    selection: { kind: 'new' },
    baseline: cloneDraft(draft),
    draft: cloneDraft(draft),
    pendingSelection: null,
    retryOnText: retryOnTextFor(draft),
    importIssues: null,
  };
}

function switchSelection(
  state: WorkflowBuilderState,
  selection: WorkflowSelection,
): WorkflowBuilderState {
  if (isDirty(state)) return { ...state, pendingSelection: { target: { kind: 'select', selection } } };
  return applySelectionTarget(state, selection);
}

/** Selects library workflow `id`; asks for a discard confirm first if the open draft is
 *  dirty. */
export function selectWorkflow(state: WorkflowBuilderState, id: string): WorkflowBuilderState {
  return switchSelection(state, { kind: 'library', id });
}

/** Opens a blank draft for a brand-new workflow — a blank name and one blank agent step;
 *  asks for a discard confirm first if the open draft is dirty. */
export function startNew(state: WorkflowBuilderState): WorkflowBuilderState {
  return switchSelection(state, { kind: 'new' });
}

/** Opens a new, id-less draft copied from library workflow `id`, named `"<name> (copy)"`;
 *  asks for a discard confirm first if the open draft is dirty. A no-op (once any pending
 *  confirm resolves) if `id` is not in `library`. */
export function duplicateWorkflow(state: WorkflowBuilderState, id: string): WorkflowBuilderState {
  if (isDirty(state)) return { ...state, pendingSelection: { target: { kind: 'duplicate', id } } };
  return applyDuplicateTarget(state, id);
}

/** Applies the switch {@link PendingSelection} was holding; a no-op if there is none. */
export function confirmPendingSelection(state: WorkflowBuilderState): WorkflowBuilderState {
  const pending = state.pendingSelection;
  if (!pending) return state;
  if (pending.target.kind === 'duplicate') return applyDuplicateTarget(state, pending.target.id);
  return applySelectionTarget(state, pending.target.selection);
}

/** Drops the pending switch, leaving the current selection/draft exactly as they were. */
export function cancelPendingSelection(state: WorkflowBuilderState): WorkflowBuilderState {
  if (!state.pendingSelection) return state;
  return { ...state, pendingSelection: null };
}

/** Restores the open draft (and its `retryOnText` boxes) to a fresh copy of `baseline`. */
export function discardDraft(state: WorkflowBuilderState): WorkflowBuilderState {
  if (!state.baseline) return state;
  return { ...state, draft: cloneDraft(state.baseline), retryOnText: retryOnTextFor(state.baseline) };
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Whether `draft` differs from `baseline` — `false` whenever either is `null` (no draft
 *  open has nothing to be dirty about). Compares by value, not by key order, since a
 *  step's key order can shift across clones (e.g. a deleted-then-restored optional
 *  field). */
export function isDirty(state: WorkflowBuilderState): boolean {
  if (!state.draft || !state.baseline) return false;
  return stableStringify(state.draft) !== stableStringify(state.baseline);
}

function parseRetryOnText(text: string): { codes: number[] } | { error: string } {
  const tokens = text
    .split(',')
    .map((token) => token.trim())
    .filter((token) => token.length > 0);

  const codes: number[] = [];
  for (const token of tokens) {
    if (!/^\d+$/.test(token) || Number(token) < 1) {
      return { error: `"${token}" is not a positive whole number` };
    }
    codes.push(Number(token));
  }
  return { codes };
}

const STEP_ISSUE_PREFIX = /^(?:Agent step|Gate step|Step) "([^"]*)"/;

/**
 * Every rule the section enforces on `draft` before it offers Save: `validateWorkflow`'s
 * own issues (run against `{ ...draft, id: draft.id ?? 'new' }`, since a brand-new draft
 * has no id yet but the validator requires one) plus one more per gate step whose
 * `retryOnText` box doesn't currently parse to a list of positive exit codes. Only gates
 * with `onFail` set are checked — a gate that stops the workflow on failure has no
 * retry-on codes to validate.
 */
export function workflowIssues(state: WorkflowBuilderState): string[] {
  if (!state.draft) return [];
  const result = validateWorkflow({ ...state.draft, id: state.draft.id ?? 'new' });
  const issues = result.ok ? [] : [...result.issues];

  for (const step of state.draft.steps) {
    if (!isGateStep(step) || !step.onFail) continue;
    const parsed = parseRetryOnText(state.retryOnText[step.id] ?? '');
    if ('error' in parsed) {
      issues.push(`Step "${step.id}"'s retry-on codes: ${parsed.error}.`);
    }
  }

  return issues;
}

/**
 * {@link workflowIssues}, bucketed by the step id each message's `Step "<id>"` /
 * `Agent step "<id>"` / `Gate step "<id>"` prefix names (the convention `validateWorkflow`
 * already uses, extended to this module's own retry-on-text messages so they bucket the
 * same way) — for showing a field's error inline instead of in one flat list. Anything
 * that doesn't name a step currently in `draft` (a document-level issue, or a stale
 * `Step "<id>"` left over from before a removal — though removal alone can't orphan an
 * issue about the removed step itself, since it's gone from `draft.steps` and so produces
 * no such issue to begin with) lands under `general`.
 */
export function stepIssues(state: WorkflowBuilderState): Record<string, string[]> {
  const result: Record<string, string[]> = { general: [] };
  if (!state.draft) return result;

  const ids = new Set(state.draft.steps.map((step) => step.id));
  for (const issue of workflowIssues(state)) {
    const match = STEP_ISSUE_PREFIX.exec(issue);
    const id = match?.[1];
    if (id && ids.has(id)) {
      (result[id] ??= []).push(issue);
    } else {
      result.general.push(issue);
    }
  }
  return result;
}

/** The agent steps before `gateId` in `draft.steps` — the only steps a gate may legally
 *  retry from. Empty with no draft open, or if `gateId` doesn't name a step in it. */
export function retryFromOptions(
  state: WorkflowBuilderState,
  gateId: string,
): Array<{ id: string; title: string }> {
  if (!state.draft) return [];
  const index = state.draft.steps.findIndex((step) => step.id === gateId);
  if (index === -1) return [];
  return state.draft.steps
    .slice(0, index)
    .filter(isAgentStep)
    .map((step) => ({ id: step.id, title: step.title }));
}

/** Whether Save should be enabled: a draft is open, it differs from `baseline`, and
 *  {@link workflowIssues} finds nothing wrong with it. */
export function canSave(state: WorkflowBuilderState): boolean {
  if (!state.draft || !isDirty(state)) return false;
  return workflowIssues(state).length === 0;
}

/** Appends a blank step of `kind` to the open draft, with a fresh id from
 *  {@link nextStepId}. A no-op with no draft open. */
export function addStep(state: WorkflowBuilderState, kind: WorkflowStep['kind']): WorkflowBuilderState {
  if (!state.draft) return state;
  const id = nextStepId(state.draft.steps, kind);
  const step: WorkflowStep =
    kind === 'agent' ? { id, kind: 'agent', title: '', brief: '' } : { id, kind: 'gate', title: '', command: '' };
  const steps = [...state.draft.steps, step];
  const retryOnText = kind === 'gate' ? { ...state.retryOnText, [id]: '' } : state.retryOnText;
  return { ...state, draft: { ...state.draft, steps }, retryOnText };
}

/**
 * Removes step `id` from the open draft. Never touches any OTHER step — in particular,
 * a gate step elsewhere in `draft` that retried from `id` keeps that `retryFrom`
 * unchanged, now dangling; {@link workflowIssues}/{@link stepIssues} flag it exactly like
 * `validateWorkflow` flags any other unresolved reference. A no-op with no draft open.
 */
export function removeStep(state: WorkflowBuilderState, id: string): WorkflowBuilderState {
  if (!state.draft) return state;
  const steps = state.draft.steps.filter((step) => step.id !== id);
  const { [id]: _removed, ...retryOnText } = state.retryOnText;
  return { ...state, draft: { ...state.draft, steps }, retryOnText };
}

/**
 * Moves the step at index `from` to index `to`, leaving every step's own fields —
 * including any gate's `onFail.retryFrom` — byte-for-byte unchanged. Whether that move
 * leaves a gate's `retryFrom` pointing at an earlier step is purely a consequence of the
 * new order; this function itself never inspects or rewrites a `retryFrom`.
 * `up`/`down` reordering is just this with `to` one less/more than `from`. A no-op with
 * no draft open, or with either index out of range.
 */
export function moveStep(state: WorkflowBuilderState, from: number, to: number): WorkflowBuilderState {
  if (!state.draft) return state;
  const steps = moveItem(state.draft.steps, from, to);
  return { ...state, draft: { ...state.draft, steps } };
}

/** Patches the open draft's `name`. A no-op with no draft open. */
export function editWorkflow(state: WorkflowBuilderState, patch: { name: string }): WorkflowBuilderState {
  if (!state.draft) return state;
  return { ...state, draft: { ...state.draft, ...patch } };
}

/** Patches step `id`'s `title` (either kind) and/or `brief`/`command` (whichever its own
 *  kind actually has) on the open draft. The other per-field setters below cover the
 *  nullable/typed fields this one deliberately leaves out. A no-op with no draft open or
 *  no step `id` in it. */
export function editStep(
  state: WorkflowBuilderState,
  id: string,
  patch: Partial<Pick<AgentStep, 'title' | 'brief'> & Pick<GateStep, 'title' | 'command'>>,
): WorkflowBuilderState {
  if (!state.draft) return state;
  const steps = state.draft.steps.map((step) => (step.id === id ? { ...step, ...patch } : step));
  return { ...state, draft: { ...state.draft, steps } };
}

/** Sets (or, with `null`, deletes) agent step `id`'s `model` override. A no-op on a gate
 *  step or with no draft open. */
export function setStepModel(
  state: WorkflowBuilderState,
  id: string,
  model: ClaudeModel | null,
): WorkflowBuilderState {
  return updateStep(state, id, (step) => (isAgentStep(step) ? withOptional(step, 'model', model) : step));
}

/** Sets (or, with `null`, deletes) agent step `id`'s `mode` override. A no-op on a gate
 *  step or with no draft open. */
export function setStepMode(
  state: WorkflowBuilderState,
  id: string,
  mode: PermissionMode | null,
): WorkflowBuilderState {
  return updateStep(state, id, (step) => (isAgentStep(step) ? withOptional(step, 'mode', mode) : step));
}

/** Sets (or, with `null`, deletes) agent step `id`'s `skillRefs`. A no-op on a gate step
 *  or with no draft open. */
export function setStepSkillRefs(
  state: WorkflowBuilderState,
  id: string,
  skillRefs: string[] | null,
): WorkflowBuilderState {
  return updateStep(state, id, (step) => (isAgentStep(step) ? withOptional(step, 'skillRefs', skillRefs) : step));
}

/** Sets (or, with `null`, deletes) gate step `id`'s `onFail`, and resyncs its
 *  `retryOnText` box to match the new `onFail.retryOn` (so switching `onFail` on/off, or
 *  replacing it wholesale, never leaves a stale box behind). A no-op on an agent step or
 *  with no draft open. */
export function setGateOnFail(
  state: WorkflowBuilderState,
  id: string,
  onFail: GateOnFail | null,
): WorkflowBuilderState {
  if (!state.draft) return state;
  const steps = state.draft.steps.map((step) =>
    step.id === id && isGateStep(step) ? withOptional(step, 'onFail', onFail) : step,
  );
  const retryOnText = { ...state.retryOnText, [id]: retryOnTextFromCodes(onFail?.retryOn) };
  return { ...state, draft: { ...state.draft, steps }, retryOnText };
}

/**
 * Sets gate step `id`'s raw retry-on-codes box text. Always stored verbatim in
 * `retryOnText` (so a half-typed `"1, 2,"` is never reformatted away mid-edit); if it
 * currently parses to a list of positive integers (ignoring empty tokens, so a trailing
 * comma is not itself an error), also writes that list to the step's `onFail.retryOn` —
 * but only when the step already has `onFail` set, since `retryOn` means nothing without
 * it. An empty box parses to no codes, which clears `retryOn` (matching "retry on any
 * non-zero exit"). Text that doesn't parse leaves the step's `onFail.retryOn` exactly as
 * it was; {@link workflowIssues} flags the box itself until it parses again.
 */
export function setRetryOnText(state: WorkflowBuilderState, id: string, text: string): WorkflowBuilderState {
  const retryOnText = { ...state.retryOnText, [id]: text };
  if (!state.draft) return { ...state, retryOnText };

  const parsed = parseRetryOnText(text);
  if ('error' in parsed) return { ...state, retryOnText };

  const steps = state.draft.steps.map((step) => {
    if (step.id !== id || !isGateStep(step) || !step.onFail) return step;
    const retryOn = parsed.codes.length > 0 ? parsed.codes : null;
    return { ...step, onFail: withOptional(step.onFail, 'retryOn', retryOn) };
  });

  return { ...state, draft: { ...state.draft, steps }, retryOnText };
}

/**
 * Folds a `workflow:save` answer back into the state. `ok` upserts the saved workflow
 * into `library`, re-baselines the draft from it (so Save immediately goes clean), and
 * points `selection` at its id — the way a brand-new draft's selection becomes a library
 * one the moment it is first saved. `false` (always `reason: 'invalid'`) appends its
 * `issues` to `notices` instead, leaving the draft open and unchanged so the human can
 * fix it and retry.
 */
export function applySaveResult(state: WorkflowBuilderState, result: WorkflowSaveResult): WorkflowBuilderState {
  if (result.ok) {
    const draft = draftFromDoc(result.workflow);
    return {
      ...state,
      library: upsertWorkflow(state.library, result.workflow),
      selection: { kind: 'library', id: result.workflow.id },
      baseline: cloneDraft(draft),
      draft: cloneDraft(draft),
      pendingSelection: null,
      retryOnText: retryOnTextFor(draft),
    };
  }

  return { ...state, notices: [...state.notices, ...result.issues] };
}

/**
 * Folds a `workflow:import`/`workflow:export`-sibling `workflow:import` answer back into
 * the state. `null` (the native picker was cancelled) is a no-op. `ok` upserts the
 * imported workflow into `library` and selects it, exactly like {@link applySaveResult}'s
 * `ok` path. A refusal sets {@link WorkflowBuilderState.importIssues} to its `issues`
 * rather than touching the open draft — the human is shown why the import failed and can
 * dismiss it with {@link dismissImportIssues}.
 */
export function applyImportResult(
  state: WorkflowBuilderState,
  result: WorkflowImportResult | null,
): WorkflowBuilderState {
  if (result === null) return state;

  if (result.ok) {
    const draft = draftFromDoc(result.workflow);
    return {
      ...state,
      library: upsertWorkflow(state.library, result.workflow),
      selection: { kind: 'library', id: result.workflow.id },
      baseline: cloneDraft(draft),
      draft: cloneDraft(draft),
      pendingSelection: null,
      retryOnText: retryOnTextFor(draft),
      importIssues: null,
    };
  }

  return { ...state, importIssues: [...result.issues] };
}

/**
 * The browser-host path for import, where there is no native file picker to hand
 * `workflow:import` a path from: parses `text` as JSON, then runs it through
 * `validateWorkflow` exactly as the desktop handler would. On success, opens it as a
 * dirty, id-less new draft (dirty against the ordinary blank-new-workflow baseline,
 * since an imported document is never that) — the same shape a save then mints an id
 * for. On failure, sets {@link WorkflowBuilderState.importIssues} to either a one-line
 * JSON-parse sentence or `validateWorkflow`'s own issues, never both.
 */
export function importFromText(state: WorkflowBuilderState, text: string): WorkflowBuilderState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ...state, importIssues: ['That text is not valid JSON.'] };
  }

  const result = validateWorkflow(parsed);
  if (!result.ok) {
    return { ...state, importIssues: [...result.issues] };
  }

  const { id: _id, ...draftWithoutId } = draftFromDoc(result.doc);
  const draft: WorkflowDraft = draftWithoutId;

  return {
    ...state,
    selection: { kind: 'new' },
    baseline: cloneDraft(blankDraft()),
    draft: cloneDraft(draft),
    pendingSelection: null,
    retryOnText: retryOnTextFor(draft),
    importIssues: null,
  };
}

/** Clears {@link WorkflowBuilderState.importIssues} without touching anything else. */
export function dismissImportIssues(state: WorkflowBuilderState): WorkflowBuilderState {
  if (!state.importIssues) return state;
  return { ...state, importIssues: null };
}

/** The open draft, pretty-printed exactly as `workflow:export`/a copy-to-clipboard would
 *  show it. `"null"` with no draft open. */
export function previewJson(state: WorkflowBuilderState): string {
  return JSON.stringify(state.draft, null, 2);
}

/** Removes workflow `id` from `library`, clearing the open selection/draft/pendingSelection
 *  /retryOnText if `id` was the one selected. */
export function applyDelete(state: WorkflowBuilderState, id: string): WorkflowBuilderState {
  const library = state.library.filter((w) => w.id !== id);
  const wasSelected = state.selection?.kind === 'library' && state.selection.id === id;
  if (!wasSelected) return { ...state, library };
  return {
    ...state,
    library,
    selection: null,
    baseline: null,
    draft: null,
    pendingSelection: null,
    retryOnText: {},
  };
}
