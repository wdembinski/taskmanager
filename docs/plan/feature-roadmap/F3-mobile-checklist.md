# F3.10 — mobile verification checklist

> **Status:** checklist written, not yet run (step 1 of 3 — see
> [F3](F3-mobile-review-cockpit.md) task F3.10). The harness that runs these rows is
> step 2; results and the build stamp are recorded in step 3, below each row.
> **Not a plan file** — unlike its sibling roadmap files, nothing here is imported as a
> project plan, so rows are plain numbered lists, not `- [ ]` checkboxes.

Every row runs twice, once per phone size, both **compact** layout (`layoutMode` < 640 px,
`packages/ui/src/layout/viewport.ts`):

- **375 × 667** (iPhone SE / 8)
- **414 × 896** (iPhone 11 / XR)

## Checks every row asserts, on every screen it visits

- No horizontal overflow: `document.documentElement.scrollWidth <= window.innerWidth`.
- Every tapped target measures at least 44 × 44 px (`getBoundingClientRect`).
- A screenshot is saved to the harness's scratch dir, named for the row, the size, and the
  step within the row.

The harness exits non-zero if any check fails anywhere, and prints `PASS`/`FAIL` per row per
size, plus the build version stamp.

## Rows

### 1. Sign-in

- With no token, `SignInScreen` renders and the fake server sees **zero** `/v1` requests
  (memory *pat-page-bootstrap-deadlock*).
- When `/token` answers `invalid_grant`, the sign-in page shows "session has expired" and
  never draws an empty board (memory *a-session-that-had-ended*).
- With a seeded token, the inbox renders the seeded items.

**Result:** _(pending — recorded in step 3)_

### 2. Answer a question

- Tap the single-select row, then tap a chip. This auto-sends: the server records
  `attention:answer` with `{decision:'answers', selections:[[label]]}`, and the item leaves
  the inbox.
- For the multi-question item, a partial answer sends nothing. After answering both,
  "Send answer" sends once.

**Result:** _(pending — recorded in step 3)_

### 3. Approve a plan

- Open the plan-approval item. The long plan scrolls inside its own region, and
  "Approve plan" stays inside the viewport (it is sticky).
- Re-plan is disabled with an empty note.
- Tap Approve plan. The server records `{decision:'approve'}`.

**Result:** _(pending — recorded in step 3)_

### 4. Move a card

- Board tab → the column tab → More actions → Move to… → IN REVIEW.
- The server records `PATCH /v1/tasks/:id {toColumn:'in-review'}`, the `IN REVIEW (n)` count
  goes up, and the card shows in that column.

**Result:** _(pending — recorded in step 3)_

### 5. Comment on and send a review

- Go to `#/card/<id>/changes` and open the file.
- Tap "Select line N" → Comment → type → save. The server records `review:add` with that
  line and body.
- Tap Send review. The server records `review:send` exactly once.

**Result:** _(pending — recorded in step 3)_

### 6. Rotate mid-draft

- Type into the plan note (or a question's free text). Rotate to 667 × 375 (or 896 × 414),
  which is ≥ 640 px and so **medium** layout, then rotate back.
- The route, the typed text and the chip selection all survive. Repeat with an open review
  comment draft.

**Result:** _(pending — recorded in step 3)_

### 7. Desktop unreachable mid-answer

- Type an answer and flip the unreachable flag, then tap Send answer.
- The draft text is kept, "Try again" shows, and the item is still in the inbox. The view
  never shows "answered".
- Clear the flag and tap Try again. The answer is recorded once.

**Result:** _(pending — recorded in step 3)_

## Build stamp

_(pending — recorded in step 3, alongside the gate run)_
