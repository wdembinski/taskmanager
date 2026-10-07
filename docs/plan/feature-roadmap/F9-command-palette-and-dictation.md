# F9 — Command palette and dictation

> **Status:** proposed · **Where:** client (desktop renderer) + web (shared `packages/ui`) · **Depends on:** none (F5's richer composer is a better dictation target, but not required) · **Unlocks:** faster navigation for every other Fn screen (F1 automations, F2 dashboard, F5 issues) — each one registers its commands here
> Only the `- [ ]` checkboxes under **Tasks** become cards when this file is imported as a plan; everything else is context.

## Why

The app now has a board, My Tasks, projects, a timeline, merge requests, settings, agent profiles and (in the web) a fleet view — and the only way between them is the nav rail and a mouse. Finding one card among a few hundred means scrolling a column. A keyboard-first "jump anywhere, do anything" entry point is the cheapest UX win on the list: no engine work, no schema change, and every later feature gets a free place to expose its actions.

Dictation is the second half: a task brief is prose, and prose is faster spoken than typed — especially on the phone-sized web host F3 targets. It is scoped as **push-to-talk into a text box**, never a voice-control mode.

## What we have today

- **No shortcut layer.** Keyboard handling is ad-hoc `window.addEventListener('keydown', …)` per screen: link deletion/Escape in `apps/client/src/renderer/src/MyTasks.tsx:1082` and `:1093`, the same pattern duplicated in `apps/web/src/board/BoardScreen.tsx:414`, and bar dragging in `packages/ui/src/projects/TimelinePane.tsx:900`. Each re-implements the "ignore when focus is in an INPUT/TEXTAREA/SELECT/contentEditable" guard.
- **No Electron accelerators or `globalShortcut`** in `apps/client/src/main` (only `contextMenu.ts` uses menu roles).
- **The shared frame** is `packages/ui/src/shell/AppShell.tsx` (slots: title bar, nav rail, banners, content, status bar) — rendered by both `apps/client/src/renderer/src/App.tsx` and `apps/web/src/App.tsx`. Screen switching lives in each host's `App.tsx`, not in `packages/ui`.
- **Composer**: `packages/ui/src/chat/Composer.tsx` (chat input with `MentionPicker`), and the description field of `packages/ui/src/AddTaskDialog.tsx`. Both are shared by the two hosts.
- **Relay policy**: `packages/shared/src/ipcRelay.ts` classifies every IPC channel `relay` vs `host-only`; a palette action that calls a host-only channel must not be offered in the web (memory *support-all-interactions-in-the-web*).
- **No microphone plumbing in Electron**: no `session.setPermissionRequestHandler` / `setPermissionCheckHandler` anywhere in `apps/client/src/main`, so a `getUserMedia({audio})` request is currently decided by Electron's default.
- **No DOM test harness** in the repo — UI logic is proven as pure state machines (`packages/ui/src/taskTimeline.ts`, `taskChat.ts`).

## Design

### Data model & contracts

No persisted data, no IPC channels, no migration. Everything lives in `packages/ui`:

- `PaletteCommand` — `{ id, group: 'navigate' | 'cards' | 'projects' | 'actions', title, keywords?: string[], subtitle?, run: () => void | Promise<void>, hostOnly?: boolean }`.
- `PaletteSource` — a function `(ctx) => PaletteCommand[]` that a host (or a feature screen) registers; the palette concatenates sources on open. Feature screens later (F1/F2/F5) add their own source rather than editing the palette.
- `paletteScore(text, query, keywords)` — pure; the token/substring rule above, implemented fresh. Returns 0 to hide.
- `paletteReduce(state, event)` — pure state machine: `open/close`, `query`, `move(±1)`, `select` → `{ open, query, rows, activeIndex }`, where `rows` is grouped + ranked output. Testable without a DOM.
- `shortcutMatches(event, 'mod+k')` — pure: `mod` = Meta on macOS, Ctrl elsewhere, accepting either on both so a Windows user on a Mac keyboard is not stranded.

### Engine / main process

- None for the palette — it only calls IPC channels that already exist (`task:*`, navigation is renderer state).
- Dictation on the desktop needs a main-process **permission handler** for the `media` permission (audio only), scoped to the app's own renderer origin, if the spike (Phase 3) chooses any `getUserMedia` path. If it chooses OS dictation instead, no main-process change.

### Server & sync

None — the palette is pure UI over data each host already has (the board store in the web, the IPC reads on the desktop). Dictation never leaves the device in the recommended path.

### UI — desktop

- `CommandPalette` (`packages/ui/src/palette/CommandPalette.tsx`) — a Fluent v9 `Dialog` with an `Input` and a listbox (`role="listbox"`, `aria-activedescendant`), groups as headed sections, keyboard: ↑/↓/Enter/Escape, Ctrl/⌘+Enter for a row's secondary action ("open in detail pane" vs "start"). No new dependency (no `cmdk`): Fluent has no command component, and the ranking is ours anyway.
- Opened by `useGlobalShortcut('mod+k', …)` mounted once in `App.tsx`. Unlike the per-screen handlers, it fires **even when focus is in a text field** (that is the point of ⌘K), but every existing per-screen handler keeps its own guard.
- Commands v1 (desktop source): go to each screen; open a card by title/key/id (searches the store's tasks, incl. `externalKey`/`ticketKey`); open a project; **Add task** (opens `AddTaskDialog`); **Start / Stop** the selected card (only when `canStopWork`/start is legal — reuse the existing predicates, never re-derive); toggle theme; open Settings section.
- A `Ctrl K` hint in the nav rail footer, and a read-only "Keyboard shortcuts" list in Settings.

### UI — web

- Same component and reducer from `packages/ui`; `apps/web/src/App.tsx` registers a web source built from the cloud board store (`cloudBoardStore.ts`).
- Any command whose channel is `host-only` in `RELAY_POLICY` is filtered out (the `hostOnly` flag is derived from the policy, not hand-set), so the web never offers an action it cannot relay.
- Browsers reserve some Ctrl+K behaviour (Firefox/Chrome focus the search bar on Ctrl+K in some layouts): call `preventDefault()` when the palette handles it; Ctrl+/ (or `/`) is offered as an alternative opener in the web.

### Failure modes & edge cases

- **Stale rows**: the palette snapshots sources on open; a card deleted while it is open must fail soft — `run` resolves the id again and shows the existing `RUN_REFUSAL_MESSAGE['unknown-task']` instead of throwing.
- **IME composition**: ignore `keydown` while `event.isComposing` so CJK input does not trigger the shortcut.
- **Dialog stacking**: opening the palette while another Fluent dialog is open closes nothing; ⌘K is ignored while a modal dialog owns focus.
- **uuid noise**: ids are searchable but ranked below title hits (the reason the custom scorer exists).
- **Dictation**: permission denied → mic shows a one-line reason and stays disabled for the session; recognition error mid-utterance keeps whatever was finalized; insert never auto-submits unless the user pressed insert-and-send.

## Out of scope (v1)

- User-rebindable shortcuts and a full shortcut map beyond ⌘K.
- Fuzzy/typo-tolerant search and searching inside descriptions or transcripts.
- Hands-free voice control ("start card 12"); wake words; text-to-speech.
- Electron `globalShortcut` (system-wide, app not focused).
- Recent-commands history / frecency ranking.

## Open questions

1. **Does Web Speech work in the packaged Electron app?** Electron's Chromium exposes `webkitSpeechRecognition`, but it is backed by Google's speech service, which needs an API key Chrome bundles and Electron does not — the widely reported outcome is an immediate `network` error. *Recommended default:* assume it does **not**; the F9.7 spike proves it either way before any desktop dictation UI is built.
2. **Desktop dictation path if Web Speech fails.** Options: (a) a hint pointing at OS dictation (Windows Win+H, macOS Fn-Fn) which already works in any focused text field, zero code, zero data leaving the OS vendor's path; (b) local transcription (whisper.cpp via a native addon or a WASM model in the renderer — 40–150 MB model download, CPU cost, another ABI-split native module per *verify-electron-app*); (c) a cloud STT API via `@tm/server` (cost, privacy). *Recommended default:* (a) for v1, (b) only if the user asks for in-app dictation on the desktop.
3. **Web host**: Web Speech works in Chrome/Edge/Safari (Safari sends audio to Apple, Chrome to Google). *Recommended default:* enable it there, hide the mic in Firefox, and say in the mic tooltip which vendor processes the audio.
4. **Ctrl+K collisions in the desktop** — nothing in the renderer binds it today. *Recommended default:* take it.

## Tasks

### F9 · Phase 1 — Palette model

- [ ] F9.1 Add the pure palette model with command sources and token scoring in packages/ui

  - New `packages/ui/src/palette/paletteModel.ts`: `PaletteCommand`, `PaletteSource`, `paletteScore`, `rankCommands` (group order, empty-query locality order), `paletteReduce` (open/close/query/move/select).
  - Acceptance: `paletteModel.test.ts` covers — every token required; word-boundary beats mid-word; `767` ranks "767: fix" above a row whose id contains `767`; empty query keeps the current project's cards first; `move` wraps; `select` on an empty list is a no-op. `pnpm typecheck`, `pnpm test`, `pnpm build` green.
- [ ] F9.2 Add a shared useGlobalShortcut hook with a pure mod+k matcher @needs: F9.1 Add the pure palette model with command sources and token scoring in packages/ui

  - `packages/ui/src/palette/shortcut.ts`: pure `shortcutMatches(evt, spec)` (Meta or Ctrl for `mod`, ignores `isComposing`, ignores repeat) + `useGlobalShortcut` that registers one window listener.
  - Acceptance: unit tests on plain event-like objects for Ctrl+K, Meta+K, Shift+Ctrl+K (no match), composing (no match), autorepeat (no match). Gates green.

### F9 · Phase 2 — Palette in both hosts

- [ ] F9.3 Build the CommandPalette dialog in packages/ui with full keyboard navigation @needs: F9.1 Add the pure palette model with command sources and token scoring in packages/ui, F9.2 Add a shared useGlobalShortcut hook with a pure mod+k matcher

  - `packages/ui/src/palette/CommandPalette.tsx` — Fluent `Dialog` + `Input` + listbox driven entirely by `paletteReduce`; ARIA listbox/option roles; Escape closes; Enter runs; Ctrl/⌘+Enter runs the secondary action; errors from `run` render as a `MessageBar` inside the palette instead of closing it.
  - Acceptance: the component holds no logic beyond wiring (reviewable); reducer tests from F9.1 extended for secondary-action and error-row transitions. Gates green.
- [ ] F9.4 Register navigation card and project commands in the desktop app @needs: F9.3 Build the CommandPalette dialog in packages/ui with full keyboard navigation

  - Mount the palette once in `apps/client/src/renderer/src/App.tsx`; a desktop `PaletteSource` in `apps/client/src/renderer/src/paletteSource.ts` building: screens, cards (title / `externalKey` / `ticketKey` / id), projects, Add task, Start/Stop selected (gated by the existing start/`canStopWork` predicates), theme, Settings sections.
  - Acceptance: pure `buildDesktopCommands(snapshot)` tested — a running card offers Stop not Start; a card with no agent project offers no Start; a deleted card's command resolves to the unknown-task refusal message. Gates green.
- [ ] F9.5 Register web commands and filter host-only actions through RELAY_POLICY @needs: F9.3 Build the CommandPalette dialog in packages/ui with full keyboard navigation

  - Mount in `apps/web/src/App.tsx`; web source from `cloudBoardStore.ts`; `hostOnly` derived from `packages/shared/src/ipcRelay.ts` so a command is dropped when any channel it calls is `host-only`; `preventDefault` on handled Ctrl+K; `/` as an extra opener when focus is not in a field.
  - Acceptance: test that every web command's channel set is `relay` in `RELAY_POLICY`, and that flipping a channel to host-only (mutating BOTH lists, per the memory) removes the command. Gates green.
- [ ] F9.6 Add the palette hint to the nav rail and a keyboard shortcuts list in Settings @needs: F9.4 Register navigation card and project commands in the desktop app

  - `Ctrl K` / `⌘K` hint in the nav rail footer (platform-aware label), clicking it opens the palette; a read-only "Keyboard shortcuts" section in desktop Settings and the web settings sections (`apps/web/src/settings/settingsSections.ts`).
  - Acceptance: `settingsSections.test.ts` updated for the new section; label helper unit-tested per platform. Gates green.

### F9 · Phase 3 — Dictation

- [ ] F9.7 Spike whether Web Speech recognition works in the packaged Electron renderer

  - Throwaway probe (scratch branch, never merged): call `webkitSpeechRecognition` in a packaged build and record the `onerror` code; also confirm `getUserMedia({audio:true})` behaviour with and without a `setPermissionRequestHandler`. Follow *verify-electron-app* — do NOT launch the app on the user's machine; ask the human to run the probe build or use a throwaway profile.
  - Acceptance: a short findings note appended to this file's Open questions (works / fails with which error) and the chosen desktop path (OS-dictation hint vs local transcription). No product code merged.
- [ ] F9.8 Add the pure dictation state machine with a pluggable recognizer seam

  - `packages/ui/src/dictation/dictationModel.ts`: `Recognizer` interface (structural — start/stop/abort/onresult/onerror/onend), `recognizerFor(window)` support check, `foldResults(final, interim, event)` (finals append, interims replace the tail), and a reducer `idle → recording → idle` with cancel / insert / insert-and-send.
  - Acceptance: tests drive a fake recognizer class — partials grow, finals stick, error keeps finalized text, cancel discards, insert returns the transcript, unsupported → `supported: false`. Gates green.
- [ ] F9.9 Wire Web Speech dictation into the Composer and the AddTaskDialog description where supported @needs: F9.8 Add the pure dictation state machine with a pluggable recognizer seam

  - Mic button in `packages/ui/src/chat/Composer.tsx` and the description field of `packages/ui/src/AddTaskDialog.tsx`; recording overlay (dot, mm:ss, partial text, cancel / insert / insert-and-send); rendered only when `supported`; inserts at the caret; tooltip names the vendor that processes audio.
  - Acceptance: mic absent when the recognizer is unsupported (pure `dictationAvailable(host, window)` tested for web-Chrome / web-Firefox / desktop); insert at caret helper unit-tested. Gates green.
- [ ] F9.10 Ship the desktop dictation path chosen by the spike @needs: F9.7 Spike whether Web Speech recognition works in the packaged Electron renderer, F9.8 Add the pure dictation state machine with a pluggable recognizer seam

  - If OS dictation: a mic-shaped hint in the desktop composers that explains Win+H / Fn-Fn and focuses the field. If Web Speech works: enable F9.9's path on the desktop and add a `media`/audio-only `setPermissionRequestHandler` in `apps/client/src/main` scoped to the app origin. Local transcription is a separate, later card.
  - Acceptance: the choice is reflected in `dictationAvailable` tests; if a permission handler is added, a unit test proves it grants audio for the app origin only and denies video and foreign origins. Gates green.
