# F22 — Collaboration

> **Status:** proposed · **Where:** client (desktop main + `packages/ui`), server, web · **Depends on:** F19 (workspaces, members, sync), F21 (teams, states, sub-issues) · **Unlocks:** F23 (Android push uses the inbox as its source), F18 (review requests land in the inbox), F24 (status update reminders), F26 (triage notifications)
> Only the `- [ ]` checkboxes under **Tasks** become cards when this file is imported as a plan; everything else is context.
>
> **Layout rule for this file:** every task's description bullets sit after a **blank line**. The plan
> parser folds any indented line that directly follows a checkbox into that task's *title*
> (`apps/client/src/main/planParser.ts:173-177`); the blank line is what keeps descriptions out of it.

## Why

A tracker shared by a team is mostly a conversation about tickets. Today the app's own tickets
have a single-person comment model: a comment is a note with no author, no thread, no edit, and
nobody is told it was written. The only "inbox" is the Attention screen, which is about agents
needing you, not people. Once F19 puts several members in one workspace, that gap is the first
thing a team hits: you assign a ticket and the assignee never hears about it; you ask a question
in a comment and nobody is notified; a ticket's state changes and nobody can see who changed it
or when.

F22 adds the collaboration layer:

- **Assignees, subscribers and @mentions**, resolved against workspace members (and agents,
  F20).
- **Threaded comments** with reactions, edit, delete and resolve.
- **Ticket history**: every field change, who made it, when.
- **A notifications inbox** in-app and by email, with a push seam that F23 plugs into.
- **Team docs**: Markdown documents that belong to a team and link to tickets.

The Attention screen keeps its job, unchanged. The inbox shows its items alongside notifications
rather than replacing it.

## What we have today

- **Comments are notes.** `task_activity` (`apps/client/src/main/store.ts:1530`) stores
  `kind: 'comment' | 'status'` with `body`, `fromStatus`, `toStatus`, and an `INTEGER
  AUTOINCREMENT` id. No author, no parent, no edit time. `TaskActivityEntry`
  (`packages/shared/src/model.ts:1631`) has `comment`, `chat`, `status-note`, `status`, `event`,
  and the read-only tracker kinds `jira-comment` / `github-comment`, which are
  fetched live and never stored. Channels: `task:activity`, `task:addComment`,
  `task:deleteComment` (`packages/shared/src/ipc.ts:764-768`).
- **The timeline merge** is `activityMerge.ts` (`apps/client/src/main/activityMerge.ts`), a pure
  interleave with a `KIND_ORDER` tiebreak. Unread tracker comments use `lastReadCommentAt` /
  `latestCommentAt` on `Task` (`model.ts:1086-1088`).
- **History is status only.** A `status` row is written on a status change; nothing records
  title, assignee, priority, estimate, dates, labels, epic, milestone or links changing.
  `activity_log` (`store.ts:1895`, F2) is the app's run-and-event feed, not a per-ticket field log.
- **People are local labels.** `Person` (`model.ts:1277`) is app-wide, with `isMe` on at most one
  row; its docstring says the app "sends nobody anything". Tickets carry one `assigneeId` and one
  `reporterId`. There are no subscribers and no mentions.
- **Attention** is run-scoped: `AttentionItem` (`packages/shared/src/attention.ts:70`) belongs to
  a live run and is answered back into that session; stored in `attention_items`
  (`store.ts:1623`); channels `attention:list|answer|dismiss` and events `attention:new` /
  `attention:resolved` (`ipc.ts:940-964`, `:1835-1837`). The wide screen is
  `packages/ui/src/Attention.tsx` (tab `'attention'` in `App.tsx`); the compact **Inbox** (F3.3)
  is `packages/ui/src/CompactInbox.tsx` with its pure reducer `inboxState.ts` (answered-elsewhere
  handling) and `attentionUrgency.ts` ordering.
- **The server** (`apps/server/src`) has no email capability and no notification tables. Its
  modules are mirror, events (`eventBus.ts`), presence, attachments, tokens, iam, agents, skills,
  workflows. The cloud is paused since 14 Oct 2026 for cost (memory *cloud-service-paused*), so
  every server task here waits for it to resume.
- **Docs:** none. Ticket descriptions are Markdown (`externalDescription`), rendered by
  `packages/ui/src/chat/MarkdownView.tsx`.

## Design

### Data model & contracts

- **People and members.** In a cloud workspace, F19's members are the people: `Person` rows are
  derived from members (and guests), with `memberId` set and `isMe` decided by the signed-in
  account. In a local workspace, `Person` stays exactly as today. `assigneeId` keeps pointing at a
  `Person` id in both, so no ticket field changes shape. F20's agent identities appear as
  assignable people with `kind: 'agent'`.
- **One assignee, many subscribers.** `assigneeId` stays single. Subscribers are a new table
  `ticket_subscribers (taskId, personId, reason: 'created' | 'assigned' | 'mentioned' |
  'commented' | 'manual', mutedAt)`. Being assigned, creating, commenting or being mentioned
  subscribes you; Unsubscribe sets `mutedAt` so you are not re-subscribed by the next comment.
- **`TicketComment`** in a new `ticket_comments` table, apart from `task_activity`, because a
  cloud comment needs a globally unique id and an author:
  `{ id (uuid), taskId, parentId: string | null, authorId, body, createdAt, editedAt, deletedAt,
  resolvedAt, resolvedById }`. Threads are **one level deep**: a reply's `parentId` is a
  top-level comment. Resolve applies to a top-level thread and collapses it. Delete is soft
  ("Comment deleted" with replies kept).
- **`CommentReaction`**: `comment_reactions (commentId, personId, emoji, createdAt)`, unique on
  the triple. A fixed set of eight emoji in v1, so the picker is one row and the web, desktop and
  phone agree.
- **Mentions** are stored in the body as tokens: `<@person:ID>` for people, and `<#ticket:KEY>`
  is left as plain key text (keys already resolve). The composer shows `@Name`; rendering
  resolves the token to the current name, so a rename never leaves stale text.
- **`TaskActivityEntry`** gains two kinds: `ticket-comment` (carries the comment, its replies and
  reactions) and `history` (one field change). Existing kinds are untouched, so every current
  consumer keeps compiling and rendering.
- **`TicketHistoryEntry`**: `ticket_history (id, taskId, field, fromValue, toValue, actorId,
  actorKind: 'person' | 'agent' | 'automation' | 'sync', at)`. Values are JSON text. Written in
  the **same transaction** as the change, by the store's ticket write methods, never by callers.
  The existing `status` rows in `task_activity` stay; history for status changes is written as
  well, and the timeline prefers history when both exist for a ticket.
- **`Notification`**: `{ id, recipientId, kind, taskId, commentId, actorId, summary, createdAt,
  readAt, archivedAt, snoozedUntil }` with `kind` in `assigned | mentioned | commented |
  state-changed | due-soon | review-requested | ai-verdict | status-update-due`. One row per
  recipient. Attention items are **not** copied into this table (see *Inbox*).
- **`NotificationPrefs`** per member: for each kind, which channels (`inApp`, `email`, `push`)
  are on, plus an email digest cadence (`off | hourly | daily`). Defaults: in-app for all;
  email for `assigned` and `mentioned`, daily digest for the rest; push off until F23.
- **`TeamDoc`**: `{ id, teamId, title, body (Markdown), createdById, updatedById, createdAt,
  updatedAt, revision, archivedAt }` in `team_docs`, plus `doc_ticket_links (docId, taskId)`.

### Pure rules

New `packages/shared/src/collab.ts` (no React, no Electron, no DB):

- `parseMentions(body)` / `renderMentions(body, peopleById)`.
- `threadComments(comments)` ordering top-level by time and replies under each, with
  resolved threads last-collapsed.
- `recipientsFor(event, subscribers, actorId, prefs)`: everyone subscribed and not muted, minus
  the actor, plus explicit mentions and the new assignee; one notification per person per event
  even when several reasons apply (a mention beats a plain comment).
- `historyDiff(before, after, fields)` producing the entries a ticket write must record.
- `coalesce(notifications)` for display: several comments on one ticket from the same burst read
  as one inbox row "3 new comments".

### Engine / desktop main process

- **Local workspace.** All tables above exist locally; comments, reactions, history,
  subscribers and docs are fully usable offline. Notifications exist but only have senders that
  are not you: agents (F20 identity commenting), automations, tracker syncs (a JIRA comment that
  mentions you), F18 review requests and F17 AI verdicts. `due-soon` is computed by a small timer
  in main, once a day per ticket.
- **Copy existing comments once.** A one-time backfill copies `task_activity` comment rows of
  **native tickets** into `ticket_comments` authored by the `isMe` person, with a stable uuid
  derived from the row id. Personal-board notes stay in `task_activity` as notes; the model
  docstring already calls them "for you". `task:addComment` keeps working: on a native ticket it
  writes a `ticket_comments` row, elsewhere a note.
- **History writes.** `ticket:update`, `task:setState` (F21), `task:setPriority`,
  `task:setTitle`, `task:setDescription`, the label, link, epic, milestone and parent writers, and
  F21's team move each record history inside their transaction. Typecheck will not list them;
  the PR enumerates them by grep over `store.ts` methods that `UPDATE tasks` for a ticket row
  (memory *phase24-tickets-design*).
- **Agent comments.** When an agent posts a comment (F20), its `authorId` is the agent person,
  and the comment notifies subscribers like any other. The agent's transcript (`event` entries)
  is not a comment and notifies nobody.

### Server & relay

- **Cloud workspace.** Comments, reactions, subscribers, history, notifications, prefs and docs
  are server tables (TypeORM entities + one migration in `apps/server/src/migrations/`), carried
  to every replica by F19's downstream sync. Comments and reactions are **append-only** rows
  (edits are new `editedAt`/`body` versions by the author only; deletes are tombstones), per the
  workspace decision; history is written by the server when it applies a field change, so its
  `actorId` is the authenticated member, not whatever a desktop claimed.
- **Fan-out on the server.** After the server applies a ticket or comment write, a
  `NotificationService` computes recipients with `recipientsFor` and writes one `Notification`
  per recipient, then hands each to the **channels** enabled in that member's prefs through one
  interface:

  ```ts
  interface NotificationChannel {
    readonly kind: 'inApp' | 'email' | 'push';
    deliver(n: Notification, member: Member): Promise<void>;
  }
  ```

  `inApp` is the row itself plus an `eventBus` push to connected clients. `email` queues for the
  digest or sends immediately for `assigned`/`mentioned`. `push` is a no-op stub registered now
  so F23 only adds an implementation (FCM). A channel failure never blocks the write; it is
  retried and recorded on the notification.
- **Email** goes through a provider adapter (`EmailSender`), with the provider chosen at deploy
  time (open question 3). Every email has a one-click unsubscribe per kind and a reply-by-link
  (no inbound email parsing in v1).
- **Relay** for a **local** workspace viewed from the web: the new read channels
  (`comment:list`, `history:list`, `notification:list`, `doc:list|get`) and writes are classified
  `'relay'` in `packages/shared/src/ipcRelay.ts`; events `comment:changed` (`'replace-by-key'`
  on the ticket id), `notification:new` (`'stream'`, like `attention:new`), `doc:changed`
  (`'replace-by-key'` on the doc id) in `ipcEventFanout.ts`. `ipc-relay-coverage.test.ts` fails until each is classified.

### UI — desktop

Copy the real components (memory *mock-the-real-components*); v9 glass shell from F13; issue
detail per the v9 issue-detail mockup.

- **Ticket panel and full-screen issue** (F12 panel): the activity section renders
  `ticket-comment` threads (reply, react, edit own, delete own, resolve thread) and `history`
  rows in one timeline with a filter: All / Comments / History. Subscribers row in the header
  with Subscribe / Unsubscribe and the avatars.
- **Composer**: `@` opens a member picker (people and agents) filtered as you type; the mention
  is a chip in the editor and a token in storage. Drafts reuse `drafts.ts`.
- **Inbox** (sidebar entry *Inbox*, per the v9 sidebar): one list, two sources merged at read
  time:
  1. **Needs you**: live `AttentionItem`s, ordered by `attentionUrgency.ts`, rendered by the
     existing `InboxItem` / `CompactAnswerView` components and answered through the existing
     `attention:answer` path. Nothing about how they are stored, answered or resolved changes.
  2. **Notifications**: grouped by ticket, newest first, with read/unread, archive, snooze
     (until tomorrow / next week), and filters by kind.

  The **Attention** tab stays where it is and behaves as today; it is the Needs-you half shown
  alone. The status bar's orange attention state keeps reading attention items only, so a
  comment never turns the bar orange (colour is for agents needing you).
- **Compact Inbox** (`CompactInbox.tsx`): gains a Notifications segment beside its existing
  list. `inboxState.ts`'s reducer and its "Answered on another device" behaviour are untouched;
  notifications get their own small reducer.
- **Team docs**: a *Docs* entry under each team in the sidebar tree; a list, and a Markdown
  editor with preview using `MarkdownView.tsx`; linked tickets in a side list; a ticket's panel
  shows the docs that link it.
- **Settings → Notifications**: the prefs matrix (kind × channel) and digest cadence; on a local
  workspace only the in-app column is shown.

### UI — web

Everything above is in `packages/ui` and renders in `apps/web` unchanged (memory
*web-mirrors-the-desktop*). On a cloud workspace the web reads comments, history, notifications
and docs from the server directly, so a teammate with no desktop can comment and get notified.

### Failure modes & edge cases

- **Mentioning someone who cannot see the ticket** (a guest without access, F27): the mention
  renders, the composer warns "Anna can't see this ticket", and no notification is sent.
- **Two people edit one comment**: only the author may edit, so this is the same author on two
  devices; last writer wins on `body`, and `editedAt` shows.
- **Offline comment**: written to the replica and the outbox; shows "Sending…" until the server
  accepts it; notifications go out when it lands, not when it was typed.
- **A ticket is deleted**: its comments, reactions, subscribers and history go with it in one
  transaction; notifications pointing at it remain readable with "Ticket deleted" and no link.
- **Notification storms** (bulk edit of 50 tickets, F25): `coalesce` groups per actor and burst;
  email digests group per ticket. Bulk edits record history but send at most one notification
  per recipient per bulk action.
- **The actor is an automation or a sync**: history records `actorKind`; notifications from
  syncs are limited to mentions of you and assignment to you, never every remote edit.
- **Attention item resolved elsewhere while the Inbox shows it**: the existing
  `ANSWERED_ELSEWHERE` handling covers it, because the Needs-you half is the same component.
- **Doc edit conflict**: saves carry `revision`; a stale save is refused, the editor keeps the
  human's text and shows the newer version beside it to merge by hand. No silent overwrite.
- **Email provider down**: the in-app row exists regardless; email retries with backoff and the
  notification records the last error, visible to admins.

## Out of scope (v1)

- Real-time co-editing of docs and descriptions (cursor presence, CRDTs).
- Multiple assignees per ticket.
- Inbound email (reply to comment by email).
- Push delivery itself (F23 implements the `push` channel).
- Custom emoji, reaction on history entries, comment threads deeper than one level.
- Writing app comments back to JIRA/GitHub; tracker comments stay read-only, as today.
- Slack/Teams delivery (out of the roadmap entirely).

## Open questions

1. **New table or widen `task_activity` for comments?** *Recommended default:* new
   `ticket_comments` table with uuid ids. An `INTEGER AUTOINCREMENT` id cannot be unique across
   devices, and author/parent/resolve would widen every reader of `task_activity` for rows that
   are not comments.
2. **Do Personal-board notes become comments?** *Recommended default:* no. They are notes for
   you, and the Personal board is not a team surface; only native tickets get threaded comments.
3. **Which email provider?** *Recommended default:* Azure Communication Services Email, since the
   cloud already runs on Azure under its own subscription; behind `EmailSender` so it can change.
4. **Does a comment from an agent notify?** *Recommended default:* yes, as a `commented`
   notification to subscribers, but never the agent's transcript. An agent asking for something
   arrives as an Attention item, as today.
5. **Does the inbox replace the Attention tab?** *Recommended default:* no. Keep the tab; the
   inbox embeds the same items so nobody has to go to two places, and the tab stays for people
   who want only what blocks agents.
6. **Who may resolve a thread?** *Recommended default:* the thread's author, the ticket's
   assignee and admins.
7. **Are team docs per team or per workspace?** *Recommended default:* per team, with a
   workspace-level "All docs" list; F24's projects can link docs the same way tickets do.

## Tasks

### F22 · Phase 1 — Contracts and pure rules

- [ ] F22.1 Add the comment, reaction, subscription, history, notification and doc contracts

  - In `packages/shared/src/model.ts`: `TicketComment`, `CommentReaction`, `TicketSubscriber`,
    `TicketHistoryEntry`, `Notification`, `NotificationKind`, `NotificationPrefs`, `TeamDoc`;
    `ticket-comment` and `history` kinds on `TaskActivityEntry`; `Person.kind` (`'person' |
    'agent'`) and `Person.memberId`.
  - Acceptance: `pnpm typecheck` green; `activityMerge.ts`'s `KIND_ORDER` covers the new kinds
    (it is a `Record` over the kind union, so the compiler enforces it) with a test for their
    tiebreak position.

- [ ] F22.2 Write the mention, threading, history and recipient rules @needs: F22.1 Add the comment, reaction, subscription, history, notification and doc contracts

  - New `packages/shared/src/collab.ts`: `parseMentions`, `renderMentions`, `threadComments`,
    `recipientsFor`, `historyDiff`, `coalesce`.
  - Acceptance: tests that the actor never notifies themselves, a muted subscriber is skipped,
    a mention beats a comment reason (one row, not two), a rename re-renders a mention, a bulk
    burst coalesces to one row, and `historyDiff` emits nothing for unchanged fields.

### F22 · Phase 2 — Local store

- [ ] F22.3 Add the comment and reaction tables and copy existing ticket comments @needs: F22.1 Add the comment, reaction, subscription, history, notification and doc contracts

  - `ticket_comments` and `comment_reactions` in `store.ts` (cascade from `tasks`); a one-time
    copy of native tickets' `task_activity` comments authored by the `isMe` person; store
    methods to add, edit, soft-delete, resolve, react; `task:addComment` writes the new table for
    a native ticket and a note elsewhere.
  - Acceptance: electron-as-node recipe (memory *the-store-has-no-tests*): snapshot a real DB,
    open twice, drop the tables, reopen; the copy runs once, comment counts on tickets match, and
    Personal-board notes are untouched.

- [ ] F22.4 Record ticket history inside every ticket write @needs: F22.2 Write the mention, threading, history and recipient rules

  - `ticket_history` table; each ticket write method in `store.ts` calls `historyDiff` and
    inserts entries in its own transaction, with `actorKind` passed by the caller; the PR lists
    every method found by grep.
  - Acceptance: a `scripts/verify-collab.mjs` scenario on a temp DB that edits every ticket field
    once and asserts one history entry each with the right from/to; it fails when any one write
    path's history call is removed (memory *headless-scenario-harness-traps*).

- [ ] F22.5 Add subscriptions and the local notification store @needs: F22.3 Add the comment and reaction tables and copy existing ticket comments, F22.4 Record ticket history inside every ticket write

  - `ticket_subscribers` and `notifications` tables; auto-subscribe on create, assign, comment and
    mention; local senders (agent comments, automations, tracker mentions of you, due-soon timer)
    write notifications via `recipientsFor`; read/archive/snooze methods.
  - Acceptance: `verify-collab.mjs` extended: an agent comment notifies the human, the human's own
    comment notifies nobody locally, unsubscribe survives a later comment, due-soon fires once
    per ticket per day.

- [ ] F22.6 Add the collaboration IPC channels and their relay classification @needs: F22.5 Add subscriptions and the local notification store

  - Channels `comment:list|add|edit|remove|resolve|react`, `history:list`,
    `subscriber:list|set`, `notification:list|markRead|archive|snooze`,
    `notificationPrefs:get|set` in `packages/shared/src/ipc.ts` and `apps/client/src/main/ipc.ts`;
    `'relay'` in `ipcRelay.ts`; events `comment:changed`, `notification:new`,
    `notification:changed` in `ipcEventFanout.ts`; `task:activity` merges the new kinds.
  - Acceptance: `test/ipc-relay-coverage.test.ts` and the fanout test pass; handler tests that
    editing another person's comment is refused with a readable error.

### F22 · Phase 3 — Desktop and web UI

- [ ] F22.7 Render threaded comments with reactions and resolve in the ticket panel @needs: F22.6 Add the collaboration IPC channels and their relay classification

  - In the F12 panel and full-screen issue: threads from `threadComments`, reply, react (eight
    emoji), edit and delete own, resolve and reopen thread; Subscribers row with subscribe
    toggle.
  - Acceptance: a pure `commentThreadView.ts` with tests for collapsed resolved threads, deleted
    parents with live replies, and reaction counts; `pnpm build` green; the shared component
    renders in the web build.

- [ ] F22.8 Add @mention autocomplete to the comment composer @needs: F22.7 Render threaded comments with reactions and resolve in the ticket panel

  - `@` picker over people and agents in the composer; chips in the editor, tokens in storage;
    warning when the mentioned person cannot see the ticket; drafts via `drafts.ts`.
  - Acceptance: tests for token round-trip (type, store, render) including a rename, and for the
    picker's filtering; a mention creates exactly one `mentioned` notification.

- [ ] F22.9 Show ticket history in the activity timeline @needs: F22.6 Add the collaboration IPC channels and their relay classification

  - `history` rows rendered compactly ("Anna changed priority High → Urgent"), grouped when
    consecutive by one actor; the All / Comments / History filter; status rows from
    `task_activity` hidden when history covers them.
  - Acceptance: a pure `historyView.ts` with tests for grouping, value formatting per field
    (dates, people, labels) and the de-duplication against legacy status rows.

- [ ] F22.10 Build the Inbox that merges notifications with Attention items @needs: F22.6 Add the collaboration IPC channels and their relay classification

  - Sidebar *Inbox*: a Needs-you section built from the existing `Attention.tsx` item components
    and `attentionUrgency.ts`, and a Notifications section with read, archive, snooze and kind
    filters; the Attention tab unchanged; `CompactInbox.tsx` gains a Notifications segment with
    its own reducer, leaving `inboxState.ts` as is; the status bar's orange stays attention-only.
  - Acceptance: `inboxState.test.ts` unchanged and green; new `notificationInbox.test.ts` for
    grouping, unread counts and snooze expiry; a test that a notification never sets the
    attention flag the status bar reads.

### F22 · Phase 4 — Cloud workspace

- [ ] F22.11 Store comments, reactions, subscribers and history on the server @needs: F22.6 Add the collaboration IPC channels and their relay classification

  - TypeORM entities and a migration for the collaboration tables; the server writes history when
    it applies a field change, with the authenticated member as actor; comments and reactions are
    append-only through F19's outbox and downstream sync; members map to `Person` rows with
    `memberId`.
  - Acceptance: server tests that a desktop cannot forge `actorId`, that an offline comment
    syncs once (idempotent on its uuid), and that a non-author edit is rejected; a sync test with
    two desktops reacting to one comment at once keeping both reactions.

- [ ] F22.12 Fan out notifications on the server through a channel interface @needs: F22.11 Store comments, reactions, subscribers and history on the server

  - `NotificationService` using `recipientsFor`; `NotificationChannel` with `inApp` (row plus
    `eventBus` push), `email` (queue) and a registered no-op `push` stub for F23; retries and
    last-error on each notification; prefs stored per member.
  - Acceptance: server tests that a failing channel neither blocks the ticket write nor drops
    the in-app row, that prefs switch a channel off, and that a bulk action sends one
    notification per recipient.

- [ ] F22.13 Send notification emails with digests and one-click unsubscribe @needs: F22.12 Fan out notifications on the server through a channel interface

  - `EmailSender` adapter and the chosen provider; immediate mail for `assigned` and
    `mentioned`, hourly/daily digests for the rest; signed unsubscribe links per kind; the
    Settings → Notifications matrix in `packages/ui`. Secrets via the existing server config
    (`apps/server/src/config/secrets.ts`).
  - Acceptance: tests with a fake sender for digest grouping, unsubscribe-link verification and
    a provider outage retried with backoff; a manual send to the owner's address on the resumed
    cloud, recorded in the PR.

### F22 · Phase 5 — Team docs and verification

- [ ] F22.14 Add team docs with revision-checked saves @needs: F22.1 Add the comment, reaction, subscription, history, notification and doc contracts

  - `team_docs` and `doc_ticket_links` locally (store, migration, `doc:list|get|save|archive|link`
    channels classified `'relay'`, `doc:changed` event) and on the server (entity, migration,
    sync); a stale `revision` refuses the save.
  - Acceptance: electron-as-node migration proof for the local tables; a server test that a stale
    save is refused and the newer body returned; relay coverage test green.

- [ ] F22.15 Edit team docs and link them to tickets in the UI @needs: F22.14 Add team docs with revision-checked saves, F22.7 Render threaded comments with reactions and resolve in the ticket panel

  - *Docs* under each team in the sidebar tree; list and Markdown editor with preview
    (`MarkdownView.tsx`); conflict view showing both versions; linked tickets side list; a
    ticket panel's *Docs* row; mentions work in docs and notify.
  - Acceptance: a pure `docEditorState.ts` with tests for the conflict path keeping the human's
    text; `pnpm build` green and the web renders the same editor.

- [ ] F22.16 Verify collaboration end to end and document it @needs: F22.8 Add @mention autocomplete to the comment composer, F22.9 Show ticket history in the activity timeline, F22.10 Build the Inbox that merges notifications with Attention items, F22.13 Send notification emails with digests and one-click unsubscribe, F22.15 Edit team docs and link them to tickets in the UI

  - Extend `scripts/verify-collab.mjs` across IPC (comment, mention, reply, resolve, history,
    inbox read state, doc conflict); with a stub `claude` on PATH (memory
    *stub-claude-on-path*), an agent comment notifies while a held agent question appears only
    as an Attention item; a new `docs/` page on collaboration and glossary entries in
    `docs/05-glossary.md`.
  - Acceptance: the script fails when `recipientsFor`'s actor exclusion or the history write is
    mutated, and passes as written; `pnpm typecheck`, `pnpm test`, `pnpm build` green with
    `--force`.
