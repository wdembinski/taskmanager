/**
 * The pure half of "Review open tickets" — one read-only agent run that reads a project's
 * open tickets against its repo and ends with a fenced JSON report: one verdict per ticket,
 * the files several tickets touch, and the waves they can run in.
 *
 * The prompt names every ticket by a ref (`ticketKey ?? externalKey ?? '#<n>'`) and hands
 * the parser the ref → task id map it used, so the report is read back onto real rows.
 * Nothing here applies anything: {@link boardReviewRecommendations} only lists what the
 * owner can Apply, one button each.
 */

/** The seven calls the reviewer can make on an open ticket — exactly one each. */
export const BOARD_REVIEW_VERDICTS = [
  'OK',
  'REWRITE',
  'SPLIT',
  'MERGE',
  'DROP',
  'REORDER',
  'DECIDE',
] as const;

export type BoardReviewVerdict = (typeof BOARD_REVIEW_VERDICTS)[number];

/**
 * The rubric the reviewer judges by — one line per verdict: when to use it, and the field
 * it requires. Quoted verbatim in the review prompt.
 */
export const BOARD_REVIEW_RUBRIC = [
  '- OK — the ticket is clear, still needed, sized for one card and in the right order. No extra field.',
  '- REWRITE — still needed, but the title or description is vague, stale or wrong about the code. Requires "rewrite": {"title", "description"}.',
  '- SPLIT — too big for one card (more than ~6 steps, or unrelated changes). Requires "parts": at least 2 {"title", "description"}, in the order they should run.',
  '- MERGE — duplicates or is a slice of another open ticket. Requires "mergeInto": the ref of the ticket that absorbs it.',
  '- DROP — already done in the code, obsolete, or no longer wanted. No extra field; say why in "reason".',
  '- REORDER — fine as written, but must not start before other open tickets land (they touch the same files or it builds on them). Requires "after": the refs it must run after.',
  '- DECIDE — cannot be worked without a choice only the owner can make. Requires "question": that choice, asked in one sentence.',
].join('\n');

/** One new ticket a SPLIT proposes, or the new text a REWRITE proposes. */
export interface BoardReviewText {
  title: string;
  description: string;
}

/** The reviewer's call on one open ticket, read back onto its row. */
export interface BoardReviewTicket {
  /** The ref the prompt named the ticket by. */
  ref: string;
  taskId: string;
  verdict: BoardReviewVerdict;
  reason: string;
  /** `path:line — what it shows` lines the reviewer backed the call with. */
  evidence: string[];
  /** REWRITE only. */
  rewrite?: BoardReviewText;
  /** SPLIT only — at least two, in run order. */
  parts?: BoardReviewText[];
  /** MERGE only — the ref of the ticket that absorbs this one. */
  mergeInto?: string;
  /** REORDER only — the refs this ticket must run after. */
  after?: string[];
  /** DECIDE only. */
  question?: string;
}

/** A file several open tickets touch — the overlap that needs an order. */
export interface BoardReviewHotFile {
  path: string;
  refs: string[];
  note: string;
}

/** Tickets that can run side by side — at most the project's ready-lane cap. */
export interface BoardReviewWave {
  refs: string[];
  note: string;
}

/** The parsed report. `warnings` are the parser's own: what it dropped or downgraded. */
export interface BoardReviewReport {
  summary: string;
  tickets: BoardReviewTicket[];
  hotFiles: BoardReviewHotFile[];
  waves: BoardReviewWave[];
  warnings: string[];
}

/** What applying one recommendation did — stored so it is never applied twice. */
export interface BoardReviewApplied {
  at: number;
  ok: boolean;
  message: string;
}

/** One `board_reviews` row: the latest per project is what the view shows. */
export interface BoardReviewRecord {
  id: string;
  projectId: string;
  status: 'running' | 'done' | 'failed';
  startedAt: number;
  finishedAt: number | null;
  report: BoardReviewReport | null;
  error: string | null;
  /** Keyed by recommendation id ({@link BoardReviewRecommendation.id}). */
  applied: Record<string, BoardReviewApplied>;
}

/** One Apply button: a non-OK ticket's verdict. */
export interface BoardReviewRecommendation {
  /** The ticket's ref — one recommendation per ticket. */
  id: string;
  taskId: string;
  verdict: Exclude<BoardReviewVerdict, 'OK'>;
  label: string;
}

export type BoardReviewParse =
  { ok: true; report: BoardReviewReport } | { ok: false; error: string };

const JSON_FENCE = /```json[^\n]*\n([\s\S]*?)```/gi;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isVerdict(value: unknown): value is BoardReviewVerdict {
  return (BOARD_REVIEW_VERDICTS as readonly unknown[]).includes(value);
}

function nonEmpty(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** A `{title, description}` with a title, or null. */
function parseText(value: unknown): BoardReviewText | null {
  if (!isRecord(value)) return null;
  const title = nonEmpty(value.title);
  if (!title) return null;
  return {
    title,
    description: typeof value.description === 'string' ? value.description.trim() : '',
  };
}

/** An optional array of strings: `[]` when absent, null when the wrong shape. */
function stringList(value: unknown): string[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((s) => typeof s !== 'string')) return null;
  return (value as string[]).map((s) => s.trim()).filter(Boolean);
}

/** Keep the refs the prompt named, warning once for each one it did not. */
function knownRefs(
  list: readonly string[],
  refs: Readonly<Record<string, string>>,
  where: string,
  warnings: string[],
): string[] {
  const kept: string[] = [];
  for (const ref of list) {
    if (!Object.hasOwn(refs, ref)) warnings.push(`${where}: unknown ref ${ref} dropped.`);
    else if (!kept.includes(ref)) kept.push(ref);
  }
  return kept;
}

type RawTicket = { ref: string; verdict: BoardReviewVerdict; raw: Record<string, unknown> };

/**
 * The verdict's required field, or the reason it is missing. A missing field downgrades
 * that one ticket to OK (with a warning); it never fails the report.
 */
function verdictFields(
  t: RawTicket,
  refs: Readonly<Record<string, string>>,
  warnings: string[],
): Partial<BoardReviewTicket> | string {
  const { raw } = t;
  switch (t.verdict) {
    case 'OK':
    case 'DROP':
      return {};
    case 'REWRITE': {
      const rewrite = parseText(raw.rewrite);
      return rewrite ? { rewrite } : 'REWRITE without a "rewrite" title';
    }
    case 'SPLIT': {
      const parts = Array.isArray(raw.parts) ? raw.parts.map(parseText) : [];
      const valid = parts.filter((p): p is BoardReviewText => p !== null);
      if (valid.length < 2 || valid.length !== parts.length) {
        return 'SPLIT needs at least 2 "parts", each with a title';
      }
      return { parts: valid };
    }
    case 'MERGE': {
      const target = nonEmpty(raw.mergeInto);
      if (!target) return 'MERGE without "mergeInto"';
      if (target === t.ref) return 'MERGE into itself';
      if (!Object.hasOwn(refs, target)) return `MERGE into unknown ref ${target}`;
      return { mergeInto: target };
    }
    case 'REORDER': {
      const list = stringList(raw.after);
      if (!list || list.length === 0) return 'REORDER without "after"';
      const after = knownRefs(
        list.filter((r) => r !== t.ref),
        refs,
        `${t.ref} after`,
        warnings,
      );
      return after.length > 0 ? { after } : 'REORDER after no known ticket';
    }
    case 'DECIDE': {
      const question = nonEmpty(raw.question);
      return question ? { question } : 'DECIDE without "question"';
    }
  }
}

/**
 * The report out of the review run's `resultText` — its LAST fenced ```json block, so a
 * reviewer that drafts one and then corrects itself is read by its final answer.
 *
 * - A shape error (no block, bad JSON, a non-array `tickets`, an unknown verdict, …) fails
 *   the whole report: a half-read report is never shown as if it were whole.
 * - A ticket whose ref the prompt never named is dropped with a warning, as is any such ref
 *   inside `after`, `hotFiles` or `waves`.
 * - A verdict missing its required field ({@link BOARD_REVIEW_RUBRIC}) falls back to OK with
 *   a warning, so it offers no Apply button.
 * - A wave larger than `cap` (the project's ready-lane cap) is kept with a warning; a cap of
 *   0 means unlimited and never warns.
 */
export function parseBoardReviewReport(
  resultText: string,
  refs: Readonly<Record<string, string>>,
  cap: number,
): BoardReviewParse {
  const blocks = [...resultText.matchAll(JSON_FENCE)];
  const last = blocks[blocks.length - 1];
  if (!last) return { ok: false, error: 'The review ended without a fenced json report.' };
  let raw: unknown;
  try {
    raw = JSON.parse(last[1]);
  } catch (err) {
    return { ok: false, error: `The report is not valid JSON: ${(err as Error).message}` };
  }
  if (!isRecord(raw)) return { ok: false, error: 'The report is not a JSON object.' };
  if (raw.summary !== undefined && typeof raw.summary !== 'string') {
    return { ok: false, error: '"summary" is not a string.' };
  }
  if (!Array.isArray(raw.tickets)) return { ok: false, error: '"tickets" is not an array.' };
  if (raw.hotFiles !== undefined && !Array.isArray(raw.hotFiles)) {
    return { ok: false, error: '"hotFiles" is not an array.' };
  }
  if (raw.waves !== undefined && !Array.isArray(raw.waves)) {
    return { ok: false, error: '"waves" is not an array.' };
  }

  const warnings: string[] = [];
  const tickets: BoardReviewTicket[] = [];
  for (const [i, value] of raw.tickets.entries()) {
    if (!isRecord(value)) return { ok: false, error: `tickets[${i}] is not an object.` };
    const ref = nonEmpty(value.ref);
    if (!ref) return { ok: false, error: `tickets[${i}] has no "ref".` };
    if (!isVerdict(value.verdict)) {
      return { ok: false, error: `${ref}: unknown verdict ${JSON.stringify(value.verdict)}.` };
    }
    if (value.reason !== undefined && typeof value.reason !== 'string') {
      return { ok: false, error: `${ref}: "reason" is not a string.` };
    }
    const evidence = stringList(value.evidence);
    if (!evidence) return { ok: false, error: `${ref}: "evidence" is not a list of strings.` };

    if (!Object.hasOwn(refs, ref)) {
      warnings.push(`Unknown ticket ${ref} dropped.`);
      continue;
    }
    if (tickets.some((t) => t.ref === ref)) {
      warnings.push(`${ref} was reviewed twice; the first verdict is kept.`);
      continue;
    }
    const base = {
      ref,
      taskId: refs[ref],
      reason: typeof value.reason === 'string' ? value.reason.trim() : '',
      evidence,
    };
    const fields = verdictFields({ ref, verdict: value.verdict, raw: value }, refs, warnings);
    if (typeof fields === 'string') {
      warnings.push(`${ref}: ${fields} — treated as OK.`);
      tickets.push({ ...base, verdict: 'OK' });
    } else {
      tickets.push({ ...base, verdict: value.verdict, ...fields });
    }
  }

  const hotFiles: BoardReviewHotFile[] = [];
  for (const [i, value] of (raw.hotFiles ?? []).entries()) {
    if (!isRecord(value)) return { ok: false, error: `hotFiles[${i}] is not an object.` };
    const path = nonEmpty(value.path);
    if (!path) return { ok: false, error: `hotFiles[${i}] has no "path".` };
    const list = stringList(value.refs);
    if (!list) return { ok: false, error: `hotFiles[${i}]: "refs" is not a list of strings.` };
    hotFiles.push({
      path,
      refs: knownRefs(list, refs, `Hot file ${path}`, warnings),
      note: typeof value.note === 'string' ? value.note.trim() : '',
    });
  }

  const waves: BoardReviewWave[] = [];
  for (const [i, value] of (raw.waves ?? []).entries()) {
    if (!isRecord(value)) return { ok: false, error: `waves[${i}] is not an object.` };
    const list = stringList(value.refs);
    if (!list) return { ok: false, error: `waves[${i}]: "refs" is not a list of strings.` };
    const wave = {
      refs: knownRefs(list, refs, `Wave ${i + 1}`, warnings),
      note: typeof value.note === 'string' ? value.note.trim() : '',
    };
    if (cap > 0 && wave.refs.length > cap) {
      warnings.push(
        `Wave ${i + 1} has ${wave.refs.length} tickets, more than the ready-lane cap of ${cap}.`,
      );
    }
    waves.push(wave);
  }

  return {
    ok: true,
    report: {
      summary: typeof raw.summary === 'string' ? raw.summary.trim() : '',
      tickets,
      hotFiles,
      waves,
      warnings,
    },
  };
}

function recommendationLabel(t: BoardReviewTicket): string {
  switch (t.verdict) {
    case 'REWRITE':
      return `Rewrite ${t.ref} as "${t.rewrite?.title ?? ''}"`;
    case 'SPLIT':
      return `Split ${t.ref} into ${t.parts?.length ?? 0} tickets`;
    case 'MERGE':
      return `Merge ${t.ref} into ${t.mergeInto ?? ''}`;
    case 'DROP':
      return `Drop ${t.ref}`;
    case 'REORDER':
      return `Run ${t.ref} after ${(t.after ?? []).join(', ')}`;
    case 'DECIDE':
      return `Ask on ${t.ref}: ${t.question ?? ''}`;
    case 'OK':
      return t.ref;
  }
}

/** One Apply button per non-OK ticket, in report order, keyed by the ticket's ref. */
export function boardReviewRecommendations(report: BoardReviewReport): BoardReviewRecommendation[] {
  return report.tickets
    .filter(
      (t): t is BoardReviewTicket & { verdict: BoardReviewRecommendation['verdict'] } =>
        t.verdict !== 'OK',
    )
    .map((t) => ({
      id: t.ref,
      taskId: t.taskId,
      verdict: t.verdict,
      label: recommendationLabel(t),
    }));
}
