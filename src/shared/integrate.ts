/**
 * Auto-merge — "when this card's work is finished, merge its branch back into base".
 *
 * The behaviour itself is old (`AppSettings.autoIntegrate`, Phase 17); what is new is
 * that the answer is no longer the same for the whole app. Merging automatically is a
 * judgement about a REPO — a scratch repo you own outright wants it, the one your team
 * ships from does not — and sometimes about a single card, so the one global switch was
 * always being set to whichever repo was in front of you.
 *
 * Three switches, one answer, resolved outward-in:
 *
 * 1. the CARD's override (the Kanban board's Details Panel), `null` = it has not ruled;
 * 2. the PROJECT's preference (Settings → its dialog), `null` = it has not ruled either;
 * 3. the app-wide default (`AppSettings.autoIntegrate`), which still means what it did.
 *
 * Both nulls are load-bearing, exactly as in `@shared/release`: a level that merely
 * inherits must KEEP inheriting, so that changing the app's default changes every project
 * that never disagreed with it, and changing a project's changes every card that never
 * disagreed with THAT. Storing the resolved boolean instead would freeze a preference the
 * human is still forming — and would silently pin every existing project and card to
 * whatever the global happened to be on the day they upgraded.
 */
import type { Project, Task } from './model';
import type { AppSettings } from './settings';

/**
 * What a project answers when nobody asked the card: its own preference, else the app's.
 *
 * Exported because the UI needs it for more than display. A switch on a card stores `null`
 * when it is set to what the project already says (see `TaskAgentPanel`), which is how a
 * card gets back to inheriting — and it cannot know what "already says" is without this.
 */
export function projectAutoIntegrate(
  project: Partial<Pick<Project, 'autoIntegrate'>> | null | undefined,
  settings: Pick<AppSettings, 'autoIntegrate'> | null | undefined,
): boolean {
  const preference = project?.autoIntegrate;
  if (preference === true || preference === false) return preference;
  return settings?.autoIntegrate === true;
}

/**
 * Whether a finished run should merge its own branch, for THIS card.
 *
 * Says nothing about whether there is a branch to merge — a non-worktree project has
 * none, and the engine checks that separately. This answers only "was it asked for".
 */
export function autoIntegrateOn(
  task: Pick<Task, 'autoIntegrate'> | null | undefined,
  project: Partial<Pick<Project, 'autoIntegrate'>> | null | undefined,
  settings: Pick<AppSettings, 'autoIntegrate'> | null | undefined,
): boolean {
  const override = task?.autoIntegrate;
  if (override === true || override === false) return override;
  return projectAutoIntegrate(project, settings);
}
