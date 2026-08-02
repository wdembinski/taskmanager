# How to release this project

**Audience: an agent, running unattended, on a branch that has just been merged.** This is
the file the app's _Release after merge_ switch points a session at (see
`src/shared/release.ts`). A human following it by hand will not be led astray, but every
instruction is written for the case where nobody is watching.

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
4. **Promote the draft LAST**, after every platform's artifacts are on it. electron-builder
   refuses to write to a release that is already published, and it says _skipped_ while
   exiting 0 — so a Linux build that uploaded nothing looks exactly like one that worked.
5. **Never release from a branch.** Only the integration branch (`development`, or whatever
   the project's base branch is) is releasable. If the checkout is on something else, say so
   and stop.
6. **Never launch the app to check it.** Not `dist/win-unpacked/…exe`, not `pnpm dev`, not
   `electron.exe .` — and not even with `--user-data-dir` pointed at a throwaway profile.
   This machine is the machine the user works on, and their copy of this app is very often
   open on it. Every check in this file is headless. If someone wants to look at the window,
   they will open it themselves.

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
  `package.json`. Say so and stop — that is a normal outcome, not a failure.
- The commit list is the release notes' raw material. Read it; it also tells you the bump.

## 1. Green gates

```bash
pnpm typecheck        # node + web
pnpm test
pnpm build
```

All three, in that order, all green. See rule 1.

## 2. The version

`package.json`'s `version` **is** the release. The house rule
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

## 3. Tag and push

```bash
git tag -l vX.Y.Z                   # normally already there; created by the work commit
git tag -a vX.Y.Z -m "vX.Y.Z — <one line saying what changed>"   # only if it is not
git push --follow-tags origin <integration-branch>
```

An **annotated** tag (`-a`), never a lightweight one. If the push is rejected, stop —
fetching and rebasing a release commit under a tag is not an unattended operation.

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

## 5. Package Windows

On Windows only:

```bash
pnpm package        # build + install-app-deps + ensure:abi + electron-builder --win
                    #   --publish onTagOrDraft + check:feed
```

This uploads the installer, its blockmap and `latest.yml` to the draft. If it reports
`skipped publishing`, the release is not a draft any more — see rule 4 — and you must fix
that before continuing.

Then smoke-test what you built — **without launching it** (rule 6):

```bash
ELECTRON_RUN_AS_NODE=1 "dist/win-unpacked/VIPPER Task Manager.exe" -e "
  const path = require('path');
  const pkg = 'dist/win-unpacked/resources/app.asar/node_modules/better-sqlite3';
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

## 6. Linux — usually a hand-back, not a step

`pnpm package:linux` **must run on Linux**, from a clone in the WSL-native home (never
`/mnt/c`, whose `node_modules` holds win32 prebuilds). Unless you are already running there
with a working Node 22 toolchain, do **not** try to improvise it.

Instead: leave the release a **draft**, and say plainly in your summary that the Linux
artifacts are owed and the draft must not be promoted until they are up. That is a correct,
complete outcome for an unattended run.

If you _are_ on Linux, follow the artifact checks in
[`docs/07`](docs/07-packaging-and-release.md#building-for-linux) — the ELF check and the
`node_register_module_v130` symbol check are both required before the upload counts.

## 7. Promote

Only once every platform that this release is for has its artifacts on the draft:

```bash
gh release edit vX.Y.Z --draft=false
```

Confirm first that `latest.yml` (and `latest-linux.yml`, if Linux shipped) sit beside the
installers. Without them, no installed app will ever see this release.

## 8. Report

Finish with, in one short paragraph: the version, the tag, whether the release is published
or still a draft, which platforms' artifacts are on it, and anything still owed (a Linux
build, a clean-machine install test, notes a human should reword). If you stopped early, say
exactly which step and why — that is more useful than a summary of the steps that worked.

---

## Things that have gone wrong before

Each of these cost a release. They are here so they cost nothing again.

- **A bypassed ABI gate ships an app that boots to a permanent "Loading…".** The addon
  loads lazily, so nothing fails at build time or launch — the store throws before the first
  IPC handler registers, and every screen waits forever. v0.25.0 shipped exactly that.
- **`publisherName` must stay unset while nothing is signed.** Its mere presence tells
  electron-updater to verify an Authenticode signature that does not exist, and every update
  from v0.30.0–v0.33.0 was refused _after_ a complete download. `check:feed` guards it.
- **Promoting before Linux uploads leaves an empty release.** electron-builder cannot write
  to a published release and reports it as `skipped` with exit code 0.
- **Never upload assets with `gh` if you can avoid it.** It rewrites spaces in filenames to
  dots, and `latest.yml` names the file electron-builder wrote — a mismatch is a release
  nobody can update to.
- **A "boot smoke test" took down the app the user was working in** (2026-08-02). An agent
  ran `timeout 12 electron.exe .` to prove the app still started. The exact mechanism was
  never pinned down, and that is the point: `src/main/index.ts` takes no
  `requestSingleInstanceLock`, so a second instance is a second full engine — scheduler,
  watcher, sync poller, updater — with its own `before-quit` teardown calling
  `sessions.stopAll()`. Pointing it at a throwaway `--user-data-dir` does not make it safe;
  that isolates the database and nothing else. This is why rule 6 exists.
