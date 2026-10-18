# How to release this project

**The pipeline releases this project now. This file is the fallback — and the
specification the pipeline was built from.**

Every push to `development` runs
[`.github/workflows/release.yml`](.github/workflows/release.yml), which performs every step
below — gates, version, tag, draft, Windows, Linux, promote — and publishes the result. An
ordinary release needs nobody to open this file.
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
   Report what failed and stop — a failed `check:abi`/`check:feed` on Windows (§5) or a
   failed ELF/ABI check on Linux (§6) is exactly as disqualifying as a failing test. A
   release is a promise that the tagged commit is good on every platform it claims to ship.
2. **Never bypass `check:abi` or `check:feed`.** They exist because both of the failures
   they catch shipped to users and were invisible until someone tried to install or update.
3. **Stop and ask** — using the `@@NEEDS_INPUT@@` contract — the moment you need a
   credential, a decision about the version number, or a force-push. A release that waited
   for an answer costs an hour; a half-published one costs a day.
4. **Promote the draft LAST — but DO promote it.** Last, because electron-builder refuses to
   write to a published release and says _skipped_ while exiting 0, so anything still to
   upload — Windows' installer and Linux's AppImage/`.deb`, with both their feeds (§5, §6) —
   must go up first. And do it, because a release nobody can install is not a release: four
   green drafts once piled up here unpublished, each waiting on a Linux build that was never
   going to happen on a contributor's own machine. §6 now packages Linux on a runner instead,
   so `promote` waits on it exactly as it waits on Windows, rather than cutting the platform
   out. Rules 1 and 3 are the only things that may leave a release unpublished.
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
| 4 Promote last, and do   | `promote` needs both `windows` and `linux` (§6), now that a runner builds Linux again. It is the last job, so both platforms' uploads always precede it.                                                   |
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
- A tag on `HEAD` is **expected**, not a stop — it names the pipeline's own
  `chore(release):` commit, or a manifest deliberately bumped ahead of every tag
  ([`CONTRIBUTING.md`](CONTRIBUTING.md) §4). What tells you there is nothing to release is a
  `gh release view vX.Y.Z` that finds an already-**published** release for the version in
  `apps/client/package.json`. Say so and stop — that is a normal outcome, not a failure.
- The commit list is the release notes' raw material. Read it; it also tells you the bump
  [`scripts/next-version.mjs`](scripts/next-version.mjs) will derive from each commit's type.

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
([`CONTRIBUTING.md`](CONTRIBUTING.md)) is that contributors never touch this file: the
pipeline derives the bump itself from the commits since the last release, so this step is a
computation, not a check.

- Pre-1.0 (`0.x`): a `feat` anywhere in the range (or any breaking change) bumps **MINOR**;
  a range of nothing but `fix`/`refactor`/`test`/`docs`/`chore`/`perf` bumps **PATCH**. The
  highest bump found wins, and a `chore(release):` commit the pipeline wrote itself is never
  counted.
- Commit the result as `chore(release): vX.Y.Z`, carrying only the version line. (This is
  the one commit allowed to carry only a version — the no-standalone-bump rule was always
  about work commits, and a work commit no longer carries one at all.)
- If `version` names a version that is **already tagged on a commit other than `HEAD`**,
  stop and ask. Somebody has released it and you are about to overwrite history. The normal
  exception is a manifest deliberately bumped ahead of every tag — the MAJOR case
  CONTRIBUTING.md §4 describes — which the pipeline honours instead of computing anything.

> **CI does this** — [`scripts/next-version.mjs`](scripts/next-version.mjs), called by the
> `version` job. It is a script with a unit test rather than a `${{ }}` expression because
> version arithmetic nobody can run before pushing is only ever debugged by tagging the wrong
> thing. It honours a manifest version newer than every tag, and otherwise classifies every
> commit since the highest **released** version by its Conventional Commits type and applies
> the highest bump found — not the manifest's own line, which no branch carries any more.
> `node scripts/next-version.mjs` locally tells you what a release would do right now without
> doing any of it.

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
>
> One rejection it does not stop for: a plain merge to `development` landing between this
> job's checkout and this step, which the push reports as non-fast-forward (and which can
> leave a dangling, harmless tag behind — `--follow-tags` pushes the tag and the branch as
> two separate ref updates, and only the branch one is rejected). That merge is not this
> workflow's own push, so it triggered its own queued run (same concurrency group), which
> will compute the version from the now-current `development` and release in this run's
> place. Rebasing and retrying here instead would risk publishing a version that does not
> account for the commit that won the race, so CI recognizes this specific rejection and
> stands down — the run finishes green with nothing released, by design, same as §0.

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

## 6. Package Linux

Required for promote, exactly like Windows (rule 4) — not a hand-back, not a best-effort
add-on. On Linux only (WSL is the usual path on a machine that is otherwise Windows; build
from the WSL-native home, never from `/mnt/c` — see
[`docs/07`](docs/07-packaging-and-release.md#building-for-linux)):

```bash
sudo apt-get update && sudo apt-get install -y fakeroot   # electron-builder shells out to it
                                                           #   for the .deb target
pnpm exec turbo run build --filter=./packages/*           # packages/*/dist — same reason as §5
pnpm --filter claude-orchestrator package:linux:local      # --linux --publish never:
                                                            #   AppImage + .deb + latest-linux.yml
```

Then check what you built is actually a Linux binary, and that its native addon was compiled
for Electron's ABI rather than the host Node's — the same failure §5 guards against on
Windows, v0.25.0's permanent "Loading…", on the other platform:

```bash
file apps/client/dist/linux-unpacked/claude-orchestrator
file apps/client/dist/linux-unpacked/claude-orchestrator | grep -q 'ELF 64-bit'

ADDON=apps/client/dist/linux-unpacked/resources/app.asar.unpacked/node_modules/better-sqlite3/build/Release/better_sqlite3.node
readelf -Ws "$ADDON" | grep -q 'node_register_module_v130'   # v130 is Electron 33's module ABI
```

**Read it through `app.asar.unpacked`, not `app.asar`** — the opposite of §5's smoke test, and
not a mistake: `readelf` reads the `.node` file, it does not `require()` it, and the unpacked
copy is the only one that exists as a file on disk to point `readelf` at.

Upload the AppImage, the `.deb` and `latest-linux.yml` into the draft §4 created:

```bash
gh release upload vX.Y.Z --clobber \
  apps/client/dist/*.AppImage \
  apps/client/dist/*.deb \
  apps/client/dist/latest-linux.yml
```

Without `latest-linux.yml` beside the installers, no AppImage can ever see this release —
§7 refuses to promote on a missing Linux feed exactly as it refuses on a missing Windows one.

> **CI does this** — `release.yml`'s `linux` job, on an `ubuntu-latest` runner, against a
> checkout of **the tag**, alongside `windows` rather than after it. `fakeroot` is installed
> first because electron-builder shells out to it for the `.deb` target; without it the
> AppImage still builds and the `.deb` target dies on its own. `promote` (§7) `needs:` this
> job the same way it needs `windows` (rule 4).
>
> This used to be removed from the pipeline entirely rather than left to fail — not because
> Linux stopped mattering, but because the only place that could build it was a contributor's
> own machine, and four green Windows-only drafts once sat unpublished for a version each
> waiting on that build (see "Things that have gone wrong before"). A runner can build it
> instead, so it is a required step again, not a best-effort one.

## 7. Promote

Not optional (rule 4). Once Windows **and** Linux are both on the draft:

```bash
gh release edit vX.Y.Z --draft=false
```

Confirm first that `latest.yml` **and** `latest-linux.yml` each sit beside their installers.
Without either one, no installed app on that platform will ever see this release.

The only ways to finish without publishing are a failed gate (rule 1) or a decision you had
to stop and ask about (rule 3). Both are reportable outcomes.

> **CI does this** — `release.yml`'s `promote` job, which checks `latest.yml` and
> `latest-linux.yml` are both on the release (each matched as a whole line, `grep -qxF`)
> before it publishes. A published release missing either feed is invisible to every
> installed app on that platform, so this fails rather than promotes.

**Then prune.** Every Windows and Linux job uploads its installer and feed into the draft,
and nothing removes an _earlier_ release's copies — about 130 releases' worth had piled up
before anything did. Once the release above is published, not before:

```bash
node scripts/prune-release-assets.mjs --keep vX.Y.Z
```

This deletes every asset on every release **other** than the one just published, drafts
included. Do the same for the `windows-vX.Y.Z` / `linux-vX.Y.Z` backup artifacts the Windows
and Linux jobs kept as a fallback (§5, §6) — delete every one of those two name patterns
except the pair matching this tag, through the Actions artifacts API.

Both steps run **after** `--draft=false`, never before: deleting another release's assets
while this one is still a draft risks touching the wrong release. And neither may fail the
run — the release is already published by the time they run, so a red step here would
describe a release that in fact succeeded, sending whoever reads it looking for a broken
release instead of a pile of unpruned assets.

**The trade-off, paid knowingly.** Once an older release's assets are gone, nobody can
download that version's installer again — there is no supported downgrade path, by hand or
otherwise. And electron-updater can no longer serve a **differential** update into that
version: a client several releases behind now downloads the full current installer instead
of a delta against its own blockmap, because the blockmap it would diff against has been
deleted along with everything else that release uploaded. Nothing here keeps N-1 (or any
other version) around to avoid that — every release but the newest is pruned, on the view
that ~130 releases' worth of dead installers costs more than the occasional larger download
costs the few clients that update rarely.

> **CI does this** — the same `promote` job, in two steps after _Publish_: one runs
> [`scripts/prune-release-assets.mjs`](scripts/prune-release-assets.mjs) against every
> release but the one just published; the other deletes the matching `windows-v*`/`linux-v*`
> backup artifacts. Both are wrapped in `|| echo ::warning::…` so a pruning failure never
> undoes a release that already succeeded — see "Things that have gone wrong before".

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

## UI changes

Not one of the gates above, and not run by `release.yml` at all — there is no job in the
pipeline for it, and none should be added. `node scripts/ui-shots.mjs --attach` screenshots
the real UI headlessly next to its mockup; the sheet lands at `.vipper/shots/index.html`,
and `--attach` copies it into `.vipper/attach/` for the app to pick up as attachments on the
card. A human looks at the sheet and approves it before that **card** is Done — a release
is not blocked on it, and nothing here checks that it happened. See
[`CONTRIBUTING.md`](CONTRIBUTING.md) §6.

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
  that never came, cost back when Linux could only be packaged on a contributor's own
  machine — which is why `promote` now `needs:` the `linux` job (§6) exactly as it needs
  `windows`, rather than cutting the platform out.
- **Never upload assets with `gh` if you can avoid it.** It rewrites spaces in filenames to
  dots, and `latest.yml` names the file electron-builder wrote — a mismatch is a release
  nobody can update to.
- **Nothing pruned an earlier release's assets, and about 130 releases' worth piled up.**
  Every Windows and Linux job uploads its installer and feed into the draft; nothing ever
  removed the ones from releases before it. §7's prune step is the fix, and it is
  deliberately not a gate: it runs after the release is already published, and treating a
  pruning failure as a release failure would send whoever reads it looking for a broken
  release instead of a pile of unpruned assets.
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
