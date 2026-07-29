/**
 * The JIRA mark, as an inline SVG.
 *
 * Inline rather than an asset file because the card renders it at 12px inside a badge:
 * an `<img>` would cost a request, could not inherit `currentColor` for the unread
 * state, and would blur at that size. Two chevrons nested at right angles is the shape
 * of Atlassian's own mark, drawn here in their blue.
 *
 * `title` is deliberately absent by default — the badge that wraps it already carries
 * the ticket key and a tooltip, and a second accessible name would make screen readers
 * announce the issue twice. Callers that use it bare pass one.
 */

/** Atlassian's JIRA blue. Overridden to `currentColor` when the badge is tinted. */
export const JIRA_BLUE = '#2684FF';

export interface JiraMarkProps {
  /** Edge length in px. The badge uses 12; a heading might use 16. */
  size?: number;
  /**
   * Fill. Defaults to the brand blue; the unread badge passes `currentColor` so the mark
   * flips to near-black along with the badge's text rather than sitting blue on orange.
   */
  color?: string;
  /** Accessible name. Omitted renders the mark as decoration (`aria-hidden`). */
  title?: string;
}

export function JiraMark({ size = 12, color = JIRA_BLUE, title }: JiraMarkProps): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      role={title ? 'img' : undefined}
      aria-hidden={title ? undefined : true}
      style={{ flexShrink: 0, display: 'block' }}
    >
      {title && <title>{title}</title>}
      {/* The upper chevron, pointing down-right. */}
      <path
        d="M16.5 1.5 30 15a1.5 1.5 0 0 1 0 2.1l-4.2 4.2-9.3-9.3-5.1-5.1 5.1-5.4z"
        fill={color}
      />
      {/* The lower chevron, the same shape rotated a quarter turn, at reduced opacity —
          which is how the mark reads as one folded ribbon rather than two arrows. */}
      <path
        d="M15.5 30.5 2 17a1.5 1.5 0 0 1 0-2.1l4.2-4.2 9.3 9.3 5.1 5.1-5.1 5.4z"
        fill={color}
        opacity="0.75"
      />
    </svg>
  );
}
