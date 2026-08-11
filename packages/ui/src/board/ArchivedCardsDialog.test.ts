/**
 * What the Removed-cards list says about a card that is not on the board.
 *
 * The rule under test is that the list never guesses. A card removed because JIRA says the
 * ticket is gone and one removed because a retention clock ran out are the same row in every
 * other respect — both were retained, both carry a `retainedSince` — and they mean opposite
 * things to the human, so the reason is read from what was RECORDED and a row that recorded
 * nothing says so rather than picking the likeliest sentence.
 *
 * The labels take `now`, in the same shape as `@shared/sync`'s, so there is no clock here.
 */
import { describe, expect, it } from 'vitest';
import { PERSONAL_PROJECT_ID, type Task, type TaskArchiveReason } from '@tm/shared/model';
import {
  archiveReasonText,
  archivedCards,
  archivedCountLabel,
  archivedCountTitle,
  removedAgo,
  removedLine,
} from './ArchivedCardsDialog';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 7, 4, 12, 0, 0);

const card = (over: Partial<Task> = {}): Task =>
  ({
    id: 'card-1',
    projectId: PERSONAL_PROJECT_ID,
    phase: '',
    title: 'Ship the thing',
    status: 'pending',
    sessionId: null,
    order: 0,
    source: 'jira',
    dependsOn: [],
    isContract: false,
    isScaffold: false,
    type: null,
    parentTaskId: null,
    description: null,
    externalSource: 'jira',
    externalKey: 'AB-12',
    archivedAt: NOW - DAY,
    archivedReason: 'left-query',
    ...over,
  }) as Task;

describe('archiveReasonText', () => {
  it('gives each recorded reason its own sentence', () => {
    const reasons: TaskArchiveReason[] = ['left-query', 'retention-expired', 'gone-from-jira'];
    const said = reasons.map(archiveReasonText);
    expect(new Set(said).size).toBe(reasons.length);
    expect(said.every((s) => s.endsWith('.'))).toBe(true);
  });

  it('separates a ticket that stopped matching from one JIRA no longer has', () => {
    expect(archiveReasonText('left-query')).toMatch(/no longer matches/);
    expect(archiveReasonText('gone-from-jira')).toMatch(/no longer has the ticket/);
  });

  it('says an old row recorded no reason rather than inventing one', () => {
    // The case that matters: a card archived by the version that added `archivedAt` and
    // nothing else. Its `retainedSince` would happily support a confident guess.
    expect(archiveReasonText(null)).toMatch(/did not record why/);
    expect(archiveReasonText(undefined)).toBe(archiveReasonText(null));
  });
});

describe('removedAgo', () => {
  it('counts the first week in days, in words for the two nearest', () => {
    expect(removedAgo(NOW, NOW)).toBe('today');
    expect(removedAgo(NOW - DAY, NOW)).toBe('yesterday');
    expect(removedAgo(NOW - 6 * DAY, NOW)).toBe('6 days ago');
  });

  it('counts elapsed days, not calendar edges — 23 hours ago is still today', () => {
    expect(removedAgo(NOW - (DAY - 3_600_000), NOW)).toBe('today');
  });

  it('switches to a date once the count stops being memorable', () => {
    expect(removedAgo(NOW - 7 * DAY, NOW)).toMatch(/^on /);
    expect(removedAgo(NOW - 400 * DAY, NOW)).toMatch(/^on /);
  });

  it('never counts backwards for a clock that disagrees with the row', () => {
    expect(removedAgo(NOW + DAY, NOW)).toBe('today');
  });

  it('has an answer for a row with no timestamp at all', () => {
    expect(removedAgo(null, NOW)).toBe('at some point');
    expect(removedAgo(undefined, NOW)).toBe('at some point');
  });
});

describe('removedLine', () => {
  it('says when it went and which question sent it', () => {
    const line = removedLine(card({ archivedReason: 'retention-expired' }), NOW);
    expect(line).toBe(
      'Removed yesterday · It was finished, kept past the query, and the retention window ran out.',
    );
  });

  it('reads the reason from the row, not from the retention state it happens to be in', () => {
    // Both of these were retained cards — identical but for what the sync recorded.
    const expired = card({ retainedSince: NOW - 30 * DAY, archivedReason: 'retention-expired' });
    const gone = card({ retainedSince: NOW - 30 * DAY, archivedReason: 'gone-from-jira' });
    expect(removedLine(expired, NOW)).not.toBe(removedLine(gone, NOW));
  });
});

describe('archivedCards', () => {
  it('drops the step rows an archived card took with it', () => {
    // The shape `board:archived` actually answers with: one card, its two steps, all three
    // rows carrying an `archivedAt`. Listed raw, that card would read as three removals and
    // two of them would offer a Restore for something no human ever removed.
    const parent = card({ id: 'card-1' });
    const steps = [
      card({ id: 'step-1', parentTaskId: 'card-1', title: 'first' }),
      card({ id: 'step-2', parentTaskId: 'card-1', title: 'second' }),
    ];
    expect(archivedCards([parent, ...steps]).map((t) => t.id)).toEqual(['card-1']);
  });

  it('keeps the order it was given — the store already sorted it newest-first', () => {
    const rows = [card({ id: 'a' }), card({ id: 'b' }), card({ id: 'c' })];
    expect(archivedCards(rows).map((t) => t.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('the toolbar button', () => {
  it('is labelled with the bare count and says the noun in its tooltip', () => {
    expect(archivedCountLabel(3)).toBe('3');
    expect(archivedCountTitle(3)).toMatch(/^3 cards/);
    expect(archivedCountTitle(1)).toMatch(/^1 card has/);
  });
});
