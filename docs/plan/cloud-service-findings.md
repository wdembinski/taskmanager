# Cloud service — what static reading predicts will fail

Step 1 of *Cloud service — tests and analyze issues*. The approved plan opened with seven
predictions read off `feat/cloud-service-implementation`'s own files. This file is the
**verification of those seven**, done before anything is merged or changed, so that step 2
(merge), step 3 (verification) and step 4 (critical files) act on checked facts rather than
on the plan's guesses.

Every finding below was re-derived from the branch itself, read without merging:

```bash
git fetch origin feat/cloud-service-implementation
git show origin/feat/cloud-service-implementation:apps/server/package.json
git ls-tree -r --name-only origin/feat/cloud-service-implementation -- apps/server
```

The branch was at `5788f5a` (`docs(plan): verify the adaptive cadence end to end (Phase 25)`).

**Two of the seven do not survive contact with the evidence.** They are written up in full
rather than quietly dropped, because both were plausible and both would otherwise be
re-raised by the next person reading the same files.

---

## Verdicts at a glance

| # | Prediction | Verdict |
|---|------------|---------|
| 1 | `nest build` has no tsconfig, so `pnpm build` fails | ❌ **refuted** — the CLI falls back to `tsconfig.json` |
| 2 | All three `migration:*` scripts point at a filename that does not exist | ✅ **confirmed** |
| 3 | Root `pnpm test` is green only because `typecheck` runs first and builds the dists | ✅ **confirmed** |
| 4 | No server test file is ever typechecked | ✅ **confirmed** |
| 5 | `apps/web` has no `vitest.config.ts`, unlike its siblings | ⚠️ **confirmed, weaker than stated** |
| 6 | A machine-dependent WSL assertion means the gate can never be green here | ❌ **refuted as stated** — it passes here; the fragility is latent |
| 7 | `turbo.json` defines no `test` task, and three packages have no `test` script | ✅ **confirmed** |

Only **2, 3, 4 and 7** are defects to fix. **5** is a consistency gap. **1** and **6** need
no code change — but both need the *record* correcting, which is why they are here.

---

## 1. `nest build` — REFUTED

**The prediction.** `apps/server/package.json` has `"build": "nest build"`; `nest-cli.json`
sets no `compilerOptions.tsConfigPath`; the CLI therefore defaults to `tsconfig.build.json`,
and `apps/server/` contains only `tsconfig.json`. Root `pnpm build` should fail here.

Every premise is true except the last inference. The file listing confirms the rest:

```
$ git ls-tree -r --name-only origin/feat/cloud-service-implementation -- apps/server | grep tsconfig
apps/server/tsconfig.json
```

and `nest-cli.json` does carry a `compilerOptions` block (`deleteOutDir: true`) with no
`tsConfigPath` in it — which is exactly the shape that makes "it defaults to
`tsconfig.build.json`" look conclusive.

**Why it is wrong.** The default is not a constant; it is a filesystem probe. From the CLI's
own source:

```js
// @nestjs/cli/lib/utils/get-default-tsconfig-path.js
function getDefaultTsconfigPath() {
    return fs.existsSync(join(process.cwd(), TSCONFIG_BUILD_JSON))
        ? TSCONFIG_BUILD_JSON
        : TSCONFIG_JSON;
}
```

With no `tsconfig.build.json` on disk it resolves `tsconfig.json` — the file that *is* there.

**And it is the right version.** The fallback is a 10.x addition, so the resolved version
decides. `apps/server` asks for `^10.4.0`, and the lockfile pins it exactly:

```
$ git show origin/feat/cloud-service-implementation:pnpm-lock.yaml | grep "'@nestjs/cli@"
  '@nestjs/cli@10.4.9':
  '@nestjs/cli@10.4.9(esbuild@0.28.1)(postcss@8.5.16)':
```

`10.4.9` is the version read above. `apps/server/tsconfig.json` is a usable build config in
its own right — `outDir: dist`, `rootDir: src`, decorators on — and it already excludes
`**/*.test.ts`, so no test file is emitted into `dist/` either.

**Consequence for the plan.** Do not add a `tsconfig.build.json` and do not set
`tsConfigPath` "to fix the build". Step 3 should still *run* `pnpm build`, because the
prediction being wrong is not the same as the build being green — it only means this is not
the reason it would fail.

> One real consequence survives: because build and typecheck now share one tsconfig, the
> `exclude` in finding 4 is load-bearing for **both**. Removing it to fix typechecking would
> start feeding test files to the build. See finding 4 for the way out.

## 2. The migration scripts — CONFIRMED

All three scripts pass `-d src/database/data-source.ts`:

```json
"migration:run":      "tsx ./node_modules/typeorm/cli.js migration:run -d src/database/data-source.ts",
"migration:generate": "tsx ./node_modules/typeorm/cli.js migration:generate -d src/database/data-source.ts",
"migration:revert":   "tsx ./node_modules/typeorm/cli.js migration:revert -d src/database/data-source.ts",
```

The directory holds no such file:

```
$ git ls-tree -r --name-only origin/feat/cloud-service-implementation -- apps/server/src/database
apps/server/src/database/dataSource.ts
apps/server/src/database/typeormOptions.ts
```

`data-source.ts` (kebab, TypeORM's documented convention) versus `dataSource.ts` (camel, the
repo's convention) — the scripts were written from the upstream docs and the file from the
house style. **Every migration command is broken**, and nothing in the gate runs them, which
is why it went unnoticed. Three one-word edits; the filename on disk is the one to keep.

## 3. The gate is order-coupled by accident — CONFIRMED

This is the most consequential of the seven, and it is exactly as described.

Root `pnpm test` is a bare `vitest run` with no build dependency — it does not go through
turbo at all:

```json
"test": "vitest run",
```

Server and web tests import **runtime values** (not types) from the protocol package:

```
apps/server/src/presence/presence.controller.test.ts:2:  import { PRESENCE_TTL_MS } from '@tm/protocol/cadence';
apps/server/src/presence/presence.registry.test.ts:2:   import { PRESENCE_TTL_MS } from '@tm/protocol/cadence';
apps/web/src/board/BoardPoller.test.ts:2:               import { CADENCE_MS } from '@tm/protocol/cadence';
```

`@tm/protocol`'s `exports` maps every subpath to built output — `./dist/*.js` for `import`,
`./dist/*.cjs` for `require` — and `files: ["dist"]`. On a clean clone `dist/` does not
exist, so those specifiers cannot resolve.

The root `vitest.config.ts` does **not** paper over it. Its aliases are the source-path ones
(`@shared`, `@protocol`, `@ui`, `@renderer`) — the `@tm/*` *package* names are deliberately
not aliased, and `apps/server/vitest.config.ts` documents that as intentional ("apps/server
imports `@tm/shared`/`@tm/protocol` as real workspace packages … never as source aliases").
So resolution really does go through `exports` to `dist/`.

What hides it is the order in RELEASE.md §1:

```bash
pnpm typecheck        # node + web
pnpm test
pnpm build
```

and `turbo.json`'s `typecheck` carrying `dependsOn: ["^build"]`. The typecheck step builds
every upstream package as a side effect, populating the dists that the *next* command
depends on. **Swap those two lines, or run `pnpm test` alone on a clean clone, and the
suite fails.** A gate whose greenness depends on the order of three independent commands is
one command away from being red for reasons nobody will connect to this.

The fix is to make the dependency explicit rather than incidental — a `test` task in
`turbo.json` with `dependsOn: ["^build"]` (see finding 7, which is the same missing piece
from the other side).

## 4. No server test is typechecked — CONFIRMED

`apps/server/tsconfig.json`:

```json
"include": ["src/**/*"],
"exclude": ["node_modules", "dist", "**/*.test.ts"]
```

and `"typecheck": "tsc --noEmit -p tsconfig.json"` — the same file. So the exclusion applies
to typechecking as much as to emitting, and **ten test files are invisible to it**:

```
src/config/devAuthGate.test.ts        src/mirror/commandMapping.test.ts
src/config/secrets.test.ts            src/mirror/rowVersion.test.ts
src/iam/iam.client.test.ts            src/presence/presence.controller.test.ts
src/iam/iam.config.test.ts            src/presence/presence.registry.test.ts
src/iam/iamAuth.guard.test.ts         src/presence/presence.service.test.ts
```

"All 9 packages green" does not cover them. A server test can call a function with the wrong
argument types, or assert against a field that no longer exists, and `pnpm typecheck` will
not say a word — vitest would only catch it if that line actually executes.

**The fix is not to delete the `exclude`.** Per finding 1, that same tsconfig is now known to
be what `nest build` compiles, so widening `include` would emit tests into `dist/`. The
correct shape is a separate `tsconfig.build.json` that keeps the exclusion for the build,
with `tsconfig.json` widened for typechecking — which also makes the `tsConfigPath` question
in finding 1 moot by giving the CLI the file it looks for first.

## 5. `apps/web` has no vitest config — CONFIRMED, but weaker than stated

The absence is real. `apps/client` and `apps/server` each carry one, and `apps/web` does not:

```
$ git ls-tree -r --name-only origin/feat/cloud-service-implementation | grep vitest.config
apps/client/vitest.config.ts
apps/server/vitest.config.ts
vitest.config.ts
```

Both siblings say in their own header comments that they exist precisely so
`pnpm --filter … test` works standalone, and `apps/server`'s is an empty
`defineConfig({})` whose entire purpose is to stop config discovery reaching the root by
accident. `apps/web` has the same `"test": "vitest run"` script and no such file.

**The correction:** it does not "run on vitest defaults". `apps/web/vite.config.ts` exists,
and vitest loads `vite.config.ts` when no vitest config is present — so a standalone run
picks up the React plugin and the rest of that config. It works, and for a reason, not by
luck. What is true is that it works by *implicit discovery* while its two siblings made the
same thing explicit and documented why. That is an inconsistency worth closing — an empty
config with a comment, exactly like `apps/server`'s — not a break.

## 6. The WSL integration test — REFUTED AS STATED

**The prediction.** `apps/client/src/main/exec/wslHost.test.ts` self-skips only when no
distro is installed; a distro *is* installed on this machine, so it runs and asserts against
the developer's real `$PATH` (`expect(stdout).toContain('/.local/bin')`, line 77) — meaning
the gate can never be green here.

The setup is accurate. `describe.runIf(process.platform === 'win32')`, `hasWsl()` is true
whenever a non-`docker-desktop` distro exists, and this machine has one:

```
$ wsl.exe -l -q
Ubuntu-20.04
docker-desktop
docker-desktop-data
```

**But the assertion passes.** Running the production prelude (`WSL_PATH_PRELUDE`) through a
login shell in that distro, which is what the test does:

```
$ wsl.exe -d Ubuntu-20.04 -e bash -lc "$PRELUDE" orch / sh -c 'echo "$PATH"'
/home/wdembins/.cargo/bin:/home/wdembins/.local/bin:/usr/local/sbin:… :/home/wdembins/.local/bin
```

`/.local/bin` is present twice over — once from Ubuntu's own `~/.profile` and once appended
by the prelude. The gate is green here today.

**The real fragility, which is not what was claimed.** The assertion does not read the
developer's `$PATH` arbitrarily; it depends on a **directory existing**. The prelude appends
conditionally:

```sh
for d in "$HOME/.local/bin" "$HOME/bin"; do
  [ -d "$d" ] && PATH="$PATH:$d"
done
```

On this distro `~/.local/bin` exists and `~/bin` does not. On a distro where **neither**
exists, the prelude correctly appends nothing, the assertion fails, and the code under test
is behaving exactly as designed. So this is a test that can fail for a reason that is not a
bug — latent, not active, and it will surface on a fresh distro or a CI runner rather than
here.

The honest framing: it is a real-WSL **integration** test with 30-second timeouts sitting
inside the standard `pnpm test` gate. That is worth deciding about deliberately — gate it
behind an opt-in flag, or have it create the directory it asserts on — but it is **not**
currently making the gate red, and step 3 should not go looking for a failure that is not
there.

> **Ruled out while nearby:** `wslSession.e2e.test.ts` is *not* a second instance of this. It
> is properly opt-in — `const ENABLED = process.env.ORCH_E2E === '1' && process.platform === 'win32'`
> — so it never runs in the normal gate, and it costs real tokens when it does.

## 7. No `test` task in turbo, no `test` script in three packages — CONFIRMED

`turbo.json` defines exactly three tasks:

```json
"tasks": {
  "build":     { "dependsOn": ["^build"], "outputs": ["dist/**", "out/**"] },
  "dev":       { "cache": false, "persistent": true },
  "typecheck": { "dependsOn": ["^build"] }
}
```

No `test`. And `packages/shared`, `packages/protocol` and `packages/ui` each expose only
`build`, `dev` and `typecheck` — no `test` script in any of the three. Yet
`packages/protocol/src/cadence.test.ts` exists and has real coverage.

So those suites run **only** via the root aggregated `vitest run`, and nothing can run them
per-package: `pnpm --filter @tm/protocol test` has no script to invoke, and
`turbo run test` has no task to schedule. This is the same missing piece as finding 3 seen
from the other end — adding a `test` task with `dependsOn: ["^build"]` fixes the ordering
bug *and* gives the packages somewhere to hang a `test` script.

---

## What step 3 should actually verify

Ranked by what the evidence says is most likely to be red, and with the two refuted
predictions removed so no time is spent chasing them:

1. **`pnpm test` on a clean clone, before anything else** — the direct test of finding 3.
   Expect failure to resolve `@tm/protocol/cadence`. This is the one to prove by
   reproduction, because the fix depends on it.
2. **`pnpm migration:run --filter @tm/server`** — finding 2, expect an immediate
   file-not-found.
3. **`pnpm typecheck` after widening the server's tsconfig** — finding 4, to see what the
   ten unchecked test files have been hiding. This may surface real type errors; that is the
   point.
4. **`pnpm build`** — finding 1 predicts this now *passes* at the server. Confirm it, since
   the plan expected otherwise.
5. **`pnpm --filter @tm/web test`** — finding 5, expected to pass; the change is consistency,
   not repair.
