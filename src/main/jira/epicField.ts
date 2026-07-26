/**
 * Finding an issue's **epic** across JIRA flavours — the link that lets a My Tasks
 * card resolve to the agent project (repo) that owns its epic.
 *
 * There is no single field for this:
 *   - **Server / Data Center** (and Cloud company-managed boards) store it in the
 *     Greenhopper "Epic Link" *custom* field, whose id (`customfield_10008`, …) is
 *     assigned per instance — so it has to be discovered at runtime via `GET /field`
 *     and cached; it cannot be hard-coded.
 *   - **Cloud team-managed** projects instead expose the epic as the issue's plain
 *     `parent`, which needs no discovery.
 *
 * So we discover the custom field once, fail soft to `parent`, and fail soft again to
 * "no epic" (the assign dialog then asks the human to pick a project). Everything here
 * is pure or takes an injected client, so it unit-tests against a mocked `fetch`.
 */
import type { JiraField, JiraIssue } from './jiraClient';

/** The Greenhopper field type behind "Epic Link" — the most reliable identifier. */
export const EPIC_LINK_FIELD_TYPE = 'com.pyxis.greenhopper.jira:gh-epic-link';

/**
 * The cached outcome of epic-field discovery, kept in `app_state`. `fieldId: null`
 * records a *successful* discovery that found no Epic Link field (a team-managed
 * Cloud site) — that's why the cache is an object rather than a bare string, so a
 * negative result isn't re-queried on every sync. `baseUrl` scopes the cache to the
 * site it was discovered on, so pointing the app at another JIRA re-discovers.
 */
export interface JiraEpicFieldCache {
  fieldId: string | null;
  baseUrl: string;
}

/**
 * Pick the "Epic Link" field id out of `GET /field`. Prefers the Greenhopper field
 * type (language-independent), then falls back to the English field name, since some
 * instances rename or re-create the field.
 */
export function findEpicLinkFieldId(fields: JiraField[]): string | null {
  const byType = fields.find((f) => f.schema?.custom === EPIC_LINK_FIELD_TYPE);
  if (byType) return byType.id;
  const byName = fields.find((f) => f.name?.trim().toLowerCase() === 'epic link');
  return byName?.id ?? null;
}

/**
 * Discover the Epic Link field id, returning null if it doesn't exist **or** the
 * lookup fails (e.g. the PAT can't read field metadata). Failing soft matters: epic
 * resolution is a convenience, and a broken `/field` call must never break the sync.
 */
export async function discoverEpicFieldId(client: {
  listFields(): Promise<JiraField[]>;
}): Promise<string | null> {
  try {
    return findEpicLinkFieldId(await client.listFields());
  } catch {
    return null;
  }
}

/**
 * The key of an issue's epic: the discovered custom field first, then `parent`.
 * Upper-cased to match the canonical form agent projects store their epic keys in
 * (see `normalizeEpicKeys` in `store.ts`). Null when the issue hangs off nothing.
 */
export function epicKeyFromIssue(issue: JiraIssue, epicFieldId: string | null): string | null {
  if (epicFieldId) {
    // The Epic Link custom field carries the epic's key as a bare string.
    const raw = (issue.fields as Record<string, unknown>)[epicFieldId];
    if (typeof raw === 'string' && raw.trim()) return raw.trim().toUpperCase();
  }
  const parent = issue.fields.parent?.key;
  return parent?.trim() ? parent.trim().toUpperCase() : null;
}
