# 7. Packaging & release

How to turn the source into an installable Windows build, what the packaging has
to get right, and the steps to cut a versioned release. Packaging config lives in
[`electron-builder.yml`](../electron-builder.yml); the build itself is driven by
electron-vite (see [`docs/02`](02-architecture.md) for the three-bundle layout).

---

## Build & package

```bash
pnpm install          # postinstall rebuilds better-sqlite3 for Electron's ABI
pnpm build            # electron-vite build -> ./out (main / preload / renderer)
pnpm package          # build + electron-builder --win  ->  ./dist
```

`pnpm package` produces, in `dist/`:

- **`Claude Orchestrator-<version>-setup.exe`** — the NSIS installer (per-user, lets
  the user choose the install directory), plus its `.blockmap`.
- `win-unpacked/` — the unpacked app (handy for inspection / a quick smoke test).

For a fast check without building the installer, `npx electron-builder --win --dir`
produces only `dist/win-unpacked/`.

> `dist/` is git-ignored; `build/icon.ico` is a tracked source asset.

---

## Two things packaging must get right

Both are verified as part of finishing Phase 7 — re-check them if the dependency or
spawn model changes.

1. **The native SQLite binary must be unpacked from the asar.** `better-sqlite3`
   ships a compiled `better_sqlite3.node`, and native `.node` files cannot be
   `require()`d from inside `app.asar`. `electron-builder.yml`'s `asarUnpack` moves
   it (and the module) to `app.asar.unpacked/…`, so the packaged app can load it.
   *Verify:* the packaged exe boots and reads/writes its DB (it lives at
   `%APPDATA%/claude-orchestrator/orchestrator.db`).

2. **The permission relay is spawned as the app's own binary running as Node.** The
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
5. Tag `vX.Y.Z` (annotated) and push with `--follow-tags`.
