/**
 * Naming a project's files so the APP's own `fs` calls can open them.
 *
 * A project stores its paths the way the machine that RUNS it sees them — a WSL
 * project's plan lives at `/home/you/repo/plan.md`, which is what `git` and the agent
 * use. But the app itself runs on Windows, and `readFileSync`/`watchFile` need the
 * same file named `\\wsl.localhost\<distro>\home\you\repo\plan.md`.
 *
 * Every place the main process touches a project file directly goes through here, so
 * the translation is in one place instead of being remembered at each call site (and
 * forgotten at one of them).
 */
import { posix, relative } from 'node:path';
import type { Project } from '@shared/model';
import { hostFor, hostJoin } from './exec';

/** The project's plan file, as this process can open it. */
export function appPlanPath(project: Project): string {
  return hostFor(project.target).toApp(project.planPath);
}

/** A file inside the project directory, as this process can open it. */
export function appProjectFile(project: Project, name: string): string {
  const host = hostFor(project.target);
  return host.toApp(hostJoin(project.path, name));
}

/**
 * The plan file's location relative to the project directory, in the shape the AGENT
 * will see — this value goes into the prompt.
 *
 * `node:path.relative` builds separators for the machine it runs on, so on Windows it
 * would turn two perfectly good Linux paths into `docs\plan.md`, which points nowhere
 * inside the distro.
 */
export function planRelPath(project: Project): string {
  const posix = project.path.startsWith('/');
  const rel = (posix ? relativePosix : relative)(project.path, project.planPath);
  return rel || project.planPath;
}

/** `path.posix.relative` is not exposed on the default import shape we use elsewhere. */
function relativePosix(from: string, to: string): string {
  return posix.relative(from, to);
}
