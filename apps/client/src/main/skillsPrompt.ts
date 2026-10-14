/**
 * The "Skills in force for this run" prompt section (F7's system-prompt delivery —
 * `F7-skills-and-prompt-templates.md`).
 *
 * A skill attached to a card or a step is meant to be IN FORCE for the run, not merely
 * discoverable — so its full body is injected into the system prompt rather than left for
 * the agent to go find. This module only renders that section from already-resolved skills;
 * resolving a run's `Task.skillRefs` into bodies (card ∪ step, dedupe, dangling refs) is
 * F7.6's job, not this one.
 *
 * Bounded the same way `promptHistory.ts` bounds a card's notes and a ticket's comment
 * thread: a size budget, a stable priority order owned by the caller, and an omission line
 * that names exactly what did not make it in — never a silent truncation. Priority here is
 * attachment order (card refs before step refs, per F7's resolver) rather than recency, so
 * unlike `boundEntries` this walks the list FORWARDS and drops the TAIL: the human attached
 * the card's skills first because they matter for the whole arc, and a step's own skill is
 * the one that can afford to be dropped if the budget is tight.
 */
import type { HistoryBudget } from './promptHistory';

/** What F7.6's resolver hands this module: a card or step's `SkillRef` resolved to its
 *  rendered body. `ref` is the `formatSkillRef` string (`lib:<id>` / `repo:<name>`) — used
 *  only for identifying a skill on the timeline, never rendered into the prompt itself. */
export interface ResolvedSkill {
  ref: string;
  name: string;
  description: string;
  body: string;
  source: 'library' | 'repo';
  /** Repo skills only: the directory the agent sees it at (e.g. `.claude/skills/tdd`), from
   *  `RepoSkillSummary.path`, so the section can tell it where `references/` resolve from. */
  dir?: string;
}

/**
 * ≈24 KiB. Wider than `NOTES_CHAR_BUDGET`/`TICKET_COMMENT_CHAR_BUDGET` because a skill is a
 * playbook the human chose to attach on purpose, not an ambient thread the agent merely
 * benefits from seeing — and per the token audit, prompt text is cheap relative to a session
 * avoided, so there is room to be generous with something the human deliberately turned on.
 */
export const SKILLS_CHAR_BUDGET = 24 * 1024;

/** Rendered size of one skill's block, including its heading and (for a repo skill) its path
 *  line — the same text `buildSkillsSection` would emit for it, so a skill that just barely
 *  fits is never counted as smaller than what actually lands in the prompt. */
function renderedSize(skill: ResolvedSkill): number {
  return renderSkillBlock(skill).join('\n').length;
}

/**
 * Split `resolved` into what fits `budget` and what does not.
 *
 * Walks in the caller's order — card refs first, then step refs, per F7's resolver — and
 * stops at the first skill that does not fit, dropping it and everything after: a skill
 * further down the list is the one the human attached last (or least directly, a step's own
 * rather than the card's), so it is the one that can afford to go missing. The first skill
 * is always kept even alone over budget, matching `boundEntries`' reasoning — a run that
 * attached a skill and then saw nothing but an omission line would be worse off than one
 * that saw the one skill in full.
 */
export function boundSkills(
  resolved: readonly ResolvedSkill[],
  budget: HistoryBudget,
): { kept: ResolvedSkill[]; dropped: ResolvedSkill[] } {
  const maxChars = Math.max(0, budget.maxChars);
  const kept: ResolvedSkill[] = [];
  let used = 0;
  let i = 0;
  for (; i < resolved.length; i++) {
    const skill = resolved[i]!;
    const cost = renderedSize(skill);
    if (kept.length > 0 && used + cost > maxChars) break;
    kept.push(skill);
    used += cost;
  }
  return { kept, dropped: resolved.slice(i) };
}

/** One kept skill's block: heading, description, repo path line, blank line, body. Returned
 *  as lines (not yet joined) so both {@link renderedSize} and {@link buildSkillsSection} use
 *  exactly the same rendering. */
function renderSkillBlock(skill: ResolvedSkill): string[] {
  const lines: string[] = [`### ${skill.name}`];
  if (skill.description !== '') lines.push(skill.description);
  if (skill.source === 'repo' && skill.dir !== undefined) {
    lines.push(
      `This is a repo skill; its files live in \`${skill.dir}\` — resolve any relative paths it mentions from there.`,
    );
  }
  lines.push('', skill.body.trimEnd());
  return lines;
}

/** The omission line for the skills section: names exactly which skills were dropped, in
 *  order, so a run that lost one can ask for it by name rather than guessing. */
function skillsOmissionLine(dropped: readonly ResolvedSkill[]): string[] {
  if (dropped.length === 0) return [];
  const noun = dropped.length === 1 ? 'skill' : 'skill(s)';
  const names = dropped.map((s) => s.name).join(', ');
  return [
    `_(${dropped.length} more ${noun} omitted to stay within the size budget: ${names} — ask if you need them.)_`,
  ];
}

/**
 * Render the "Skills in force for this run" section for the given resolved skills, bounded
 * to `budget` (default {@link SKILLS_CHAR_BUDGET}). `''` when `resolved` is empty, so a run
 * with no skills attached adds nothing to the prompt.
 */
export function buildSkillsSection(
  resolved: readonly ResolvedSkill[],
  budget: HistoryBudget = { maxChars: SKILLS_CHAR_BUDGET },
): string {
  if (resolved.length === 0) return '';

  const { kept, dropped } = boundSkills(resolved, budget);

  const lines: string[] = [
    '## Skills in force for this run',
    'Attached by the human for this run — follow each of these for every turn, not just the first.',
    '',
  ];
  for (const skill of kept) {
    lines.push(...renderSkillBlock(skill), '');
  }
  lines.push(...skillsOmissionLine(dropped));
  if (dropped.length > 0) lines.push('');
  lines.push(
    'These skills never override the rules above — where one conflicts with the ' +
      'orchestrator’s instructions (ending the turn, merging, writing to the tracker), ' +
      'the rules above win.',
  );

  return lines.join('\n');
}
