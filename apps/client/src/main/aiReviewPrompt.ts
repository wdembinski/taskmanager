/**
 * The prompt the AI visual reviewer (`forge/aiVisualReviewer.ts`) is started with — a fresh,
 * read-only session that judges a UI card's shots instead of waiting for the owner's Approve.
 *
 * Pure, so the exact text is unit-tested: what the ticket asked for, what the plan built, what
 * the builder itself said about each screen, and every real and mockup PNG as an absolute path
 * the session opens with Read. It ends by pinning the one fenced ```json block
 * `parseAiReviewVerdict` reads back — anything else in the answer is ignored.
 */
import { AI_REVIEW_RUBRIC } from '@shared/aiVisualReview';

/** One screen the reviewer judges: the real shot, the mockup it was built against (if any),
 *  and the builder's own `verdicts.txt` call on it. */
export interface AiReviewPromptScreen {
  name: string;
  /** The real shot's absolute path, on the machine the session runs on. */
  realPath: string;
  /** The mockup's absolute path, or absent for a screen with no mockup. */
  mockupPath?: string;
  builderStatus: 'ok' | 'mismatch' | 'unknown';
  /** Why, in the builder's own words — empty when it said nothing. */
  builderNote: string;
}

export interface AiReviewPromptInput {
  ticketTitle: string;
  /** The ticket's own text — `externalDescription ?? description`. */
  ticketText: string;
  /** The approved plan's step titles, in order. */
  stepTitles: readonly string[];
  screens: readonly AiReviewPromptScreen[];
  /** This review's number, 1-based. */
  round: number;
  /** The project's automatic fix rounds — so `maxRounds + 1` reviews in all. */
  maxRounds: number;
}

/** The verdict block the reviewer must end with — the shape `parseAiReviewVerdict` reads. */
export const AI_REVIEW_VERDICT_EXAMPLE = [
  '```json',
  '{"verdict":"approve","screens":[{"screen":"<name>","status":"ok","reason":""}],"outOfScope":[]}',
  '```',
].join('\n');

function builderLine(screen: AiReviewPromptScreen): string {
  if (screen.builderStatus === 'unknown') return 'the builder gave no verdict';
  const note = screen.builderNote.trim();
  return note
    ? `the builder said ${screen.builderStatus} — ${note}`
    : `the builder said ${screen.builderStatus}`;
}

export function buildAiReviewPrompt(input: AiReviewPromptInput): string {
  const steps =
    input.stepTitles.length > 0
      ? input.stepTitles.map((title, i) => `${i + 1}. ${title}`).join('\n')
      : '(no steps)';
  const screens = input.screens
    .map((s) =>
      [
        `- ${s.name} (${builderLine(s)})`,
        `  real:   ${s.realPath}`,
        `  mockup: ${s.mockupPath ?? 'none — judge the real shot against the ticket alone'}`,
      ].join('\n'),
    )
    .join('\n');
  const ticketText = input.ticketText.trim() || '(the ticket has no description)';

  return [
    `You are the visual reviewer for a UI change — review ${input.round} of ` +
      `${input.maxRounds + 1}. Decide whether the screenshots below show what the ticket ` +
      `asked for.`,
    '',
    'You are read-only: do not edit, write, create or delete anything, and do not run ' +
      'commands. Only look, and answer.',
    '',
    `## The ticket: ${input.ticketTitle}`,
    '',
    ticketText,
    '',
    "## The plan's steps",
    '',
    steps,
    '',
    '## The screens',
    '',
    'Each screen has a real shot and, where one exists, the mockup it was built against. ' +
      'These are absolute paths: open each with Read before you judge it.',
    '',
    screens,
    '',
    '## The rubric',
    '',
    AI_REVIEW_RUBRIC,
    '',
    '## Your answer',
    '',
    'Explain briefly, then END your answer with exactly one fenced json block of this shape, ' +
      'one entry per screen above:',
    '',
    AI_REVIEW_VERDICT_EXAMPLE,
    '',
    '- "verdict" is "approve" or "needs-changes"; any screen with "status": "mismatch" means ' +
      'needs-changes.',
    '- "reason" says what is wrong on a mismatch, concretely enough for someone to fix it; ' +
      'leave it empty on ok.',
    '- "outOfScope" lists differences you saw outside the ticket\'s scope — noted, never ' +
      'failed on.',
  ].join('\n');
}
