/**
 * The card's timeline as a **conversation** (Phase 12, phase 5) — pure and unit-tested.
 *
 * The detail pane used to render one row per entry: a note, a JIRA comment, and every
 * transcript line the noise filter let through. A conversation needs less and more than
 * that — less, because a run's tool chatter is one fact ("it did 12 things"), and more,
 * because who said something decides which side of the pane it sits on.
 *
 * The taxonomy (the user's spec — one axis for *who*, one for *where it came from*):
 *
 *   your chat message  → right, blue
 *   your note          → right, blue (lighter — nobody but you ever reads it)
 *   your status update → right, blue (lighter), tagged with the keyword's colour
 *   your JIRA comment  → right, blue, tagged `JIRA` (it left the app)
 *   someone else's     → left, grey, with their name
 *   the agent          → left, FULL WIDTH, unbubbled (tables and code need the width)
 *
 * Status changes are deliberately absent: they belong to the Details tab, not to a
 * conversation. Nothing else is dropped — tool work is folded, not hidden, and anything
 * this module does not understand still reaches the pane as a system line.
 */
import type { SessionEvent } from '@shared/session';
import type { TaskActivityEntry } from '@shared/model';
import type { AdfBlock, CommentAttachment } from '@shared/adf';

/** Tool names the CLI uses to spawn a sub-agent — worth naming in a folded row. */
const SUBAGENT_TOOLS = new Set(['task', 'agent']);

export type Turn =
  /** Something the human wrote. `variant` picks the fill and the `JIRA` tag. */
  | {
      key: string;
      kind: 'you';
      variant: 'chat' | 'note' | 'jira' | 'status';
      body: string;
      createdAt: number;
      /** Only a note can be deleted — the other two were read by someone else. */
      commentId: number | null;
      /** A ticket comment's structure, when it had any (mentions, links, code). */
      rich?: AdfBlock[];
      attachments?: CommentAttachment[];
    }
  /** Someone else's ticket comment. */
  | {
      key: string;
      kind: 'them';
      author: string;
      body: string;
      createdAt: number;
      rich?: AdfBlock[];
      attachments?: CommentAttachment[];
    }
  /** The agent's prose, markdown as written. */
  | { key: string; kind: 'agent'; text: string; createdAt: number }
  /** A run of tool work, collapsed to one line ("Worked with 12 tools"). */
  | { key: string; kind: 'tools'; count: number; labels: string[]; createdAt: number }
  /** Anything else the transcript carries: results, limits, errors, stderr. */
  | { key: string; kind: 'system'; text: string; tone: 'meta' | 'err'; createdAt: number };

/** Read a sub-agent's description out of a `Task` tool call, for the folded label. */
function subAgentLabel(input: Record<string, unknown> | undefined): string | null {
  const value = input?.description ?? input?.subagent_type;
  if (typeof value !== 'string' || !value.trim()) return null;
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat.length > 60 ? `${flat.slice(0, 60)}…` : flat;
}

/**
 * True for the events that are *work*, not speech — the ones a run folds together.
 *
 * A BENIGN failure counts as work: a stale edit or an unread file is something the agent
 * fixes on its own next turn, and interrupting the thread to announce it reports a problem
 * that was over before you finished reading about it. A real failure still breaks out.
 */
function isToolWork(event: SessionEvent): boolean {
  if (event.kind === 'thinking' || event.kind === 'tool-use') return true;
  return event.kind === 'tool-result' && (!event.isError || event.benign === true);
}

/** Keep a failure reason to one readable line — the full text is in the transcript. */
function briefly(text: string | undefined, max = 160): string {
  const flat = (text ?? '').replace(/\s+/g, ' ').trim();
  if (!flat) return '';
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/**
 * What a non-speech, non-tool event says in one line, or null to drop it. `started`
 * and `usage` are bookkeeping the human never asked about; everything else is either
 * the end of a turn or something that went wrong, and both matter.
 */
function systemLine(event: SessionEvent): { text: string; tone: 'meta' | 'err' } | null {
  switch (event.kind) {
    case 'result':
      return event.success
        ? { text: 'The agent finished this turn.', tone: 'meta' }
        : {
            text: `The run ended without finishing${event.stopReason ? ` (${event.stopReason})` : ''}.`,
            tone: 'err',
          };
    case 'rate-limit':
      // Healthy signals (`allowed`, `allowed_warning`) never reach the renderer — the
      // engine drops them at the emit boundary — so anything arriving here is a real
      // block. Said in words, because `allowed (five_hour)` in red meant nothing to anyone.
      return { text: 'Paused — Claude’s usage limit was reached.', tone: 'err' };
    case 'tool-result': {
      // Only genuine failures reach this line (`isToolWork` folds the benign ones away),
      // and they now carry their reason. "A tool call failed." with no detail was the
      // worst kind of log line: alarming and useless.
      const reason = briefly(event.errorText);
      return {
        text: reason ? `A tool call failed — ${reason}` : 'A tool call failed.',
        tone: 'err',
      };
    }
    case 'stderr':
      return { text: event.text.trim(), tone: 'err' };
    case 'exited':
      return event.code === 0 ? null : { text: `The session exited (${event.code}).`, tone: 'err' };
    default:
      return null; // started / usage / thinking-outside-a-run: nothing to say
  }
}

/**
 * Fold a sorted activity list into conversation turns.
 *
 * Consecutive events of a kind are merged: the agent's chunks become one turn (the CLI
 * streams prose in pieces, and a bubble per piece would shred a paragraph), and a run of
 * tool work becomes one collapsed row carrying its count.
 */
export function foldTurns(entries: readonly TaskActivityEntry[]): Turn[] {
  const turns: Turn[] = [];
  const last = (): Turn | undefined => turns[turns.length - 1];

  for (const entry of entries) {
    switch (entry.kind) {
      case 'status':
        continue; // the Details tab's story, not the conversation's
      case 'chat':
        turns.push({
          key: `chat-${entry.id}`,
          kind: 'you',
          variant: 'chat',
          body: entry.body,
          createdAt: entry.createdAt,
          commentId: null,
        });
        continue;
      case 'status-note':
        // Not dropped like a `status` change: a status change is a fact the Details
        // cell already shows, while this is something you *said* about the card, and
        // the ones a newer note replaced are only readable here.
        turns.push({
          key: `progress-${entry.id}`,
          kind: 'you',
          variant: 'status',
          body: entry.body,
          createdAt: entry.createdAt,
          commentId: null,
        });
        continue;
      case 'comment':
        turns.push({
          key: `note-${entry.id}`,
          kind: 'you',
          variant: 'note',
          body: entry.body,
          createdAt: entry.createdAt,
          commentId: entry.id,
        });
        continue;
      case 'jira-comment':
        turns.push(
          entry.mine
            ? {
                key: `jira-${entry.id}`,
                kind: 'you',
                variant: 'jira',
                body: entry.body,
                createdAt: entry.createdAt,
                commentId: null,
                rich: entry.rich,
                attachments: entry.attachments,
              }
            : {
                key: `jira-${entry.id}`,
                kind: 'them',
                author: entry.author,
                body: entry.body,
                createdAt: entry.createdAt,
                rich: entry.rich,
                attachments: entry.attachments,
              },
        );
        continue;
      case 'event':
        break;
    }

    const event = entry.event;
    if (event.kind === 'assistant') {
      const text = event.text.trim();
      if (!text) continue;
      const prev = last();
      // One paragraph, not one bubble per chunk.
      if (prev?.kind === 'agent') prev.text = `${prev.text}\n${text}`;
      else turns.push({ key: `e-${entry.id}`, kind: 'agent', text, createdAt: entry.createdAt });
      continue;
    }

    if (isToolWork(event)) {
      const prev = last();
      const label =
        event.kind === 'tool-use' && SUBAGENT_TOOLS.has(event.name.toLowerCase())
          ? subAgentLabel(event.input)
          : null;
      const counts = event.kind === 'tool-use' ? 1 : 0;
      if (prev?.kind === 'tools') {
        prev.count += counts;
        if (label) prev.labels.push(label);
      } else {
        turns.push({
          key: `e-${entry.id}`,
          kind: 'tools',
          count: counts,
          labels: label ? [label] : [],
          createdAt: entry.createdAt,
        });
      }
      continue;
    }

    const line = systemLine(event);
    if (line) {
      turns.push({
        key: `e-${entry.id}`,
        kind: 'system',
        text: line.text,
        tone: line.tone,
        createdAt: entry.createdAt,
      });
    }
  }

  // A run that only thought (no tool call ever landed) folds to a row saying nothing.
  return turns.filter((t) => t.kind !== 'tools' || t.count > 0);
}
