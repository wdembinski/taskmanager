/**
 * Discovering the repo skills a project already carries under
 * `.claude/skills/<name>/SKILL.md` (F7.5).
 *
 * A repo skill is never owned or synced by this app the way a library `Skill` is
 * (`@shared/skills`) — it lives in the project's own worktree, so every function here
 * reads straight off disk through the project's `ExecHost` rather than a store. Both
 * functions fail soft: a missing `.claude/skills` directory, an unreadable `SKILL.md`,
 * or one bad entry among many never throws and never loses the rest of the list.
 *
 * `listRepoSkills` is what a project mirror shows in a picker; `readRepoSkill` is what
 * F7.6 calls at run time to actually inject a chosen skill's body into a prompt.
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import type { RepoSkillSummary } from '@shared/skills';
import { isValidSkillName, parseSkillMarkdown } from '@shared/skills';
import { hostJoin, localHost, type ExecHost } from './exec';

export const REPO_SKILLS_DIR = ['.claude', 'skills'] as const;

/** A repo skill read in full — what F7.6 injects. */
export interface RepoSkill {
  name: string;
  description: string;
  body: string;
  /** Host-shaped absolute directory of the skill (so `references/` resolve), for the prompt. */
  dir: string;
  warnings: string[];
}

/**
 * List the repo skills under `root`'s `.claude/skills`, sorted by name.
 *
 * A missing directory — by far the ordinary case, since most projects carry no repo
 * skills at all — produces `[]`, not an error. Each entry is read with
 * {@link readRepoSkill} in parallel so one unreadable skill (a directory with no
 * `SKILL.md`, a permissions error) never drops the others from the list.
 */
export async function listRepoSkills(
  projectId: string,
  root: string,
  host: ExecHost = localHost(),
): Promise<RepoSkillSummary[]> {
  if (!root.trim()) return [];

  let entries;
  try {
    const skillsDir = host.toApp(hostJoin(root, ...REPO_SKILLS_DIR));
    entries = await readdir(skillsDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const skills = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && isValidSkillName(entry.name))
      .map((entry) => readRepoSkill(root, entry.name, host)),
  );

  return skills
    .filter((skill): skill is RepoSkill => skill !== null)
    .map((skill) => ({
      projectId,
      name: skill.name,
      description: skill.description,
      path: [...REPO_SKILLS_DIR, skill.name, 'SKILL.md'].join('/'),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Read one repo skill's `SKILL.md` in full. `null` for an invalid `name`, a missing or
 * non-file `SKILL.md`, or any other read error — never a thrown exception, since a
 * skill being gone or malformed by the time a run reaches it is an ordinary race, not
 * a fault.
 */
export async function readRepoSkill(
  root: string,
  name: string,
  host: ExecHost = localHost(),
): Promise<RepoSkill | null> {
  if (!isValidSkillName(name)) return null;

  const dir = hostJoin(root, ...REPO_SKILLS_DIR, name);
  const file = host.toApp(hostJoin(dir, 'SKILL.md'));

  let text: string;
  try {
    const stats = await stat(file);
    if (!stats.isFile()) return null;
    text = await readFile(file, 'utf8');
  } catch {
    return null;
  }

  const parsed = parseSkillMarkdown(text, name);
  const warnings = [...parsed.warnings];
  if (parsed.name !== '' && parsed.name !== name) {
    warnings.push(
      `frontmatter name "${parsed.name}" differs from the folder name "${name}"; the folder name wins`,
    );
  }

  return { ...parsed, name, dir, warnings };
}
