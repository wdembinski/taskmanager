/**
 * Static-markup coverage for `CommentThread`'s AI drafts (F16.12): one draft per severity and a
 * human draft beside them. The text buttons' wiring is checked through `aiDraftActions` — the
 * pure list `AiDraftCard` renders its buttons from — since this package renders without a DOM.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { AI_FINDING_SEVERITIES, type AiFindingSeverity } from '@tm/shared/aiReview';
import type { ReviewComment } from '@tm/shared/review';
import { CommentThread, aiDraftActions, citesLabel, draftDecision } from './CommentThread';

function human(over: Partial<ReviewComment> = {}): ReviewComment {
  return {
    id: 'h1',
    taskId: 't1',
    diffId: 'd1',
    path: 'src/upload/retry.ts',
    side: 'new',
    line: 18,
    body: 'Should backoff cap at 30s?',
    excerpt: '  await sleep(backoff);',
    createdAt: 1,
    updatedAt: 1,
    sentAt: null,
    ...over,
  };
}

function ai(severity: AiFindingSeverity, over: Partial<ReviewComment> = {}): ReviewComment {
  return human({
    id: `ai-${severity}`,
    body: `A ${severity} finding.`,
    origin: 'ai',
    aiReviewId: 'r1',
    severity,
    suggestion: null,
    acceptedAt: null,
    dismissedAt: null,
    ...over,
  });
}

function render(comments: readonly ReviewComment[]): string {
  const noop = (): void => {};
  return renderToStaticMarkup(
    <CommentThread
      comments={comments}
      editor={null}
      onEditDraft={noop}
      onSave={noop}
      onCancel={noop}
      onEdit={noop}
      onDelete={noop}
      onAccept={noop}
      onDismiss={noop}
      onRestore={noop}
    />,
  );
}

/** The markup of the card carrying `data-severity="<severity>"`, up to the next card. */
function card(html: string, marker: string): string {
  const start = html.lastIndexOf('<div', html.indexOf(marker));
  const next = html.indexOf('data-ai-draft', html.indexOf(marker) + marker.length);
  return html.slice(start, next === -1 ? undefined : html.lastIndexOf('<div', next));
}

/** The class list of the element carrying `attr`. */
function classOf(html: string, attr: string): string[] {
  const tag = new RegExp(`<[^>]*${attr}[^>]*>`).exec(html)?.[0] ?? '';
  return (/class="([^"]*)"/.exec(tag)?.[1] ?? '').split(' ').filter((c) => c !== '');
}

describe('CommentThread AI drafts', () => {
  const pending = AI_FINDING_SEVERITIES.map((s) => ai(s));
  const html = render([human(), ...pending]);

  it('marks every AI draft with the AI pill, its severity and pending', () => {
    expect(html.match(/data-ai-draft/g)).toHaveLength(4);
    expect(html.match(/data-ai-mark/g)).toHaveLength(4);
    for (const severity of AI_FINDING_SEVERITIES) {
      const one = card(html, `data-severity="${severity}"`);
      expect(one).toContain('data-decision="pending"');
      expect(one).toMatch(/data-ai-mark[^>]*>AI</);
      expect(one).toContain(`data-severity-glyph="${severity}"`);
      // "Draft · <glyph> <severity>": the word follows its glyph.
      expect(one).toContain('Draft');
      expect(one).toContain(`</svg>${severity}</span>`);
      expect(one).toContain('cites line 18');
    }
  });

  it('colours only the blocker glyph', () => {
    expect(html.match(/data-tone="attention"/g)).toHaveLength(1);
    expect(card(html, 'data-severity="blocker"')).toContain('data-tone="attention"');
    const blocker = classOf(html, 'data-severity-glyph="blocker"');
    const neutral = AI_FINDING_SEVERITIES.filter((s) => s !== 'blocker').map((s) =>
      classOf(html, `data-severity-glyph="${s}"`),
    );
    // The attention class is the one the blocker carries and no other glyph does.
    const extra = blocker.filter((c) => neutral.every((list) => !list.includes(c)));
    expect(extra.length).toBeGreaterThan(0);
    for (const list of neutral) expect(list).toEqual(neutral[0]);
  });

  it('offers Keep · Edit · Dismiss on a pending draft, in that order', () => {
    const one = card(html, 'data-severity="major"');
    const keys = [...one.matchAll(/data-draft-action="(\w+)"/g)].map((m) => m[1]);
    expect(keys).toEqual(['keep', 'edit', 'dismiss']);
    expect(one).toMatch(/data-draft-action="keep"[^>]*>Keep</);
    expect(one).toMatch(/data-draft-action="edit"[^>]*>Edit</);
    expect(one).toMatch(/data-draft-action="dismiss"[^>]*>Dismiss</);
    expect(one).not.toContain('aria-label="Delete comment"');
  });

  it('draws the human draft exactly as before: range, icons, no AI mark', () => {
    const humanOnly = render([human()]);
    expect(humanOnly).not.toContain('data-ai-draft');
    expect(humanOnly).not.toContain('data-ai-mark');
    expect(humanOnly).not.toContain('data-draft-action');
    expect(humanOnly).toContain('>L18<');
    expect(humanOnly).toContain('aria-label="Edit comment"');
    expect(humanOnly).toContain('aria-label="Delete comment"');
    expect(humanOnly).toContain('Should backoff cap at 30s?');
  });

  it('shows a suggestion as a −/+ mini diff, and nothing without one', () => {
    const withSuggestion = render([
      ai('major', {
        excerpt: 'return undefined;\n}',
        suggestion: 'throw lastError;\n}',
      }),
    ]);
    expect(withSuggestion).toContain('data-suggestion');
    expect(withSuggestion.match(/data-line="del"/g)).toHaveLength(2);
    expect(withSuggestion.match(/data-line="add"/g)).toHaveLength(2);
    expect(withSuggestion).toMatch(/data-line="del"[^>]*><span[^>]*>−<\/span>return undefined;/);
    expect(withSuggestion).toMatch(/data-line="add"[^>]*><span[^>]*>\+<\/span>throw lastError;/);
    expect(html).not.toContain('data-suggestion');
  });

  it('draws a kept draft with Edit/Delete icons and "kept", the AI mark still on', () => {
    const kept = render([ai('minor', { acceptedAt: 5 })]);
    expect(kept).toContain('data-decision="accepted"');
    expect(kept).toContain('data-ai-mark');
    expect(kept).toContain('aria-label="Edit comment"');
    expect(kept).toContain('aria-label="Delete comment"');
    expect(kept).toMatch(/data-kept[^>]*>kept</);
    expect(kept).not.toContain('data-draft-action');
  });

  it('draws a dismissed draft dimmed, with Restore alone', () => {
    const dismissed = render([ai('nit', { dismissedAt: 5 })]);
    const pendingNit = render([ai('nit')]);
    expect(dismissed).toContain('data-decision="dismissed"');
    const keys = [...dismissed.matchAll(/data-draft-action="(\w+)"/g)].map((m) => m[1]);
    expect(keys).toEqual(['restore']);
    expect(dismissed).toMatch(/data-draft-action="restore"[^>]*>Restore</);
    expect(dismissed).not.toContain('aria-label="Delete comment"');
    // Dimmed: the dismissed card carries a class the pending one does not.
    const dimmedClasses = classOf(dismissed, 'data-ai-draft');
    const plainClasses = classOf(pendingNit, 'data-ai-draft');
    expect(dimmedClasses.some((c) => !plainClasses.includes(c))).toBe(true);
  });

  it('cites a range as lines N–M', () => {
    expect(citesLabel(ai('major', { start: { side: 'new', line: 12 } }))).toBe('cites lines 12–18');
    expect(citesLabel(ai('major'))).toBe('cites line 18');
  });
});

describe('aiDraftActions', () => {
  function handlers() {
    return {
      onAccept: vi.fn(),
      onDismiss: vi.fn(),
      onRestore: vi.fn(),
      onEdit: vi.fn(),
    };
  }

  it('wires Keep to accept, Edit to the editor and Dismiss to dismiss', () => {
    const draft = ai('blocker');
    const h = handlers();
    const actions = aiDraftActions(draft, h);
    expect(actions.map((a) => a.label)).toEqual(['Keep', 'Edit', 'Dismiss']);
    for (const action of actions) action.run();
    expect(h.onAccept).toHaveBeenCalledWith('ai-blocker');
    expect(h.onEdit).toHaveBeenCalledWith(draft);
    expect(h.onDismiss).toHaveBeenCalledWith('ai-blocker');
    expect(h.onRestore).not.toHaveBeenCalled();
  });

  it('wires Restore on a dismissed draft', () => {
    const h = handlers();
    const actions = aiDraftActions(ai('nit', { dismissedAt: 5 }), h);
    expect(actions.map((a) => a.key)).toEqual(['restore']);
    actions[0].run();
    expect(h.onRestore).toHaveBeenCalledWith('ai-nit');
  });

  it('offers nothing on a kept or sent draft', () => {
    expect(aiDraftActions(ai('minor', { acceptedAt: 5 }), handlers())).toEqual([]);
    expect(aiDraftActions(ai('minor', { acceptedAt: 5, sentAt: 9 }), handlers())).toEqual([]);
  });

  it('leaves out an action whose callback the host did not pass', () => {
    const actions = aiDraftActions(ai('major'), { onEdit: vi.fn() });
    expect(actions.map((a) => a.key)).toEqual(['edit']);
  });

  it('reads the decision from the stamps', () => {
    expect(draftDecision(ai('major'))).toBe('pending');
    expect(draftDecision(ai('major', { acceptedAt: 1 }))).toBe('accepted');
    expect(draftDecision(ai('major', { dismissedAt: 1 }))).toBe('dismissed');
  });
});
