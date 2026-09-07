/**
 * How a model choice reads, and what an empty one stores — on the CARD side of the split.
 *
 * A card's `agentModel` is nullable, and `null` is the interesting value: it means this card
 * runs on whatever its agent project resolves to. That used to be one answer (`defaultModel`)
 * so the UI could get away with quietly pinning it; now that a project plans and executes on
 * different models, pinning one name opts the card out of the split without ever saying so.
 *
 * Three controls have to say "follow the project" — the composer's footer, the assign dialog
 * and the panel's echo — so the sentinel they carry and the words they use live here rather
 * than three times over. Exactly why `PlanningModelField` exists for the project side of the
 * same question.
 *
 * `modelCaption`/`projectDefaultLabel`/`cardModelCaption` take an optional `labelOf` lookup —
 * a model id to the CLI's own display name (`ModelResolution.label`, `@tm/shared/model`) — so
 * a project that has split planning from execution reads `Opus 4.7 planning · Haiku 4.5 steps`
 * rather than the raw ids the ladder deals in. It defaults to the identity function, so every
 * call site that has not been wired to a catalog lookup yet (every one of them, until "Wire
 * every model picker to the catalog") keeps reading exactly as it did before this.
 */
import { resolveRunModel } from '@tm/shared/model';
import type { Project, Task } from '@tm/shared/model';
import type { ClaudeModel } from '@tm/shared/session';

/**
 * The option value standing for `null` — a Dropdown can't carry one. The leading `..` keeps
 * it out of the model namespace, so a future model name can never collide with it (the same
 * trick, for the same reason, as `SAME_AS_EXECUTION`).
 */
export const PROJECT_DEFAULT = '..project-default';

/**
 * What the chosen option MEANS as a stored value: the sentinel, and a Dropdown that hands
 * back nothing, both mean `null` — "follow the project".
 *
 * Exported so the round trip can be asserted without a DOM: getting this backwards pins a
 * model the human declined, and the control redisplays it as a deliberate choice.
 */
export function cardModelFromOption(optionValue: string | undefined): ClaudeModel | null {
  return optionValue && optionValue !== PROJECT_DEFAULT ? (optionValue as ClaudeModel) : null;
}

/** Just the two fields any of this depends on, so a caller can pass a half-built project. */
type ProjectModels = Pick<Project, 'defaultModel' | 'planningModel'>;

/** A model id, verbatim — the default `labelOf`, for every caller with no catalog to ask. */
const RAW_ID = (id: string): string => id;

/**
 * How a project's models read. One name while planning follows execution — which is every
 * project until someone splits them — and both, labelled, once they differ, since at that
 * point "sonnet" alone would be a half-truth about what this repo costs.
 *
 * Both names come from {@link resolveRunModel} rather than being read off the fields, so this
 * caption can never disagree with the ladder that actually decides what a run costs. `labelOf`
 * turns each id into what the CLI actually calls it — see the file header.
 */
export function modelCaption(
  project: ProjectModels,
  labelOf: (id: string) => string = RAW_ID,
): string {
  const steps = resolveRunModel({ agentModel: null }, project, false);
  const planning = resolveRunModel({ agentModel: null }, project, true);
  const stepsLabel = labelOf(steps);
  const planningLabel = labelOf(planning);
  return planning === steps ? stepsLabel : `${planningLabel} planning · ${stepsLabel} steps`;
}

/**
 * The empty choice, naming what it defers to — so the dropdown answers "what will this
 * actually run on?" without the reader having to open Settings. Nameless when the card has
 * no agent project yet: there is nothing to quote, and inventing `sonnet` there is the
 * hardcoded fallback this replaces.
 */
export function projectDefaultLabel(
  project: ProjectModels | null,
  labelOf: (id: string) => string = RAW_ID,
): string {
  return project ? `Project default · ${modelCaption(project, labelOf)}` : 'Project default';
}

/** How a card's model reads back: its own override, else what its project resolves to. */
export function cardModelCaption(
  task: Pick<Task, 'agentModel'>,
  project: ProjectModels | null,
  labelOf: (id: string) => string = RAW_ID,
): string {
  if (task.agentModel != null) return labelOf(task.agentModel);
  return project ? modelCaption(project, labelOf) : 'project default';
}
