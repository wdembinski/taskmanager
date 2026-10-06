# F5 — Composer and hand-to-agent

> **Status:** proposed · **Where:** client + web (shared `packages/ui`), main-process tracker reads · **Depends on:** none to start; Phase 3 needs **F7** (prompt templates) and **F1** (triggers) · **Unlocks:** F4 (Linear plugs into the issue browser as a fourth provider), F3 (one-tap hand-off from a phone)
> Only the `- [ ]` checkboxes under **Tasks** become cards when this file is imported as a plan; everything else is context.

## Why

Two gaps between "I have work" and "an agent is doing it":

1. **Creating and starting are two dialogs.** `AddTaskDialog` makes the card; `AssignAgentDialog` delegates it and starts it. The common intent — "do this, now, in that repo" — costs two dialogs and a hunt for the new card in between.
2. **The board only shows what the sync query lets in.** An open issue outside the JQL / GitHub query, or one you have not pulled yet, cannot be handed to an agent without first making it appear on the board. The everyday flow should be one click: browse open issues, filter by label, hand this one to the agent.

## What we have today

- `packages/ui/src/AddTaskDialog.tsx` (1127 lines, shared by both hosts) already asks: board (Personal vs a ticket board), project filing (`projectTagId`), title/description, type, phase, epic, a JIRA ticket to create and link, **staged attachments** (`stageAttachments`, copied once the row exists — `attachment:pick` is host-only), "Runs after…" chain link, and step-under-a-card. Its rules are a pure function `addTaskPlan(form)`.
- `packages/ui/src/AssignAgentDialog.tsx` — agent project (pre-filled by `resolveAgentProject` from the epic), model, permission mode, notes; calls `task:assignAgent` (`packages/shared/src/ipc.ts:675`, input `AssignAgentInput` in `packages/shared/src/model.ts:1314` — `agentProjectId`, `mode?`, `model?`, `planningModel?`, `notes?`). Renders in both hosts.
- Model ladder (memory *model-split-phase23*): `task.agentModel ?? (planning ? project.planningModel : null) ?? project.defaultModel` — NULL means "follow the project"; a new picker must write NULL for "default", not the concrete default.
- Tracker reads in `apps/client/src/main`: `jira/jiraClient.ts` `search(jql)` / `searchAll` / `getIssue`; `github/githubClient.ts` `searchIssues(query)` / `getIssue`; `gitlab/gitlabClient.ts` has merge-request reads only (`listMyMergeRequests`, `listNotes`) — **no issue listing yet**. Labels: JIRA `fields.labels`, GitHub `labelsOf()` in `github/githubIssueSync.ts:185`.
- Syncs (`jiraSync.ts`, `githubIssueSync.ts`) bring in issues that match the board's query, and archive cards that **leave** it (`TaskArchiveReason 'left-query'`, memory *jql-drops-what-you-finish*).
- Relay: every channel is classified in `packages/shared/src/ipcRelay.ts`; `ticket:create`, `task:create`, `task:assignAgent` relay to the web.
- No prompt templates (F7) and no triggers (F1) exist.

## Design

### Data model & contracts

- `IssueSummary` (shared): `{ provider: 'jira' | 'github' | 'gitlab', key, title, url, state, labels: string[], type?, assignee?, updatedAt, onBoardTaskId: string | null }` — `onBoardTaskId` is resolved in main by matching `externalSource`+`externalKey` against the store, so the UI can show "On board → open" instead of importing twice.
- IPC (all `relay` in `RELAY_POLICY`): `issues:list(query: IssueQuery)` → `{ items: IssueSummary[], labels: string[], nextCursor? }`; `issues:import(provider, key)` → `Task` (idempotent: returns the existing card if already on the board).
- `AddTaskForm` gains `assign: { agentProjectId, model: ClaudeModel | null, mode: PermissionMode | null } | null` and `startNow: boolean`; `AddTaskPlan`'s `card` variant gains the same `assign`. Steps never carry it (a step runs in its parent's worktree).
- Task: `pinnedImport?: boolean` (or a new `source: 'import'` — see Open questions) so a card imported from outside the sync query is **not** archived as `left-query`. Store migration (memory *the-store-has-no-tests* for how to cover it).

### Engine / main process

- `IssueProvider` interface in `apps/client/src/main/issues/` with three implementations wrapping the existing clients: JIRA (JQL `statusCategory != Done ORDER BY updated DESC`, optional `labels = …`), GitHub (`searchIssues('is:issue is:open repo:… label:…')`), GitLab (new `listIssues(projectId, {state:'opened', labels})` on `gitlabClient.ts`). F4 adds Linear as a fourth.
- `issues:import` builds a card exactly as the sync's mapping would (reuse the sync's row mapper, do not re-implement it), sets `pinnedImport`, and is idempotent by `externalKey`.
- "Add and start": the composer calls `task:create` (or `ticket:create`) then `task:assignAgent` — no new engine path. A limit/auth park is a success (memory *assign-into-a-standing-limit*): the card exists and is queued.
- The syncs skip `pinnedImport` cards when computing `left-query` archival.

### Server & sync

- No new server endpoints: the three new channels relay over the existing `ipc-invoke` mirror kind, so the web reaches the desktop's tracker credentials. Large `issues:list` answers must respect the result-size cap that fixed *one-answer-wedges-the-mirror* — page with `nextCursor`, 50 items per page.
- `pinnedImport` is a task field and must be added to the mirrored task shape in `packages/protocol` so the web renders it.

### UI — desktop

- **Composer** (`AddTaskDialog`): a collapsible **"Run it"** section — agent project (pre-filled via `resolveAgentProject`), model (Default = NULL), mode; the primary button becomes **Add and start** when a project is chosen, with **Add** as the secondary. ⌘/Ctrl+Enter submits. Hidden for steps.
- **Issues screen** (`packages/ui/src/issues/IssuesScreen.tsx`, new nav item): provider tabs (only connected providers), search box, **label facet filter** (multi-select, the selection always visible as chips outside the dropdown so a filter never hides it), list + detail pane; the detail shows the issue body read-only and a **hand-off panel**: prompt box pre-filled with the issue key + URL (never the body), agent project/model/mode pickers (route state, persisted), **Hand to agent** (= import → assign → start) and **Add to board** (import only). Already-on-board issues show "On board" with an Open button.

### UI — web

- Same `IssuesScreen` and composer from `packages/ui`; mounted in `apps/web/src/App.tsx`. Attachments in the web composer stay limited to what `filesEnabled` allows today (`attachment:pick` is host-only).
- Hand-off confirms with a toast as well as inline, because on a phone the inline confirmation is often under the keyboard.

### Failure modes & edge cases

- **Imported card archived by the next sync** because it is outside the JQL — prevented by `pinnedImport`; a test proves the sync skips it.
- **Double import** (two clicks, or web and desktop at once): `issues:import` is idempotent by `(externalSource, externalKey)`; the second call returns the first card.
- **Card created, start refused** (no repo, signed out, limit): the card is kept; refusals use `RUN_REFUSAL_MESSAGE`, parks read as success. Never roll back the card.
- **Provider not connected / token invalid**: tab shows the provider's own test-connection message (memory *jira-401-with-a-valid-token*), not an empty list.
- **Rate limits**: GitHub search is 30 req/min; list on demand only (no polling on this screen), cache the last page for the session.
- **Draft prompt per issue**: stored only once the user types (an untouched box stores nothing), keyed by provider+key, in renderer `localStorage`, wrapped in try/catch.
- **Model "Default"** must persist as NULL so later project-default changes still apply.

## Out of scope (v1)

- Creating issues in the trackers from the browser (the composer's existing JIRA-ticket option covers JIRA).
- Editing issue fields, commenting, or transitioning from the Issues screen.
- Bulk hand-off of many issues at once.
- Skill multi-select (F7 owns skills; this doc only consumes templates).
- Linear (F4).

## Open questions

1. **`pinnedImport` flag vs a new `source: 'import'`.** `source` already distinguishes `jira`/`github`; changing it could break every `source === 'jira'` check. *Recommended default:* a separate boolean `pinnedImport`, leaving `source` as the provider.
2. **Should Hand to agent pick a JIRA board or always land on Personal?** *Recommended default:* Personal board (where delegated cards live today), filed under the project resolved from the issue.
3. **GitLab issues** — worth building now, given only MRs are used today? *Recommended default:* yes, behind the same interface; it is one list call.
4. **Composer: one dialog or a full-screen composer?** *Recommended default:* keep the existing dialog and add the "Run it" section — the form already answers the other questions and a second composer would be a second set of answers.

## Tasks

### F5 · Phase 1 — Add and start

- [ ] F5.1 Extend the pure addTaskPlan with an optional agent assignment and a start-now flag

  - `packages/ui/src/AddTaskDialog.tsx`: `AddTaskForm.assign` + `startNow`; `AddTaskPlan` card variant carries `assign`; steps never do; model "Default" → `null`.
  - Acceptance: `addTaskPlan` tests — card with assign keeps it, step drops it, default model is null, startNow without a project is `incomplete` with a message. Gates `pnpm typecheck`, `pnpm test`, `pnpm build` green.
- [ ] F5.2 Add a Run it section with agent project model and mode pickers to AddTaskDialog @needs: F5.1 Extend the pure addTaskPlan with an optional agent assignment and a start-now flag

  - Reuse `resolveAgentProject` and the option lists from `AssignAgentDialog.tsx` (extract them to a shared `agentPickers.ts` rather than copying); collapsible; hidden for steps; both hosts.
  - Acceptance: extracted helpers unit-tested (pre-fill from epic, default model null); AssignAgentDialog still uses the same helpers (no behaviour change — its existing tests pass). Gates green.
- [ ] F5.3 Make Add and start create the card then assign and start it with one error surface @needs: F5.2 Add a Run it section with agent project model and mode pickers to AddTaskDialog

  - Pure `addTaskSteps(plan)` → ordered writes (create / ticket link / attachments / assign); dialog executes them; a refusal after the card exists keeps the dialog result as "created, not started: <RUN_REFUSAL_MESSAGE>"; a park is success. ⌘/Ctrl+Enter submits.
  - Acceptance: tests over `addTaskSteps` and a pure `outcomeMessage(result)` — limit park reads as success, `no-project` keeps the card and names the fix. Gates green.

### F5 · Phase 2 — Issue browser and hand-off

- [ ] F5.4 Add the issue listing and import contracts with relay classification

  - `packages/shared`: `IssueSummary`, `IssueQuery`, IPC `issues:list` / `issues:import`, both `relay` in `ipcRelay.ts`; `Task.pinnedImport` + protocol task shape.
  - Acceptance: `test/ipc-relay-coverage.test.ts` and `ipcRelay.test.ts` pass with the new channels; a size test keeps one `issues:list` page under the relay result cap. Gates green.
- [ ] F5.5 Implement issue providers for JIRA GitHub and GitLab in the main process @needs: F5.4 Add the issue listing and import contracts with relay classification

  - `apps/client/src/main/issues/{issueProvider,jiraIssues,githubIssues,gitlabIssues}.ts`; new `listIssues` on `gitlabClient.ts`; `onBoardTaskId` resolved against the store; label filter pushed into each provider's query; 50 per page with a cursor.
  - Acceptance: provider tests with recorded fixtures (query string built correctly per label set, labels normalized, on-board resolution, pagination cursor). Gates green.
- [ ] F5.6 Add idempotent issue import that pins the card against left-query archival @needs: F5.5 Implement issue providers for JIRA GitHub and GitLab in the main process

  - `issues:import` reuses the syncs' row mappers; sets `pinnedImport`; store migration for the column; `jiraSync.ts` / `githubIssueSync.ts` skip pinned cards when archiving `left-query`.
  - Acceptance: tests — importing twice returns one card; a pinned card outside the query survives a sync pass; an unpinned one is still archived. Migration covered with the drop-column recipe from *the-store-has-no-tests*. Gates green.
- [ ] F5.7 Add the pure issue browser state with label facets and per-issue drafts @needs: F5.4 Add the issue listing and import contracts with relay classification

  - `packages/ui/src/issues/issueBrowserState.ts`: provider tab, search, selected labels (selection never filtered away), list/selection, page append, stale-answer guard (seq frontier like `taskTimeline.ts`), draft prompt store (untouched → nothing stored).
  - Acceptance: reducer tests — out-of-order page answers ignored; switching provider resets selection; draft written only after an edit; pre-fill is key + URL, never the body. Gates green.
- [ ] F5.8 Build the Issues screen with list detail and hand-off panel in packages/ui @needs: F5.5 Implement issue providers for JIRA GitHub and GitLab in the main process, F5.7 Add the pure issue browser state with label facets and per-issue drafts

  - `IssuesScreen.tsx`: provider tabs (connected only), search, label chips + facet dropdown, list, read-only detail, hand-off panel (prompt box, pickers from F5.2's helpers), "On board → Open" for known issues, provider connection errors shown verbatim.
  - Acceptance: component is wiring only over F5.7's reducer; a pure `handOffAvailability(issue, projects)` tested (no agent projects → disabled with the desktop-only explanation, as AssignAgentDialog does). Gates green.
- [ ] F5.9 Add one-click hand to agent that imports assigns and starts in one action @needs: F5.6 Add idempotent issue import that pins the card against left-query archival, F5.8 Build the Issues screen with list detail and hand-off panel in packages/ui, F5.3 Make Add and start create the card then assign and start it with one error surface

  - Hand to agent = `issues:import` → `task:assignAgent` (notes = the prompt box) → toast + inline "View card"; Add to board = import only.
  - Acceptance: pure `handOffSteps` tested — already-on-board issue skips import; refusal keeps the imported card and reports the reason; park reports success. Verified end-to-end with the stub CLI from *stub-claude-on-path* (import → run starts). Gates green.
- [ ] F5.10 Mount the Issues screen in the desktop nav and in apps/web @needs: F5.8 Build the Issues screen with list detail and hand-off panel in packages/ui

  - Nav item in `apps/client/src/renderer/src/App.tsx` and `apps/web/src/App.tsx`; if F9 has landed, register a palette source ("Hand issue … to agent").
  - Acceptance: web settings/nav section tests updated; the screen is reachable in both hosts (human check noted as owed — no DOM harness). Gates green.

### F5 · Phase 3 — Templates and triggers (after F7 and F1)

- [ ] F5.11 Add a prompt template insert menu to the composer and the hand-off panel

  - Requires F7's template store. Menu inserts at the caret; into an untouched pre-filled box it appends below the reference rather than above it.
  - Acceptance: pure `insertTemplate(text, caret, template, untouched)` tested for caret, untouched-append and empty cases. Gates green.
- [ ] F5.12 Add an optional attach a trigger section to the composer

  - Requires F1's trigger model. "Run on a schedule / when …" attaches an F1 trigger to the new card instead of (or as well as) starting now.
  - Acceptance: `addTaskPlan` tests — trigger plus startNow both honoured; trigger on a step rejected; the created trigger references the new card id. Gates green.
