# Phase 25 — the gate report

Step 2 of *Cloud service — tests and analyze issues*. Step 1
([`cloud-service-findings.md`](cloud-service-findings.md)) checked seven predictions by
**reading** `feat/cloud-service-implementation`. This file **runs** them.

Every command below was executed from the repo root of this worktree, on the merged commit,
with its exit code and its actual output recorded. Where the output is quoted it is verbatim,
ANSI colour stripped and nothing else changed.

This file is the deliverable of the step and the input to the ones after it. It is written
twice: once with the numbers from the merged tree as it arrived (§2–§4), and once with the
numbers after the fixes (§6).

---

## 1. The merge

The plan predicted a fast-forward. **It was not one**, and the reason is worth recording
because it is the plan's own doing: step 1 committed `57a5c7d` onto this branch, so by the
time step 2 ran, `HEAD` was no longer `origin/development` and no longer an ancestor of the
cloud branch.

```
$ git merge-base --is-ancestor origin/development origin/feat/cloud-service-implementation
  → development IS ancestor of cloud branch

$ git merge-base --is-ancestor HEAD origin/feat/cloud-service-implementation
  → NOT fast-forward

$ git merge-base HEAD origin/feat/cloud-service-implementation
324f29bb9780c29d8237d517a03d4f89d0a4771c

$ git log --oneline origin/feat/cloud-service-implementation..HEAD
57a5c7d docs(cloud): verify what static reading predicts will fail
```

So this was a real three-way merge with one commit on the branch side. It was still
**conflict-free**, and for a checkable reason rather than a hopeful one: step 1's commit
touches exactly one file, `docs/plan/cloud-service-findings.md`, and the cloud branch does not
touch it (it touches `docs/plan/README.md` and
`docs/plan/azure-realtime-cost-comparison.md`). Disjoint sets, no overlap, no
`package.json:3` collision.

```
$ git merge origin/feat/cloud-service-implementation --no-edit
  → exit 0
d790147 Merge remote-tracking branch 'origin/feat/cloud-service-implementation'
        into feat/cloud-service-tests-and-analyze-issues
```

`git status --porcelain` empty afterwards.

### Install and ABI

```
$ pnpm install
  → exit 0 — "Done in 1m 34.7s using pnpm v11.18.0"
```

Corepack did fetch the raised `packageManager` (`pnpm@11.18.0`, up from `11.11.0`), the
`allowBuilds` block was honoured without a prompt, and `apps/client`'s `postinstall`
(`electron-builder install-app-deps`) rebuilt `better-sqlite3` against Electron 33.4.11.

```
$ pnpm --filter claude-orchestrator check:abi
ABI check OK: better_sqlite3.node and Electron both at ABI 130.
  → exit 0
```

---

## 2. The three root gates, in RELEASE.md §1 order

| # | Command | Exit | Result |
|---|---------|------|--------|
| 1 | `pnpm typecheck` | **0** | 9 successful, 9 total |
| 2 | `pnpm test` | **0** | 123 files passed, 1 skipped; 2066 tests passed, 2 skipped |
| 3 | `pnpm build` | **0** | 6 successful, 6 total — **but see §3.1: `@tm/server` emits nothing** |

### `pnpm typecheck` — exit 0

```
 Tasks:    9 successful, 9 total
Cached:    0 cached, 9 total
  Time:    34.661s
```

Nine tasks, not six, because `typecheck` carries `dependsOn: ["^build"]` — the three library
packages' `build` tasks run first. **That side effect is the whole of finding 3**; it is what
populates `packages/*/dist` for the `pnpm test` that follows.

### `pnpm test` — exit 0

```
 Test Files  123 passed | 1 skipped (124)
      Tests  2066 passed | 2 skipped (2068)
   Duration  54.05s
```

The one skipped file is `apps/client/src/main/exec/wslSession.e2e.test.ts` — properly opt-in
behind `ORCH_E2E=1`, exactly as step 1 said.

`apps/client/src/main/exec/wslHost.test.ts` **ran and passed**:

```
 ✓ apps/client/src/main/exec/wslHost.test.ts (13 tests) 4841ms
```

This confirms step 1's refutation of prediction 6 (see §4.6 for what it means for the record
in `docs/plan/README.md`, which says the opposite).

### `pnpm build` — exit 0, and this is the gate that had never been run

```
 Tasks:    6 successful, 6 total
Cached:    3 cached, 6 total
  Time:    15.484s

 WARNING  no output files found for task @tm/server#build.
          Please check your `outputs` key in `turbo.json`
```

Exit 0. `@tm/web` built (`dist/assets/index-CTujenP6.js`, 522.81 kB),
`claude-orchestrator` built all three bundles (`out/main`, `out/preload`, `out/renderer`).
Prediction 1 is confirmed refuted: `nest build` did **not** fail for want of a
`tsconfig.build.json`.

That warning is not cosmetic. See the next section.

---

## 3. What running the gates found that reading them did not

### 3.1 `nest build` succeeds and emits nothing — NEW

The most consequential result of this step, and nothing in step 1's static read predicted it,
because it is invisible in the files step 1 was reading.

```
$ ls apps/server/dist
ls: cannot access 'apps/server/dist': No such file or directory
```

`nest build` exits 0. There is no `dist/`. Run it directly, outside turbo, and the result is
identical:

```
$ cd apps/server && pnpm exec nest build
  → exit 0
$ ls dist
ls: cannot access 'dist': No such file or directory
```

**Why.** `apps/server/tsconfig.json` extends `../../tsconfig.base.json`, and that file sets:

```json
"noEmit": true,
```

The server's own `compilerOptions` override `module`, `moduleResolution`, `target`, `lib`,
`outDir`, `rootDir`, `experimentalDecorators`, `emitDecoratorMetadata`, `resolveJsonModule`,
`noUnusedLocals` and `noUnusedParameters` — but not `noEmit`. So `outDir: "dist"` and
`emitDecoratorMetadata: true` are both set on a compiler that has been told to write nothing.

**What it costs.** `apps/server/package.json` declares `"main": "dist/main.js"` and
`"start": "node dist/main.js"`. Neither can ever work from a `pnpm build`. The server is not
merely unbuilt, it is unstartable by its own documented entry point — and the gate says
green, because `tsc --noEmit` genuinely has no errors to report.

**How this relates to prediction 1.** Step 1 refuted the prediction correctly: the
`tsconfig.build.json` fallback in `@nestjs/cli` 10.4.9 really does resolve `tsconfig.json`,
and the build really does not fail. What neither the prediction nor its refutation reached is
that resolving `tsconfig.json` is exactly what makes the build a no-op, because
`tsconfig.json` is the `noEmit` typecheck config. The right answer turns out to be the one
step 1 advised against for the wrong reason and finding 4 advised in favour of for the right
one: **`apps/server` needs its own `tsconfig.build.json`.** Fixed in §5.1.

### 3.2 Finding 3 is real and five times wider than predicted — CONFIRMED

The clean-order check, in a throwaway clone of `d790147` outside this worktree, with **no
`pnpm typecheck` first**:

```
$ git clone --no-hardlinks . /c/tmp/tmclean && cd /c/tmp/tmclean && git checkout d790147
$ ls packages/*/dist
ls: cannot access 'packages/*/dist': No such file or directory

$ pnpm install
  → exit 0 — "Done in 22.3s using pnpm v11.18.0"

$ pnpm test
  → exit 1
 Test Files  15 failed | 108 passed | 1 skipped (124)
      Tests  1875 passed | 2 skipped (1877)
[ELIFECYCLE] Test failed. See above for more details.
```

Step 1 predicted three files failing on one specifier (`@tm/protocol/cadence`). The reality is
**15 files on six specifiers**, and most of the damage is `@tm/shared`, not `@tm/protocol`:

```
Failed to load url @tm/protocol/cadence
Failed to load url @tm/shared/attachments
Failed to load url @tm/shared/board
Failed to load url @tm/shared/iamPkce
Failed to load url @tm/shared/model
Failed to load url @tm/shared/taskChain
```

The 15 files:

```
apps/client/src/renderer/src/AddTaskDialog.test.ts
apps/client/src/renderer/src/statusMapView.test.ts
apps/server/src/presence/presence.controller.test.ts
apps/server/src/presence/presence.registry.test.ts
apps/server/src/presence/presence.service.test.ts
apps/web/src/auth/cloudAuth.test.ts
apps/web/src/board/BoardPoller.test.ts
packages/ui/src/AttachmentStrip.test.ts
packages/ui/src/TaskSteps.test.ts
packages/ui/src/board/boardColumns.test.ts
packages/ui/src/board/chainArrows.test.ts
packages/ui/src/board/chainDrag.test.ts
packages/ui/src/board/currentSprint.test.ts
packages/ui/src/modelChoice.test.ts
packages/ui/src/taskChat.test.ts
```

A representative error, verbatim:

```
Error: Failed to load url @tm/protocol/cadence (resolved id: @tm/protocol/cadence)
in C:/tmp/tmclean/apps/web/src/board/BoardPoller.test.ts. Does the file exist?
```

Step 1 looked for test files that import `@tm/*` directly and found three. What it missed is
that a test also fails when the **module under test** imports `@tm/*` — `packages/ui`'s
sources import `@tm/shared/*` throughout, so seven `packages/ui` suites and two
`apps/client` suites go down without naming `@tm/*` anywhere in their own text. Fixed in
§5.2.

### 3.3 A missing `test` script is silent, not loud — NEW

Finding 7 said `packages/shared`, `packages/protocol` and `packages/ui` have no `test`
script. True. What running it shows is that pnpm does not treat that as an error:

```
$ pnpm --filter @tm/protocol test
  → exit 0
```

No output. No script. No warning. **Exit 0.** Same for `@tm/shared` and `@tm/ui`. A CI step
or a release check that runs `pnpm --filter <pkg> test` across the workspace would report six
green packages while running tests in three of them. That is a worse failure mode than the
missing script itself, and it is the reason finding 7 is worth fixing rather than noting.
Fixed in §5.2.

---

## 4. The per-package runs and the remaining findings

### 4.1 Standalone per-package tests — all exit 0

| Command | Exit | Result |
|---------|------|--------|
| `pnpm --filter claude-orchestrator test` | **0** | 67 files passed, 1 skipped; 1231 tests passed, 2 skipped |
| `pnpm --filter @tm/server test` | **0** | 10 files passed; 44 tests passed |
| `pnpm --filter @tm/web test` | **0** | 7 files passed; 60 tests passed |
| `pnpm --filter @tm/shared test` | 0 | **no script — nothing ran** (§3.3) |
| `pnpm --filter @tm/protocol test` | 0 | **no script — nothing ran** (§3.3) |
| `pnpm --filter @tm/ui test` | 0 | **no script — nothing ran** (§3.3) |

`apps/web`'s standalone run works, confirming step 1's correction to prediction 5: with no
`vitest.config.ts` present, vitest discovers `apps/web/vite.config.ts` and picks up the React
plugin from it. The gap is consistency, not breakage.

The stack trace visible in `apps/web`'s log is **not** a failure — it is
`cloudAuth.test.ts`'s own "returns null rather than throwing when the refresh request fails"
case printing the error it deliberately provokes (`vipper.iam token request failed
(400 invalid_grant)`) to stderr. All 7 files pass.

### 4.2 Finding 2, the migration scripts — CONFIRMED, verbatim

```
$ pnpm --filter @tm/server migration:run
$ tsx ./node_modules/typeorm/cli.js migration:run -d src/database/data-source.ts
Error during migration run:
Error: Unable to open file: "…\apps\server\src\database\data-source.ts".
Cannot find module '…\apps\server\src\database\data-source.ts'
Require stack:
- …\node_modules\typeorm\util\ImportUtils.js
- …\node_modules\typeorm\commands\CommandUtils.js
- …\node_modules\typeorm\commands\SchemaSyncCommand.js
- …\node_modules\typeorm\cli.js
    at Function.loadDataSource (…\CommandUtils.ts:21:19)
    at async Object.handler (…\MigrationRunCommand.ts:42:26)
[ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL] @tm/server@0.76.1 migration:run:
`tsx ./node_modules/typeorm/cli.js migration:run -d src/database/data-source.ts`
Exit status 1
  → exit 1
```

Exactly as predicted: the file on disk is `dataSource.ts`, the script asks for
`data-source.ts`, and it dies before it ever tries to reach a database. Fixed in §5.1.

### 4.3 Finding 4, the unchecked server tests — CONFIRMED

`apps/server/tsconfig.json` excludes `**/*.test.ts` and `"typecheck": "tsc --noEmit -p
tsconfig.json"` reads that same file, so the ten server test suites are invisible to the
typecheck gate. Confirmed by construction rather than by a command — there is no command that
can show a check that isn't happening. What §6 shows instead is what appears once they *are*
checked. Fixed in §5.1.

### 4.4 Finding 5, `apps/web`'s missing vitest config — CONFIRMED as a consistency gap

Runs fine (§4.1). Fixed in §5.2 for parity only.

### 4.5 Finding 7, no `test` task in turbo — CONFIRMED

`turbo.json` defines `build`, `dev`, `typecheck`. No `test`. Fixed in §5.2.

### 4.6 Finding 6, the WSL test — REFUTED AS STATED, and the record is wrong

`wslHost.test.ts` passed here (§2), 13 tests in 4841 ms. Step 1 already established that.

But the phase's own verification section in `docs/plan/README.md` records the opposite,
twice, in two separate sessions:

> `pnpm test` — 122 test files passed, **1 pre-existing failure**
> (`apps/client/src/main/exec/wslHost.test.ts`, the same real-WSL-PATH assertion the last two
> verification steps recorded — environmental, unrelated to this step)

So the same test failed in at least three earlier sessions on this machine and passes in this
one. That is the strongest possible argument for the fix rather than against it: the suite's
result depends on the state of a WSL distro nobody is managing, it is a real-environment
integration test with 30-second timeouts, and it has already been used to normalise a red
gate as "pre-existing". Fixed in §5.3 by moving it behind the repo's existing opt-in pattern —
the assertion itself is untouched.

---

## 5. The fixes

Each entry below is written once it has actually landed, with its own commit.

### 5.1 `apps/server` — the build, the migrations, the unchecked tests

**`apps/server/tsconfig.build.json`** (new) extends `tsconfig.json`, sets `noEmit: false`, and
carries the `exclude` for tests and `dist`. `@nestjs/cli` 10.4.9's `getDefaultTsconfigPath()`
probes for exactly this filename first, so `nest build` picks it up with no change to
`nest-cli.json`.

```
$ rm -rf dist && pnpm build          # in apps/server
  → exit 0
$ ls dist
app.module.js  config  database  entities  iam  main.js  migrations  mirror  presence
$ find dist -name "*.test.js"
  → (nothing)
```

`dist/main.js` exists for the first time. `pnpm build` at the root no longer prints
`WARNING  no output files found for task @tm/server#build`.

**`apps/server/tsconfig.json`** drops `**/*.test.ts` from `exclude`, so `pnpm typecheck`
covers the ten server test suites. Both halves verified by file list rather than by trusting
the config:

```
$ tsc --noEmit -p tsconfig.json      --listFiles | grep -c "apps/server/src.*\.test\.ts"
10
$ tsc --noEmit -p tsconfig.build.json --listFiles | grep -c "apps/server/src.*\.test\.ts"
0
```

**The ten newly-checked test files produced no type errors.** The step expected them to
surface some — "that is the point, not a scope creep" — and they did not:

```
$ pnpm --filter @tm/server typecheck
$ tsc --noEmit -p tsconfig.json
  → exit 0
```

Recorded as a result, not as a fix. What was actually wrong was that nothing was looking; the
ten suites turn out to be type-clean. The value of the change is that this is now true by
check rather than by luck.

**The three `migration:*` scripts** point at `-d src/database/dataSource.ts`. `app.module.ts`
already said `database/dataSource.ts` correctly; the one genuinely stale comment was
`src/database/typeormOptions.ts:4`, now corrected. The script now reaches the database layer
and fails only for want of a server:

```
$ pnpm --filter @tm/server migration:run
  → exit 1
  code: 'ESOCKET',
  originalError: ConnectionError: Failed to connect to localhost:1433 - Could not connect (sequence)
```

That is the step's "Done when" exactly: for want of a database rather than for want of a
file. Getting past it needs Docker Desktop, which §7 records as out of reach here.

### 5.2 The test gate — self-sufficient, and reachable per package

**`turbo.json`** gains a `test` task with `dependsOn: ["^build"]`, so
`turbo run test` schedules the library builds ahead of every package's suite.

**The root `test` script** becomes:

```json
"test": "turbo run build --filter=./packages/* && vitest run",
```

rather than routing the root gate itself through `turbo run test`. Both options were on the
table and this one was chosen deliberately, because of §3.3: `turbo run test` fans out to each
package's own `test` script, so the root gate's *completeness* would depend on all six
packages having one — and a package that lacks it exits 0 in silence. That is the exact
failure mode this report just documented. Keeping the root gate a single `vitest run` keeps it
**discovery-based**: it globs the tree, so a new package's tests are picked up by existing,
and cannot be silently omitted by a missing script. The `turbo run build` prefix supplies the
one thing it was missing.

The counts confirm the two paths agree rather than merely both being green — 124 files either
way, so nothing falls between them:

```
$ pnpm test                       # root, aggregated
 Tasks:    3 successful, 3 total  # the three library builds, first
 Test Files  123 passed | 1 skipped (124)
      Tests  2066 passed | 2 skipped (2068)
  → exit 0

$ pnpm exec turbo run test        # the new task, fanned out
 Tasks:    9 successful, 9 total  # 6 test + 3 build
```

The root `vitest.config.ts` is **not** aliased to source. `apps/web` and `apps/server` import
`@tm/*` as real packages resolved through `exports` to `dist/`, and aliasing would make the
root run test code no consumer actually loads.

**`packages/shared`, `packages/protocol`, `packages/ui`** each gain `test` and `test:watch`
scripts and an explicit `vitest.config.ts`. All six packages now run standalone, and the six
counts sum to the aggregate exactly:

| Command | Exit | Files |
|---------|------|-------|
| `pnpm --filter claude-orchestrator test` | 0 | 67 passed, 1 skipped (68) |
| `pnpm --filter @tm/server test` | 0 | 10 passed |
| `pnpm --filter @tm/web test` | 0 | 7 passed |
| `pnpm --filter @tm/shared test` | 0 | 25 passed |
| `pnpm --filter @tm/protocol test` | 0 | 1 passed |
| `pnpm --filter @tm/ui test` | 0 | 13 passed |
| | | **124 = the aggregate** |

**`apps/web/vitest.config.ts`** (new) — explicit, with the same explanatory header its two
siblings carry. It `mergeConfig`s `./vite.config.ts` rather than replacing it, so the React
plugin the old implicit discovery supplied is still there; the point is to stop relying on
discovery order, not to drop what discovery was providing.

### 5.3 The WSL suite

`apps/client/src/main/exec/wslHost.test.ts`'s real-distro block moves behind
`ORCH_WSL_TEST=1`, the same shape as `wslSession.e2e.test.ts`'s `ORCH_E2E=1`.

**A correction to the step's own framing.** It named
`apps/client/src/main/jira/jiraSync.integration.test.ts` as a second instance of the existing
opt-in pattern. It is not one — that file is fully mocked (its own header: "No Electron and no
SQLite"), gated by nothing, and it runs in the normal gate correctly. `ORCH_E2E` is the only
precedent in this repo, and `ORCH_WSL_TEST` is named to match it.

**Only the real-distro block is gated.** The file's other two `describe`s — the shell
prelude's syntax canary and the relay/`WSLENV` wiring — are pure string assertions that touch
no distro, and they keep running in the gate unconditionally. Gating those would be losing
coverage for nothing.

The assertions themselves are untouched, and both directions were checked:

```
$ pnpm exec vitest run src/main/exec/wslHost.test.ts                    # gate default
 ✓ src/main/exec/wslHost.test.ts (13 tests | 9 skipped) 5ms
      Tests  4 passed | 9 skipped (13)

$ ORCH_WSL_TEST=1 pnpm exec vitest run src/main/exec/wslHost.test.ts    # on demand
      Tests  13 passed (13)
   Duration  2.43s
```

The four pure tests still run, the nine real-WSL ones still pass against the real distro when
asked, and the file's contribution to `pnpm test` drops from **4841 ms to 5 ms**.

`docs/07-packaging-and-release.md` documents the new flag beside `ORCH_E2E`, so it is
discoverable from the same place.

---

## 6. The gates re-run on the fixed tree

The whole of §2–§4's command set, re-run on `f66e3b5`.

| Command | Before | After |
|---------|--------|-------|
| `pnpm typecheck` | 0 — 9/9 | **0 — 9/9**, now including 10 server test files |
| `pnpm test` | 0 — 123 files, 2066 tests | **0 — 123 files, 2057 tests, 11 skipped** |
| `pnpm build` | 0 — 6/6, `@tm/server` emitted nothing | **0 — 6/6, `dist/main.js` written**, no turbo warning |
| `pnpm --filter claude-orchestrator test` | 0 — 68 files | **0 — 68 files** |
| `pnpm --filter @tm/server test` | 0 — 10 files | **0 — 10 files** |
| `pnpm --filter @tm/web test` | 0 — 7 files | **0 — 7 files** |
| `pnpm --filter @tm/shared test` | 0 — *no script, nothing ran* | **0 — 25 files** |
| `pnpm --filter @tm/protocol test` | 0 — *no script, nothing ran* | **0 — 1 file** |
| `pnpm --filter @tm/ui test` | 0 — *no script, nothing ran* | **0 — 13 files** |
| `pnpm --filter @tm/server migration:run` | 1 — `Cannot find module … data-source.ts` | **1 — `ESOCKET … localhost:1433`** |
| clean clone, `pnpm install && pnpm test` | **1 — 15 files failed** | **0 — 124 files** |
| `pnpm --filter claude-orchestrator check:abi` | 0 | **0 — ABI 130 both sides** |

**The one number that moved is `pnpm test`'s test count, and it is not a regression.**
2066 passed / 2 skipped became 2057 passed / 11 skipped — the same 2068 total. The nine that
moved are exactly `wslHost.test.ts`'s real-distro cases, now behind `ORCH_WSL_TEST=1` (§5.3),
where they still pass on demand. No test was deleted or weakened.

The clean-clone run, which is the one that was red:

```
$ git clone --no-hardlinks . /c/tmp/tmclean3 && cd /c/tmp/tmclean3 && git checkout f66e3b5
$ pnpm install
  → exit 0
$ pnpm test                             # no pnpm typecheck first
 Tasks:    3 successful, 3 total
 Test Files  123 passed | 1 skipped (124)
      Tests  2057 passed | 11 skipped (2068)
  → exit 0
```

Identical counts to the developed worktree, from an empty `node_modules` and no
`packages/*/dist`, with the three commands in any order.

### Every failure §2–§4 recorded, and what happened to it

| Finding | Status |
|---------|--------|
| 1 — `nest build` fails for want of a tsconfig | Refuted by step 1; **but §3.1 found the real defect underneath it** — fixed (§5.1) |
| 2 — `migration:*` scripts name a file that does not exist | Fixed (§5.1) |
| 3 — `pnpm test` is order-coupled to `pnpm typecheck` | Fixed (§5.2), proved by clean-clone reproduction then repair |
| 4 — no server test is typechecked | Fixed (§5.1); the ten files turned out type-clean |
| 5 — `apps/web` has no vitest config | Fixed (§5.2), consistency only |
| 6 — the WSL assertion cannot be green here | Refuted as stated; **gated anyway** (§5.3), with the reasoning recorded |
| 7 — no `test` task, three packages with no `test` script | Fixed (§5.2) |
| §3.1 — `nest build` emits nothing (new) | Fixed (§5.1) |
| §3.3 — a missing `test` script exits 0 in silence (new) | Fixed (§5.2) |

Nothing is left in the "environmental, leave it" column at the test level. The two items that
genuinely cannot be closed on this machine are in §7, and neither is a test failure.

---

## 7. What this machine could not close

Recorded, not acted on:

- **`@tm/server` has never been booted against a real SQL Server.** Its `AppModule` opens a
  TypeORM/mssql connection at boot, so it cannot start without a reachable database, and this
  step was explicitly not to attempt `docker compose up`. The phase's own earlier
  verification section records Docker Desktop failing to come healthy on this machine
  (`request returned 500 Internal Server Error` from `dockerDesktopLinuxEngine`) across two
  restart attempts. §5.1 makes `dist/main.js` exist for the first time, which is a
  precondition for that boot, not a substitute for it.
- **`package:local` still dies at the NSIS `MAX_PATH` link step.** `!include: could not find
  … StdUtils.nsh`, at a path 279 characters long against Windows' 260-character limit — a
  function of this worktree's path plus pnpm's `.pnpm` store naming, not of any code here.

---

## 8. Step 3 — independent verification

Everything above was written by the step that *made* the fixes. This section is step 3 of the
plan re-running the same commands against `2bc3936` without reusing any of step 2's results,
so the report is confirmed by a run that had nothing invested in it being green.

**One methodological finding came out of doing that, and it changes how §2–§6 should be read.**

### 8.1 A cached gate is not a gate — NEW

The first command of this step reproduced §6's typecheck result in 47 milliseconds:

```
$ pnpm typecheck
 Tasks:    9 successful, 9 total
Cached:    9 cached, 9 total
  Time:    47ms >>> FULL TURBO
  → exit 0
```

Nothing was typechecked. Turbo replayed step 2's stored stdout, exit code included, because
the input hashes had not moved. A verification step that accepts this has verified that a
previous run once passed — not that the tree passes now. It is the same class of mistake as
[`noEmit` making `nest build` a no-op](#31-nest-build-succeeds-and-emits-nothing--new): a
green exit code standing in for work that did not happen.

So every turbo-routed gate below was re-run with `--force`, and `pnpm build` additionally had
`apps/server/dist` deleted first so the emit had to be produced rather than found.

### 8.2 The three root gates, forced, in RELEASE.md §1 order

| # | Command | Exit | Result |
|---|---------|------|--------|
| 1 | `turbo run typecheck --force` | **0** | 9 successful, 9 total — **0 cached**, 22.291s |
| 2 | `pnpm test` | **0** | 123 files passed, 1 skipped; 2057 passed, 11 skipped; 39.92s |
| 3 | `turbo run build --force` | **0** | 6 successful, 6 total — **0 cached**, 24.129s, no turbo warning |

`pnpm test` is not turbo-cached — the root script is `turbo run build --filter=./packages/* &&
vitest run`, and `vitest run` executes every time — so it needed no `--force`.

The build's emit, after `rm -rf apps/server/dist`:

```
$ ls apps/server/dist
app.module.js  config  database  entities  iam  main.js  migrations  mirror  presence
$ ls -l apps/server/dist/main.js
-rw-r--r-- 1 wdemb 197609 1134 Aug 10 10:03 dist/main.js
$ find apps/server/dist -name "*.test.js" | wc -l
0
```

`dist/main.js` is produced from nothing, and no test file rides along into it. §5.1 holds.

```
$ pnpm --filter claude-orchestrator check:abi
ABI check OK: better_sqlite3.node and Electron both at ABI 130.
  → exit 0
```

### 8.3 The six standalone suites, and a stronger check than §5.2 made

| Command | Exit | Files | Tests |
|---------|------|-------|-------|
| `pnpm --filter claude-orchestrator test` | 0 | 67 passed, 1 skipped (68) | 1222 passed, 11 skipped (1233) |
| `pnpm --filter @tm/server test` | 0 | 10 passed | 44 passed |
| `pnpm --filter @tm/web test` | 0 | 7 passed | 60 passed |
| `pnpm --filter @tm/shared test` | 0 | 25 passed | 515 passed |
| `pnpm --filter @tm/protocol test` | 0 | 1 passed | 12 passed |
| `pnpm --filter @tm/ui test` | 0 | 13 passed | 204 passed |
| | | **124** | **2068** |

§5.2 summed the six **file** counts and got the aggregate's 124. Summing the six **test**
counts as well gives 2068 — the aggregate's exact total, 2057 passed plus 11 skipped. That is
the stronger statement: the two paths do not merely cover the same number of files, they run
the same number of tests, so no suite is being collected by one path and quietly dropped by
the other. All 11 skips resolve to `apps/client` (9 WSL + 2 e2e), which is where §5.3 and
`ORCH_E2E` put them.

### 8.4 Finding 3, proved by A/B rather than by one green run

The clean-order check, in a throwaway clone outside this worktree, **no `pnpm typecheck`
first**:

```
$ git clone --no-hardlinks . /c/tmp/tmverify3 && cd /c/tmp/tmverify3 && git checkout 2bc3936
$ ls -d packages/*/dist apps/server/dist
ls: cannot access 'packages/*/dist': No such file or directory
ls: cannot access 'apps/server/dist': No such file or directory

$ pnpm install
  → exit 0 — "Done in 23.1s using pnpm v11.18.0"

$ pnpm test
 Tasks:    3 successful, 3 total
 Test Files  123 passed | 1 skipped (124)
      Tests  2057 passed | 11 skipped (2068)
  → exit 0
```

**A green run here proves nothing on its own** — it is equally consistent with the fix
working and with the check having stopped being able to fail. So the same procedure was run
against `d790147`, the merge commit before the fixes, on the same machine, the same day, the
same pnpm 11.18.0:

```
$ git clone --no-hardlinks . /c/tmp/tmprefix && cd /c/tmp/tmprefix && git checkout d790147
$ pnpm install
  → exit 0 — "Done in 23.5s using pnpm v11.18.0"
$ pnpm test
 Test Files  15 failed | 108 passed | 1 skipped (124)
      Tests  1875 passed | 2 skipped (1877)
  → exit 1
```

with the same six unresolvable specifiers §3.2 recorded:

```
Failed to load url @tm/protocol/cadence   … in apps/web/src/board/BoardPoller.test.ts
Failed to load url @tm/shared/attachments … in packages/ui/src/AttachmentStrip.tsx
Failed to load url @tm/shared/board       … in packages/ui/src/board/chainArrows.ts
Failed to load url @tm/shared/iamPkce     … in apps/web/src/auth/cloudAuth.ts
Failed to load url @tm/shared/model       … in packages/ui/src/modelChoice.ts
Failed to load url @tm/shared/taskChain   … in packages/ui/src/board/boardColumns.test.ts
```

Red before, green after, one variable changed. Finding 3 is fixed, and the check that says so
is one that demonstrably still knows how to fail.

Note the four specifiers whose failing file is a **source** module, not a test — `.tsx`/`.ts`
under `packages/ui` and `apps/web`. That is §3.2's point reproduced independently: the blast
radius is the module graph, not the set of test files that name `@tm/*`.

### 8.5 The remaining findings, re-checked

**Finding 4** — by file list rather than by reading the config, which is the only way to see a
check that is or isn't happening:

```
$ tsc --noEmit -p tsconfig.json       --listFiles | grep -c "apps/server/src.*\.test\.ts"
10
$ tsc         -p tsconfig.build.json  --listFiles | grep -c "apps/server/src.*\.test\.ts"
0
```

Ten test files typechecked, zero compiled into the build. Both halves of §5.1's split confirmed.

**Finding 2** — `apps/server/package.json` now names `-d src/database/dataSource.ts` in all
three scripts, and `ls src/database/` shows `dataSource.ts` and `typeormOptions.ts`. Running it
reproduces §5.1's outcome:

```
$ pnpm --filter @tm/server migration:run
Error during migration run:
ConnectionError: Failed to connect to localhost:1433 - Could not connect (sequence)
  code: 'ESOCKET'
```

Failing for want of a database, not for want of a file. Unchanged from §5.1, and still
un-closable here for the reason in §7.

**Finding 6** — both directions, confirming the nine gated tests were parked and not lost:

```
$ pnpm exec vitest run src/main/exec/wslHost.test.ts                   # gate default
      Tests  4 passed | 9 skipped (13)
   Duration  462ms

$ ORCH_WSL_TEST=1 pnpm exec vitest run src/main/exec/wslHost.test.ts   # on demand
      Tests  13 passed (13)
   Duration  2.60s
```

The nine still pass against the real Ubuntu-20.04 distro when asked. §5.3's 4841 ms → 5 ms
claim reads as 462 ms here against a cold vitest start; the tests themselves report 5 ms.

### 8.6 The two prohibitions

- **The app was never launched.** No `pnpm dev`, no `electron`, no packaged binary. The only
  Electron the step touched is `electron-builder install-app-deps` inside `pnpm install`, and
  `check:abi`, which reads the module header off disk.
- **No release was cut.** `git tag --contains origin/development..HEAD` is empty (73 tags in
  the repo, none on this branch), and step 3 added no version bump. Worth recording for step 4:
  the branch has already moved the version of record from a root `0.74.3` on `development` to
  `apps/client` at `0.78.6`, with the root becoming a private `0.0.0` workspace — that
  restructure arrived with the cloud branch, and whatever releases this eventually is has a
  bump question to answer that this step deliberately did not.

### 8.7 Verdict

Every row of §6 reproduced, plus the negative control §6 did not run. The clean-clone check was
run against `2bc3936`, the last commit on this branch that touches code or configuration; step 3
adds documentation only, so no gate result above can be changed by the commit that records it.

Nothing in §2–§4 is left unfixed or unexplained. The two items in §7 remain open, and neither
is a test failure: `@tm/server` has still never been booted against a real SQL Server, and
`package:local` still dies at the NSIS `MAX_PATH` limit.
