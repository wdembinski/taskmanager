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

Two of the five need a human click, and one of them is a genuine red rather than a formality:
the repository's default workflow permission is `read`, which would fail the `version` job's
push. Neither is a code change, and neither could have been caught by any gate in this
report — which is the reason that file exists.
