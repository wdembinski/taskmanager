/**
 * The files a card carries — and the rules for naming and citing them.
 *
 * A brief is prose, so anything that is not prose (the screenshot of the bug, the mockup
 * the layout has to match, the CSV that reproduces it) was either described in words or
 * pasted as a path only the person who wrote it can open. An attachment is that file
 * kept where the app keeps everything else, and named so a brief can point AT it:
 * `@shot.png`, resolved to a real file by the agent that runs the card.
 *
 * The type and its rules live in one module, the way `taskChain.ts` holds `TaskLink` and
 * `canLink`, and for the same reason: three sides ask the same questions and must not
 * answer differently. The renderer greys out an `@foo` whose file is gone, the prompt
 * builder decides which files a step's brief actually cites, and main decides what a
 * picked file is called on disk. One `name` policy, one `@ref` grammar, both pure.
 *
 * Two rules that are not obvious and hold this together:
 *
 * - **`name` is both the token and the filename.** `UNIQUE (taskId, name)` in the store
 *   is therefore one constraint doing two jobs — it is what makes `@name` unambiguous and
 *   what keeps the bytes from colliding on disk. So the name is sanitized to what BOTH a
 *   Windows filename and an `@token` can be, which is the narrow intersection
 *   `[A-Za-z0-9._-]`, and deduped **case-insensitively** because NTFS says `A.png` and
 *   `a.png` are the same file even though a Set of strings does not.
 * - **A ref is resolved against the known list, never against a syntax.** Nothing here
 *   decides what an `@token` *means* on its own; a token that matches no attachment is
 *   prose. That is what stops `@needs:` (the plan-file dependency syntax, see
 *   `docs/03-how-orchestration-works.md`) and an email address from ever being read as an
 *   attachment, without either of them being special-cased — and it doubles as how the UI
 *   knows to grey out an `@foo` whose file was removed.
 *
 * No path anywhere in this file. The absolute path is
 * `join(userData, ATTACHMENTS_DIR, taskId, name)`, derived where it is needed; the
 * renderer never learns one at all and reaches an image through {@link attachmentUrl}.
 */

/** One file attached to one card (or to one step — a step is a task row). */
export interface TaskAttachment {
  /** Stable app-assigned id (UUID) — what remove/open/preview address. */
  id: string;
  /** The card or step this hangs off. */
  taskId: string;
  /**
   * The `@token`, and the file's name on disk — see the note above on why those are the
   * same string. Unique within a task; sanitized by {@link attachmentName}.
   */
  name: string;
  /**
   * The name the file arrived with, untouched — what the chip shows. Kept separately
   * because `name` may have been stripped of spaces, accents and parentheses, and
   * "Screenshot 2026-08-03 at 11.04 (1).png" is how a human recognizes their own file.
   */
  fileName: string;
  /** Best-effort content type, or null when nothing could be inferred from the suffix. */
  mimeType: string | null;
  /** Bytes on disk, for the chip's subtitle and for refusing something absurd. */
  size: number;
  createdAt: number;
  /**
   * Epoch ms of the last successful push of these bytes to the cloud — **absent** when the
   * cloud has never held them, or when it held them and evicted them since.
   *
   * The bytes live on the desktop's disk; this says whether a second copy of them is
   * currently reachable from a browser. A web tab renders a chip for every attachment either
   * way (the row travels for free: `attachment:list` and `attachment:changed` already carry
   * whole rows over the relay, so nothing new is plumbed to make this visible), and uses this
   * to tell "you can look at this now" from "ask the desktop to push it first".
   *
   * A timestamp rather than a boolean because the two facts it answers are different
   * questions and only one of them a boolean could answer: *is it up there* — and *is what
   * is up there the bytes I have*. An attachment's bytes never change once written (a
   * re-attached file is a new id, see `attachmentName`'s dedupe), so the second question is
   * really "was it pushed by a build that pushed the whole thing", and a date is what you can
   * reason about after the fact when it turns out one wasn't.
   *
   * `null` and absent mean the same thing — never pushed — and both occur: the store's column
   * reads back as `null` on every row that has not been up, while a row minted in memory
   * (or one from a build older than the column) simply has no key. Every reader therefore
   * tests it for truthiness rather than for presence. Writing it is `markAttachmentUploaded`,
   * and only `cloudAttachmentUploader.ts` calls that.
   */
  cloudBlobAt?: number | null;
}

/**
 * A file a browser parked in the cloud (`POST /v1/uploads`), on its way to becoming a real
 * attachment — what `attachment:addUploaded` names so the desktop can collect the bytes.
 *
 * An id rather than the bytes, for the same reason `attachment:add` takes paths rather than
 * bytes: the relay is a JSON command queue, and a picture through it would be base64 in a
 * `commands` row. The bytes travel over their own raw route between the two machines that
 * actually have them.
 *
 * `fileName` is the browser's, so it is **not trusted**: it names a file on somebody else's
 * machine and reaches the desktop over the network. `attachmentName` is what turns it into
 * something that may be written under `userData` — see `uploadedAttachments.ts`, which is the
 * one place that boundary is crossed.
 */
export interface UploadedAttachment {
  /** `UploadTicket.id` — the id `GET /v1/uploads/:id` hands the bytes back for. */
  id: string;
  /** What the human called the file, untrusted; the chip's label once it lands. */
  fileName: string;
  /** The browser's `File.type`, or nothing when it had none to offer. */
  mimeType?: string | null;
}

/**
 * One file lifted straight off the clipboard — `attachment:stagePasted`'s input, and the
 * only shape here whose bytes never touched a disk or a network before reaching main.
 *
 * A `Uint8Array` rather than a path or an id, because a paste has neither: the renderer
 * read it out of a `ClipboardEvent`/`DataTransferItem` a moment ago, and there is nothing
 * on disk yet for a path to name and nothing parked in the cloud for an id to look up. This
 * is the one attachment-shaped payload the app ever sends bytes-first over IPC, and
 * {@link MAX_PASTE_BYTES} is what keeps that an acceptable thing to do.
 */
export interface PastedAttachment {
  /** What the source app called it, if anything — a browser paste often has nothing. */
  fileName: string;
  /** The clipboard item's declared type, or null when it offered none. */
  mimeType: string | null;
  /** The bytes themselves, still raw — naming and sanitizing happen once they reach main. */
  bytes: Uint8Array;
}

/**
 * The most one pasted file's bytes may be, to cross into main at all.
 *
 * Far below {@link CLOUD_BLOB_MAX_BYTES}'s sibling `MAX_ATTACHMENT_BYTES` (100 MB,
 * `apps/client/src/main/attachments.ts`), and deliberately: a picked file crosses IPC as a
 * PATH (`attachment:add`), but a paste has no path to give, so its bytes ride a structured
 * clone from renderer to main instead — held whole in memory on both sides of that clone,
 * the way a cloud blob is held whole in memory on both sides of an HTTPS request. Set to the
 * same ceiling as {@link CLOUD_BLOB_MAX_BYTES} and `MAX_PREVIEW_BYTES` for that reason: a
 * clipboard image is a screenshot or a mockup, never a video, and 25 MB is generous for
 * either without inviting the structured-clone cost `attachment:add` was built to avoid.
 */
export const MAX_PASTE_BYTES = 25 * 1024 * 1024;

/**
 * The extension a pasted file is written with, guessed from the clipboard's own MIME type —
 * the inverse of main's `mimeForExtension` (`apps/client/src/main/attachmentPaths.ts`), which
 * goes the other way (suffix to MIME) for a file that already has a name. A paste usually
 * does not: Chromium hands the renderer a bitmap and a type, not a filename, so this is the
 * one place the app has to go from type to suffix instead.
 *
 * Deliberately short — the image types a clipboard actually produces — rather than a mirror
 * of `mimeForExtension`'s whole table: nothing pastes a `.docx` onto a card. Without the dot,
 * to match the convention `mimeForExtension` reads its own keys by.
 */
const EXTENSION_BY_MIME: Readonly<Record<string, string>> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
  'image/svg+xml': 'svg',
  'image/tiff': 'tiff',
};

/** {@link EXTENSION_BY_MIME}, or null when the type is missing or not one this app pastes. */
export function extensionForMime(mimeType: string | null): string | null {
  if (!mimeType) return null;
  return EXTENSION_BY_MIME[mimeType.toLowerCase()] ?? null;
}

/** The suffix off `name`, without the dot — the same slice `mimeForExtension` looks up by. */
function extensionFromName(name: string): string | null {
  const bare = name.split(/[\\/]/).pop() ?? '';
  const dot = bare.lastIndexOf('.');
  return dot > 0 ? bare.slice(dot + 1).toLowerCase() : null;
}

/**
 * What a just-pasted file is called before {@link attachmentName} ever sees it.
 *
 * Chromium calls every clipboard bitmap `image.png` — no exceptions, no counter of its own —
 * so a second screenshot pasted onto the same card would otherwise reach `attachmentName`
 * with the exact name the first one already took, and land as `image-2.png` purely because
 * it arrived second. That is a name that describes an arrival order nobody asked about
 * instead of the moment the picture was taken, which `pasted-20260821-114233.png` does.
 *
 * The extension is decided in the order that trusts the strongest fact first: the
 * clipboard's own MIME type via {@link extensionForMime}, since that describes the bytes
 * actually being written; then the extension already on `originalName`, for a paste that
 * did carry one; and only when neither says anything, `bin`.
 *
 * Pure, and not a substitute for {@link attachmentName} — it decides what the file is
 * called, not whether that name is safe to write or unique on the task; the result is meant
 * to be fed through `attachmentName` exactly as a picked file's name already is.
 */
export function pastedFileName(originalName: string, mimeType: string | null, at: number): string {
  const ext = extensionForMime(mimeType) ?? extensionFromName(originalName) ?? 'bin';
  return `pasted-${pasteStamp(at)}.${ext}`;
}

/** `YYYYMMDD-HHMMSS`, in UTC so the same instant names the same file on every machine. */
function pasteStamp(at: number): string {
  const d = new Date(at);
  const pad = (n: number): string => String(n).padStart(2, '0');
  const date = `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
  const time = `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
  return `${date}-${time}`;
}

/**
 * The MIME prefix a browser may show INLINE — everything else is served as a download.
 *
 * The whole preview story is `<img src>`, so this is not a taste call about which files
 * deserve a thumbnail: it is the one content class the cloud will hand a browser to render
 * in its own origin. Anything else (a PDF, an HTML file, a `.svg`'s more adventurous
 * cousins) is served `Content-Disposition: attachment`, which makes the browser save it
 * rather than execute it against the session that asked for it.
 *
 * `image/svg+xml` matches this prefix and IS rendered — an SVG is a picture, and refusing
 * the commonest mockup format would be a strange place to draw the line — but it is the one
 * image type that can carry script, so the cloud serves it under `Content-Security-Policy:
 * sandbox`. See the server's `attachmentHeaders.ts`, which is where both halves are decided.
 */
export const CLOUD_PREVIEW_MIME_PREFIX = 'image/';

/**
 * The most one attachment's bytes may be, to be pushed to the cloud at all.
 *
 * Bounded far below what an attachment may be locally, and deliberately: an attachment can
 * be a 30 MB screen recording (`attachment:add` takes paths, never bytes, precisely so one
 * never crosses a structured clone), while a cloud blob crosses an HTTPS request, is held
 * whole in memory at both ends of it, and lands in a shared per-account quota. 25 MB covers
 * every screenshot and mockup anybody previews in a browser, and refuses the video — which
 * is not a regression, because the video was never previewable in a browser anyway.
 *
 * Enforced on the SERVER by a byte counter over the request stream, not by trusting
 * `Content-Length` — a sender can declare one number and send another.
 */
export const CLOUD_BLOB_MAX_BYTES = 25 * 1024 * 1024;

/**
 * What an agent is told about one attachment: the token to expect in the brief, and where
 * that file actually is **on the machine the run happens on** — already translated for a
 * WSL run, so the prompt never carries a path the agent cannot open.
 */
export interface PromptAttachment {
  name: string;
  path: string;
}

/** One `@name` found in a piece of text, with where it sits so the UI can decorate it. */
export interface AttachmentRef {
  /** The attachment's `name` as the known list spells it, without the `@`. */
  name: string;
  /** Index of the `@` in the source text. */
  start: number;
  /** Index one past the ref's last character. */
  end: number;
}

/** The directory under `userData` the bytes live in: `<userData>/attachments/<taskId>/<name>`. */
export const ATTACHMENTS_DIR = 'attachments';

/** The custom scheme the renderer previews images over (registered privileged before ready). */
export const ATTACHMENT_SCHEME = 'vipper-attachment';

/**
 * The URL an image preview loads.
 *
 * A host segment (`a`) rather than `scheme:///<id>`, because a URL with an empty authority
 * parses inconsistently and Chromium's own `new URL()` is what the protocol handler will
 * use to pull the id back out. The id is all that crosses: the handler resolves it
 * THROUGH the store, so there is no renderer-supplied string that reaches the filesystem
 * and traversal is impossible by construction rather than by validation.
 */
export function attachmentUrl(id: string): string {
  return `${ATTACHMENT_SCHEME}://a/${encodeURIComponent(id)}`;
}

/**
 * The id back out of an {@link attachmentUrl}, or null when the URL is not one of ours.
 *
 * The other half of the round trip, and it lives here rather than in the protocol handler
 * so the two are written against each other and tested together — the handler is the one
 * caller, but it cannot be unit-tested (it needs Electron, a store and a disk) and a URL
 * grammar that only one untestable function knows is a grammar that drifts.
 *
 * Everything is checked and nothing is trusted: the scheme, that the path is exactly the
 * one segment behind the dummy host, and that the escaping decodes. What comes back is
 * still only an id — it is looked up in the store, never joined onto a path — so this is
 * where a malformed URL turns into a 404 rather than where a traversal is caught.
 */
export function attachmentIdFromUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== `${ATTACHMENT_SCHEME}:`) return null;
  const segments = parsed.pathname.split('/').filter((s) => s !== '');
  if (segments.length !== 1) return null;
  try {
    // `%2F` survives parsing as an escape (it is not a separator), so an id that was
    // escaped on the way out is one segment here and decodes back to itself.
    return decodeURIComponent(segments[0]) || null;
  } catch {
    return null; // a lone `%` — malformed escaping is simply not one of our URLs
  }
}

/** The most a `name` may run to. Long enough to stay recognizable, short enough to type. */
const NAME_MAX = 64;

/** What a name degrades to when sanitizing leaves nothing at all (emoji-only, `...`, blank). */
const FALLBACK_NAME = 'file';

/** The one character class that is legal in a Windows filename AND in an `@token`. */
const NAME_CHAR = /[A-Za-z0-9._-]/;

/**
 * Names Windows reserves at the device level — unusable as a filename with or without an
 * extension, and failing at `open()` rather than at validation. Prefixed with `_` rather
 * than rejected, so the human still recognizes the file they picked.
 */
const DEVICE_NAMES: ReadonlySet<string> = new Set([
  'con',
  'prn',
  'aux',
  'nul',
  ...Array.from({ length: 9 }, (_, i) => `com${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `lpt${i + 1}`),
]);

/**
 * Split off the extension. A leading dot is part of the STEM (`.gitignore` is a dotfile,
 * not an extension), which is why the test is `> 0` and not `>= 0`.
 */
function splitExtension(name: string): { stem: string; ext: string } {
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return { stem: name, ext: '' };
  return { stem: name.slice(0, dot), ext: name.slice(dot) };
}

/**
 * `stem` + a dedupe suffix + `ext`, capped at {@link NAME_MAX} by shortening the STEM.
 *
 * The extension and the suffix are both load-bearing — one decides what opens the file,
 * the other is the only thing telling two files apart — so the cap can only ever eat into
 * the middle. A pathological extension (longer than the whole budget) is the one case
 * where there is nothing left to protect, and the name is simply cut.
 */
function composeName(stem: string, ext: string, n: number): string {
  const suffix = n < 2 ? '' : `-${n}`;
  const room = NAME_MAX - ext.length - suffix.length;
  if (room < 1) return `${stem}${suffix}${ext}`.slice(0, NAME_MAX);
  const cut = stem.length <= room ? stem : stem.slice(0, room).replace(/-+$/, '');
  return `${cut || FALLBACK_NAME}${suffix}${ext}`;
}

/**
 * What a picked file is called once it is ours: an `@token` that is also a safe filename,
 * unique among `taken`.
 *
 * Every step here is a rule about one of the two jobs the name does:
 * directories are stripped (a picked path must not become a path), the text is
 * NFC-normalized (macOS hands over decomposed accents, so the same filename would
 * otherwise compare unequal to itself), whitespace becomes `-` so the token does not end
 * at the first space, everything outside {@link NAME_CHAR} is dropped, and a trailing dot
 * — legal to *write* on Windows and impossible to open afterwards — goes with it. `..`
 * and `.` fall out of that as `''` and land on {@link FALLBACK_NAME}, which is why
 * traversal is not a case that needs its own check.
 *
 * Dedupe inserts `-2`, `-3` **before** the extension, so the file still opens in the right
 * program, and compares case-insensitively because the name is also a Windows filename.
 */
export function attachmentName(fileName: string, taken: readonly string[]): string {
  const bare = fileName.split(/[\\/]/).pop() ?? '';
  const sanitized = bare
    .normalize('NFC')
    .replace(/\s+/g, '-')
    .replace(/[^A-Za-z0-9._-]+/g, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|[-.]+$/g, '');

  const split = splitExtension(sanitized || FALLBACK_NAME);
  const ext = split.ext;
  let stem = split.stem || FALLBACK_NAME;
  if (DEVICE_NAMES.has(stem.toLowerCase())) stem = `_${stem}`;

  const used = new Set(taken.map((t) => t.toLowerCase()));
  // Bounded by the list itself: each `n` yields a distinct name, so `taken.length + 1`
  // attempts cannot all collide.
  for (let n = 1; n <= taken.length + 1; n += 1) {
    const candidate = composeName(stem, ext, n);
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
  return composeName(stem, ext, taken.length + 2);
}

/**
 * Trailing punctuation peeled off a candidate while it matches nothing.
 *
 * Only `.` can actually occur today — the others are not in {@link NAME_CHAR}, so the
 * greedy match stops before them — but the rule is stated whole, because "a ref may end
 * at a sentence's full stop" is the intent, and a later widening of the character class
 * must not quietly change what `@shot.png.` means.
 */
const PEELABLE = '.,;:!?)';

/**
 * Every `@name` in `text` that names something in `known`, in the order they appear.
 *
 * Three rules, and the third is the one that matters:
 *
 * 1. The `@` must start a word — the preceding character is absent or outside
 *    {@link NAME_CHAR}. That one rule alone is what stops `bob@example.com`.
 * 2. The token runs greedily over {@link NAME_CHAR}, then trailing punctuation is peeled
 *    off while the candidate matches nothing — so `@shot.png.` at the end of a sentence
 *    resolves, and `@a.png.bak` still prefers the longer name when both exist.
 * 3. Only candidates present in `known` are emitted. A token that names no attachment is
 *    prose, which is how `@needs:` and every other stray `@` stay out of this without
 *    being special-cased.
 *
 * Every OCCURRENCE is returned, not every distinct name: the offsets are the point, since
 * the pane decorates each token where it sits.
 */
export function parseAttachmentRefs(text: string, known: readonly string[]): AttachmentRef[] {
  const byLower = new Map(known.map((n) => [n.toLowerCase(), n]));
  const refs: AttachmentRef[] = [];
  const pattern = /@[A-Za-z0-9._-]*/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const at = match.index;
    const before = at > 0 ? text[at - 1] : '';
    if (before && NAME_CHAR.test(before)) continue;
    let candidate = match[0].slice(1);
    while (candidate) {
      const hit = byLower.get(candidate.toLowerCase());
      if (hit !== undefined) {
        refs.push({ name: hit, start: at, end: at + 1 + candidate.length });
        break;
      }
      if (!PEELABLE.includes(candidate[candidate.length - 1])) break;
      candidate = candidate.slice(0, -1);
    }
  }
  return refs;
}

/**
 * The attachments a piece of text actually cites — what the agent is handed, so a brief
 * mentioning one of six files does not come with a legend for all six.
 *
 * Returned in `all`'s order (the order the chips are listed in) rather than in order of
 * mention, and each named file appears once however often it is written.
 */
export function referencedAttachments<T extends { name: string }>(
  text: string,
  all: readonly T[],
): T[] {
  const cited = new Set(
    parseAttachmentRefs(
      text,
      all.map((a) => a.name),
    ).map((r) => r.name.toLowerCase()),
  );
  return all.filter((a) => cited.has(a.name.toLowerCase()));
}

/**
 * What a step may name: its own attachments, plus its parent card's.
 *
 * A step's brief is written against the card's material — the mockup is attached once, to
 * the card, and every step that has to match it says `@mockup.png`. Attaching it again per
 * step would be a copy per step, and copies drift.
 *
 * The step's own list wins a name clash, since that is the one attached closest to the
 * work, and a shadowed parent file is then simply unreachable from that step — which is
 * exactly what the human asked for by giving it the same name.
 */
export function attachmentsInScope<T extends { name: string }>(
  own: readonly T[],
  parent: readonly T[],
): T[] {
  const shadowed = new Set(own.map((a) => a.name.toLowerCase()));
  return [...own, ...parent.filter((a) => !shadowed.has(a.name.toLowerCase()))];
}

/**
 * Write `@name` into `text` at the caret — what clicking a chip (or picking from the `@`
 * menu) does — and say where the caret ends up.
 *
 * Spacing is added only where it is missing, on both sides, because the commonest way to
 * ruin a ref is to graft it onto the previous word: `see@shot.png` is not a ref at all
 * (rule 1 of {@link parseAttachmentRefs}), and it would fail silently. The caret lands
 * after the inserted text, so typing continues where the eye is.
 */
export function insertAttachmentRef(
  text: string,
  caret: number,
  name: string,
): { text: string; caret: number } {
  const at = Math.max(0, Math.min(caret, text.length));
  const before = text.slice(0, at);
  const after = text.slice(at);
  const lead = before && !/\s$/.test(before) ? ' ' : '';
  const trail = after && /^\s/.test(after) ? '' : ' ';
  const token = `${lead}@${name}${trail}`;
  return { text: before + token + after, caret: at + token.length };
}
