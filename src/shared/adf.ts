/**
 * The shape of a parsed rich-text comment, on the boundary between engine and UI.
 *
 * The parser itself lives in `main/jira/adf.ts` — it is engine work and has no business
 * in the renderer bundle. But the RESULT crosses the IPC boundary (a JIRA comment now
 * arrives with its mentions and links intact rather than flattened to text), so per
 * `docs/02` its types belong here, where both sides can see them.
 */

/** An inline run within a block. */
export type AdfSpan =
  | { kind: 'text'; text: string }
  | { kind: 'code'; text: string }
  /** `id` is a Cloud accountId or a Server username; null when the doc named nobody. */
  | { kind: 'mention'; text: string; id: string | null }
  | { kind: 'link'; text: string; href: string };

/** A block-level element. A small vocabulary on purpose — this renders in a chat pane. */
export type AdfBlock =
  | { kind: 'paragraph'; spans: AdfSpan[] }
  | { kind: 'heading'; level: number; spans: AdfSpan[] }
  | { kind: 'quote'; spans: AdfSpan[] }
  | { kind: 'codeBlock'; text: string }
  | { kind: 'list'; ordered: boolean; items: AdfSpan[][] }
  | { kind: 'media'; filename: string | null };

/** A file on the issue, cited by a comment. Attachment metadata is per-ISSUE in JIRA. */
export interface CommentAttachment {
  filename: string;
  /** Authenticated URL — opened in the browser, never fetched by the renderer. */
  url: string | null;
  mimeType: string | null;
  size: number | null;
}
