import { CLOUD_PREVIEW_MIME_PREFIX } from '@tm/shared/attachments';

/**
 * The headers a blob is served under — every one of them a decision about a file somebody
 * else's browser is about to render inside our origin.
 *
 * Pure, and separated from the route for that reason: "what does an SVG get served as" is a
 * security rule, and a rule that can only be exercised by making an HTTP request is a rule
 * nobody re-checks after the first time.
 *
 * - **`X-Content-Type-Options: nosniff`.** Without it a browser is free to disagree with the
 *   `Content-Type` and act on what the bytes look like — which turns "an attachment whose
 *   suffix said `image/png`" into whatever it actually is. The MIME type here came from a
 *   file extension on somebody's desktop; it is a hint, and this is what stops the hint being
 *   upgraded to permission.
 * - **`Content-Disposition: attachment` for everything but `image/*`.** The one thing a
 *   browser is asked to display is a picture (see `CLOUD_PREVIEW_MIME_PREFIX`); anything else
 *   — a PDF, an HTML file, a `.txt` full of markup — is offered as a download instead, so it
 *   is never executed against the session that fetched it. `inline` for images is what makes
 *   `<img src>` work at all.
 * - **`Content-Security-Policy: sandbox` on SVG.** An SVG is an image by MIME type and a
 *   document by capability: it can carry `<script>`, and a browser navigating straight to one
 *   will run it. `sandbox` with no allow-list drops it into a unique opaque origin with
 *   scripts disabled, which leaves `<img src>` (where scripts never ran anyway) working
 *   exactly as before. Refusing SVGs outright was the alternative, and it would have refused
 *   the commonest mockup format there is.
 * - **`Cache-Control: private, immutable`.** `private` because these bytes belong to one
 *   account and must not land in a shared cache. `immutable` because an attachment's bytes
 *   genuinely never change — re-attaching a file mints a new id (`attachmentName`'s dedupe),
 *   so a URL that resolves once resolves to those bytes forever. That is what lets a pane
 *   full of images re-render without re-fetching, which is most of the point of serving them
 *   over a URL rather than as blobs in the tab's heap.
 */

/** What a blob with no usable MIME type is served as: bytes, not a guess. */
export const FALLBACK_MIME_TYPE = 'application/octet-stream';

/** A year — the conventional "forever" for `immutable`, which needs a max-age to mean anything. */
const IMMUTABLE_MAX_AGE_SECONDS = 31_536_000;

/** Whether a browser may render this inline, or must be handed it as a download. */
export function isInlineMimeType(mimeType: string | null | undefined): boolean {
  return (mimeType ?? '').toLowerCase().startsWith(CLOUD_PREVIEW_MIME_PREFIX);
}

/** The one image type that is a document in disguise. */
function isSvg(mimeType: string | null | undefined): boolean {
  return (mimeType ?? '').toLowerCase().startsWith('image/svg');
}

/**
 * `filename=` plus RFC 5987 `filename*=`, both, because the two are read by different
 * browsers and one of them cannot carry a non-ASCII name at all.
 *
 * The ASCII form is stripped to what can sit inside quotes without escaping anything — a
 * quote or a backslash in a filename would otherwise end the parameter early and let the rest
 * of the name be read as more header, which is the whole reason this is not a template
 * string.
 */
export function contentDisposition(fileName: string | null | undefined, inline: boolean): string {
  const kind = inline ? 'inline' : 'attachment';
  const name = (fileName ?? '').trim();
  if (name.length === 0) return kind;

  // eslint-disable-next-line no-control-regex -- control characters are exactly what must go.
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/** Everything `GET /v1/attachments/:id` sets, decided from the blob's own metadata. */
export function mediaHeaders(
  mimeType: string | null | undefined,
  fileName: string | null | undefined,
): Record<string, string> {
  const type = (mimeType ?? '').trim() || FALLBACK_MIME_TYPE;
  const inline = isInlineMimeType(type);

  const headers: Record<string, string> = {
    'Content-Type': type,
    'Content-Disposition': contentDisposition(fileName, inline),
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': `private, max-age=${IMMUTABLE_MAX_AGE_SECONDS}, immutable`,
  };
  if (isSvg(type)) headers['Content-Security-Policy'] = 'sandbox';
  return headers;
}
