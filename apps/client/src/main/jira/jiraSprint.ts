/**
 * Sprints — narrowing the board to what's in flight, and naming the sprint a card
 * belongs to (Phase 14).
 *
 * Two separate problems, both solved here because they share a subject:
 *
 *   1. **Filtering.** "The current sprint" is expressed in JQL as `sprint in
 *      openSprints()`, which works on Cloud and Server/DC alike and needs no board to
 *      be configured. Composing it into the user's own JQL is the fiddly part: the
 *      clause has to land *before* `ORDER BY`, or JIRA rejects the query.
 *   2. **Naming.** The sprint an issue sits in lives in a Greenhopper *custom* field
 *      whose id is per-instance, exactly like "Epic Link" — so it is discovered at
 *      runtime via `GET /field` and cached, never hard-coded (see `epicField.ts`,
 *      which this deliberately mirrors).
 *
 * Everything is pure or takes an injected client, so it unit-tests against a mocked
 * `fetch`.
 */
import type { JiraField, JiraIssue } from './jiraClient';

/** The Greenhopper field type behind "Sprint" — the language-independent identifier. */
export const SPRINT_FIELD_TYPE = 'com.pyxis.greenhopper.jira:gh-sprint';

/** The JQL clause selecting every sprint that is currently running. */
export const OPEN_SPRINTS_CLAUSE = 'sprint in openSprints()';

/**
 * The cached outcome of sprint-field discovery, kept in `app_state`. `fieldId: null`
 * records a *successful* discovery that found no Sprint field (an instance without
 * JIRA Software), so a negative result isn't re-queried on every sync. `baseUrl`
 * scopes the cache to the site it came from.
 */
export interface JiraSprintFieldCache {
  fieldId: string | null;
  baseUrl: string;
}

/**
 * Split a JQL string into its filter and its trailing `ORDER BY`. Scans for the
 * keyword outside quotes, because `summary ~ "order by tuesday"` is a legal filter
 * and a blind `indexOf` would cut the query in half at the wrong place.
 */
export function splitOrderBy(jql: string): { where: string; orderBy: string } {
  let quote: string | null = null;
  for (let i = 0; i < jql.length; i++) {
    const ch = jql[i];
    if (quote) {
      // Backslash escapes the next character inside a JQL string literal.
      if (ch === '\\') i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if ((ch === 'o' || ch === 'O') && /^order\s+by\b/i.test(jql.slice(i))) {
      // Only a token boundary counts, so `reorder by` isn't mistaken for a clause.
      if (i > 0 && /[\w.]/.test(jql[i - 1])) continue;
      return { where: jql.slice(0, i).trim(), orderBy: jql.slice(i).trim() };
    }
  }
  return { where: jql.trim(), orderBy: '' };
}

/**
 * Add "only issues in a running sprint" to a JQL query, preserving its sort.
 *
 * The existing filter is parenthesised before the `AND`: a query ending in a top-level
 * `OR` (`assignee = me OR reporter = me`) would otherwise bind the new clause to the
 * last branch only, quietly widening the board instead of narrowing it.
 */
export function withCurrentSprint(jql: string): string {
  const { where, orderBy } = splitOrderBy(jql);
  const filter = where ? `(${where}) AND ${OPEN_SPRINTS_CLAUSE}` : OPEN_SPRINTS_CLAUSE;
  return orderBy ? `${filter} ${orderBy}` : filter;
}

/**
 * Pick the "Sprint" field id out of `GET /field`. Prefers the Greenhopper field type,
 * then the English field name, since instances rename or re-create the field.
 */
export function findSprintFieldId(fields: JiraField[]): string | null {
  const byType = fields.find((f) => f.schema?.custom === SPRINT_FIELD_TYPE);
  if (byType) return byType.id;
  const byName = fields.find((f) => f.name?.trim().toLowerCase() === 'sprint');
  return byName?.id ?? null;
}

/**
 * Discover the Sprint field id, returning null if it doesn't exist **or** the lookup
 * fails. Failing soft matters: the sprint name is a label on a card, and a broken
 * `/field` call must never break the sync.
 */
export async function discoverSprintFieldId(client: {
  listFields(): Promise<JiraField[]>;
}): Promise<string | null> {
  try {
    return findSprintFieldId(await client.listFields());
  } catch {
    return null;
  }
}

/** One sprint as we care about it: what to show, and whether it's the running one. */
interface ParsedSprint {
  name: string;
  active: boolean;
}

/**
 * Read one entry of the sprint field, which comes in two shapes across JIRA versions:
 * a proper object (Cloud, and Server since ~7.x), or the toString() of a Java object
 * that older Server/DC instances still emit —
 * `com.atlassian.greenhopper.service.sprint.Sprint@1a2b[id=7,name=Sprint 5,state=ACTIVE,…]`.
 */
function parseSprintEntry(entry: unknown): ParsedSprint | null {
  if (entry && typeof entry === 'object') {
    const o = entry as { name?: unknown; state?: unknown };
    if (typeof o.name !== 'string' || !o.name.trim()) return null;
    return {
      name: o.name.trim(),
      active: typeof o.state === 'string' && o.state.toLowerCase() === 'active',
    };
  }
  if (typeof entry === 'string') {
    // `name=` runs to the next comma-delimited `key=` or the closing bracket, so a
    // sprint literally called "Sprint 5, part 2" survives.
    const name = /[,\[]name=(.*?)(?:,\s*\w+=|\]$|$)/.exec(entry)?.[1]?.trim();
    if (!name) return null;
    const state = /[,\[]state=(\w+)/.exec(entry)?.[1] ?? '';
    return { name, active: state.toLowerCase() === 'active' };
  }
  return null;
}

/**
 * The sprint name to show on a card. An issue can carry several sprints — every one it
 * has ever been in, closed ones included — so a running sprint always wins; failing
 * that we show the last entry, which is the most recent one JIRA reports.
 */
export function sprintNameFromIssue(issue: JiraIssue, sprintFieldId: string | null): string | null {
  if (!sprintFieldId) return null;
  const raw = (issue.fields as Record<string, unknown>)[sprintFieldId];
  if (raw == null) return null;
  const entries = (Array.isArray(raw) ? raw : [raw])
    .map(parseSprintEntry)
    .filter((s): s is ParsedSprint => s !== null);
  if (entries.length === 0) return null;
  return (entries.find((s) => s.active) ?? entries[entries.length - 1]).name;
}
