# F18 — Forge review round-trip

> **Status:** proposed · **Where:** client (desktop main + `packages/ui`), web (through the relay) · **Depends on:** F15 (review workspace, subjects, `review_drafts`), F16 (soft: AI drafts publish like any accepted draft) · **Unlocks:** F17's verdict comment and bot approval reuse the publish path; F22 (T4 inbox) and F23 (push) consume its review events
> Only the `- [ ]` checkboxes under **Tasks** become cards when this file is imported as a plan; everything else is context.
>
> **Layout rule for this file:** every task's description bullets sit after a **blank line**. The plan
> parser folds any indented line that directly follows a checkbox into that task's *title*
> (`apps/client/src/main/planParser.ts:173-177`); the blank line is what keeps descriptions out of it.

## Why

After F15 the review happens in the app, but its result still has to be retyped on GitHub or
GitLab. Drafts on a PR subject can only be copied as Markdown. What colleagues already said
on the PR is invisible in the workspace. Approving still means opening the browser.

F18 closes the loop:

- **pull** the existing review threads into the diff;
- **publish** your drafts as **one** review (Comment, Approve or Request changes), with each
  comment on its line;
- **reply** to a thread and **resolve** it;
- map line positions between our diff and the forge's, so nothing lands on the wrong line;
- emit events when you are asked to review or someone replies. A badge on Reviews consumes
  them today. The T4 inbox (F22) and Android push (F23) consume them later.

## What we have today

- **GitHub client** (`apps/client/src/main/github/githubClient.ts`):
  - reads: `listReviewComments` (`:985`, REST `/pulls/{n}/comments`; `GitHubReviewComment`
    has only `path` and `line`, `:132`) and `listReviews` (`:993`, `GitHubReview` with
    `state`/`body`/`user`, `:220`);
  - writes: `addIssueComment` (`/issues/{n}/comments`, `:743-761`), PR update, merge and
    create;
  - `graphqlRoot` (`:391`) exists, so GraphQL calls have a home.

  **Nothing creates a review, posts a line comment, replies, or resolves a thread.**
- **GitLab client** (`apps/client/src/main/gitlab/gitlabClient.ts`):
  - `listNotes` (`:603`) returns non-system notes with **no position** (`GitLabNote`, `:86`);
  - `getApprovals` and `getReviewers` (`:402-406`);
  - writes for merge, rebase, create and update MR.

  There are no discussions, no positions, no `diff_refs` and no `versions`, and nothing
  approves, posts a draft note or resolves.
- **Notes as unread counts:** `forge/notes.ts` (`ForgeNote`, `ForgeNoteAuthor`) and the
  `latestNoteAt`/`lastReadAt` markers on `MergeRequest`
  (`packages/shared/src/mergeRequest.ts`) feed today's "new comment" signal on your own
  PRs/MRs. They count notes; they do not place them on lines.
- **Composer Markdown:** `github/githubComment.ts` turns composer mentions into `@login`.
- **Token scopes as the app documents them today:** GitHub needs `repo` (or `public_repo`)
  (`apps/client/src/renderer/src/Settings.tsx:1679`). GitLab "needs the read_api scope"
  (`Settings.tsx:1467`), but the GitLab client already **writes** (merge, rebase, create MR),
  which `read_api` does not allow. F18's writes make that hint wrong for everyone, so it gets
  fixed here.
- **From F15 and F16:** subjects (`gh-<repoId>-<n>`, `gl-<repoId>-<n>`), `review_drafts` with
  `diffId`, side, line, optional range start and excerpt, `excerptFor`/`markOutdated`,
  `parseHunks`, the `local-ref` and `forge-api` sources, and the queue service. F16 adds AI
  drafts with `acceptedAt` and structured `suggestion`.
- **No inbox for non-task events:** `AttentionItem` is task-scoped
  (`packages/shared/src/attention.ts:76`). T4's inbox does not exist yet.

## Design

### Data model & contracts

A new `packages/shared/src/forgeReview.ts`:

- `ForgeThread { id, subjectId, provider, forgeThreadId (GitHub review-thread node id / GitLab discussion id), path | null, anchor: ForgeAnchor | null, resolved, outdated, comments: ForgeThreadComment[] }`.
- `ForgeAnchor { commitSha, baseSha?, startSha?, side: 'old' | 'new', line, start?: { side, line } }`,
  in the forge's own coordinates.
- `ForgeThreadComment { forgeCommentId, author: ForgeNoteAuthor, body, createdAt, mine }`.
- `PublishVerdict = 'comment' | 'approve' | 'request-changes'`.
- `PublishPlan { subjectId, diffId, headSha, verdict, body, items: Array<{ draftId, placement: 'inline' | 'file' | 'general', reason?: string }> }`.
- `PublishResult = { status: 'published'; forgeReviewId; url; posted: number } | { status: 'refused'; reason: PublishRefusal; detail?: string } | { status: 'partial'; … }`.
  `partial` exists only for GitLab, where publishing is several calls (see below).
- `review_drafts` gains `publishedAt`, `forgeCommentId` and `publishId`.

Pure functions:

- **`mapForgeAnchor(thread, summary, files)`** places a forge thread on our diff.
  - It places it at the anchor's `side`/`line` only when the thread's `commitSha` equals our
    `headSha`, and (GitLab) its `baseSha` equals our `baseSha`.
  - GitHub also reports a thread's *current* `line` (null when outdated) beside
    `originalLine`. A non-null current line is placed directly.
  - Anything else is `outdated` and listed under the file, in the "Earlier conversation"
    group, with its quoted diff hunk. It is never guessed onto a line.
- **`classifyDraft(draft, forgeFile)`** decides where a draft can go on the forge:
  - `inline` when its whole range sits inside one of the forge's own hunks for that file;
  - `file` when the file is in the forge diff but the range is not (an expanded-context
    line, or a far-away AI finding);
  - `general` when the file is not in the forge diff at all;
  - always `general` for an outdated draft, with its excerpt quoted.

  GitHub accepts file-level comments (`subject_type: 'file'`). GitLab has none, so a
  `file` draft on GitLab is folded into the review body as a quoted location.
- **`formatForgeComment(draft, provider)`** produces the body.
  - A suggestion becomes ```` ```suggestion ```` (GitHub) or ```` ```suggestion:-0+0 ````
    sized to the range (GitLab).
  - A `file`/`general` placement prefixes `` `path:line` `` and the fenced excerpt (the same
    location format as `formatReviewMessage`).
- **`buildPublishBody(verdict, note, foldedItems)`** builds the review summary, plus a hidden
  marker `<!-- tm-review:<publishId> -->` that makes publishing idempotent (see the engine).

### Engine / desktop main process

**Pulling threads** (`apps/client/src/main/review/forgeThreads.ts`):

- **GitHub:** GraphQL `pullRequest.reviewThreads(first: 100)` with `id`, `isResolved`,
  `isOutdated`, `path`, `line`, `originalLine`, `startLine`, `diffSide`, `startDiffSide` and
  comments (`databaseId`, `author.login`, `body`, `createdAt`, `commit.oid`). REST cannot read
  `isResolved`, and resolving needs the thread's node id, so GraphQL is the only complete
  answer. Pages are followed to a cap of 5 × 100 threads. Conversation-tab comments come
  from the existing `/issues/{n}/comments` read and are shown as general threads.
- **GitLab:** `GET /projects/:id/merge_requests/:iid/discussions`. A note's
  `position { base_sha, start_sha, head_sha, old_path, new_path, old_line, new_line, line_range }`,
  `resolvable` and `resolved` map onto `ForgeThread`. Non-diff discussions become general
  threads. System notes are dropped, as `listNotes` already does.

Threads are cached in a `forge_review_threads` table (subject, thread JSON, `syncedAt`), so the
workspace opens instantly, the web reads them through the relay, and new replies can be
detected (see events). They are refreshed when the subject opens, after every publish, reply
or resolve, and on the F15 queue cadence for subjects in a queue.

**Line mapping, the rule that matters.** Our diff and the forge's are compared **per publish,
never assumed**.

- With the `local-ref` source, our diff is `mergeBase(base tip, head)..head`, which is
  GitHub's PR diff. GitLab's diff belongs to an MR **version** (`diff_refs`: `base_sha`,
  `start_sha`, `head_sha`), and its `base_sha` can lag the target branch until the next push.
- So before publishing, the desktop:
  1. loads the forge's own hunks for each file that has a draft:
     - GitHub `/pulls/{n}/files`;
     - GitLab `GET …/versions`, then `GET …/versions/:id` for the version whose `head_sha`
       is our `headSha`;
  2. runs `classifyDraft` against those hunks;
  3. anchors every inline comment with the forge's coordinates for that same version.

  On GitHub this is `commit_id = headSha`, `line`/`side` (`old` → `LEFT`, `new` → `RIGHT`),
  plus `start_line`/`start_side` for a range. GitHub requires both ends of a range in one
  hunk; otherwise the draft becomes `file`. On GitLab it is
  `position { position_type: 'text', base_sha, start_sha, head_sha, old_path, new_path, old_line?, new_line? }`.
  A context line carries both numbers, an added line only `new_line`, and a removed line
  only `old_line`. A range adds `line_range { start, end }` with GitLab's
  `<sha1(path)>_<old>_<new>` line codes.
- If **no forge version matches our head** (the author pushed since you loaded it), publish
  is refused as `head-moved`. The workspace reloads (F6's `stale` → `markOutdated`) and the
  human re-checks. Nothing is posted against a commit the human did not read.

**Publishing one review.**

- **GitHub:** one `POST /repos/{o}/{r}/pulls/{n}/reviews` with `commit_id`, `event`
  (`COMMENT`/`APPROVE`/`REQUEST_CHANGES`), `body` and `comments[]`, inline and file-level.
  It is a single atomic call.
- **GitLab:** a review is a set of **draft notes** published together:
  1. `POST …/draft_notes` per item;
  2. `POST …/draft_notes/bulk_publish`;
  3. then, for Approve, `POST …/approve` with `sha = headSha`, so GitLab refuses if the head
     moved.

  If a draft note fails to create, the ones already created are deleted
  (`DELETE …/draft_notes/:id`) and nothing is published. If `bulk_publish` succeeds but
  `approve` fails, the result is `partial` and names exactly that: "comments posted;
  approval refused: <reason>".
- **Request changes on GitLab:** newer GitLab sets a reviewer state; older instances have no
  such state. The client probes once per instance (see open questions). Without it, the
  review is published with "Changes requested" at the top of its body, and `unapprove` is
  called if you had approved. The dialog says which of the two happened.
- **Refusals as data, before any network write:**
  - `nothing-to-publish`: no accepted drafts and an empty body, for a Comment;
  - `own-pr-verdict`: GitHub rejects Approve/Request changes on your own PR, so those two
    are disabled up front, and only Comment is offered;
  - `head-moved`;
  - `pending-review-exists`: GitHub allows one pending review per user, and one started on
    github.com blocks ours. The refusal says so and links to it;
  - `missing-scope` (see tokens);
  - `forge-api-unavailable`.
- **Idempotent.** `publishId` is minted and stored on the drafts **in the same transaction that
  starts the publish**, so a double click publishes once. If the response is lost
  (timeout), a retry first lists the PR's reviews or notes for the `tm-review:<publishId>`
  marker and adopts the review it finds instead of posting a second one. On success the
  drafts get `publishedAt` and `forgeCommentId`, and render as threads from then on.
- **Unaccepted AI drafts are never published.** The plan only collects human drafts and
  accepted AI drafts. A published comment carries no automatic "AI" marker: once the human
  has accepted or edited it, it is theirs (see open questions).
- **Agent card subjects with a PR/MR.** The workspace offers both destinations: *Send to
  agent* (F6) and *Publish to PR*. A draft goes to one of them; a draft that has been sent is
  not offered for publishing again, and vice versa.

**Replies and resolve:**

- **GitHub:** reply with `POST /repos/{o}/{r}/pulls/{n}/comments/{commentId}/replies`;
  resolve and unresolve with GraphQL `resolveReviewThread` / `unresolveReviewThread`
  (thread node id).
- **GitLab:** reply with `POST …/discussions/:id/notes`; resolve with
  `PUT …/discussions/:id?resolved=true|false`.

Replies are sent immediately. They are not drafts, because a reply is a conversation, not part
of a review. A refusal comes back as data.

**Tokens and scopes.**

- **GitHub classic:** `repo` (`public_repo` for public only). Already required.
- **GitHub fine-grained:** *Pull requests: read and write* and *Contents: read*. An
  SSO-enforced org additionally needs the token authorised for SSO; its 403 body says so,
  and the refusal quotes it.
- **GitLab:** `api` for any write, which includes F18 and today's merge and rebase.
  `read_api` + `read_repository` are enough to read.

Test connection reports the scopes it can see:

- classic GitHub tokens return `X-OAuth-Scopes`;
- GitLab answers `GET /personal_access_tokens/self` (15.5+) with `scopes`;
- fine-grained GitHub tokens expose nothing, so their first write's 403 is mapped to
  `missing-scope`.

The Settings hints are corrected (the GitLab one moves from `read_api` to `api`).

**Events (the inbox seam).** A pure `reviewEventsBetween(prevQueues, nextQueues, prevThreads, nextThreads, me)`
yields:

- `review-requested`: a subject newly in *Requested from me*;
- `review-submitted`: a new review on one of *my* PRs;
- `thread-reply`: a new comment by someone else in a thread I started or replied to;
- `thread-resolved`.

They are appended to a `review_events` table, deduplicated by forge ids. In v1 the only
consumer is the unread dot and count on the Reviews entry, cleared when the subject is
opened. F22 (T4 inbox) reads this table as a source, and F23's push sends from it once the
server relays it. F18 writes nothing for them except the table and a `review:events:changed`
event.

### Server & relay

- No server endpoints. The new channels are `review:threads`, `review:refreshThreads`,
  `review:publishPlan` (dry run: placements and refusals), `review:publish`, `review:reply`,
  `review:resolve`, `review:events` and `review:markEventsSeen`, plus the
  `review:threads:changed` and `review:events:changed` events, all classified `relay`.
  Tokens never leave the desktop. The web publishes through the desktop, as every other
  forge write already works.
- A thread answer is capped at 500 threads and at `RESULTS_BYTES_LIMIT`. Over that, the oldest
  resolved threads are summarised as a count.

### UI — desktop

- **Threads inline** in F15's diff, under their line in either layout. Each shows the author
  avatar, a relative time, the body rendered as Markdown (suggestion blocks shown as a
  mini-diff), and **Reply** and **Resolve**/**Unresolve**. Resolved threads are collapsed to
  one line. Outdated threads sit in an "Earlier conversation" group at the top of their file.
  General threads sit in a group above the file list.
- **The publish bar** replaces F15's *Copy review as Markdown* on PR subjects. *Publish
  review…* opens a dialog with:
  - the verdict (Comment / Approve / Request changes, with the disabled ones explained);
  - the summary note;
  - the `publishPlan` items: how many go inline, how many become file-level, and how many
    are folded into the body, each with its reason;
  - the target ("as @you on owner/repo#12").

  Confirming publishes. The result states what happened, including GitLab's `partial`.
- Your published comments appear as threads with a "published" stamp, the same way F6 stamps
  "sent".
- The Reviews entry carries an unread dot for new `review_events`. Colour is used only when
  something is waiting on you (memory *board-colour-budget*).

### UI — web

- The same workspace and dialogs through the shared components. The web adds no states of its
  own beyond F15's (unreachable, stale, oversized). A publish refused because the desktop is
  unreachable keeps the drafts and says so.

### Failure modes & edge cases

- **The forge rejects one comment** (GitHub 422 "line could not be resolved"): the whole
  review fails atomically on GitHub. The refusal names the draft, which is re-classified as
  `file`, and the human publishes again. On GitLab, the rollback path deletes the created
  draft notes.
- **The author force-pushed:** old threads become `outdated`, and drafts are re-checked by
  `markOutdated`. Publishing is refused until the human reloads.
- **A rename:** a draft on the old side of a renamed file uses `old_path`. A GitLab position
  carries both paths.
- **A very long thread list:** cap and summary, as above.
- **Rate limits:** a publish is never retried automatically except through the marker check.
  Thread refresh backs off on 403/429 and shows "as of".
- **A token whose user lost access to the repo:** `missing-scope` or `forbidden` with the forge's
  text. Drafts are never lost.
- **A self-hosted GitLab without draft notes** (very old): the fallback posts discussions one by
  one. It is labelled as not atomic, and the dialog asks before doing it.

## Out of scope (v1)

- Posting the AI verdict as a PR comment, and approving with a separate bot token (F17).
- Editing or deleting comments already published.
- Reactions and emoji.
- Suggestion "apply" from inside the app.
- Pushing events to a phone or email (F22/F23 consume `review_events`).
- Syncing GitHub's per-file "viewed" flag.

## Open questions

- **Mark published comments that started as AI findings?** Recommended default: no automatic
  marker; once accepted, the comment is the human's. A per-user setting can add a short
  "(AI-assisted)" suffix for teams that want it.
- **GitLab "Request changes" on instances that support a reviewer state?** Recommended default:
  probe once per instance and use it when present. Otherwise fall back to the body heading
  plus `unapprove`, and say which happened. Verify the exact endpoint against a current
  GitLab before F18.7 starts. This plan does not take its shape on trust.
- **GitLab range comments need `line_range` line codes:** recommended default: compute them
  as `<sha1(path)>_<old>_<new>` and check against a real instance in F18.7's test before
  relying on them. Fall back to single-line anchors on the range end if the instance rejects
  them.
- **Replies as drafts, too?** Recommended default: no. Replies post immediately; only the
  review is batched.
- **Event retention?** Recommended default: keep 90 days of `review_events`, pruned at boot.

## Tasks

### F18 · Phase 1 — Contracts and mapping

- [ ] F18.1 Define forge thread, anchor and publish contracts in packages/shared/src/forgeReview.ts

  - Add `ForgeThread`, `ForgeAnchor`, `ForgeThreadComment`, `PublishVerdict`, `PublishPlan`,
    `PublishResult` and the refusal union, plus `publishedAt`/`forgeCommentId`/`publishId` on
    the draft type.
  - Acceptance: `pnpm typecheck` green; a test that the thread answer cap stays under
    `RESULTS_BYTES_LIMIT` for 500 maximal threads.

- [ ] F18.2 Implement mapForgeAnchor and classifyDraft @needs: F18.1 Define forge thread, anchor and publish contracts in packages/shared/src/forgeReview.ts

  - Pure functions: place forge threads on our diff (same head, or GitHub's current `line`;
    otherwise outdated), and classify drafts as inline, file or general against the forge's
    own hunks, including ranges that cross hunks and renamed old-side anchors.
  - Acceptance: table tests for each rule, including a GitLab version whose `base_sha` lags
    ours (no direct placement), an expanded-context draft (`file`), a draft on a file absent
    from the forge diff (`general`), and an outdated draft (`general` with excerpt).

- [ ] F18.3 Implement formatForgeComment and buildPublishBody with the idempotency marker @needs: F18.1 Define forge thread, anchor and publish contracts in packages/shared/src/forgeReview.ts

  - Per-forge suggestion blocks sized to the range, the location prefix for folded items, the
    summary body, and the hidden `tm-review:<publishId>` marker.
  - Acceptance: snapshot tests for both forges, a suggestion containing backticks (fence
    lengthened as in `formatReviewMessage`), and a GitLab `file` draft folded into the body.

### F18 · Phase 2 — Forge clients

- [ ] F18.4 Add review-thread and version reads to the GitHub and GitLab clients

  - GitHub: a GraphQL `listReviewThreads` (paged, capped).
  - GitLab:
    - `listDiscussions`;
    - `listVersions`, and `getVersion` with its diffs;
    - `diff_refs` on the MR detail;
    - `getTokenScopes` (`/personal_access_tokens/self`).

    Read `X-OAuth-Scopes` on GitHub responses.
  - Acceptance: client tests with recorded responses for paging, outdated threads,
    non-diff discussions, and a GitLab instance that 404s the scopes endpoint (scopes
    unknown, not an error).

- [ ] F18.5 Add review publishing, replies and resolve to the GitHub client @needs: F18.3 Implement formatForgeComment and buildPublishBody with the idempotency marker

  - `createReview` (one call, inline and file-level comments), `replyToReviewComment`,
    `resolveReviewThread`/`unresolveReviewThread` (GraphQL), and error mapping for 422
    (unresolvable line, own-PR verdict, pending review) and SSO 403.
  - Acceptance: client tests asserting the exact request bodies (sides, ranges,
    `commit_id`) and every error mapping.

- [ ] F18.6 Add draft notes, bulk publish, approve and resolve to the GitLab client @needs: F18.3 Implement formatForgeComment and buildPublishBody with the idempotency marker

  - Add:
    - `createDraftNote` (with `position` and `line_range`), `deleteDraftNote` and
      `bulkPublishDraftNotes`;
    - `approve(sha)` and `unapprove`;
    - `replyToDiscussion` and `resolveDiscussion`;
    - the reviewer-state probe for Request changes;
    - the discussion-by-discussion fallback for instances without draft notes.
  - Acceptance: client tests for the request bodies, including context, added and removed
    line positions; rollback deletes on a failed draft note; `approve` with a stale `sha`
    mapped to `head-moved`.

### F18 · Phase 3 — Engine

- [ ] F18.7 Build the forge thread service with the forge_review_threads cache @needs: F18.4 Add review-thread and version reads to the GitHub and GitLab clients, F18.2 Implement mapForgeAnchor and classifyDraft

  - Add `apps/client/src/main/review/forgeThreads.ts` and a store migration for
    `forge_review_threads`. The service refreshes on open, after writes and on the queue
    cadence, maps threads with `mapForgeAnchor`, and keeps the cache on failure.
  - Verify GitLab `line_range` line codes and the Request-changes endpoint against a real
    instance here, and record the result in this file.
  - Acceptance: service tests with fake clients; the migration is verified with the
    drop-column + electron-as-node recipe (memory *the-store-has-no-tests*).

- [ ] F18.8 Build the publish preflight that places every draft @needs: F18.7 Build the forge thread service with the forge_review_threads cache

  - `review:publishPlan`:
    1. fetch the forge's hunks for the version matching our head;
    2. classify accepted drafts;
    3. compute the refusals (own-PR verdict, head moved, missing scope, nothing to publish).

    Unaccepted AI drafts are excluded.
  - Acceptance: tests that an unaccepted AI draft never appears in a plan, that the plan for a
    moved head is a `head-moved` refusal, and that the own-PR case offers Comment only.

- [ ] F18.9 Implement review:publish as one idempotent forge review @needs: F18.8 Build the publish preflight that places every draft, F18.5 Add review publishing, replies and resolve to the GitHub client, F18.6 Add draft notes, bulk publish, approve and resolve to the GitLab client

  - Mint and store `publishId` in the starting transaction, publish per forge, adopt an
    existing review found by marker on retry, stamp the drafts, and refresh the threads.
    GitLab's `partial` result names what failed.
  - Acceptance: tests for a double click (one review), a lost response then retry (adopted,
    not duplicated), GitHub 422 on one comment (nothing posted, draft re-classified),
    GitLab approve failing after publish (`partial`), and drafts that stay drafts on every
    refusal.

- [ ] F18.10 Add the reply and resolve channels @needs: F18.7 Build the forge thread service with the forge_review_threads cache, F18.5 Add review publishing, replies and resolve to the GitHub client, F18.6 Add draft notes, bulk publish, approve and resolve to the GitLab client

  - Add `review:reply` and `review:resolve`, with refusals as data and a thread refresh after
    each.
  - Acceptance: handler tests for both forges, including resolve on a thread that is not
    resolvable (refused) and a reply to a thread deleted upstream.

- [ ] F18.11 Emit review events into review_events for the inbox seam @needs: F18.7 Build the forge thread service with the forge_review_threads cache

  - Add the pure `reviewEventsBetween`, the `review_events` table (deduplicated by forge ids,
    90-day prune), `review:events`, `review:markEventsSeen` and `review:events:changed`. They
    are fed from the F15 queue refresh and the thread refresh.
  - Acceptance: tests that a first sync after install emits nothing (no flood), that a new
    review request emits once across two refreshes, that my own reply is not an event, and
    that a truncated queue answer emits no removals.

- [ ] F18.12 Name the required token scopes in Settings and Test connection @needs: F18.4 Add review-thread and version reads to the GitHub and GitLab clients

  - Correct the Settings hints (GitLab `api` for writes; GitHub fine-grained permissions), have
    Test connection list the scopes it can see and the ones missing for review publishing, and
    map a fine-grained 403 to `missing-scope`.
  - Acceptance: tests for scope parsing on both forges and for the hint text per token kind;
    `pnpm build` green.

- [ ] F18.13 Classify the new channels for the relay @needs: F18.9 Implement review:publish as one idempotent forge review, F18.10 Add the reply and resolve channels, F18.11 Emit review events into review_events for the inbox seam

  - Register `review:threads`, `review:refreshThreads`, `review:publishPlan`,
    `review:publish`, `review:reply`, `review:resolve`, `review:events` and
    `review:markEventsSeen`, with their events, as `relay`. Cap the thread answer.
  - Acceptance: `test/ipc-relay-coverage.test.ts` green; an `httpTransport` test that publish
    is relayed, not refused; `pnpm typecheck`, `pnpm test` and `pnpm build` green.

### F18 · Phase 4 — UI and verification

- [ ] F18.14 Draw forge threads inline and add the publish dialog to the workspace @needs: F18.13 Classify the new channels for the relay

  - Add threads under their lines in both layouts, with Reply, Resolve and the collapsed
    resolved state; the "Earlier conversation" and general groups; the publish dialog with
    verdict, note, placement summary and target; published stamps; the unread dot on Reviews;
    and the two destinations (agent / PR) on agent cards that have a PR.
  - Acceptance: `reviewState` tests for the thread and publish transitions; a headless render
    of a subject with inline, outdated and general threads in light and dark; tokens only.

- [ ] F18.15 Write verify-forge-review.mjs against a fake forge and document the round-trip @needs: F18.14 Draw forge threads inline and add the publish dialog to the workspace

  - A scenario with a local fake GitHub and GitLab HTTP server (recording request bodies) and a
    temp bare repo for `local-ref`. It covers: pull threads, publish a mixed review (inline,
    file and folded), retry after a dropped response (one review), reply, resolve, and a
    review-request event. Add a "Publishing a review" section, with the scope table, to
    `docs/03-how-orchestration-works.md`.
  - Acceptance: prove the script can fail by mutation (memory
    *headless-scenario-harness-traps*); all three gates green, run with `--force` (memory
    *a-cached-gate-is-not-a-gate*).
