/**
 * Building the GraphQL requests Linear's sync and moves send — never sending them.
 *
 * `jira/jiraJql.ts`, one tracker over: pure string/object assembly, no client, so every
 * shape here is unit-testable without a fake server. The one question worth getting right
 * is the same one JIRA's module exists for — "of these issues, which still match?" — and
 * Linear answers it differently enough to need its own module rather than a flag on JIRA's.
 *
 * `issuesQuery` asks the SCOPED question ("what does the user's filter currently select?"),
 * paged and ordered. `issuesByIdQuery` asks the UNSCOPED one ("do these specific issues still
 * exist, and in what state?") — deliberately NOT ANDed with the settings filter, because a
 * card resting in Done after it stopped matching `includeStateTypes` must still be re-readable
 * by its own id. Conflating the two would make retention impossible to re-check: the very
 * narrowing that moved the issue out of the board's scope would also stop it from being asked
 * about again.
 *
 * Identity is the Linear UUID (`identifier` is mutable — a team move renames `ENG-12` to
 * `OPS-40` without changing the issue), so `isLinearId` and the UUID shape are the one thing
 * guarded before any id-shaped value reaches a GraphQL variable or an interpolated string.
 */
import type { LinearSettings, LinearStateType } from '@shared/settings';

/** A GraphQL request ready to hand to the client: the document plus its variables. */
export interface LinearRequest {
  query: string;
  variables: Record<string, unknown>;
}

/** Linear's own `IssueFilter` GraphQL input — a nested bag of operators, not typed field by field. */
export type IssueFilter = Record<string, unknown>;

/**
 * The fields every issue query asks for — shared between the scoped and by-id queries so the
 * two can never quietly drift on what a sync actually sees.
 */
const ISSUE_FIELDS = `
  id
  identifier
  title
  description
  url
  priority
  updatedAt
  state { id name type }
  team { id key }
  labels { nodes { name } }
  assignee { id name }
`;

/** Every {@link LinearStateType} Linear itself defines — anything else is a value worth distrust. */
const KNOWN_STATE_TYPES: readonly LinearStateType[] = [
  'triage',
  'backlog',
  'unstarted',
  'started',
  'completed',
  'canceled',
];

/**
 * UUID v4-shaped. Linear's own ids (issues, states, users) are all v4, and this is the one gate
 * every id reaching a mutation or an interpolated `first:` count goes through before it does —
 * see `isLinearId`.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Whether a stored value is safe to use as a Linear id. */
export function isLinearId(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value.trim());
}

/**
 * Parse {@link LinearSettings.advancedFilter} into an {@link IssueFilter}, or explain why it
 * can't be used. Blank/undefined is not an error — it means "nothing extra" — and an empty
 * object (`{}`) is treated the same way, since ANDing it onto the rest of the filter would
 * change nothing anyway.
 *
 * Every error names "Linear advanced filter" so Settings and the status bar can show the
 * message as-is without having to say where it came from themselves.
 */
export function parseAdvancedFilter(
  raw: string | undefined,
): { ok: true; filter: IssueFilter | null } | { ok: false; error: string } {
  const trimmed = raw?.trim();
  if (!trimmed) return { ok: true, filter: null };

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Linear advanced filter is not valid JSON: ${message}` };
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: 'Linear advanced filter must be a JSON object.' };
  }

  const filter = parsed as IssueFilter;
  return { ok: true, filter: Object.keys(filter).length === 0 ? null : filter };
}

/**
 * The `IssueFilter` a sync should ask Linear for, from the declarative settings fields plus
 * whatever {@link LinearSettings.advancedFilter} adds.
 *
 * Returns an error — never a filter — when no team key survives: empty teams must mirror
 * nothing (see the field's own doc), and a filter with no `team` clause at all would instead
 * pull the entire workspace, which is the opposite of what an empty `teamKeys` means.
 */
export function buildIssueFilter(
  settings: Pick<LinearSettings, 'teamKeys' | 'assignee' | 'includeStateTypes' | 'advancedFilter'>,
): { ok: true; filter: IssueFilter } | { ok: false; error: string } {
  const advanced = parseAdvancedFilter(settings.advancedFilter);
  if (!advanced.ok) return advanced;

  const teamKeys = [...new Set(settings.teamKeys.map((key) => key.trim()).filter(Boolean))];
  if (teamKeys.length === 0) {
    return {
      ok: false,
      error: 'Linear has no team selected — add at least one team key before syncing.',
    };
  }

  const and: IssueFilter[] = [{ team: { key: { in: teamKeys } } }];

  if (settings.assignee === 'me') {
    and.push({ assignee: { isMe: { eq: true } } });
  }

  const stateTypes = settings.includeStateTypes.filter((type) => KNOWN_STATE_TYPES.includes(type));
  if (stateTypes.length > 0) {
    and.push({ state: { type: { in: stateTypes } } });
  }

  if (advanced.filter) {
    and.push(advanced.filter);
  }

  return { ok: true, filter: { and } };
}

/**
 * The board's scoped issues query: Linear's own `issues` connection, filtered and paged,
 * newest-updated first so an interrupted sync resumes having seen the issues most likely to
 * have changed again by the time it comes back.
 */
export function issuesQuery(
  filter: IssueFilter,
  after: string | null = null,
  first = 50,
): LinearRequest {
  return {
    query: `
      query Issues($first: Int!, $after: String, $filter: IssueFilter) {
        issues(first: $first, after: $after, filter: $filter, orderBy: updatedAt) {
          nodes { ${ISSUE_FIELDS} }
          pageInfo { hasNextPage endCursor }
        }
      }
    `,
    variables: { first, after, filter },
  };
}

/**
 * Split issue ids into request-sized batches — the same reasoning as `jiraJql.ts`'s
 * `chunkKeys`, at the same size.
 */
export function chunkIds(ids: readonly string[], size = 50): string[][] {
  const step = Math.max(1, Math.floor(size));
  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += step) chunks.push(ids.slice(i, i + step));
  return chunks;
}

/**
 * The retained-issue re-read: "of these ids, which still exist, and in what state?" — the
 * Linear analogue of `jiraJql.ts`'s `withKeysIn`, and deliberately not ANDed with the settings
 * filter for the same reason that one is scoped to keys alone: this is what done-retention
 * needs to ask, and the settings filter is precisely the thing a finished issue may have
 * already fallen out of.
 *
 * Returns `null` when no id survives validation — the caller's "nothing to ask", same as
 * `withKeysIn`'s `''`.
 */
export function issuesByIdQuery(ids: readonly unknown[]): LinearRequest | null {
  const valid = [...new Set(ids.filter(isLinearId).map((id) => id.trim()))];
  if (valid.length === 0) return null;

  return {
    query: `
      query IssuesByIds($ids: [String!]!) {
        issues(first: ${valid.length}, filter: { id: { in: $ids } }) {
          nodes { ${ISSUE_FIELDS} }
          pageInfo { hasNextPage endCursor }
        }
      }
    `,
    variables: { ids: valid },
  };
}

/** Fetch one issue's comments, paged. Throws on an invalid id — a programming error, not user input. */
export function commentsQuery(issueId: string, after: string | null = null): LinearRequest {
  if (!isLinearId(issueId)) throw new Error(`commentsQuery: not a Linear id: ${issueId}`);

  return {
    query: `
      query IssueComments($id: String!, $after: String) {
        issue(id: $id) {
          comments(first: 50, after: $after) {
            nodes { id body createdAt url user { id name displayName } }
            pageInfo { hasNextPage endCursor }
          }
        }
      }
    `,
    variables: { id: issueId.trim(), after },
  };
}

/** The authenticated token's own identity — who "mine" means when deciding an unread comment. */
export function viewerQuery(): LinearRequest {
  return {
    query: `
      query Viewer {
        viewer { id name displayName }
      }
    `,
    variables: {},
  };
}

/** Every team in the workspace, for the Settings `teamKeys` picker. */
export function teamsQuery(): LinearRequest {
  return {
    query: `
      query Teams {
        teams(first: 100) {
          nodes { id key name }
        }
      }
    `,
    variables: {},
  };
}

/**
 * One team's workflow states, for the Settings status-map viewer. `teamKey` travels as a
 * variable, never interpolated into the document — the same discipline every id-bearing query
 * here follows, even though a team key is not itself a Linear id.
 */
export function teamStatesQuery(teamKey: string): LinearRequest {
  return {
    query: `
      query TeamStates($key: String!) {
        workflowStates(filter: { team: { key: { eq: $key } } }, first: 100) {
          nodes { id name type position }
        }
      }
    `,
    variables: { key: teamKey },
  };
}

/** Move an issue to a new workflow state. Throws on an invalid id — a programming error. */
export function issueUpdateStateMutation(issueId: string, stateId: string): LinearRequest {
  if (!isLinearId(issueId))
    throw new Error(`issueUpdateStateMutation: not a Linear id: ${issueId}`);
  if (!isLinearId(stateId))
    throw new Error(`issueUpdateStateMutation: not a Linear id: ${stateId}`);

  return {
    query: `
      mutation IssueUpdateState($id: String!, $stateId: String!) {
        issueUpdate(id: $id, input: { stateId: $stateId }) {
          success
          issue { id identifier state { id name type } }
        }
      }
    `,
    variables: { id: issueId.trim(), stateId: stateId.trim() },
  };
}

/** Post a comment on an issue. Throws on an invalid id — a programming error. */
export function commentCreateMutation(issueId: string, body: string): LinearRequest {
  if (!isLinearId(issueId)) throw new Error(`commentCreateMutation: not a Linear id: ${issueId}`);

  return {
    query: `
      mutation CommentCreate($issueId: String!, $body: String!) {
        commentCreate(input: { issueId: $issueId, body: $body }) {
          success
          comment { id body createdAt url user { name displayName } }
        }
      }
    `,
    variables: { issueId: issueId.trim(), body },
  };
}
