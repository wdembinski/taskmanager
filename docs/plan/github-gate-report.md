# GitHub support — the verification report

Step 10 of _GitHub support_, and the last one. Steps 1–8 **built** the integration; step 9
**wrote** the headless harness. This file **runs** everything that can be run on this machine,
records the real numbers, and says plainly what cannot be run here and is therefore still owed
to a person.

Everything below was executed from this worktree on `86d557d`
(`test(github): verify the integration headlessly`), plus the one test file this step adds.
The app was **never launched** —
[RELEASE.md rule 6](../../RELEASE.md#the-rules-that-outrank-everything-below): there is no
single-instance lock, so a second instance kills a live session.

---

## Summary

| What                                   | Result                                                              |
| -------------------------------------- | ------------------------------------------------------------------- |
| `pnpm format:check`                    | ✅ clean                                                            |
| `pnpm typecheck --force`               | ✅ 9 tasks, **0 cached**, 23.4s                                     |
| `pnpm test`                            | ✅ 150 files passed / 1 skipped — **2498 passed**, 11 skipped, 38.3s |
| `pnpm build --force`                   | ✅ 6 tasks, **0 cached**, 28.6s                                     |
| Unit cover for every module added      | ✅ 15 files, 296 tests — one gap found and filled (`identity.ts`)   |
| `scripts/verify-github.mjs` end to end | ✅ **92 checks**, exit 0                                            |
| The harness can still go red           | ✅ re-checked by mutation: 5 red, exit 1, restored                  |
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
