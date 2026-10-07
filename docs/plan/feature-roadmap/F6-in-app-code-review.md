# F6 — In-app code review

> **Status:** proposed · **Where:** client (desktop main + `packages/ui`), web (through the relay) · **Depends on:** nothing · **Unlocks:** F3 (mobile review cockpit), Variants (comparing diffs)
> Only the `- [ ]` checkboxes under **Tasks** become cards when this file is imported as a plan; everything else is context.

## Why

Today the only way to read what an agent wrote is to leave the app: open the MR/PR on
GitLab/GitHub, or open the worktree in an editor. A card with no forge behind it (a local repo, a
card that has not pushed yet) has no diff anywhere. And the feedback loop is broken. A note left on
GitHub never reaches the agent; the human retypes it into the card's chat, without the line it was
about.

F6 puts the diff on the card. You read it, comment on lines, and send every comment back to the
agent as **one** review message. That message carries the path, the line numbers and the quoted
code, so the agent knows exactly what each note refers to.

## What we have today

- Worktrees per card: `apps/client/src/main/worktreeManager.ts` (`prepare`, `integrate`,
  `cleanup`, `inspect`, `taskBranch(taskId)`).
- Git helpers in `apps/client/src/main/git.ts`, all running through `ExecHost` (so they already
  work for the WSL execution target): `changedInBranch` (names only, `base..branch`),
  `addedInBranch`, `commitsAhead`, `blobSha`, `workingFileSha`, `listUntracked`. **There is no
  patch reader.** Nothing returns hunks.
- The base-branch setting per project (`BaseBranchField.tsx`). See memory
  *merge-only-moves-the-checked-out-branch*.
- Forge links: `apps/client/src/main/forge/*`, `describeMergeRequest.ts`, `describePullRequest.ts`,
  `packages/ui/src/MergeRequests.tsx`. These link out; they do not render diffs.
- Talking to a card's agent: `'task:chat'` (`packages/shared/src/ipc.ts:703`), which returns
  `ChatSendResult` with refusals as data. A chat reply on a settled card settles like a work run
  (memory *a-merged-card-merges-again*).
- The card pane: `packages/ui/src/TaskDetail.tsx` (≈1,200 lines). The web renders the same
  component (`apps/web/src/board/BoardScreen.tsx` imports `@tm/ui/TaskDetail`). See memory
  *web-mirrors-the-desktop*.
- Relay classification: `packages/shared/src/ipcRelay.ts` is exhaustive over `keyof IpcApi`, so
  a new channel fails typecheck until it is classified. Coverage test:
  `test/ipc-relay-coverage.test.ts`.
- Payload caps: `RESULTS_BYTES_LIMIT = 1_000_000` (`apps/client/src/main/cloudResults.ts`),
  `SYNC_BYTES_LIMIT = 1_000_000` (`cloudDelta.ts`), server `DEFAULT_BODY_LIMIT = '8mb'`
  (`apps/server/src/config/bodyLimit.ts`). An oversized relayed answer is replaced by an error,
  not carried forever. Memory *one-answer-wedges-the-mirror* records the day an uncapped body
  wedged the mirror.
- No diff renderer exists anywhere in `packages/ui`, `apps/client/src/renderer` or `apps/web`.
- UI kit: Fluent UI v9 with Griffel `makeStyles` (`packages/ui/src/theme.ts`). There is no DOM
  test harness. UI logic is tested as pure state machines (`packages/ui/src/taskTimeline.ts`,
  `taskChat.ts`).

## Design

### Data model & contracts

A new module, `packages/shared/src/review.ts`, holds the pure types and functions:

- `DiffSummary { diffId, baseRef, baseSha, headSha, includesWorkingTree, files: DiffFileEntry[], truncated }`
- `DiffFileEntry { path, oldPath?, status: 'added'|'modified'|'deleted'|'renamed'|'copied', additions, deletions, binary, image: boolean, bytes }`
- `DiffFile { diffId, path, hunks: DiffHunk[], tooLarge?: { bytes } }`
- `DiffHunk { oldStart, oldLines, newStart, newLines, header, lines: DiffLine[] }`
- `DiffLine { kind: 'context'|'add'|'del', text, oldLine?, newLine?, noNewlineAtEof? }`
- `ReviewComment { id, taskId, diffId, path, oldPath?, side: 'old'|'new', line, start?: { side, line }, body, excerpt, createdAt, updatedAt, sentAt: string|null }`

**`diffId`** is a short hash of `(baseSha, headSha, working-tree status fingerprint)`. Every file
read names the `diffId` it belongs to and is refused with `stale` when the worktree has moved on.
That way a comment is always anchored to a revision the human actually saw.

Pure functions in the same module:

- `parsePatch(text) → DiffHunk[]`, which handles renames, `\ No newline at end of file`, binary
  markers and empty files.
- `wordDiff(oldText, newText) → Segment[]`, a token-level LCS bounded by line length. Above a
  cap, a line is marked "whole line changed".
- `formatReviewMessage(comments, summary) → string`, which builds the one batched follow-up (see
  the engine section).
- `markOutdated(comments, file) → comments`. A comment is *outdated* when its anchor line no
  longer exists in the new revision or its text no longer matches the excerpt.

Comments are **drafts until sent**. They are data on the card, stored on the desktop.

### Engine / desktop main process

- **Where the diff is computed:** on the desktop, against the card's worktree when it exists,
  otherwise against the task branch in the project repo. The three-dot form,
  `git diff <base>...<branch>`, compares from the merge base, so the human reviews only what the
  agent changed and not what landed on base meanwhile. **Uncommitted changes in the worktree are
  included** (`git diff <mergeBase>` against the working tree, plus untracked files from
  `listUntracked`), because an agent often stops before committing. `includesWorkingTree` says so
  in the UI.
- New git helpers in `git.ts`: `mergeBase`, `diffNameStatus` (`-z --name-status -M` with
  `--numstat`), `diffFilePatch(path)` (`--no-color --no-ext-diff -U3`), and `showBlob(ref, path)`
  for images. They all go through `ExecHost`, as the existing helpers do.
- New `apps/client/src/main/review/diffService.ts`. It resolves `task → project → base branch →
  worktree/branch`, computes the `diffId`, applies the caps, and returns the IPC answers.
- **Caps**, all well under `RESULTS_BYTES_LIMIT`:
  - the summary lists at most 1,000 files (`truncated: true` beyond that);
  - one file's patch is at most 256 kB of text, otherwise `tooLarge` and no hunks;
  - an image is at most 512 kB per side, base64, otherwise "too large to preview";
  - lock files and generated files above 2,000 changed lines are collapsed by default. They are
    still readable on demand, under the same per-file cap.
- **Comment store:** a new SQLite table `review_comments`, added by a store migration. Memory
  *the-store-has-no-tests* has the drop-column + electron-as-node recipe that verifies it.
- **Sending:** `review:send(taskId)` collects the unsent comments plus an optional overall note
  and builds one message with `formatReviewMessage`. The message gives each comment as
  ``path:line[-line]`` with the fenced excerpt and the note, plus a header line naming the
  `diffId`/head SHA it was written against. It is delivered through the same path as
  `'task:chat'`, so it inherits that path's refusals and its settle behaviour. On success the
  comments get `sentAt`; on a refusal they stay drafts and the refusal is returned as data.
- Sending a review **never moves the card**. The run borrows `status` the way every run does
  (memory *card-state-is-the-humans*).
- After merge the worktree and often the branch are gone (memory
  *a-step-added-after-the-merge*). The summary then returns `{ landed: true, forgeUrl? }`
  instead of an empty diff. "Nothing changed" and "this already landed" must read differently
  (memory *a-merge-is-invisible*).

### Server & relay

- **No new server endpoints.** The new channels are relayed IPC, like every other read the web
  makes.
- New IPC channels: `task:diffSummary`, `task:diffFile`, `task:diffImage`, `review:list`,
  `review:add`, `review:update`, `review:delete` and `review:send`. All are classified `relay` in
  `packages/shared/src/ipcRelay.ts`; typecheck enforces the classification.
- The per-file caps keep each relayed answer bounded. Because a web client fetches **one file at
  a time** (lazily, as each file expands), a browser opening a large review cannot build a
  multi-megabyte tick. The memory *one-answer-wedges-the-mirror* case is closed by design, not by
  luck.
- Comments are **not** mirrored into server tables in v1. The desktop owns them, and the web
  reads and writes them through the relay. When the desktop is unreachable, the web shows the
  existing unreachable banner and does not keep a separate draft copy, so there is never a second
  copy to reconcile.

### UI — desktop

- A new **Changes** section in `TaskDetail`. It is built as its own module tree in
  `packages/ui/src/review/` (so `TaskDetail.tsx` only mounts it): `ReviewPane.tsx`,
  `FileTree.tsx`, `DiffView.tsx`, `CommentThread.tsx`, and the pure `reviewState.ts`.
- Header: the base and head refs, an "includes uncommitted changes" note when it applies, file
  and line totals, an unsent-comment count, and **Send review** (enabled only when there is at
  least one draft).
- File tree: a Fluent `Tree` grouped by directory. Each file shows a status letter and +/−
  counts, and generated or oversized files carry a "collapsed" marker. Selecting a file scrolls
  to it.
- Diff: a unified view, monospace, with old and new line-number gutters and word-level
  highlights inside changed lines. Images are shown before/after, side by side. A per-file "load
  anyway" applies only up to the cap; beyond it the file reads "too large to show — open in
  editor".
- Comments:
  - Hovering a line shows a "+" in the gutter; pressing it opens an inline editor.
  - Shift-click selects a range.
  - A comment can be edited or deleted until it is sent.
  - Sent comments render read-only with a "sent" stamp.
  - An outdated comment is dimmed with an "outdated" label but can still be sent; its excerpt
    tells the agent what it was about.
  - Ctrl/Cmd+Enter saves.
- Colour: green and red backgrounds on added and removed lines are *content*. They use Fluent
  palette tokens at their subtlest step, and the pane adds no other colour (memory
  *board-colour-budget*).
- The card's attention/badge row gains nothing. The unsent-comment count lives only in the pane
  header, because it is the human's own draft and not something waiting on them.

### UI — web

- The same `ReviewPane` renders in `apps/web` through the shared `TaskDetail` (memory
  *web-mirrors-the-desktop*). Every read and write goes over the relay, so the web needs no
  separate implementation.
- States the web must draw, and the desktop never sees:
  - the desktop is unreachable (the existing banner, with the pane read-only and showing what
    was last loaded);
  - a stale `diffId` ("the agent changed the files since you opened this — reload");
  - an oversized answer error from `cloudResults` ("this file is too large to send to the
    browser").
- Mobile layout is **not** part of F6. F3 adapts this pane for phones.

### Failure modes & edge cases

- **The worktree is mid-rebase or has conflicts** (memories *a-worktree-stranded-mid-rebase*,
  *a-paused-rebase-nobody-owns*): the summary reports `conflicted` with the conflicted file
  list, the diff is not drawn, and comments are disabled. Conflict handling stays with the
  existing flow.
- **The base ref is missing** or the branch was never created: an explicit empty state ("this
  card has not produced a branch yet"), never a git error.
- **The agent edits while you comment:** the next file read returns `stale`. The pane offers a
  reload. After the reload, drafts are recomputed with `markOutdated` and kept.
- **Binary files that are not images:** the file is listed with its size and no diff.
- **CRLF or mixed line endings:** normalised before `wordDiff` so whole lines do not light up.
- **Huge single lines** (minified files): `wordDiff` caps the token count and falls back to
  whole-line change.
- **WSL execution target:** every git call goes through `ExecHost`. Paths in answers are repo
  relative, never host paths.
- **The same comment sent twice:** `review:send` sets `sentAt` in the same transaction that
  hands the message to the chat path, so a double click sends one review.

## Out of scope (v1)

- Split (side-by-side) diff view. Unified only; it is the one that also works on a phone.
- In-app staging or committing, and a repo-wide git browser (branches, commits, changes outside any card).
- Posting comments to GitHub or GitLab as PR/MR review comments.
- Syntax highlighting. Plain monospace with word-level highlights first; highlighting is a
  later, separate card.
- Server-side storage of comments, or editing comments while the desktop is offline.
- Comparing two runs' diffs (that is Variants).

## Open questions

- **Include uncommitted worktree changes?** Recommended: **yes**, labelled. Hiding them would
  show "no changes" for an agent that simply has not committed yet.
- **Should Send review also move the card or restart a stopped chain?** Recommended: **no**. It
  is a chat message with structure; the card's state stays the human's.
- **Should the review message include unchanged context lines around each comment?**
  Recommended: only the commented lines as the excerpt, plus the path and line numbers. The
  agent has the files.
- **Comment retention after the card is done:** recommended: keep them (sent ones are history),
  and delete them with the card.

## Tasks

### F6 · Phase 1 — Diff contract and pure parsing

- [ ] F6.1 Define the review contract types in packages/shared/src/review.ts

  - Add `DiffSummary`, `DiffFileEntry`, `DiffFile`, `DiffHunk`, `DiffLine`, `ReviewComment`, the `stale`/`landed`/`conflicted` result variants, and the cap constants (`DIFF_FILE_MAX_BYTES = 256_000`, `DIFF_IMAGE_MAX_BYTES = 512_000`, `DIFF_SUMMARY_MAX_FILES = 1000`, `DIFF_COLLAPSE_LINES = 2000`).
  - Acceptance: `pnpm typecheck` green; a unit test asserts every cap constant is below `RESULTS_BYTES_LIMIT`.
- [ ] F6.2 Implement parsePatch for unified git diffs @needs: F6.1 Define the review contract types in packages/shared/src/review.ts

  - A pure `parsePatch(text)` covering added/deleted/renamed/copied files, multiple hunks, `\ No newline at end of file`, binary markers, empty files and CRLF.
  - Acceptance: table-driven tests in `review.test.ts` with real `git diff` fixtures; line numbers on both sides are correct for every fixture.
- [ ] F6.3 Implement bounded wordDiff for changed lines @needs: F6.1 Define the review contract types in packages/shared/src/review.ts

  - A pure token-level diff for a removed/added line pair, with a token cap that falls back to whole-line change, and whitespace/CRLF normalisation.
  - Acceptance: tests for single-word edits, reordered tokens, a 20 kB minified line (falls back, stays under 5 ms), and identical lines.
- [ ] F6.4 Implement formatReviewMessage and markOutdated @needs: F6.1 Define the review contract types in packages/shared/src/review.ts

  - Build the one batched follow-up (header with the head SHA, then per comment `path:line[-line]`, the fenced excerpt and the note, plus an optional overall note). Write `markOutdated` against a new `DiffFile`.
  - Acceptance: snapshot tests of the message for single comments, ranges, renamed-file old-side comments and outdated comments; `markOutdated` tests for moved, deleted and edited anchor lines.

### F6 · Phase 2 — Reading diffs on the desktop

- [ ] F6.5 Add patch-reading git helpers to git.ts @needs: F6.2 Implement parsePatch for unified git diffs

  - Add `mergeBase`, `diffNameStatus` (name-status + numstat, `-z`, `-M`), `diffFilePatch`, `showBlob`, and a working-tree variant that includes untracked files. All go through `ExecHost`.
  - Acceptance: an integration test against a temp repo (outside the work tree — memory *headless-scenario-harness-traps*) covering a commit-only diff, uncommitted edits, an untracked file, a rename and an image.
- [ ] F6.6 Build diffService and the task:diffSummary, task:diffFile, task:diffImage channels @needs: F6.5 Add patch-reading git helpers to git.ts, F6.3 Implement bounded wordDiff for changed lines

  - Add `apps/client/src/main/review/diffService.ts`, which resolves worktree or branch, base and `diffId`; applies the caps; and answers `landed`/`conflicted`/`stale`. Register the IPC handlers and classify the channels `relay` in `ipcRelay.ts`.
  - Acceptance: unit tests with a fake git for every result variant and each cap; `test/ipc-relay-coverage.test.ts` passes; `pnpm typecheck`, `pnpm test` and `pnpm build` are green.

### F6 · Phase 3 — Comments and sending them

- [ ] F6.7 Add the review_comments table and store methods @needs: F6.1 Define the review contract types in packages/shared/src/review.ts

  - A store migration plus `listReviewComments`, `addReviewComment`, `updateReviewComment`, `deleteReviewComment` and `markReviewSent`; delete on card delete.
  - Acceptance: the migration is verified with the drop-column + electron-as-node recipe (memory *the-store-has-no-tests*); round-trip tests of the pure row mapping.
- [ ] F6.8 Expose review:list, review:add, review:update, review:delete over IPC with outdated recompute @needs: F6.7 Add the review_comments table and store methods, F6.6 Build diffService and the task:diffSummary, task:diffFile, task:diffImage channels, F6.4 Implement formatReviewMessage and markOutdated

  - Handlers that validate the anchor against the current `diffId`, recompute `outdated` on list, and refuse edits to sent comments. Classify the channels `relay`.
  - Acceptance: handler tests for an add against a stale `diffId`, an edit after send (refused) and the outdated recompute; relay coverage green.
- [ ] F6.9 Implement review:send as one batched follow-up through the chat path @needs: F6.8 Expose review:list, review:add, review:update, review:delete over IPC with outdated recompute

  - Collect the unsent comments plus the note, format them with `formatReviewMessage`, deliver through the same code path as `'task:chat'`, and mark them sent in the same transaction. Refusals come back as data and the comments stay drafts.
  - Acceptance: tests for a running card, a settled card, a refused send (the drafts are kept) and a double send (exactly one message). Verify with a stub `claude` on PATH (memory *stub-claude-on-path*) that the session receives the formatted message.

### F6 · Phase 4 — The desktop review pane

- [ ] F6.10 Write the pure review pane state machine in packages/ui/src/review/reviewState.ts @needs: F6.1 Define the review contract types in packages/shared/src/review.ts

  - Covers the selected file, expanded/collapsed files, per-file load state (idle/loading/loaded/tooLarge/stale), the comment editor (anchor, range, draft text), and stale-diff handling. It follows the `taskTimeline.ts` sequencing pattern, so a late answer for an old `diffId` is a no-op.
  - Acceptance: tests for out-of-order file answers, switching cards mid-load, a stale reload that keeps drafts, and range selection across a gap.
- [ ] F6.11 Build ReviewPane with FileTree and DiffView in packages/ui/src/review @needs: F6.10 Write the pure review pane state machine in packages/ui/src/review/reviewState.ts, F6.6 Build diffService and the task:diffSummary, task:diffFile, task:diffImage channels

  - A Fluent v9 `Tree` file list with status and +/−; a unified diff with line gutters and word highlights; before/after images; collapsed generated files; the header with the refs and the uncommitted note; the empty, landed and conflicted states. Mount it as a **Changes** section in `TaskDetail.tsx`.
  - Acceptance: `pnpm build` green; a headless smoke check (memory *verify-electron-app*, never launch the user's app) renders a seeded card's diff; tokens only, no hard-coded colours.
- [ ] F6.12 Add line and range comments with Send review to the pane @needs: F6.11 Build ReviewPane with FileTree and DiffView in packages/ui/src/review, F6.9 Implement review:send as one batched follow-up through the chat path

  - The gutter "+", shift-click ranges, the inline editor (Ctrl/Cmd+Enter to save), edit/delete, the outdated label, sent stamps, and the unsent count plus **Send review** with an optional overall note in the header.
  - Acceptance: the state-machine tests cover add, edit, delete and send transitions; a stub-CLI scenario shows the comments arriving at the agent and the pane flipping them to sent.

### F6 · Phase 5 — Review from the browser

- [ ] F6.13 Make the review pane work over the relay in apps/web @needs: F6.12 Add line and range comments with Send review to the pane

  - Confirm the shared `TaskDetail` mounts the pane in the web. Draw the unreachable, stale and oversized-answer states. One file is fetched at a time, lazily on expand.
  - Acceptance: `httpTransport` tests that the new channels are relayed (not refused); a test that an oversized relayed answer renders the "too large for the browser" state; web build green.
- [ ] F6.14 Write the F6 end-to-end verification script and user docs @needs: F6.13 Make the review pane work over the relay in apps/web

  - A `scripts/verify-review.mjs` scenario with a temp repo, a card with commits and uncommitted edits, a diff summary, file reads, two comments, send, and an assertion on the stub session's input. Add a "Reviewing changes" section to `docs/03-how-orchestration-works.md`.
  - Acceptance: prove the script can fail by mutation (memory *headless-scenario-harness-traps*); all three gates green, run with `--force` (memory *a-cached-gate-is-not-a-gate*).
