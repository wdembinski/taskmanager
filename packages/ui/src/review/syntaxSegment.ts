/**
 * The syntax-segment shapes and {@link mergeSegments} itself, split out of `./highlight` for
 * one reason: this is the one piece of F15.11 that `DiffView` needs at RENDER time (every
 * line, synchronously), so it is the one piece that cannot go behind the dynamic
 * `import('./highlight')` that loads `highlight.js/lib/core` — a bundler has to keep anything
 * a static import reaches in the eagerly-loaded graph. Keeping this file free of any
 * `highlight.js` import is what lets `./highlight` (core plus the per-language grammars) load
 * as its own chunk instead of landing in the entry bundle.
 */
import type { WordSegment, WordSegmentKind } from '@tm/shared/review';

/** The five-hue bucket every hljs scope collapses into — or `null` for "render as plain text". */
export type SyntaxScope = 'keyword' | 'string' | 'comment' | 'number' | 'title';

export interface SyntaxSegment {
  text: string;
  scope: SyntaxScope | null;
}

export interface MergedSegment {
  text: string;
  scope: SyntaxScope | null;
  word: WordSegmentKind;
}

/**
 * Intersects a line's syntax segments with its word-diff segments — both must cover exactly
 * the same text — into one run of segments carrying both facts, so `DiffView` can render a
 * single `<span>` per run instead of nesting two independent sets of boundaries.
 */
export function mergeSegments(
  syntax: readonly SyntaxSegment[],
  words: readonly WordSegment[],
): MergedSegment[] {
  const result: MergedSegment[] = [];
  let si = 0;
  let wi = 0;
  let sOffset = 0;
  let wOffset = 0;

  while (si < syntax.length && wi < words.length) {
    const sSeg = syntax[si];
    const wSeg = words[wi];
    const take = Math.min(sSeg.text.length - sOffset, wSeg.text.length - wOffset);
    if (take > 0) {
      result.push({
        text: sSeg.text.slice(sOffset, sOffset + take),
        scope: sSeg.scope,
        word: wSeg.kind,
      });
    }
    sOffset += take;
    wOffset += take;
    if (sOffset >= sSeg.text.length) {
      si += 1;
      sOffset = 0;
    }
    if (wOffset >= wSeg.text.length) {
      wi += 1;
      wOffset = 0;
    }
  }
  return result;
}
