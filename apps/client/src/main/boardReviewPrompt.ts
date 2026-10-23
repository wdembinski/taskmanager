/**
 * The prompt "Review open tickets" starts its one read-only session with — the hand review of
 * the TM board on 2026-10-18, made project-agnostic.
 *
 * Pure, so the exact text is unit-tested: the open tickets (with their epic, milestone, ticket
 * links and arrows), what is already done, how this orchestrator runs a card, the rubric, the
 * ready-lane cap and the one fenced ```json block `parseBoardReviewReport` reads back.
 *
 * Every ticket is named by a ref — `ticketKey ?? externalKey ?? '#<n>'`, made unique — and the
 * ref → task id map is returned beside the prompt, so the parser can read the report back
 * onto real rows. Only OPEN tickets are in that map: a verdict, a `mergeInto` or an `after`
 * naming a done ticket or an epic is not something Apply can act on.
 */
import { BOARD_REVIEW_RUBRIC } from '@shared/boardReview';
import type { Milestone, Task, TicketLink } from '@shared/model';
import type { TaskLink } from '@shared/taskChain';

/** An open ticket as the prompt reads it — a board card's own fields, so a `Task` fits. */
export type BoardReviewPromptTicket = Pick<
  Task,
  | 'id'
  | 'title'
  | 'status'
  | 'ticketKey'
  | 'externalKey'
  | 'externalDescription'
  | 'epicTaskId'
  | 'milestoneId'
>;

/** A done ticket or an epic: named, never described. */
export type BoardReviewPromptNamed = Pick<Task, 'id' | 'title' | 'ticketKey' | 'externalKey'>;

export interface BoardReviewPromptInput {
  projectName: string;
  /** The project's ready-lane cap — `0` means unlimited. */
  cap: number;
  /** Board cards not in the done column, epics excluded. */
  openTickets: readonly BoardReviewPromptTicket[];
  /** Finished tickets, newest first — only the first {@link DONE_TICKET_LIMIT} are listed. */
  doneTickets: readonly BoardReviewPromptNamed[];
  epics: readonly BoardReviewPromptNamed[];
  milestones: readonly Pick<Milestone, 'id' | 'name'>[];
  ticketLinks: readonly Pick<TicketLink, 'fromTaskId' | 'toTaskId' | 'type'>[];
  /** The board's arrows: `from` has to happen first, `to` waits. */
  taskLinks: readonly Pick<TaskLink, 'fromTaskId' | 'toTaskId' | 'gate'>[];
}

export interface BoardReviewPrompt {
  prompt: string;
  /** Ref → task id, open tickets only — what `parseBoardReviewReport` reads refs against. */
  refs: Record<string, string>;
}

/** A description longer than this is cut, so one essay of a ticket cannot crowd out the rest. */
export const DESCRIPTION_LIMIT = 6000;

/** How many of the latest done tickets the prompt lists. */
export const DONE_TICKET_LIMIT = 40;

/** The report the reviewer must end with — the shape `parseBoardReviewReport` reads. */
export const BOARD_REVIEW_EXAMPLE = [
  '```json',
  '{"summary":"<two or three sentences on the board as a whole>",',
  ' "tickets":[',
  '  {"ref":"TM-9","verdict":"OK","reason":"…","evidence":["src/a.ts:12 — …"]},',
  '  {"ref":"TM-10","verdict":"REWRITE","reason":"…","evidence":["src/b.ts:40 — …"],',
  '   "rewrite":{"title":"…","description":"…"}},',
  '  {"ref":"TM-11","verdict":"SPLIT","reason":"…","evidence":[],',
  '   "parts":[{"title":"…","description":"…"},{"title":"…","description":"…"}]},',
  '  {"ref":"TM-12","verdict":"MERGE","reason":"…","evidence":[],"mergeInto":"TM-10"},',
  '  {"ref":"TM-13","verdict":"DROP","reason":"…","evidence":["src/c.ts:7 — already does it"]},',
  '  {"ref":"TM-14","verdict":"REORDER","reason":"…","evidence":[],"after":["TM-9"]},',
  '  {"ref":"TM-15","verdict":"DECIDE","reason":"…","evidence":[],"question":"…?"}],',
  ' "hotFiles":[{"path":"src/a.ts","refs":["TM-9","TM-14"],"note":"…"}],',
  ' "waves":[{"refs":["TM-9","TM-10"],"note":"…"},{"refs":["TM-14"],"note":"…"}]}',
  '```',
].join('\n');

/**
 * Give every row a unique ref, open tickets first so they keep their own key when a done
 * ticket or an epic shares it. A keyless row is `#<n>`; a key seen twice gets `/2`, `/3`, ….
 */
function assignRefs(rows: readonly BoardReviewPromptNamed[]): Map<string, string> {
  const byId = new Map<string, string>();
  const taken = new Set<string>();
  let keyless = 0;
  for (const row of rows) {
    if (byId.has(row.id)) continue;
    const key = row.ticketKey?.trim() || row.externalKey?.trim();
    let ref: string;
    if (key) {
      ref = key;
      for (let n = 2; taken.has(ref); n++) ref = `${key}/${n}`;
    } else {
      do ref = `#${++keyless}`;
      while (taken.has(ref));
    }
    taken.add(ref);
    byId.set(row.id, ref);
  }
  return byId;
}

function truncate(text: string): string {
  if (text.length <= DESCRIPTION_LIMIT) return text;
  return (
    `${text.slice(0, DESCRIPTION_LIMIT)}\n` +
    `[… cut: ${text.length - DESCRIPTION_LIMIT} more characters]`
  );
}

/** "How this orchestrator runs a card" — the facts `planScopeLines` / `planQualityLines` give
 *  every planner, restated for someone judging whether a ticket is plannable at all. */
const HOW_A_CARD_RUNS = [
  '## How this orchestrator runs a card',
  '',
  '- A card is first PLANNED: one session reads the ticket and writes a plan whose headings ' +
    'are steps.',
  "- Each heading then becomes a separate agent SESSION in the card's worktree. Steps never " +
    'see the ticket or the document — only their own section and the framing ' +
    '(Context/Facts/Decisions). So a ticket has to carry, or point to, everything its work ' +
    'needs.',
  '- More than about six steps, or work across unrelated areas (engine and UI, server and ' +
    'desktop), is too big for one card: that is a SPLIT.',
  '- When the last step finishes the work goes up as a PR; the orchestrator merges this ' +
    'branch and runs the release itself afterwards. No ticket should ask for a merge or a ' +
    'release step.',
  '- Arrows gate starts: a card with an after-merge arrow into it does not start until the ' +
    'card the arrow comes from has MERGED. Cards with no arrow between them may run at the ' +
    'same time, and two such cards editing the same files collide at merge time.',
].join('\n');

/** The whole review prompt, plus the ref → task id map the parser reads it back with. */
export function buildBoardReviewPrompt(input: BoardReviewPromptInput): BoardReviewPrompt {
  const done = input.doneTickets.slice(0, DONE_TICKET_LIMIT);
  const refById = assignRefs([...input.openTickets, ...done, ...input.epics]);
  const refOf = (id: string): string | null => refById.get(id) ?? null;
  const titleById = new Map<string, string>();
  for (const row of [...input.openTickets, ...done, ...input.epics]) {
    titleById.set(row.id, row.title);
  }
  const named = (id: string): string => {
    const ref = refOf(id);
    if (!ref) return '(a ticket not on this board)';
    return `${ref} "${titleById.get(id) ?? ''}"`;
  };
  const epicTitle = new Map(input.epics.map((e) => [e.id, e.title]));
  const milestoneName = new Map(input.milestones.map((m) => [m.id, m.name]));

  const refs: Record<string, string> = {};
  for (const t of input.openTickets) refs[refById.get(t.id)!] = t.id;

  const ticketBlock = (t: BoardReviewPromptTicket): string => {
    const ref = refById.get(t.id)!;
    const lines = [`### ${ref} — ${t.title}`, '', `- Status: ${t.status}`];
    lines.push(
      `- Epic: ${t.epicTaskId ? (epicTitle.get(t.epicTaskId) ?? '(an epic not listed)') : 'none'}`,
    );
    lines.push(
      `- Milestone: ${
        t.milestoneId ? (milestoneName.get(t.milestoneId) ?? '(a milestone not listed)') : 'none'
      }`,
    );
    const after = input.taskLinks.filter((l) => l.toTaskId === t.id);
    const before = input.taskLinks.filter((l) => l.fromTaskId === t.id);
    lines.push(
      `- Arrows in (runs after): ${
        after.length ? after.map((l) => `${named(l.fromTaskId)} [${l.gate}]`).join('; ') : 'none'
      }`,
    );
    lines.push(
      `- Arrows out (runs before): ${
        before.length ? before.map((l) => `${named(l.toTaskId)} [${l.gate}]`).join('; ') : 'none'
      }`,
    );
    const links = input.ticketLinks.flatMap((l) =>
      l.fromTaskId === t.id
        ? [`${l.type} ${named(l.toTaskId)}`]
        : l.toTaskId === t.id
          ? [`${named(l.fromTaskId)} ${l.type} this`]
          : [],
    );
    lines.push(`- Ticket links: ${links.length ? links.join('; ') : 'none'}`);
    const text = t.externalDescription?.trim();
    lines.push('', text ? truncate(text) : '(no description)');
    return lines.join('\n');
  };

  const open = input.openTickets.length
    ? input.openTickets.map(ticketBlock).join('\n\n')
    : '(no open tickets)';
  const doneList = done.length
    ? done.map((t) => `- ${refById.get(t.id)} — ${t.title}`).join('\n')
    : '(nothing done yet)';
  const epics = input.epics.length
    ? input.epics.map((e) => `- ${refById.get(e.id)} — ${e.title}`).join('\n')
    : '(no epics)';
  const milestones = input.milestones.length
    ? input.milestones.map((m) => `- ${m.name}`).join('\n')
    : '(no milestones)';
  const waveRule =
    input.cap > 0
      ? `This project runs at most ${input.cap} ready cards at once (its ready-lane cap), so ` +
        `no wave may hold more than ${input.cap} tickets.`
      : 'This project has no cap on ready cards at once (no cap), so a wave may be any size — ' +
        'but tickets in one wave must still not touch the same files.';

  const prompt = [
    `You are reviewing the open tickets of the project "${input.projectName}" against its ` +
      `code, in this repository. Give every open ticket exactly one verdict, find the files ` +
      `several of them touch, and order them into waves that can run side by side.`,
    '',
    'You are read-only: do not edit, write, create or delete anything, and do not run ' +
      'commands. Read the code, and answer. Nothing you recommend is applied without the ' +
      "owner's click.",
    '',
    HOW_A_CARD_RUNS,
    '',
    `## Open tickets (${input.openTickets.length})`,
    '',
    'Each is named by its ref — use exactly these refs in your answer.',
    '',
    open,
    '',
    `## Done tickets (latest ${done.length})`,
    '',
    'Already finished — titles only. A ticket that repeats one of these is a DROP or a MERGE.',
    '',
    doneList,
    '',
    '## Epics',
    '',
    epics,
    '',
    '## Milestones',
    '',
    milestones,
    '',
    '## The rubric',
    '',
    'Exactly one verdict per open ticket:',
    '',
    BOARD_REVIEW_RUBRIC,
    '',
    '## Hot files',
    '',
    'For every open ticket, find the files its work would edit. List each file that two or ' +
      'more open tickets would edit under "hotFiles", with the refs that touch it — those ' +
      'tickets must not run at the same time, so give them an order (REORDER) or put them in ' +
      'different waves.',
    '',
    '## Waves',
    '',
    'Order the tickets you keep (everything but DROP and MERGE) into waves: wave 1 can start ' +
      'now, each later wave after the one before it has merged. Tickets in one wave must not ' +
      'share a hot file or depend on each other.',
    waveRule,
    '',
    '## Evidence',
    '',
    'Back every verdict with evidence from the code (path:line): what is already there, what ' +
      'is missing, which file the work lands in. A verdict with no evidence is a guess.',
    '',
    '## Your answer',
    '',
    'Explain briefly, then END your answer with exactly one fenced json block of this shape, ' +
      'one "tickets" entry per open ticket above:',
    '',
    BOARD_REVIEW_EXAMPLE,
    '',
    '- "verdict" is one of OK, REWRITE, SPLIT, MERGE, DROP, REORDER, DECIDE; add only the ' +
      'field the rubric names for it.',
    '- "mergeInto" and "after" name other OPEN tickets by their ref.',
    '- "evidence" lines are `path:line — what it shows`.',
  ].join('\n');

  return { prompt, refs };
}
