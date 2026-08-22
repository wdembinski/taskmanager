# How to release this project

**The pipeline releases this project now. This file is the fallback — and the
specification the pipeline was built from.**

Every push to `development` runs
[`.github/workflows/release.yml`](.github/workflows/release.yml), which performs every step
below — gates, version, tag, draft, Windows, promote — and publishes the result. Linux is no
longer part of a release; see §6. An ordinary release needs nobody to open this file.
[`docs/11-ci-cd-pipeline.md`](docs/11-ci-cd-pipeline.md) is that pipeline described end to
end: what triggers what, the secrets it needs, and how to re-run one that failed halfway.

Read _this_ file when:

- **the pipeline went red**, and you need to know what the step that failed was protecting;
- **a release has to be cut by hand** — Actions is down, the runner cannot build something,
  or the commit cannot go through `development` at all;
- **you are changing `release.yml`**, in which case the rules below are what it has to keep
  being true.

**Audience: an agent, running unattended, on a branch that has just been merged.** That is
the by-hand case, and it is what every instruction here is written for. This is also the
file the app's _Release after merge_ switch points a session at (see
`packages/shared/src/release.ts`) — but for **this** repo that switch should now be **off**,
because the pipeline already does it and two releasers racing over one tag is worse than
either alone. See [`docs/11`](docs/11-ci-cd-pipeline.md#the-apps-release-after-merge-switch).
A human following this file by hand will not be led astray either.

The deep background — what packaging has to get right, why the ABI gate exists, how
auto-update works — is [`docs/07-packaging-and-release.md`](docs/07-packaging-and-release.md).
This file is the _procedure_; that one is the _reasons_. Read it if a step surprises you.

---

## The rules that outrank everything below

1. **A failing gate ends the release.** Not "retry until green", not "skip the flaky one".
   Report what failed and stop. A release is a promise that the tagged commit is good.
2. **Never bypass `check:abi` or `check:feed`.** They exist because both of the failures
   they catch shipped to users and were invisible until someone tried to install or update.
3. **Stop and ask** — using the `@@NEEDS_INPUT@@` contract — the moment you need a
   credential, a decision about the version number, or a force-push. A release that waited
   for an answer costs an hour; a half-published one costs a day.
4. **Promote the draft LAST — but DO promote it.** Last, because electron-builder refuses to
   write to a published release and says _skipped_ while exiting 0, so anything still to
   upload must go up first. And do it, because a release nobody can install is not a release:
   four green drafts once piled up here unpublished, each waiting on a Linux build that was
   never going to happen on its own — which is why Linux is no longer part of a release at all
   (see §6). Rules 1 and 3 are the only things that may leave a release unpublished.
5. **Never release from a branch.** Only the integration branch (`development`, or whatever
   the project's base branch is) is releasable. If the checkout is on something else, say so
   and stop.
6. **Never launch the app to check it.** Not `apps/client/dist/win-unpacked/…exe`, not
   `pnpm dev`, not `electron.exe .` — and not even with `--user-data-dir` pointed at a
   throwaway profile.
   This machine is the machine the user works on, and their copy of this app is very often
   open on it. Every check in this file is headless. If someone wants to look at the window,
   they will open it themselves.

These six are unchanged by the pipeline, because they are **why** it is shaped the way it
is. Each one is now also mechanised:

| Rule                     | Where CI keeps it                                                                                                                                                                                          |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 A failing gate ends it | `gates` is a `needs:` of everything. Nothing is tagged from a red tree, and no job retries one.                                                                                                            |
| 2 Never bypass the gates | `windows` runs the real `package` script, which runs `ensure:abi` and `check:feed` inside itself. There is no flag here that skips them.                                                                   |
| 3 Stop and ask           | A workflow cannot ask, so it must never reach a question. `scripts/next-version.mjs` decides the version by rule instead of by judgement, and the one credential is `GITHUB_TOKEN`, which is issued to it. |
| 4 Promote last, and do   | `promote` needs only `windows` — the only platform this pipeline packages, now that Linux is gone (§6). It is the last job, so the Windows upload always precedes it.                                      |
| 5 Never from a branch    | **Structural now.** The workflow's only push trigger is `branches: [development]`; the `version` job's first step fails the run if a `workflow_dispatch` was aimed at anything else.                       |
| 6 Never launch the app   | No job starts the app. The smoke test runs the packaged binary under `ELECTRON_RUN_AS_NODE` — as plain Node, no window — the same way §5 does, and on a runner with nobody's copy open in the first place. |

---

## 0. Know what you are releasing

```bash
git rev-parse --abbrev-ref HEAD     # must be the integration branch
git status --porcelain              # must be empty
git log --oneline "$(git describe --tags --abbrev=0)"..HEAD
```

- A dirty tree is a stop: something is uncommitted and it is not yours to commit or stash.
- A tag on `HEAD` is **expected**, not a stop — [`CONTRIBUTING.md`](CONTRIBUTING.md) has every
  commit bump and tag its own version. What tells you there is nothing to release is a
  `gh release view vX.Y.Z` that finds an already-**published** release for the version in
  `apps/client/package.json`. Say so and stop — that is a normal outcome, not a failure.
- The commit list is the release notes' raw material. Read it; it also tells you the bump.

> **CI does this** — `release.yml`'s `version` job, in its _Is there anything to release?_
> step. Same question, same verdict: a published release for the tag ends the run green with
> a `::notice`, and every later job skips. A leftover **draft** is not that — it is a release
> that failed partway through, and the run continues into it rather than creating a second.

## 1. Green gates

```bash
pnpm typecheck        # node + web
pnpm test
pnpm build
```

All three, in that order, all green. See rule 1.

> **CI does this** — `release.yml`'s `gates` job, which everything else `needs:`, plus
> `pnpm format:check` ahead of them. The same list runs on every pull request in
> [`ci.yml`](.github/workflows/ci.yml), deliberately duplicated rather than shared: one
> guards a merge and one guards a tag, and a change made for one must not silently change
> the other.

## 2. The version

`apps/client/package.json`'s `version` **is** the release — the root `package.json` is
just the workspace manifest and stays at `0.0.0`. The house rule
([`CONTRIBUTING.md`](CONTRIBUTING.md)) is that the bump rides inside the commit that ships the
change, so most of the time it is already correct and this step is a check, not an edit.

- Pre-1.0 (`0.x`): a `feat:` in the range bumps **MINOR**, a `fix:`-only range bumps
  **PATCH**. A breaking change also bumps MINOR while pre-1.0.
- If `version` is unchanged since the last tag, bump it yourself and commit _just that_:
  `chore(release): vX.Y.Z`. (This is the one commit allowed to carry only a version — the
  no-standalone-bump rule is about work commits, and here there is no work commit to ride.)
- If `version` names a version that is **already tagged on a commit other than `HEAD`**,
  stop and ask. Somebody has released it and you are about to overwrite history. A tag on
  `HEAD` naming that same version is the normal case — the work commit put it there.

> **CI does this** — [`scripts/next-version.mjs`](scripts/next-version.mjs), called by the
> `version` job. It is a script with a unit test rather than a `${{ }}` expression because
> version arithmetic nobody can run before pushing is only ever debugged by tagging the wrong
> thing. It honours a manifest version newer than every tag, and otherwise applies the
> fallback above by patch-bumping the highest **released** version — not the manifest's,
> which may be behind. `node scripts/next-version.mjs` locally tells you what a release would
> do right now without doing any of it.

## 3. Tag and push

```bash
git tag -l vX.Y.Z                   # normally already there; created by the work commit
git tag -a vX.Y.Z -m "vX.Y.Z — <one line saying what changed>"   # only if it is not
git push --follow-tags origin <integration-branch>
```

An **annotated** tag (`-a`), never a lightweight one. If the push is rejected, stop —
fetching and rebasing a release commit under a tag is not an unattended operation.

> **CI does this** — the `version` job's _Tag and push_ step, as `github-actions[bot]`, with
> the same `--follow-tags` so the branch is never briefly ahead of the tag naming it. Two
> things stop the bump commit from starting another release: pushes authenticated with
> `GITHUB_TOKEN` do not trigger workflows, and `gates` skips itself when the head commit is a
> `chore(release):`. `development`'s branch protection, if any, has to let that bot push —
> see [`docs/11`](docs/11-ci-cd-pipeline.md#one-time-repository-settings).

## 4. Draft the GitHub release

```bash
gh auth status                       # if this fails: stop and ask for a token
export GH_TOKEN=$(gh auth token)     # PowerShell: $env:GH_TOKEN = (gh auth token)
gh release create vX.Y.Z --draft --title "vX.Y.Z — <headline>" --notes-file notes.md
```

Write `notes.md` from the commit range in step 0: group by what a user would notice
(new behaviour, fixes, then anything internal), not by commit order. Keep it to what
changed for someone using the app. Delete `notes.md` afterwards — it is not a source file.

The release must exist as a **draft** before packaging, because that is what
electron-builder uploads into.

> **CI does this** — the `version` job's _Draft the GitHub release_ step, with
> `--generate-notes`. That is the one place the pipeline is worse than a person: generated
> notes are the commit subjects, not the grouping this section asks for. **Reword them on
> the release page** when a version deserves it; the release is already published by then,
> and editing its notes is safe.

## 5. Package Windows

On Windows only:

```bash
pnpm --filter claude-orchestrator package
                    # build + install-app-deps + ensure:abi + electron-builder --win
                    #   --publish onTagOrDraft + check:feed
```

This uploads the installer, its blockmap and `latest.yml` to the draft. If it reports
`skipped publishing`, the release is not a draft any more — see rule 4 — and you must fix
that before continuing.

Then smoke-test what you built — **without launching it** (rule 6). `dist/` is inside
`apps/client`, since that is where the `package` script above runs:

```bash
ELECTRON_RUN_AS_NODE=1 "apps/client/dist/win-unpacked/VIPPER Task Manager.exe" -e "
  const path = require('path');
  const pkg = 'apps/client/dist/win-unpacked/resources/app.asar/node_modules/better-sqlite3';
  const Database = require(path.resolve(pkg));
  const row = new Database(':memory:').prepare('select 1 as ok').get();
  console.log('packaged addon OK on ABI ' + process.versions.modules, row);
"
```

`ELECTRON_RUN_AS_NODE` runs the packaged binary as plain Node: no window, no engine, no
scheduler, nothing that can collide with a copy the user has open.

This is a **stronger** check than opening the window ever was. The "Loading…" symptom is the
native addon failing to load, and the addon loads lazily inside `new Database()` — so that is
precisely what this does, against the very binary that shipped, under the very Electron that
will load it. `check:abi` compares ABI numbers on the copy in `node_modules`; this actually
opens a database with the copy in `dist`. If it throws, the release is bad — stop.

**Require it through `app.asar`, not through `app.asar.unpacked`.** Only the compiled
`.node` is unpacked; `better-sqlite3`'s own dependencies — `bindings` above all — stay inside
the archive. Requiring the unpacked directory directly therefore dies with
`Cannot find module 'bindings'` on a perfectly good build, because the sibling it wants is in
the asar it just stepped outside of. Asking for the asar path is also what the app itself
does: Electron resolves the JavaScript from inside the archive and redirects the `.node` to
`app.asar.unpacked` on its own. This file said `app.asar.unpacked` until v0.55.5 and so
failed every healthy build it was run against.

What it does not cover is whether the window renders. Nothing headless can, and that is an
acceptable gap: every renderer failure this project has actually shipped came through the
addon. If a human wants the window looked at, say in your report that it is owed.

> **CI does this** — `release.yml`'s `windows` job, on a `windows-latest` runner, against a
> checkout of **the tag** rather than the branch. Two adaptations, both forced by the runner:
> it runs `pnpm exec turbo run build --filter=./packages/*` first, because `package` never
> goes through turbo and a clean install has no `packages/*/dist` for the bundler to resolve;
> and the smoke test writes `PASS`/`FAIL` to a **file** instead of printing, because the
> packaged binary is a GUI-subsystem executable, detached from the console, so a step reading
> stdout would pass on every build, healthy or not.
>
> [`ci.yml`](.github/workflows/ci.yml) runs the same package-and-smoke-test on any pull
> request touching `apps/client`, `packages/**` or the lockfile, with `package:local`
> (`--publish never`). Since a merge into `development` is now the thing that tags, an ABI
> break is much better caught on the PR than after the tag exists.

## 6. Linux releases are discontinued

There is no Linux job. `release.yml` packages and publishes Windows only — nothing here builds
an AppImage or a `.deb`, and nothing uploads a `latest-linux.yml` feed. `promote` (§7) publishes
as soon as Windows is on the draft; it is not waiting on Linux and never has anything to say is
owed.

This used to be a `linux` job that packaged on `ubuntu-latest` and uploaded into the same
draft. It was removed rather than left to fail: a platform build that nobody maintains is worse
than no platform build, and four green Windows-only drafts once sat unpublished for a version
each, waiting on a Linux pass that was never coming (see rule 4 and "Things that have gone
wrong before").

If you need a Linux build for yourself, `pnpm --filter claude-orchestrator package:linux:local`
still packages an AppImage/`.deb` **on Linux** (see
[`docs/07`](docs/07-packaging-and-release.md#building-for-linux)) but uploads nothing — there
is no supported way to attach it to a GitHub release, and no update feed for it either.

> **CI does this** — nothing. See `release.yml`'s header comment.

## 7. Promote

Not optional (rule 4). Once Windows is on the draft:

```bash
gh release edit vX.Y.Z --draft=false
```

Confirm first that `latest.yml` sits beside the installer. Without it, no installed app will
ever see this release.

The only ways to finish without publishing are a failed gate (rule 1) or a decision you had
to stop and ask about (rule 3). Both are reportable outcomes.

> **CI does this** — `release.yml`'s `promote` job, which checks `latest.yml` is on the release
> (matched as a whole line, `grep -qxF`) before it publishes. A published release with no feed
> beside it is invisible to every installed app, so this fails rather than promotes.

## 8. Report

Finish with, in one short paragraph: the version, the tag, whether the release is published or
still a draft, and anything still owed (a clean-machine install test, notes a human should
reword). If you stopped early, say exactly which step and why — that is more useful than a
summary of the steps that worked.

> **CI does this** — as annotations on the run: a `::notice` when the tag is published or when
> there was nothing to release. What no workflow can report is the part that was always owed to
> a person — installing the build on a **clean machine** and taking one project end to end.
> Nothing in the pipeline does that, and nothing in it pretends to.

---

## Things that have gone wrong before

Each of these cost a release. They are here so they cost nothing again.

- **A bypassed ABI gate ships an app that boots to a permanent "Loading…".** The addon
  loads lazily, so nothing fails at build time or launch — the store throws before the first
  IPC handler registers, and every screen waits forever. v0.25.0 shipped exactly that.
- **`publisherName` must stay unset while nothing is signed.** Its mere presence tells
  electron-updater to verify an Authenticode signature that does not exist, and every update
  from v0.30.0–v0.33.0 was refused _after_ a complete download. `check:feed` guards it.
- **Promoting before every artifact is uploaded leaves gaps nothing can fill afterwards.**
  electron-builder cannot write to a published release and reports it as `skipped` with exit
  code 0. This is what four unpublished Windows-only drafts, each waiting on a Linux build
  that never came, cost before Linux was removed from the pipeline entirely (§6).
- **Never upload assets with `gh` if you can avoid it.** It rewrites spaces in filenames to
  dots, and `latest.yml` names the file electron-builder wrote — a mismatch is a release
  nobody can update to.
- **A "boot smoke test" took down the app the user was working in** (2026-08-02). An agent
  ran `timeout 12 electron.exe .` to prove the app still started. The exact mechanism was
  never pinned down, and that is the point: `apps/client/src/main/index.ts` takes no
  `requestSingleInstanceLock`, so a second instance is a second full engine — scheduler,
  watcher, sync poller, updater — with its own `before-quit` teardown calling
  `sessions.stopAll()`. Pointing it at a throwaway `--user-data-dir` does not make it safe;
  that isolates the database and nothing else. This is why rule 6 exists.
- **Two releasers, one tag.** The pipeline and the app's _Release after merge_ switch both
  follow this file, and both would tag. Leave that switch **off** for this repo
  ([`docs/11`](docs/11-ci-cd-pipeline.md#the-apps-release-after-merge-switch)); the agent it
  starts would either race the workflow for the tag or find the release already published
  and stop, and only one of those two outcomes is harmless.
