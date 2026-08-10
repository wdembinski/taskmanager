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

`apps/client/src/main/exec/wslHost.test.ts` moves behind `ORCH_WSL_TEST=1`, the same shape as
`wslSession.e2e.test.ts` (`ORCH_E2E=1`) and `jiraSync.integration.test.ts`
(`ORCH_JIRA_TEST=1`). The assertions are unchanged.

---

## 6. The gates re-run on the fixed tree

*(§6 is written by the re-run at the end of this step; see the numbers below.)*

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
