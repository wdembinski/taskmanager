/**
 * The Skill data model and `SKILL.md` codec — F7's "reusable playbook" a card or step
 * carries into every turn of a run, as opposed to a one-shot prompt template
 * (`promptTemplates.ts`).
 *
 * Two kinds, one reference shape: a {@link Skill} is a library row this app owns end to
 * end (editable, synced through the dedicated `/v1/skills` endpoint); a
 * {@link RepoSkillSummary} merely DESCRIBES a `.claude/skills/<name>/SKILL.md` file that
 * already lives in a project's worktree — this module never writes one. {@link SkillRef}
 * is how a `Task` points at either kind without the two colliding on name: a library skill
 * is addressed by its id, a repo skill by its name, and the two are never the same string.
 *
 * `parseSkillMarkdown` / `serializeSkillMarkdown` read and write the same `SKILL.md`
 * frontmatter-then-body shape the `claude` CLI itself expects, by hand — no YAML dependency,
 * because the repo has none and the subset actually needed (two single-line string fields)
 * does not justify adding one. Both are pure and total: a malformed file never throws, it
 * comes back with `warnings` instead, which is how an import surfaces "this worked, but…"
 * to a human rather than failing the whole operation over one bad frontmatter line.
 */

/** A library skill — owned end to end by this app, synced through its own endpoint
 *  (`/v1/skills`) rather than riding `SyncRequest` (see `one-answer-wedges-the-mirror`). */
export interface Skill {
  /** uuid. */
  id: string;
  /** `SKILL_NAME_RE` slug — shown in pickers alongside `description`, and what a `repo:`
   *  ref would collide with if the two kinds shared a namespace, which is why they don't. */
  name: string;
  /** One line, shown in pickers. */
  description: string;
  /** Markdown, bounded by {@link SKILL_BODY_MAX} — enforced by the store and the server's
   *  413, never by this module. */
  body: string;
  createdAt: number;
  updatedAt: number;
}

/** What a project mirror carries for a repo skill: enough to list and pick it without ever
 *  syncing its body (repo skills are read from the worktree at run time, not stored). */
export interface RepoSkillSummary {
  projectId: string;
  name: string;
  description: string;
  /** Where it lives on disk, relative to the project root, for display and for the
   *  "Skills in force" prompt section to name. */
  path: string;
}

/** A repo skill read in full — `skill:getRepo`'s answer, for F7.8's "Copy to library".
 *  `path` is relative like {@link RepoSkillSummary.path}, never the host's absolute `dir`. */
export interface RepoSkillDetail {
  name: string;
  description: string;
  body: string;
  path: string;
  warnings: string[];
}

/**
 * `skill:save`'s input — what an editor has in hand before a save mints the rest. `id`
 * absent means "new skill": the handler mints a uuid, and there is no existing row to keep
 * `createdAt` from.
 */
export interface SkillDraft {
  id?: string;
  name: string;
  description: string;
  body: string;
}

/**
 * `skill:save`'s answer. A value, not a throw, because a name clash is something the UI
 * offers "replace" over rather than an error to show and abandon — the same reason
 * {@link SkillImportResult}'s `'clash'` status is a value too.
 *
 * Mirrors the store's own `SaveSkillResult` (`apps/client/src/main/store.ts`) plus a
 * human-readable `message` on refusal; the store stays reason-only since nothing inside the
 * main process needs a sentence, only the handler that hands one to a human.
 */
export type SkillSaveResult =
  | { ok: true; skill: Skill }
  | { ok: false; reason: 'invalid-name' | 'too-large' | 'name-taken'; message: string };

/** `skill:import`'s input — one call imports a batch from exactly one source. Pasted text
 *  carries its own bytes because there is no file for the main process to read. */
export type SkillImportRequest =
  { source: 'files' } | { source: 'folder' } | { source: 'text'; text: string };

/**
 * One imported candidate's outcome, discriminated on `status`. A batch (`skill:import`'s
 * answer) is an array of these, one per file/paste — never a single refusal for the whole
 * call, so one bad file in a folder import does not cost the rest.
 */
export type SkillImportResult =
  | {
      status: 'imported';
      skill: Skill;
      warnings: string[];
      source: SkillImportRequest['source'];
    }
  | {
      /** A skill already exists with this name — the UI offers "Replace", which is just
       *  `skill:save({ ...candidate, id: existing.id })`; no re-pick, no `replace` flag. */
      status: 'clash';
      candidate: Pick<Skill, 'name' | 'description' | 'body'>;
      existing: Skill;
      source: SkillImportRequest['source'];
      message: string;
    }
  | {
      status: 'refused';
      source: SkillImportRequest['source'];
      reason: 'no-name' | 'too-large' | 'unreadable';
      message: string;
    };

/** `skill:export`'s answer: every library skill named in the call that was actually written,
 *  by name, under `dir/<name>/SKILL.md` — the CLI's own layout, so committing `dir` under a
 *  project's `.claude/skills` makes each one a repo skill. */
export interface SkillExportResult {
  dir: string;
  written: string[];
}

/** A `Task.skillRefs` entry: which kind, and the id/name that addresses it within that
 *  kind. See {@link formatSkillRef} / {@link parseSkillRef} for the serialised form a
 *  `Task` actually stores. */
export type SkillRef = { kind: 'library'; id: string } | { kind: 'repo'; name: string };

/**
 * 64 KiB. The server's `/v1/skills` answers 413 over this, and the desktop store enforces
 * the same cap on write (Settings then shows "too large to sync"). Exported so both sides
 * read the same number rather than each hard-coding `65536`.
 *
 * This module does not enforce it: {@link parseSkillMarkdown} and
 * {@link serializeSkillMarkdown} are pure text transforms and never truncate or reject a
 * body for size, so an over-budget import still parses — it is the store/server's job to
 * refuse the write, not the parser's job to silently cut the file short.
 */
export const SKILL_BODY_MAX = 64 * 1024;

/** The slug `Skill.name` and a `repo:` ref's name must satisfy — lower-case ASCII, digits
 *  and hyphens, 1 to 64 characters. The same shape a URL path segment or a CLI skill
 *  directory name would want. */
export const SKILL_NAME_RE = /^[a-z0-9-]{1,64}$/;

/** Whether `value` is a string matching {@link SKILL_NAME_RE} — a type guard so a caller
 *  reading untrusted input (a frontmatter field, an IPC payload) narrows in one call. */
export function isValidSkillName(value: unknown): value is string {
  return typeof value === 'string' && SKILL_NAME_RE.test(value);
}

/**
 * `fileName` (a bare name, never a path — a caller importing a `SKILL.md` passes its
 * parent folder's name instead, see `fallbackNameFromPath` in `skillHandlers.ts`), slugged
 * to {@link SKILL_NAME_RE}'s shape for use as an import's fallback skill name: a trailing
 * `.md` is dropped case-insensitively, then every run of characters outside `[a-z0-9]`
 * becomes one hyphen, leading/trailing hyphens are trimmed, and the result is capped at 64
 * characters (trimming a hyphen the cap exposes too).
 *
 * `''` — never a string that fails {@link isValidSkillName} — when nothing usable
 * survives, e.g. a name made entirely of punctuation.
 */
export function skillNameFromFileName(fileName: string): string {
  const stem = fileName.replace(/\.md$/i, '');
  const collapsed = stem
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const capped = collapsed.slice(0, 64).replace(/-+$/g, '');
  return isValidSkillName(capped) ? capped : '';
}

const LIBRARY_PREFIX = 'lib';
const REPO_PREFIX = 'repo';

/** `{ kind: 'library', id }` → `lib:<id>`; `{ kind: 'repo', name }` → `repo:<name>`. The
 *  prefix is what keeps the two kinds from ever colliding on the same string even when a
 *  library id and a repo name happen to match. */
export function formatSkillRef(ref: SkillRef): string {
  return ref.kind === 'library' ? `${LIBRARY_PREFIX}:${ref.id}` : `${REPO_PREFIX}:${ref.name}`;
}

/**
 * The inverse of {@link formatSkillRef}. `null` for anything that is not an unambiguous
 * ref: no `:` at all, a prefix other than `lib`/`repo`, an empty library id, a library id
 * containing whitespace, or a repo name that fails {@link isValidSkillName}.
 *
 * A library id is accepted as any non-empty, whitespace-free string — today that is always
 * a uuid, but this does not pin the format down further than the codec actually needs.
 * Only the OUTER whitespace of `raw` is trimmed; nothing between the prefix and the id/name
 * is touched, so `formatSkillRef` and this stay exact inverses of each other
 * (`parseSkillRef(formatSkillRef(r))` deep-equals `r`).
 */
export function parseSkillRef(raw: string): SkillRef | null {
  const trimmed = raw.trim();
  const colonIndex = trimmed.indexOf(':');
  if (colonIndex === -1) return null;
  const prefix = trimmed.slice(0, colonIndex);
  const rest = trimmed.slice(colonIndex + 1);

  if (prefix === LIBRARY_PREFIX) {
    return rest && !/\s/.test(rest) ? { kind: 'library', id: rest } : null;
  }
  if (prefix === REPO_PREFIX) {
    return isValidSkillName(rest) ? { kind: 'repo', name: rest } : null;
  }
  return null;
}

/** The result of reading a `SKILL.md`-shaped file. Total: every input produces one of
 *  these, never a thrown error — `warnings` is how a caller tells a human "this imported,
 *  but look here" instead of refusing the whole import over a frontmatter quirk. */
export interface ParsedSkillMarkdown {
  name: string;
  description: string;
  body: string;
  warnings: string[];
}

const FRONTMATTER_DELIMITER = '---';

/** A `key: value` frontmatter line. The key matches a CLI/YAML identifier
 *  (`[A-Za-z][A-Za-z0-9_-]*`); everything after the colon — including no separating space
 *  at all — is the raw value, unquoted by {@link unquoteFrontmatterValue}. */
const FRONTMATTER_KEY_VALUE_RE = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/;

/** Strip one layer of outer `"…"` / `'…'` quoting. Double quotes unescape `\"` and `\\`
 *  (the only two escapes {@link escapeDoubleQuoted} ever produces); single quotes carry no
 *  escaping of their own, matching the subset of YAML this module actually speaks. */
function unquoteFrontmatterValue(raw: string): string {
  const value = raw.trim();
  if (value.length >= 2 && value[0] === '"' && value[value.length - 1] === '"') {
    return value.slice(1, -1).replace(/\\(["\\])/g, '$1');
  }
  if (value.length >= 2 && value[0] === "'" && value[value.length - 1] === "'") {
    return value.slice(1, -1);
  }
  return value;
}

/** `fallbackName`, narrowed to a usable skill name — `''` when it is missing or itself not
 *  a valid slug, so a caller never has to re-check it before using it. */
function usableFallback(fallbackName: string | undefined): string {
  return fallbackName !== undefined && isValidSkillName(fallbackName) ? fallbackName : '';
}

/** The "no usable frontmatter" result shared by both ways of getting there: no opening
 *  delimiter at all, and an opening delimiter with no closing one. Either way the whole
 *  (already CRLF-normalised) text is the body, verbatim — nothing is trimmed, because
 *  nothing was recognised as a frontmatter block to trim around. */
function wholeTextAsBody(
  normalized: string,
  fallbackName: string | undefined,
  warning: string,
): ParsedSkillMarkdown {
  return {
    name: usableFallback(fallbackName),
    description: '',
    body: normalized,
    warnings: [warning],
  };
}

/**
 * Read a `SKILL.md`-shaped file apart into its `name`/`description`/`body`, tolerating
 * every malformed shape the CLI's own skills (or a hand-edited import) might carry.
 *
 * Recognises frontmatter only when line 1 is exactly `---` (after `trimEnd`, so trailing
 * spaces on that line do not disqualify it) and some later line is also exactly `---`;
 * between them, each line is read as `key: value` and unrecognised lines (block scalars,
 * lists, nested maps — anything this module does not speak) are skipped with one warning
 * apiece rather than losing the rest of the file over them. `name`/`description` inside
 * that block are unquoted with {@link unquoteFrontmatterValue}; every other key is read
 * and ignored silently, since an unknown key is not a fault.
 */
export function parseSkillMarkdown(text: string, fallbackName?: string): ParsedSkillMarkdown {
  const normalized = text.replace(/\r\n/g, '\n').replace(/^\uFEFF/, '');
  const lines = normalized.split('\n');

  if (lines[0].trimEnd() !== FRONTMATTER_DELIMITER) {
    return wholeTextAsBody(
      normalized,
      fallbackName,
      'no frontmatter found; the whole file is the body',
    );
  }

  const closingIndex = lines.findIndex(
    (line, index) => index > 0 && line.trimEnd() === FRONTMATTER_DELIMITER,
  );
  if (closingIndex === -1) {
    return wholeTextAsBody(
      normalized,
      fallbackName,
      'frontmatter opened with "---" but never closed; the whole file is the body',
    );
  }

  const warnings: string[] = [];
  const fields: Record<string, string> = {};
  for (const line of lines.slice(1, closingIndex)) {
    if (line.trim() === '') continue;
    const match = FRONTMATTER_KEY_VALUE_RE.exec(line);
    if (!match) {
      warnings.push(`ignored a frontmatter line that was not "key: value": ${line.trim()}`);
      continue;
    }
    fields[match[1]] = unquoteFrontmatterValue(match[2]);
  }

  const fallback = usableFallback(fallbackName);
  let name = fields.name;
  if (name === undefined) {
    warnings.push('frontmatter has no name; using the fallback name instead');
    name = fallback;
  } else if (!isValidSkillName(name)) {
    warnings.push(
      `frontmatter name "${name}" is not a valid skill name; using the fallback name instead`,
    );
    name = fallback;
  }

  let description = fields.description;
  if (description === undefined) {
    warnings.push('frontmatter has no description; using an empty one');
    description = '';
  }

  const bodyLines = lines.slice(closingIndex + 1);
  let bodyStart = 0;
  while (bodyStart < bodyLines.length && bodyLines[bodyStart].trim() === '') bodyStart += 1;
  const body = bodyLines.slice(bodyStart).join('\n').trimEnd();

  return { name, description, body, warnings };
}

/** `description`'s embedded newlines collapsed to single spaces — a `SKILL.md` field is
 *  single-line by contract, so a multi-line description is flattened rather than rejected. */
function collapseToOneLine(description: string): string {
  return description.replace(/\r?\n/g, ' ');
}

/** Characters that, anywhere in the collapsed description, force quoting so the colon (or
 *  quote, or backslash) is not read as YAML structure or as ending the value early. */
const QUOTE_TRIGGER_RE = /[:#"'\\]/;

/** Characters that, as the FIRST character of the collapsed description, are YAML-
 *  significant on their own (block/flow markers, comments, anchors, directives) and so
 *  force quoting even though none of {@link QUOTE_TRIGGER_RE} appears anywhere in the value. */
const YAML_LEADING_CHARS = new Set(['-', '[', '{', '>', '|', '*', '&', '!', '%', '@', '`']);

/** Whether `collapsed` (already newline-flattened, NOT yet trimmed) needs `"…"` quoting for
 *  {@link serializeSkillMarkdown} to round-trip it unchanged: empty, carrying leading/
 *  trailing spaces that an unquoted `key: value` line's own `\s*` would otherwise eat, or
 *  containing/starting with a character {@link parseSkillMarkdown} (or any YAML reader)
 *  would treat as structure rather than text. */
function needsQuoting(collapsed: string): boolean {
  if (collapsed === '') return true;
  if (collapsed.trim() !== collapsed) return true;
  if (QUOTE_TRIGGER_RE.test(collapsed)) return true;
  return YAML_LEADING_CHARS.has(collapsed[0]);
}

/** Escape `\` then `"` — in that order, so a literal backslash is not mistaken for the
 *  start of the escape it is about to become. The exact inverse of
 *  {@link unquoteFrontmatterValue}'s `\(["\\])` unescape. */
function escapeDoubleQuoted(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/** `description`, formatted the way {@link serializeSkillMarkdown} writes it: one line,
 *  quoted exactly when {@link needsQuoting} says reading it back unquoted would lose or
 *  misread something. */
function formatDescription(description: string): string {
  const collapsed = collapseToOneLine(description);
  return needsQuoting(collapsed) ? `"${escapeDoubleQuoted(collapsed)}"` : collapsed;
}

/**
 * Write a `SKILL.md`: `---\nname: <name>\ndescription: <description>\n---\n\n<body>\n`,
 * LF endings throughout.
 *
 * Exact inverse of {@link parseSkillMarkdown} for any `name`/`description`/`body` a caller
 * actually has in hand: `parseSkillMarkdown(serializeSkillMarkdown(s))` yields `s.name`,
 * `s.description` one-lined, and `s.body.trimEnd()` (CRLF already normalised on the way
 * in), with no warnings — the quoting rules above exist specifically so that reading this
 * back never needs a warning.
 */
export function serializeSkillMarkdown(
  skill: Pick<Skill, 'name' | 'description' | 'body'>,
): string {
  return `---\nname: ${skill.name}\ndescription: ${formatDescription(skill.description)}\n---\n\n${skill.body}\n`;
}
