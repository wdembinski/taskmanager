/**
 * Question detection (Phase 4) — pure, unit-tested.
 *
 * PERMISSIONS no longer come from watching the event stream — they are vetoed
 * pre-execution by the permission broker + MCP tool (see `permissionBroker.ts`).
 * What remains here is detecting when Claude asks the HUMAN a question mid-task.
 *
 * Rather than guess from prose (the old "message ends in ?" heuristic, which both
 * missed multi-line questions and fired on rhetorical ones), we define an
 * explicit contract: the task prompt instructs Claude to prefix a line with a
 * sentinel when — and only when — it needs a human decision to continue. Here we
 * detect that sentinel deterministically. `NEEDS_INPUT_SENTINEL` is the single
 * source of truth, shared with the prompt builder so the two never drift.
 */
import type { SessionEvent } from '@shared/session';
export { NEEDS_INPUT_SENTINEL } from '@shared/planCheck';
import { NEEDS_INPUT_SENTINEL } from '@shared/planCheck';

/** A detected clarifying question, optionally with discrete choices to offer. */
export interface DetectedQuestion {
  kind: 'question';
  prompt: string;
  /** Multiple-choice options (empty = free-text answer expected). */
  options: string[];
}

/**
 * Extract the question from an assistant message if it uses the sentinel, else
 * `null`. The sentinel only counts when it starts a (trimmed) line — a message
 * that quotes it, negates it, or explains the convention in prose is not itself
 * asking a question, so a mid-line occurrence must not trigger a false positive.
 * The question is the text on that sentinel line, with the sentinel stripped; any
 * following lines that are dash/asterisk bullets (`- SQLite`) are parsed as
 * multiple-choice OPTIONS. This lets Claude offer concrete choices the human
 * answers in one click, while a bare question (no bullets) stays a free-text
 * prompt.
 */
export function detectQuestion(text: string): DetectedQuestion | null {
  const lines = text.split('\n');
  const i = lines.findIndex((line) => line.trim().startsWith(NEEDS_INPUT_SENTINEL));
  if (i === -1) return null;

  const firstLine = lines[i].trim().slice(NEEDS_INPUT_SENTINEL.length);
  const rest = lines.slice(i + 1);
  const options: string[] = [];
  const prose: string[] = [];
  for (const line of rest) {
    const bullet = line.match(/^\s*[-*]\s+(.+?)\s*$/);
    if (bullet) options.push(bullet[1]);
    else if (line.trim()) prose.push(line.trim());
  }

  // The question is the sentinel line; if that was empty, fall back to any
  // non-bullet prose that followed, then to a generic prompt.
  const prompt = firstLine.trim() || prose.join(' ') || 'Claude needs input to continue.';
  return { kind: 'question', prompt, options };
}

/**
 * Classify one event. Returns a detected question, or `null` when the event needs
 * no human. Pure and side-effect free.
 */
export function detectAttention(event: SessionEvent): DetectedQuestion | null {
  if (event.kind === 'assistant') return detectQuestion(event.text);
  return null;
}

// ---- Cross-agent negotiation (Phase D) -----------------------------------
//
// Parallel agents don't only ask the HUMAN questions — sometimes one wants to
// change the SHARED approach mid-flight (an interface in CONTRACT.md, a file
// split). Instead of editing the contract unilaterally (and colliding at
// integration), the agent raises a **proposal**; the orchestrator asks the
// affected in-flight teammates to AGREE or OBJECT in a single round. Same idea as
// the question sentinel — an explicit marker line, detected deterministically —
// so agents and orchestrator never drift on the wire format.

/** Marker an agent puts at the start of a line to propose a shared-approach change. */
export const PROPOSE_SENTINEL = '@@PROPOSE@@';
/** Marker a teammate uses to accept a proposal. */
export const AGREE_SENTINEL = '@@AGREE@@';
/** Marker a teammate uses to reject a proposal (followed by a reason). */
export const OBJECT_SENTINEL = '@@OBJECT@@';

/** A proposal an agent raised to change the shared approach. */
export interface DetectedProposal {
  kind: 'proposal';
  /** What the agent wants to change (the text on the sentinel line). */
  text: string;
  /** Files/areas the change touches, parsed from following `- ` bullets (may be empty). */
  files: string[];
}

/** A teammate's response to a proposal. */
export interface DetectedResponse {
  position: 'agree' | 'object';
  /** For an objection, the stated reason (empty when none / on agreement). */
  reason: string;
}

/**
 * Extract a proposal from an assistant message if it uses the sentinel, else
 * `null`. Mirrors `detectQuestion`: the proposal text is the sentinel line; any
 * following `- `/`* ` bullets are parsed as the affected files/areas (used to find
 * which teammates the change touches — best-effort, falls back to all siblings).
 */
export function detectProposal(text: string): DetectedProposal | null {
  const index = text.indexOf(PROPOSE_SENTINEL);
  if (index === -1) return null;

  const after = text.slice(index + PROPOSE_SENTINEL.length);
  const [firstLine, ...rest] = after.split('\n');
  const files: string[] = [];
  const prose: string[] = [];
  for (const line of rest) {
    const bullet = line.match(/^\s*[-*]\s+(.+?)\s*$/);
    if (bullet) files.push(bullet[1]);
    else if (line.trim()) prose.push(line.trim());
  }
  const proposalText = firstLine.trim() || prose.join(' ') || 'A teammate proposes a change.';
  return { kind: 'proposal', text: proposalText, files };
}

/**
 * Extract a teammate's AGREE/OBJECT response, else `null`. An objection takes
 * precedence over agreement if both markers appear (fail safe — a mixed reply is
 * treated as dissent). The reason is the remaining text on the objection line.
 */
export function detectResponse(text: string): DetectedResponse | null {
  const obj = text.indexOf(OBJECT_SENTINEL);
  if (obj !== -1) {
    const reason = text
      .slice(obj + OBJECT_SENTINEL.length)
      .split('\n')[0]
      .trim();
    return { position: 'object', reason };
  }
  const agree = text.indexOf(AGREE_SENTINEL);
  if (agree !== -1) return { position: 'agree', reason: '' };
  return null;
}

/** One row of a CONTRACT.md `## File ownership` map: an owner and the files/globs it owns. */
export interface OwnershipEntry {
  /** The owning task/area, as free text (matched leniently against sibling titles). */
  owner: string;
  /** The path/glob tokens found on the line (e.g. `src/api/**`, `store.ts`). */
  globs: string[];
}

/**
 * Parse the `## File ownership` section of a prose `CONTRACT.md` into owner→globs
 * rows. Deliberately lenient: it scans bullet lines under any "file ownership"
 * heading and pulls out path/glob-looking tokens; whatever text remains is the
 * owner. Handles `- src/api/** — Build API`, `- Build API: src/api/**`, etc.
 * Overlap detection is best-effort — the caller falls back to "all siblings" when
 * nothing parses — so imperfect prose degrades safely rather than mis-routing.
 */
export function parseFileOwnership(markdown: string): OwnershipEntry[] {
  const entries: OwnershipEntry[] = [];
  let inSection = false;
  for (const raw of markdown.split('\n')) {
    const line = raw.trimEnd();
    const heading = line.match(/^#{1,6}\s+(.*)$/);
    if (heading) {
      inSection = /file\s*ownership/i.test(heading[1]);
      continue;
    }
    if (!inSection) continue;
    const bullet = line.match(/^\s*[-*]\s+(.+?)\s*$/);
    if (!bullet) continue;
    const content = bullet[1];
    // A token is glob-like if it has a path separator or wildcard, or looks like a
    // filename (`name.ext`). Everything else is prose we treat as the owner.
    const globs =
      content.match(/[A-Za-z0-9_./*-]*[/*][A-Za-z0-9_./*-]*|[A-Za-z0-9_-]+\.[A-Za-z0-9]+/g) ?? [];
    let owner = content;
    for (const g of globs) owner = owner.replace(g, ' ');
    owner = owner
      .replace(/[—:(),`]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    entries.push({ owner, globs });
  }
  return entries;
}

/** Turn a leniently-parsed glob into an anchored RegExp (`*`=segment, `**`=any). */
function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const pattern = escaped
    .replace(/\*\*/g, ' ') // placeholder so the single-* pass skips it
    .replace(/\*/g, '[^/]*')
    .replace(/ /g, '.*');
  return new RegExp(`^${pattern}$`);
}

/**
 * Whether a proposal's named file matches an ownership glob. Best-effort and
 * intentionally generous (a false positive only widens who we consult, which is
 * safe): tries glob→file and file→glob (a proposal may name a broader path than
 * the contract), then a substring fallback for informal prose.
 */
export function fileMatchesGlob(file: string, glob: string): boolean {
  const f = file.trim();
  const g = glob.trim();
  if (!f || !g) return false;
  if (f === g) return true;
  try {
    if (globToRegExp(g).test(f)) return true;
    if (globToRegExp(f).test(g)) return true;
  } catch {
    // Malformed token — fall through to the substring check.
  }
  return f.includes(g) || g.includes(f);
}

/**
 * Given a proposal's files, the parsed contract ownership, and the titles of the
 * in-flight sibling tasks, decide which siblings the proposal affects. Falls back
 * to **all** siblings when the proposal names no files, the contract has no
 * parseable ownership, or nothing matches — so a change is never silently routed
 * past a teammate it might impact. Pure and unit-tested.
 */
export function siblingsAffectedByProposal(
  proposalFiles: readonly string[],
  ownership: readonly OwnershipEntry[],
  siblingTitles: readonly string[],
): string[] {
  const all = [...new Set(siblingTitles)];
  if (proposalFiles.length === 0 || ownership.length === 0) return all;

  const hitOwners = ownership
    .filter((entry) => entry.globs.some((g) => proposalFiles.some((f) => fileMatchesGlob(f, g))))
    .map((entry) => entry.owner.toLowerCase())
    .filter((owner) => owner.length > 0);
  if (hitOwners.length === 0) return all;

  const affected = all.filter((title) => {
    const t = title.toLowerCase();
    return hitOwners.some((owner) => owner.includes(t) || t.includes(owner));
  });
  return affected.length > 0 ? affected : all;
}

/**
 * Tally one consensus round. Unanimous agreement (and at least one voter) is the
 * only path that auto-applies a proposal; anything else — an objection, or a
 * non-responder mapped to `object` on timeout — is `contested` and goes to the
 * human. An empty set is vacuously `agree` (no affected teammate to consult).
 */
export function tallyConsensus(positions: readonly ('agree' | 'object')[]): 'agree' | 'contested' {
  return positions.every((p) => p === 'agree') ? 'agree' : 'contested';
}
