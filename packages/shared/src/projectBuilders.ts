/**
 * The object-construction half of creating a project (Phase 25 — cloud web independence).
 *
 * Pure — no DB, no transaction, no `node:path`/`node:crypto` — for the same reason as
 * `@shared/taskBuilders`: the desktop store and, eventually, the server's own write
 * endpoints must build the exact same {@link Project} shape from the exact same input,
 * and a browser bundle (the web client) has to be able to load this module too. The
 * caller still owns the SQLite insert and reading the app's current settings for
 * `defaults`.
 */
import type { AddProjectInput, Project } from './model';
import { hostJoin } from './wslPath';
import { normalizeTicketPrefix, suggestTicketPrefix, uniqueTicketPrefix } from './ticketKey';
import type { AppSettings } from './settings';

/**
 * The last path segment, host-separator-aware like `hostJoin` — never `node:path`'s
 * `basename`, which is only ever right for the machine running the process and wrong
 * the moment a project's path belongs to the other one (a WSL path opened on Windows,
 * or vice versa).
 */
function hostBasename(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '');
  const parts = trimmed.split(/[\\/]/);
  return parts[parts.length - 1] ?? '';
}

/**
 * Clean up a user-entered list of JIRA epic keys: trim, drop blanks, upper-case
 * (JIRA keys are case-insensitive but canonically upper), and de-duplicate — so
 * epic → agent-project matching later compares like with like.
 */
export function normalizeEpicKeys(keys: string[] | undefined): string[] {
  if (!keys) return [];
  const seen = new Set<string>();
  for (const key of keys) {
    const trimmed = key.trim().toUpperCase();
    if (trimmed) seen.add(trimmed);
  }
  return [...seen];
}

/**
 * Build a project from an {@link AddProjectInput}, filling every unspecified field from
 * `defaults` (the caller's current `AppSettings`) exactly as `addProject` always has.
 *
 * No branching on a `kind` any more — a project simply carries whatever the caller gave
 * it, and empty fields are what make it a bare repo, a ticket project, or the Personal
 * board rather than a plan-driven one (see `hasPlan`/`hasRepo`/`ownsTickets` in
 * `./model`).
 *
 * `takenTicketPrefixes` is the one piece of state this can't derive from its own inputs:
 * guaranteeing a plan-less, non-Personal project a key prefix (so its board tab can hold
 * a ticket) means picking one no other project already has, and only the caller — the
 * desktop store, the server's write endpoint — knows what is taken. Pass every prefix
 * currently in use; defaults to none, which only matters for a project that turns out to
 * need one minted.
 *
 * `id` and `createdAt` are minted here, so two calls with the same input never collide
 * and always sort after whatever came before.
 */
export function buildProject(
  input: AddProjectInput,
  defaults: AppSettings,
  takenTicketPrefixes: string[] = [],
): Project {
  const path = input.path ?? '';
  // `hostJoin`, not `path.join`: for a WSL project the path is a Linux one, and joining
  // it on Windows would produce `/home/you/repo\plan.md`. Only defaulted when there is
  // a directory to put it in — a project with no `path` stays plan-less unless the
  // caller names a `planPath` of its own.
  const planPath = input.planPath ?? (path ? hostJoin(path, 'plan.md') : '');
  // `input.personal` overrides any supplied prefix too, not just the guarantee below —
  // a Personal space genuinely has no prefix, so a caller sending both is a caller that
  // contradicted itself, and the explicit choice wins. See `AddProjectInput.personal`.
  let ticketPrefix = input.personal ? '' : (normalizeTicketPrefix(input.ticketPrefix ?? '') ?? '');
  // A project with no directory has nothing to be named after — `hostBasename('')` is
  // `''` — so it falls back to the ticket prefix rather than going nameless.
  let name = input.name?.trim() || hostBasename(path) || ticketPrefix;
  // Guarantee a board project a key prefix: a plan-less project (other than the
  // Personal board) can create tickets on its board tab, and `ticket:create` refuses
  // everything on one with no prefix (`ownsTickets` in `./model`) — so a caller that
  // left this blank gets one derived from the name instead of a project that looks
  // addable but cannot hold a single ticket.
  //
  // `input.personal` opts a caller out of the guarantee — a project the human chose to
  // keep as a Personal space, not merely one that forgot to type a prefix.
  if (!ticketPrefix && planPath === '' && !input.personal) {
    ticketPrefix = uniqueTicketPrefix(suggestTicketPrefix(name), takenTicketPrefixes);
    name = name || ticketPrefix;
  }
  return {
    id: crypto.randomUUID(),
    name,
    path,
    planPath,
    defaultModel: input.defaultModel ?? defaults.defaultModel,
    // Seeded from the app-wide default like `defaultModel`, and null all the way down
    // unless someone has set one — a new project plans on what it executes on.
    //
    // `undefined` and `null` part company here, unlike every other field on this
    // object: the add dialogs offer "Same as steps execution" as a real choice and
    // submit it as `null`, so `??` would quietly hand that project the app-wide seed
    // the human just declined. Only a caller that omits the key gets the seed.
    planningModel:
      input.planningModel !== undefined
        ? input.planningModel
        : (defaults.defaultPlanningModel ?? null),
    defaultPermissionMode: input.defaultPermissionMode ?? defaults.defaultPermissionMode,
    concurrency: Math.max(1, Math.round(input.concurrency ?? defaults.concurrency)),
    useWorktrees: input.useWorktrees ?? true,
    baseBranch: input.baseBranch?.trim() ?? '',
    writeBackPlan: input.writeBackPlan ?? defaults.writeBackPlan,
    // Off unless asked for: releasing is the one thing a human is entitled to have
    // never happen by accident.
    autoRelease: input.autoRelease ?? false,
    // Off unless asked for, for the same reason: pushing a branch to somebody's forge
    // and opening a pull request on it is not something to start doing by surprise.
    autoCreatePr: input.autoCreatePr ?? false,
    // `null` unless the caller ruled: a new project inherits the app-wide switch and
    // keeps inheriting it, rather than freezing today's value into the row.
    autoIntegrate: input.autoIntegrate ?? null,
    // New projects are trusted as aligned; legacy projects backfill to false via the
    // store's own migration. A plan carrying `@needs:`/`@contract` is also confirmed
    // aligned on its next sync (see ipc `syncProjectPlan`).
    planAligned: input.planAligned ?? true,
    jiraEpicKeys: normalizeEpicKeys(input.jiraEpicKeys),
    ticketPrefix,
    target: input.target ?? defaults.defaultExecTarget,
    instructions: input.instructions?.trim() ?? '',
    color: input.color?.trim() ?? '',
    createdAt: Date.now(),
  };
}
