# F15 — Review workspace

> **Status:** proposed · **Where:** client (desktop main + `packages/ui`), web (through the relay) · **Depends on:** F6 (shipped), F13 (shell, Reviews sidebar entry, theme tokens) · **Unlocks:** F16 (AI reviewer), F18 (forge review round-trip), F17 (soft)
> Only the `- [ ]` checkboxes under **Tasks** become cards when this file is imported as a plan; everything else is context.
>
> **Layout rule for this file:** every task's description bullets sit after a **blank line**. The plan
> parser folds any indented line that directly follows a checkbox into that task's *title*
> (`apps/client/src/main/planParser.ts:173-177`); the blank line is what keeps descriptions out of it.

Mockup: [`mockups/v9-6-review-workspace-light.svg`](mockups/v9-6-review-workspace-light.svg).

## Why

F6 put an agent's diff on its card. That covers one of the three kinds of review a working day
has. The other two still happen outside the app: a colleague's pull request that asks for your
review, and your own PR/MR waiting on someone else. Neither has a card, so neither has a
diff here.

The F6 pane is also built to sit inside a card's detail pane. It is a narrow column with a
unified diff, no syntax colour, no way to see more context than git's three lines, and no
memory of which files you have already read. That is enough for a glance at an agent's
change. It is not enough for a 40-file review.

F15 adds a full-screen **review workspace**, reached from a **Reviews** entry in the sidebar.
It lists three queues — *Requested from me*, *My PRs/MRs* and *Agent cards awaiting review* —
and opens any item in one layout: file tree, unified or side-by-side diff, syntax
highlighting, expandable context, viewed-file checkboxes and keyboard navigation.

The diff source is **hybrid**. When the PR's repository is a project in the app, its local
clone fetches the PR/MR head ref and F6's diff service does the rest, so everything works,
including (later) AI review in a worktree. When it is not, the workspace falls back to the
forge's diff API: read and draft comments only.

## What we have today

- **The F6 contract** in `packages/shared/src/review.ts`: the caps (`:19-22`,
  `DIFF_FILE_MAX_BYTES = 256_000`, `DIFF_SUMMARY_MAX_FILES = 1000`), `DiffSummary` (`:59`),
  `DiffFile`/`DiffHunk`/`DiffLine` (`:69-89`), `parsePatch` (`:392`, which expects full
  `diff --git` headers), `ReviewComment` (`:422`), the `stale`/`landed`/`conflicted`/
  `no-branch` variants (`:444-468`), `excerptFor` (`:543`), `markOutdated` (`:572`),
  `formatReviewMessage` (`:638`) and `wordDiff` (`:691`).
- **Everything is keyed by `taskId`.** `DiffService` (`apps/client/src/main/review/diffService.ts:152`)
  exposes `summary(taskId)`, `file(taskId, diffId, path)` and `image(…)`. Its private
  `resolve(taskId)` (`:351`) walks task → owner card → project → live worktree or task branch
  → base, and returns a `Resolved` that `fileFrom` and the caps then consume. `computeDiffId`
  (`:127`) hashes base, head and a work-tree fingerprint. The git reads sit behind the
  `DiffGit` interface (`:64`).
- **The comment store** is `review_comments` (`apps/client/src/main/store.ts:1927`) with
  `taskId TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE`. A pull request with no card
  cannot have a row there. Sending is `reviewService.ts` (the `'task:chat'` path).
- **IPC:** `task:diffSummary`, `task:diffFile`, `task:diffImage`, `review:list|add|update|delete|send`
  (`packages/shared/src/ipc.ts:794-833`), all classified `relay`
  (`packages/shared/src/ipcRelay.ts:272-280`).
- **The pane:** `packages/ui/src/review/` — `ReviewPane.tsx` (effects and transport),
  `ReviewPaneView.tsx` (state in, JSX out), `DiffView.tsx` (unified only), `FileTree.tsx`,
  `CommentThread.tsx`, the pure `reviewState.ts` and `reviewView.ts`. The del/add run pairing
  that feeds word highlights is at `reviewView.ts:152`. It mounts in `TaskDetail.tsx:62`,
  `VariantCompare.tsx:26` and the compact card screen (F3.8).
- **Not there:** syntax highlighting, a side-by-side layout, context expansion, viewed state
  and keyboard navigation. A grep of `packages/ui/src/review` finds none of them, and
  `packages/ui/package.json` depends only on `@tm/protocol` and `@tm/shared`. There is no
  shortcut layer either (F9 records the ad-hoc `keydown` listeners).
- **Git:** `fetchRef` (`apps/client/src/main/git.ts:1046`) fetches only `+refs/heads/<branch>`
  into a local ref, under `NO_PROMPT_ENV` and with secret redaction. It cannot fetch
  `refs/pull/N/head`. `addWorktree` (`:232`) only adds a worktree on a branch. `showBlob`
  (`:819`), `mergeBase` (`:1111`) and `remoteUrl` (`:936`) exist.
  `forge/remoteUrl.ts` has `parseRemoteUrl` (`:43`) and `pickForge` (`:98`).
  `forge/createPr.ts:543` `resolveForgeGitTarget` builds a tokenized URL from `origin` only.
- **GitHub client** (`apps/client/src/main/github/githubClient.ts`): `listMyPullRequests`
  (`:588`, search `is:pr is:open author:@me`), `searchIssues` (`:606`, with the truncation
  flag), `getPullRequest` (`:788`, carries `head.sha`), `listReviewComments` (`:985`),
  `listReviews` (`:993`) and `graphqlRoot` (`:391`). **No review-requested query** (a grep for
  `review-requested` finds nothing). There is no PR files or diff endpoint.
- **GitLab client** (`apps/client/src/main/gitlab/gitlabClient.ts`): `listMyMergeRequests`
  (`:321`, `scope=created_by_me`). Its comment says MRs where you are a reviewer were left out
  on purpose. `GitLabMergeRequest.reviewers` (`:63`), `getReviewers` (`:406`) and `listNotes`
  (`:603`) exist. There is **no `reviewer_username` query**, no diffs endpoint, and no
  `diff_refs` on the MR type.
- **`merge_requests` holds your own PRs/MRs only** (`store.ts:1573`). Its rows are
  card-matched by a guess (`MergeRequest.taskId`, `packages/shared/src/mergeRequest.ts:59-87`)
  and protected by the removal guard (`forge/removalGuard.ts`). Other people's PRs must not be
  put in it, or the guard and the card matcher would act on them.
- **Navigation:** the desktop rail is `TabId` in `apps/client/src/renderer/src/App.tsx:117`.
  It has no `reviews`. F13 replaces the rail with the sidebar that carries the Reviews entry.
- **Relay caps:** `RESULTS_BYTES_LIMIT = 1_000_000` (`cloudResults.ts`). Memory
  *one-answer-wedges-the-mirror* records why every relayed answer must be bounded.

## Design

### Data model & contracts

In `packages/shared/src/review.ts`:

- `ReviewSubject = { kind: 'task'; taskId } | { kind: 'pr'; provider: ForgeProvider; repoId: number; repoPath: string; number: number }`.
  `subjectId` is a string: `task:<taskId>`, or the same `gh-<repoId>-<n>` / `gl-<repoId>-<n>`
  form `MergeRequest.id` already uses (`github/githubPrSync.ts:83`). A PR found by search has
  no numeric repo id (the search row lacks it), so the queue service reads the detail first.
- `ReviewQueue = 'requested' | 'mine' | 'agent'`, and
  `ReviewQueueItem { subjectId, queue, subject, title, author, repoPath, ref ('#12' / '!12'), headSha | null, draft, updatedAt, projectId | null, taskId | null, draftCount, viewedCount, fileCount | null }`.
  `projectId` is set when a local clone was matched.
- `ReviewSource = 'worktree' | 'local-ref' | 'forge-api'`. `DiffSummary` gains `subjectId`,
  `source` and `capabilities { expandContext, aiReview, sendToAgent, publish }`, so the UI
  never has to infer what a source can do. The widening is optional on the type. Typecheck
  does **not** find every place that builds a summary; grep for `DiffSummary` and
  `includesWorkingTree` (memory *phase24-tickets-design*).
- `DiffFileEntry` gains `newBlobSha?: string`, which the viewed state keys on.
- `ReviewViewedMark { subjectId, path, blobSha, viewedAt }`.
- Drafts are generalised from `taskId` to `subjectId` (see the engine section).

Pure functions, all unit-tested:

- `parseHunks(text)`: forge APIs return per-file hunks without `diff --git` headers.
  `parsePatch` keeps its signature and delegates to `parseHunks` for each file body.
- `expandContext(file, gap, lines)`: merges lines read from a blob into the gap before,
  between or after hunks. They become `context` rows with both line numbers derived from the
  neighbouring hunk offsets. Expanded rows are real lines, so `excerptFor` anchors work on
  them unchanged.
- `splitRows(file)`: turns hunks into `{ left: DiffLine | null; right: DiffLine | null }`
  rows. It reuses the del/add run pairing at `reviewView.ts:152`, so side-by-side rows and
  word highlights line up the same way.
- `viewedState(entries, marks)`: a mark counts only while its `blobSha` equals the entry's
  `newBlobSha`. A file the author changes again comes back unviewed.

### Engine / desktop main process

**One resolver per source.** `DiffService.resolve` is split in two. Subject resolution
produces a `ResolvedDiff { git, dir, baseRef, baseSha, headSha, to, includesWorkingTree, diffId, source }`,
and `fileFrom`, `stat`, `image` and the caps keep consuming exactly that. The existing task
path becomes `resolveTask` and is unchanged in behaviour (F6, F3 and F10 tests stay green).
Two new resolvers are added:

- **`local-ref`, for a PR whose repo is an app project.** The project is matched by parsing
  *every* remote of every project (`git remote -v`, then `parseRemoteUrl`) and comparing host
  and path with the PR's repo. A fork checkout whose upstream is named `upstream` still
  matches. The matched remote is fetched with a new `fetchRefspecs(cwd, remoteOrUrl, specs[], opts)`
  (`fetchRef` becomes a one-spec call to it). It runs under the same `NO_PROMPT_ENV`, with
  `credential.interactive=never` and redaction:
  - GitHub: `+refs/pull/<n>/head:refs/tm/review/<subjectId>/head`
  - GitLab: `+refs/merge-requests/<iid>/head:refs/tm/review/<subjectId>/head`
  - both: `+refs/heads/<base>:refs/tm/review/<subjectId>/base`

  Fork PRs work because both forges publish these refs on the *target* repo. The fetched head
  must equal the forge's `head.sha` / `sha`; if it does not, the PR moved during the fetch, so
  it is fetched once more and then answered `stale`. `baseSha = mergeBase(base, head)` and
  `to = headSha` give the same three-dot diff the forge shows. The fetch **never** touches the
  working tree, the index, `HEAD` or any branch. It is safe while the main checkout is dirty
  or mid-rebase (memory *merge-only-moves-the-checked-out-branch*). Refs live under
  `refs/tm/review/` and are deleted when their subject leaves every queue. A tokenized URL is
  used when the remote needs one, exactly as `resolveForgeGitTarget` does for pushes.
- **`forge-api`, for a PR with no local clone.**
  - GitHub: `GET /repos/{o}/{r}/pulls/{n}/files` (100 a page, at most 3,000 files). `patch`
    is missing for binary and oversized files, which read as `tooLarge`.
  - GitLab: `GET /projects/:id/merge_requests/:iid/diffs` (15.7+), falling back to
    `/changes` on a 404 from older self-hosted instances.
  - Each body goes through `parseHunks`. `diffId = computeDiffId(base_sha, head_sha, 'forge')`.
  - The pages for one `diffId` are cached in memory (a small LRU, keyed by `diffId`). A file
    read then does not refetch the whole PR.
  - Context expansion reads raw files at a SHA (GitHub contents API with the raw media type;
    GitLab `repository/files/:path/raw?ref=`), under `DIFF_FILE_MAX_BYTES`.
  - Capabilities: `expandContext` and `publish` (F18), but not `aiReview` (F16 needs a
    worktree) and not `sendToAgent`.

**The review queues.** A new `apps/client/src/main/review/queueService.ts` builds the queues:

- *Requested from me:* GitHub search `is:pr is:open review-requested:@me archived:false`
  (through `searchIssues`, keeping its `truncated` flag), and GitLab
  `GET /merge_requests?reviewer_username=<me>&state=opened&scope=all`. The username comes
  from the existing identity call (`gitlab/identity.ts`).
- *My PRs/MRs:* the existing `merge_requests` rows (`mr:mergeRequests`). No new forge call.
- *Agent cards awaiting review:* top-level cards with `status === 'in-review'`, `workedAt`
  set and `landedAt` null, read from the store.

The answer is cached in a new `review_queue` table (subject, queue, row JSON, `syncedAt`), so
the sidebar count is there at boot and the web gets an answer without a forge round trip. A
row is dropped only from a **complete** answer. A truncated search or a failed call keeps the
last rows and shows "as of" (memories *jql-drops-what-you-finish* and
*merged-mr-drops-out-of-the-list*). The service refreshes when Reviews opens, every
5 minutes while the app runs, and on demand. GitHub search allows 30 requests a minute, and
this uses 1–2 of them.

**Drafts.** A new `review_drafts` table keyed by `subjectId` replaces `review_comments` as the
store behind the `review:*` channels. A store migration copies every existing row across
with `subjectId = 'task:' || taskId`, and the old table is left in place for one release. The
`tasks` foreign key goes away, so card deletion deletes `task:<id>` drafts explicitly. Verify
it with the drop-column + electron-as-node recipe (memory *the-store-has-no-tests*). For a PR
subject, drafts stay local until F18 publishes them. F15 offers **Copy review as Markdown**
(`formatReviewMessage`) and **Open on forge** in the meantime.

**Viewed state.** A new `review_viewed (subjectId, path, blobSha, viewedAt)` table. The blob
SHA comes from `git ls-tree` for `local-ref` and `worktree`, and from GitHub's per-file `sha`.
GitLab's diffs carry no blob SHA, so it uses a hash of the file's diff text.

**IPC.** New `review:queues`, `review:refreshQueues`, `review:subjectSummary`,
`review:subjectFile`, `review:subjectImage`, `review:context` (`subjectId, diffId, path, side, from, to`
→ at most 2,000 lines and `DIFF_FILE_MAX_BYTES`), `review:viewed` and `review:setViewed`, and
the `review:queues:changed` event. The existing `task:diff*` channels stay as thin wrappers
over `task:<id>`, so the card pane and F3/F10 are untouched. Every new channel is classified
`relay` in `ipcRelay.ts`, and typecheck enforces it.

### Syntax highlighting

Highlighting happens in the renderer (`packages/ui/src/review/highlight.ts`), the same code on
the desktop and in the web, so nothing new crosses the relay.

**Library: highlight.js v11, core build** (`highlight.js/lib/core`), with languages registered
lazily through dynamic `import()` the first time a file extension needs them. The reasons:

- it tokenises **fragments**. A hunk is not a whole file, and in `forge-api` mode a hunk is
  all we have;
- it is synchronous string → spans, with no DOM, no WASM and no theme of its own to fight our
  tokens;
- the core is roughly 25 kB minified (about 8 kB gzip), and each language is 2–15 kB, loaded
  only when used. The task measures the real delta and holds it to a budget.

The alternatives were rejected:

- Shiki: TextMate grammars plus an Oniguruma WASM or JS-regex engine — hundreds of kB before
  the first language, and themes rather than tokens.
- Lezer: accurate and incremental, but it parses whole files with per-language parsers. That
  suits an editor, not hunks.
- Prism: similar weight, a global mutable language registry, and weaker TSX.

Strategy:

- Highlight each hunk side as **one block**, then split by line, so multi-line strings and
  comments inside a hunk come out right.
- When the whole file is at hand (`local-ref`/`worktree`, under the cap), highlight the full
  file once per side and index the result by line number. That fixes constructs that open
  outside the hunk.
- Lines over 1,000 characters and files over 20,000 lines stay plain. Work is chunked with
  `requestIdleCallback`. A Web Worker is a follow-up only if a measured file stays over
  16 ms.

Colour: syntax colour is **content**, like the add/del tints, and sits inside the code surface
only. It uses a muted five-hue set of new `syntax*` tokens in `theme.ts`, for light and dark,
plus a "monochrome code" setting. Chrome around the diff gets no new colour (memory
*board-colour-budget*).

### UI — desktop

- **Entry.** The F13 sidebar's **Reviews** entry carries the count of *Requested from me*.
  If F15 lands before F13's sidebar, it adds a `reviews` `TabId` to the rail
  (`App.tsx:117`), which F13 then moves.
- **Layout** (see the mockup). Three columns:
  - the queues: three collapsible groups with counts, each row showing the faint mono ref,
    title, author avatar and a draft count when there are drafts;
  - the file tree: the F6 `FileTree`, plus a viewed checkbox per file and "12 / 40 viewed";
  - the diff.

  Panes follow F13's near-opaque `paneGlass`. The **code surface itself is fully opaque**, because
  translucent text backgrounds hurt reading.
- **Header:** title, `owner/repo#N`, `base ← head`, a source badge ("local clone" or "forge
  API · read only"), the layout toggle (unified / side by side), the draft count and the
  actions:
  - *Send to agent* for card subjects (the F6 path);
  - *Copy review as Markdown* and *Open on forge* for PR subjects (F18 replaces the copy with
    *Publish*);
  - a reserved slot for F16's *Ask AI to review*.
- **Side by side** uses `splitRows`. It has a comment gutter on each side, word highlights
  from the same pairing, and the layout is remembered per viewer as a local (not mirrored)
  setting (memory *settings-mirror-global-vs-local*). Below 900 px wide it falls back to
  unified.
- **Expand context:** a "⋯ N hidden lines" row between hunks. Clicking it expands 20 lines;
  shift-click expands all.
- **Viewed:** ticking a file collapses it and moves the selection to the next unviewed file.
- **Keyboard** (`packages/ui/src/review/reviewKeys.ts`, pure):

  | Key | Action |
  | --- | --- |
  | `n` / `p` | next / previous file |
  | `j` / `k` | next / previous hunk |
  | `v` | toggle viewed, then go to the next file |
  | `s` | unified / side by side |
  | `e` | expand context around the current hunk |
  | `c` | comment on the focused line |
  | `?` | show the key list |
  | `Esc` | close the editor, then the workspace |

  The keys are ignored in inputs and during IME composition, as F9 specifies, and use F9's
  `shortcutMatches` if it has landed. The workspace actions are also registered as palette
  commands (`packages/ui/src/palette/paletteModel.ts`).
- **The card's Changes section** gains *Open in review workspace*. The card pane stays as
  it is.

### UI — web

- The same `ReviewWorkspace` renders under a `/reviews` route in `apps/web`. Every read and
  write goes through the relay (memory *web-mirrors-the-desktop*).
- Bounds:
  - a queue answer is capped at 300 rows;
  - each file and each context read is one answer under the F6 caps;
  - highlighting runs in the browser.
- The web draws the F6 states (unreachable, `stale`, oversized answer). It adds "queues as of
  <time>" when the desktop answered from cache.
- Compact (F3) keeps its own Changes tab. The workspace on a phone width is unified only and
  is not redesigned here.

### Failure modes & edge cases

- **The fetch fails** (no credentials, network, SSO-enforced org, a closed PR whose ref is
  gone). The workspace falls back to `forge-api` and **says why** in the source badge's
  tooltip. It never falls back silently.
- **The PR moved** between listing and reading: `stale`, a reload, and drafts kept via
  `markOutdated`, as in F6.
- **No project matches** but the human has the repo cloned somewhere: `forge-api` with a hint
  to add the clone as a project.
- **GitLab without `/diffs`:** `/changes` instead. Without either: an explicit error naming
  the instance version.
- **A huge PR** (more than 1,000 files or GitHub's 3,000-file limit): `truncated: true`,
  stated in the header, as in F6.
- **Search rate limit or `incomplete_results`:** keep the cached queue and show "as of".
- **The subject leaves every queue** (merged, closed, request withdrawn): its review refs are
  deleted and its drafts are kept. A direct link still opens it read-only.
- **The WSL execution target:** every git call goes through the project's `ExecHost`, and
  paths in answers are repo relative.
- **Highlighting a file with an unknown extension:** plain monospace, never a guessed
  language.

## Out of scope (v1)

- Publishing comments, approving or requesting changes on the forge (F18).
- AI review (F16).
- Commit-by-commit view and interdiffs between two pushes.
- Syncing the "viewed" state with GitHub's own per-file viewed flag.
- Editing files, blame, or a repo browser.
- A mobile layout for the workspace beyond unified fallback.

## Open questions

- **One generalised drafts table, or a second table for PR subjects?** Recommended default:
  one `review_drafts` table keyed by `subjectId`, with the copy migration. Two tables would
  duplicate every handler, and F16/F18 add columns to drafts that both kinds need.
- **Fetch PR refs into a project's clone without asking?** Recommended default: yes, for
  projects already in the app. The refs are namespaced under `refs/tm/review/`, pruned
  automatically, and never checked out. A per-project setting can turn it off.
- **Which highlighter?** Recommended default: highlight.js core with lazy languages, for the
  reasons above. Revisit only if the measured cost misses the budget.
- **Queue refresh cadence?** Recommended default: on open plus every 5 minutes. It is 1–3 forge
  requests, and the badge is worthless if stale.
- **Include plan steps in the agent queue?** Recommended default: no, top-level cards only.
  Steps share their parent's branch, and their diff is the card's.
- **Sync viewed state with GitHub?** Recommended default: not in v1 (GraphQL
  `markFileAsViewed` is a later card).

## Tasks

### F15 · Phase 1 — Contracts and pure helpers

- [ ] F15.1 Define review subjects, queue items and diff sources in packages/shared/src/review.ts

  - Add `ReviewSubject`, `subjectId` helpers (`task:<id>`, `gh-…`, `gl-…`), `ReviewQueue`,
    `ReviewQueueItem`, `ReviewSource`, the `capabilities` block and `subjectId`/`source` on
    `DiffSummary`, `newBlobSha` on `DiffFileEntry`, and `ReviewViewedMark`.
  - Grep every builder of `DiffSummary` (typecheck will not find optional widenings) and set
    the new fields on the existing task path.
  - Acceptance: `pnpm typecheck` green; tests for the `subjectId` round trip and for a
    summary built by the existing task path carrying `source: 'worktree'`.

- [ ] F15.2 Implement parseHunks and make parsePatch delegate to it @needs: F15.1 Define review subjects, queue items and diff sources in packages/shared/src/review.ts

  - Add a pure `parseHunks(text)` for header-less per-file bodies, as GitHub's `patch` and
    GitLab's `diff` fields return them. `parsePatch` calls it per file and keeps its
    signature.
  - Acceptance: every existing `review.test.ts` fixture passes unchanged; new fixtures from
    real GitHub and GitLab API bodies (no-newline marker, a binary file with no patch, a
    rename with no hunks).

- [ ] F15.3 Implement splitRows, expandContext and viewedState @needs: F15.1 Define review subjects, queue items and diff sources in packages/shared/src/review.ts

  - Pure helpers in `packages/shared/src/review.ts`, as specified in **Data model &
    contracts**. `splitRows` reuses the del/add pairing from
    `packages/ui/src/review/reviewView.ts:152` (moved to shared if needed, re-exported from
    `reviewView`).
  - Acceptance: tests for uneven del/add runs, a pure-add file, context expansion at file
    start/end and between hunks (line numbers on both sides), an `excerptFor` anchor on an
    expanded line, and a viewed mark invalidated by a new blob SHA.
  - **Facts checked** (ahead of design): `pairWordDiffs` (`packages/ui/src/review/reviewView.ts:159`;
    its own doc comment starts a few lines above at `:151`, which is what this plan's `:152`
    actually points into) runs each `del` run immediately followed by its `add` run, pairs
    them index-for-index through `wordDiff` (shortest run first), and leaves the unmatched
    tail — and every `context` line — `null`. `wordDiff`/`WordSegment` live in
    `@tm/shared/review` (`review.ts:812`/`:787`). It is used by `DiffView.tsx:589` and tested
    from `reviewView.test.ts:121`. All exactly as described.
  - `excerptFor` (`review.ts:664`, with `rowIndex` just above it at `:652`) flattens
    `file.hunks[].lines` once and matches a side only through that side's own field —
    `oldLine` for `'old'`, `newLine` for `'new'`, never the other one. A `context` line
    carries both, so a row that becomes `context` after expansion resolves from either side
    with no change to `excerptFor` itself, confirming the plan's premise.
  - The git hunk convention holds in this codebase's own fixtures: `review.test.ts:99` parses
    a pure-add file's header as `@@ -0,0 +1,3 @@`, and `parseHunkCounts` (`review.ts:363`)
    already defaults an omitted count to `1` and treats `0` as "that side is empty" — so
    `expandContext`'s "a 0-count side's first line is `c+1`" needs no new parsing, only
    arithmetic on the hunk's own `oldStart`/`newStart`/`oldLines`/`newLines`.
  - The three shared vitest files are exactly as named — `review.test.ts`,
    `review.subject.test.ts` and `review.message.test.ts` — all colocated with `review.ts` in
    `packages/shared/src/`. `review.split.test.ts` does not exist yet; step 3 creates it from
    nothing.
  - None of `splitRows`, `expandContext` or `viewedState` exist yet (a grep of `review.ts` for
    each name finds nothing), so there is no existing behaviour to preserve here, only the
    design doc's contract above to satisfy.
  - Two things the design doc leaves for the Implementation step to decide, not re-derive:
    "reuses the del/add pairing" can only mean the run-detection loop inside `pairWordDiffs`
    (`reviewView.ts:162-172`, the two inner `while`s that find each `delStart..delEnd`/
    `addStart..addEnd` pair) — the word-level output itself (`WordSegment[] | null`) isn't
    what a side-by-side row needs, and that loop has no name of its own yet to reuse by. And
    `expandContext`'s `gap` parameter has no existing shape to match: `review.ts` defines no
    gap/context-window type today, so its shape (file-start / between-hunks / file-end, and
    which line numbers bound it) is Implementation's to design.

### F15 · Phase 2 — Sources, queues and storage on the desktop

- [ ] F15.4 Add the review_drafts, review_viewed and review_queue tables with the review_comments copy migration @needs: F15.1 Define review subjects, queue items and diff sources in packages/shared/src/review.ts

  - Store migration in `apps/client/src/main/store.ts`:
    - create the three tables;
    - copy `review_comments` rows into `review_drafts` with `subjectId = 'task:' || taskId`;
    - leave the old table for one release.
  - Re-point `reviewService.ts` and the `review:*` handlers at `review_drafts`, and delete a
    card's drafts explicitly on card delete.
  - Acceptance: the migration is verified with the drop-column + electron-as-node recipe
    (memory *the-store-has-no-tests*), including a DB that already holds sent and unsent F6
    comments; the existing `reviewService.test.ts` passes against the new table.

- [x] F15.5 Add fetchRefspecs and the refs/tm/review namespace to git.ts

  - Add `fetchRefspecs(cwd, remoteOrUrl, specs, opts)` with `NO_PROMPT_ENV`,
    `credential.interactive=never` and redaction, and turn `fetchRef` into a one-spec caller.
    Add `deleteRefs(cwd, prefix)` and `listRemotes(cwd)`. Everything goes through `ExecHost`.
  - Acceptance: an integration test against a temp bare "forge" repo outside the work tree
    (memory *headless-scenario-harness-traps*). It fetches `refs/pull/7/head` into
    `refs/tm/review/…` and asserts that HEAD, the index, the working tree and every branch
    are byte-identical before and after, even with a dirty tree.

- [ ] F15.6 Split DiffService.resolve into subject resolvers and add the local-ref source @needs: F15.5 Add fetchRefspecs and the refs/tm/review namespace to git.ts, F15.1 Define review subjects, queue items and diff sources in packages/shared/src/review.ts

  - Extract `ResolvedDiff`, keep the task path as `resolveTask`, and add `resolvePrLocal`:
    - match the project across all remotes;
    - fetch the head and base refs;
    - verify the head SHA against the forge's;
    - compute the merge base;
    - set `source: 'local-ref'`.

    Prune a subject's refs when it leaves every queue.
  - Acceptance: the existing `diffService.test.ts` passes unchanged; new fake-git tests cover
    a fork PR, a head that moved during the fetch (`stale` after one retry), no matching
    project (falls through), and a fetch failure that records its reason for the badge.

- [ ] F15.7 Add PR file, raw-file and reviewer-queue reads to the GitHub and GitLab clients

  - GitHub: `listPullRequestFiles` (paged, `patch`, `sha`, `status`, `previous_filename`),
    `getRawFile(owner, repo, path, ref)`, and `listReviewRequests()` =
    `searchIssues('is:pr is:open review-requested:@me archived:false')`.
  - GitLab:
    - `listMergeRequestDiffs`, with the `/changes` fallback on 404;
    - `getRawFile(projectId, path, ref)`;
    - `listReviewerMergeRequests(username)`;
    - `diff_refs` on `GitLabMergeRequest`.
  - Acceptance: client tests with recorded responses for paging, a missing `patch`, the 404
    fallback, and `truncated` propagation from search.

- [ ] F15.8 Build the forge-api diff source @needs: F15.7 Add PR file, raw-file and reviewer-queue reads to the GitHub and GitLab clients, F15.2 Implement parseHunks and make parsePatch delegate to it, F15.6 Split DiffService.resolve into subject resolvers and add the local-ref source

  - `apps/client/src/main/review/forgeDiffSource.ts`:
    - summary and file answers built from the forge pages, with a per-`diffId` LRU;
    - context reads and images from raw files;
    - the F6 caps applied, and capabilities `{ expandContext, publish }`.
  - Acceptance: tests with a fake client for every result variant, a `tooLarge` file without
    a patch, a stale `diffId` after the head moves, and an LRU hit that makes no second
    network call.

- [ ] F15.9 Build the review queue service with complete-answer-only removal @needs: F15.7 Add PR file, raw-file and reviewer-queue reads to the GitHub and GitLab clients, F15.4 Add the review_drafts, review_viewed and review_queue tables with the review_comments copy migration

  - `apps/client/src/main/review/queueService.ts`: the three queues, project matching
    (`projectId`), draft and viewed counts, the `review_queue` cache, and refresh on open,
    every 5 minutes and on demand.
  - Rows are removed only from a complete answer. Emit `review:queues:changed`.
  - Acceptance: tests for a truncated search (nothing dropped), a forge outage (cache kept,
    `syncedAt` unchanged), an agent card leaving `in-review`, and a PR that is both mine and
    requested (shown once, under *My PRs/MRs*).

  - **Design decisions, taken against the current code — step 2 writes these, it does not
    re-derive them:**
    - **Segments, not queues, are the unit every refresh reconciles.** `requested` is really
      two independent network calls — GitHub's `listReviewRequests()` and GitLab's
      `listReviewerMergeRequests(username)` (both already implemented, F15.7) — so it splits
      into segments `requested:github` and `requested:gitlab`; `mine` (a synchronous read of
      `store.listMergeRequests()`, no forge call) and `agent` (a synchronous read of the
      store's own tasks) are each one segment. Reconciliation happens per segment, never per
      queue: a GitHub outage must not touch GitLab's rows in the same `requested` queue, and
      vice versa. Every segment answers `{ rows: ReviewQueueItem[]; complete: boolean } |
      'failure'` for one refresh.
    - **Forge-disabled is a complete empty answer; a throw (including "no token") is a
      failure.** `store.getSettings().github.enabled` / `.gitlab.enabled` is checked BEFORE
      building a client — when off, the segment answers `{ rows: [], complete: true }`
      straight away, same as any other complete pass, so turning an integration off clears
      its rows out of the cache instead of leaving them stranded forever. Only once enabled
      is a client actually built: `ipc.ts`'s own `buildGitHubClient`/`buildGitLabClient`
      (`ipc.ts:2227-2233`) already throw when no token is saved, and that throw — along with
      any network failure from the list call itself, and a `requested:gitlab` segment with
      no cached username yet (`store.loadGitLabIdentity()` returns null, so
      `reviewer_username` cannot be asked for) — is the `failure` case: no writes, existing
      rows and `syncedAt` left exactly as stored.
    - **Reconciliation against the cache, per the three outcomes:** `failure` writes
      nothing for that segment's subjects. `complete: false` (GitHub/GitLab's own
      `truncated`, or a GitHub repo whose id could not be resolved — see below) upserts every
      row the segment DID return with a fresh `syncedAt`, and deletes nothing — a row for a
      repo that could not be resolved this round is simply absent from the returned set, so
      its last cached state, if any, survives untouched under its own, older `syncedAt`.
      `complete: true` upserts every returned row, then deletes every cached row already in
      this exact segment (same queue, same `subject.provider` for a `requested:*` segment)
      whose `subjectId` is not among the ones just returned.
    - **The cache read filters the one `review_queue` table by `subject.provider` in
      memory, not by a schema column.** The table (`store.ts:2151-2157`) is keyed
      `(subjectId, queue)` with `row` holding the whole `ReviewQueueItem` as JSON — there is
      no `provider` column to scope a `requested:github`-only delete to, so reconciling a
      `requested:*` segment reads every cached `requested` row, parses `row.subject.provider`
      out of the JSON, and only ever upserts/deletes the ones matching this segment's own
      provider. `mine`/`agent` need no such filter — each is already its own whole queue.
    - **`DiffService.matchProject(host, repoPath)` is extracted from the existing
      `matchPrProject` (`diffService.ts:588-613`), which then calls it.** The two project/
      remote loops stay byte-identical; only the parameter source changes from
      `req.host`/`req.subject.repoPath` to two plain strings, and the return narrows to just
      `{ project, remote, parsedRemote } | null` (no `refGit` — that stays `matchPrProject`'s
      own addition on top, since only it needs to fetch):
      ```ts
      async matchProject(host: string, repoPath: string): Promise<{
        project: Project;
        remote: { name: string; fetchUrl: string; pushUrl: string };
        parsedRemote: RemoteRef;
      } | null> { /* the existing double loop, comparing against host/repoPath directly */ }

      private async matchPrProject(req: PrLocalRequest) {
        const refGitFor = this.deps.refGitFor;
        if (!refGitFor) return null;
        const match = await this.matchProject(req.host, req.subject.repoPath);
        return match ? { ...match, refGit: refGitFor(match.project) } : null;
      }
      ```
      `matchProject` becomes a public method (the queue service calls it directly);
      `matchPrProject` stays private. Behaviour for every existing `resolvePrLocal` caller is
      unchanged.
    - **The GitHub repo-id map is rebuilt once per `refresh()`, never persisted.** A fresh
      `Map<string, number>` keyed by the lowercased `owner/repo` string `repoRefFromApiUrl`
      already parses off `repository_url` (`describePullRequest.ts:52`, the same helper
      `ipc.ts` imports) is seeded for free from every row `store.listMergeRequests()` already
      loaded this refresh (`projectPath` → `repoId`, both already on `MergeRequest` —
      `mergeRequest.ts:90,92`), then filled on demand with one new
      `GitHubClient.getRepository(owner, repo)` call per still-unseen `owner/repo` the
      `requested:github` segment's rows name — the same shape as `getBranchProtection`
      (`githubClient.ts:1105-1113`):
      ```ts
      getRepository(owner: string, repo: string): Promise<{ id: number; full_name: string }> {
        return this.request<{ id: number; full_name: string }>(repoPath(owner, repo));
      }
      ```
      Rebuilding the map every refresh rather than caching it across refreshes is deliberate:
      a repo id never changes, so there is no staleness to chase, and refilling it costs
      nothing (`merge_requests` is already loaded; the GET only fires for a repo nothing has
      named yet). GitLab needs no such map — `GitLabMergeRequest.project_id` is already the
      numeric id (`gitlabClient.ts:39`).
    - **`GitLabMergeRequest` gains an `author` field; `GitHubSearchIssueItem` already has
      one.** GitHub's search rows already carry `user?.login` (`githubClient.ts:89`);
      GitLab's list/detail endpoints return an `author` object by default but the client's
      own type never declared it (only `GitLabNote.author` does, `gitlabClient.ts:97`), so
      this step widens `GitLabMergeRequest` with the identical
      `author?: { id?: number; username?: string; name?: string } | null;` and reads
      `mr.author?.name ?? mr.author?.username ?? ''`.
    - **`author` for `mine` and `agent` rows has no forge payload to read it from.** `mine`
      rows are, by construction, always authored by the signed-in user
      (`listMyMergeRequests`/`listMyPullRequests` already scope to
      `created_by_me`/`author:@me` — `gitlabClient.ts:400-411`, `githubClient.ts:638-639`),
      so their `author` is read from the already-cached
      `store.loadGitHubIdentity()`/`loadGitLabIdentity()` (`.login`/`.username`) for the
      row's own `provider`, falling back to `''` when that identity has never been resolved.
      `agent` rows have no author concept at all — a card is not authored by anyone in the
      forge sense — so `author: ''` there, deliberately.
    - **`requested` rows never need a `taskId` lookup.** Dedup (below) only ever removes a
      subject from `requested` when the SAME subject is present in `mine` — and every `mine`
      row comes from `store.listMergeRequests()`, the one place `taskId` is already computed
      (`MergeRequest.taskId`/`openedForTaskId`). So any `requested` row that survives dedup,
      by definition, has no matching `mine` row to borrow a `taskId` from; `requested` rows
      always answer `taskId: null` rather than re-running a match dedup already proved would
      fail.
    - **`agent` rows map directly off `Task`, with no forge concepts to resolve.**
      `subject: { kind: 'task', taskId: task.id }`, `subjectId: taskSubjectId(task.id)`,
      `title: task.title`, `projectId: task.projectId` (known already — no `matchProject`
      call needed), `taskId: task.id`, `repoPath:` the owning project's `name` (display
      only, same as every other queue), `ref: ''`, `headSha: null` (resolved lazily by
      `DiffService` once the workspace actually opens the subject, not eagerly here),
      `draft: false`, `updatedAt: task.workedAt!` (non-null by construction — see the
      predicate below), `author: ''`.
    - **The `agent` segment's predicate, read straight off the store:** every task, across
      every project (`store.listProjects().flatMap(p => store.getTasks(p.id))`, the same
      cross-project read `ipc.ts:946` already uses), with `parentTaskId == null` (top-level —
      a step of an approved plan is not its own review subject), `status === 'in-review'`,
      `workedAt != null` (something actually ran) and `landedAt == null` (not already
      merged). Always `complete: true` — a store read cannot truncate or go offline.
    - **Enrichment (`projectId`, `draftCount`, `viewedCount`) runs once per `refresh()`,
      after every segment's raw rows are collected — not per segment.** All of a refresh's
      rows (`requested:github` ∪ `requested:gitlab` ∪ `mine` ∪ `agent`, before dedup) share
      one pass: a `Map<string, ProjectId | null>` memoizes `matchProject` by
      `` `${host}\n${repoPath}` `` so ten PRs on the same repo cost one match;
      `draftCount`/`viewedCount` are fetched in one grouped query each
      (`countUnsentDrafts`/`countViewedMarks`, below) over the whole batch's `subjectId`s
      rather than one query per row.
    - **Two new `Store` reads, grouped rather than per-id**, since a refresh can touch dozens
      of subjects at once:
      - `countUnsentDrafts(subjectIds: readonly string[]): Record<string, number>` —
        `SELECT subjectId, COUNT(*) FROM review_drafts WHERE sentAt IS NULL AND subjectId IN
        (...) GROUP BY subjectId`; a subject absent from the result means 0.
      - `countViewedMarks(subjectIds: readonly string[]): Record<string, number>` — the same
        shape over `review_viewed`. Documented as an upper bound on both the store method and
        `ReviewQueueItem.viewedCount` itself: it counts every stored mark regardless of
        whether its `blobSha` still matches, which only `viewedState` (F15.3) —
        recomputed once a subject's own summary is loaded, F15.10 — can tell apart from a
        `changed` file.
    - **The `review_queue` cache reads/writes, shaped around the table as it already
      exists (`store.ts:2151-2157`), not a new schema:**
      - `listReviewQueueRows(queue: ReviewQueue): Array<{ item: ReviewQueueItem; syncedAt:
        number }>` — every cached row for one queue, `row` JSON-parsed, paired with its own
        `syncedAt` so `snapshot()` can compute `asOf` without a second read.
      - `upsertReviewQueueRows(queue: ReviewQueue, items: readonly ReviewQueueItem[],
        syncedAt: number): void` — one `INSERT … ON CONFLICT(subjectId, queue) DO UPDATE` per
        item, `row` re-serialised, `syncedAt` set to the one value for the whole batch.
      - `deleteReviewQueueRows(queue: ReviewQueue, subjectIds: readonly string[]): void` —
        `DELETE … WHERE queue = ? AND subjectId IN (...)`, the one call a complete segment's
        reconciliation uses to drop what it no longer returned.

      No new store method lists tasks for the `agent` segment — `listProjects`/`getTasks`
      already answer it, and the `in-review`/`workedAt`/`landedAt` predicate is queue-service
      business logic, not a storage concern.
    - **Dedup happens in `snapshot()`, on the cached rows, every time — never baked into what
      `refresh()` writes.** After reading every queue's cached rows, drop any `requested` row
      whose `subjectId` also appears in `mine`. Doing it at read time rather than write time
      is why a `requested` row that stops being deduped (the human's `mine` row lands, or the
      PR closes) does not need `refresh()` to run again first, and why a `requested` row that
      WAS deduped keeps living quietly in the cache, ready to reappear the moment its `mine`
      row disappears — the case this ticket's own acceptance list calls out: "a PR that is
      both mine and requested, shown once, under *My PRs/MRs*."
    - **`ReviewQueuesSnapshot` (new, `review.ts`):**
      ```ts
      export interface ReviewQueuesSnapshot {
        items: ReviewQueueItem[];
        asOf: Record<ReviewQueue, number | null>;
        partial: ReviewQueue[];
      }
      ```
      `asOf[queue]` is the OLDEST `syncedAt` among that queue's currently cached rows, taken
      AFTER dedup removes rows (a deduped-away `requested` row must not drag its own queue's
      "as of" back) — `null` for a queue with no rows at all (never synced). `partial` lists
      every queue where ANY of its segments' most recent refresh was `failure` or
      `complete: false` — tracked in memory only, one `Record<ReviewQueue, boolean>` on the
      service itself, defaulting every queue to "not partial" until the first `refresh()`
      this session actually says otherwise (a freshly booted app shows whatever is cached
      with no staleness badge until it has asked at least once).
    - **`ReviewQueueService`'s own shape:**
      ```ts
      export interface ReviewQueueServiceDeps {
        store: Pick<Store, 'listReviewQueueRows' | 'upsertReviewQueueRows' |
          'deleteReviewQueueRows' | 'countUnsentDrafts' | 'countViewedMarks' |
          'listMergeRequests' | 'listProjects' | 'getTasks' | 'getSettings' |
          'loadGitHubIdentity' | 'loadGitLabIdentity'>;
        diffs: Pick<DiffService, 'matchProject' | 'pruneReviewRefs'>;
        github(): GitHubClient; // throws when disabled/no token — ipc.ts's buildGitHubClient
        gitlab(): GitLabClient; // same, buildGitLabClient
        emit(event: 'review:queues:changed'): void;
      }
      ```
      `github`/`gitlab` are factories rather than live client instances so a token saved
      mid-session is picked up on the very next refresh, the same way every other forge call
      in the app already works. `refresh()` de-dupes concurrent callers behind one shared
      in-flight promise, computes every segment, writes the reconciliation above, recomputes
      `partial`, calls `emit('review:queues:changed')` only when the deduped snapshot actually
      changed from the previous one (this ticket's acceptance list requires silence on an
      unchanged forge outage, not an event every 5 minutes), and finally calls
      `diffs.pruneReviewRefs` with the union of every subjectId left in the `review_queue`
      cache across all three queues post-reconciliation (pre-dedup — a deduped-out
      `requested` row is still a live PR worth keeping its ref for), exactly where
      `diffService.ts:616-619` already says the queue service will call it. `refreshLocal()`
      runs only the `mine`+`agent` segments (no forge call, so no in-flight dedup needed) and
      still fires `review:queues:changed` on a real change, but never prunes refs. `open()`
      returns `snapshot()` synchronously and fires `refresh()` without awaiting it. `start()`
      calls `refresh()` once, then `setInterval(() => void this.refresh(), 5 * 60_000).unref()`;
      `stop()` clears that interval.

- [ ] F15.10 Expose the subject, context, viewed and queue channels over IPC @needs: F15.8 Build the forge-api diff source, F15.9 Build the review queue service with complete-answer-only removal, F15.3 Implement splitRows, expandContext and viewedState

  - Register `review:queues`, `review:refreshQueues`, `review:subjectSummary`,
    `review:subjectFile`, `review:subjectImage`, `review:context`, `review:viewed` and
    `review:setViewed`, and re-express `task:diff*` as wrappers. Classify every channel
    `relay` in `packages/shared/src/ipcRelay.ts`.
  - Acceptance: handler tests for each channel, including a context read over the cap
    (refused as data); `test/ipc-relay-coverage.test.ts` green; `pnpm typecheck`, `pnpm test`
    and `pnpm build` green.

### F15 · Phase 3 — The workspace

- [ ] F15.11 Add syntax highlighting with highlight.js core and lazily loaded languages @needs: F15.1 Define review subjects, queue items and diff sources in packages/shared/src/review.ts

  - `packages/ui/src/review/highlight.ts`:
    - an extension → language map;
    - lazy `import()` per language;
    - hunk-block and full-file modes;
    - the line and file length cut-offs and idle-time chunking.

    Add the `syntax*` tokens (light and dark) to `theme.ts`, a "monochrome code" setting, and
    render the spans in `DiffView`.
  - Acceptance: pure tests that a multi-line comment inside one hunk is highlighted on every
    line, and that an over-long line stays plain. Measure the bundle delta: the initial chunk
    grows by no more than 15 kB gzip, and each language lands in its own chunk. `pnpm build`
    green, tokens only.

- [ ] F15.12 Add the side-by-side layout to DiffView @needs: F15.3 Implement splitRows, expandContext and viewedState

  - A split renderer over `splitRows` with a comment gutter per side and the same word
    highlights; the layout toggle with a local per-viewer setting; unified below 900 px.
  - Acceptance: `reviewView` tests that every split row maps back to the right `DiffLine` for
    commenting (old side on the left, new on the right); a headless render of a seeded
    `ReviewState` in both layouts (memory *verify-electron-app*: never launch the user's
    app).

- [ ] F15.13 Extend reviewState with viewed files, expanded context and keyboard navigation @needs: F15.3 Implement splitRows, expandContext and viewedState

  - Add to `packages/ui/src/review/reviewState.ts`:
    - viewed marks;
    - context expansion (load states per gap);
    - the current file and hunk cursor.

    Add the pure `reviewKeys.ts` key map with the input and IME guard.
  - Acceptance: state-machine tests for n/p/j/k at the edges, `v` advancing to the next
    unviewed file, an expansion answer for an old `diffId` (a no-op), and keys ignored inside
    the comment editor.

  - **Design decisions, taken against the current code — step 3 implements these, it does
    not re-derive them:**
    - **`taskId` stays the one frontier key; `subjectId` is derived, never stored.**
      `ReviewState` (`reviewState.ts:81-107`) and every guard on it (`reviewAccepts`,
      `commentsAccepted`, `fileLoadStarted`, …) key on `taskId`, and F15.13 does not touch
      that — the ticket's own brief says so, and `ReviewComment.taskId` (`review.ts:622`) has
      not been generalised to `subjectId` either yet (F15.4 is still `[ ]`). But
      `ReviewViewedMark` (`review.ts:609-614`) already carries `subjectId`, not `taskId` —
      it is shared with drafts and the queue cache (`review.ts:10`). The bridge: wherever a
      mark must be built or compared, derive it on the spot with the already-exported
      `taskSubjectId(taskId)` (`review.ts:79`, `taskSubjectId(subject.taskId)` is exactly
      what `subjectId()` does for a task subject at `:73`). `viewedMarks`/`viewedLoadStarted`/
      `viewedArrived` never filter by subject themselves — they store and overwrite
      wholesale, exactly like `comments`/`commentsLoadStarted`/`commentsArrived` do today
      (`:483-501`). Filtering the marks array down to this card's own `subjectId` before
      calling `viewedArrived` is the host's job (`ReviewPane.tsx`, F15.14), matching
      `viewedState`'s own documented contract: "the caller is expected to have already
      filtered marks by `subjectId`" (`review.ts:1039`). `viewedStatuses(s)` therefore just
      calls `viewedState(s.summary.summary.files, s.viewedMarks)` with no subject logic of
      its own.
    - **`setViewed`'s refusals, precisely:** refuse (return `s`) when `s.taskId === null`
      (nothing to derive a `subjectId` from), when `s.summary?.status !== 'ok'`, when no entry
      in `s.summary.summary.files` matches `path`, or — only for `viewed: true` — when that
      entry's `newBlobSha` is `undefined` (`review.ts:197-198`; there is nothing for a mark to
      key on). Once past the guards: `viewed: true` upserts
      `{ subjectId: taskSubjectId(s.taskId), path, blobSha: entry.newBlobSha, viewedAt: now }`
      into `viewedMarks` (replace any existing mark for the same `path`, else append) and
      removes `path` from `expanded` (collapses it); `viewed: false` removes any mark for
      `path` from `viewedMarks` and leaves `expanded` untouched (unviewing never re-expands).
      `setViewed` never touches `viewedSeq` — that counter belongs to the load race
      (`viewedLoadStarted`/`viewedArrived`) only, the same separation `editDraft`/`clickLine`
      already keep from `commentsSeq`. There is deliberately no `viewedSaved`/`viewedRefused`
      counterpart: unlike comments, a viewed mark has no draft to keep on a refusal, so the
      optimistic local mark IS the state until the next `viewedArrived` reconciles it — step 3
      must not invent a save-ack handler nothing in this brief asks for.
    - **`toggleViewedAndAdvance(s, now)`, built on `setViewed` and `viewedState`:** no-op when
      `s.selectedPath === null` or `s.summary?.status !== 'ok'`. Otherwise read
      `wasViewed = viewedState(s.summary.summary.files, s.viewedMarks).byPath[s.selectedPath]
      === 'viewed'`, then `next = setViewed(s, s.selectedPath, !wasViewed, now)`. If
      `next === s` (the toggle itself was refused — e.g. no `newBlobSha`), return `s`
      unchanged. If the toggle turned a file OFF (`wasViewed` was `true`), return `next` with
      the selection untouched — only turning a file ON advances. When it turned ON: recompute
      `viewedState` against `next.viewedMarks`, walk the navigation order (below) starting
      just after `s.selectedPath`, wrapping to the start, and `selectFile(next, found)` for
      the first path whose status is `'unviewed'` or `'changed'`; if none qualifies, return
      `next` with the selection exactly as `setViewed` left it ("stays put").
    - **Navigation order avoids the import cycle by moving, not just reusing,
      `buildFileTree`.** `reviewView.ts` already imports *runtime* values from
      `reviewState.ts` (`filesToLoad`, `isCollapsedByDefault` — `reviewView.ts:22-28`), so a
      new import the other way (`reviewState.ts` pulling `buildFileTree` out of
      `reviewView.ts`) would be a genuine two-file runtime cycle, not just a type-only one.
      The fix: move `buildFileTree` and its private helpers (`insert`, `collapseChain`,
      `buildChildren`, the `RawDir`/`RawNode` types) and the public `FileTreeNode`/
      `FileTreeDir`/`FileTreeFile` types (`reviewView.ts:30-112`) into `reviewState.ts`, add a
      pure `navigationOrder(entries: readonly DiffFileEntry[]): readonly string[]` next to it
      that flattens the tree into leaf path order (dirs in their already-sorted order, depth
      first, same traversal `buildChildren` already produces), and have `reviewView.ts`
      re-export all four names from `reviewState.ts` — the same re-export shape it already
      uses for `pairWordDiffs` (`reviewView.ts:148`, `export { pairWordDiffs } from
      '@tm/shared/review';`). `FileTree.tsx`, `ReviewPaneView.tsx` and `reviewView.test.ts`
      all import `buildFileTree`/`FileTreeNode`/`FileTreeDir`/`FileTreeFile` from
      `./reviewView` today (confirmed by grep) and need no changes. This file-level move is
      step 2's job ("Files"); step 3 only adds `navigationOrder` and the cursor logic that
      calls it.
    - **`nextFile`/`prevFile` need no "selected path not in the order" branch.**
      `summaryArrived` already prunes `selectedPath` to a path present in the current summary
      or to `null` (`reviewState.ts:191`), so by construction `selectedPath` is always either
      `null` or found in `navigationOrder(s.summary.summary.files)`. `indexOf` on a `null`
      selection is handled by an explicit `selectedPath === null` branch (→ first for `next`,
      last for `prev`), not by relying on `indexOf`'s `-1`.
    - **`nextHunk`/`prevHunk` read the hunk count off the loaded file, not off any cached
      length.** No-op when `s.selectedPath === null`, when `s.files[s.selectedPath]?.status
      !== 'loaded'`, or when that file's `hunks.length === 0`. Otherwise, with
      `hunks = (s.files[s.selectedPath] as { status: 'loaded'; file: DiffFile }).file.hunks`:
      `nextHunk` — `null` → `0`; at `hunks.length - 1` → no-op; else `+1`. `prevHunk` — `null`
      → no-op (per the brief); at `0` → no-op; else `-1`.
    - **`selectFile` gains `hunkIndex: null` in its returned object**, with no change to its
      existing early-return guard (`s.selectedPath === path && s.expanded.includes(path)`) —
      that guard only short-circuits when nothing about the selection is actually changing
      (e.g. `toggleViewedAndAdvance` landing back on the same path because none qualified),
      so the cursor staying put in that one case is intentional, not an oversight.
    - **`gapBounds`/`contextRequest` reuse `expandContext`'s own arithmetic by export, not by
      copy.** `firstLine`/`endLine` (`review.ts:922-929`) are today module-private; this step
      adds `export` to both (no rename, no signature change) so `gapBounds(file: DiffFile,
      gap: number): { low: number; high: number }` in `reviewState.ts` can compute exactly
      `expandContext`'s own `low`/`high` (`review.ts:987-988`): `prev = gap > 0 ?
      file.hunks[gap - 1] : undefined`, `next = gap < file.hunks.length ? file.hunks[gap] :
      undefined`, `low = prev ? endLine(prev.newStart, prev.newLines) : 1`, `high = next ?
      firstLine(next.newStart, next.newLines) : Infinity`.
    - **`contextRequest(file, gap, mode)`'s two modes, concretely, always `side: 'new'`:**
      with `{ low, high } = gapBounds(file, gap)` and `next = gap < file.hunks.length ?
      file.hunks[gap] : undefined`:
      - `'step'`: when `next` exists, the 20 lines right before it —
        `from = Math.max(low, high - 20)`, `to = high - 1`; for the trailing gap (`next`
        undefined, `high === Infinity`), the 20 lines right after the previous hunk instead —
        `from = low`, `to = low + 19`.
      - `'all'`: the whole gap, capped — `from = low`, `to = Number.isFinite(high) ?
        Math.min(high - 1, low + DIFF_CONTEXT_MAX_LINES - 1) : low + DIFF_CONTEXT_MAX_LINES -
        1`.

      Nothing here needs to clamp to the file's own last line — the `review:context` handler
      (F15.10, not this step) already clips to the file length and sets `DiffContext.truncated`
      (`review.ts:684`); `contextRequest` only ever has hunk bounds to work from.
    - **`context`'s key is the bound captured at request time, not re-derived at answer
      time.** `contextLoadStarted(s, taskId, diffId, path, gap, seq)` is refused (same object)
      unless `taskId === s.taskId`, `diffId === s.diffId` and `s.files[path]?.status ===
      'loaded'`; once past those, it computes `{ low } = gapBounds(loadedFile, gap)` from
      that file's *current* hunks and sets `context[path][low] = { status: 'loading', seq }`
      unconditionally (overwriting any prior entry at that bound, same as `fileLoadStarted`
      overwrites `files[path]` unconditionally once its own guards pass). The caller (F15.14)
      carries this same `low` forward into the `review:context` request and the eventual
      `contextArrived`/`contextFailed` call — it must not recompute `gap`/`low` from
      possibly-shifted hunks when the answer lands, which is exactly why `contextArrived`'s
      signature takes `low` and not `gap`.
    - **`contextArrived(s, taskId, diffId, path, low, seq, result)`, the four outcomes:**
      refused (same object) unless `taskId === s.taskId`, `diffId === s.diffId`, and
      `context[path]?.[low]` is `{ status: 'loading', seq }` with this exact `seq` (the same
      "a newer re-request wins" rule `isLoadingThisSeq`/`fileArrived` already use,
      `reviewState.ts:240-242,250-260`).
      - `result.status === 'ok'`: re-scan `0..file.hunks.length` on the *current* loaded file
        for a gap `g` with `gapBounds(file, g).low === low`. If found, apply
        `expandContext(file, g, { start: result.context.start, text: result.context.text })`,
        store the merged file at `files[path]`, clamp `hunkIndex` to
        `Math.min(s.hunkIndex, mergedFile.hunks.length - 1)` when `hunkIndex` is not `null`
        (a merge can only ever reduce the hunk count, never grow it), and delete the
        `context[path][low]` entry. If no such gap is found (a neighbouring expansion already
        swallowed this bound first), apply nothing to `files[path]` — the text would double
        up — but still delete `context[path][low]`, since the row it belonged to no longer
        exists to ever read that key again.
      - `result.status === 'tooLarge'`: `context[path][low] = { status: 'tooLarge', bytes:
        result.bytes }`.
      - `result.status === 'stale'`: sets `staleDiffId = result.currentDiffId`, same as
        `fileArrived`'s own stale handling (`reviewState.ts:270`), and otherwise leaves
        `context[path][low]` as `'loading'` — harmless, since `staleDiffId` being set already
        freezes every other load (`filesToLoad`, `reviewState.ts:646`) until Reload, which
        clears `context` wholesale via the next `summaryArrived` anyway.
      - `contextFailed(s, taskId, diffId, path, low, seq, error)`: same guards, sets
        `context[path][low] = { status: 'idle', error }`.
    - **`context` resets in two places, "same as `files`":** inside `summaryArrived`, both
      the existing non-ok branch (`reviewState.ts:167-178`) and the new-`diffId` branch
      (`:180-194`) additionally reset `context: {}` in the same object they already reset
      `files: {}` in. And `fileLoadStarted` (`:229-238`) additionally sets `context[path] =
      {}` for that one path every time it re-enters `'loading'` — a file being refetched
      invalidates any gap bounds computed against its previous hunks, the same reasoning
      `expandContext`'s own gap arithmetic depends on.
    - **`reviewKeys.ts`'s guard order matters — `editorOpen` is checked before
      `isEditableTarget`, not after.** `isComposing`/`repeat` are checked first and always
      return `null`, matching `shortcutMatches`'s own guard (`palette/shortcut.ts:43`). Then,
      if `ctx.editorOpen`: return `evt.key === 'Escape' ? 'escape' : null` immediately,
      *without* consulting `isEditableTarget` at all — this is deliberate, not an oversight,
      because `CommentThread.tsx:166` already lets Escape close the editor from inside its own
      textarea, and the brief's "ignored … even if focus has left its textarea" requires the
      opposite case too (Escape must still fire when focus has moved to some other, non-
      editable element while the editor is logically still open). Only once `editorOpen` is
      `false` does `isEditableTarget(evt.target)` (reusing `palette/shortcut.ts:35-39`,
      requiring a local `ReviewKeyEventLike extends ShortcutEventLike` that adds
      `target?: EditableTargetLike | null`) gate everything else, followed by the
      Ctrl/Meta/Alt guard, then `evt.key === '?'` → `'showKeys'`, then each letter via
      `shortcutMatches(evt, letter)` (`n`/`p`/`j`/`k`/`v`/`s`/`e`/`c`), then a final
      `evt.key === 'Escape'` → `'escape'` (the "no editor, close the workspace" case the host
      handles), then `null`. Letters deliberately do **not** get `?`'s Shift exception —
      `shortcutMatches` already requires Shift to be absent for a bare letter spec
      (`palette/shortcut.ts:55`), and nothing in the brief asks to loosen that.
    - **`REVIEW_KEYS` reuses F9.6's `KeyboardShortcutItem` shape** (`id`, `label`, `spec`,
      `palette/KeyboardShortcutsList.tsx:27-33`) so F15.14 can pass it straight into
      `<KeyboardShortcutsList items={REVIEW_KEYS} />` for the `?` dialog with no adapting, and
      map it over the palette's own command list separately. One row per discoverable action —
      `nextFile`/`n`, `prevFile`/`p`, `nextHunk`/`j`, `prevHunk`/`k`, `toggleViewed`/`v`,
      `toggleLayout`/`s`, `expandContext`/`e`, `comment`/`c`, `showKeys`/`?` — deliberately with
      no row for `escape`: it is the universal close/cancel key, and no other `?`-list or
      palette table in this codebase lists it either.
    - **`applyReviewKey(s, action, now)`'s full dispatch:** `'nextFile'` → `nextFile(s)`,
      `'prevFile'` → `prevFile(s)`, `'nextHunk'` → `nextHunk(s)`, `'prevHunk'` → `prevHunk(s)`,
      `'toggleViewed'` → `toggleViewedAndAdvance(s, now)`, `'escape'` → `s.editor !== null ?
      closeEditor(s) : s` (the no-editor case is UI-only — the host closes the whole
      workspace, this function has no such concept). `'toggleLayout'`, `'expandContext'`,
      `'comment'` and `'showKeys'` always return `s` unchanged — each needs something this
      pure module cannot do alone (a per-viewer layout setting, a specific gap/anchor to
      expand, focusing a textarea, opening a dialog), so F15.14 reads the action off
      `reviewKeyAction` directly and handles those five itself without ever calling
      `applyReviewKey` for them.

- [ ] F15.14 Build the ReviewWorkspace screen and the Reviews entry @needs: F15.10 Expose the subject, context, viewed and queue channels over IPC, F15.11 Add syntax highlighting with highlight.js core and lazily loaded languages, F15.12 Add the side-by-side layout to DiffView, F15.13 Extend reviewState with viewed files, expanded context and keyboard navigation

  - `packages/ui/src/review/ReviewWorkspace.tsx`, split into an effects component and a
    `…View` component, as F6 does:
    - the queues, the file tree with viewed boxes, and the diff;
    - the header with the source badge and actions (Send to agent / Copy review as
      Markdown / Open on forge), plus the reserved AI slot;
    - the Reviews sidebar entry with its count (or a `reviews` `TabId` if F13's sidebar has
      not landed);
    - *Open in review workspace* on the card's Changes section, and the palette commands.

    Follow the v9 mockup and F13's tokens, with a fully opaque code surface.
  - Acceptance: `pnpm build` green; a headless render of a seeded workspace in light and dark
    themes; no hard-coded colours (tokens only).

### F15 · Phase 4 — Browser and verification

- [ ] F15.15 Make the review workspace work over the relay in apps/web @needs: F15.14 Build the ReviewWorkspace screen and the Reviews entry

  - Add a `/reviews` route rendering the shared `ReviewWorkspace`. Cap the queue answer at 300
    rows. Draw the unreachable, stale, oversized and "as of" states, and fetch one file at a
    time.
  - Acceptance: `httpTransport` tests that the new channels are relayed (not refused); a test
    that a queue answer stays under `RESULTS_BYTES_LIMIT` at the cap; web build green.

- [ ] F15.16 Write the F15 verification script and user docs @needs: F15.15 Make the review workspace work over the relay in apps/web

  - `scripts/verify-review-workspace.mjs`:
    - a temp bare "forge" repo with a PR ref and a clone registered as a project;
    - a fake forge HTTP server for the queues and the `forge-api` path;
    - assertions on the summary, a file, a context expansion, viewed state and the queue
      cache.

    Add a "Review workspace" section to `docs/03-how-orchestration-works.md`.
  - Acceptance: prove the script can fail by mutation (memory
    *headless-scenario-harness-traps*); all three gates green, run with `--force` (memory
    *a-cached-gate-is-not-a-gate*).
