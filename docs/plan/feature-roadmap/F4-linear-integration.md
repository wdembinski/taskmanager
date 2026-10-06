# F4 — Linear integration

> **Status:** proposed · **Where:** client (desktop) + web (settings and cards via the mirror/relay) — no server code · **Depends on:** nothing · **Unlocks:** F1 Linear-event triggers, F5 one-click hand-to-agent for Linear issues
> Only the `- [ ]` checkboxes under **Tasks** become cards when this file is imported as a plan; everything else is context.

## Why

Linear is the tracker many small teams actually use. We mirror
JIRA issues and GitHub issues onto the board (two-way: a drag moves the ticket, comments flow both
ways) and GitLab merge requests onto cards — but a Linear shop cannot use the board at all. F4 adds
Linear as a **fourth tracker with the same two-way behaviour** as JIRA and GitHub, reusing their
resolvers, retention rules and isolation guarantee rather than inventing new ones.

## What we have today

- Tracker reconcilers: `apps/client/src/main/jira/jiraSync.ts` (`reconcileJiraTasks`,
  `retainedKeys`, `removalCandidateKeys`) and `apps/client/src/main/github/githubIssueSync.ts`
  (`issueToTask`, `issuesToRecheck`, `reconcileGitHubIssues`) — the shape to mirror.
- Moves: `apps/client/src/main/jira/jiraMove.ts` (`pickTransition`, `shouldLearnStatus`) and
  `apps/client/src/main/github/githubMove.ts` (`resolveMove`, `planLabelChange`, `shouldLearnLabel`).
- One column resolver both directions share: `packages/shared/src/statusResolve.ts`
  (`resolveStatusColumn` with tiers explicit → learned → heuristic → category,
  `isReviewishStatus`, `hasBlockedName`, `resolveGitHubColumn`).
- Archive safety: `apps/client/src/main/forge/removalGuard.ts`; filing a ticket onto its own board:
  `resolveOwningBoardProject` in `packages/shared/src/agentProjects.ts` (commit `c6ba89e`, gated on
  `features.ticketsToOwnBoard`).
- Settings: `JiraSettings`/`GitHubSettings` in `packages/shared/src/settings.ts`; both are in
  `GLOBAL_SETTINGS_KEYS` (mirrored to the web), tokens are not.
- Tokens: encrypted via `store.loadGitHubToken()` + `decryptSecret` (`ipc.ts:1779`), cleaned by
  `sanitizeToken` (`packages/shared/src/secretToken.ts`).
- One sync timer for every integration: `apps/client/src/main/syncPoller.ts` (`SyncService`);
  service ids in `packages/shared/src/sync.ts` (`SyncServiceId`).
- Relay classification: `jira:*`/`github:*` in `packages/shared/src/ipcRelay.ts:243-275`
  (credential writes `host-only`).
- Model: `Task.source` is `'plan' | 'adhoc' | 'jira' | 'github' | 'ticket'`
  (`packages/shared/src/model.ts:705`), `externalKey`/`externalUrl`, `TaskActivityEntry` with
  `jira-comment`/`github-comment` kinds.
- The only E2E pattern: `apps/client/scripts/verify-github.mjs` (real store, throwaway HTTP server
  with mutable issues).
- The server and `packages/protocol` do not enumerate `source` (checked by grep), so Linear rows
  ride the cloud mirror unchanged.

## Design

### Data model & contracts

- `Task.source` gains `'linear'`; `TaskActivityEntry` gains `linear-comment`
  `{ id, author, body, createdAt, url }`; `SyncServiceId` gains `'linear'`.
- **Identity is the Linear UUID, not the identifier.** An issue moved to another team gets a new
  identifier (`ENG-12` → `OPS-40`). So the task id is `linear-<uuid>`, `externalKey` is the
  identifier (display, updated on every sync), `externalUrl` the issue URL.
- `LinearSettings` (in `AppSettings.linear`, added to `GLOBAL_SETTINGS_KEYS`; the key stays local):
  - `enabled`, `teamKeys: string[]`, `assignee: 'me' | 'anyone'`,
    `includeStateTypes` (default `triage, backlog, unstarted, started`),
    `advancedFilter?: string` (raw `IssueFilter` JSON, validated, AND-ed with the above);
  - `stateColumnOverrides: Record<string, BoardColumn>` and `learnedStateColumns` — by state name,
    exactly like JIRA's maps;
  - `columnTargetStates: Record<teamKey, Partial<Record<BoardColumn, string>>>` — Linear states are
    **per team**, so "which state does IN REVIEW mean" is answered per team;
  - `showDoneColumn`, `doneRetentionDays` (14).
- **Column mapping reuses the shared resolver.** `linearCategory(stateType)` maps
  `triage | backlog | unstarted` → `To Do`, `started` → `In Progress`, `completed | canceled` →
  `Done`; that category is fed to `resolveStatusColumn`, so the explicit → learned → heuristic →
  category tiers, the review/blocked name heuristics and the status-map viewer all work unchanged.
  No new resolver, no rename of `JiraStatusCategory` (YAGNI).

### Engine / sync

New `apps/client/src/main/linear/`:

- `linearQueries.ts` (pure) — the issues query (`issues(first: 50, after, filter, orderBy:
  updatedAt)` with `id identifier title description url priority updatedAt state { id name type }
  team { key } labels assignee`), the `IssueFilter` built from settings, the retained-issue re-read
  (`issues(filter: { id: { in: [...] } })`), comments query, `issueUpdate(stateId)` and
  `commentCreate` mutations.
- `linearClient.ts` — `POST https://api.linear.app/graphql`, `Authorization: <key>` after
  `sanitizeToken`, injected `fetch`. Typed errors: `LinearAuthError` (401 / `AUTHENTICATION_ERROR`),
  `LinearRateLimitError(resetAt)` (`RATELIMITED` in GraphQL `errors`, reset from
  `x-ratelimit-requests-reset`), partial-data errors surfaced, never ignored. Pagination with a hard
  cap (500 issues per sync) that reports itself rather than truncating silently.
- `linearSync.ts` — `issueToTask` and `reconcileLinearIssues`, mirroring `reconcileGitHubIssues`:
  adopt / update / retain / archive. **Done retention** per memory `jql-drops-what-you-finish`: a
  card resting in DONE that leaves the filter is retained (`retainedSince`), re-read by UUID each
  sync, retired after `doneRetentionDays` or when Linear stops returning it. `rechecked: null`
  (fetch failed — keep everything) is distinct from `[]` (Linear says gone — retire).
  Filing onto the owning board reuses `resolveOwningBoardProject`. Priority (0–4) maps read-only.
- `linearMove.ts` (pure) — `resolveLinearMove(task, toColumn, teamStates, settings)`: per-team
  configured state → learned → name heuristic → first state of the column's type by `position`.
  **BLOCKED is local only** (memory `jira-transitions-on-every-move`); DONE never picks a
  `canceled` state. A team with no matching state returns a refusal value naming what is missing.
  `shouldLearnState` mirrors `shouldLearnStatus`.
- Moves go through the existing **transition-before-local-write** rule in `task:move` /
  `task:setStatus`: update Linear first, throw on failure so the optimistic move rolls back, learn
  on success.
- Register `{ id: 'linear', isEnabled, run }` in `syncPoller.ts`; the status bar's sync state
  includes it. A rate limit backs the Linear service off until the reset without slowing the others.
- **Isolation**: the reconciler filters `source === 'linear'` in both directions, making it the third
  independent fact in docs/12's isolation guarantee. **Typecheck will not find the widening sites**
  (memory `phase24-tickets-design`: no exhaustiveness idiom) — they are enumerated by grep.

### Server

None — Linear cards are ordinary `tasks` rows that the cloud mirror carries without inspecting
`source`, and `linear` settings ride `settings_mirrors` once whitelisted. One task verifies the
round trip instead of writing code. A webhook receiver (instant updates instead of polling) would
live on the server, but belongs with F1's triggers.

### UI — desktop

- **Settings → Linear** beside GitHub in `apps/client/src/renderer/src/Settings.tsx`: enable toggle;
  API key field (write-only, "stored encrypted on this machine"); **Test connection** that probes
  (`viewer`, `organization`, the chosen teams) and names the exact failure; team multi-picker
  (`linear:teams`); assignee me/anyone; state-type checkboxes; per-team **column → state** table
  (`linear:states`) showing which mappings were learned; retention and Done-column toggles.
- Cards: an identifier chip linking to Linear (same chip as GitHub/JIRA keys).
- Detail pane: Linear comments interleaved in the timeline (`linear-comment`), an add-comment box,
  and the unread marker (`linear:markRead`), as GitHub has.

### UI — web

The settings section renders Linear's (mirrored) configuration with a `readOnlyNotice` for the key —
credentials are `host-only`, so "set the API key on the desktop app". Linear cards and comments
render through the shared `@tm/ui` components with no web-only styling (memory
`web-mirrors-the-desktop`). `linear:markRead` follows `jira:markRead`'s tier on the web transport
(refused — its returned Task feeds board state).

### Failure modes & edge cases

- Key with a trailing newline → `sanitizeToken` on save **and** on use (memory
  `jira-401-with-a-valid-token`).
- Revoked key → an integration error in the status bar and Settings, never a card failure.
- Rate limited → back off until the reset; the status bar says when Linear will be read again.
- Issue moved between teams → same card (UUID identity), new identifier, columns re-resolved with
  the new team's states.
- Issue completed or filtered out while in DONE → retained, re-read by UUID; a failed re-read keeps it.
- Issue trashed or deleted → re-read returns nothing → retired through the removal guard.
- A state renamed upstream → a stale learned entry falls back to the state type.
- A team with no review-type state → an IN REVIEW drag uses a `started` state matching the review
  heuristic, else refuses with "team X has no state for In Review — pick one in Settings".
- Drag during a sync → the existing per-card guard applies; the sync re-resolves after the write.
- Images in descriptions on `uploads.linear.app` need auth → rendered as links, not inline.

## Out of scope (v1)

OAuth app install, webhooks, creating Linear issues from the Add-task dialog, cycles / projects /
milestones mapping, sub-issues as subtasks (issues sync flat), two-way priority or assignee,
mentions and attachment upload in comments.

## Open questions

1. **App-wide connection (like our JIRA/GitHub) or one per project?** Default: app-wide,
   with a team list.
2. **Create Linear issues from the Add-task dialog?** Default: not in v1 — the natural follow-up,
   mirroring `jira:createTask`.
3. **Sub-issues as subtasks?** Default: flat in v1; the parent shown as a link.
4. **Priority both ways?** Default: read-only mapping in v1.
5. **Canceled → DONE?** Default: yes, as JIRA's Cancelled does; moving a card into DONE always picks
   a `completed` state.

## Tasks

### F4 · Phase 1 — Contracts and pure mapping

- [ ] F4.1 Add Linear settings and the linear source to the shared model

  - `packages/shared/src/settings.ts` (`LinearSettings`, defaults, `AppSettings.linear`, add to
    `GLOBAL_SETTINGS_KEYS`); `model.ts` (`source: 'linear'`, `linear-comment` activity kind);
    `sync.ts` (`SyncServiceId`).
  - Acceptance: `settings.test.ts` passes with `linear` classified global; `pnpm typecheck` green.
- [ ] F4.2 Map Linear workflow state types to board columns through the shared resolver @needs: F4.1 Add Linear settings and the linear source to the shared model

  - `linearCategory` + `resolveLinearColumn` in `packages/shared/src/statusResolve.ts`.
  - Acceptance: tests for every state type, explicit/learned/heuristic precedence, a review-named
    `started` state → IN REVIEW, `canceled` → DONE.
- [ ] F4.3 Resolve a board move to a target Linear state per team @needs: F4.2 Map Linear workflow state types to board columns through the shared resolver

  - Pure `apps/client/src/main/linear/linearMove.ts`: `resolveLinearMove`, `shouldLearnState`.
  - Acceptance: tests for configured → learned → heuristic → position order, BLOCKED local only,
    DONE never canceled, and the missing-state refusal message.
- [ ] F4.4 Build the Linear GraphQL query and filter builders @needs: F4.1 Add Linear settings and the linear source to the shared model

  - Pure `apps/client/src/main/linear/linearQueries.ts`.
  - Acceptance: tests for the filter from settings (teams, me, state types), an invalid
    `advancedFilter` rejected with a message, the by-UUID re-read, and both mutations.

### F4 · Phase 2 — Client and sync

- [ ] F4.5 Implement the Linear GraphQL client with rate-limit and auth errors @needs: F4.4 Build the Linear GraphQL query and filter builders

  - `apps/client/src/main/linear/linearClient.ts` with injected `fetch`.
  - Acceptance: mocked-fetch tests for 401, `RATELIMITED` with reset parsed from headers, partial
    GraphQL errors, pagination across pages, and the 500-issue cap reported.
- [ ] F4.6 Reconcile Linear issues onto the board with done retention @needs: F4.2 Map Linear workflow state types to board columns through the shared resolver, F4.5 Implement the Linear GraphQL client with rate-limit and auth errors

  - `apps/client/src/main/linear/linearSync.ts`, modelled on `githubIssueSync.ts` (+ its tests).
  - Acceptance: tests for adopt/update/archive, a team move keeping the same card with a new
    identifier, `rechecked: null` keeping vs `[]` retiring, own-board filing, and native tickets /
    JIRA / GitHub rows never touched.
- [ ] F4.7 Store the Linear API key encrypted and register the Linear sync service @needs: F4.6 Reconcile Linear issues onto the board with done retention

  - Store save/load/clear like GitHub's token; `syncPoller.ts` registration; sync state entry.
  - Acceptance: poller tests show a rate-limited Linear service not delaying JIRA/GitHub; key
    round-trip covered by the F4.10 verify script (the store has no unit tests).

### F4 · Phase 3 — IPC, relay and verification

- [ ] F4.8 Expose the Linear IPC channels and classify them for the relay @needs: F4.7 Store the Linear API key encrypted and register the Linear sync service, F4.3 Resolve a board move to a target Linear state per team

  - `ipc.ts` + `packages/shared/src/ipc.ts`: `linear:getConfigStatus | setCredentials |
    clearCredentials | testConnection | teams | states | sync | fetchComments | addComment |
    markRead`; Linear moves inside `task:move`/`task:setStatus` (transition before write).
    `ipcRelay.ts`: credentials `host-only`, the rest `relay`.
  - Acceptance: `test/ipc-relay-coverage.test.ts` and relay tests green; typecheck proves the
    exhaustive records.
- [ ] F4.9 Widen every source and comment-kind site for Linear @needs: F4.1 Add Linear settings and the linear source to the shared model

  - Grep-enumerate `source ===`, `'github-comment'`, `SyncServiceId` (known: `packages/ui/src/chat/turns.ts`,
    `apps/client/src/main/activityMerge.ts`, `store.ts`, `ipc.ts`) and widen each.
  - Acceptance: the grep list and its outcome recorded in the PR; tests for `turns.ts` and
    `activityMerge.ts` with a `linear-comment` entry.
- [ ] F4.10 Verify Linear sync end to end against a fake GraphQL server @needs: F4.8 Expose the Linear IPC channels and classify them for the relay, F4.9 Widen every source and comment-kind site for Linear

  - `apps/client/scripts/verify-linear.mjs` modelled on `verify-github.mjs`: real store on SQLite
    in `os.tmpdir()`, a throwaway GraphQL server with mutable issues.
  - Acceptance: scenarios — adopt, drag → `issueUpdate`, team move, done retention + re-read, rate
    limit back-off, revoked key, key with trailing whitespace. Exits 0, and fails when a scenario's
    fix is mutated out.

### F4 · Phase 4 — Desktop UI

- [ ] F4.11 Add the Linear section to desktop Settings with a probing connection test @needs: F4.8 Expose the Linear IPC channels and classify them for the relay

  - `apps/client/src/renderer/src/Settings.tsx`, beside GitHub.
  - Acceptance: the form's patch/validation helpers are pure and tested; build green; a human pass
    with a real key is owed (never launch the app from an agent).
- [ ] F4.12 Show Linear identifiers and comments on cards and in the detail pane @needs: F4.8 Expose the Linear IPC channels and classify them for the relay, F4.9 Widen every source and comment-kind site for Linear

  - Shared card chip and `TaskDetail` timeline in `@tm/ui`; add-comment and mark-read.
  - Acceptance: chip/link derivation tested; build green.

### F4 · Phase 5 — Web and docs

- [ ] F4.13 Render Linear settings read-only and Linear cards on the web @needs: F4.11 Add the Linear section to desktop Settings with a probing connection test, F4.12 Show Linear identifiers and comments on cards and in the detail pane

  - `apps/web/src/settings/settingsSections.ts` + the shared section with `readOnlyNotice`;
    confirm the mirror carries a Linear card unchanged.
  - Acceptance: settings-section tests updated; `test/shell-parity.test.ts` green.
- [ ] F4.14 Document Linear in the ticket model and getting-started guides @needs: F4.10 Verify Linear sync end to end against a fake GraphQL server, F4.13 Render Linear settings read-only and Linear cards on the web

  - `docs/12-the-ticket-model.md` (third isolation fact), `docs/01-getting-started.md` (setup).
  - Acceptance: docs list the live E2E still owed with a real key; `pnpm typecheck`, `pnpm test`,
    `pnpm build` green.
