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
pnpm package          # build + install-app-deps + ABI gate + electron-builder --win
pnpm package:linux    # same, --linux (AppImage + deb) — MUST run on Linux
pnpm check:abi        # the ABI gate on its own
```

`pnpm package` produces, in `dist/`:

- **`Claude Orchestrator-<version>-setup.exe`** — the NSIS installer (per-user, lets
  the user choose the install directory), plus its `.blockmap`.
- `win-unpacked/` — the unpacked app (handy for inspection / a quick smoke test).

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

No certificate is wired in, so the installer and exe are **unsigned** — Windows
SmartScreen will show an "unknown publisher" prompt on first run. To sign at release
time, provide a cert to electron-builder (`CSC_LINK` + `CSC_KEY_PASSWORD`, or
`win.signtoolOptions`) — the `publisherName` is already set so SmartScreen reputation
accrues to the right name once signed.

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
./Claude\ Orchestrator-<version>.AppImage              # AppImage (add --no-sandbox if
                                                      # Ubuntu 24.04+ blocks user namespaces)
```

`Failed to connect to the bus: … dbus` messages are cosmetic and expected on a machine
without a session bus; ignore them. What matters is that no `No handler registered for
'…'` lines appear and every tab shows data. Since v0.25.1 a startup failure also raises
an error dialog and writes `~/.config/Claude Orchestrator/logs/main.log`.

Note `gh release create` replaces spaces in asset filenames with dots, so any download
table in the release notes must use the dotted name.

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
4. `pnpm package`; smoke-test `dist/win-unpacked/Claude Orchestrator.exe` (and,
   ideally, run the installer on a clean machine and take one project end-to-end).
5. For a Linux release, `pnpm package:linux` on Linux and run the artifact checks
   above. The ABI gate is not optional — a bundle that fails it is broken in a way
   that only shows up after install.
6. Tag `vX.Y.Z` (annotated) and push with `--follow-tags`.
