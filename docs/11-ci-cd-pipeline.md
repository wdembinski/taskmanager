# 11. The CI/CD pipeline

Three workflows, in [`.github/workflows/`](../.github/workflows/). Together they mean a
merge into `development` is the whole release: the desktop app is tagged, packaged for
Windows and Linux, and published, while the cloud service is deployed in parallel.

| Workflow                                          | Trigger                                      | What it does                                                                                       |
| ------------------------------------------------- | -------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| [`ci.yml`](../.github/workflows/ci.yml)           | pull request → `development`                 | The gates, the server image, and (when the desktop app is touched) a full package                  |
| [`release.yml`](../.github/workflows/release.yml) | push → `development`, or `workflow_dispatch` | Tags, drafts, packages Windows + Linux, publishes — [`RELEASE.md`](../RELEASE.md) run by a machine |
| [`deploy.yml`](../.github/workflows/deploy.yml)   | push → `development`, or `workflow_dispatch` | Deploys `@tm/server` to Azure Container Apps and `@tm/web` to Static Web Apps                      |

There is no `main` in this repository; `development` is the integration branch, and it is
the only branch anything is released or deployed from.

`release.yml` and `deploy.yml` share a trigger but nothing else, and each ignores the
other's half of the repo: `deploy.yml` never touches `apps/client`, and `release.yml` never
touches Azure. A push that changes only the desktop app deploys nothing; a push that changes
only the server still cuts a release, because the version of record is the desktop app's and
the tag names the whole repository's state.

What was checked before any of this ran for real — the gates, the version resolver against
the repo's actual tags, and the invariant tests put through their own mutations — is recorded
in [`docs/plan/ci-cd-gate-report.md`](plan/ci-cd-gate-report.md), along with the two things
that could not be proven until the pipeline was on `development`.

---

## What triggers what

**On a pull request into `development`** — `ci.yml`:

| Job       | Runner  | When                                                                  |
| --------- | ------- | --------------------------------------------------------------------- |
| `gates`   | ubuntu  | always — `format:check`, `typecheck`, `test`, `build`                 |
| `docker`  | ubuntu  | always — builds `apps/server/Dockerfile`, pushes nothing              |
| `package` | windows | only when `apps/client/**`, `packages/**` or `pnpm-lock.yaml` changed |

`package` is the expensive one and the reason the path filter exists. It builds the real
installer with `package:local` (`--publish never`) and runs the packaged-addon smoke test.
It is here because a merge into `development` now _tags_: an ABI break is invisible to
typecheck and test, surfaces only when the packaged addon is loaded, and has shipped before
(v0.25.0 booted to a permanent "Loading…"). Catching it on the PR beats catching it after
the tag exists.

**On a push to `development`** — `release.yml` and `deploy.yml`, in parallel.

`release.yml`'s jobs are [`RELEASE.md`](../RELEASE.md)'s sections:

| Job       | Runner  | RELEASE.md                                                            |
| --------- | ------- | --------------------------------------------------------------------- |
| `gates`   | ubuntu  | §1 — nothing is tagged from a red tree                                |
| `version` | ubuntu  | §0 idempotence, §2 the version, §3 the tag, §4 the **draft**          |
| `windows` | windows | §5 — package into the draft, then the headless addon smoke test       |
| `linux`   | ubuntu  | §6 — package into the draft, plus docs/07's ELF and ABI-symbol checks |
| `promote` | ubuntu  | §7 — publish the draft, **even if `linux` failed** (rule 4)           |

`deploy.yml` filters by path, and can run either half, both, or neither:

| Changed                                                             | Deployed                                         |
| ------------------------------------------------------------------- | ------------------------------------------------ |
| `apps/server`, `packages/shared`, `packages/protocol`, the lockfile | image → GHCR → **migration job** → Container App |
| `apps/web`, `packages/ui`, and the same shared packages             | Vite build → Static Web Apps                     |
| `apps/client` only                                                  | nothing                                          |

Both are `concurrency: cancel-in-progress: false` — a half-finished release or deploy costs
far more than a queue. `ci.yml` is the opposite: a new push to a PR cancels the run still in
flight for the old commit.

---

## The two loop hazards in `release.yml`

The `version` job pushes a commit to the branch the workflow triggers on. That is a release
that starts a release. Two independent things stop it, and both are deliberate:

1. **Pushes authenticated with `GITHUB_TOKEN` do not trigger workflows.** GitHub's own loop
   guard, and the one doing the work today.
2. **`gates` skips itself when the head commit is a `chore(release):`** — and so the whole
   workflow skips, since everything `needs:` it. This covers the day someone swaps in a PAT
   to get the push signed or to trigger something downstream, at which point guard 1
   evaporates silently.

The bump commit also touches only `apps/client/package.json`, which matches no filter in
`deploy.yml` — so even if it did trigger, it would deploy nothing.

If you ever replace `GITHUB_TOKEN` with a PAT for the push, **keep guard 2**. It is the only
one left at that point.

---

## Secrets

Repository → Settings → Secrets and variables → Actions. The complete list:

| Secret                            | Used by                     | What it is                                                                                                                                                                                                                                     |
| --------------------------------- | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GITHUB_TOKEN`                    | `release.yml`, `deploy.yml` | **Not created by anyone** — GitHub issues it per run. `release.yml` pushes the bump and tag with it, creates and edits the release, and hands it to electron-builder as `GH_TOKEN` for the asset upload; `deploy.yml` logs in to GHCR with it. |
| `AZURE_CLIENT_ID`                 | `deploy.yml`                | App registration (or user-assigned managed identity) client id                                                                                                                                                                                 |
| `AZURE_TENANT_ID`                 | `deploy.yml`                | Entra tenant id                                                                                                                                                                                                                                |
| `AZURE_SUBSCRIPTION_ID`           | `deploy.yml`                | The subscription holding the `taskmanager` resource group                                                                                                                                                                                      |
| `AZURE_STATIC_WEB_APPS_API_TOKEN` | `deploy.yml`                | `az staticwebapp secrets list -n taskmanager-web -g taskmanager --query properties.apiKey -o tsv`                                                                                                                                              |
| `VITE_CLOUD_IAM_CLIENT_ID`        | `deploy.yml`                | The web build's public vipper.iam client id — compiled into the bundle by Vite                                                                                                                                                                 |

`ci.yml` needs **no** secrets at all. It publishes nothing, so it needs nothing to publish
with — which is also what makes it safe to run against a fork's pull request.

`VITE_CLOUD_IAM_CLIENT_ID` is a secret only by storage, not by nature: a browser bundle has
nowhere to hide anything, and PKCE is what secures the sign-in (see `apps/web/.env.example`).

**Azure login uses OIDC — there is no stored Azure credential.** Create a federated
credential on the app registration and give its service principal a role on the
`taskmanager` resource group:

```text
subject:  repo:wdembinski/taskmanager:ref:refs/heads/development
issuer:   https://token.actions.githubusercontent.com
audience: api://AzureADTokenExchange
role:     Contributor (or the narrower "Container Apps Contributor") on RG taskmanager
```

The subject string pins the branch. A deploy dispatched from any other ref gets a token
Azure will not exchange, and `azure/login` fails with a message that does not say why —
see the cloud sign-in notes in [`docs/09`](09-deploying-the-cloud-service.md).

---

## One-time repository settings

Neither of these lives in a file, so neither shows up in a diff — and each fails in a way
that looks like a bug in the workflow.

**1. Settings → Actions → General → Workflow permissions → _Read and write permissions_.**

`release.yml` declares `permissions: contents: write`, but a workflow's `permissions:` block
can only ever _narrow_ what the repository allows. With the repo default left at read-only,
that declaration grants nothing: the `version` job's `git push` and its `gh release create`
both fail with a 403 that reads like a bad credential rather than a repository setting.

**2. `development`'s branch protection must let `github-actions[bot]` push.**

The `version` job pushes the bump commit and the tag directly to `development`. Any
protection rule that stops a direct push stops the release:

- _Require a pull request before merging_ — add `github-actions[bot]` to the bypass list.
- _Require status checks to pass_ — the bump commit has no PR and therefore no checks, so
  it must be bypassable too.
- _Require linear history_ is fine: the bump is a single commit on top of the branch head.
- Tag protection rules, if any, must admit `v*` from the bot.

If a release run dies at _Tag and push_ with `protected branch hook declined`, this is why.

**3. Actions must be enabled**, and the workflows allowed to run — a fresh fork or a
repository transfer disables them. Nothing else is needed for the desktop half; the cloud
half's one-time work (Key Vault, database users, the vipper.iam clients, the Terraform
stand-up) lives in [`docs/10-cloud-deployment-runbook.md`](10-cloud-deployment-runbook.md)
and the infrastructure repo, and none of it is repeated here.

---

## Re-running a release that failed halfway

Which re-run to use depends on **whether the tag was pushed**, because that decides what
`scripts/next-version.mjs` computes the second time.

**The failure was in `windows`, `linux` or `promote`** — the tag exists and the draft exists.
Use **Re-run failed jobs** on the same run (Actions → the run → _Re-run failed jobs_). The
successful `version` job is not re-run and its outputs — `version`, `tag`, `release` — are
preserved, so the retried jobs package the same tag into the same draft. This is almost
always the one you want.

> Do **not** reach for `workflow_dispatch` here. A fresh run recomputes the version from
> scratch, and by then the manifest is no longer ahead of the highest tag — so
> `next-version.mjs` applies §2's fallback, patch-bumps to the _next_ version, and starts a
> second release, leaving the first draft orphaned with its half-uploaded assets. If that
> has already happened: delete the orphaned draft (`gh release delete vX.Y.Z --yes`) and let
> the newer version be the release. Leave the old **tag** alone — a pushed tag is never
> moved or deleted here (CONTRIBUTING.md §4), and an extra tag with no release is harmless.

**The failure was in `gates` or `version`, before the tag was pushed** — nothing was created,
so either re-run works. Actions → **Release** → _Run workflow_ → branch **`development`**.
A dispatch aimed at any other branch fails at the `version` job's first step, by rule 5.

**A dispatch is also how you release a commit that is already on `development`** — after
fixing a repository setting, say. It is safe to run at any time: if the version's release is
already **published**, the `version` job reports "nothing to release" as a `::notice`, every
later job skips, and the run is green. If a **draft** exists for the computed tag, the run
resumes into it rather than creating a second one.

> On a `workflow_dispatch` there is no `github.event.head_commit`, so the `chore(release):`
> skip guard evaluates against an empty string and lets the run through. That is intended: a
> deliberate re-run should not be skipped by a guard meant for automatic pushes.

`deploy.yml` has the same dispatch trigger for the same reason. It compares against the
previous commit, so a dispatch may deploy nothing if nothing changed in the filtered paths.

---

## Rolling the cloud back

The deploy verifies itself and fails **without** rolling anything back. That is deliberate:
traffic moves to a new revision only once it reports healthy, so a container that never
starts normally leaves the previous one serving. Check before you act.

```bash
az containerapp revision list -n taskmanager-api -g taskmanager -o table
az containerapp update -n taskmanager-api -g taskmanager \
  --image ghcr.io/wdembinski/taskmanager-server:<previous-sha>
```

Every image is tagged with its commit SHA and Terraform ignores the running image, so this
is a one-liner and Terraform will not fight it back.

**Migrations do not roll back with it.** They are applied before the app is repointed, so
the older image meets the newer schema — fine for additive migrations, which is exactly the
reason to keep them additive ([`docs/10`](10-cloud-deployment-runbook.md), "Rollback and
teardown").

The web half has no rollback command: re-deploy the previous commit with a dispatch, or push
a revert.

There is no equivalent for the desktop app. A bad release is not un-published — the answer
is to ship the fix as the next version, because a user who already installed the bad one is
only reachable through the update feed.

---

## The app's _Release after merge_ switch

This repository's projects and cards should have **_Release after merge_ off**.

The switch tells the orchestrator to start an agent session when a card's branch merges, and
that agent reads [`RELEASE.md`](../RELEASE.md) and follows it (see
`packages/shared/src/release.ts`). With `release.yml` in place, the merge already starts a
release — so leaving the switch on means two releasers following the same file over the same
tag. The agent would either race the workflow to push it, or arrive to find the version
published and stop. Only the second is harmless, and nothing decides which you get.

**No code changed for this.** `RELEASE_DOC` still points at `RELEASE.md`, and that is still
correct: the file is still this project's release procedure, and it is still what an agent
should follow when a release has to be cut by hand. The feature is unchanged and remains
right for every _other_ repository the orchestrator drives — a project without a pipeline is
exactly what it was built for. Only this repo's switch should be off, and turning it off is
a click, not a commit.

---

## What still needs a human

The pipeline is not a replacement for two things, and does not pretend to be:

- **The release notes.** `release.yml` drafts with `--generate-notes`, which is the commit
  subjects. RELEASE.md §4 asks for them grouped by what a user would notice. Reword them on
  the release page when a version deserves it — the release is published by then, and
  editing its notes is safe.
- **A clean-machine install.** Nothing here runs the installer on a machine that has never
  had the app, opens it, and takes one project end to end. The packaged smoke test proves
  the native addon loads, which is where every shipped failure has come from; it says
  nothing about whether the window renders. That check was always owed to a person, on a
  different machine, and it still is.
