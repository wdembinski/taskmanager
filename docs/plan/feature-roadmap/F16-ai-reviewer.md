# F16 — AI reviewer

> **Status:** proposed · **Where:** client (desktop main + `packages/ui`), web (through the relay) · **Depends on:** F15 (review workspace, subjects, `local-ref` source, `review_drafts`) · **Unlocks:** F17 (autonomous delivery: the AI review step), F18 (soft: AI drafts published as part of a review)
> Only the `- [ ]` checkboxes under **Tasks** become cards when this file is imported as a plan; everything else is context.
>
> **Layout rule for this file:** every task's description bullets sit after a **blank line**. The plan
> parser folds any indented line that directly follows a checkbox into that task's *title*
> (`apps/client/src/main/planParser.ts:173-177`); the blank line is what keeps descriptions out of it.

## Why

Reading a diff is the slow part of review, and much of what it catches is mechanical: a missed
null check, a test that asserts nothing, a migration without a down path, a string that should
be a constant. A model reading the same diff with the repository open finds most of that in a
few minutes and costs a few dollars.

F16 adds **Ask AI to review** to any review subject F15 can open:

- your own PR, before you request a human;
- a colleague's PR, as a pre-review before you read it yourself;
- an agent card's work, before you merge it.

The reviewer is a headless Claude session in a **read-only temporary worktree at the PR
head**. It is given the diff, the ticket or PR description and the repository's own
`REVIEW.md`, if there is one. It answers with **structured findings**, each with a path, a
line range, a severity, a body and an optional suggested change.

Findings land in the F15 workspace as **AI-marked drafts**. The human curates them: accept,
edit or dismiss. Nothing reaches the forge or the agent without the human. Every review shows
what it cost.

F17 builds its "AI review → merge" policy on this engine; F16 itself never merges, approves or
posts anything.

## What we have today

- **Sessions:** `apps/client/src/main/claudeSession.ts`. `buildClaudeArgs` (`:269`) runs
  `claude -p --output-format stream-json --input-format stream-json --verbose --model …
  --permission-mode …` with `--session-id`/`--resume`, appends the
  `HEADLESS_TURN_CONTRACT` file (`headlessContract.ts:41`) and, when a gate is present,
  `--mcp-config … --permission-prompt-tool …`. It **cannot restrict tools**: there is no
  `--allowedTools`/`--disallowedTools` and no settings-source control. `StartSessionRequest`
  (`packages/shared/src/session.ts:45`) has `prompt, cwd, model, permissionMode,
  autoCompactPercent, subagentModel`. A `result` event carries `costUsd`, `resultText` and
  `usage` (`session.ts:125-145`).
- **A run with no card exists:** `Scheduler.startAuxiliarySession(projectId, request)`
  (`scheduler.ts:2437`), the "Align plan" run. It records usage as `'orchestrator'` with
  `taskId: null`, stops the session on `result`, and is registered so Stop and dispose reach
  it. It has **no limit or sign-in park**. A limit hit there is simply lost.
- **The release run is the precedent for a repo-owned instruction file.** `startReleaseRun`
  (`scheduler.ts:7407`) refuses when something is already running on the card and notes a
  missing `RELEASE.md` instead of staying silent. It picks a permission mode that can do the
  job (`releaseMode`, `:479`), and the prompt is built by the pure `buildReleasePrompt`
  (`releasePrompt.ts`). `RELEASE_DOC = 'RELEASE.md'` is in `packages/shared/src/release.ts:25`.
- **Permissions:** `permissionPolicy.ts` classifies a tool use as `allow` or `ask`. There is no
  `deny`, and unknown tools default to `allow`. The broker (`permissionBroker.ts`) routes `ask`
  to the Attention inbox, which is **task-scoped** (`AttentionItem.taskId`,
  `packages/shared/src/attention.ts:76`).
- **Parks:** `LimitGate` (`limitGate.ts:278`) and `AuthGate` (`authGate.ts:149`) hold
  `parkedTaskIds` only (`packages/shared/src/limit.ts:39`, `auth.ts:50`). Detection is
  `detectLimitFailure` (`limitGate.ts:175`) and `detectAuthFailure` (`authGate.ts:116`). The
  memories *limit-gate-is-the-only-memory* and *a-limit-that-only-said-so-in-prose* are why
  anything a limit stops must be parked in the gate itself.
- **The model ladder:** `task.agentModel ?? (planning ? project.planningModel : null) ?? project.defaultModel`
  (memory *model-split-phase23*; `Project.defaultModel`/`planningModel` at
  `packages/shared/src/model.ts:216-227`).
- **Cost accounting:** `token_usage` (`store.ts:1546`) with `source` in
  `UsageSource = 'task' | 'orchestrator'` (`packages/shared/src/usage.ts:17`) and a nullable
  `taskId`. `recordUsage`/`recordCost` are at `scheduler.ts:4316`/`:4346`. The Performance
  dashboard rolls it up in `usageRollup.ts`.
- **Validation:** no schema library in any package (no zod, ajv or valibot). The house
  pattern is a hand-written pure validator (`planValidate.ts`).
- **Worktrees:** `addWorktree` (`git.ts:232`) adds a worktree on a branch only, with no
  `--detach`. `removeWorktree`/`pruneWorktrees` exist. F15 adds `refs/tm/review/<subjectId>/head`
  in the project clone.
- **No `REVIEW.md`** anywhere, and nothing reads one.

## Design

### Data model & contracts

A new `packages/shared/src/aiReview.ts`:

- `AiFinding { path, side: 'new' | 'old', startLine, endLine, severity: 'blocker' | 'major' | 'minor' | 'nit', category?: string, title, body, suggestion?: string }`.
  `suggestion` is the full replacement text for `startLine..endLine` on the new side.
- `AiReviewOutput { summary: string; verdict: 'approve' | 'comment' | 'request-changes'; findings: AiFinding[] }`.
  `verdict` is recorded and shown. F17 acts on it; F16 never does.
- `AiReview { id, subjectId, diffId, headSha, status, parkReason | null, model, startedAt | null, finishedAt | null, costUsd | null, tokens | null, summary | null, verdict | null, findingCount, droppedCount, error | null, requestedBy: 'human' | 'automation' }`.
- `status`: `queued | running | parked-limit | parked-signin | failed | done | cancelled`.
- Caps: `AI_REVIEW_MAX_CHANGED_LINES = 4000`, `AI_REVIEW_MAX_FILES = 150`,
  `AI_REVIEW_MAX_FINDINGS = 50` and `AI_REVIEW_RESULT_MAX_BYTES = 200_000`.

Pure functions:

- `parseFindings(resultText)`: the reviewer is told to end with exactly one fenced
  ```` ```json ```` block. The **last** such block is parsed, and nothing else in the reply is
  trusted.
- `validateFindings(output, summary, filesByPath)`:
  - a field-by-field check;
  - each finding's `path` must be in the diff;
  - the range must resolve with `excerptFor` on the named side.

  A range outside the hunks but inside the file becomes a **file-level** finding (anchored
  to the file, with the range named in the body). An unknown path is **dropped** and counted
  in `droppedCount`. The result is `{ ok, findings, dropped, errors }`, and is never thrown.
- `findingToDraft(finding, review)`: maps a finding onto a F15 `review_drafts` row with
  `origin: 'ai'`. A suggestion is kept as structured data; F18 formats it per forge.

`review_drafts` (F15) gains `origin ('human' | 'ai')`, `aiReviewId`, `severity`,
`suggestion`, `acceptedAt` and `dismissedAt`. An AI draft counts as the human's — sendable or
publishable — **only once accepted**. Editing it accepts it.

### Engine / desktop main process

**`ReviewRunner`** (`apps/client/src/main/review/aiReviewRunner.ts`) owns the queue. It runs
one review at a time per desktop by default.

1. **Refusals as data, before anything is spent:**
   - the subject has no `aiReview` capability (`forge-api` source: "add the repo as a
     project to let the AI review it");
   - the diff is over the caps ("too large to review — N changed lines, cap 4,000");
   - a review for the same `diffId` is already queued or running;
   - the limit or sign-in gate is up, in which case the review **parks** with the gate's
     reason rather than being refused;
   - for a card subject, the card is running (its worktree is moving under the reviewer).
2. **Worktree.** `git worktree add --detach <root>/<reviewId> <headSha>` from the project clone
   (F15 has fetched the ref). The root is under userData (`review-worktrees/`), never inside a
   repo (memory *headless-scenario-harness-traps*). For a card subject it uses the card's
   branch HEAD. Uncommitted changes in the card's worktree are **not** reviewed, and the
   result says so ("N uncommitted files were not reviewed"). The worktree is removed when the
   run settles. A boot-time sweep removes any left behind, through `removeWorktree` +
   `pruneWorktrees`. Everything goes through the project's `ExecHost` (WSL).
3. **Read-only by construction, not by request.** `StartSessionRequest` gains optional
   `allowedTools`, `disallowedTools`, `settingSources` and `strictMcpConfig`, which
   `buildClaudeArgs` turns into flags. A review run uses:
   - `allowedTools`: `Read`, `Grep`, `Glob`, `Bash(git log:*)`, `Bash(git show:*)`,
     `Bash(git diff:*)`, `Bash(git blame:*)`;
   - `disallowedTools`: `Edit`, `Write`, `MultiEdit`, `NotebookEdit`, `WebFetch`,
     `WebSearch`, `Task`;
   - the permission gate, with a new **review policy**: `evaluateReviewToolUse` returns
     `allow` or **`deny`**, never `ask`. Nobody is watching, and the Attention inbox has no
     card to hang an item on. A denied tool use is recorded on the review;
   - `settingSources: ['user']` and `--strict-mcp-config`. A PR is untrusted input: its
     `.claude/settings.json` could add hooks that run shell commands on the reviewer's machine,
     and its `.mcp.json` could add servers. Neither may load.

   The flags are probed once per CLI version (`claude --help`, the same free-probe pattern as
   the `/usage` probe). If the installed CLI lacks them, AI review is **refused** with that
   reason. It never silently runs unsandboxed.
4. **Prompt.** A pure `buildReviewPrompt` (`apps/client/src/main/review/reviewPrompt.ts`), on
   the `buildReleasePrompt` model. It contains:
   - what is under review: the PR/MR or card title and description, the linked ticket's body
     when there is one, base and head SHAs, and the file list with +/− counts;
   - that the full diff is `git diff <baseSha>...<headSha>` in the current directory;
   - the instructions file;
   - the output contract (the JSON schema, severities, one fenced block at the end, at most
     50 findings, nothing but findings in the JSON);
   - "never modify files".

   It does not inline the whole diff: the reviewer reads it with git, which keeps a big diff
   out of the prompt and lets it read the surrounding code.
5. **`REVIEW.md` is read from the base, not the head.** It comes from
   `git show <baseSha>:REVIEW.md` and is passed in the prompt. A PR that edits `REVIEW.md`
   cannot rewrite its own reviewer's rules. The worktree's copy is ignored, and the prompt says
   so. A missing file is not a failure: the run uses a built-in default checklist, and the
   result notes "no REVIEW.md — used the default checklist", as `startReleaseRun` does for a
   missing `RELEASE.md`. Project `instructions` are appended, as for releases.
6. **Model.** The ladder gains a review rung:
   `project.reviewModel ?? project.planningModel ?? project.defaultModel`. Reviewing is
   reading and judging, the same kind of turn as planning. `reviewModel` is null by default,
   meaning "same as planning" (the three-state idiom from memory *model-split-phase23*).
7. **Run.** A sibling of `startAuxiliarySession`, `startReviewSession(review, request)`:
   - registered for Stop and dispose;
   - usage recorded with a new `UsageSource` value, `'review'`, and the subject's `taskId`
     when it has one. Grep `usageRollup.ts`, the dashboard and every `source ===` site,
     because typecheck will not find the widening;
   - the cost shown live from `result.costUsd`.
8. **Settle.** On `result`:
   - `detectAuthFailure`, then `detectLimitFailure`, before anything else (see parks);
   - `parseFindings` → `validateFindings`;
   - if the JSON is missing or invalid, **one repair turn** through `handle.send()` naming the
     validation errors (the session is still open, `--input-format stream-json`). A second
     failure ends the run as `failed` with the errors kept;
   - valid findings become drafts in one transaction, and `aiReview:changed` is emitted;
   - the session is stopped, the worktree removed and the review row finalised.

   The `result` must be read after `settled` is checked (memory
   *a-park-settled-over-by-its-own-result*). A failure that lands after a park must not
   re-queue it.
9. **Parks.** `LimitState` and `AuthState` gain `parkedReviewIds?: string[]` (optional, so
   persisted gates still load). A limit or sign-in failure parks the review in the gate with
   its reason. `onResumeDue` restarts every parked review **from scratch**: a new session and
   a new worktree, because a half-finished review has no useful state. The gate is the only
   memory (memory *limit-gate-is-the-only-memory*); the review row's status only mirrors it.
10. **Head moved.** If the subject's `diffId` changed while the review ran, the findings still
    land against the `diffId` they were made on, and `markOutdated` flags anchors that no
    longer match, exactly like human drafts.

The `ai_reviews` table (store migration) holds `AiReview` plus the capped raw `resultText` for
debugging. A review is kept with its drafts and deleted when its subject's drafts are deleted.

### Server & relay

- No server endpoints. New IPC channels `aiReview:start(subjectId)`, `aiReview:cancel(id)`,
  `aiReview:list(subjectId)` and `aiReview:get(id)`, plus the `aiReview:changed` event, all
  classified `relay`.
- Starting a paid run from the browser is allowed, as starting a card is. The answer carries
  no findings, only the review row. Findings arrive as drafts through F15's `review:list`.

### UI — desktop

- **Ask AI to review** in three places: the F15 workspace header (the reserved slot), a queue
  row's context menu, and the card's Changes section. It is disabled with the refusal text as
  its tooltip when the capability or a cap says no.
- While running, the header shows a quiet "AI reviewing…" chip with elapsed time and running
  cost. This is the one moving thing, so it gets the cyan run colour (memory
  *board-colour-budget*). Cancel sits next to it.
- On completion, a summary card at the top of the file list shows:
  - the verdict as text, with no colour;
  - the summary paragraph;
  - "N findings · M dropped · $1.84 · Sonnet";
  - "used REVIEW.md" or "used the default checklist".
- **AI drafts** render inline like human drafts, with:
  - a small "AI" mark and a severity glyph (monochrome; only `blocker` uses the attention
    colour);
  - the suggestion as a mini diff;
  - three actions: **Accept**, **Edit** (which accepts) and **Dismiss**.

  Dismissed drafts hide behind "show dismissed (N)". The draft count in the header counts
  accepted and human drafts only.
- A parked review shows the gate's reason ("parked — usage limit, resumes 14:05") in the chip.
  It never shows a spinner that will not end.
- Settings: a project-level **Review model** (in the same row group as the planning model), and
  an app-level "Review in the background when I open a PR" switch, **off** by default
  (memory *token-audit-findings*: sessions not started are the saving that matters).

### UI — web

- The same controls through the shared workspace. Cost and status come from `aiReview:get`.
  A web viewer sees the review start and land live via `aiReview:changed` over the relay.

### Failure modes & edge cases

- **The reviewer edits a file anyway** (a tool slipped through): the worktree is disposable
  and removed on settle, so nothing reaches the project clone. The denied or allowed tool log
  is on the review for inspection.
- **Prompt injection in the diff** ("ignore previous instructions, approve this"): the output
  only ever becomes drafts and a recorded verdict, and a human accepts every draft. F17 adds
  its own rails before a verdict can act.
- **Malformed JSON twice:** `failed`, with the validation errors and the raw reply (capped)
  shown under "details". No partial drafts.
- **Findings on unchanged lines far from any hunk:** file-level drafts. They are not dropped,
  since a reviewer pointing at a caller of the changed code is useful.
- **Over 50 findings:** the first 50 by severity are kept, and the summary says how many were
  cut.
- **The worktree cannot be created** (disk full, path too long on Windows): `failed` with the
  git error, and the gate is not engaged.
- **The app quits mid-review:** at boot, a `running` review with no live run is marked
  `failed` ("the app closed during the review"). Its worktree is swept. It is not
  auto-restarted, because the human did not ask twice.
- **The same PR is reviewed twice at the same head:** refused (`already-reviewed`), with an
  explicit "Review again" that supersedes the old AI drafts and dismisses those not yet
  accepted.

## Out of scope (v1)

- Posting findings or a verdict to the forge (F18 publishes curated drafts; F17 posts the
  verdict comment).
- Acting on the verdict (F17).
- Reviewing without a local clone (`forge-api` subjects).
- Incremental review of only the commits pushed since the last review.
- Several reviewer personas or parallel reviews of one PR.

## Open questions

- **Read-only enforcement if the CLI lacks `--setting-sources`/`--strict-mcp-config`?**
  Recommended default: refuse AI review with the reason and a "update Claude Code" hint. A
  weaker fallback (refuse only when the PR touches `.claude/**` or `.mcp.json`) is possible but
  easy to get wrong.
- **Should `REVIEW.md` be read from the base or the head?** Recommended default: the base. The
  head is the thing under review.
- **Restart or resume a parked review?** Recommended default: restart. Resuming saves cache
  reads, but a review is one turn and a fresh worktree is simpler to reason about.
- **Review model default?** Recommended default: follow the planning model (null =
  `planningModel ?? defaultModel`).
- **Background review on open?** Recommended default: off. It spends money on PRs the human
  may never read.
- **Concurrency?** Recommended default: one AI review at a time per desktop, queued behind
  card runs only by the gates, not by a shared slot.

## Tasks

### F16 · Phase 1 — Contract and prompt

- [ ] F16.1 Define the AI review and finding contracts in packages/shared/src/aiReview.ts

  - Add `AiFinding`, `AiReviewOutput`, `AiReview`, the status union and the caps, plus the
    `origin`/`aiReviewId`/`severity`/`suggestion`/`acceptedAt`/`dismissedAt` fields on the F15
    draft type.
  - Acceptance: `pnpm typecheck` green; a test that `AI_REVIEW_RESULT_MAX_BYTES` is below
    `RESULTS_BYTES_LIMIT`.

- [ ] F16.2 Implement parseFindings and validateFindings against a diff summary @needs: F16.1 Define the AI review and finding contracts in packages/shared/src/aiReview.ts

  - `parseFindings` reads only the last fenced JSON block. `validateFindings` checks the
    fields, the path, and the range via `excerptFor`; it yields file-level fallbacks and
    dropped counts, and never throws. Add `findingToDraft`.
  - Acceptance: table tests for valid output, prose with no block, two blocks (the last
    wins), an unknown path (dropped), a range outside the hunks (file-level), an inverted
    range, more than 50 findings (cut by severity) and non-JSON junk.

- [ ] F16.3 Write buildReviewPrompt with REVIEW.md read from the base @needs: F16.1 Define the AI review and finding contracts in packages/shared/src/aiReview.ts

  - A pure `apps/client/src/main/review/reviewPrompt.ts`: subject context, the git command to
    read the diff, `REVIEW.md` text (from `git show <baseSha>:REVIEW.md`) or the default
    checklist, project instructions, the output contract, and "never modify files". Add
    `REVIEW_DOC = 'REVIEW.md'` beside `RELEASE_DOC`.
  - Acceptance: snapshot tests with and without `REVIEW.md`, with a linked ticket, and for a
    card subject with uncommitted files (named as not reviewed).

### F16 · Phase 2 — The engine

- [ ] F16.4 Add tool restriction and settings isolation to buildClaudeArgs with a CLI capability probe

  - `StartSessionRequest` gains `allowedTools`, `disallowedTools`, `settingSources` and
    `strictMcpConfig`, mapped to flags in `buildClaudeArgs`. Values go through the contract
    file or quoted args, mindful of the `shell: true` quoting note at `claudeSession.ts:262`.
    Add a cached `claude --help` probe that reports whether the flags exist.
  - Acceptance: `buildClaudeArgs` tests (absent fields produce byte-identical args for every
    existing caller); probe parsing tests for a CLI with and without the flags.

- [ ] F16.5 Add a deny-only review policy to the permission broker @needs: F16.4 Add tool restriction and settings isolation to buildClaudeArgs with a CLI capability probe

  - Add `PermissionDecision`'s `deny` arm and `evaluateReviewToolUse` (allow read tools and
    the git read subcommands; deny everything else, including `git` writes and any shell
    pipeline). The broker answers `deny` without creating an Attention item and records it on
    the review.
  - Acceptance: exhaustive policy tests (`git log` allowed; `git checkout`, `git log; rm x`,
    `Edit` and `WebFetch` denied); the existing `evaluateToolUse` tests are unchanged.

- [ ] F16.6 Add the ai_reviews table and the AI columns on review_drafts @needs: F16.1 Define the AI review and finding contracts in packages/shared/src/aiReview.ts

  - Store migration: `ai_reviews`, the new `review_drafts` columns, row mapping, and
    list/get/update methods. Mark stale `running` rows `failed` at boot.
  - Acceptance: verified with the drop-column + electron-as-node recipe (memory
    *the-store-has-no-tests*); round-trip tests of the pure row mapping.

- [ ] F16.7 Manage detached review worktrees with a boot sweep

  - Add `addDetachedWorktree(repo, path, sha)` to `git.ts`, and
    `apps/client/src/main/review/reviewWorktrees.ts` (create under
    `userData/review-worktrees/<reviewId>`, remove on settle, sweep orphans at boot), all
    through `ExecHost`.
  - Acceptance: an integration test against a temp repo outside the work tree: create at a
    SHA, assert the main checkout and branches are untouched, remove, and sweep an orphan
    directory that git no longer knows.

- [ ] F16.8 Build ReviewRunner with refusals, one repair turn and drafts landing in one transaction @needs: F16.2 Implement parseFindings and validateFindings against a diff summary, F16.3 Write buildReviewPrompt with REVIEW.md read from the base, F16.5 Add a deny-only review policy to the permission broker, F16.6 Add the ai_reviews table and the AI columns on review_drafts, F16.7 Manage detached review worktrees with a boot sweep

  - `apps/client/src/main/review/aiReviewRunner.ts` and `Scheduler.startReviewSession`:
    - the queue (one at a time) and the refusals as data;
    - worktree, prompt, launch with the review flags, and live cost;
    - the settle path: auth, then limit, then parse, then the repair turn, then drafts;
    - cleanup, cancel, and `aiReview:changed`.
  - Acceptance: scheduler-level tests with a fake session for a clean run, a repair turn that
    fixes the JSON, two failures (`failed`, no drafts), cancel mid-run (worktree removed),
    and a head that moved mid-run (drafts land outdated).

- [ ] F16.9 Park AI reviews in the limit and sign-in gates @needs: F16.8 Build ReviewRunner with refusals, one repair turn and drafts landing in one transaction

  - Add `parkedReviewIds?` to `LimitState` and `AuthState`, engage with the review's id on a
    detected wall, refuse-to-park at start while a gate is up, and restart from scratch on
    `onResumeDue`. A failure after the park must not re-queue it (check `settled` in the
    `result` branch).
  - Acceptance: tests for a limit detected only in prose (memory
    *a-limit-that-only-said-so-in-prose*), a sign-in failure, a gate restored at boot with a
    parked review, and a result landing 10 ms after the park (memory
    *a-park-settled-over-by-its-own-result*).

- [ ] F16.10 Record review cost under a review usage source and add the review model rung @needs: F16.8 Build ReviewRunner with refusals, one repair turn and drafts landing in one transaction

  - Widen `UsageSource` with `'review'`. Grep every `source ===` and `'orchestrator'` site
    (typecheck will not find them) and give reviews their own row on the Performance
    dashboard. Add `Project.reviewModel` (nullable, store migration) and the ladder
    `reviewModel ?? planningModel ?? defaultModel`.
  - Acceptance: `usageRollup` tests that review spend is counted once and shown separately;
    ladder tests for all three states; the migration verified with the electron-as-node
    recipe.

- [ ] F16.11 Expose the aiReview channels over IPC and the relay @needs: F16.8 Build ReviewRunner with refusals, one repair turn and drafts landing in one transaction

  - Register `aiReview:start`, `aiReview:cancel`, `aiReview:list`, `aiReview:get` and the
    `aiReview:changed` event, all classified `relay`.
  - Acceptance: handler tests (start refused for a `forge-api` subject and over the caps);
    `test/ipc-relay-coverage.test.ts` green; all three gates green.

### F16 · Phase 3 — In the workspace

- [ ] F16.12 Render AI drafts with accept, edit and dismiss in the review workspace @needs: F16.11 Expose the aiReview channels over IPC and the relay

  - Extend `reviewState.ts` and the comment thread with the AI mark, the severity glyph, the
    suggestion mini-diff, accept/edit/dismiss, "show dismissed (N)", and draft counts that
    exclude unaccepted AI drafts. Card subjects' *Send to agent* sends accepted drafts only.
  - Acceptance: state-machine tests for each transition, and that an unaccepted AI draft is
    never included in `formatReviewMessage`'s input; a headless render with one draft per
    severity.

- [ ] F16.13 Add Ask AI to review with status, cost and the summary card @needs: F16.12 Render AI drafts with accept, edit and dismiss in the review workspace

  - The button in the workspace header, the queue row menu and the card's Changes section,
    with the refusal tooltip; the running chip with cost and Cancel; the parked text; the
    summary card; the Review model field in project settings; the background switch, off by
    default.
  - Acceptance: `pnpm build` green; a headless render of the running, parked, failed and done
    states; tokens only, cyan used only on the running chip.

### F16 · Phase 4 — Verification

- [ ] F16.14 Write verify-ai-review.mjs with a stub claude and document REVIEW.md @needs: F16.13 Add Ask AI to review with status, cost and the summary card, F16.9 Park AI reviews in the limit and sign-in gates, F16.10 Record review cost under a review usage source and add the review model rung

  - A scenario with a stub `claude` on PATH (memory *stub-claude-on-path*) that:
    - asserts the review flags in its argv;
    - writes a marker if any tool tries to edit;
    - prints a findings block on its first turn and broken JSON on a second scenario, to
      exercise the repair turn;
    - prints a rate-limit result on a third, to exercise the park.

    The scenario asserts drafts, cost rows, worktree removal and an unchanged project clone.
    Add a "AI review" section and a `REVIEW.md` template to
    `docs/03-how-orchestration-works.md`.
  - Acceptance: prove the script can fail by mutation (memory
    *headless-scenario-harness-traps*); all three gates green, run with `--force`.
