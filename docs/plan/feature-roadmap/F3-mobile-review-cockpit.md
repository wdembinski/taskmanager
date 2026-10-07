# F3 — Mobile review cockpit

> **Status:** proposed · **Where:** web (`apps/web`, `packages/ui`) · **Depends on:** F6 (in-app code review) for Phase 4 only. Phases 1–3 can ship before F6. · **Unlocks:** overnight autonomy (F1) becomes manageable from a phone
> Only the `- [ ]` checkboxes under **Tasks** become cards when this file is imported as a plan; everything else is context.

## Why

Autonomy is only worth as much as the speed at which a human can unblock it. An agent waiting on
a plan approval or a question at 23:00 waits until somebody opens a laptop. The web app already
reaches the desktop from anywhere, but it is a desktop layout in a browser: five side-by-side
board columns, a nav rail, a side pane, drag-and-drop, and hover-only affordances. On a phone that
is unusable.

F3 makes a phone a first-class cockpit for the four things that unblock work:

- answering what is waiting (questions, permissions, plan approvals, failures);
- reading a card;
- moving it;
- reviewing its diff.

## What we have today

- The web shell renders the desktop's own shell, board and `TaskDetail`
  (`packages/ui/src/shell/AppShell.tsx`, `NavRail.tsx`, `StatusBar.tsx`;
  `apps/web/src/board/BoardScreen.tsx`). See memory *web-mirrors-the-desktop*.
- **There are no responsive breakpoints anywhere.** The only `@media` rules in `packages/ui`
  are `prefers-reduced-motion`.
- The attention inbox: `'attention:list'`, `'attention:answer'` and `'attention:dismiss'`
  (`packages/shared/src/ipc.ts:726–741`), with kinds `permission`, `question`,
  `merge-conflict`, `task-failed`, `proposal`, `plan-approval` and `agent-question`
  (`packages/shared/src/attention.ts`). UI: `packages/ui/src/Attention.tsx`,
  `AgentQuestionForm.tsx`, `attentionIndex.ts`.
- The board model: columns `todo | in-progress | in-review | blocked | done`
  (`packages/shared/src/model.ts:89`); `'task:move'`. Moving to a column transitions the JIRA
  ticket (memory *jira-transitions-on-every-move*). The layout lives in
  `packages/ui/src/board/*` (`KanbanColumn.tsx`, `TaskCard.tsx`, drag in `chainDrag.ts`).
- Web transport and banners: `apps/web/src/board/httpTransport.ts`, `UnreachableBanner.tsx`,
  `StaleBanner.tsx`, `SkewBanner.tsx`, `ClientPicker.tsx`, and `presence.ts` with
  `browserFocusSignal.ts`. These drive the 2.5 s/25 s cadence
  (`packages/protocol/src/cadence.ts`).
- Sign-in and token pages: `apps/web/src/auth/cloudAuth.ts`, `apps/web/src/settings/*`. Memory
  *pat-page-bootstrap-deadlock*: the token page must never be gated on a relayed read.
- Questions time out. A 1800 s AskUserQuestion timeout once left a finished step Running (memory
  *a-question-nobody-answered-in-time*).

## Design

### Data model & contracts

- **No new engine data.** F3 is presentation over existing channels, plus one pure module:
  `packages/ui/src/layout/viewport.ts`.
  - `layoutMode(widthPx) → 'compact' | 'medium' | 'wide'`, with **compact < 640 px**,
    **medium 640–1023 px** and **wide ≥ 1024 px**. Wide is today's layout, unchanged.
  - The same numbers are exported for Griffel `@media` rules, so CSS and state can never drift
    (two copies of a breakpoint drift apart, so the number lives in one place).
- Two derived, pure selectors:
  - `attentionUrgency(item, now)` sorts the inbox. Order: questions with a countdown, then plan
    approvals, permissions, merge conflicts, failures and proposals; oldest first within a kind.
  - `questionDeadline(item)` gives the remaining time before the CLI's question timeout, or
    `expired`.
- Navigation state for compact mode is a small hash route
  (`#/inbox`, `#/board/<column>`, `#/card/<id>/<section>`), so the phone's back button and
  gesture work. Wide mode ignores the route segments it does not use.

### Engine / desktop main process

None — every action F3 exposes (answer, dismiss, move, chat, approve plan, review) is an existing
channel. Classification already happens in `packages/shared/src/ipcRelay.ts`. Phase 4 consumes
F6's channels.

### Server & relay

- No new endpoints.
- A phone is just another web session for presence. Focused, it holds the account on the 2.5 s
  tier; backgrounded, `visibilitychange` already reports unfocused. **No cadence change:** a
  phone in a pocket must not keep the account on the fast tier, and the existing focus signal
  already ensures that.
- An expired question is answered as a chat message (the existing `'task:chat'`). The cockpit
  does not invent a "resume with answer" channel in v1.

### UI — desktop

None — the desktop window keeps its current layout. Shared components gain compact variants
that only the web's compact mode selects, and wide-mode rendering is byte-for-byte the existing
path.

### UI — web

Compact mode (phones), in concrete terms:

- **Shell:**
  - A **bottom tab bar** replaces `NavRail`: **Inbox** (with badge), **Board**, **Search** and
    **Settings**. A bottom bar is reachable with a thumb and keeps the context in view, which a
    drawer does not.
  - `StatusBar`'s content moves into a one-line status strip at the top that merges the
    Unreachable, Stale and Skew banners into a single strip naming the worst condition.
  - `100dvh`, `env(safe-area-inset-*)` padding, and `<meta name="viewport"
    content="width=device-width, initial-scale=1, viewport-fit=cover">`.
- **Inbox is home.** A list sorted by `attentionUrgency`. Each row shows the card title, the
  kind, the age, and a countdown for questions. Tapping a row opens a full-screen answer view:
  - `agent-question`: option chips at least 44 px tall. A single-select question resolves on one
    tap; multiple questions are collected and sent once. An expired question shows "the agent
    moved on — your answer will be sent as a chat message".
  - `permission`: the tool and input, rendered readably, with Allow / Deny.
  - `plan-approval`: the full plan as readable markdown, with **Approve** and **Request
    changes** (a note box).
  - `merge-conflict` / `task-failed`: the reason and the conflicted files, plus Open card /
    Retry where the existing actions allow it.
- **Board:**
  - One column at a time. A segmented column switcher across the top shows a count per column,
    and you swipe or tap to switch.
  - Cards render as full-width rows.
  - **No drag-and-drop on touch.** A card's "Move to…" opens a bottom action sheet listing the
    columns. It is the same `'task:move'`, so JIRA transitions still happen.
  - Chain arrows are hidden in compact mode, and a card shows a "step n of m" label instead.
- **Card:** a full-screen route with a back button. `TaskDetail`'s sections become a top
  segmented control (**Chat · Steps · Changes · Details**). The composer is pinned above the
  keyboard.
- **Review** (Phase 4, needs F6): the file list is a bottom sheet and the diff is unified, with a
  **wrap long lines** toggle (on by default). There are no hover affordances: tap a line number
  to select it (tap a second line for a range), then **Comment** in a bottom sheet. **Send
  review** sits in a sticky footer.
- **Touch rules everywhere in compact mode:**
  - every target is at least 44 × 44 px;
  - no hover-only control;
  - no tooltip-only information;
  - long-press is never the only way to reach an action.
- **Medium mode (tablets):** the wide layout with the nav rail collapsed to icons, the board
  scrolling horizontally, and the card pane as an overlay sheet instead of a split.
- **Install:** a web app manifest and icons, so the cockpit can be added to the home screen.
  There is no service worker in v1.

### Failure modes & edge cases

- **The desktop is unreachable** while you answer: the answer goes out as a relayed command and
  fails like any other relayed command. The answer view keeps the typed text and shows the strip
  state. It must not show "answered" before the relay confirms it.
- **An item is resolved elsewhere** (answered on the desktop) while it is open on the phone:
  `'attention:resolved'` arrives and the view closes with "answered on another device".
- **A question expires while it is open:** the countdown reaches zero and the view switches to
  the chat-message fallback without losing the selection.
- **The token or session expired on the phone** (memory *a-session-that-had-ended*): the compact
  shell must render the sign-in page. It must never draw an empty board as if signed in, and
  never gate the token page on a relayed `settings:get` (memory *pat-page-bootstrap-deadlock*).
- **Rotation or resize across a breakpoint:** layout mode changes without losing the open
  card, the answer draft, or the comment draft. The state lives above the layout switch.
- **A very long plan or diff on a small screen:** it scrolls inside its own region, and the
  action buttons stay sticky.

## Out of scope (v1)

- Web push notifications and an offline mode or service worker. Notifying a phone when
  something needs it belongs with F1 (triggers) and F2 (activity) and needs push
  infrastructure we do not have.
- Native mobile apps.
- Editing agent settings, projects or integrations on a phone. Settings stays reachable but is
  not redesigned.
- Phone layouts for the Projects, Gantt and Git graph screens.
- Voice input (that is F9).

## Open questions

- **Bottom tab bar or drawer?** Recommended: **bottom tab bar**. There are only four
  destinations, and triage is a thumb task.
- **Should the desktop window also get compact mode when narrowed?** Recommended: **no** for
  v1. Keep the desktop path untouched and limit the risk to the web.
- **Expired question: chat fallback, or a new "resume with answer" engine channel?**
  Recommended: chat fallback in v1. Revisit if agents misread it.
- **Swipe between columns, or tap only?** Recommended: tap on the switcher, with swipe as a
  progressive extra. A swipe must never be the only way.

## Tasks

### F3 · Phase 1 — Layout foundation

- [ ] F3.1 Add the viewport layout module and mobile document setup to apps/web

  - `packages/ui/src/layout/viewport.ts` (`layoutMode`, breakpoint constants for Griffel, and a `useLayoutMode` hook on `matchMedia`); the viewport meta, `100dvh` and safe-area padding in `apps/web/index.html` and the root styles.
  - Acceptance: unit tests for `layoutMode` at 0/639/640/1023/1024 px; a test that the Griffel media strings are built from the same constants; web build green.
- [ ] F3.2 Build the compact app shell with a bottom tab bar and one status strip @needs: F3.1 Add the viewport layout module and mobile document setup to apps/web

  - A compact variant of `AppShell`. `NavRail` becomes a bottom bar (Inbox with badge, Board, Search, Settings). A pure `worstConnectionState(unreachable, stale, skew)` picks the one strip message. Hash routes are `#/inbox`, `#/board/<col>` and `#/card/<id>/<section>`, with a pure route parser.
  - Acceptance: tests for the route parser (including unknown and malformed hashes) and `worstConnectionState`; sign-in and the token page render without any relayed read (memory *pat-page-bootstrap-deadlock*); the wide layout is unchanged (`pnpm build` green, no diff in the wide-mode components).

### F3 · Phase 2 — Inbox-first triage

- [ ] F3.3 Build the compact Inbox screen with urgency sort and question countdowns @needs: F3.2 Build the compact app shell with a bottom tab bar and one status strip

  - Pure `attentionUrgency` and `questionDeadline` in `packages/ui/src/attentionIndex.ts` (or next to it); the compact inbox list rows; and close-on-`attention:resolved` with "answered on another device".
  - Acceptance: tests for sort order across all seven kinds, deadline math including expired, and resolved-elsewhere handling in the inbox state.
- [ ] F3.4 Build full-screen touch answer views for questions, permissions and plan approvals @needs: F3.3 Build the compact Inbox screen with urgency sort and question countdowns

  - `AgentQuestionForm` compact variant: 44 px chips, one-tap single-select, a combined send for multiple questions, and the expired-question chat fallback through `'task:chat'`. Permission Allow/Deny; plan approval with a markdown reader, Approve and Request changes (with a note). Drafts survive a layout-mode change.
  - Acceptance: pure state-machine tests for the answer form (partial answers never sent, expiry mid-edit keeps the selection, relay failure keeps the draft and never reports "answered").

### F3 · Phase 3 — Board and card on a phone

- [ ] F3.5 Render the board as one column at a time with a column switcher @needs: F3.2 Build the compact app shell with a bottom tab bar and one status strip

  - A segmented switcher with counts (a pure selector over the existing board selectors), full-width card rows, chain arrows hidden, and a "step n of m" label.
  - Acceptance: selector tests for counts and the active column via `#/board/<col>`; folded and shelved cards counted the same way the wide board counts them.
- [ ] F3.6 Replace drag with a Move to action sheet on touch @needs: F3.5 Render the board as one column at a time with a column switcher

  - A bottom sheet listing the columns and calling `'task:move'` (so JIRA transitions still happen, memory *jira-transitions-on-every-move*). A running card stays movable: an agent run never blocks a human move (memory *card-state-is-the-humans*), so the sheet offers exactly what the wide board's drop targets allow.
  - Acceptance: tests that the sheet's enabled columns equal the wide board's allowed drop targets for the same card state.
- [ ] F3.7 Open cards as a full-screen route with tabbed TaskDetail sections @needs: F3.5 Render the board as one column at a time with a column switcher

  - `#/card/<id>/<section>` with Chat · Steps · Changes · Details as a top segmented control, a composer pinned above the keyboard, and Back via history.
  - Acceptance: route tests for deep links and back navigation; the open card survives a rotation across a breakpoint (state above the layout switch).

### F3 · Phase 4 — Review on a phone (requires F6 shipped)

- [ ] F3.8 Adapt the F6 review pane for compact mode @needs: F3.7 Open cards as a full-screen route with tabbed TaskDetail sections

  - The file list as a bottom sheet; the unified diff with wrap on by default; tap a line number to select it (a second tap for a range), then **Comment** in a bottom sheet; a sticky **Send review** footer. No hover affordances.
  - Acceptance: tests of F6's `reviewState.ts` for the tap-selection transitions (single, range, cancel); `pnpm test` and `pnpm build` green. Start this card only after F6.14 has landed.

### F3 · Phase 5 — Install and verify

- [ ] F3.9 Add a web app manifest and home-screen icons @needs: F3.2 Build the compact app shell with a bottom tab bar and one status strip

  - A `manifest.webmanifest` (name, standalone display, theme colours from `theme.ts` tokens) and icons, linked from `index.html`. No service worker.
  - Acceptance: the web build output contains the manifest and icons; Lighthouse "installable" passes against a local preview build.
- [ ] F3.10 Write the mobile verification checklist and run it at phone widths @needs: F3.4 Build full-screen touch answer views for questions, permissions and plan approvals, F3.6 Replace drag with a Move to action sheet on touch, F3.8 Adapt the F6 review pane for compact mode, F3.9 Add a web app manifest and home-screen icons

  - `docs/plan/feature-roadmap/F3-mobile-checklist.md` lists the flows at 375 × 667 and 414 × 896 in device emulation: sign-in, answer a question, approve a plan, move a card, comment on and send a review, rotate mid-draft, and the desktop unreachable mid-answer. Record the results.
  - Acceptance: every checklist row passes and is recorded with the build version; all three gates green with `--force` (memory *a-cached-gate-is-not-a-gate*).
