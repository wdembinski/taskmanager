/**
 * The GitHub mark — the Octocat silhouette — as an inline SVG. `JiraMark`, one tracker over.
 *
 * Inline for the same three reasons that one is: the card draws it at 12px inside a badge,
 * where an `<img>` would cost a request, could not inherit `currentColor` for the unread
 * state, and would blur at that size.
 *
 * **Monochrome, and — unlike `JiraMark` — with no brand colour to default to.** Two reasons,
 * and they agree:
 *
 *  - GitHub's own mark IS monochrome. It is black on light and white on dark and has never
 *    been anything else, so there is no "GitHub colour" to spend the way Atlassian's blue is
 *    spent. Inheriting the badge's foreground is the brand-correct rendering, not a
 *    compromise.
 *  - The board's colour budget: colour is for the things that MOVE — a step dot, a pipeline
 *    stage, the unread tint — and "which tracker this card came from" is the most static fact
 *    on the card. It never changes, and it is the same on the forty cards beside it.
 *
 * That default also makes the unread state free: when the ticket badge takes its tint, the
 * mark flips to near-black along with the text without the caller passing anything, which is
 * exactly what `JiraMark` needs an explicit `color="currentColor"` to achieve.
 *
 * `title` is deliberately absent by default, as next door: the badge that wraps it already
 * carries the ticket key and a tooltip, and a second accessible name would make a screen
 * reader announce the issue twice.
 */

export interface GitHubMarkProps {
  /** Edge length in px. The badge uses 12; a heading might use 16. */
  size?: number;
  /**
   * Fill. Defaults to `currentColor` — see this file's header for why that is the mark's
   * real colour rather than a fallback. A caller that wants it fixed can say so.
   */
  color?: string;
  /** Accessible name. Omitted renders the mark as decoration (`aria-hidden`). */
  title?: string;
}

export function GitHubMark({
  size = 12,
  color = 'currentColor',
  title,
}: GitHubMarkProps): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      role={title ? 'img' : undefined}
      aria-hidden={title ? undefined : true}
      style={{ flexShrink: 0, display: 'block' }}
    >
      {title && <title>{title}</title>}
      {/* One closed path — the body, the arms and the tail — which is why it needs the
          even-odd rule: the cut-outs (the eyes, the gap under the arms) are subpaths inside
          the silhouette rather than shapes drawn over it. */}
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.6 7.6 0 0 1 2-.27c.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z"
        fill={color}
      />
    </svg>
  );
}
