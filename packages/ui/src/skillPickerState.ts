/**
 * The skill picker's pure state (F7.9), shared by `AssignAgentDialog`, `TaskAgentPanel` and
 * each `TaskSteps` row. No React — a row list and a handful of pure transforms the three
 * surfaces drive their own popover/list rendering from.
 *
 * `own` is always the open task's OWN `skillRefs` — never the card-plus-step union a run
 * actually executes with. A step's inherited (card) refs are shown for context (checked,
 * captioned "from card") but are never part of `own`, and toggling one is a no-op: there is
 * no task whose `skillRefs` that click could write to without silently moving the ref from
 * the card to the step. See `F7-skills-and-prompt-templates.md`'s F7.9 decisions.
 */
import {
  canonicalSkillRef,
  formatSkillRef,
  type RepoSkillSummary,
  type Skill,
} from '@tm/shared/skills';

/** One row's source — which list it came from, shown as the row's caption when it is not
 *  inherited or missing. */
export interface SkillOption {
  ref: string;
  name: string;
  description: string;
  source: 'library' | 'repo';
}

/** `library`'s rows, then `repo`'s, each group sorted by name — library and repo never
 *  interleave, so the two sources stay visually grouped regardless of name collisions
 *  between them (which cannot happen anyway: {@link formatSkillRef} keeps their refs apart). */
export function skillOptions(library: Skill[], repo: RepoSkillSummary[]): SkillOption[] {
  const toOption = (
    source: SkillOption['source'],
    item: Pick<Skill | RepoSkillSummary, 'name' | 'description'>,
    ref: string,
  ): SkillOption => ({ ref, name: item.name, description: item.description, source });

  const libraryOptions = library
    .map((skill) => toOption('library', skill, formatSkillRef({ kind: 'library', id: skill.id })))
    .sort((a, b) => a.name.localeCompare(b.name));
  const repoOptions = repo
    .map((skill) => toOption('repo', skill, formatSkillRef({ kind: 'repo', name: skill.name })))
    .sort((a, b) => a.name.localeCompare(b.name));

  return [...libraryOptions, ...repoOptions];
}

/** Case-insensitive substring match on `name` OR `description`; a blank (or all-whitespace)
 *  `query` matches everything. */
export function filterSkillOptions(options: SkillOption[], query: string): SkillOption[] {
  const needle = query.trim().toLowerCase();
  if (needle === '') return options;
  return options.filter(
    (option) =>
      option.name.toLowerCase().includes(needle) ||
      option.description.toLowerCase().includes(needle),
  );
}

/** The refs a picker is rendering against: `own` is the open task's own `skillRefs`;
 *  `inherited` is the parent card's (empty for a card's own picker, or a dialog with no
 *  parent card yet). Neither needs to be pre-canonicalised — every function here does that
 *  itself before comparing. */
export interface SkillPickerRefs {
  own: string[];
  inherited: string[];
}

/** One row a picker renders: a label to show, a caption naming why, and whether clicking it
 *  does anything. `missing` rows have no {@link SkillOption} behind them — `label` is then
 *  the raw canonical ref text, since there is no name left to show. */
export interface SkillPickerRow {
  ref: string;
  label: string;
  caption: 'from card' | 'library' | 'repo' | 'missing';
  state: 'inherited' | 'selected' | 'available' | 'missing';
  removable: boolean;
}

function dedupeCanonical(refs: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of refs) {
    const ref = canonicalSkillRef(raw);
    if (seen.has(ref)) continue;
    seen.add(ref);
    result.push(ref);
  }
  return result;
}

/**
 * Every row a picker shows: one per {@link SkillOption} matching `query` (filtered by
 * {@link filterSkillOptions}), in `options` order, plus one `missing` row — ignoring
 * `query`, since there is nothing to search — for every own/inherited ref with no matching
 * option, in inherited-then-own order with duplicates collapsed to one row.
 *
 * A ref that is both inherited and own (a step whose own `skillRefs` happens to repeat a
 * card ref) renders as a single `inherited` row — inherited wins the duplicate, matching
 * {@link "@tm/shared/skills".effectiveSkillRefs}'s "card wins order" rule.
 */
export function pickerRows(
  options: SkillOption[],
  refs: SkillPickerRefs,
  query: string,
): SkillPickerRow[] {
  const inherited = new Set(dedupeCanonical(refs.inherited));
  const own = new Set(dedupeCanonical(refs.own));
  const optionRefs = new Set(options.map((option) => option.ref));

  const matchedRows = filterSkillOptions(options, query).map((option): SkillPickerRow => {
    if (inherited.has(option.ref)) {
      return {
        ref: option.ref,
        label: option.name,
        caption: 'from card',
        state: 'inherited',
        removable: false,
      };
    }
    if (own.has(option.ref)) {
      return {
        ref: option.ref,
        label: option.name,
        caption: option.source,
        state: 'selected',
        removable: true,
      };
    }
    return {
      ref: option.ref,
      label: option.name,
      caption: option.source,
      state: 'available',
      removable: false,
    };
  });

  const missingRows = dedupeCanonical([...refs.inherited, ...refs.own])
    .filter((ref) => !optionRefs.has(ref))
    .map((ref): SkillPickerRow => ({
      ref,
      label: ref,
      caption: 'missing',
      state: 'missing',
      removable: !inherited.has(ref),
    }));

  return [...matchedRows, ...missingRows];
}

/**
 * The task's next own `skillRefs` after clicking `ref`: canonicalised, deduplicated (first
 * occurrence kept), order preserved, with `ref` removed if already present or appended if
 * not. `own` comes back completely unchanged — not even re-canonicalised — when `ref` is one
 * of `inherited`'s: there is no task this click could write to, so nothing changes.
 */
export function toggleSkillRef(own: string[], inherited: string[], ref: string): string[] {
  const canonical = canonicalSkillRef(ref);
  if (inherited.some((raw) => canonicalSkillRef(raw) === canonical)) return own;

  const deduped = dedupeCanonical(own);
  return deduped.includes(canonical)
    ? deduped.filter((existing) => existing !== canonical)
    : [...deduped, canonical];
}

/**
 * The names behind `effectiveRefs` (typically `effectiveSkillRefs(card, step)`) for the
 * agent panel's "Skills · a · b" line, in the same order: the matching {@link SkillOption}'s
 * `name`, or the raw canonical ref text when nothing in `options` matches (a dangling ref —
 * same "never silently drop it" rule as {@link pickerRows}'s `missing` rows). `[]` when
 * `effectiveRefs` is empty, so the caller renders no line rather than a bare "Skills ·".
 */
export function skillsLineLabels(effectiveRefs: string[], options: SkillOption[]): string[] {
  const byRef = new Map(options.map((option) => [option.ref, option.name] as const));
  return effectiveRefs.map((ref) => byRef.get(canonicalSkillRef(ref)) ?? canonicalSkillRef(ref));
}
