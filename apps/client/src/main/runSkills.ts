/**
 * Resolving a run's skills — turning a card and its step's `Task.skillRefs` into the
 * bodies `skillsPrompt.ts` injects into the system prompt (F7.6).
 *
 * Pure: no store, no fs. `resolveRunSkills` is handed two lookup functions instead of
 * reading the library table or the worktree itself, so the scheduler (which has both)
 * stays the only caller that touches either, and this module is trivial to unit test with
 * plain maps standing in for both.
 *
 * A ref that cannot be resolved — a parse failure, or a parseable ref whose target is gone
 * (a deleted library skill, a repo skill folder that moved) — is never thrown. It is
 * reported back as `dangling` so the run still starts; `skillsTimelineNote` is what tells
 * the human which ones it had to drop.
 */
import type { Task } from '@shared/model';
import { formatSkillRef, parseSkillRef, type Skill } from '@shared/skills';
import type { HistoryBudget } from './promptHistory';
import type { RepoSkill } from './repoSkills';
import { boundSkills, SKILLS_CHAR_BUDGET, type ResolvedSkill } from './skillsPrompt';

/** A ref that pointed at nothing a run could use — either it never parsed, or it parsed
 *  fine but its target (a library row, a repo skill folder) is gone. */
export interface DanglingSkill {
  /** The canonical ref string (`lib:<id>` / `repo:<name>`), or the raw text when it could
   *  not even be parsed into one. */
  ref: string;
  reason: 'missing' | 'invalid-ref';
}

/** What `resolveRunSkills` needs to turn a ref into a body: a library row by id, and a
 *  repo skill by name, each read fresh by the caller (the store, the worktree) rather than
 *  cached here. `undefined` (library) or `null`/`undefined` (repo) both mean "no such skill
 *  right now" — the caller is never asked to distinguish "not found" from "not looked up". */
export interface RunSkillLookups {
  library(id: string): Skill | undefined;
  repo(name: string): RepoSkill | null | undefined;
}

/**
 * The card's `skillRefs` followed by the step's own, `null` treated as `[]`, each
 * canonicalised through `parseSkillRef`/`formatSkillRef` so whitespace or formatting
 * variants of the same ref compare equal — and deduplicated keeping the FIRST occurrence,
 * so a card's ref always wins its own duplicate on the step.
 *
 * A ref that fails to parse is kept as its trimmed raw text (still deduplicated against
 * other occurrences of the same bad text) rather than dropped here — `resolveRunSkills` is
 * what turns it into a reported `dangling` entry; this function only orders and dedupes.
 */
export function runSkillRefs(
  card: Pick<Task, 'skillRefs'>,
  step: Pick<Task, 'skillRefs'>,
): string[] {
  const combined = [...(card.skillRefs ?? []), ...(step.skillRefs ?? [])];
  const seen = new Set<string>();
  const refs: string[] = [];
  for (const raw of combined) {
    const parsed = parseSkillRef(raw);
    const canonical = parsed ? formatSkillRef(parsed) : raw.trim();
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    refs.push(canonical);
  }
  return refs;
}

/**
 * Resolve a run's skills: `runSkillRefs(card, step)`, each looked up through `lookups` and
 * split into what resolved and what is dangling. Never throws — a missing skill or an
 * unparseable ref lands in `dangling` and the rest still resolves.
 */
export function resolveRunSkills(
  card: Pick<Task, 'skillRefs'>,
  step: Pick<Task, 'skillRefs'>,
  lookups: RunSkillLookups,
): { resolved: ResolvedSkill[]; dangling: DanglingSkill[] } {
  const resolved: ResolvedSkill[] = [];
  const dangling: DanglingSkill[] = [];

  for (const ref of runSkillRefs(card, step)) {
    const parsed = parseSkillRef(ref);
    if (!parsed) {
      dangling.push({ ref, reason: 'invalid-ref' });
      continue;
    }

    if (parsed.kind === 'library') {
      const skill = lookups.library(parsed.id);
      if (!skill) {
        dangling.push({ ref, reason: 'missing' });
        continue;
      }
      resolved.push({
        ref,
        name: skill.name,
        description: skill.description,
        body: skill.body,
        source: 'library',
      });
    } else {
      const skill = lookups.repo(parsed.name);
      if (!skill) {
        dangling.push({ ref, reason: 'missing' });
        continue;
      }
      resolved.push({
        ref,
        name: skill.name,
        description: skill.description,
        body: skill.body,
        source: 'repo',
        dir: `.claude/skills/${skill.name}`,
      });
    }
  }

  return { resolved, dangling };
}

/**
 * The activity-timeline note for a run's skills: which ones are in force, which got cut by
 * the size budget, and which refs are dangling — so a human reading the card's history sees
 * exactly what the run saw, not just that a prompt section exists.
 *
 * `null` when `result` carries no refs at all (nothing resolved and nothing dangling), so a
 * run with no skills attached adds no note. `budget` defaults to the same
 * `SKILLS_CHAR_BUDGET` `skillsPrompt.ts` renders with, so the omission line here always
 * matches what the prompt section actually dropped.
 */
export function skillsTimelineNote(
  result: { resolved: ResolvedSkill[]; dangling: DanglingSkill[] },
  budget: HistoryBudget = { maxChars: SKILLS_CHAR_BUDGET },
): string | null {
  const { resolved, dangling } = result;
  if (resolved.length === 0 && dangling.length === 0) return null;

  const { kept, dropped } = boundSkills(resolved, budget);
  const sentences: string[] = [];

  if (kept.length > 0) {
    sentences.push(`Skills in force for this run: ${kept.map((s) => s.name).join(', ')}.`);
  }
  if (dropped.length > 0) {
    sentences.push(`Omitted to fit the size budget: ${dropped.map((s) => s.name).join(', ')}.`);
  }
  for (const d of dangling) {
    sentences.push(`Skill \`${d.ref}\` no longer exists — this run started without it.`);
  }
  sentences.push("Changes to this card's skills take effect on its next run.");

  return sentences.join(' ');
}
