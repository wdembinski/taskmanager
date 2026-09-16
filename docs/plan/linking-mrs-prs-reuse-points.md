# Linking GitLab MRs / GitHub PRs — verified reuse points

Step 1 of *Linking GitLab MRs and GitHub PRs automatically when created manually*
(`feat/linking-gitlab-mrs-and-github-prs`). The approved plan's step 1 heading was itself
exploration notes rather than an actionable phase, so `planToSubtasks` split it into its own
step — but a step's prompt only carries its **sibling's title** as a one-liner, not the body,
so the detail below would otherwise be lost before step 2 ("Plan") ever saw it. This file is
that hand-off: every claim from the approved plan re-checked against the code as it stands on
this branch today, plus the caveats found while checking.

## Verdicts at a glance

| # | Claim | Verdict |
|---|-------|---------|
| 1 | `MergeRequest` is one type for both forges; `openedForTaskId` is carried, never re-derived | ✅ confirmed |
| 2 | `store.upsertMergeRequest` `COALESCE`s `openedForTaskId` so a link can't be blanked | ✅ confirmed |
| 3 | `describeMergeRequest` / `describePullRequest` turn one MR/PR into `FetchedMergeRequest`, reusable verbatim | ✅ confirmed |
| 4 | `listedFromDetail(detail, owner, repo)` dresses a GitHub detail response as the listing shape | ✅ confirmed |
| 5 | `reconcileMergeRequests` / `reconcilePullRequests` map a `FetchedMergeRequest` into a full `MergeRequest`, reusable with a single-item array | ⚠️ confirmed, with a caveat (see below) |
| 6 | `GitHubClient.getPullRequest(owner, repo, number)` takes the strings a URL gives | ✅ confirmed |
| 7 | `GitLabClient.getMergeRequest(projectId, iid)` takes a numeric id, does not URL-encode, needs a path-addressed sibling | ✅ confirmed |
| 8 | IPC wiring template is `task:createPullRequest`: contract → `ipcRelay` → `ipc.ts` handler via `createPrDeps()` | ✅ confirmed |
| 9 | Preload is a generic passthrough — no per-channel edit needed | ✅ confirmed |
| 10 | `TaskAgentPanel.tsx` owns provider actions at the cited locations | ✅ confirmed, line numbers below |

Nothing was refuted. One reuse point (#5) needs an explicit addition, not just a straight
reuse, and is worth stating plainly so step 2's plan doesn't assume it's a drop-in call.

---

## 1–2. Data model (`packages/shared/src/mergeRequest.ts`, `apps/client/src/main/store.ts`)

`MergeRequest.openedForTaskId` (`mergeRequest.ts:87`) is exactly as described: "the card this
app **opened** this merge request for, remembered rather than re-derived." Its own doc comment
already anticipates a manual-link feature — it says the field is "the one thing about *which
card* the syncs may not touch, alongside the read markers and the local rename: nothing
upstream can change it, because nothing upstream knows it."

`store.ts`'s upsert statement (`store.ts:2318-2357`) confirms the asymmetry the plan called
out: `taskId = excluded.taskId` is a plain overwrite (a sync is allowed to rebuild its guess),
but `openedForTaskId = COALESCE(excluded.openedForTaskId, merge_requests.openedForTaskId)`
(`store.ts:2341`) never lets a `NULL` win over a value already on the row. A "link" write only
needs to set `openedForTaskId` on the row it upserts; it does not need to protect against a
later sync clearing it — that's already handled.

## 3–4. Detail fetch (`gitlab/describeMergeRequest.ts`, `github/describePullRequest.ts`)

Both signatures match the plan exactly:

- `describeMergeRequest(client, listed: GitLabMergeRequest, { stale, prior })` (`describeMergeRequest.ts:45-49`).
- `describePullRequest(client, listed: GitHubSearchIssueItem, { stale, prior, detail, onCiRefusal })` (`describePullRequest.ts:288-292`).

`listedFromDetail(detail, owner, repo)` (`describePullRequest.ts:70-89`) exists precisely to
avoid writing the field mapping a second time: it "dresses" a `GitHubPullRequest` detail
response as the `GitHubSearchIssueItem` shape `describePullRequest` expects as `listed`. Its
own doc comment says it's for "the one call that does not start at the search endpoint" — a PR
"re-read **by number**" — which is exactly the shape a manual-link-by-URL flow needs.

Useful detail beyond the plan's summary: `DescribePullRequestOptions.detail` (`describePullRequest.ts:106`)
lets a caller hand in an already-fetched `GitHubPullRequest` so CI/approvals aren't re-read off
a second detail call. The existing "read back a settled PR" pass in `ipc.ts:2299` is the
worked example: `describePullRequest(client, listedFromDetail(detail, owner, repo), { stale: true, detail })`.
GitLab's `describeMergeRequest` has no equivalent parameter — it always re-fetches internally
via `client.getMergeRequest` when `stale: true` (`describeMergeRequest.ts:66`) — so the GitLab
side of a link flow makes one fetch inside `describeMergeRequest` itself, not two.

## 5. Row building (`gitlab/gitlabSync.ts#reconcileMergeRequests`, `github/githubPrSync.ts#reconcilePullRequests`)

Confirmed reusable with a single-item `fetched` array (`gitlabSync.ts:141-145`:
`reconcileMergeRequests(existing, fetched, opts)`, where both `existing` and `fetched` are
plain arrays — nothing requires them to be the full board's lists).

**Caveat found while checking, not in the original plan:** `reconcileMergeRequests`'s own
`openedForTaskId` handling (`gitlabSync.ts:163`) is `prior?.openedForTaskId ?? null` — it
*preserves* a prior row's value, it does not *set* one for a brand-new row. For a link
flow's first write, `prior` is `undefined` (nothing is stored yet), so feeding the reconciler
alone would produce `openedForTaskId: null` — the exact bug `openedForTaskId` exists to
prevent. `forge/createPr.ts#rowFor` (`createPr.ts:453-488`) already solves this for the
Create-PR path by building the stored row directly rather than through the reconciler and
setting `openedForTaskId: taskId` explicitly (`createPr.ts:460`). A manual-link flow needs the
same explicit override — either build the row directly the way `rowFor` does, or call the
reconciler and then patch `openedForTaskId` onto its result before upserting. Either way, this
is not a verbatim call to the reconciler; step 2's plan should say so rather than assume it.

## 6–7. Client fetch methods (`github/githubClient.ts`, `gitlab/gitlabClient.ts`)

`GitHubClient.getPullRequest(owner: string, repo: string, number: number)` (`githubClient.ts:638`)
takes exactly the two strings a `github.com/{owner}/{repo}/pull/{number}` URL gives up on
parsing, with no lookup needed first.

`GitLabClient.getMergeRequest(projectId: number, iid: number)` (`gitlabClient.ts:268-270`) is
`request(`/projects/${projectId}/merge_requests/${iid}`)` — no `encodeURIComponent`, and
`projectId` is asserted numeric by the template, so a `group/subgroup/project` path literally
cannot be handed to it (it would need `/` characters encoded to be usable as a path segment,
which this call never does). `createMergeRequest` (`gitlabClient.ts:314-339`) already takes the
project by **path**, URL-encoded (`encodeURIComponent(projectPath)`, `gitlabClient.ts:318`),
confirming GitLab's API accepts a URL-encoded path everywhere a numeric id is accepted. A
link-by-URL flow (which has a `group/proj` path and an `iid`, not a numeric project id) needs a
small addition alongside `getMergeRequest` — same endpoint shape, path-encoded instead of
numeric — there is no existing method that already does this.

## 8–9. IPC wiring

The template channel, followed end to end:

- Contract: `packages/shared/src/ipc.ts:482-484` —
  `'task:createPullRequest': (taskId: string) => Promise<{ url: string; ref: string; existed: boolean }>`.
- Relay classification: `packages/shared/src/ipcRelay.ts:195` — `'task:createPullRequest': 'relay'`.
- Handler: `apps/client/src/main/ipc.ts:1797` —
  `handle('task:createPullRequest', async (taskId) => openPullRequest(createPrDeps(), taskId))`,
  built from `createPrDeps()` (`ipc.ts:1775-1795`), whose `upsertMergeRequest` wrapper both
  calls `store.upsertMergeRequest` and immediately `send('mergeRequests:changed', ...)`
  (`ipc.ts:1780-1786`) — the reason a card shows a newly-created PR before the next poll, and
  the same push a link flow would want.
- Preload (`apps/client/src/preload/index.ts:28-45`): `invoke` is generic over `keyof IpcApi`
  with no per-channel branch — a new channel needs no preload change, only the contract entry
  and the relay classification.

## 10. UI (`packages/ui/src/TaskAgentPanel.tsx`)

Line numbers on this branch's current tip:

- `createPullRequest()` — `TaskAgentPanel.tsx:620-628` (`await transport.invoke('task:createPullRequest', taskId)`, wrapped in the same `setBusy`/`setError` pattern as every other action in the file).
- `isStep` — `TaskAgentPanel.tsx:285` (`Boolean(task.parentTaskId)`).
- `canIntegrate` — `TaskAgentPanel.tsx:352` (multi-line condition; not reproduced here, but confirmed present at this line).
- The Create-PR button block — `TaskAgentPanel.tsx:878-905`: gated on
  `canIntegrate && !isStep && !live && !openMr` (`:878`), `onClick={() => void createPullRequest()}` (`:889`).
- The already-open-MR branch sits right beside it: `canIntegrate && !isStep && openMr` (`:894`) — the existing UI already distinguishes "no MR yet" from "one is open," which is the same distinction a manually-linked MR needs to fold into (`openMr` is read from `listMergeRequests()` filtered to the task, per `:201`'s comment about holding "a LINK to an open one instead of a second [create]").

This component is shared verbatim by desktop (`apps/client/.../MyTasks.tsx`) and web
(`apps/web/.../BoardScreen.tsx`) — confirmed by it being the one file all four bullets above
live in; no fork was found for either host.

---

## Net

Nine of ten claims are drop-in reuse, verified against the code rather than assumed. The
tenth — row-building via `reconcileMergeRequests`/`reconcilePullRequests` — is reusable for
everything except `openedForTaskId`, which a link flow must set explicitly the same way
`forge/createPr.ts#rowFor` already does, or the linked row will read as unlinked the moment
anything upstream can't re-derive the key (exactly the failure `openedForTaskId` was invented
to prevent, and exactly the class of bug the field's own doc comment warns about). No file
changes were made in this step — it is exploration only, verified against the current code.
