# 7. Packaging & release

How to turn the source into an installable Windows or Linux build, what the packaging
has to get right, and the steps to cut a versioned release. Packaging config lives in
[`electron-builder.yml`](../electron-builder.yml); the build itself is driven by
electron-vite (see [`docs/02`](02-architecture.md) for the three-bundle layout).

---

## Build & package

```bash
pnpm install          # postinstall rebuilds better-sqlite3 for Electron's ABI
pnpm build            # electron-vite build -> ./out (main / preload / renderer)
pnpm package          # build + install-app-deps + ABI gate + electron-builder --win,
                      #   publishing to GitHub on a tag or draft release (needs GH_TOKEN)
pnpm package:linux    # same, --linux (AppImage + deb) — MUST run on Linux
pnpm package:local    # --win, --publish never: build the installer, upload nothing
pnpm check:abi        # the ABI gate on its own
```

`pnpm package` produces, in `dist/`:

- **`claude-orchestrator-<version>-setup.exe`** — the NSIS installer (per-user, lets
  the user choose the install directory), plus its `.blockmap`.
- **`latest.yml`** — the update feed the in-app updater reads (see *Auto-update* below).
- `win-unpacked/` — the unpacked app (handy for inspection / a quick smoke test).

> Artifact names are deliberately space-free (`${name}`, not `${productName}`) — see
> *Auto-update*. Releases up to v0.29.0 used `Claude Orchestrator-…`.

For a fast check without building the installer, `npx electron-builder --win --dir`
produces only `dist/win-unpacked/`.

> `dist/` is git-ignored; `build/icon.ico` is a tracked source asset.

---

## Three things packaging must get right

Re-check these if the dependency or spawn model changes.

1. **The native SQLite binary must be unpacked from the asar.** `better-sqlite3`
   ships a compiled `better_sqlite3.node`, and native `.node` files cannot be
   `require()`d from inside `app.asar`. `electron-builder.yml`'s `asarUnpack` moves
   it (and the module) to `app.asar.unpacked/…`, so the packaged app can load it.
   *Verify:* the packaged exe boots and reads/writes its DB (it lives at
   `%APPDATA%/claude-orchestrator/orchestrator.db`).

2. **That binary must be compiled for Electron's ABI, not the host Node's.** Electron
   embeds its own Node: Electron 33 needs `NODE_MODULE_VERSION` **130**, while Node 22
   builds addons for **127**. Because `better-sqlite3` loads its addon lazily inside
   `new Database()`, a mismatch does *not* fail the build or crash on launch — the app
   opens, `createStore()` throws before the first `ipcMain.handle()`, and every screen
   sits on "Loading…" forever. v0.25.0 shipped exactly that on Linux.

   `pnpm check:abi` (`scripts/check-native-abi.mjs`) compares the addon's
   `node_register_module_v*` symbol against `process.versions.modules` read from the
   installed Electron. `pnpm ensure:abi` does the same check and, on a mismatch, forces
   a from-source rebuild against Electron's headers — both `package` scripts run it
   before electron-builder, and it fails the build if the rebuild doesn't take.
   **Never bypass this gate to get a release out.**

   The self-heal is not belt-and-braces: on Linux under pnpm, `electron-builder
   install-app-deps` logs `finished moduleName=better-sqlite3` and leaves the Node-ABI
   binary in place. Verified while cutting v0.25.1 — the gate caught it, and only the
   explicit `npm_config_runtime=electron` source build fixed it.

3. **The permission relay is spawned as the app's own binary running as Node.** The
   pre-execution permission veto (Phase 4) materializes a `.cjs` relay to `userData`
   at runtime and has the Claude CLI spawn it via `process.execPath` with
   `ELECTRON_RUN_AS_NODE=1`. In a packaged build `process.execPath` is the installed
   `Claude Orchestrator.exe`. *Verify:*
   `ELECTRON_RUN_AS_NODE=1 "…/Claude Orchestrator.exe" -e "require('http')"` runs as
   Node. (The relay script lives outside the asar, so it needs no unpack.)

4. **The updater config baked into the bundle must not describe a release nobody can
   install.** Two one-line mistakes have shipped: a `publisherName` that made
   electron-updater reject every unsigned installer, and a `latest.yml` naming a file that
   wasn't on the release. Neither has a symptom until a user's app tries to update.

   `pnpm check:feed` (`scripts/check-update-feed.mjs`) reads what electron-builder just
   wrote into `dist/` and fails on an unexpanded `${…}` macro in `app-update.yml`, a
   `publisherName` with nothing signing the build, or a `latest*.yml` naming an artifact
   that isn't beside it. All three `package` scripts run it.

---

## Auto-update

The app updates itself from its own GitHub Releases. `electron-builder` publishes the
installers **and** a `latest.yml` / `latest-linux.yml` feed to the release;
`src/main/updater.ts` (wrapping `electron-updater`) reads that feed, downloads a newer
build in the background, and applies it when the app quits. The status bar offers a
"restart" shortcut once a build is ready; **Settings → General → Updates** shows the
state, a *Check now* button and the download progress. A failure is never a dialog, but it
is no longer silent either: the status bar shows *Update failed — see Settings*, and
Settings names the electron-updater error code alongside a link to the releases page.

**Not every install can update itself** (`src/main/updateSupport.ts`):

| Install | Mode | Why |
| --- | --- | --- |
| Windows NSIS | `auto` | Applies unsigned, with no prompt — the downloaded installer has no mark-of-the-web, so SmartScreen never sees it. |
| Linux AppImage | `auto` | Only when actually run as the AppImage (`$APPIMAGE` is set). |
| Linux `.deb` | `manual` | apt owns those files. Pointing the updater at them errors on **every** launch, so it is never armed; Settings links to the releases page instead. |
| macOS | `manual` | macOS refuses an update that isn't signed and notarized. |
| `pnpm dev` | `off` | Nothing to update. |

**Builds up to v0.33.0 can never auto-update — they must be replaced by hand once.** Their
baked `app-update.yml` says `publisherName: ['${author}']`, and electron-updater treats the
presence of that key as "verify the downloaded installer's Authenticode signature". The
installer is unsigned, so verification refused it and every Windows update from v0.30.0
onwards died with `ERR_UPDATER_INVALID_SIGNATURE` *after* a complete download. The failure
was invisible: the status bar only rendered the `downloaded` state, so the app looked idle
while the release page looked fine. Anyone on such a build has to download the installer
from the releases page and click through SmartScreen (*More info → Run anyway*) once;
from that build on, updates apply themselves. The cause is fixed in `electron-builder.yml`
(`win.verifyUpdateCodeSignature: false`, no `publisherName`) and `pnpm check:feed` refuses
to let it return.

**Publishing.** `pnpm package` runs `electron-builder --publish onTagOrDraft`, which
uploads to a **draft** release when one exists (or when HEAD is a tag). Set a token
first — a classic PAT with `repo` scope:

```bash
export GH_TOKEN=ghp_…            # PowerShell: $env:GH_TOKEN = 'ghp_…'
gh release create v0.30.0 --draft --title "v0.30.0 — …" --notes-file notes.md
pnpm package                     # uploads the exe, blockmap and latest.yml to the draft
pnpm package:linux               # same, from WSL, for the AppImage/deb + latest-linux.yml
gh release edit v0.30.0 --draft=false
```

Nothing is served to users until the draft is promoted, and un-publishing it rolls the
release back. `pnpm package:local` is the escape hatch that uploads nothing.

**Promote LAST — after every platform has uploaded.** `--publish onTagOrDraft` will only
write to a *draft*, so once the release is published electron-builder refuses it:

```
GitHub release not created  reason=existing type not compatible with publishing type
  tag=v0.33.0 existingType=release publishingType=draft
skipped publishing  file=claude-orchestrator-0.33.0.AppImage
```

It says *skipped*, not *failed*, and exits 0 — so a Linux build that uploaded nothing
looks exactly like one that worked. v0.33.0 was promoted after Windows and before Linux,
and the artifacts had to go up with `gh release upload` afterwards. Either keep the draft
until both platforms are done, or flip it back with `gh release edit vX.Y.Z --draft=true`
before re-running.

**Why builder publishes instead of `gh release create`.** `gh` rewrites spaces in
uploaded asset names to dots, while `latest.yml` records the filename electron-builder
wrote — so a hand-uploaded `Claude Orchestrator-x.y.z-setup.exe` arrived as
`Claude.Orchestrator-…` and the updater 404'd on the exact file the feed named. The
artifact names are now space-free as well, so the two can't diverge again.

**Testing the feed without cutting a release.** Build two versions and serve `dist/`
locally:

```bash
pnpm package:local                       # with version bumped to e.g. 0.29.1
npx http-server dist -p 8080
```

Then point an *installed* 0.29.0 at it. The updater honours `UPDATE_CONFIG_PATH`, so
write a `local-feed.yml`:

```yaml
provider: generic
url: http://localhost:8080
```

and launch the installed build with `UPDATE_CONFIG_PATH` set to that file. That
exercises feed → download → install-on-quit end to end. Do this, then one throwaway-repo
publish, before a real draft release.

**`UPDATE_CONFIG_PATH` replaces the whole updater config, not just the feed URL.** This is
why the harness above gave false confidence for three releases: electron-updater reads
`publisherName` and `updaterCacheDirName` from that same file, so a two-line
`provider: generic` yml silently switches signature verification *off* and downloads into a
different cache directory. The local test therefore passed while every real release failed.

Copy the whole shape of the real thing, not just the provider, whenever the verification
path is what you mean to test:

```yaml
provider: generic
url: http://localhost:8080
updaterCacheDirName: claude-orchestrator-updater
# publisherName: [...]   # only if the release you are simulating carries one
```

Verified 2026-07-30 by running one binary twice against the same feed, changing only this
file: with `publisherName` present the download completed and was then refused with
`ERR_UPDATER_INVALID_SIGNATURE`; without it the same download installed.

Also useful when a local feed appears to do nothing at all: set `UPDATE_LOG_VERBOSE=1`
alongside it. electron-updater reports "Skip checkForUpdates because application is not
packed" and similar at `info`, which `src/main/updater.ts` silences by default, so an
entirely inert updater is otherwise indistinguishable from an up-to-date one.

---

## First-run readiness

The app shells out to the user's own `claude` CLI (their subscription login) — it is
**not** bundled ([`docs/06`](06-licensing.md)). On every launch the engine checks and
the UI surfaces (footer status dot + a top warning bar when something is wrong):

- `claude` is installed and on `PATH`,
- it is logged in (a `~/.claude/.credentials.json` exists), and
- `ANTHROPIC_API_KEY` is **not** set (that would bill the paid API instead of the
  subscription — we warn prominently).

See `summarizeClaudeStatus` in `src/main/claudeStatus.ts`.

---

## Running the work in WSL (Windows GUI, Linux execution)

A project can execute on a **WSL distro** while the app stays a native Windows window
— for Linux-only work (Yocto/bitbake, services built for a Linux image) without
running the GUI itself under WSLg. Set it per project in the Add/Edit dialog ("Runs
on"), with the default for new projects in **Settings → General**. Browsing to a
folder inside a distro selects that distro automatically.

Existing projects are unaffected: the target defaults to `local`, which is the exact
behavior the app always had.

**What a WSL project needs on the target machine** — reported in Settings rather than
discovered when a task fails (`probeWslTarget` in `src/main/exec/wsl.ts`):

- the distro responds,
- `claude` is installed **and findable from a login shell** — commands run via
  `bash -lc`, because `~/.local/bin` (where `claude` usually lands) is absent from a
  non-login `PATH`, and because your own environment should be in place,
- that `claude` is logged in, and
- **Windows interop is enabled**, which is how tool approval works: the CLI runs in
  Linux but spawns our permission relay as the *Windows* binary, so it reaches the
  in-app broker over ordinary loopback. WSL's default NAT networking gives Linux no
  route to Windows `127.0.0.1`, so without interop a gated run has no transport.

**Notes and limitations**

- Changing a project's target clears each task's saved session id and removes its
  worktrees — both only exist on the machine that created them.
- Worktrees for a WSL project live inside the distro
  (`~/.local/share/claude-orchestrator/worktrees`), never on the Windows side.
- Nothing serializes two tasks that build in the same **shared** external tree (e.g.
  one Yocto build directory used by two projects); bitbake's own lock will reject the
  second. Project concurrency defaults to 1, so this only bites if you raise it.
- Per-project **standing instructions** (Add/Edit dialog) are injected into every
  run's prompt — the place for "source this environment first" or "run bitbake through
  this wrapper". Knowledge about the *codebase* belongs in its own `CLAUDE.md`, which
  the CLI reads by itself.

Verify a real session end to end (costs tokens, needs a logged-in CLI in the distro):

```bash
ORCH_E2E=1 pnpm vitest run src/main/exec/wslSession.e2e.test.ts
```

---

## Versioning & tags (Conventional Commits → SemVer)

Each shipped phase is a `feat:` commit; while pre-1.0 (`0.x`) a `feat` bumps **MINOR**,
a `fix` bumps **PATCH**, and a breaking change (`feat!:` / `BREAKING CHANGE:`) bumps
MINOR (or take the app to `1.0.0` when declaring it stable). `package.json`'s
`version` matches the tag on each release commit; tag the commit with an annotated
`vX.Y.Z`.

```bash
git tag -a v0.7.0 -m "v0.7.0 — Phase 6: history, resume-across-restart & polish"
git push --follow-tags origin <branch>
```

Non-feature commits (docs, chore) do not bump the version and are not tagged.

---

## Code signing (not configured)

No certificate is wired in, so the installer and exe are **unsigned**. The only place that
shows is a hand-downloaded installer: a browser marks it with the mark-of-the-web, and
SmartScreen then raises "Windows protected your PC — unknown publisher" (*More info → Run
anyway*). Auto-updates are unaffected; electron-updater fetches the file itself, so it never
carries that mark.

**`publisherName` must stay unset while nothing is signed.** It is not a harmless label
waiting for a certificate — electron-builder copies it verbatim into the `app-update.yml`
baked into the bundle (macros like `${author}` are **not** expanded there), and
electron-updater treats its presence as an instruction to verify the downloaded installer's
Authenticode signature. Unsigned + `publisherName` set = every update refused with
`ERR_UPDATER_INVALID_SIGNATURE`. That is the v0.30.0–v0.33.0 bug described under
[Auto-update](#auto-update). Hence `win.verifyUpdateCodeSignature: false`, which also stops
electron-builder writing the key at all, and `pnpm check:feed` as the gate.

To sign later, in **one** commit:

1. hand a certificate to electron-builder — `CSC_LINK` + `CSC_KEY_PASSWORD`, or
   `win.signtoolOptions.certificateSubjectName`, or `win.azureSignOptions` for Azure
   Trusted Signing (supported by electron-builder 25);
2. set `win.signtoolOptions.publisherName` to the certificate's **exact** DN;
3. remove `win.verifyUpdateCodeSignature: false`.

Doing any of those without the others ships a release that installed clients reject. Note
the switch-over is one-way: clients running an unsigned build verify nothing, so they will
take the first signed build happily — but from then on the DN must not change without the
same care.

---

## Building for Linux

`pnpm package:linux` **must run on Linux** so `better-sqlite3` compiles for Linux —
WSL is the usual path. Build from a clone in the WSL-native home, never from `/mnt/c`:
the Windows `node_modules` holds win32 prebuilds. Ubuntu's system `node` may be far too
old for electron-builder, so source nvm and select Node 22 first, and rebuild `PATH` from
nvm's bin directory so `which pnpm` doesn't resolve to the Windows shim.

Verify the artifacts before uploading anything:

```bash
file dist/linux-unpacked/claude-orchestrator          # must say: ELF 64-bit
readelf -Ws dist/linux-unpacked/resources/app.asar.unpacked/node_modules/\
better-sqlite3/build/Release/better_sqlite3.node | grep node_register_module_v
                                                      # must say: v130 (Electron 33)
```

Then actually run it **from a terminal** — a `.desktop` launcher discards stderr, and
that is how a startup failure stayed invisible in v0.25.0:

```bash
/opt/Claude\ Orchestrator/claude-orchestrator          # .deb install
./claude-orchestrator-<version>.AppImage               # AppImage (add --no-sandbox if
                                                       # Ubuntu 24.04+ blocks user namespaces)
```

`Failed to connect to the bus: … dbus` messages are cosmetic and expected on a machine
without a session bus; ignore them. What matters is that no `No handler registered for
'…'` lines appear and every tab shows data. Since v0.25.1 a startup failure also raises
an error dialog and writes `~/.config/Claude Orchestrator/logs/main.log`.

Since v0.30.0 electron-builder uploads the Linux artifacts too (`--publish onTagOrDraft`,
same `GH_TOKEN`), which is also what writes `latest-linux.yml` — an AppImage cannot
self-update without it.

---

## Release checklist

1. Green gate: `pnpm typecheck` && `pnpm test` && `pnpm build`.
2. Confirm the dependency tree is still permissive — no copyleft
   ([`docs/06`](06-licensing.md)):
   ```bash
   pnpm licenses list --prod        # eyeball the License column
   ```
   (As of v0.8.0: only MIT / ISC / Apache-2.0 / BSD / WTFPL in the shipped tree — no
   GPL/AGPL/LGPL/MPL/EPL/CDDL.)
3. Bump `package.json` `version` if the release commit hasn't; commit.
4. Create the **draft** release (`gh release create vX.Y.Z --draft …`) and export
   `GH_TOKEN`, so the packaging steps have somewhere to upload to.
5. `pnpm package`; smoke-test `dist/win-unpacked/Claude Orchestrator.exe` (and,
   ideally, run the installer on a clean machine and take one project end-to-end).
6. For a Linux release, `pnpm package:linux` on Linux and run the artifact checks
   above. The ABI gate is not optional — a bundle that fails it is broken in a way
   that only shows up after install.
7. `pnpm check:feed` — the packaging scripts already run it, so this is only needed after
   a hand-upload or a config change. It fails on an `app-update.yml` carrying an
   unexpanded macro or a `publisherName` with nothing signing the build, and on a
   `latest*.yml` naming a file that isn't there. It runs *after* the upload on purpose:
   the upload went to a **draft**, so failing here is still ahead of any user.
8. Confirm the draft carries `latest.yml` (and `latest-linux.yml`) beside the
   installers — without them nobody's app will ever see this release.
9. Promote the draft (`gh release edit vX.Y.Z --draft=false`) — **only once every
   platform's artifacts are on it**, for the reason above.
10. Tag `vX.Y.Z` (annotated) and push with `--follow-tags`.

If artifacts have to be uploaded by hand after promotion, `gh release upload` works, but
check the asset names against `latest*.yml` afterwards: `gh` rewrites spaces in filenames
to dots, and a feed naming a file that is not on the release is a release nobody can
update to.
