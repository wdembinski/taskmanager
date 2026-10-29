# F26 — Triage and git automation

> **Status:** proposed · **Where:** server (`apps/server`), client (desktop main), `packages/shared`, `packages/ui`, web · **Depends on:** F21 (issue model & workflow), F22 (collaboration) · **Unlocks:** teams that take work in from many sources without a human sorting every ticket by hand
> Only the `- [ ]` checkboxes under **Tasks** become cards when this file is imported as a plan; everything else is context.
>
> **Layout rule for this file:** every task's description bullets sit after a **blank line**. The plan
> parser folds any indented line that directly follows a checkbox into that task's *title*
> (`apps/client/src/main/planParser.ts:173-177`); the blank line is what keeps descriptions out of it.

## Why

A team tracker fills up from many directions: members filing quickly, guests, automations,
imports. Most new tickets arrive incomplete:

- with no team or no labels;
- with nobody assigned;
- as a duplicate of something already open.

Without a place to sort them, they land straight in a team's backlog and the backlog rots.
On the git side, people still keep tickets and branches in step by hand: they name a branch
after the ticket, move the ticket when the PR opens, and close it when the PR merges.

F26 adds five things:

- a **triage inbox** per team, where new tickets wait for a decision;
- **round-robin** assignment;
- **AI triage**: a headless session that proposes duplicates, labels and a team, which a
  human accepts in one click;
- **auto-close / auto-archive rules**, built on F14's archive;
- **git automation**: branch names from ticket keys, and PR/MR events that move tickets.

It also adds a **one-time import** from JIRA, GitHub and Asana into native tickets,
so a team can move its history in.

## What we have today

Verified on `docs/roadmap-f13-f27` (tip `95d3bcf`).

- **Native tickets (Phase 24).**
  - `Task.source` is `'plan'|'adhoc'|'jira'|'github'|'ticket'`
    (`packages/shared/src/model.ts:816`).
  - `isNativeTicket` is `source === 'ticket'` (`packages/shared/src/tickets.ts:44`).
  - Fields (`model.ts:1175-1239`): `ticketKey`, `ticketNumber`, `issueType`, `epicTaskId`,
    `milestoneId`, `labels`, `storyPoints`, `estimateDays`, `startAt`, `dueAt`,
    `assigneeId` and `reporterId`.
  - Keys:
    - formatted by `packages/shared/src/ticketKey.ts` (`formatTicketKey` `:63`,
      `parseTicketKey` `:84`);
    - allocated by `createTicketTx` (`apps/client/src/main/store.ts:4133-4160`), which bumps
      `projects.ticketSeq`;
    - built by `buildTicketTask` (`packages/shared/src/taskBuilders.ts:64`).
  - Labels: `ticket_labels` (`store.ts:1746`, per project, `COLLATE NOCASE`), `TicketLabel`
    (`model.ts:1358`) and `normalizeLabels` (`tickets.ts:143`).
  - Links: `ticket_links` (`store.ts:1767`), whose `TicketLinkType` (`model.ts:648`) already
    includes `'duplicates'`.
  - There is **no team** concept; F21 adds teams with their own key prefix and workflow
    states.
- **Branch names.** `buildBranchName` (`packages/shared/src/branchName.ts:163-184`) builds
  `<prefix>/<type>/<key>/<slug>`:
  - the prefix is `AppSettings.branchPrefix`;
  - the key is `slugify(externalKey)`, lower-cased;
  - the slug is the title cut to 40 characters.

  Only `packages/ui/src/AssignAgentDialog.tsx:222-261` proposes a name, and it passes
  `externalKey` only. **A native ticket's `TM-12` never reaches its branch name today.**
  The legacy fallback is `orch/<taskId>` (`worktreeManager.ts:427-429`). Names are
  validated again at `ipc.ts:1180` and stored as `agentBranch` (`:1204`).
- **Finding keys in PRs/MRs.**
  - `discoverIssueKeys` (`apps/client/src/main/forge/issueKeys.ts:50`) matches
    `[A-Za-z][A-Za-z0-9]*[-_]\d+` in the branch, then the title, then the description. It
    matches case-insensitively and only against known board keys.
  - `pickTaskKey` (`:73`) takes the branch's key first.
  - `closingReferences` / `discoverPullRequestKeys` (`apps/client/src/main/github/prMatch.ts:57/:90`)
    add "Closes #n".
  - `buildBoardIndex` (`forge/boardIndex.ts:12-41`) indexes native `ticketKey`s too.
- **What PR/MR events do today.**
  - `reconcileMergeRequests` (`gitlab/gitlabSync.ts:143`) and the GitHub reconciler retain
    merged or closed rows.
  - `landedTaskIds` (`gitlabSync.ts:276`) → `scheduler.noteWorkLanded` (`ipc.ts:2912`,
    `:3089`) only stamps `landedAt` and releases chains. **Nothing moves a ticket when a
    PR opens, merges or closes.**
  - Tracker write-back, `writeMoveToForge` (`ipc.ts:5151`: JIRA transition,
    GitHub label/close), runs only on human moves: `task:move` (`:5174`), the status dropdown
    (`:1706`) and assign+start (`:1248`).
- **Archive.**
  - `Task.archivedAt` and `archivedReason` (`model.ts:1068/1084`).
  - `TaskArchiveReason` is `left-query|retention-expired|gone-from-jira|variant-discarded`
    (`:669`).
  - `archiveTask`/`unarchiveTask` live in `store.ts:4951/4980`.
  - Archiving today is done only by tracker syncs' `doneRetentionDays` (`ipc.ts:4440`,
    `:4643`, `:4781`) and by variant picks.
  - F14 adds manual archiving and milestone auto-archive. There is no age-based close.
- **Automations (F1)** live in `packages/shared/src/automation.ts`:
  - tracker triggers watch only `jira|github` (`:21`);
  - the events are `appeared|entered-status|labeled` (`:29`);
  - the action is always "run an agent";
  - `detectTrackerEvents` (`automationTracker.ts:43-52`) **ignores native tickets**.
- **Headless one-off Claude.** `host.exec(cwd, 'claude', ['-p', …, '--output-format', 'json'])`
  with the `result` parsed. Examples: `readClaudeUsage` (`apps/client/src/main/claudeUsage.ts:54-75`),
  `claudeModels.ts:67-120` and `Scheduler.probeUsage` (`scheduler.ts:4985`). `runClaudeSession`
  (`claudeSession.ts:390`) is the streaming alternative.
- **"Inbox" means attention items today** (`packages/shared/src/attention.ts`,
  `packages/ui/src/inboxState.ts`), not ticket intake. F22 adds the notifications inbox.
  There is no triage, no round-robin and no duplicate detection anywhere.
- **Tracker clients usable for import:**
  - **JIRA** (`jira/jiraClient.ts`): `search` `:241`, `getIssue` `:680`, `getComments`
    `:472`, `getAttachments` `:688`, `listLabels` `:402`, `searchUsers` `:551`,
    `listPriorities` `:488`.
  - **GitHub** (`github/githubClient.ts`): `searchIssues` `:606`, `searchIssuesPage` `:635`,
    `getIssue` `:670`, `listRepoLabels` `:655`, `listAssignableUsers` `:778`.
  - **Asana:** no client exists.
  - The F5 import (`issues/importIssue.ts`, `ISSUE_PROVIDERS = jira|github|gitlab` in
    `packages/shared/src/issues.ts:11`) creates a pinned **mirror** card, not a native
    ticket.

## Design

### Data model & contracts

- **Triage is a workflow state category.** F21's per-team workflow gains a `triage`
  category: one state per team, outside the board's columns.
  - A new ticket lands in Triage when any of these is true:
    - it was created by a guest;
    - it was created by an import or automation that has "triage" on;
    - it was created without a team;
    - the team's "everything goes through triage" switch is on.
  - Members filing into their own team skip triage by default.
  - Leaving triage is one of: **Accept** (to the team's default state, optionally assigning),
    **Duplicate of …** (a `duplicates` link plus close), **Decline** (closed with a reason),
    or **Move to team**.
- **`TriageSuggestion`** (`packages/shared/src/triage.ts`, new):
  - `{ ticketId, duplicates: { ticketId, confidence, why }[], labels: string[], teamId, assigneeId?, summary, model, costUsd, createdAt, inputHash }`;
  - it is stored server-side and shown beside the ticket, never applied by itself;
  - `inputHash` (title + description + team catalogue version) stops a repeat run on an
    unchanged ticket.
- **Round-robin** (`assignment rules` per team):
  - `{ mode: 'off' | 'round-robin' | 'least-open', pool: memberId[], skipOutOfOffice: boolean, includeAgents: boolean }`;
  - the cursor is kept server-side per team, so two members accepting at once never both
    get the same next person;
  - an agent member in the pool (F20) means an accepted ticket can go straight to an agent.
- **Rules** (`packages/shared/src/ticketRules.ts`) are declarative and per team, evaluated
  by a pure `evaluateRules(tickets, rules, now)`:
  - `auto-close`: close tickets in states X with no activity for N days, with a comment
    saying why;
  - `auto-archive`: archive closed tickets N days after closing. This reuses F14's archive,
    with the new `TaskArchiveReason` `rule-auto-archive`, and they stay restorable;
  - `close-triage-after`: decline triage tickets untouched for N days.

  All rules are off by default. Each one previews ("this would close 12 tickets") before it
  is saved.
- **PR/MR event rules** (per team), `prEventRules: { opened?: StateId, merged?: StateId, closedUnmerged?: StateId | 'previous' }`.
  - Defaults for a new team: opened → the team's "In review"-category state; merged → its
    "Done"-category state; closed unmerged → previous.
  - These are **explicit human-configured rules**. They are written as the human's move
    (`humanStatusPatch`), so a live run's borrowed status is respected (memory
    *card-state-is-the-humans*), and the history entry reads "moved by rule: PR !42 merged".
- **Branch key policy.** `BranchNameInput` gains `ticketKey`. The key segment is the native
  `ticketKey` when there is one, else `externalKey`.
  - New `AppSettings.branchKeyCase: 'lower' | 'preserve'`, default `'preserve'` for new
    installs, so `feat/TM-12/fix-login` matches what people type.
  - `discoverIssueKeys` already matches case-insensitively.
  - The branch name is offered on the ticket as **Copy branch name**, for humans who work
    without an agent.
- **Import** (`packages/shared/src/import.ts`):
  - `ImportSource = 'jira' | 'github' | 'asana'`;
  - `ImportPlan { source, scope (JQL / repo+query / Asana project), mapping: { states, types, priorities, labels, people }, includeComments, includeClosed }`;
  - `ImportReport { created, skipped, errors[], keyMap: { externalKey, ticketKey }[] }`.

  Imported tickets are **native** (`source: 'ticket'`) with server-assigned keys. They keep
  `importedFrom: { source, key, url }` so links and search still find the old key. Comments
  come in as F22 comments, authored by a mapped member or "imported from <source>".

### Engine / desktop main process

- **AI triage runs on a desktop** (agent work stays on desktops). It is an `Assignment` of
  kind `triage` that any desktop serving the team can claim through F20's lease. The
  desktop:
  - calls `host.exec(..., 'claude', ['-p', prompt, '--output-format', 'json'])`, the
    `readClaudeUsage` pattern, with a tight timeout and the team's cheapest planning model;
  - runs it in a temp directory with **no repo and no tools** (`--allowedTools ""`), since
    triage reads text only;
  - includes in the prompt: the ticket, the team's label catalogue, the team list with
    descriptions, and the top 20 candidate duplicates;
  - finds candidates server-side by full-text search over open tickets (F25's search), not
    by the model scanning everything;
  - parses the answer against a JSON schema. An invalid answer is a failed suggestion with
    the reason, never a partial apply.

  A usage-limit park or a dead sign-in leaves the triage assignment `queued` (memory
  *the-sign-in-gate*). Triage simply waits.
- **Git events.** After each forge sync, the existing reconcilers already know every PR/MR
  state transition (`lastEventAt` transitions in `gitlabSync.ts:183-196`). A new
  `prEventMoves(before, after, rules)` (pure) turns opened/merged/closed transitions into
  moves for matched native tickets. In a cloud workspace the moves are sent as ordinary
  ticket writes, so every replica sees them.
  - Only the desktop that observed the PR sends the move. To avoid duplicates across
    desktops, the server de-duplicates by `(ticketId, mrId, transition)`.
  - JIRA/GitHub-sourced cards keep today's tracker sync; these rules apply to native
    tickets only.
- **Import runs on the desktop** that holds the source credentials (tokens never leave the
  machine). It uses the existing clients, plus a new minimal `asana/asanaClient.ts`
  (PAT; projects, tasks, stories, users):
  - pages through the source;
  - maps with the `ImportPlan`;
  - sends batches of ≤ 200 tickets through the normal ticket-create path, so the server
    assigns keys;
  - is resumable: the `keyMap` is persisted after each batch, and a rerun skips keys
    already imported.

### Server & relay

- The triage state, `TriageSuggestion` table, assignment-rule cursor, `ticketRules` and
  `prEventRules` live on the server (cloud workspaces are server-authoritative).
- **The rules evaluator** runs on the server on a timer (hourly). It writes ordinary ticket
  updates with `authorKind: 'system'`.
- **Local workspaces** run the same pure evaluator on the desktop's automation clock
  (`automationClock.ts`), so auto-close/archive works without the cloud.
- Import progress streams over the existing SSE events channel.
- Relay classification in `ipcRelay.ts`:
  - `import:preview`, `import:run`, `import:status` relay.
  - `asana:setCredentials`/`asana:clearCredentials` are `credential-write` host-only.
  - `triage:*` channels relay.

### UI — desktop

- The sidebar gains a **Triage** entry per team with a count. The count is plain text, since
  it is not something moving.
- The **triage list** is a keyboard-first list:
  - `a` accept, `d` duplicate, `x` decline, `m` move team, `s` take the suggestion;
  - each row shows the AI suggestion inline (labels as faint chips, "possible duplicate of
    TM-88", team) with its cost;
  - **Run AI triage** on the selection.
- **Team settings** gets:
  - triage switches;
  - assignment rules (pool, mode);
  - auto-close/archive rules with a live "would affect N" preview;
  - PR event rules (three state pickers);
  - branch key case.
- **Ticket**: **Copy branch name** in the header menu, and "Imported from JIRA ABC-123" as a
  faint link.
- **Import wizard** (Settings › Import):
  1. source;
  2. scope;
  3. mapping (states, types, priorities, labels, people, with sensible auto-matches);
  4. a dry-run preview of counts and the first 20 tickets;
  5. run, with a progress bar;
  6. the report, with a key map download.

### UI — web

- Triage, rules and settings render from `@tm/ui` (memory *web-mirrors-the-desktop*). They
  work with no desktop, because the data is server-side.
- **Run AI triage** from the web enqueues the assignment, and says so plainly when no online
  desktop serves the team.
- Import is desktop-only in the web: "start the import from the desktop app that holds the
  token".

### Failure modes & edge cases

- **AI suggests a label the team does not have:** dropped, and listed as "new label
  suggested" for an admin. It is never created by itself.
- **Duplicate cycle** (A duplicates B, B duplicates A): refused at link time.
- **PR names two tickets:** `pickTaskKey`'s branch-first rule picks the moved ticket. The
  others get a "referenced in PR !42" activity entry only.
- **PR reopened after merge-move:** no reverse move. Merge is terminal; a human decides.
- **A rule and a human edit race:** the human wins. Rules write with a version check and
  skip a ticket changed since evaluation.
- **Import of a huge JIRA project:** paged, resumable, with a cap per run (5,000 tickets),
  and the report says what remains. Attachments are linked, not copied, in v1.
- **Import of people with no member:** mapped to "unassigned" plus `importedAssignee` text,
  so history is not lost.
- **Widening unions:** `TaskArchiveReason`, the new workflow category and the import source
  are unions that typecheck does not chase. Grep every switch (memory
  *phase24-tickets-design*).
- **Store migrations (local workspace):** verified with the drop-column + electron-as-node
  recipe (memory *the-store-has-no-tests*).

## Out of scope (v1)

- Intake from email, chat or customer-support tools (decided: never).
- Continuous two-way sync with the import sources. Import is one-time; the existing tracker
  syncs stay what they are.
- AI triage that applies its own suggestion without a human.
- Copying attachments' bytes during import.
- Moving JIRA/GitHub-sourced cards by PR rules. Those trackers own their state.

## Open questions

- **Should PR merge move a ticket to Done by default?** Recommended default: **yes for new
  cloud teams**, configurable off. It is an explicit team rule written as a human move, so
  it does not break "only the human moves a card" for local runs.
- **Lower-case or preserved key in branch names?** Recommended default: **preserve** for new
  installs, and keep `lower` for existing installs so no in-flight branch name changes.
- **Which model runs AI triage?** Recommended default: **the team's planning model at its
  cheapest rung** (Phase 23 ladder), with cost shown per suggestion.
- **Round-robin pool includes agents?** Recommended default: **off**. A team opts agents in
  explicitly.
- **Import into local workspaces too?** Recommended default: **yes**. The importer only
  needs a ticket-create path, and both workspace kinds have one.

## Tasks

### F26 · Phase 1 — Contracts and pure logic

- [ ] F26.1 Define triage, assignment rule, ticket rule and import contracts

  - New `packages/shared/src/triage.ts`, `ticketRules.ts`, `import.ts`; the `triage` workflow category on F21's states; `TaskArchiveReason` gains `rule-auto-archive`; grep every switch over the widened unions.
  - Acceptance: `pnpm typecheck` green; exhaustiveness tests for each new union.
- [ ] F26.2 Write evaluateRules for auto-close and auto-archive @needs: F26.1 Define triage, assignment rule, ticket rule and import contracts

  - Pure `evaluateRules(tickets, rules, now)` returning closes/archives with reasons and the version each was evaluated at; a preview mode.
  - Acceptance: table-driven tests for idle thresholds, already-archived tickets, a ticket edited after evaluation (skipped), and every rule off.
- [ ] F26.3 Write prEventMoves for opened, merged and closed transitions @needs: F26.1 Define triage, assignment rule, ticket rule and import contracts

  - Pure function over before/after MR rows and a team's `prEventRules`, native tickets only, branch-key ticket moved and others noted.
  - Acceptance: tests for each transition, a two-ticket PR, a reopened-after-merge PR (no move), and a JIRA-sourced card (ignored).
- [ ] F26.4 Put the native ticket key into branch names @needs: F26.1 Define triage, assignment rule, ticket rule and import contracts

  - `BranchNameInput.ticketKey`, `branchKeyCase` setting, `AssignAgentDialog.tsx` passes `ticketKey`; Copy branch name on the ticket.
  - Acceptance: `branchName.test.ts` cases for native key, external key, both, preserved and lower case; an `issueKeys.test.ts` case that `feat/TM-12/x` and `feat/tm-12/x` both match `TM-12`.

### F26 · Phase 2 — Triage and assignment

- [ ] F26.5 Add the triage state, triage actions and suggestions table on the server @needs: F26.1 Define triage, assignment rule, ticket rule and import contracts

  - Routing new tickets into Triage by the switches; Accept / Duplicate of / Decline / Move team endpoints; `TriageSuggestion` storage with `inputHash`.
  - Acceptance: server unit and e2e tests for each routing rule and action; duplicate cycle refused.
- [ ] F26.6 Assign accepted tickets round-robin with a server-side cursor @needs: F26.5 Add the triage state, triage actions and suggestions table on the server

  - `round-robin` and `least-open` modes, out-of-office skip, optional agent members (F20); cursor updated in the same transaction as the assignment.
  - Acceptance: a concurrency test with two simultaneous accepts (different assignees); tests for pool changes and an empty pool.
- [ ] F26.7 Run AI triage as a claimed headless session on a desktop @needs: F26.5 Add the triage state, triage actions and suggestions table on the server

  - A `triage` assignment kind claimed through F20's lease; `claude -p --output-format json` in an empty temp dir with no tools; candidates from server full-text search; schema-validated answer; failures stored as failed suggestions; limit/sign-in parks leave it queued.
  - Acceptance: tests with a stub `claude` on PATH (memory *stub-claude-on-path*) for a valid answer, invalid JSON, an unknown label (dropped) and an unchanged `inputHash` (no rerun).
- [ ] F26.8 Build the triage list with keyboard actions and inline suggestions @needs: F26.6 Assign accepted tickets round-robin with a server-side cursor, F26.7 Run AI triage as a claimed headless session on a desktop

  - Sidebar Triage entry with count, the list with `a/d/x/m/s`, suggestion chips with cost, Run AI triage; same components in the web through `@tm/ui`.
  - Acceptance: pure list-state tests for each key; `pnpm build` green; tokens only, colour only for movement (memory *board-colour-budget*).

### F26 · Phase 3 — Rules and git events

- [ ] F26.9 Evaluate ticket rules on the server and on the local automation clock @needs: F26.2 Write evaluateRules for auto-close and auto-archive

  - Hourly server job writing `system`-authored updates with a version check; the same evaluator on `automationClock.ts` for local workspaces; auto-archive goes through F14's archive.
  - Acceptance: e2e test closing and archiving a seeded idle ticket; a human edit between evaluate and write wins; local-workspace test with the store migration verified by the drop-column + electron-as-node recipe (memory *the-store-has-no-tests*).
- [ ] F26.10 Move native tickets on PR and MR events @needs: F26.3 Write prEventMoves for opened, merged and closed transitions

  - Call `prEventMoves` after each forge sync (`ipc.ts:2912`/`:3089` area); write as the human's move (`humanStatusPatch`); server de-duplicates by `(ticketId, mrId, transition)`; history reads "moved by rule".
  - Acceptance: tests for a live run on the ticket (status borrowed, `preRunStatus` updated), two desktops observing the same merge (one move), and a GitHub and a GitLab merge.
- [ ] F26.11 Add team settings for triage, assignment, rules, PR events and branch keys @needs: F26.8 Build the triage list with keyboard actions and inline suggestions, F26.9 Evaluate ticket rules on the server and on the local automation clock, F26.10 Move native tickets on PR and MR events

  - Switches, pool picker, rule editor with a live "would affect N" preview, three PR state pickers, branch key case.
  - Acceptance: pure preview-state tests; web and desktop builds green.

### F26 · Phase 4 — One-time import

- [ ] F26.12 Add a minimal Asana client with stored token @needs: F26.1 Define triage, assignment rule, ticket rule and import contracts

  - `apps/client/src/main/asana/asanaClient.ts` (PAT; projects, tasks paged, stories, users); `asana:setCredentials`/`asana:clearCredentials` encrypted like other tokens and classified `credential-write` host-only.
  - Acceptance: client tests against recorded payloads; `test/ipc-relay-coverage.test.ts` passes.
- [ ] F26.13 Build the importer with mapping, dry run and resumable batches @needs: F26.12 Add a minimal Asana client with stored token

  - Source adapters over the JIRA, GitHub and Asana clients; `ImportPlan` mapping with auto-matches; dry-run preview; batches of 200 through the ticket-create path; persisted `keyMap`; comments as F22 comments; `importedFrom` on each ticket; 5,000 cap per run.
  - Acceptance: adapter tests per source with fixtures; a resume test that a rerun creates nothing twice; a cap test that the report names what remains.
- [ ] F26.14 Build the import wizard @needs: F26.13 Build the importer with mapping, dry run and resumable batches

  - Source, scope, mapping, preview, run with SSE progress, report with key map download; "start from the desktop app" in the web.
  - Acceptance: pure wizard-state tests; headless smoke render (never launch the user's app — memory *verify-electron-app*).

### F26 · Phase 5 — End to end

- [ ] F26.15 Write the triage and git automation scenario and docs @needs: F26.11 Add team settings for triage, assignment, rules, PR events and branch keys, F26.14 Build the import wizard

  - `scripts/verify-triage.mjs`: import fixtures from two sources into a team with triage on, run AI triage with a stub `claude`, accept round-robin, open and merge a fake PR on a `feat/TM-n/…` branch and assert the ticket moves, advance the clock and assert auto-close then auto-archive. Document in `docs/`.
  - Acceptance: prove the script fails by mutation (memory *headless-scenario-harness-traps*); `pnpm typecheck`, `pnpm test`, `pnpm build` green with `--force` (memory *a-cached-gate-is-not-a-gate*).
