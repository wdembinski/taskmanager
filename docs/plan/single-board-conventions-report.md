# Single board for all tickets — did this branch follow its own conventions?

Step 10 of this branch's plan (`feat/single-board-for-all-tickets-and`), the last one. The
plan's own conventions section makes four claims about how every phase would be built. Each
was checked against the nine commits this branch actually produced (`ef614d0`..`486dc9d`),
not assumed from having written the earlier steps.

## 1. Contract first: `shared/src/ipc.ts` → `handle()` in `main/ipc.ts` → `invoke` in React

Held. Every commit that widened the IPC surface touched `packages/shared/src/ipc.ts` and
`apps/client/src/main/ipc.ts` **in the same commit** — `ef614d0` (6 / 43 lines),
`9a7edc4` (40 / 47 lines), `5709354` (31 / 25 lines), `2f66579` (12 / 15 lines). Commits that
only consumed an already-widened contract (`cb9c121`, `2fcf831`) correctly touched no shared
or main-process file at all. `abb850a` (the Projects screen) needed no new channels, so it
touched neither. No commit added a `handle()` branch without a matching type on the contract,
or an `invoke` call the contract didn't already describe.

## 2. One phase, one commit, Conventional Commits, subject ≤ 50 chars, version bump in the same commit

Partially held. All nine commits are one phase each, and all nine use a correct Conventional
Commits type/scope (`refactor(projects)`, `feat(board)`, `feat(projects)`, `test`, `docs`) that
matches what the commit actually contains. Two sub-rules did not hold:

**Subject length** — four of nine exceed 50 characters:

| Commit    | Subject                                                              | Length |
| --------- | --------------------------------------------------------------------- | -----: |
| `ef614d0` | `refactor(projects): derive project capabilities from fields, drop kind discriminator` | 84 |
| `9a7edc4` | `refactor(projects): fold agentProject:* into project:*`             |     54 |
| `abb850a` | `feat(projects): build the Projects management screen`               |     52 |
| `486dc9d` | `docs: walk the critical files, and hand over the merge`             |     54 |

**Version bump** — did not hold, for any commit. `apps/client/package.json` reads
`"version": "0.86.0"` at the branch's base (`0079851`) and still reads `"version": "0.86.0"`
at the tip (`486dc9d`) — unchanged across all six `feat`/`refactor` phases. Per the stated rule
(`feat` → MINOR, pre-1.0) this branch owes at least one MINOR bump, and arguably one per `feat`
commit.

This is not a paperwork gap. `origin/development` has moved to `"0.89.6"` while this branch sat
at `"0.86.0"` — three minor releases and several patches ahead, all shipped from `development`
independently while this branch was in flight (`git log origin/development -- apps/client/package.json`
shows `v0.89.5`, `v0.89.3`, ... between this branch's base and today). Bumping `0.86.0` now
would not just conflict textually on the version line, it would produce a version *behind*
what has already shipped. This is the same shape as the known
"a branch that outlives a release always conflicts on the version line" trap — the fix is not
a mechanical bump on this branch, it's re-laddering onto `development`'s current version once
the integrator has resolved which design survives (see `single-board-gate-report.md`'s 44
conflict markers / 14 files). Doing that here, on a branch whose merge destination is not yet
decided, would produce a version number that is wrong the moment it's chosen. Left for the
integrator alongside the design decision.

## 3. `pnpm format` before every commit

Held, as far as it can be checked after the fact. Git history doesn't record whether format
ran before each individual commit, but the finished tip (`4799804`, re-checked at `486dc9d` in
the previous step) runs `pnpm format:check` clean with exit 0 — see `single-board-gate-report.md`.
Had an earlier phase skipped it and a later phase's formatter pass silently absorbed the
drift, that would still show up as clean today, so this is as strong a claim as history allows.

## 4. Never launch the Electron app on this machine; verify headlessly

Held. No phase in this branch's history launched the packaged app or `electron .` directly —
verification ran through the headless script built in Phase 8
(`docs/plan/single-board-gate-report.md`'s gate table: format, typecheck, build, and the 2983-test
suite, all forced and re-run on the finished tip rather than trusted from an earlier
measurement).

## Net

Three of four conventions held throughout. The fourth — version bumps — did not happen at all,
and by the time this was checked, fixing it locally would be worse than leaving it: the correct
number depends on a merge decision (`single-board-gate-report.md`) this step still cannot make.
Both gaps are handed to the same integrator, for the same reason — neither is a mechanical fix
from inside this branch.
