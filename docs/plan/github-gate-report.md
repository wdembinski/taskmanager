# GitHub support — the verification report

Steps 1–8 **built** the integration; step 9 **wrote** the headless harness; step 10 **ran** it
and became §§1–7 of this file. Steps 11–13 then rebased the branch onto `development`, added the
pull-request discussion, and re-ran the lot — that is §8. Step 14 walked the plan's **critical
files** one by one on the finished tip and re-earned every number a fourth time — that is §9,
which is also where the merge this branch is now heading into is written down.

This file records the real numbers, and says plainly what cannot be run here and is therefore
still owed to a person.

§§1–7 were executed on `86d557d` (`test(github): verify the integration headlessly`) at step 10.
The branch has since been **rebased onto `development`** and has gained the pull-request
discussion, so everything was **re-run on the current tip `27bc03e`** — that run is §8, and the
Summary below carries its numbers rather than step 10's. The app was **never launched** —
[RELEASE.md rule 6](../../RELEASE.md#the-rules-that-outrank-everything-below): there is no
single-instance lock, so a second instance kills a live session.

---

## Summary

Numbers from the re-run on `27bc03e` (§8). Step 10's original numbers are kept inline in §§1–4,
so the two runs can be compared rather than one overwriting the other. All of them were run a
third time on the finished tip `61750e1` (§9.2) and came back **identical** — which is the point:
step 14 wrote no code, so a number that had moved would have meant something drifted underneath.

| What                                   | Result                                                              |
| -------------------------------------- | ------------------------------------------------------------------- |
| `pnpm format:check`                    | ✅ clean                                                            |
| `pnpm turbo run typecheck --force`     | ✅ 9 tasks, **0 cached**, 26.6s                                     |
| `pnpm vitest run`                      | ✅ 153 files passed / 1 skipped — **2555 passed**, 11 skipped, 52.3s |
| `pnpm turbo run build --force`         | ✅ 6 tasks, **0 cached**, 29.5s                                     |
| Unit cover for every module added      | ✅ 15 files, 296 tests — one gap found and filled (`identity.ts`)   |
| `pnpm run verify:github` end to end    | ✅ **98 checks**, exit 0                                            |
| The harness can still go red           | ✅ 3 mutations, **4 red each**, exit 1, all restored                |
| The mirror still matches `ipc.ts`      | ⚠️ **one real drift found and fixed** — see §8                      |
| Live GitHub account, real token        | ⏳ **owed to a human** — see §5                                     |

Nothing here went red that was not made to.

---

## 1. The three gates, forced

RELEASE.md §1's list in its order, plus the `format:check` CI runs ahead of it. `--force` on
the two turbo gates is not decoration: turbo replays a cached task's recorded exit code, so a
plain `pnpm typecheck` can return 0 in 48ms having compiled nothing.

| Gate                     | Exit | Tasks / files                     | Time    |
| ------------------------ | ---- | --------------------------------- | ------- |
| `pnpm format:check`      | 0    | all matched files                 | —       |
| `pnpm typecheck --force` | 0    | 9 successful, **0 cached**        | 23.42s  |
| `pnpm test`              | 0    | 150 files passed, 1 skipped (151) | 38.31s  |
| `pnpm build --force`     | 0    | 6 successful, **0 cached**        | 28.595s |

`pnpm test`: **2498 passed, 11 skipped (2509)**. It needs no `--force` — its turbo prefix only
builds `packages/*`, and `vitest run` itself is never cached.

---

## 2. The unit cover — the primary evidence

The repo's convention is that a pure module carries a `.test.ts` beside it, and that a client
is tested against a mocked `fetch` the way `gitlabClient.test.ts` is. Run on their own:

```
$ pnpm exec vitest run apps/client/src/main/github apps/client/src/main/forge \
    packages/shared/src/statusResolve.test.ts packages/shared/src/mergeRequest.test.ts \
    packages/ui/src/tracker.test.ts
Test Files  15 passed (15)
     Tests  296 passed (296)
```

| Module                                | Tests | What it is the evidence for                                             |
| ------------------------------------- | ----: | ----------------------------------------------------------------------- |
| `github/githubClient.ts`              |    27 | every URL, header and body, against a mocked `fetch` — incl. `/api/v3`   |
| `github/githubPrSync.ts`              |    35 | a PR becomes a `MergeRequest`, and a settled one is re-read not deleted  |
| `github/prMatch.ts`                   |    26 | `closes #7` resolves against the PR's **own** repository                 |
| `github/githubIssueSync.ts`           |    22 | an issue becomes a card, and keeps the id and the block it already had   |
| `github/githubMove.ts`                |    19 | a drag becomes a label change + a state change, or is refused            |
| `github/describePullRequest.ts`       |    17 | branches, reviews, checks and GitHub's own merge verdict                 |
| `github/checkRuns.ts`                 |    14 | check runs → pipeline stages, and what "green" means                     |
| `github/githubComment.ts`             |     8 | a comment posted back onto the issue                                     |
| `github/identity.ts`                  | **7** | **added by this step** — see §3                                          |
| `forge/issueKeys.ts`                  |    11 | the provider-neutral key, moved here from `gitlab/mrMatch.ts`            |
| `forge/stageFold.ts`                  |     8 | many checks folded into one stage row                                    |
| `forge/removalGuard.ts`               |     3 | a sync that answers with nothing does not empty the board                |
| `shared/statusResolve.ts`             |    36 | `resolveGitHubColumn` — label + state → column, and the reason for it    |
| `shared/mergeRequest.ts`              |    57 | the provider-neutral merge request both forges now produce               |
| `ui/tracker.tsx`                      |     6 | which mark a card wears                                                  |

The provider-neutral refactor of step 1 is covered by the suites it touched rather than by new
ones — `gitlabSync.test.ts`, `describeMergeRequest.test.ts`, `pipelineStages.test.ts`,
`tickets.test.ts`, `boardColumns.test.ts`, `statusMapView.test.ts`, `httpTransport.test.ts` —
all inside the root run above. That is the point of the refactor: GitLab's behaviour had to
stay identical while the types stopped naming it.

---

## 3. The one gap this step found

`apps/client/src/main/github/identity.ts` was the only pure module the feature added without a
test file beside it. It decides whether a comment counts as unread, which is a visible bug in
both directions — too eager and every PR you have ever answered stays orange forever; too shy
and a waiting reviewer is silent. `githubIssueSync.test.ts` touched it once, incidentally, with
an author whose id **and** login both matched, so it could not see the id/login fallback at all.

`identity.test.ts` now covers all of it: the id match, the login fallback when either side
lacks an id, the trim/case handling, an unknown identity matching nothing, and a blank identity
not matching everybody.

**Proved it can fail.** `githubAuthorIsMe`'s id comparison mutated to `return true`:

```
FAIL  apps/client/src/main/github/identity.test.ts > matches on the numeric id when both sides carry one
     expected true to be false
Tests  1 failed | 28 passed (29)
```

`githubIssueSync.test.ts` stayed **green** through that mutation — which is the argument for
the file existing. `identity.ts` was restored from a copy in `$TEMP` and `git status` confirmed
byte-identical afterwards.

---

## 4. The headless harness, and re-proving it

`apps/client/scripts/verify-github.mjs` (step 9) is the only end-to-end evidence available on
this machine: a real `store.ts` on a real SQLite file in a scratch profile, and a throwaway
`http` server standing in for `api.github.com` with mutable issues, so a PATCH really closes an
issue and the next search really stops returning it.

```
$ cd apps/client && pnpm exec node scripts/verify-github.mjs
...
All scenarios passed.        # 92 PASS, exit 0
```

Its header claims four mutations were run when it was written. That is a claim about past work
and unverifiable by reading, so one was re-run here — `landedTaskIds` in
`main/gitlab/gitlabSync.ts` counting `closed` instead of `merged`:

```
4. A merged pull request opens an after-merge gate
  FAIL  the card's work is now recorded as landed - null
  FAIL  so the gate is open
  FAIL  and the successor is ready to be released
  FAIL  a later poll repeating "merged" does not restamp the landing - null
5. Past the retention window, the card leaves — taking its pull request with it
  FAIL  and the landing it recorded is still on it - null
5 check(s) failed.                                       # exit 1
```

**5 red, exactly the number and the sections the header predicted**, and sections 1–3 stayed
entirely green — the pair that isolates the landing from the filing. The exit code is 1, which
is what makes the script usable as a gate rather than as a printout. `gitlabSync.ts` was
restored from `$TEMP`, the harness re-run to 92 green, and the work tree left clean.

The harness's own caveat stands and is repeated here because it is the maintenance cost of this
feature: the parts of `ipc.ts` it exercises are **mirrored**, because `registerIpc` is a
3000-line closure with no test file. If `ipc.ts` changes, `verify-github.mjs` must be re-read
against it.

That bill came due three steps later, and §8.1 records what it cost: one real drift, invisible to
every gate, which made the harness run green while verifying the bug.

---

## 5. What is owed to a human, and why it cannot be done here

**A live end-to-end run against a real GitHub account.** Every prior integration phase — JIRA,
GitLab, sprints, the status map — ended with the same line, for the same reason: the credential
is the user's to paste, and no amount of local verification substitutes for one real token
against one real server. What the harness proves is that the app builds the right request and
does the right thing with the answer; what only a live run can prove is that GitHub agrees.

To do it (the app's own Settings → GitHub):

1. Paste a personal access token — `repo` scope, or `public_repo` for public repositories only
   — and press **Test connection**. It should name you.
2. Switch **Enable GitHub** on. `https://api.github.com` is the default; a GitHub Enterprise
   Server host takes the instance root and the client appends `/api/v3` itself.
3. Leave the default query `is:issue is:open assignee:@me`, and check that your issues arrive
   as cards in the column their labels say.
4. Drag one to DONE and confirm the issue closes upstream, **and** that the card is still on
   the board after the next poll — the retention window (14 days by default) is what stops the
   query's `is:open` taking away the thing you just finished.
5. Open a pull request whose body says `closes #<n>` and confirm it lands on that issue's card,
   with its checks and reviews on the pane.
6. Merge it, and confirm the card records the landing and any after-merge gate opens.

Steps 3–6 are the harness's four scenarios in the same order, so a divergence points at a
specific section of `verify-github.mjs` rather than at the feature in general.

**Linux.** Unrun, as it is every Windows-side phase; the CI pipeline packages both.

Neither is a code change, and neither could have been caught by any gate in this report.

---

## 6. One divergence from an older plan note, recorded

[`README.md`'s Phase 25 risk list](README.md) carries an assumption that the GitHub issue sync
would *enrich* a card's column from **Projects v2** over GraphQL when a project is attached and
the token has `read:project`. That is **not** what shipped, and the difference is deliberate
rather than an omission: this ticket resolves a column from the issue's **labels**
(`resolveGitHubColumn`, plus a map the app teaches itself on a successful drag), over plain
REST, with no GraphQL call and no `read:project` scope anywhere in the client.

The reason is the write side. A column has to survive a round trip — the resolver that decides
where a card lands and the one that decides whether a drag "took" must agree, or the next poll
undoes the move. A drag can add a label; making it move a card between Projects v2 columns is a
second write surface with its own permission, and the two would then disagree about which one
owns the column. Labels are also the only mechanism that works on a repository with no project
attached at all, which the older note already treated as the base case.

Anyone reading that paragraph later should read it as superseded by this one. Nothing in the
shipped feature depends on Projects v2; adding it would be a new ticket, not a gap in this one.

---

## 7. The version, and the one thing to watch on the merge

None of steps 1–8 bumped `apps/client/package.json`, so the branch arrived here still at
`0.83.0` — the number it was cut from, now three releases stale. This step set it to
**`0.85.0`**: CONTRIBUTING §4 makes MINOR the author's call and nobody else's, and this ticket
is a `feat`.

```
$ node scripts/next-version.mjs
version=0.85.0
tag=v0.85.0
needsCommit=false
# apps/client/package.json already bumped to 0.85.0, ahead of the highest tag v0.84.1
```

**The thing to watch.** `development` carries `0.84.0` on that same line, so the merge conflicts
on it — as it does for every branch that outlives a release. The integrator's scripted
resolution takes **base's** version when `package.json` conflicts on nothing but the release
bump, which has silently swallowed a branch's bump at least four times in this repo's history.
If it happens again, the pipeline patch-bumps and this feature ships as **`v0.84.2`**, a wrong
version number rather than a missing release. Check the released tag; if it reads `v0.84.2`,
set `development`'s manifest to `0.85.0` before the next release rather than re-pointing a tag.

> **Update, `27bc03e`.** `v0.84.2` has since been released from `development` independently, so
> it is now the highest tag and the sentence above can no longer be used as the tell. The branch
> was rebased onto that `development` and its manifest still reads `0.85.0`, which is still
> ahead of the highest tag, so `needsCommit=false` still holds and the rule is unchanged — only
> the number to be suspicious of is. If this feature ships as **`v0.84.3`**, the bump was
> swallowed.
>
> **Update, `61750e1`.** `v0.84.3` has since been released from `development` too, so that
> number is spent as a tell as well. §9.3 carries the current one.

---

## 8. Re-verified on the rebased tip (`27bc03e`)

Two things happened to the branch after §§1–7 were written: it was **rebased onto
`development`** (which had shipped _Resume a stopped run_ and two releases into nine of the same
files), and it gained the **pull-request discussion** — `forge/notes.ts`, `listReviewComments`,
and the `latestNoteAt` ternary that keeps an unread mark a sync did not look at. Both move code
the harness mirrors, so the numbers above were re-earned rather than assumed.

### 8.1 The mirror, re-read against `ipc.ts` — one real drift

`verify-github.mjs` mirrors `registerIpc`'s `syncGitHubIssues`, `syncGitHubPullRequests`,
`moveGitHubIssue`, `learnLabelColumn` and the `task:move` handler, because that closure is 3000
lines with no test file. Every one was re-read line by line against the rebased `ipc.ts`.

**The drift.** `ipc.ts`'s `syncGitHubPullRequests` now resolves an `identity` and passes it to
`reconcilePullRequests`; the mirror did not. This is precisely the failure mode a mirror has and
a test file does not: there is no compiler on a `.mjs`, so the missing option was `undefined`,
`githubAuthorIsMe` answered _false_ for every author alive, and the harness ran green while
verifying the bug. Restoring the omission deliberately reddens the same four checks as the
predicate mutation in §8.3 — that is the evidence it mattered, rather than a claim that it did.

Two differences were re-read and left alone, because they are deliberate and not drift: the
mirror fetches **serially** where `ipc.ts` uses four workers (a fixed request order is what makes
the recorded request log assertable), and it folds `syncGitHub`'s `syncIssues` /
`syncPullRequests` toggles into the two functions those toggles guard. Both are now stated in the
harness header so the next reader does not re-derive them.

`task:move` was also re-read: `ipc.ts` now routes through `writeMoveToForge`, whose GitHub branch
is the two lines the mirror already had. No change needed.

### 8.2 The harness, extended to the discussion

Six checks added, 92 → **98**. The fixture is the argument, so it is worth stating: PR 41 carries
one note in **each** of the three places GitHub scatters a discussion, and the newest of them is
**mine** —

| When    | Where                            | Who             |
| ------- | -------------------------------- | --------------- |
| `10:30` | an APPROVED review, empty body   | `reviewer`      |
| `11:00` | a COMMENTED review with a body   | `reviewer`      |
| `12:00` | an **inline** review comment     | `someone-else`  |
| `13:00` | the conversation tab             | **me**          |

The asserted answer is the `12:00` one. That single epoch is red if `/pulls/{n}/comments` is
never asked (it falls back to `11:00`) and red if whose-comment-is-whose has been forgotten (it
rises to `13:00`). PR 42 carries one note in each place too and **every one is mine**, so its
answer is `null` — the half of the rule that says a ring must also be able to stay off, which an
assertion that only checked "did it light up?" would never catch.

One further check sits in section 4: after the PR merges it is re-read with `stale: false`, which
does not look at the discussion at all — and the unread mark must survive that, which is the
`prior?.latestNoteAt` ternary rather than a blank.

### 8.3 Proving the new checks can fail

Three mutations, one at a time, each restored from a copy in `$TEMP` with `git status` confirming
the file byte-identical afterwards.

| Mutation                                                            | Red   | What the number became                                     |
| ------------------------------------------------------------------- | ----- | ---------------------------------------------------------- |
| `listReviewComments(...)` → `[]` in `describePullRequest.ts`         | **4** | `11:00` — fell back to the review body, did **not** vanish |
| `reconcilePullRequests`'s `isMine` → `() => false`                   | **4** | `13:00`, and PR 42 grew a mark it should never have        |
| the mirror's `identity` option removed again (the §8.1 drift)        | **4** | identical to the row above — which is why §8.1 mattered    |

The first is the one worth dwelling on. The mark did not go null; it fell back to an **older,
real** note. A harness asserting `latestNoteAt !== null` would have stayed green with the entire
inline-comment endpoint deleted, which is the failure this fixture is shaped to prevent.

### 8.4 The gates, forced, on `27bc03e`

| Gate                               | Exit | Tasks / files                     | Time    |
| ---------------------------------- | ---- | --------------------------------- | ------- |
| `pnpm format:check`                | 0    | all matched files                 | —       |
| `pnpm turbo run build --force`     | 0    | 6 successful, **0 cached**        | 29.525s |
| `pnpm turbo run typecheck --force` | 0    | 9 successful, **0 cached**        | 26.577s |
| `pnpm vitest run`                  | 0    | 153 passed, 1 skipped (154)       | 52.29s  |
| `pnpm run verify:github`           | 0    | **98 checks**                     | —       |

`pnpm vitest run`: **2555 passed, 11 skipped (2566)** — up from step 10's 2498 because the rebase
brought `development`'s _Resume_ suites and step 2 added its own.

```
$ node scripts/next-version.mjs
version=0.85.0
tag=v0.85.0
needsCommit=false
# apps/client/package.json already bumped to 0.85.0, ahead of the highest tag v0.84.2
```

### 8.5 The harness has a name now

`apps/client/package.json` gained `"verify:github": "node scripts/verify-github.mjs"`, beside
`check:abi` / `ensure:abi`, so the path is no longer something only the script's own header
remembers.

It is **deliberately not in CI**. It stands up an HTTP server and runs under Electron-as-Node
against a real `better-sqlite3` addon, which is a materially different thing from "the unit tests
run on every push" and is a decision to take on its own rather than smuggle in with this ticket.

### 8.6 `development` moved while this was being written

`development` was an ancestor of the branch when this step began and was **ten commits ahead by
the time it ended** — the app advances it mid-session. So `git merge-base --is-ancestor
development feat/github-support`, which the plan lists as a verification criterion, no longer
passes. Nothing in this step caused it and nothing in this step may fix it: rebasing is the
integrator's to do at merge time, and this step is forbidden from touching the branch's shape.

What matters here is whether it invalidates §8.1, because those ten commits **do** touch
`apps/client/src/main/ipc.ts` — by 85 lines. They do not. The whole of that change is the cloud
command queue and its imports; not one line of the five regions the harness mirrors
(`syncGitHubIssues`, `syncGitHubPullRequests`, `moveGitHubIssue`, `learnLabelColumn`,
`task:move`) is touched, which `git diff … -- ipc.ts | grep -i github` returning nothing
confirms. The reconciliation above therefore still describes the `ipc.ts` that will exist after
the integrator's rebase.

That is a happy answer this time and should not be read as a general one. The rule the mirror
imposes is unchanged: **whoever rebases this branch next must re-read `verify-github.mjs` against
`ipc.ts` again**, because the check that catches a drift is a person, not a gate.

---

## 9. The critical files, walked one by one on the finished tip (`61750e1`)

The plan's last step names six files (plus three reference points) as the ones this ticket lives
or dies on. This section is that walk. Nothing below is a claim carried forward from an earlier
step: every file was re-opened on `61750e1`, and every gate was re-run on it rather than on the
`27bc03e` §8 measured.

### 9.1 The six files, and what is actually in them

| File                                          | What it had to end up as                            | On `61750e1`                                                                                                                                    |
| --------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/ui/src/board/TaskCard.tsx`          | both features, neither overwriting the other        | ✅ `canResumeWork` (:66), `TrackerMark` (:98), `resumable` (:1112) + `resumesChain` (:1114) **above** `ticketUnread` (:1116), `styles.runButton` (:1301, :1334) |
| `apps/client/package.json`                    | `0.85.0`, and the harness given a name              | ✅ `0.85.0`; `"verify:github"` beside `check:abi` / `ensure:abi`                                                                                  |
| `apps/client/src/main/ipc.ts`                 | 785 GitHub lines *and* the two things `development` put there | ✅ 3510 lines: `createWindowStateFlusher` imported at :154, `task:resumeAgent` at :854, `github:*` at :1454–:3355, the renamed `mr:*` at :1961–:1977 |
| `github/{githubClient,describePullRequest,githubPrSync}.ts` + `forge/notes.ts` | step 2's unread signal                | ✅ `listReviewComments` (:607), all three sources folded at `describePullRequest.ts:307`, the keep-what-we-knew ternary at `githubPrSync.ts:165–169` |
| `apps/client/scripts/verify-github.mjs`       | still mirroring the merged `ipc.ts`, still able to go red | ✅ 1349 lines, **98 checks**, exit 0 — §9.2                                                                                                     |
| `docs/plan/github-gate-report.md`             | what was actually run                               | ✅ this section                                                                                                                                  |

Two absences are as load-bearing as the presences, because they are what a bad rebase resolution
would have left behind: `TaskCard.tsx` contains **no** `styles.stopButton` (the key `development`
renamed) and **no** `jiraUnread` (the name the branch renamed). Both greps come back empty.

The three reference points held without needing a change. `gitlab/gitlabSync.ts` now *imports*
the logic it used to own (`latestForeignNoteAt` at :26, used at :169–:173) rather than carrying a
second copy; `scripts/next-version.mjs` reads `needsCommit=false`; RELEASE.md §1's four gates are
below.

### 9.2 The gates, forced, on `61750e1`

| Gate                               | Exit | Tasks / files                     | Time    |
| ---------------------------------- | ---- | --------------------------------- | ------- |
| `pnpm turbo run build --force`     | 0    | 6 successful, **0 cached**        | 28.149s |
| `pnpm turbo run typecheck --force` | 0    | 9 successful, **0 cached**        | 22.877s |
| `pnpm vitest run`                  | 0    | 153 files passed, 1 skipped (154) | 47.20s  |
| `pnpm format:check`                | 0    | all matched files                 | —       |
| `pnpm run verify:github`           | 0    | **98 checks**                     | —       |

`pnpm vitest run`: **2555 passed, 11 skipped (2566)** — identical to §8.4, which is the answer
wanted here: step 14 added no code, so a moved number would have meant something had drifted.

The mirror was re-read against `ipc.ts` once more, under the rule §8.6 leaves behind. `ipc.ts` is
byte-identical to the one §8.1 reconciled — no commit since is on this branch — so §8.1 stands
rather than being re-derived. What has moved is `development`, and that is §9.3.

### 9.3 The merge this branch is now heading into

`development` was ten commits ahead when §8.6 was written and is **eleven** now. The eleventh is
`0de6d4c chore(release): v0.84.3`; the other ten are Phase 26, which taught `apps/web` to relay
the desktop's own IPC handlers. `git merge-base --is-ancestor development feat/github-support`
therefore still does not pass, and — as §8.6 says — this step may no more fix that than the last
one could: the rebase belongs to the integrator, and a step is forbidden from reshaping the
branch. What a step *can* do is hand over the resolutions instead of the surprise.

A read-only `git merge-tree 767bda5 development HEAD` puts the whole conflict surface at **six
files, eight hunks**. Every other file merges clean, including the 3510-line `ipc.ts` — the
eleven commits touch it by 85 lines and `git diff … -- ipc.ts | grep -i github` is still empty,
so not one of the five regions the harness mirrors is in the way.

| File                                | The conflict                                                                       | The resolution                                                                                                                            |
| ----------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/client/package.json`          | `0.84.3` vs `0.85.0`                                                                | **Keep `0.85.0`.** See §7 — this is the line that has been silently swallowed before                                                       |
| `apps/client/src/renderer/src/Settings.tsx` | `development` moved `statusMap.ts` into `packages/ui`; the branch still imports `./statusMap` and adds `./statusMapView` | Take `@ui/statusMap`, **keep** the branch's `import { buildGitHubLabelRows } from './statusMapView'`. `statusMapView.ts` never imports the moved module, so nothing else follows |
| `apps/web/src/board/httpTransport.ts` (×2) | the branch adds `github:*` entries to `STUBBED_READS`; `development` **deleted that whole layer** for a real `ipc-invoke` relay | Take `development`'s relay outright and drop the branch's stub entries. The relay is channel-generic, so the GitHub channels are served *better* by it than by the stubs they replace — but check that by eye, do not assume it |
| `apps/web/src/board/httpTransport.test.ts` | the tests for the layer above                                                    | Same call: `development`'s suite, minus the branch's stub cases                                                                            |
| `apps/web/src/board/BoardScreen.tsx` | one JSDoc paragraph, reworded by both                                              | Take the branch's wording (it says "the tracker's own container … JIRA's project name, or GitHub's `owner/repo`") and keep `development`'s closing sentence about the real agent-project list |
| `packages/ui/src/TaskDetail.tsx`    | `development` gave `task:activity` a `.catch`; the branch made the comment channel depend on the tracker | **Take both**: `development`'s `.catch`, then the branch's `tracker === 'github' ? 'github:fetchComments' : 'jira:fetchComments'` and its unconditional clear-the-unread-border block |

Only the `httpTransport` pair is more than mechanical, and it is not a *conflict* so much as an
overlap: two branches independently taught the web app about GitHub channels, and `development`'s
way — relay the channel — subsumes the branch's. Resolve it by deleting, not by merging.

**The version tell, refreshed.** §7's tell was `v0.84.2`, §8's was `v0.84.3`; both have since been
released from `development` on their own, which is what spends a tell. The manifest still reads
ahead of every tag —

```
$ node scripts/next-version.mjs
version=0.85.0
tag=v0.85.0
needsCommit=false
# apps/client/package.json already bumped to 0.85.0, ahead of the highest tag v0.84.3
```

— so the rule is unchanged and only the number to be suspicious of has moved again. **If this
feature ships as `v0.84.4`, the bump was swallowed on the merge.** Fix it by setting
`development`'s manifest to `0.85.0` before the next release, never by re-pointing a tag.
