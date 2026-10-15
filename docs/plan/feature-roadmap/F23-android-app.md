# F23 — Android app

> **Status:** proposed · **Where:** new `apps/mobile` (Capacitor shell), web (`apps/web` compact mode, `packages/ui`), server (new `notifications` module), CI (`.github/workflows/release.yml`) · **Depends on:** F3 (shipped: compact mode), F13 (glass tokens and shell), F19 (cloud resumed, workspaces), F22 (the notifications inbox is the push source). Phase 2's Review screen also needs F15, F16 and F18; the Agents tab needs F20 · **Unlocks:** answering an agent, approving a plan or a review from the lock screen
> Only the `- [ ]` checkboxes under **Tasks** become cards when this file is imported as a plan; everything else is context.
>
> **Layout rule for this file:** every task's description bullets sit after a **blank line**. The plan
> parser folds any indented line that directly follows a checkbox into that task's *title*
> (`apps/client/src/main/planParser.ts:173-177`); the blank line is what keeps descriptions out of it.

## Why

F3 made the web usable on a phone. A phone browser still cannot do the one thing that matters
most for unattended agents: **tell you** that something is waiting. An agent that asks a
question at 23:00 waits until somebody happens to open a tab. A home-screen web app has no
reliable push on Android without a service worker and Web Push stack we do not have. It
signs in through a tab that the OS kills, and it cannot open a link from an email straight
onto the ticket.

F23 wraps the existing compact web app in a thin native Android shell (Capacitor). The UI is
not rewritten. What the shell adds is what only a native app can do: FCM push, verified app
links, sign-in through the system browser, Keystore-backed token storage and an optional
biometric lock. The screens follow the v9 phone mockups:
[`mockups/v9-4-mobile-light.svg`](mockups/v9-4-mobile-light.svg) and
[`mockups/v9-5-mobile-dark.svg`](mockups/v9-5-mobile-dark.svg).

## What we have today

- **Compact mode is shipped (F3).** `apps/web/src/compact/CompactApp.tsx` is the root below
  640 px (`packages/ui/src/layout/viewport.ts`). It has four tabs (Inbox, Board, Search,
  Settings) and hash routes (`apps/web/src/compact/useHashRoute.ts` over `compactRoute.ts`:
  `#/inbox`, `#/board/<col>`, `#/card/<id>/<section>`). Its parts are `CompactInbox.tsx`,
  `CompactAnswerView.tsx`, `attentionUrgency.ts`, `packages/ui/src/board/CompactCardScreen.tsx`
  (Chat · Steps · Changes · Details) and `StatusStrip.tsx`.
- **Install metadata exists:** `apps/web/public/manifest.webmanifest` (standalone, dark
  `#1f1f1f`, 192/512 icons), `index.html` with `viewport-fit=cover`. `manifest.test.ts` keeps the
  theme colour in step. **There is no service worker and no push of any kind.**
- **Web sign-in** (`apps/web/src/auth/cloudAuth.ts`): authorization code + PKCE through
  `@tm/shared/iamPkce`. The whole page redirects to vipper.iam and back to
  `${origin}/callback`. The verifier sits in `sessionStorage`, the refresh token in
  `localStorage`, the access token in memory. One in-flight refresh is shared because vipper.iam
  rotates refresh tokens on every use. `onSessionEnded` turns a dead token into the sign-in
  screen (memory *a-session-that-had-ended*).
- **vipper.iam is node-oidc-provider.** Redirect URIs are matched as **exact strings**, and
  `offline_access` is silently dropped without `prompt=consent` (memory *cloud-sign-in-chain*,
  both handled in `iamPkce.ts`). The web build's public client id is `VITE_CLOUD_IAM_CLIENT_ID`;
  the desktop has its own (`apps/client/src/main/iamConfig.ts`). vipper.iam supports TOTP and
  passkeys (the vipper.iam repo at `C:\Repositories\iam`: `apps/backend/src/webauthn`, `mfa`).
- **CORS is an allowlist** (`apps/server/src/config/cors.ts`, `CLOUD_ALLOWED_ORIGINS`). In
  production an unset value allows nothing.
- **Static hosting:** Azure Static Web Apps with `apps/web/staticwebapp.config.json`
  (`navigationFallback` to `index.html`, an exclude list by extension, `X-Frame-Options: DENY`).
  Nothing is served under `/.well-known/` today.
- **The server has no notification, device or push concept.** Attention items live only on the
  desktop (`attention_items` in `store.ts`, `'attention:list'` relayed through
  `ipcRelay.ts`). Server-side notifications arrive with F22. Live run output reaches a browser
  through `GET /v1/events` (SSE) and `cloudEventForwarder.ts`, which only forwards while
  somebody listens (`SyncResponse.eventListeners`).
- **Presence:** `presence.ts` and `browserFocusSignal.ts` (`visibilitychange`) put a focused
  client on the 2.5 s tier and a hidden one on the slow tier (`packages/protocol/src/cadence.ts`).
- **Secrets:** `apps/server/src/config/secrets.ts` maps Key Vault names to env vars at startup
  (`SECRET_ENV_MAP`).
- **CI/CD** (`docs/11-ci-cd-pipeline.md`): `release.yml` runs gates → version → `windows` and
  `linux` packaging into a **draft** → `promote` publishes only when both have uploaded
  (rule 4). Assets cannot be added to a release after it is published (RELEASE.md §6).
  `ci.yml` needs no secrets, which keeps it safe for fork PRs.
- **The cloud is paused** since 14 Oct 2026 (memory *cloud-service-paused*). F19.1 resumes it.
  Nothing in this file can be verified until then.

## Design

### Data model & contracts

- **Server — `push_devices`** (new migration): `id`, `accountId`, `fcmToken` (unique), `platform`
  (`android`), `appVersion`, `locale`, `createdAt`, `lastSeenAt`, `revokedAt`, and
  `prefs` JSON (`{ needsYou, reviews, mentions, aiVerdicts, quietHours? }`).
- **Wire (`packages/protocol/src/push.ts`):**
  - `POST /v1/push/devices` `{ fcmToken, appVersion, locale, prefs }` → `{ deviceId }`. This is an
    upsert by token, so a reinstall or token refresh never duplicates.
  - `PATCH /v1/push/devices/:id` `{ prefs }`; `DELETE /v1/push/devices/:id` on sign-out.
  - The push payload is a **minimal** FCM *notification* message: `title`, a short `body`, an
    Android `channel_id`, `collapse_key = <notificationId's subject>`, and `data: { route,
    notificationId, workspaceId }`. It never contains code, diff text, a token or a full
    question. The app fetches the real content after it opens, so a lock-screen preview leaks
    no more than the title.
- **Notification kinds → channels** (Android 8+ channels, user-tunable in system settings):

  | Kind (from F22) | Channel | Default importance |
  |---|---|---|
  | agent question, plan approval, permission, run failed or parked | *Agent needs you* | high |
  | review requested (F18), changes requested on my PR | *Reviews* | high |
  | @mention | *Mentions* | default |
  | AI review verdict (F16/F17) | *AI verdicts* | low |

- **Routes in the app** extend the compact grammar: `#/inbox/<filter>`, `#/issue/<id>/<section>`,
  `#/review/<forge>/<id>/<file>`. App-link paths map to them (see Deep links).

### Engine / desktop main process

None. The desktop's part (an attention item becoming a server notification) belongs to F22.
F23 only consumes F22's notification records.

### Server & relay

- New Nest module `apps/server/src/notifications/push/` (`push.controller.ts`,
  `push.service.ts`, `fcmClient.ts`) behind `IamAuthGuard`.
- **FCM HTTP v1**: `fcmClient.ts` signs a service-account JWT, exchanges it for an OAuth token
  (cached until shortly before expiry, the same shape as `iam.client.ts`'s `serviceToken`), and
  posts `projects/<id>/messages:send`. The service-account JSON is a new Key Vault secret,
  `fcm-service-account` → `FCM_SERVICE_ACCOUNT` in `SECRET_ENV_MAP`. Without it the module
  disables itself and logs once. Push is optional infrastructure, not a boot dependency.
- **Fan-out**: `push.service` subscribes to F22's "notification created" event. For each
  recipient's active devices whose prefs allow the kind:
  - **skip** if that account has a *focused* web, desktop or app session in the presence map
    within the last 60 s. You are looking at it already, so a buzz is noise.
  - one send per device, retried twice with backoff on 5xx or 429;
  - `404 UNREGISTERED` / `400 INVALID_ARGUMENT` on the token → set `revokedAt`. A dead token is
    never retried forever.
  - a per-account rate cap (20 per minute). Above it, sends collapse into one "N more things
    need you" per channel.
- **Dedup**: a push is keyed by `notificationId`. A redelivered F22 event does not buzz twice.
- **CORS:** the app's WebView origin is `https://app.tasks.vipper.network`, set through Capacitor's
  `server.hostname` with `androidScheme: 'https'`, added to `CLOUD_ALLOWED_ORIGINS`. That is
  deliberately **not** `https://localhost`, which would allow every local dev page.
- No relay changes. Every action the app takes is an existing web call: direct-tier writes
  (F19), relayed `ipc-invoke` for run actions (`task:chat`, `task:stopAgent`,
  `attention:answer`), and F18's review routes.

### The Android shell

- **`apps/mobile`**: a pnpm workspace package holding `capacitor.config.ts` (appId
  `network.vipper.tasks`) and the generated `android/` Gradle project, committed. It has no React
  code of its own.
- **Bundled, not remote.** `webDir` is a `vite build --mode mobile` output of `apps/web` with an
  absolute `VITE_CLOUD_API_BASE` and the Android IAM client id. Bundling gives an offline shell,
  a version the skew banner can reason about (`PROTOCOL_VERSION`, `SkewBanner.tsx`), and keeps
  clear of the store's rejection of "a website in a wrapper". The cost is that a web fix reaches
  phones only with an app update. Recommended mitigation: ship the APK on every release (see
  CI).
- **Platform bridge**: `apps/web/src/platform/` gains a `Platform` interface (`openAuthUrl`,
  `tokenStore`, `push`, `biometric`, `onAppUrlOpen`) with a `browser` implementation (today's
  behaviour) and a `capacitor` one loaded only when `Capacitor.isNativePlatform()`. Components
  never import Capacitor directly, so `apps/web` still builds and runs in a browser unchanged.
- Plugins, all from the Capacitor core set where one exists: `@capacitor/app` (URL open, back
  button, resume), `@capacitor/browser` (Custom Tabs), `@capacitor/push-notifications`,
  `@capacitor/preferences`, plus one maintained Keystore-backed secure-storage plugin and one
  biometric plugin, each chosen in its task and pinned.

### Sign-in in a WebView: why the system browser

The web flow cannot simply run inside the WebView:

- RFC 8252 says a native app must use an **external user agent** for OAuth. An embedded WebView
  lets the app read the password field, and any identity provider vipper.iam federates to later
  (F27's SSO) may refuse embedded user agents outright. Google already does
  (`disallowed_useragent`).
- **Passkeys** registered in vipper.iam do not work reliably in an Android WebView. A Custom Tab
  is real Chrome, with the user's password manager and passkeys.
- The redirect back must reach the app. Options:
  1. **A verified App Link** `https://tasks.vipper.network/app/callback`, with
     `/.well-known/assetlinks.json` served by the Static Web App. **Recommended.** It cannot be
     hijacked by another app, unlike a custom scheme.
  2. A custom scheme `network.vipper.tasks:/callback`. This is the fallback if App Link
     verification fails on a device (some OEM builds verify lazily).
- **Flow**: `beginSignIn` creates the PKCE pair and stores it in `@capacitor/preferences` (not
  `sessionStorage`: Android may kill the app process while the Custom Tab is open, and
  `sessionStorage` dies with it), then opens the authorize URL in a Custom Tab. vipper.iam
  redirects to the App Link. Android delivers it to `appUrlOpen`, the shell closes the tab, and
  `completeSignIn` redeems the code with the stored verifier.
- vipper.iam needs a **new public client** (`taskmanager-android`, `token_endpoint_auth_method:
  none`, grants `authorization_code` + `refresh_token`) whose redirect URIs are exactly the App
  Link and the custom scheme. node-oidc-provider will not accept a "similar" one.
- The refresh token moves from `localStorage` to Keystore-backed storage through the `tokenStore`
  interface. The existing single-flight refresh (`CloudAuth.inflight`) is kept. Rotation makes a
  second concurrent refresh fatal, and a push tap that wakes the app while a refresh is in
  flight must not start another.

### Push: what Android will and will not do

- An FCM **notification** message is displayed by the system even when the app is killed, and
  a tap starts the app with the `data` extras. That is why F23 uses notification messages, not
  data-only ones. A *high-priority data-only* message that does not lead to a visible
  notification is downgraded by Android over time, and Doze delays normal-priority messages.
- A **force-stopped** app receives nothing until it is opened again. Some OEM battery managers
  behave like force-stop for apps not opened recently. The app's Settings → Notifications page
  says so and links to the system battery setting. Nothing can be done server-side.
- Android 13+ requires the **`POST_NOTIFICATIONS` runtime permission**. It is asked for after
  sign-in, with one sentence of why, never on first launch. A denial is remembered, and the
  Inbox shows a quiet "Notifications are off" row with a button to system settings.
- Tokens rotate (`registration` fires again). The app re-posts on every launch and on every
  rotation. The server upsert makes that free.
- In the foreground, the push is not shown by the system. The app shows its own toast and
  refreshes the Inbox.

### Deep links

- App Link paths (also served by the web, so a link works with or without the app):
  `/i/<workspaceId>/<ticketKey>` → `#/issue/<id>/run`,
  `/r/<forge>/<project>/<number>` → `#/review/…`, `/inbox` → `#/inbox/needs-you`.
  Hash fragments cannot be matched by App Links, which is why these are paths that redirect
  into the hash route.
- `assetlinks.json` lists **both** SHA-256 fingerprints: the upload key's and the Play App
  Signing key's. With Play App Signing, the installed app is signed by Google's key, and an
  assetlinks file with only the upload key silently fails verification for every Play install.
- `staticwebapp.config.json`: exclude `/.well-known/*` from `navigationFallback`, serve
  `assetlinks.json` as `application/json`, and keep `X-Frame-Options: DENY`.

### Biometric unlock (optional)

- Off by default. When on, the app asks for BiometricPrompt (device credential allowed as
  fallback) on cold start and on resume after **5 minutes** in the background, before the
  token store is read. It is a lock on this device's copy of the token, not a second factor:
  it cannot be enforced by the server and does not pretend to be.
- If the device's biometric enrolment changes, the Keystore key is invalidated, and the app
  falls back to a fresh sign-in rather than an unlock loop.

### UI — web (compact mode, shared by the app)

Per the v9 phone mockups. Everything here renders in the web's compact mode as well; the app
adds nothing visual of its own except the system bars.

- **Shell**: a glass bottom tab bar (**Inbox · Issues · Reviews · Agents · More**). It replaces
  F3's Inbox/Board/Search/Settings; Board, Search and Settings move under Issues and More. It has
  a **2 px accent-gradient hairline** on top, near-opaque cards (F13 `paneGlass`, the same hint of frost as the desktop panes, with
  `backdrop-filter`, and the opaque fallback when "reduce transparency" is set or the WebView
  lacks support), and the Inbox badge as an orange dot (colour for attention only, memory
  *board-colour-budget*).
- **Inbox**: segmented filters **Needs you · Mentions · Reviews**. Cards per kind:
  - *Question*: key, ticket title, the question, and one-tap option chips (`development` /
    `main` / Other…).
  - *Plan to approve*: steps · model · estimated cost, **Approve** and **Read plan**.
  - *Review requested*: who, PR/MR number and title, `+184 −32 · 7 files · pipeline passed`.
  - *AI review finished*: the verdict line (`approved · 1 suggestion · merged`).

  Sorting keeps `attentionUrgency`. Answers go through the existing `CompactAnswerView` paths.
- **Issue**: back to Issues, key and milestone, title, chips (status, assignee "Agent", due).
  An **Agent run** card shows the runner desktop's name, the step checklist with the running
  step's elapsed time, and a two-line live log tail from the SSE event stream. Activity follows.
  A pinned composer **Message the agent…** (`task:chat`) has a **Stop** button
  (`task:stopAgent`).
- **Review**: back to Reviews, PR number and "author → you", title, a file pager
  (`src/upload/retry.ts`, `file 3 of 7 · +42 −9`, ‹ ›), and a unified diff with wrap on. **AI
  draft** suggestions sit inline with **Keep · Edit · Dismiss** (F16's drafts). A sticky footer
  shows "N drafts" with **Request changes** and **Approve** (F18 publishes them as one review).

### Failure modes & edge cases

- **The cloud is down or paused**: the shell still opens (bundled). The status strip says the
  server is unreachable, and the push module stays silent because there is nothing to send from.
- **Signed out on the server while a push arrives**: the tap opens the sign-in screen and then
  continues to the route. A route is never dropped on sign-in.
- **Push for something already answered elsewhere**: the app opens the Inbox with "answered on
  another device" (F3's resolved-elsewhere behaviour). F22 marking the notification read also
  cancels the system notification on the device (`removeDeliveredNotifications`).
- **The desktop that would answer a relayed action is offline**: run actions (answer, Stop,
  chat) fail like any relayed command and keep the draft. The Issue screen shows "WD-DESKTOP is
  offline". Ticket edits still work, because they are direct (F19).
- **App older than the server** (`PROTOCOL_VERSION` skew): the skew banner reads "Update the app",
  with a Play Store link. Push keeps working, because the payload format is versioned by
  additions only.
- **App Link verification failed on a device**: sign-in falls back to the custom scheme. Deep
  links open in the browser, which still works.
- **Revoked FCM token, uninstalled app**: the first send gets `UNREGISTERED`, and the device row
  is revoked. Sign-out deletes the row first.
- **Two accounts on one phone**: v1 supports one signed-in account. Switching account
  unregisters the device first.

## Out of scope (v1)

- iOS. Capacitor makes it possible later, but APNs, a Mac build host and App Store review are a
  separate project.
- A local replica or offline editing on the phone. The app reads the server like the web does.
- Running agents on the phone, or any desktop-host action (`ipcRelay` host-only stays refused).
- Email notifications (F22) and Web Push for the plain browser.
- Rich notification actions (answer from the notification shade). Tap-to-open only in v1.
- Tablet-specific layouts beyond F3's medium mode.

## Open questions

- **Play Store or sideload?** Recommended default: **both**. The signed APK goes on every
  GitHub release for sideloading, from day one. Play goes through the internal-testing track
  first. A personal Play developer account created after November 2023 must run a closed
  test with at least 12 testers for 14 days before it may publish to production, and the app
  needs a privacy policy and a Data safety form. Plan for that lead time; do not discover it at
  launch.
- **Bundled web assets or the live site in the WebView?** Recommended default: **bundled**
  (offline shell, store policy, skew is explicit). Revisit live updates only if release cadence
  makes bundled fixes too slow.
- **Must the Android job gate the desktop release?** Recommended default: **yes**. It joins
  `promote`'s required jobs like `linux`, because assets cannot be added after publish.
  If that is too costly, give the APK its own `android-v*` tag.
- **App Link or custom scheme for the OAuth callback?** Recommended default: **App Link**, with
  the custom scheme registered as the fallback.
- **Skip pushes while the user is active elsewhere?** Recommended default: **yes**, with a
  60-second presence window. It can be turned off per device.
- **Biometric re-lock interval.** Recommended default: **5 minutes** in the background.

## Tasks

### F23 · Phase 1 — The shell and sign-in

- [ ] F23.1 Scaffold the Capacitor app around the web build

  - `apps/mobile` (`capacitor.config.ts`, committed `android/` project, `pnpm --filter @tm/mobile build:debug`), `vite build --mode mobile` in `apps/web` with an absolute API base, and the `Platform` interface in `apps/web/src/platform/` with the browser implementation (today's behaviour) and a lazily loaded Capacitor one.
  - Acceptance: a debug APK builds locally with the documented JDK and SDK versions. `pnpm build` for `@tm/web` is byte-identical in behaviour (no Capacitor import in the browser bundle, asserted by a bundle grep test). Gates green.
- [ ] F23.2 Register the app origin with the server and vipper.iam @needs: F23.1 Scaffold the Capacitor app around the web build

  - `server.hostname: 'app.tasks.vipper.network'` with `androidScheme: 'https'`. Add that origin to `CLOUD_ALLOWED_ORIGINS` in the deploy config. Register the `taskmanager-android` public client in vipper.iam with exactly the App Link and custom-scheme redirect URIs, and record it in `docs/10-cloud-deployment-runbook.md`.
  - Acceptance: `cors.test.ts` covers the new origin and still refuses `https://localhost` in production. An authorize request with the registered redirect is accepted and one off by a character is refused (checked once against the live IAM, recorded).
- [ ] F23.3 Sign in through the system browser with an App Link callback @needs: F23.2 Register the app origin with the server and vipper.iam

  - The Capacitor `openAuthUrl` (Custom Tab), PKCE state in `@capacitor/preferences`, the `appUrlOpen` → `completeSignIn` route, and `/.well-known/assetlinks.json` (both upload and Play App Signing fingerprints) served by the Static Web App with `navigationFallback` excluding `/.well-known/*`. Custom-scheme fallback.
  - Acceptance: unit tests for the callback parser (state mismatch, missing code, both redirect forms) and for state surviving a simulated process death. A test that `staticwebapp.config.json` excludes `/.well-known/`. On-device sign-in with a passkey recorded in the device checklist.
- [ ] F23.4 Keep the refresh token in Keystore-backed storage @needs: F23.3 Sign in through the system browser with an App Link callback

  - A `TokenStore` seam in `cloudAuth.ts` (`localStorage` in the browser, a pinned secure-storage plugin on Android) and a one-time move of any existing token. The single-flight refresh is kept across a push-triggered resume.
  - Acceptance: tests with a fake `TokenStore`: two concurrent `getAccessToken()` calls spend one refresh token; a dead token fires `onSessionEnded` and clears the store.

### F23 · Phase 2 — The v9 phone screens

- [ ] F23.5 Adopt the v9 mobile tab bar and glass surfaces in compact mode @needs: F23.1 Scaffold the Capacitor app around the web build

  - Rebuild `BottomTabBar` as Inbox · Issues · Reviews · Agents · More (Board, Search, Settings under Issues and More), with the 2 px accent-gradient hairline, near-opaque cards and bars on F13 `paneGlass`, the opaque fallback for reduce-transparency, and the new routes in `compactRoute.ts`. Shared components only (memory *web-mirrors-the-desktop*).
  - Acceptance: route parser tests for the new and old hashes (an old `#/board/<col>` still lands); `test/shell-parity.test.ts` green; a test that the fallback tokens are chosen when `backdrop-filter` is unsupported. Start after F13 has shipped its tokens.
- [ ] F23.6 Build the Inbox with Needs you, Mentions and Reviews filters @needs: F23.5 Adopt the v9 mobile tab bar and glass surfaces in compact mode

  - The question, plan, review-requested and AI-verdict cards from the mockups. Sources: the relayed `attention:list` (today) merged with F22's notification list. `attentionUrgency` sorting is kept. 44 px targets.
  - Acceptance: selector tests for the filter split and the merge (one item from both sources shows once); F3's resolved-elsewhere test still passes.
- [ ] F23.7 Build the Issue screen with the live agent run, message and Stop @needs: F23.5 Adopt the v9 mobile tab bar and glass surfaces in compact mode

  - The run card (runner desktop name, step checklist with the running step's elapsed time, a two-line log tail from `GET /v1/events`), activity, and the pinned composer (`task:chat`) with **Stop** (`task:stopAgent`). Shows "<desktop> is offline" when the runner is not polling.
  - Acceptance: tests for the step list view model and the log-tail reducer (bounded to N lines, survives an SSE gap frame). The relay failure keeps the composer draft.
- [ ] F23.8 Build the Review screen with AI drafts and a sticky verdict bar @needs: F23.5 Adopt the v9 mobile tab bar and glass surfaces in compact mode

  - The file pager, unified diff with wrap, inline AI drafts with Keep · Edit · Dismiss (F16), and a sticky "N drafts · Request changes · Approve" bar that publishes one review (F18). It reuses F3.8's compact review pieces.
  - Acceptance: tests of the draft-curation state (keep, edit, dismiss, count) and that Approve with zero kept drafts sends an approval with no comments. Start only after F16 and F18 have shipped.

### F23 · Phase 3 — Push notifications

- [ ] F23.9 Add device registration and the FCM client to the server @needs: F23.2 Register the app origin with the server and vipper.iam

  - Migration for `push_devices`, `apps/server/src/notifications/push/` (controller, service, `fcmClient.ts` with a cached OAuth token), `fcm-service-account` in `SECRET_ENV_MAP`, and self-disable when the secret is missing. `packages/protocol/src/push.ts`.
  - Acceptance: tests for the upsert-by-token, the JWT and token cache (refresh before expiry), the self-disable path, and revoke on `UNREGISTERED`. The F19.2 `test:db` harness covers the migration.
- [ ] F23.10 Fan F22 notifications out to devices @needs: F23.9 Add device registration and the FCM client to the server

  - Subscribe to F22's notification-created event. Map kinds to channels. Skip when the account has a focused session within 60 s (presence map). Dedupe by `notificationId`. Apply the per-account rate cap with the collapsed "N more" message. Use a minimal payload with no code or secrets. Cancel on read.
  - Acceptance: pure tests for kind → channel, the presence skip, the rate cap and collapse, and payload redaction (a test fails if a diff or question body is put in the payload). Start only after F22's notification store has shipped.
- [ ] F23.11 Register for push on the device and route taps @needs: F23.10 Fan F22 notifications out to devices, F23.4 Keep the refresh token in Keystore-backed storage

  - Create the four Android channels. Ask for `POST_NOTIFICATIONS` after sign-in with a one-line reason. Register the token on launch and on rotation; unregister on sign-out. Route a tap through sign-in if needed. Foreground pushes become an in-app toast. Settings → Notifications per kind, with the battery-optimisation note.
  - Acceptance: tests for tap → route (signed in, signed out, unknown route falls back to Inbox) and for re-registration on rotation. On-device: a push received with the app killed and with it in Doze, recorded.

### F23 · Phase 4 — Deep links and lock

- [ ] F23.12 Open issue, review and inbox links in the app @needs: F23.3 Sign in through the system browser with an App Link callback, F23.5 Adopt the v9 mobile tab bar and glass surfaces in compact mode

  - App Link intent filters for `/i/…`, `/r/…` and `/inbox`. The same paths redirect into hash routes in the plain web. Ticket keys are resolved through F19's workspace data.
  - Acceptance: path → route parser tests (a renamed prefix still resolves through the key history, an unknown key shows "not found" rather than a blank screen). On-device: a link tapped in an email opens the app, recorded.
- [ ] F23.13 Add an optional biometric unlock @needs: F23.4 Keep the refresh token in Keystore-backed storage

  - Off by default. BiometricPrompt with a device-credential fallback before the token store is read, on cold start and after 5 minutes in the background. An invalidated key leads to a fresh sign-in.
  - Acceptance: tests of the lock timer state machine (background, resume, threshold, invalidated key). On-device: enable, lock, unlock, and change enrolment, recorded.

### F23 · Phase 5 — Build, sign, ship

- [ ] F23.14 Build and sign the Android app in the release pipeline @needs: F23.11 Register for push on the device and route taps

  - An `android` job in `release.yml` (ubuntu, pinned JDK and SDK) that builds a signed APK and AAB from the release tag and uploads the APK into the draft. `versionCode` comes from the semver (`major·1 000 000 + minor·1 000 + patch`), `versionName` is the app version, and `promote` requires it, as it requires `linux`. Secrets `ANDROID_KEYSTORE_B64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD` are documented in `docs/11-ci-cd-pipeline.md`. `ci.yml` builds an **unsigned** debug APK only, so it stays secret-free.
  - Acceptance: a test for the `versionCode` function (monotonic across every existing tag). A dry-run release on a branch produces a draft with the APK, and `apksigner verify` passes in the job. A broken Gradle build fails `promote` (proved once).
- [ ] F23.15 Publish to Play internal testing and run the device checklist @needs: F23.14 Build and sign the Android app in the release pipeline, F23.6 Build the Inbox with Needs you, Mentions and Reviews filters, F23.7 Build the Issue screen with the live agent run, message and Stop, F23.8 Build the Review screen with AI drafts and a sticky verdict bar, F23.12 Open issue, review and inbox links in the app, F23.13 Add an optional biometric unlock

  - Play Console listing, privacy policy, Data safety form, Play App Signing (its fingerprint added to `assetlinks.json`), and the internal track. `docs/plan/feature-roadmap/F23-device-checklist.md` lists sign-in with a password and a passkey; push with the app killed, in Doze and force-stopped (expected: none); answer a question; approve a plan; Stop a run; curate drafts and approve a review; open an email link; biometric lock; reduce-transparency on; and the cloud unreachable.
  - Acceptance: every checklist row is recorded against a build version on at least two devices (one Pixel, one non-Pixel OEM). Gates green with `--force`. The closed-testing clock (12 testers, 14 days) is started if production is wanted.
