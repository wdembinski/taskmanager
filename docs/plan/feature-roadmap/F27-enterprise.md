# F27 — Enterprise: SSO, SCIM, audit log, permissions, export

> **Status:** proposed · **Where:** server (`apps/server`), web, client (desktop main + `packages/ui`), packages (`shared`, `protocol`), plus work in the vipper.iam repo · **Depends on:** F19 (workspaces, members, roles), F22 (collaboration: the actions to audit and the people to notify); F21 (soft: team-level permissions once teams exist); F20 (soft: agent runs as audited, permissioned actions) · **Unlocks:** adoption by organisations that require SSO, provisioning and an audit trail
> Only the `- [ ]` checkboxes under **Tasks** become cards when this file is imported as a plan; everything else is context.
>
> **Layout rule for this file:** every task's description bullets sit after a **blank line**. The plan
> parser folds any indented line that directly follows a checkbox into that task's *title*
> (`apps/client/src/main/planParser.ts:173-177`); the blank line is what keeps descriptions out of it.

## Why

F19 gives a workspace members and three roles. That is enough for a small team that trusts each
other, and not enough for an organisation:

- People should sign in with the organisation's own identity provider, and the workspace should
  refuse anyone who did not.
- Somebody leaving the company must lose access the same hour, without an admin remembering
  this app exists. That includes the PAT they made six months ago.
- "Who changed this, and who gave them the right to?" needs an answer that nobody, including an
  admin, can quietly edit.
- A contractor should see one project, not the whole backlog, and only until their contract
  ends.
- The data must be exportable in full, as a file, whenever the organisation asks.

F27 adds those five things. Most of the identity work belongs in vipper.iam, which is already
this product's identity provider. F27 is explicit about which half lives where.

## What we have today

**Task Manager server (`apps/server`):**

- Authentication is `IamAuthGuard` (`apps/server/src/iam/iamAuth.guard.ts`). A PAT-shaped bearer
  resolves **locally** through `PatService` (`iam/patService.ts`) and never reaches vipper.iam.
  Every other bearer is introspected (`iam/iam.client.ts`: `active`, `sub`, `sub_type`, `scope`,
  `aud`, and nothing else), then authorized as `{ resourceType: 'taskmanager', identifier:
  accountId, action: 'read' | 'write' }`. Both answers are cached for a few seconds
  (`iam/authCache.ts`).
- **Consequence:** if vipper.iam deactivates a user, their bearer stops working within the cache
  window, but **their PATs keep working** until they expire (up to `MAX_PAT_EXPIRY_DAYS = 365`,
  or never, `PAT_EXPIRY_CHOICES` includes `null`; `packages/protocol/src/wire.ts:671-687`).
  Nothing tells this server a user is gone.
- F19 adds `workspaces`, `workspace_members` (role `admin | member | guest`),
  `workspace_member_projects` (guest visibility), invites, and the pure
  `workspaceCan(role, action, ctx)` in `packages/shared/src/workspaceRoles.ts`. It also adds the
  per-workspace change stream with `hidden` tombstones for rows that leave a guest's view.
- **There is no audit log.** The `commands` table calls itself "a small audit trail of what was
  relayed" (`entities/command.entity.ts`), but it holds relay payloads, not decisions. F19's
  `ws_ticket_history` records field changes on tickets only.
- Attachments are stored by `attachments/sqlBlobStore.ts` behind `blobStore.ts`, downloaded with
  short-lived media tokens (`attachments/mediaTokens.ts`). This is the obvious carrier for an
  export file.
- No server-side export of any kind exists.

**vipper.iam (the separate repo at `C:\Repositories\iam`):**

- It provides users, roles, permissions, PATs, an OIDC provider (node-oidc-provider), TOTP and
  passkeys (`apps/backend/src/mfa`, `webauthn`), service accounts, resource types and groups, and
  per-resource **access grants** on top of RBAC (`access-grants/`, `authorize/`: "may this
  credential do `action` on `(resourceType, identifier)`"). It also has an append-only
  `audit_events` table for its own security events (`audit/audit-event.entity.ts`).
- **It does not provide:**
  - SAML, or signing in through an external identity provider (no upstream federation);
  - SCIM. It is a backlog item in its own `docs/plan.md` ("SCIM 2.0 — `/Users` + `/Groups` …
    most valuable *after* multi-tenancy");
  - organisations or tenants (backlog item **E**, "the largest structural change");
  - self-registration (users are created by an administrator).
- Its introspection does not say **how** a user signed in, so an "SSO required" rule has
  nothing to check today.

## Design

### Where each piece lives

| Capability | vipper.iam | Task Manager server |
|---|---|---|
| SAML 2.0 and OIDC sign-in through an organisation's IdP (identity brokering), JIT user creation | **yes**: it is the identity provider; TM never speaks SAML | nothing; it still only sees vipper.iam tokens |
| An `idp` / `amr` claim saying which connection a session came from, in introspection | **yes** | reads it to enforce per-workspace SSO |
| SCIM `/Users` (create, update, deactivate) | **yes**: it owns the user directory | nothing directly |
| SCIM `/Groups` and group membership | **yes** | maps groups to workspace roles |
| A "user deactivated" signal (webhook or event) | **yes**, emits it | consumes it: suspends memberships, revokes TM PATs |
| Organisations / tenants | backlog E, optional for F27 | workspaces are TM's own tenant boundary already |
| Workspace roles, capabilities, guests, project scoping | no | **yes** (F19 tables, extended here) |
| Audit log of workspace actions | its own security events only | **yes**, new |
| Full workspace export | no | **yes** |

The rule: **identity in vipper.iam, authorisation over workspace data in Task Manager.**
vipper.iam's access grants could in principle hold per-workspace grants (each workspace
registered as a resource identifier). That would put every ticket read on a network round trip
and split one permission model across two services, so it is not used. vipper.iam stays the
coarse "may use taskmanager" gate it is today.

### Data model & contracts

**Audit log (server):**

- `ws_audit_events`: `id`, `workspaceId` (nullable for account-level events), `at`,
  `actorAccountId`, `actorKind` (`user | pat | agent | system | scim`), `actorClientId`,
  `ip`, `userAgent`, `action`, `targetType`, `targetId`, `summary` (a short, human sentence),
  `details` JSON (before/after for settings and permissions, **never** ticket bodies or
  secrets), `requestId`.
- **Append-only by construction:** no update or delete route, and the migration runs
  `DENY UPDATE, DELETE ON ws_audit_events TO <app role>`. Retention is the one deletion, run by
  a separate maintenance job under a different principal. Every purge itself writes an event.
- The writer runs **in the same transaction** as the change it records. An action that commits
  without its audit row is impossible; a failed audit write rolls the action back.
- The event catalogue is a typed union in `packages/shared/src/auditEvents.ts`. A test
  enumerates every mutating controller route and fails if one has no audit action mapped (the
  same exhaustiveness idea as `ipcRelay.ts`).

**Capabilities (replacing F19's fixed role table):**

- Capabilities: `ticket.read`, `ticket.create`, `ticket.edit`, `ticket.delete`, `comment.create`,
  `comment.moderate`, `project.manage`, `milestone.manage`, `member.invite`, `member.manage`,
  `agent.assign`, `agent.run` (F20), `workspace.settings`, `workspace.export`, `audit.read`,
  `sso.manage`.
- Built-in roles are **named capability sets** (`admin`, `member`, `guest`, plus `viewer`).
  Custom roles are capability sets an admin defines. F19's three roles migrate one to one.
- **Scopes**: a grant applies to the whole workspace, or to one project (or one team, once F21
  exists). `ws_role_grants(workspaceId, principalType: 'member' | 'group', principalId, roleId,
  scopeType: 'workspace' | 'project' | 'team', scopeId, expiresAt)`.
- Resolution is one pure function, `can(principal, capability, resource)` in
  `packages/shared/src/permissions.ts`: the union of every grant whose scope contains the
  resource and has not expired. **No deny rules** in v1. Deny rules make "why can she see this?"
  unanswerable.
- `GET /v1/workspaces/:id/me/capabilities` → effective capabilities per scope, so the desktop
  and the web hide controls with the same answer the server enforces.

**Guests:** a guest is a member whose grants are project-scoped and **must** carry an
`expiresAt` (default 90 days, maximum 1 year). A guest never sees the member list beyond the
people on their projects. A guest cannot hold `agent.assign` or `agent.run`: an agent run
executes on an employee's machine, with that machine's credentials.

**SSO enforcement:** `workspace_sso`: `workspaceId`, `connectionId` (vipper.iam's id for the
organisation's IdP connection), `verifiedDomains` (DNS TXT verified), `required` (bool),
`allowPats` (bool, default false), `jitRole` (role for a first sign-in from a verified domain,
default none).

**Group mapping:** `ws_group_bindings(workspaceId, iamGroupId, roleId, scopeType, scopeId)`. The
server reads the `groups` claim from introspection (a vipper.iam addition) and materialises
grants with `principalType: 'group'`.

**Export:** `ws_exports(id, workspaceId, requestedBy, status, blobId, bytes, createdAt,
expiresAt, error)`. The file is a ZIP: `manifest.json` (format version, workspace, counts,
checksums), one NDJSON file per entity (projects, tickets, milestones, labels, links, comments,
history, members, role grants), `attachments/<id>` blobs, and `audit.ndjson` if requested.

### Engine / desktop main process

- The replica stores the effective capabilities from `/me/capabilities` and refreshes them on
  every change-stream page that carries a `permissions` marker.
- When a grant is removed, the change stream already sends `hidden` tombstones (F19). The
  replica deletes those rows. **What was on disk before cannot be wiped remotely.** The admin UI
  says so in words.
- A deprovisioned account: the next request returns `401 account-suspended` (distinct from a
  token problem). The desktop stops syncing every cloud workspace, marks each replica
  `suspended`, and offers only "Delete local data". No "Make a local copy" (F19.17), because the
  organisation has withdrawn access to the data.
- PATs: a desktop never uses a PAT for workspace sync. It signs in interactively. So
  `allowPats: false` does not affect it.

### Server & relay

- **One guard order** for every workspace route: `IamAuthGuard` (who) → account status (not
  suspended) → `WorkspaceGuard` (member, not expired) → SSO check (when `required`: the token's
  `idp` equals `connectionId`; a PAT is refused unless `allowPats`) → `can()` for the route's
  capability → handler → audit writer in the same transaction.
- **Deprovisioning** reaches this server two ways, and both are needed:
  1. **Push**: vipper.iam posts `user.deactivated` / `user.reactivated` to
     `POST /v1/iam/events`, signed with a shared secret in Key Vault. The server sets
     `accounts.suspendedAt`, revokes every PAT of that account (`PatService`), suspends
     memberships and writes audit events.
  2. **Pull, as a backstop**: a PAT that resolves locally is checked against
     `accounts.suspendedAt`. Once a day a job introspects a service-side probe for every account
     with an active PAT (vipper.iam's admin API, by subject) and suspends any that vipper.iam
     reports inactive. Without the backstop, one lost webhook leaves a PAT alive for a year.
- **SCIM groups** do not call this server directly. vipper.iam owns groups, the `groups` claim
  carries them, and a group change takes effect at the next token refresh. Bindings are
  re-evaluated on every request through the auth cache, so it takes minutes, not a sync.
- `ipcRelay.ts`: `audit:list` and `workspace:export` relay. Downloading an export is a direct
  web download (a media token) and is never relayed. The new SSO and role settings channels
  relay. Nothing new is host-only.

### UI — desktop and web (shared `@tm/ui`)

- Settings → Workspace gains **Roles & access** (members with their effective roles per scope,
  guests with expiry dates, group bindings, custom roles as capability checklists),
  **Security** (SSO connection, verified domains, Require SSO, Allow PATs, JIT role) and
  **Audit log**.
- **Audit log** is a dense table: time, actor, action, target, and summary. Filters are actor,
  action group, target and date range. It exports to CSV or NDJSON. The view and the export are
  themselves audited (`audit.viewed`, `audit.exported`).
- A control the user lacks the capability for is **hidden** when it would never apply to them
  (a guest never sees "Invite"). It is **disabled with a one-line reason** when it applies but is
  blocked here ("Project admins only"). The reason is never a tooltip alone: it shows inline on
  touch (F3's rule).
- **Export workspace…**: an admin starts it, sees progress, and gets a download link valid for
  24 h. The completed export is listed with who started it.
- Colour stays reserved for movement and attention (memory *board-colour-budget*). A suspended
  replica uses the orange attention state in the status bar; nothing else in this feature gets
  colour.

### Failure modes & edge cases

- **Locked out by SSO**: an admin turns on Require SSO while signed in with a password. The
  setting refuses unless the admin's own current session came through the connection
  ("Sign in with <IdP> first, then turn this on"). There is always at least one admin who can
  still get in.
- **The IdP is down**: Require SSO means nobody can sign in. That is correct behaviour, and the
  page says so. vipper.iam's break-glass admin can still turn the requirement off, and that
  change is audited.
- **A webhook is lost or arrives twice**: events carry an id and are applied idempotently. The
  daily backstop catches a lost one.
- **A user is reactivated**: memberships come back with their old grants. Revoked PATs stay
  revoked, because a PAT revocation is never undone.
- **A guest's grant expires mid-session**: the next request loses visibility, `hidden` tombstones
  follow, and the guest sees "Your access to <project> ended on <date>".
- **A custom role loses a capability that a running agent needs** (F20): runs in progress finish;
  the next start parks with "You no longer have permission to run agents in <project>".
- **A huge export**: it streams page by page from the change-stream readers into the ZIP and
  never holds the workspace in memory. Attachments stream from the blob store. A size cap per
  export (configurable, default 5 GB) refuses with a reason before starting.
- **An audit write fails**: the action fails with it. That is the point. An alert fires, because
  a failing audit table stops every write in the workspace.
- **Clock and ordering**: audit rows are ordered by an identity column and `at` from the database
  (`SYSUTCDATETIME()`), never a client clock.

## Out of scope (v1)

- SAML or SCIM implemented inside Task Manager. Both belong in vipper.iam.
- vipper.iam organisations / multi-tenancy (its backlog E). F27 works without it: one
  vipper.iam instance serves several organisations' connections, and workspaces are the tenant
  boundary in this app.
- Deny rules, attribute-based conditions (time-of-day, IP ranges), field-level permissions.
- Remote wipe of a desktop replica or the phone's cache.
- Data residency choices, customer-managed encryption keys, and a signed BAA or DPA process.
- Streaming the audit log to an external SIEM. Export to file is v1; a push sink is a later
  addition.
- Restoring an export **over** an existing workspace. Import always creates a new one.

## Open questions

- **SCIM in vipper.iam before or after its multi-tenancy (E)?** Recommended default: **before,
  scoped per IdP connection**. One SCIM token per connection is enough to provision and
  deprovision users without tenants. Tenants can come later without changing this server.
- **Groups claim or a group-sync API?** Recommended default: **the `groups` claim** on
  introspection. It needs no new channel and stays fresh at token refresh. Revisit if group
  counts make tokens large (then introspection returns group ids only, and names come from an
  API).
- **Audit retention.** Recommended default: **400 days**, configurable per workspace between 90
  days and 7 years.
- **May an admin read ticket content of a project they have no grant on?** Recommended default:
  **yes**. `admin` includes every capability at workspace scope; a "restricted project" that
  hides content from admins is out of scope for v1.
- **Do agent runs write audit events?** Recommended default: **yes, start and stop only** (who,
  which ticket, which desktop, which model), not each step. Steps stay in the run's own record
  (F20).
- **Should PATs be allowed in an SSO-required workspace?** Recommended default: **no**, with an
  explicit per-workspace opt-in for automation, and every PAT use audited.

## Tasks

### F27 · Phase 1 — Audit log

- [ ] F27.1 Add the append-only audit log and its transactional writer

  - Migration for `ws_audit_events` with `DENY UPDATE, DELETE` for the app role. `apps/server/src/audit/auditWriter.ts` takes the caller's `EntityManager`, so it runs in the same transaction. `packages/shared/src/auditEvents.ts` holds the typed catalogue.
  - Acceptance: a `test:db` test (F19.2's harness) proves an UPDATE as the app role is refused, and that an action whose audit insert throws rolls back. Unit tests for the summary sentences.
- [ ] F27.2 Record every security-relevant workspace action @needs: F27.1 Add the append-only audit log and its transactional writer

  - Membership, invites, role and grant changes, workspace settings, SSO settings, publish and import, ticket and project deletes, PAT create, use-in-workspace and revoke, export start and download, and agent run start and stop (F20).
  - Acceptance: `test/audit-coverage.test.ts` enumerates every mutating route in `apps/server/src/**/*.controller.ts` and fails when one maps to no audit action (proved by adding an unmapped route). Details never contain a ticket body or a token (a redaction test).
- [ ] F27.3 Show and export the audit log for admins @needs: F27.2 Record every security-relevant workspace action

  - `GET /v1/workspaces/:id/audit` (paged, filtered), the shared `AuditLogView` in `@tm/ui` on desktop and web, CSV and NDJSON export, a retention setting, and the maintenance purge job under its own principal, which writes its own event.
  - Acceptance: tests for the filter query builder and paging cursor; viewing and exporting write `audit.viewed` / `audit.exported`. The purge never deletes inside the retention window (boundary test).

### F27 · Phase 2 — Capabilities and guests

- [ ] F27.4 Replace fixed roles with capability sets and scoped grants

  - `packages/shared/src/permissions.ts` (`can()`, the built-in role sets, union-only resolution, expiry). Migration for `ws_roles` and `ws_role_grants`, mapping F19's roles one to one. `GET /v1/workspaces/:id/me/capabilities`.
  - Acceptance: a table-driven test of `can()` over every built-in role × capability × scope, plus expiry. A migration test proves every F19 member has identical effective rights before and after.
- [ ] F27.5 Enforce capabilities on every route and in the change stream @needs: F27.4 Replace fixed roles with capability sets and scoped grants

  - One `@Requires(capability, resourceFrom)` decorator per workspace route, checked by the guard after `WorkspaceGuard`. The change stream filters by `ticket.read` per project and emits `hidden` tombstones on loss.
  - Acceptance: a test enumerates workspace routes and fails on one without `@Requires`. `test:db` proves a project-scoped member reads one project only, and loses it on grant removal.
- [ ] F27.6 Hide or explain controls by capability on desktop and web @needs: F27.5 Enforce capabilities on every route and in the change stream

  - A `useCan(capability, resource)` hook in `@tm/ui` fed by `/me/capabilities` (replica on desktop, server on web). Hide what can never apply; disable-with-reason what is blocked here. The reason shows inline, never only in a tooltip.
  - Acceptance: selector tests for hide-versus-disable decisions; `test/shell-parity.test.ts` green. A grep test that no component reads a role name directly (only capabilities).
- [ ] F27.7 Invite guests to projects with an expiry @needs: F27.5 Enforce capabilities on every route and in the change stream

  - Guest invites name projects (or teams, after F21) and an expiry (default 90 days, maximum 1 year). Expiry is enforced on every request. Guests are barred from `agent.*` capabilities. A guest's member list is limited to collaborators. "Your access ended" screen.
  - Acceptance: tests that a guest grant without expiry is refused, a guest role with `agent.run` is refused, an expired grant loses access on the next request, and a guest's member list excludes non-collaborators.

### F27 · Phase 3 — SSO, SCIM and deprovisioning

- [ ] F27.8 Write the vipper.iam contract for SSO, SCIM and deactivation events

  - `docs/plan/feature-roadmap/F27-iam-contract.md`: identity brokering (SAML 2.0 and OIDC upstream connections, JIT users), the `idp` and `groups` claims on introspection, SCIM `/Users` and `/Groups` per connection, and the signed `user.deactivated` / `user.reactivated` webhook with idempotency ids. Filed as tickets against the vipper.iam repo. No code in that repo from this plan.
  - Acceptance: the contract has request and response examples for every item, and the vipper.iam owner signs it off (recorded). The phase's later tasks start only once the vipper.iam side has shipped.
- [ ] F27.9 Suspend accounts and revoke PATs when vipper.iam deactivates a user @needs: F27.8 Write the vipper.iam contract for SSO, SCIM and deactivation events

  - `POST /v1/iam/events` (signed, idempotent), `accounts.suspendedAt`, revoke of every PAT, membership suspension, the `401 account-suspended` answer, the PAT path checking suspension, and the daily backstop job against vipper.iam's admin API. The desktop handles `suspended` replicas.
  - Acceptance: tests for the signature check, replay, and ordering (deactivate then reactivate). A test that a valid, unexpired PAT of a suspended account is refused. The backstop suspends an account whose webhook was never delivered (simulated).
- [ ] F27.10 Enforce SSO per workspace @needs: F27.9 Suspend accounts and revoke PATs when vipper.iam deactivates a user

  - `workspace_sso` (connection, DNS-TXT verified domains, required, allowPats, jitRole), the guard step that checks the `idp` claim, the self-lockout refusal, JIT membership for verified domains, and the Security settings page. Every change is audited.
  - Acceptance: tests that a password session is refused when SSO is required, a PAT is refused unless `allowPats`, enabling is refused from a non-SSO session, and domain verification fails on a wrong TXT record.
- [ ] F27.11 Map vipper.iam groups onto workspace roles @needs: F27.10 Enforce SSO per workspace

  - `ws_group_bindings`, grants with `principalType: 'group'` resolved from the `groups` claim on each request through the auth cache, and the bindings UI in Roles & access.
  - Acceptance: `can()` tests with group-derived grants (union with direct grants, removal on group loss). An end-to-end test with a fake introspection proves a SCIM group removal ends access at the next token refresh.

### F27 · Phase 4 — Full workspace export

- [ ] F27.12 Export a whole workspace as a file @needs: F27.2 Record every security-relevant workspace action

  - `ws_exports` and an async job that streams NDJSON per entity and attachments into a ZIP in the blob store (manifest with format version, counts and checksums), a size cap refused up front, a 24 h media-token download, admin-only (`workspace.export`), and audited.
  - Acceptance: `test:db` exports a seeded workspace and verifies manifest counts and checksums. Memory stays bounded (a 50,000-ticket fixture streams under a fixed heap ceiling). An over-cap export is refused with its reason before any work starts.
- [ ] F27.13 Import an export into a new workspace @needs: F27.12 Export a whole workspace as a file

  - Reuse F19's import sessions to create a new workspace from an export file (keys, links, history and comments kept; members mapped or left as unassigned). Never over an existing workspace.
  - Acceptance: a round-trip test (export → import → export) gives identical entity files apart from ids and timestamps that the manifest declares as regenerated.

### F27 · Phase 5 — Prove it

- [ ] F27.14 Verify the enterprise controls end to end @needs: F27.3 Show and export the audit log for admins, F27.6 Hide or explain controls by capability on desktop and web, F27.7 Invite guests to projects with an expiry, F27.11 Map vipper.iam groups onto workspace roles, F27.13 Import an export into a new workspace

  - A scenario script against the docker server with a fake vipper.iam: deactivate a user (bearer, PAT and desktop replica all lose access, all audited); require SSO; expire a guest; remove a group binding; export and re-import. Check that the audit log contains exactly the expected events.
  - Acceptance: every scenario passes, and the script is shown to fail when the PAT suspension check is removed. All three gates green with `--force` (memory *a-cached-gate-is-not-a-gate*). Results recorded in this file.
