# F17 — Autonomous delivery

> **Status:** proposed · **Where:** client (desktop main + `packages/ui`), `packages/shared`, web (through the relay) · **Depends on:** F16 (AI reviewer engine) · **Unlocks:** end-to-end delivery of a planned milestone without a human at the keyboard; F18 reuses the verdict comment and the reviewer identity
> Only the `- [ ]` checkboxes under **Tasks** become cards when this file is imported as a plan; everything else is context.
>
> **Layout rule for this file:** every task's description bullets sit after a **blank line**. The plan
> parser folds any indented line that directly follows a checkbox into that task's *title*
> (`apps/client/src/main/planParser.ts:173-177`); the blank line is what keeps descriptions out of it.

## Why

The engine can already do every step of delivery on its own: run a card, open a PR/MR, watch
its pipeline, fix a red pipeline, rebase a conflicted branch, and release a chained successor
once the work lands. What it cannot do is decide that a PR is good enough to merge. So each
card stops at "PR open, pipeline green", and the whole plan waits for a human to review and
press Merge, however small the change.

F17 adds a **merge policy** per project, which a card can override:

- **Manual**: today's behaviour. The PR/MR stays open for a human.
- **Auto-merge**: no AI. Merge once the pipeline is green and the forge says the PR/MR is mergeable.
- **AI review → merge**: once the pipeline is green, F16's reviewer reads the PR. Approve
  means merge. Request changes means the findings go back to the coding agent, which runs
  again, for at most N rounds.

With that in place, an approved plan can deliver itself: a card's work is done, a PR opens,
the pipeline goes green, the AI reviews it, the PR merges and the card is **landed**. The plan
then starts the next unblocked card. Every step is guarded by rails, and every refusal
**parks** with a reason that names what to do next.

## What we have today

Verified on `docs/roadmap-f13-f27` (tip `95d3bcf`).

- **Plan scheduling.** `selectNextPending` (`apps/client/src/main/scheduler.ts:599`) is pure.
  A `@needs:` title is satisfied only when every task with that title has `status === 'done'`
  (`:603-614`). `pump` (`:3437`) calls it over `pumpCandidates` (`:3420`). `Schedulable`
  (`:555-571`) carries `status`, `order`, `title`, `dependsOn`, `phase`, `isContract` and
  `isScaffold`. It has **no** `landedAt`.
- **The engine never moves a card to `done`.** That is deliberate (memory
  *card-state-is-the-humans*). `finishStep` (`:5819`) sets a *step* (a row with
  `parentTaskId`) to `done`. A *card* goes back to `in-progress` on every path:
  - the plain tail (`:5857`);
  - `landWork`'s PR branch (`:5917-5922`);
  - its "left for you" branch (`:5962`);
  - `applyIntegrationResult`'s `merged` branch (`:6130-6134`).

  Only three things make a card `done`:
  - a human drag;
  - the failure inbox's `markDone` action (`:6699-6711`);
  - a plan-file line already ticked `[x]` when the plan syncs (`taskReconcile.ts:76`).
- **Chains between cards.** `ChainRunner` (`apps/client/src/main/chainRunner.ts`) handles
  links between cards:
  - `landed(taskId)` (`:211-216`) stamps `Task.landedAt` once and releases successors.
  - `workWritten` (`:228`) releases `stacked` links.
  - `linkSatisfied` (`packages/shared/src/taskChain.ts:233-240`) makes an `after-merge` link
    wait on `landedAt != null`.
  - `Task.landedAt` is documented at `packages/shared/src/model.ts:1242-1255`.
  - These are human-drawn `task_links`, deliberately **not** `Task.dependsOn`
    (`taskChain.ts:16-18`).
- **Landing paths.**
  - **Local integrate:** `applyIntegrationResult` (`scheduler.ts:6087`) calls
    `this.chain.landed(...)` (`:6142`), then `startReleaseRun` (`:6152`, defined `:7407`,
    gated by `autoReleaseOn`), then `finishParentChain`.
  - **GitLab:** `landedTaskIds` (`gitlab/gitlabSync.ts:276-280`) feeds
    `scheduler.noteWorkLanded` (`scheduler.ts:2726`) from `syncGitLab` (`ipc.ts:2912`).
  - **GitHub:** the PR sync makes **the same hand-off** (`ipc.ts:3089`, comment at
    `:3086-3088`). It reuses `landedTaskIds` over the reconciled PR rows, whose
    `state === 'merged'` comes from `githubClient.ts:345`. This was added with
    `89b30d2 feat(github): file pull requests onto cards`.
  - **Neither forge path calls `startReleaseRun`.** Auto-release runs only after a *local*
    merge.
- **Opening a PR.** In `landWork` (`scheduler.ts:5878`), the PR question is asked of the
  *owner* card before auto-merge (`:5906-5926`). `openPullRequestFor` is at `:7483`.
  Opening uses `forge/createPr.ts` (`openPullRequest` `:159`, `prTitle` `:592`, `prBody`
  `:627`). Settings that decide what happens:
  - `autoCreatePrOn` (`packages/shared/src/pullRequest.ts:25`);
  - `autoIntegrateOn` (`packages/shared/src/integrate.ts:48`);
  - `autoReleaseOn` (`packages/shared/src/release.ts:34`);
  - the project fields `autoRelease`, `autoCreatePr` and `autoIntegrate`
    (`model.ts:271/281/291`), with card overrides of the same names;
  - icon tooltips in `packages/ui/src/agentAutoToggles.ts`.
- **Watching a PR.** `forge/prWatcher.ts` runs `prWatchAction`
  (`packages/shared/src/mergeRequest.ts:581`) after every sync. The actions are
  `forge-rebase`, `resolve-conflicts`, `fix-pipeline` and `note-pipeline-passed`.
  - Each is keyed on `lastActedSha`.
  - The watcher is gated on `features.prAutoResolve`.
  - `fix-pipeline` hands the failing pipeline to the agent through
    `chatWithAgent(..., { purpose })`.
  - Pipeline stages fold through `gitlab/pipelineStages.ts` and `github/checkRuns.ts`, both
    via `forge/stageFold.ts`.
- **Readiness and merging.**
  - `mrReadyToMerge` (`mergeRequest.ts:484`) reads the forge's own `detailedMergeStatus`
    (memory *merge-status-needs-gitlabs-verdict*: an unrecognised status blocks).
  - `mr:merge` (`ipc.ts:3229-3252`) calls `GitLabClient.mergeMergeRequest`
    (`gitlabClient.ts:455`) or `GitHubClient.mergePullRequest` (`githubClient.ts:841`), both
    guarded by the head SHA.
- **Missing forge capabilities:**
  - no GitLab `merge_when_pipeline_succeeds`/auto-merge;
  - no GitHub auto-merge (GraphQL `enablePullRequestAutoMerge`);
  - no approve call on either forge;
  - no "post a review" call.

  The read side is present: `getApprovals` (`gitlabClient.ts:401`), `listReviews`
  (`githubClient.ts:993`) and `getBranchProtection` (`githubClient.ts:1053`, which 403s
  without admin).
- **Tokens.** Forge tokens are stored encrypted through `safeStorage` and decrypted on demand
  by `decryptSecret` (`ipc.ts:2012`). Their write channels (`gitlab:setCredentials`,
  `github:setCredentials` …) are `credential-write` host-only in
  `packages/shared/src/ipcRelay.ts:104-113`. `PrWatcherDeps.tokenFor` /
  `CreatePrDeps.tokenFor` read the token when it is used and never hold it.
- **PR ↔ card.** `MergeRequest.taskId` is a guess rebuilt on every sync.
  `openedForTaskId` pins PRs that the app opened (memory *a-pr-the-button-opened*).
- **Timeline and parks.**
  - `noteRun`/`noteCard` write timeline notes.
  - Attention kinds (`packages/shared/src/attention.ts:38-45`) are `permission`, `question`,
    `merge-conflict`, `task-failed`, `proposal`, `plan-approval` and `agent-question`. None
    of them is about delivery.
  - A gate that refuses must park, and the park must live *in* the gate (memories
    *the-gate-is-the-only-memory*, *a-refusal-that-named-the-wrong-wall*).

### The two engine gaps, verified

1. **Does a PR-path plan card count as `done` before it lands?** Not by itself: the engine
   leaves it `in-progress`. But `@needs` reads *only* `status === 'done'`, so it is wrong in
   both directions:
   - **Too early.** A human who drags the card to DONE while its PR is still open releases
     every `@needs` dependant. Those dependants cut their worktrees from a base that does not
     contain the work.
   - **Never.** Without a human, a plan card is never `done`, so a plan of PR-path cards
     **never advances on its own**, even after every PR has merged. The same holds for
     auto-integrated cards: they land and stay `in-progress`. `landedAt` is written, but
     `selectNextPending` cannot see it.

   F17 makes `@needs` read *landed*. On the PR path, `landedAt` is the only thing that
   satisfies a dependency.
2. **Does a merged GitHub PR set `landedAt` / release chains?** **Yes, already.**
   `ipc.ts:3089` calls `scheduler.noteWorkLanded` for every merged GitHub PR row, exactly as
   GitLab does at `:2912`. The brief's premise is out of date. What *is* still missing on
   both forges:
   - a forge merge does not start the auto-release run, because `startReleaseRun` is only
     reached from a local merge;
   - landing is only learned at the next poll;
   - landing needs the PR to be matched to the card (`taskId`/`openedForTaskId`).

   F17 keeps the GitHub landing path covered with a regression test, and adds an explicit
   release hand-off for forge landings.

## Design

### Data model & contracts

A new pure module, `packages/shared/src/delivery.ts`:

- `MergePolicy = 'manual' | 'auto-merge' | 'ai-review'`.
- `Project.mergePolicy: MergePolicy`. The default is `'manual'`, so an upgrade changes
  nothing.
- `Task.mergePolicy: MergePolicy | null`. `null` means "follow the project", the same shape
  as `autoIntegrate`.
- `mergePolicyOn(task, project)` resolves the policy in the same order as `autoCreatePrOn`:
  the owner card's override, then the project. It is asked of the **owner** card, never a
  step.
- The policy only means something on the PR path (`autoCreatePrOn` is true). Saving
  `auto-merge`/`ai-review` turns `autoCreatePr` on for that scope, and the panel says so.
  A local-integrate project keeps today's `autoIntegrate` switch.
- `DeliveryRails`, per project with app defaults:
  - `protectedPaths: string[]` (globs). Default: `**/migrations/**`, `.github/**`,
    `.gitlab-ci.yml`, `**/*.env*`, `**/secrets/**`, `**/*.pem`, `RELEASE.md`.
  - `maxDiffLines: number`. Default `800` added + removed lines, excluding the collapsed
    generated files F6 already recognises.
  - `maxReviewRounds: number`. Default `3`.
  - `requirePipeline: true`. Always true in v1: a project with no CI parks as `no-pipeline`
    and never merges unseen.
- `DeliveryPhase`: `awaiting-pipeline` → `reviewing` → `fixing` → `approving` → `merging`
  → `landed`, plus `parked`.
- `DeliveryParkReason`, a closed union. Each reason has a fixed sentence and a next action:
  - `pipeline-failed-after-fix`, `no-pipeline`;
  - `protected-path` (the paths that matched), `diff-too-large` (lines vs cap);
  - `max-rounds`, `review-failed` (the reviewer session failed or was limit-parked);
  - `self-approval-forbidden`, `approval-required`, `branch-protection-blocked` (the forge's
    own status string);
  - `merge-refused` (the forge's 405/406/409/422 message);
  - `conflicts-unresolved`, `draft`, `token-missing`;
  - `policy-changed` (a human switched the policy to Manual mid-flight; not an error, a stop).
- `Delivery { taskId, mrId, policy, phase, round, reviewedSha, verdict: 'approve' | 'request-changes' | null, parkReason, parkDetail, updatedAt }`,
  one row per owner card.
- `nextDeliveryAction(delivery, mr, rails, ctx) → DeliveryAction` is the whole decision as
  one pure function, the way `prWatchAction` is:
  - `wait`;
  - `review(sha)`;
  - `send-findings(round)`;
  - `approve(identity)`;
  - `merge(mode: 'direct' | 'forge-auto')`;
  - `park(reason, detail)`;
  - `done`.

  It is keyed on the head SHA, so a repeat poll never repeats an action.
- **`@needs` reads landed.** `Schedulable` gains `landedAt: number | null` and
  `prPath: boolean`. A title is satisfied when every task bearing it is satisfied, and a
  task is satisfied when:
  - `prPath` and `landedAt != null`. A human `done` on an unlanded PR-path card does
    **not** count, and the card shows "waiting for the PR to merge";
  - or `!prPath` and (`status === 'done'` or `landedAt != null`).

  `prPath` is computed in `pumpCandidates` from `autoCreatePrOn(owner, project)`, or from an
  `openedForTaskId` PR row on the card. The board's "Depends on" hint
  (`packages/ui/src/TaskDetailsCell.tsx:517`) calls the same exported predicate. The board
  and the engine must never disagree about "ready" (memory *a-chain-that-declined-in-silence*).

### Engine / desktop main process

- **`apps/client/src/main/delivery/deliveryEngine.ts`** (new) owns the `Delivery` rows. It
  is driven from three places:
  - `openPullRequestFor` succeeding: create the row, phase `awaiting-pipeline`;
  - every forge sync, right after `watchMergeRequests` (`ipc.ts:2914`/`:3091`): advance each
    row with `nextDeliveryAction`;
  - `settle` of a fix run that F17 started (purpose `delivery-fix`): back to
    `awaiting-pipeline` on the new head.

  The prWatcher keeps its job (rebase, conflicts, red pipeline). For a delivering card the
  `features.prAutoResolve` gate is read as **on**: a policy other than Manual is an explicit
  opt-in to the app touching the branch (memory *the-tool-owns-merge-and-release*). Its
  existing round count (`lastActedSha`) is shared with the delivery round cap, so a red
  pipeline cannot loop for ever.
- **AI review.** `review(sha)` starts F16's reviewer on the PR head:
  - a read-only temp worktree;
  - inputs: the diff, the ticket/PR text and the repo's `REVIEW.md`.

  It receives the verdict and findings as structured data. The reviewer's run is an `auxRun`
  and is counted against the global concurrency cap. A usage limit parks it **in the
  delivery row**. The resume comes from the limit gate's resume, never from a timer (memory
  *the-gate-is-the-only-memory*).
- **Rails, checked before the AI is even asked.**
  - `protectedPaths` are matched against `diffNameStatus` (F6's helper, which includes
    renames' old paths).
  - The size cap uses the same numstat.
  - A rail hit parks immediately, with the matching paths or the counts. The AI is never run
    on a PR that could not be merged anyway.
  - A rail hit on a *later* round (the fix touched a migration) parks the same way.
- **Request changes.** The findings go back to the coding agent as one message through the
  `task:chat` path, built by F6's `formatReviewMessage` shape plus the AI severity. The run
  is tagged `purpose: 'delivery-fix'` and does not move the card. The round count goes up;
  at `maxReviewRounds` the card parks as `max-rounds` and the last findings stay on the card
  as drafts for the human.
- **Approve.** The approval step is decided per forge:
  1. If a **reviewer bot token** is configured for this forge, approve as that identity:
     GitHub `POST /pulls/{n}/reviews` `event: APPROVE`; GitLab
     `POST /merge_requests/:iid/approve` with `sha`.
  2. Otherwise, approving with the user's token:
     - **GitHub:** the PR was authored with that token, and GitHub forbids self-approval. So
       F17 skips approving and tries to merge. If the forge reports approvals required
       (`detailedMergeStatus`/`mergeBlockers` says review required), the card parks as
       `self-approval-forbidden`, naming the bot-token setting.
     - **GitLab:** self-approval depends on the project's approval settings. F17 tries it,
       and a 401/403 parks as `approval-required`.
  3. The verdict is **always** recorded twice:
     - on the card timeline, with the findings count, cost and the reviewed SHA;
     - as one PR/MR comment ("AI review: approve / request changes — N findings — reviewed
       `<sha>`"), posted with the bot token if present, otherwise the user's.

     The comment is a record, not a review: inline findings stay in the app (F18 owns
     publishing reviews).
- **Merge.**
  - **Direct merge** through the same client calls `mr:merge` uses, with the head SHA, when
    `mrReadyToMerge` says yes.
  - **Forge auto-merge** when the only blocker is a pipeline that is still running (an
    approval or a rebase re-triggered CI):
    - GitLab `merge_when_pipeline_succeeds: true` on the merge call;
    - GitHub GraphQL `enablePullRequestAutoMerge`, with the method from `pickMergeMethod`.
  - Any other blocker parks with the forge's own blocker named. Branch protection is
    respected and never bypassed: no admin merge, no force.
- **Landed.** The landing still comes from the sync's existing `noteWorkLanded` (no second
  path). Its new effects:
  - the delivery row moves to `landed`;
  - `startReleaseRun` is called for a forge landing when `autoReleaseOn` (a new
    `noteWorkLanded` → `chain.landed` → release hand-off, once per card, guarded by
    `landedAt` being newly written);
  - the project is pumped, so `@needs` dependants start.
- **Parks** are a new attention kind, `delivery-parked`, with the reason sentence and up to
  three actions:
  - **Merge anyway** (human, Manual for this card);
  - **Run another round**;
  - **Switch to Manual**.

  Parks survive a restart because the `Delivery` row is persisted. The in-memory attention
  item is rebuilt from it on boot.
- **Timeline notes** at every phase change, in plain sentences:
  - "Pipeline green on `abc123` — asking the AI reviewer."
  - "AI requested changes (4 findings) — round 2 of 3 sent to the agent."
  - "Merged by the app after AI approval."
  - "Parked: the diff touches `apps/server/migrations/…` — protected path."

  Phase changes go to the F2 activity log.
- **Policy changes mid-flight.**
  - Switching to Manual cancels any pending action and parks as `policy-changed`, quietly.
  - Switching from Manual to a policy on a card with an open PR adopts it at the next sync.

### Server & relay

- No new server endpoints. The delivery rows live on the desktop; the card's `mergePolicy`
  and `Delivery` summary fields ride the existing task mirror.
- New channels: `delivery:get`, `delivery:retry`, `delivery:setPolicy`, and
  `forge:setReviewerCredentials` / `forge:clearReviewerCredentials`.
  - The credential pair is classified `credential-write` host-only in `ipcRelay.ts`, the
    same reason as every other token.
  - The rest are `relay`.

### UI — desktop

- **Project settings**:
  - a "Merge policy" radio group (Manual / Auto-merge / AI review → merge), each with a
    one-line consequence;
  - the rails (protected path globs, size cap, max rounds);
  - per forge, an optional **Reviewer bot token** field, with a status line saying whether
    approvals will be real.
- **Card panel**: the policy as a fourth icon toggle beside merge/PR/release
  (`agentAutoToggles.ts` gains `mergePolicyTooltip`). The panel shows "inherited from
  <project>" when the card has no override.
- **Delivery strip** on the card's PR row:
  - phase, round `2/3`, the last verdict with cost;
  - on a park, the reason and its actions.

  The strip uses colour only for movement: the cyan run pill while the reviewer or a fix
  run is working, and orange for a park. Everything else is monochrome (memory
  *board-colour-budget*).
- **Board**: a dependant waiting on an unlanded PR-path card reads "waiting for <card> to
  merge", not "blocked".

### UI — web

- Same components through `@tm/ui` (memory *web-mirrors-the-desktop*). Policy and retry relay.
- The bot-token field shows "set this from the desktop app", like every credential.

### Failure modes & edge cases

- **Head moves during review** (a human pushes): the verdict is for a stale SHA. The
  reviewer's result is discarded, and the next sync re-reviews the new head. Merges always
  pass the reviewed SHA, so the forge refuses a moved branch with a 409, which becomes
  `merge-refused`.
- **Pipeline flaky / red after a fix round:** the existing `fix-pipeline` action handles it.
  After the round cap, the card parks as `pipeline-failed-after-fix`.
- **PR closed without merge by a human:** the row ends, quietly. The card shows "PR
  closed — delivery stopped". Nothing is reopened.
- **PR not matched to the card** (`taskId` guess lost): F17 only drives PRs with
  `openedForTaskId`, which the app itself set. A PR found only by key matching is never
  merged by the app.
- **Two plan cards' PRs ready at once:** they merge in plan order. The second is rebased by
  the existing `forge-rebase` path, and its pipeline must go green again before merge.
- **Usage limit / sign-in gate:** the reviewer and the fix runs park in the gate. Merges and
  approvals are API calls and continue. They are not agent work.
- **Bot token belongs to the same user as the main token:** detected by comparing `getMe()`
  ids when the token is saved. The token is refused with "this is the same account — GitHub
  will not let it approve its own PR".
- **Store migration:** a new `deliveries` table plus `mergePolicy` columns. The store has no
  migration tests, so it is verified with the drop-column + electron-as-node recipe (memory
  *the-store-has-no-tests*).
- **`source`/kind widening:** the new attention kind and run purpose are unions that
  typecheck does not chase into every `switch`. Grep the sites (memory
  *phase24-tickets-design*).

## Out of scope (v1)

- Publishing AI findings as inline forge review comments. That is F18. F17 posts only the
  one verdict comment.
- AI review gating a *local* merge (no forge). Local projects keep `autoIntegrate`.
- Merge queues and merge trains.
- Changing the forge's branch protection, or admin-merging past it.
- Delivery for PRs the app did not open.

## Open questions

- **Should a human `done` on an unlanded PR-path card still count for `@needs`?**
  Recommended default: **no**. Landed is the only fact a dependant can build on. The board
  says why it is waiting, and "Release now" stays available on chain links.
- **Should a forge landing run auto-release?** This repo releases through CI
  (memory *ci-cd-pipeline-releases-now*), so for many repos the forge already releases.
  Recommended default: **yes, when `autoReleaseOn`**, as a local merge does. It stays off
  for every project that has not opted in.
- **What should the size cap count?** Recommended default: added + removed lines, excluding
  F6's collapsed generated/lock files, cap `800`.
- **Should the AI reviewer's own suggested changes ever be applied without the coding
  agent?** Recommended default: **no**. Findings always go to the coding agent, which owns
  the branch.
- **Should the verdict comment be posted on a Manual-policy "Ask AI to review"?**
  Recommended default: **no**. Only delivery posts automatically; a manual review stays
  drafts (F16).

## Tasks

### F17 · Phase 1 — Contracts and the landed rule

- [ ] F17.1 Define the delivery contract in packages/shared/src/delivery.ts

  - `MergePolicy`, `mergePolicyOn`, `DeliveryRails` with defaults, `DeliveryPhase`, `DeliveryParkReason` with its sentences and next actions, `Delivery`, `DeliveryAction`; `Project.mergePolicy` and `Task.mergePolicy` in `model.ts`.
  - Acceptance: unit tests for policy resolution (card override, project default, step asks owner); `pnpm typecheck` green; every `DeliveryParkReason` has a sentence (exhaustiveness test).
- [ ] F17.2 Make plan @needs satisfied by landedAt on the PR path @needs: F17.1 Define the delivery contract in packages/shared/src/delivery.ts

  - Add `landedAt` and `prPath` to `Schedulable`; export one `needSatisfied(task)` predicate from `packages/shared`; use it in `selectNextPending` and fill `prPath` in `pumpCandidates`; make `TaskDetailsCell`'s "Depends on" hint read the same predicate ("waiting for … to merge").
  - Acceptance: `scheduler.test.ts` cases — a PR-path card dragged to done does not release its dependant; landed releases it without `done`; an auto-integrated card that landed releases it; a non-PR card's `done` still works; scaffold/contract ordering unchanged.
- [ ] F17.3 Pin GitHub landing and add the forge-landing release hand-off @needs: F17.2 Make plan @needs satisfied by landedAt on the PR path

  - A regression test that a merged GitHub PR row reaches `noteWorkLanded` (`ipc.ts:3089`) and stamps `landedAt`; `noteWorkLanded` gains the once-per-card `startReleaseRun` when `autoReleaseOn` and pumps the project.
  - Acceptance: tests for GitHub and GitLab merged rows; a repeat poll does not start a second release; a stub `claude` on PATH (memory *stub-claude-on-path*) shows the release run starting after a fake forge merge.

### F17 · Phase 2 — Forge capabilities

- [ ] F17.4 Add approve, verdict comment and auto-merge calls to the GitLab client @needs: F17.1 Define the delivery contract in packages/shared/src/delivery.ts

  - `approveMergeRequest(sha)`, `createNote`, `mergeMergeRequest` gaining `whenPipelineSucceeds`; errors keep GitLab's own message.
  - Acceptance: client tests against recorded payloads for success, 401/403 approval refusal and 405/406/409 merge refusals.
- [ ] F17.5 Add approve review, issue comment and auto-merge calls to the GitHub client @needs: F17.1 Define the delivery contract in packages/shared/src/delivery.ts

  - `approvePullRequest(sha)` (`POST /pulls/{n}/reviews`, `APPROVE`), a verdict comment through `githubComment.ts`, and `enableAutoMerge` (GraphQL `enablePullRequestAutoMerge`, method from `pickMergeMethod`).
  - Acceptance: client tests including the 422 self-approval refusal mapped to `self-approval-forbidden`, and auto-merge not allowed on the repo.
- [ ] F17.6 Store the optional reviewer bot token per forge @needs: F17.4 Add approve, verdict comment and auto-merge calls to the GitLab client, F17.5 Add approve review, issue comment and auto-merge calls to the GitHub client

  - `forge:setReviewerCredentials` / `forge:clearReviewerCredentials`, encrypted through `safeStorage` like the other tokens, read through `tokenFor`-style deps at use time; refuse a token whose `getMe()` equals the main token's user; classify both `credential-write` host-only in `ipcRelay.ts`.
  - Acceptance: `test/ipc-relay-coverage.test.ts` passes; tests for save, same-user refusal, decrypt failure message; the web refuses the channel locally.

### F17 · Phase 3 — The delivery engine

- [ ] F17.7 Write the pure nextDeliveryAction decision function @needs: F17.1 Define the delivery contract in packages/shared/src/delivery.ts

  - Covers pipeline states, rails, verdicts, round cap, bot-token presence, forge blockers from `mergeBlockers`, stale reviewed SHA, closed PR, policy changed.
  - Acceptance: a table-driven test per transition; the same input twice on the same SHA yields `wait` (idempotent like `prWatchAction`).
- [ ] F17.8 Add the deliveries table and store methods @needs: F17.1 Define the delivery contract in packages/shared/src/delivery.ts

  - Migration for `deliveries` plus `mergePolicy` on projects and tasks; get/upsert/list/delete-with-card; rows feed the task mirror's summary fields.
  - Acceptance: migration verified with the drop-column + electron-as-node recipe (memory *the-store-has-no-tests*); pure row-mapping round-trip tests.
- [ ] F17.9 Check the rails against the PR diff @needs: F17.7 Write the pure nextDeliveryAction decision function

  - Glob-match `protectedPaths` against `diffNameStatus` (including rename old paths) and count lines against `maxDiffLines`, skipping F6's collapsed generated files; runs before any AI review and again on every round.
  - Acceptance: temp-repo integration test (outside the work tree — memory *headless-scenario-harness-traps*) for a migration path, a renamed protected file and an oversize diff.
- [ ] F17.10 Build deliveryEngine and drive it from opening the PR and every forge sync @needs: F17.7 Write the pure nextDeliveryAction decision function, F17.8 Add the deliveries table and store methods, F17.9 Check the rails against the PR diff, F17.6 Store the optional reviewer bot token per forge

  - `apps/client/src/main/delivery/deliveryEngine.ts`: create on `openPullRequestFor`, advance after `watchMergeRequests`, run F16's reviewer on green, send findings as one `delivery-fix` chat, approve (bot or skip), merge directly or arm forge auto-merge, park with the reason; only PRs with `openedForTaskId`.
  - Acceptance: engine tests with fake forge and fake reviewer for approve→merge, request-changes→fix→approve, max rounds, protected path, self-approval park, moved head (409), PR closed by a human.
- [ ] F17.11 Park deliveries as an attention item that survives restart @needs: F17.10 Build deliveryEngine and drive it from opening the PR and every forge sync

  - New `AttentionKind` `delivery-parked` with Merge anyway / Run another round / Switch to Manual; rebuilt from `deliveries` on boot; reviewer runs parked by a usage limit resume from the limit gate's resume, never a timer. Grep every `AttentionKind` and run-purpose switch (typecheck will not find them).
  - Acceptance: tests for each action; a reboot test that a parked delivery reappears; a limit park that resumes exactly once.
- [ ] F17.12 Record the verdict on the timeline and as one PR comment @needs: F17.10 Build deliveryEngine and drive it from opening the PR and every forge sync

  - Timeline notes at each phase change and the F2 activity entry; one verdict comment per reviewed SHA, posted with the bot token when present.
  - Acceptance: tests that a repeat sync posts no second comment; the comment names the SHA, verdict, finding count and cost.

### F17 · Phase 4 — UI

- [ ] F17.13 Add merge policy, rails and reviewer token to project settings @needs: F17.6 Store the optional reviewer bot token per forge, F17.8 Add the deliveries table and store methods

  - Radio group with one-line consequences, rails editor, per-forge bot token with "approvals will be real / will be skipped" status; choosing a policy turns on `autoCreatePr` and says so.
  - Acceptance: `pnpm build` green; tokens only, no hard-coded colours; the web settings fork shows "set this from the desktop app" for the token.
- [ ] F17.14 Show the policy toggle and the delivery strip on the card @needs: F17.11 Park deliveries as an attention item that survives restart, F17.12 Record the verdict on the timeline and as one PR comment

  - Fourth icon toggle with `mergePolicyTooltip` in `agentAutoToggles.ts`; the strip on the PR row (phase, round, verdict, cost, park actions); colour only for the running reviewer and parks (memory *board-colour-budget*); same component in the web through `@tm/ui`.
  - Acceptance: tests for `mergePolicyTooltip` wording and the pure strip state; headless smoke render (memory *verify-electron-app* — never launch the user's app); web build green.

### F17 · Phase 5 — End to end

- [ ] F17.15 Write the autonomous delivery end-to-end scenario and user docs @needs: F17.14 Show the policy toggle and the delivery strip on the card, F17.3 Pin GitHub landing and add the forge-landing release hand-off

  - `scripts/verify-delivery.mjs`: a three-card plan with `@needs`, a stub `claude` for both the coding agent and the reviewer (first verdict request-changes, then approve), a fake forge for PR/pipeline/merge, asserting that card 2 starts only after card 1's PR is merged and `landedAt` written, and that a protected-path card parks. Add "Autonomous delivery" to `docs/03-how-orchestration-works.md`.
  - Acceptance: prove the script fails by mutation (revert F17.2's predicate; memory *headless-scenario-harness-traps*); `pnpm typecheck`, `pnpm test`, `pnpm build` green with `--force` (memory *a-cached-gate-is-not-a-gate*).
