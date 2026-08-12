# The CI/CD pipeline — what a human still has to do

Step 9 of _Create CI/CD pipeline_, and the last one. Steps 1–6 wrote the pipeline, step 7
[verified it](ci-cd-gate-report.md), step 8 mapped its files. This file is about the part
that is not in any of those diffs, because it is not in any file: **repository settings and
one switch in the app**.

Each item below was _checked_, not assumed — the state as of **12 August 2026**, on
`6cdd803`, is recorded with the command that read it. Three were already right, one was
fixed on the spot, and **one thing remains: a single switch in the app.**

[`docs/11`'s _One-time repository settings_](../11-ci-cd-pipeline.md#one-time-repository-settings)
explains what these settings are and why the workflows need them; this file is the checklist
of what is actually set right now.

---

## Summary

| #   | What                                            | State found                            | Now                    |
| --- | ----------------------------------------------- | -------------------------------------- | ---------------------- |
| 1   | Actions → Workflow permissions **read + write** | ❌ `read`                              | ✅ **set** — see below |
| 2   | `github-actions[bot]` may push to `development` | ✅ nothing blocks it                   | nothing — no-op        |
| 3   | The five repository secrets                     | ✅ all five present                    | nothing                |
| 4   | Actions enabled at all                          | ✅ enabled, all actions allowed        | nothing                |
| 5   | The app's _Release after merge_ switch          | ❌ **on** for the Task Manager project | **still to do**        |

1 and 5 were the two that mattered, and neither is optional in the sense of "the pipeline is
worse without it" — without 1 the release cannot run at all, and without 5 two releasers race
the same tag. **1 is done. 5 needs a click in the app**, and is the last thing standing
between this branch and a pipeline that runs itself.

---

## 1. Workflow permissions — **done, 12 August 2026**

The equivalent of **Settings → Actions → General → Workflow permissions → _Read and write
permissions_**. The repository was found read-only, which would have failed the pipeline's
first run:

```
$ gh api repos/wdembinski/taskmanager/actions/permissions/workflow
{"default_workflow_permissions":"read","can_approve_pull_request_reviews":false}
```

`release.yml` declares `permissions: contents: write`, but a workflow's `permissions:` block
can only ever _narrow_ what the repository allows — it can never raise it. Left as it was,
that declaration granted nothing, and the `version` job would have failed at its `git push`
with a 403 that reads like a bad credential rather than a repository setting.

Set with the API rather than the settings page, on the human's go-ahead, and read back:

```
$ gh api -X PUT repos/wdembinski/taskmanager/actions/permissions/workflow \
    -f default_workflow_permissions=write -F can_approve_pull_request_reviews=false
$ gh api repos/wdembinski/taskmanager/actions/permissions/workflow
{"default_workflow_permissions":"write","can_approve_pull_request_reviews":false}
```

**`can_approve_pull_request_reviews` was sent explicitly as `false`, and stayed `false`.** It
is _Allow GitHub Actions to create and approve pull requests_ on that settings page, sits
directly under the radio button being changed, and is the genuinely dangerous half of it — a
workflow that can approve pull requests can approve its own. Nothing here opens one. It is
passed explicitly rather than omitted so that a re-run of the command cannot quietly turn it
on.

Widening the default did not widen the three workflows: each declares its own `permissions:`
block and so keeps narrowing itself to what it needs (`ci.yml` stays read-only, `deploy.yml`
takes `packages: write` + `id-token: write`, `release.yml` takes `contents: write`). What
changed is the default a _future_ workflow would inherit if it forgot to declare one — which
is the argument for every new workflow in this repo declaring one, as all three do.

---

## 2. Branch protection — **nothing to do**

The plan listed this conditionally ("if it is protected"), and it is not:

```
$ gh api repos/wdembinski/taskmanager/branches/development/protection
Branch not protected (HTTP 404)

$ gh api repos/wdembinski/taskmanager/rulesets
[]

$ gh api repos/wdembinski/taskmanager/tags/protection
Not Found (HTTP 404)
```

No protection rule, no ruleset, no tag protection rule. The `version` job's direct push of
the bump commit and the `v*` tag to `development` has nothing standing in front of it, so
there is no bypass list to add the bot to.

This stays worth knowing rather than being deleted, because **it is a setting that can be
added later by someone solving an unrelated problem.** If protection is ever turned on,
`release.yml` breaks at _Tag and push_ with `protected branch hook declined`, and
[`docs/11`](../11-ci-cd-pipeline.md#one-time-repository-settings) lists which rules need a
bypass for `github-actions[bot]` and which are harmless.

---

## 3. Secrets — **nothing to do**

The plan said no new secrets are needed. Checked against what the workflows actually
reference — every `secrets.*` in all three files, minus `GITHUB_TOKEN`, which GitHub issues
per run and nobody creates:

```
$ gh secret list --repo wdembinski/taskmanager
AZURE_CLIENT_ID                    2026-08-11T07:16:42Z
AZURE_STATIC_WEB_APPS_API_TOKEN    2026-08-11T07:16:45Z
AZURE_SUBSCRIPTION_ID              2026-08-11T07:16:44Z
AZURE_TENANT_ID                    2026-08-11T07:16:43Z
VITE_CLOUD_IAM_CLIENT_ID           2026-08-11T07:16:44Z
```

Five referenced, five present, none missing and none spare. All five predate this branch —
they were configured for the cloud deploy in v0.79.0, and `release.yml` added no secret of
its own because `GITHUB_TOKEN` covers the tag push, the release, the asset upload and GHCR.

There are **no environment-scoped secrets** (`gh api …/environments` returns none), so these
repository-level ones are what every job sees. Nothing to do here — but if `deploy.yml` ever
fails at `azure/login` with these all present, the cause is the federated credential on the
app registration rather than a secret, and that is
[`docs/11`'s _Secrets_ section](../11-ci-cd-pipeline.md#secrets).

---

## 4. Actions are enabled — **nothing to do**

```
$ gh api repos/wdembinski/taskmanager/actions/permissions
{"enabled":true,"allowed_actions":"all","sha_pinning_required":false}
```

Enabled, and every action allowed — which matters because the workflows use third-party
actions (`pnpm/action-setup`, `dorny/paths-filter`, `azure/login`, the Static Web Apps
action) that an `allowed_actions` of `local_only` would refuse.

---

## 5. The app's _Release after merge_ switch — **required**

**Settings → the _Task Manager_ project → turn _Release after merge by default_ off.**

It is currently on. Read from a snapshot of the live database (copied first, never opened in
place, while the app was running):

```
$ node -e "…SELECT id, name, autoRelease FROM projects…"
{"id":"a87aa50a-cc8b-490b-b166-efb548c2d588","name":"Task Manager","path":"C:\\Repositories\\task-manager","autoRelease":1}
```

Every other project reads `autoRelease: 0`, so this is genuinely specific to this repo — the
feature stays right for every project the orchestrator drives that has no pipeline, which is
what it was built for.

**One click is enough, and this was worth checking rather than assuming.** A card carries a
nullable _override_ of the project's preference, and an override of `true` wins even after
the project's own switch goes off (`autoReleaseOn` in `packages/shared/src/release.ts`). If
any card held one, turning off the project switch would leave that card still releasing. None
does:

```
$ …SELECT COUNT(*) FROM tasks WHERE autoRelease IS NOT NULL…
count=0
```

Not one card in the database has ever overridden the project preference either way, so the
project switch is the only thing deciding this, and turning it off turns it off everywhere.

**Why it has to go off:** the switch starts an agent session when a card's branch merges, and
that agent reads [`RELEASE.md`](../../RELEASE.md) and follows it. With `release.yml` in place
the merge _already_ starts a release, so leaving the switch on means two releasers following
the same file toward the same tag. One of them arrives to find the version published and
stops, which is harmless; the other races the workflow to push the tag, which is not. Nothing
decides which you get.

No code changed for this, and none should — see
[`docs/11`'s section on the switch](../11-ci-cd-pipeline.md#the-apps-release-after-merge-switch).

---

## The order

What is left should happen **before this branch merges into `development`**, because the
merge is the first real run of everything:

1. **Turn the app switch off (5).** If it is still on when the branch merges, the orchestrator
   starts a release agent for this very card — the one racing case above, on the pipeline's
   first run, before anyone has seen it work. This is now the only thing on this list that a
   person has to do, and the only one still able to spoil the first run.
2. ~~Set workflow permissions (1).~~ Done, above. Had it been left, `release.yml` would have
   run and died in the `version` job — recoverable by fixing the setting and then Actions →
   **Release** → _Run workflow_ → branch `development`, which is a plain re-run because
   nothing is created before that failure.
3. **Then merge.** The merge itself is the first genuine run of `release.yml` and `deploy.yml`;
   the gate report's [§4](ci-cd-gate-report.md#4-what-this-step-did-not-prove-and-why) explains
   why that could not be rehearsed and why it is recoverable rather than reckless.

If the order slips, nothing is lost that a re-run cannot recover — the release is idempotent,
a leftover draft is resumed rather than duplicated, and a published version makes the run a
green no-op.

---

## Still owed to a person, and not by this step

Unchanged by anything here, and listed so this file is not mistaken for the last word:

- **A clean-machine install** — the installer run on a machine that has never had the app,
  opened, and taken one project end to end. The packaged smoke test proves the native addon
  loads; it says nothing about whether the window renders.
- **The release notes**, when a version deserves better than generated commit subjects.

Both are in [`docs/11`'s _What still needs a human_](../11-ci-cd-pipeline.md#what-still-needs-a-human).
