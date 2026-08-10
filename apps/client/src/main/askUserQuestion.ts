/**
 * Holding the CLI's own `AskUserQuestion` for a human — parsing what it asked, and
 * phrasing what the human answered so the agent can act on it.
 *
 * ## Why this exists
 *
 * The agent asked a real question, the app never showed it, and the run continued as if
 * it had been answered. The cause: `AskUserQuestion` is a normal tool call, the risk
 * policy auto-approved it (it neither deletes, pushes, nor touches secrets), and a CLI
 * running headless — `-p --output-format stream-json`, no terminal attached — resolves
 * its own question by taking its recommended option. Nothing was broken; nothing had been
 * told to stop.
 *
 * ## The answer channel, and why it is a `deny`
 *
 * The permission broker speaks two words: `allow` and `deny`. `allow` runs the tool, which
 * is precisely the bug — the CLI would answer itself again. So the human's choice must
 * travel back on `deny.message`, which the model receives as the tool's result. That is
 * not a workaround invented here: `PLAN_HANDOVER_MESSAGE` and `PLAN_REJECTED_MESSAGE`
 * already hand prose to the model through the same door.
 *
 * The consequence shapes {@link formatAnswerMessage}: because the model sees a denial as
 * an *error* result, the text must read as an ANSWER. Phrase it as a refusal and the agent
 * will politely ask the same question again.
 *
 * Pure and total, so all of this is testable without a CLI.
 */
import type { AttentionOption, AttentionQuestion } from '@shared/attention';

/** The CLI's built-in interactive question tool. */
export const ASK_USER_QUESTION_TOOL = 'AskUserQuestion';

/**
 * Whether a tool name is that tool. Tolerant of the `mcp__<server>__AskUserQuestion`
 * form, because a tool re-exported through an MCP server is the same tool with the same
 * consequence, and matching only the bare name would let that variant slip the gate.
 */
export function isAskUserQuestionTool(toolName: string): boolean {
  const name = toolName.trim().toLowerCase();
  const wanted = ASK_USER_QUESTION_TOOL.toLowerCase();
  return name === wanted || name.endsWith(`__${wanted}`);
}

/** How many questions/options we will render. Beyond this something has gone wrong upstream. */
const MAX_QUESTIONS = 8;
const MAX_OPTIONS = 12;

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function parseOption(raw: unknown): AttentionOption | null {
  if (typeof raw === 'string') {
    const label = raw.trim();
    return label ? { label } : null;
  }
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const label = text(o['label']) || text(o['name']) || text(o['value']);
  if (!label) return null;
  const description = text(o['description']);
  return description ? { label, description } : { label };
}

/**
 * Parse the tool's `input` into our shape.
 *
 * Deliberately forgiving: this is an undocumented internal payload, and a strict parser
 * that threw on an unexpected field would turn a shape change into "the agent silently
 * answers itself again" — the exact failure this module exists to end. Anything
 * unrecognised yields `[]`, and the caller then raises a free-text item, which still
 * blocks and is still answerable. Degrading to a plainer form is fine; degrading to
 * silence is not.
 */
export function parseAskUserQuestion(input: unknown): AttentionQuestion[] {
  if (!input || typeof input !== 'object') return [];
  const raw = (input as Record<string, unknown>)['questions'];
  if (!Array.isArray(raw)) return [];
  const out: AttentionQuestion[] = [];
  for (const entry of raw.slice(0, MAX_QUESTIONS)) {
    if (!entry || typeof entry !== 'object') continue;
    const q = entry as Record<string, unknown>;
    const question = text(q['question']) || text(q['prompt']) || text(q['header']);
    if (!question) continue;
    const options = Array.isArray(q['options'])
      ? (q['options'].slice(0, MAX_OPTIONS).map(parseOption).filter(Boolean) as AttentionOption[])
      : [];
    out.push({
      header: text(q['header']),
      question,
      multiSelect: q['multiSelect'] === true,
      options,
    });
  }
  return out;
}

/** A one-line summary for the inbox heading and the card. */
export function describeQuestions(questions: AttentionQuestion[]): string {
  if (questions.length === 0) return 'The agent has a question for you.';
  if (questions.length === 1) return questions[0].question;
  return `${questions[0].question} (and ${questions.length - 1} more)`;
}

/** What we hand back when the human explicitly declines to choose. */
export const DECLINED_ANSWER_MESSAGE =
  'The user read your question and chose not to pick an option. Use your best judgement ' +
  'and continue — do not ask again.';

/**
 * The message the agent receives as its tool result.
 *
 * Written as a report of a decision already taken, for a reason that is easy to get wrong:
 * it arrives as a DENIED tool call, i.e. an error, and an agent that reads an error tends
 * to retry. "Treat this as the tool's result and continue" is what converts a refusal the
 * model would work around into an answer it acts on.
 */
export function formatAnswerMessage(
  questions: AttentionQuestion[],
  selections: string[][],
  freeText?: (string | null)[],
  note?: string,
): string {
  const lines: string[] = [
    'The user answered your question. Treat this as the tool’s result and continue — ' +
      'do NOT ask the same question again.',
    '',
  ];

  const count = Math.max(questions.length, selections.length);
  for (let i = 0; i < count; i += 1) {
    const asked = questions[i]?.question ?? `Question ${i + 1}`;
    const picked = (selections[i] ?? []).map((s) => s.trim()).filter(Boolean);
    const typed = freeText?.[i]?.trim();
    // A typed answer is appended rather than substituted: "Postgres, and note that the
    // staging box is on 14" is one answer, and dropping either half loses the point.
    const parts = [...picked, ...(typed ? [typed] : [])];
    const answer = parts.length ? parts.join(', ') : '(no preference given)';
    lines.push(`${i + 1}. ${asked}`);
    lines.push(`   → ${answer}`);
  }

  const extra = note?.trim();
  if (extra) {
    lines.push('', `Additional instruction from the user: ${extra}`);
  }
  return lines.join('\n');
}
