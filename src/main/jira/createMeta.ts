/**
 * createMeta — normalizing the two shapes JIRA answers "what can I create?" with.
 *
 * Both the project list and the issue-type list come back differently depending on the
 * deployment and, for issue types, on which of two create-meta endpoints answered. Cloud
 * pages its project search (`{ values: [...] }`) while Server/DC returns a flat array;
 * Cloud's `/issue/createmeta/{key}/issuetypes` returns `{ values }` while the older
 * `/issue/createmeta?projectKeys=…&expand=projects.issuetypes` nests the types under a
 * projects array. Rather than teach the dialog three shapes, everything lands here.
 *
 * Subtask types are filtered out: this dialog creates a card on a board, and a subtask
 * needs a parent it has no way to ask for.
 *
 * Pure — no fetch, no Electron, no DB.
 */

export interface JiraProjectOption {
  key: string;
  name: string;
}

export interface JiraIssueTypeOption {
  id: string;
  name: string;
  /** The icon JIRA uses for the type, when it gave one. */
  iconUrl: string | null;
}

function asArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  const record = value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
  return Array.isArray(record?.values) ? record.values : [];
}

function str(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  if (typeof value === 'string' && value.length > 0) return value;
  if (typeof value === 'number') return String(value);
  return null;
}

/**
 * Projects the user may create in, de-duplicated by key and sorted by name.
 *
 * An empty list is an ANSWER, not a failure: `/project/search` and `createmeta` are both
 * permission-filtered, so a user with no create rights anywhere genuinely has nothing to
 * pick. The dialog says so rather than looking broken.
 */
export function normalizeProjects(raw: unknown): JiraProjectOption[] {
  const byKey = new Map<string, JiraProjectOption>();
  for (const entry of asArray(raw)) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    const key = str(record, 'key');
    if (!key || byKey.has(key)) continue;
    byKey.set(key, { key, name: str(record, 'name') ?? key });
  }
  return [...byKey.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Issue types for one project, from either create-meta endpoint.
 *
 * `projectKey` narrows the nested (legacy) shape, which can carry several projects when
 * the caller asked broadly — without it, a board would offer another project's types.
 */
export function normalizeIssueTypes(raw: unknown, projectKey?: string): JiraIssueTypeOption[] {
  const record = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null;

  // The legacy shape: { projects: [{ key, issuetypes: [...] }] }.
  const projects = record ? asArray(record.projects) : [];
  const flat: unknown[] = projects.length
    ? projects
        .filter((p): p is Record<string, unknown> => Boolean(p) && typeof p === 'object')
        .filter((p) => !projectKey || str(p, 'key') === projectKey)
        .flatMap((p) => asArray(p.issuetypes))
    : asArray(raw);

  const byId = new Map<string, JiraIssueTypeOption>();
  for (const entry of flat) {
    if (!entry || typeof entry !== 'object') continue;
    const type = entry as Record<string, unknown>;
    // A subtask needs a parent this dialog cannot ask for, so it is never offered.
    if (type.subtask === true || type.hierarchyLevel === -1) continue;
    const id = str(type, 'id');
    const name = str(type, 'name');
    if (!id || !name || byId.has(id)) continue;
    byId.set(id, { id, name, iconUrl: str(type, 'iconUrl') });
  }
  return [...byId.values()];
}
