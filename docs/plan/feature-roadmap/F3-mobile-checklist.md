# F3.10 — mobile verification checklist

> **Status:** run and passing — see [F3](F3-mobile-review-cockpit.md) task F3.10.
> **Not a plan file** — unlike its sibling roadmap files, nothing here is imported as a
> project plan, so rows are a plain table, not `- [ ]` checkboxes.

## Purpose

Proves the F3 compact review cockpit actually works at phone width, in a real browser,
against the real built `@tm/web` bundle — not a jsdom stand-in (`apps/web/vitest.config.ts`
has no DOM environment at all, so none of this repo's `*.test.ts` files ever mount the
compact shell). Every flow a reviewer needs on a phone runs once per device size below;
every row must read PASS before this ticket is done.

## Device sizes

Both are **compact** layout (`layoutMode` < 640 px, `packages/ui/src/layout/viewport.ts`):

- **375 × 667** (iPhone SE / 8)
- **414 × 896** (iPhone 11 / XR)

## How to re-run

```
node scripts/verify-mobile.mjs
```

Boots a fake HTTP relay server and real headless Chrome (via CDP) against the real built
`@tm/web` bundle, runs all seven rows below at both sizes, and prints `PASS`/`FAIL` per check.
It exits non-zero if any check fails anywhere. Screenshots land under the run's own scratch
directory, printed at the end of the run.

## Checks every row asserts, on every screen it visits

- No horizontal overflow: `document.documentElement.scrollWidth <= window.innerWidth`.
- Every tapped target measures at least 44 × 44 px (`getBoundingClientRect`).
- A screenshot is saved to the harness's scratch dir, named for the row, the size, and the
  step within the row.

## Results

| Flow                              | Size    | Steps                                                                                                                | Expected                                                                                                                                                                     | Result | Build              |
| --------------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ------------------ |
| 1. Sign-in                        | 375×667 | No token → `SignInScreen`; seeded refresh token answered `invalid_grant`; seeded good token.                         | Zero `/v1` requests with no token; "session has expired" on `invalid_grant` (never an empty board); seeded inbox renders with a good token.                                  | PASS   | v0.189.0 @ cbd7568 |
| 1. Sign-in                        | 414×896 | Same as above.                                                                                                       | Same as above.                                                                                                                                                               | PASS   | v0.189.0 @ cbd7568 |
| 2. Answer a question              | 375×667 | Tap a single-select chip (auto-send); partially answer a two-question item, then complete it and tap "Send answer".  | `attention:answer` recorded with `{decision:'answers', selections:[[label]]}` and the item leaves the inbox; the partial answer sends nothing, the completed one sends once. | PASS   | v0.189.0 @ cbd7568 |
| 2. Answer a question              | 414×896 | Same as above.                                                                                                       | Same as above.                                                                                                                                                               | PASS   | v0.189.0 @ cbd7568 |
| 3. Approve a plan                 | 375×667 | Open the plan-approval item, scroll the plan, leave the note empty, tap "Approve plan".                              | The plan scrolls inside its own region with "Approve plan" staying on screen (sticky); "Re-plan" is disabled with an empty note; server records `{decision:'approve'}`.      | PASS   | v0.189.0 @ cbd7568 |
| 3. Approve a plan                 | 414×896 | Same as above.                                                                                                       | Same as above.                                                                                                                                                               | PASS   | v0.189.0 @ cbd7568 |
| 4. Move a card                    | 375×667 | Board tab → column tab → "More actions" → "Move to…" → "IN REVIEW".                                                  | `PATCH /v1/tasks/:id {toColumn:'in-review'}` recorded; the "IN REVIEW (n)" count goes up; the card shows in that column.                                                     | PASS   | v0.189.0 @ cbd7568 |
| 4. Move a card                    | 414×896 | Same as above.                                                                                                       | Same as above.                                                                                                                                                               | PASS   | v0.189.0 @ cbd7568 |
| 5. Comment on and send a review   | 375×667 | Open `#/card/<id>/changes`, select a line, comment, save; tap "Send review".                                         | `review:add` recorded with that line and body; `review:send` called exactly once.                                                                                            | PASS   | v0.189.0 @ cbd7568 |
| 5. Comment on and send a review   | 414×896 | Same as above.                                                                                                       | Same as above.                                                                                                                                                               | PASS   | v0.189.0 @ cbd7568 |
| 6. Rotate mid-draft               | 375×667 | Type into a plan note (and, separately, an open review comment draft); rotate across the 640 px breakpoint and back. | The route, the typed text, and the chip selection all survive the round trip, for both drafts.                                                                               | PASS   | v0.189.0 @ cbd7568 |
| 6. Rotate mid-draft               | 414×896 | Same as above.                                                                                                       | Same as above.                                                                                                                                                               | PASS   | v0.189.0 @ cbd7568 |
| 7. Desktop unreachable mid-answer | 375×667 | Type an answer, flip the unreachable flag, tap "Send answer"; clear the flag, tap "Try again".                       | Draft text/selections are kept, "Try again" shows, the item stays in the inbox (never "answered"); clearing the flag and retrying sends the answer exactly once.             | PASS   | v0.189.0 @ cbd7568 |
| 7. Desktop unreachable mid-answer | 414×896 | Same as above.                                                                                                       | Same as above.                                                                                                                                                               | PASS   | v0.189.0 @ cbd7568 |

## Build stamp

Fresh full run, both sizes, all 7 rows:

- **Version:** 0.189.0 (`apps/client/package.json`)
- **Commit:** `cbd7568` — fix(web): stop signed-in screens crashing on load
- **Chrome:** 155.0.8059.40
- **Date:** 2026-10-15
- **Harness:** `node scripts/verify-mobile.mjs` — 110 checks, ALL PASS
