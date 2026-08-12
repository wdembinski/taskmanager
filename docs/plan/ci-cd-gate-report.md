# The CI/CD pipeline — the verification report

Step 7 of _Create CI/CD pipeline_. Steps 1–6 **wrote** the pipeline — the version resolver,
the three workflows, the docs and the invariant tests. This file **runs** what can be run
before any of it is on `development`, and says plainly what cannot be.

Every command below was executed from the repo root of this worktree, on
`295c5fa` (`test(ci): guard the pipeline with its own invariants`), with its exit code and
its real numbers recorded. [`docs/11-ci-cd-pipeline.md`](../11-ci-cd-pipeline.md) describes
the pipeline itself; this is only the evidence that it holds together.

---

## Summary

| What                         | Result                                                                    |
| ---------------------------- | ------------------------------------------------------------------------- |
| Version resolver             | ✅ `v0.83.0`, `needsCommit=false` — and correct on all 89 real tags       |
| Workflows parse and hold     | ✅ 34 tests; **8 of 8 mutations caught**                                  |
| Whole tree green             | ✅ `format:check`, `typecheck`, `test`, `build` — all forced, none cached |
| Workflow → script references | ✅ every `pnpm` script the three files call exists                        |
| Packaging path               | ⏳ deferred to step 3's PR job by design — not run locally                |
| Release end to end           | ⏳ unprovable until this lands; the first real run is the merge itself    |

Nothing here went red that was not made to.

> The last row has since been overtaken by events, twice: the pipeline's first real run failed
> at `gates` on 12 August 2026, and the run after it published **v0.83.1** end to end. The
> measurements above are left exactly as they were taken;
> [§7](#7-added-after-this-report--the-first-real-run-and-what-it-caught) is what happened.

---

## 1. The version resolver

Run as the workflow runs it, in this worktree:

```
$ node scripts/next-version.mjs
version=0.83.0
tag=v0.83.0
needsCommit=false
# apps/client/package.json already bumped to 0.83.0, ahead of the highest tag v0.82.7
```

That is the branch-already-bumped case — the common one, and the one where the release must
use the manifest as-is rather than inventing a version.

**The `$GITHUB_OUTPUT` contract**, which is the only part of the script the unit test cannot
see, because the test imports the module and the module deliberately writes nothing on
import:

```
$ GITHUB_OUTPUT=$TEMP/probe.txt node scripts/next-version.mjs
$ cat $TEMP/probe.txt
version=0.83.0
tag=v0.83.0
needsCommit=false
```

Three lines, `key=value`, appended — which is what `release.yml`'s `version` job reads back
as `steps.decide.outputs.*`.

**Against the repo's real tag list** (89 `v*` tags), rather than the fixtures in the unit
test:

| Manifest version | Resolves to | `needsCommit` | Why                                    |
| ---------------- | ----------- | ------------- | -------------------------------------- |
| `0.83.0`         | `v0.83.0`   | `false`       | ahead of the highest tag `v0.82.7`     |
| `0.82.7`         | `v0.82.8`   | `true`        | names a version already tagged         |
| `0.80.0`         | `v0.82.8`   | `true`        | behind — bumps the **tag**, not itself |
| `0.8.0`          | `v0.82.8`   | `true`        | the lexical trap, below                |

The last two rows are the ones that matter. A manifest left behind by a merge that dropped
its bump — which has happened in this repo at least four times — must not produce `0.80.1`,
because that is already tagged and a release must never overwrite a tag. And `0.8.0` is the
string-compare trap in the flesh: `'0.8.0' > '0.82.6'` lexically, both tags exist here, and
the resolver still answers `v0.82.8`.

`pnpm test` covers the bump / reuse / first-release cases as unit tests — 25 of them in
`scripts/next-version.test.mjs`, collected by the root run because vitest's default glob
takes `.mjs`.

---

## 2. The workflows parse, and hold their invariants

```
$ pnpm exec vitest run test/workflow-invariants.test.ts scripts/next-version.test.mjs
Test Files  2 passed (2)
     Tests  34 passed (34)
```

Both files are inside the root `pnpm test` — confirmed by running the root gate and finding
them in its 138 files, not by assuming the glob reaches them.

### 2.1 The mutations — the part that makes the guard a guard

`test/workflow-invariants.test.ts` says in its header that it was written red-first. That is
a claim about work already done, and unverifiable by reading. So it was re-checked
mechanically: break one invariant, run the suite, require red, restore the file. The harness
lived in `$TEMP`, never in the work tree, and the tree was confirmed clean afterwards.

| Mutation                                               | Caught by                                          |
| ------------------------------------------------------ | -------------------------------------------------- |
| `version: 9` added to `pnpm/action-setup`              | never passes a version                             |
| a runner moved to `node-version: 20`                   | installs Node 22 everywhere                        |
| `promote` no longer `needs:` `linux`                   | runs promote after both package jobs               |
| `promote` gated on `needs.linux.result == 'success'`   | does not let a failed Linux build hold the release |
| `gh release create` without `--draft`                  | creates the release as a draft                     |
| `--draft=false` removed, so nothing publishes          | publishes in the promote job and nowhere else      |
| a CI gate stubbed to `echo`                            | runs RELEASE.md §1's list                          |
| a gate added to **RELEASE.md §1** that CI does not run | runs RELEASE.md §1's list                          |

**8 of 8 caught.** The last two are a pair worth separating: the drift guard reads §1 out of
`RELEASE.md` rather than restating it, so it fails from _either_ side — a workflow that drops
a gate, and a doc that gains one. §1 is the specification, and the test is what makes that
more than a sentence.

### 2.2 Every script the workflows call exists

A workflow naming a script that is not there fails only on the runner, and only after
minutes of setup. All three `--filter claude-orchestrator` targets — `package`,
`package:linux`, `package:local` — and every root script the files invoke
(`install`, `format:check`, `typecheck`, `test`, `build`) resolve against the real manifests.

---

## 3. The whole tree, forced

RELEASE.md §1's list, plus the `format:check` CI adds ahead of it:

| Gate                | Exit | Tasks                       | Time    |
| ------------------- | ---- | --------------------------- | ------- |
| `pnpm format:check` | 0    | —                           | —       |
| `pnpm typecheck`    | 0    | 9, **0 cached**             | 22.285s |
| `pnpm test`         | 0    | 138 files passed, 1 skipped | 34.09s  |
| `pnpm build`        | 0    | 6, **0 cached**             | 27.732s |

`pnpm test`: **2278 passed, 11 skipped (2289)**.

### 3.1 The first `pnpm typecheck` was not a gate

Run plainly, it returned this:

```
 Tasks:    9 successful, 9 total
Cached:    9 cached, 9 total
  Time:    48ms >>> FULL TURBO
```

Exit 0 in 48ms, having compiled nothing. turbo replays a cached task's recorded exit code,
so a green `pnpm typecheck` locally can mean "this tree passed once, on some earlier commit".
The numbers in the table above are therefore from `pnpm exec turbo run typecheck --force`
and `... build --force`, which is the only form of those two commands worth quoting in a
verification.

This is a **local** hazard only, and the pipeline is not exposed to it: there is no turbo
remote cache configured (`turbo.json` has no `remoteCache`), and the workflows cache only
pnpm's store (`cache: pnpm`), never `.turbo`. Every CI run compiles cold. Anyone re-checking
this report by hand should force it; the runner does not have to.

---

## 4. What this step did not prove, and why

Both of these are deferred by the plan's own design, not skipped.

- **The packaging path.** Proven by `ci.yml`'s `package` job on the first PR that touches
  `apps/client`, not here. Packaging in a worktree trips the `dist/app.asar` lock and takes
  around ten minutes, and the job runs the real `package:local` script — which runs
  `ensure:abi` and `check:feed` inside itself, so the runner checks strictly more than a
  local run would.
- **A release, end to end.** Not provable before this lands. A workflow runs from the branch
  it is on, so the first genuine run of `release.yml` **is** the merge that lands it. Two
  things make that acceptable rather than reckless: a failed run can be re-run with
  `workflow_dispatch` without an empty commit, and the release is idempotent — an already
  published release for the version makes the run a no-op, and a leftover draft is reused
  rather than duplicated.

A clean-machine install remains owed to a person, as
[`docs/11`](../11-ci-cd-pipeline.md#what-still-needs-a-human) already says. Nothing in this
step changes that.

---

## 5. Added after this report — step 8's file map

Everything above is pinned to `295c5fa` and its numbers are left as they were measured. Step
8 then added [`docs/11`'s _The files it is made of_](../11-ci-cd-pipeline.md#the-files-it-is-made-of)
— the map of every file the pipeline is made of, including the four it reuses unchanged — and
a fifth group in `test/workflow-invariants.test.ts` that reads that map back. So two numbers
in §2 have moved:

```
$ pnpm exec vitest run test/workflow-invariants.test.ts scripts/next-version.test.mjs
Test Files  2 passed (2)
     Tests  36 passed (36)          # was 34: 11 workflow invariants (was 9) + 25 version cases
```

Checked the same way, by mutation:

| Mutation                                                               | Caught by                                            |
| ---------------------------------------------------------------------- | ---------------------------------------------------- |
| a mapped path renamed (`scripts/next-version.mjs` → `nextversion.mjs`) | names files that are all still there                 |
| `deploy.yml` no longer named anywhere in the map                       | both assertions                                      |
| the `## The files it is made of` heading renamed                       | both assertions — the section lookup is not optional |
| a fourth workflow added to `.github/workflows/`                        | accounts for every workflow on disk                  |

**4 of 4 caught**, with the mutated file restored from a copy in `$TEMP` each time and the
work tree confirmed clean afterwards. The third is the one worth keeping: a guard that reads a
document section has to fail when the section is gone, not quietly find nothing and pass.

The reuse claim the map makes is checkable directly, and was:

```
$ git diff --name-status development...HEAD -- apps/client/scripts apps/client/electron-builder.yml
(no output)
```

`apps/client/package.json` is the one file in that group with a diff, and it is one line — the
version. Its `package`, `package:linux` and `package:local` scripts are byte-for-byte what they
were before the pipeline existed, which is what makes "the runner runs the scripts a human
runs" a fact rather than an intention.

§3's list was re-run in full on top of this step, forced as it explains: `format:check` clean,
`typecheck` 9/9 with 0 cached, `pnpm test` **2280 passed, 11 skipped** across 138 files, and
`build` 6/6 with 0 cached. The two extra tests against §3's 2278 are the two above.

---

## 6. Added after this report — step 9's settings check

§4 above says a release end to end is unprovable until this lands. The settings it would land
_onto_ are provable now, and step 9 checked them:
[`ci-cd-handoff.md`](ci-cd-handoff.md) records what every repository setting and secret the
pipeline depends on actually reads today, with the command that read it.

Two of the five were wrong, and one was a genuine red rather than a formality: the
repository's default workflow permission was `read`, which cannot be raised by a workflow's
own `permissions:` block and would have failed the `version` job's push. It has since been
set to `write`. The other — the app's _Release after merge_ switch — is a click in the app
and is still owed.

Neither is a code change, and neither could have been caught by any gate in this report, on
any runner, at any point. That is the reason that file exists: a pipeline can be entirely
correct in every file it is made of and still not run.

---

## 7. Added after this report — the first real run, and what it caught

§4 said a release end to end was unprovable until this landed. It has now landed, and there
have been two runs. The short version:

| Run                                                                            | Head        | Result                                                       |
| ------------------------------------------------------------------------------ | ----------- | ------------------------------------------------------------ |
| [31602231983](https://github.com/wdembinski/taskmanager/actions/runs/31602231983) | `b7d79d2`   | ❌ red at `gates` — one assertion. Nothing tagged, nothing published |
| [31608982908](https://github.com/wdembinski/taskmanager/actions/runs/31608982908) | `2fc8676`   | ✅ **v0.83.1 published**, Windows + Linux, 5m07s              |

`f263099..b7d79d2` into `development` on 12 August 2026 started the first. **It went red at
`gates`, so `version`, `windows`, `linux` and `promote` all skipped** — no `v0.83.0` tag, no
draft, nothing published, and the latest release stayed `v0.82.6`. The pipeline behaved
correctly: _nothing is tagged from a red tree_ is exactly §1's job, and what it caught was a
test of ours rather than a fault in the workflows.

**There is no `v0.83.0` and there never will be.** The fix commit was pushed, the next run
took the version from the manifest as it found it, and `v0.83.1` is the release that carries
both. A skipped version number costs nothing — a moved tag would.

### 7.1 One assertion, and it was describing the machine

```
Test Files  1 failed | 136 passed | 2 skipped (139)
     Tests  1 failed | 2277 passed | 13 skipped (2291)

FAIL apps/client/src/main/exec/wslHost.test.ts > WslExecHost path and relay wiring
     > spawns the relay as the WINDOWS binary, reachable over loopback
```

The assertion was `expect(spec.command.startsWith('/mnt/')).toBe(true)`.

`relaySpec` builds that command as `this.toNative(process.execPath)`
([`wslHost.ts:262`](../../apps/client/src/main/exec/wslHost.ts)), and `toNative` is
`windowsToLinux`, which **returns non-Windows input untouched**
([`wslPath.ts:60`](../../packages/shared/src/wslPath.ts)) — deliberate and documented, so a
stored Linux path survives the round trip. So:

| Where it runs   | `process.execPath` | Translates to  | `/mnt/` prefix |
| --------------- | ------------------ | -------------- | -------------- |
| This Windows box | `C:\…\node.exe`   | `/mnt/c/…`     | ✅ passes      |
| ubuntu runner   | `/usr/bin/node`    | itself         | ❌ fails       |

The assertion was never a statement about `relaySpec`. It was a statement about the machine,
and it had been true for months because **the suite had never run on Linux**: the branch was
merged locally without a PR, so `ci.yml` never fired, and every gate run before this one was
this same Windows box. `pnpm test` was green here throughout — and, as it stood, **could not
be made to fail here**, which is the actual lesson.

### 7.2 Red before green, on this machine

A test that has never been seen to fail proves nothing, so the runner was stood up locally
before anything was changed: a throwaway setup file (in `$TEMP`, never in the work tree, and
deleted afterwards) doing the two things the runner does differently —

```js
Object.defineProperty(process, 'platform', { value: 'linux' });
process.execPath = '/usr/bin/node';
```

`vitest 2.1.9` has no `--setupFiles` CLI flag, so it was wired in through a throwaway config
that merges `setupFiles` onto `apps/client/vitest.config.ts` by absolute path. That config
sits in `$TEMP` as well rather than beside the real one: an untracked `.ts` inside
`apps/client` is a file `typecheck` would pick up, so the entire harness stays outside the
work tree and is invoked as `--config $TEMP/ci-runner-sim/vitest.config.ts` with cwd
`apps/client`. Both files deleted afterwards, and the work tree confirmed clean.

| Step                                                  | Result                                                            |
| ----------------------------------------------------- | ----------------------------------------------------------------- |
| **RED** — the pre-fix test, simulated runner          | ❌ `wslHost.test.ts:185:46`, _expected false to be true_          |
| **CONTROL** — the pre-fix test, no setup file         | ✅ 4 passed, 9 skipped                                            |
| **GREEN** — after the fix, simulated runner           | ✅ 4 passed, 9 skipped                                            |
| **GREEN** — after the fix, this Windows box, no setup | ✅ 4 passed, 9 skipped                                            |

The red reproduced CI's failure at the same file, the same line and the same assertion —
which is what makes it a reproduction rather than a resemblance. The control row is what
makes it a reproduction of the **runner**: the same pre-fix test, same command, setup file
removed, passes on this box. The two lines of simulation are the entire difference between
green here and red there, which is the bug stated as an experiment.

### 7.3 The fix asserts the whole path, on every platform

`process.execPath` is a plain writable, configurable property
(`{"writable":true,"enumerable":true,"configurable":true}`), so the test now stands a Windows
binary in its place and asserts the **entire** translated string:

```ts
expect(spec.command).toBe('/mnt/c/Users/me/AppData/Local/Programs/app/VIPPER Task Manager.exe');
```

Restored in a `finally`, because `process.execPath` is process-wide and
`permissionServer.test.ts` spawns with it — a leaked fake would break an unrelated file in
the same run.

Two alternatives were rejected. Changing `wslHost.ts` would have been fixing correct
production code to get past a red gate — the production code was right all along, and it is
untouched.

The other is the one that actually shipped first. Commit `2fc8676` put the `/mnt/` check
behind `process.platform === 'win32'` and added an equality against
`host.toNative(process.execPath)`; that is what turned the pipeline green and released
`v0.83.1`. It was the right call under the circumstances — the release was blocked — but it
is weaker than it looks in the place that matters: the guard **deletes the shape check from
CI entirely**, which is the one environment where nothing else exercises it, and the equality
it added is a tautology (both sides call `toNative(process.execPath)`, so it holds whatever
`toNative` does, including nothing at all).

Stubbing the input replaces both with a single assertion that runs identically on every
runner and states a fact about `relaySpec` rather than about the box it ran on.

It is also strictly a stronger check than the prefix ever was, which was confirmed by
mutation: dropping the `toLowerCase()` from `windowsToLinux`'s drive letter yields
`/mnt/C/Users/…`, which `startsWith('/mnt/')` accepts happily and the equality catches.

```
Expected: "/mnt/c/Users/me/AppData/Local/Programs/app/VIPPER Task Manager.exe"
Received: "/mnt/C/Users/me/AppData/Local/Programs/app/VIPPER Task Manager.exe"
```

`wslPath.ts` was restored from a copy in `$TEMP` immediately afterwards and confirmed clean.
Two tests went red under that mutation, not one — `translates paths in both directions`
catches it as well, which is as it should be. The point is narrower: of the three ways the
relay's own command has been asserted, only this one catches it.

### 7.4 The gates, re-run

RELEASE.md §1 in full, forced as §3 explains:

| Gate                                  | Exit | Result                                          |
| ------------------------------------- | ---- | ----------------------------------------------- |
| `pnpm install --frozen-lockfile`      | 0    | already up to date                              |
| `pnpm format:check`                   | 0    | all matched files clean                         |
| `pnpm exec turbo run typecheck --force` | 0  | 9 tasks, **0 cached**, 32.087s                  |
| `pnpm test`                           | 1    | **2281 passed, 11 skipped**; 1 file failed — below |
| `pnpm exec turbo run build --force`   | 0    | 6 tasks, **0 cached**, 27.665s                  |

### 7.5 The one red left is local to this machine, and CI is the proof

`apps/server/src/config/secrets.test.ts` fails **here** at collection, before any of its
tests run:

```
SyntaxError: The requested module '../commonjs/state-cjs.js'
             does not provide an export named 'state'
  ❯ apps/server/src/config/secrets.ts:1  import { DefaultAzureCredential } from '@azure/identity';
```

It is not caused by anything on this branch — it reproduces on `HEAD` with the fix stashed,
the test file dates from `f36d40b` (Phase 25, already on `development`), and it is a module
interop failure in a dependency rather than an assertion.

The interesting part is that **it does not happen on the runner**. The same commit's log from
run 31602231983 shows it green:

```
✓ apps/server/src/config/secrets.test.ts (3 tests) 4ms
```

So this is an artefact of this machine's `node_modules` — two `@azure/identity` versions are
in the local store (`3.4.2` and `4.13.1`) and the path in the error does not exist under the
`4.13.1` the server resolves. It was left alone deliberately: it is not in the release path,
CI installs the same lockfile cleanly, and rebuilding `node_modules` inside a worktree is the
hazard that has previously deleted the real checkout's copy. Anyone who does want it gone
should chase it in the main checkout, not here.

The honest summary of §7.4 is therefore: **every gate that CI runs is green, and the one
local failure is one CI demonstrably does not have.**

One other thing was seen once and is written down rather than dismissed: on one of three full
`pnpm test` runs, two cases in `apps/client/src/main/worktreeManager.test.ts` failed
(`adopts an identical untracked dupe` and `union-merges additive .gitignore churn`). They
passed in isolation — 36 of 36 — and did not recur on the two runs after it. That file shells
out to `git` in temporary repositories, so contention under a loaded parallel run is the
likely cause, but "likely" is the accurate word: it has been seen to fail once, on this
machine, and nobody has explained it. If it starts failing on the runner, this is the first
sighting.

### 7.6 The run after it, which is the proof §4 said could not be written

Pushing the interim fix started
[run 31608982908](https://github.com/wdembinski/taskmanager/actions/runs/31608982908), and it
went all the way through in **5m07s**:

```
$ gh release view v0.83.1 --json isDraft,publishedAt,assets
draft: false   published: 2026-08-12T14:55:18Z   tag: v0.83.1
   claude-orchestrator-0.83.1-setup.exe
   claude-orchestrator-0.83.1-setup.exe.blockmap
   claude-orchestrator-0.83.1.AppImage
   claude-orchestrator-0.83.1.deb
   latest-linux.yml
   latest.yml
```

Every claim §4 deferred is now discharged. `gates` reached **Build** and passed it on ubuntu;
`version` tagged and drafted; `windows` and `linux` both packaged into that draft; `promote`
published it. Both update feeds are there alongside both installers, which means
`check-update-feed.mjs` ran inside the packaging scripts and was satisfied — on the runner,
not here.

**A merge into `development` now cuts and publishes a release without anyone watching.** That
is the whole point of the pipeline, and as of 12 August 2026 it is a fact rather than a
design.

What is still owed is unchanged and is not something a runner can do: the clean-machine
install, and release notes better than generated commit subjects. Both are in
[`docs/11`](../11-ci-cd-pipeline.md#what-still-needs-a-human).

### 7.7 What this section changes, and what it must not

The release is unblocked, so **this step is no longer an unblock** — it is the stronger
version of a fix that already shipped. Two consequences worth stating plainly:

- **No release by hand, then or now.** `RELEASE.md` was not run at any point here. The merge
  is the release, and a second releaser following the same file toward the same tag is the
  hazard [the handoff's §5](ci-cd-handoff.md#5-the-apps-release-after-merge-switch--required)
  describes. That switch is **still on**, and run 31608982908 went green with it on — so if
  it started an agent, that agent raced a workflow that won. It is still the one thing that
  can spoil a future run, and it is still a click nobody has made.
- **The version moved under this branch.** When this step was planned the manifest read
  `0.83.0` with `needsCommit=false`; `v0.83.1` has since been tagged _from this branch's own
  HEAD_, so the manifest now reads `0.83.1`, names a version that is already published, and
  `scripts/next-version.mjs` answers `0.83.2 / needsCommit=true`. Rather than leave the
  release to §2's fallback, `apps/client/package.json` is bumped to `0.83.2` here, which puts
  the resolver back on `needsCommit=false` and makes the next release deterministic.
