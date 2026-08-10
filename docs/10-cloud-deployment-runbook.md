# Cloud deployment runbook

From an empty subscription to `@tm/server` and `@tm/web` serving real traffic. Nine phases,
**run in order** — three of them fail if you skip ahead.

[`09-deploying-the-cloud-service.md`](09-deploying-the-cloud-service.md) explains how the
pieces work and why each is shaped the way it is. `infrastructure/taskmanager/README.md` is
the module reference. This file is the order to do them in.

First run takes 60–90 minutes, most of it waiting on DNS and certificates. Running cost is
roughly **$25–30/month**.

**There is an executable version of this file**: [`scripts/Deploy-Cloud.ps1`](../scripts/Deploy-Cloud.ps1).
Every phase below is a phase of that script, each one idempotent and separately runnable.
Start with a dry run, which changes nothing but still reports the real current state:

```powershell
.\scripts\Deploy-Cloud.ps1 -DryRun     # walk the whole sequence
.\scripts\Deploy-Cloud.ps1             # do it
.\scripts\Deploy-Cloud.ps1 -From 3     # resume after the secrets are seeded
.\scripts\Deploy-Cloud.ps1 -Phase 8    # just re-run the verification
```

Read this file for *why* each step is where it is; run the script to actually do it.

---

## 0. Before you start

- **Tools:** `terraform`, `az`, `gh`, and `sqlcmd` (or the Azure Portal query editor).
- **Azure:** rights in subscription `cb8f3ead-774b-440f-8b7e-8f0bfee1d632`, and ownership of
  the `vipper.network` zone in resource group `vipper-network-dns`.
- **GHCR:** a PAT with `read:packages` — the Container App pulls a private image with it.
- **vipper.iam:** console access, to register three clients that do not exist yet.

**Decide the hostnames now.** The defaults are `tasks-api.vipper.network` and
`tasks.vipper.network`, and they appear in *two* places: the Terraform variables, and
hardcoded in `.github/workflows/deploy.yml` as `VITE_CLOUD_API_BASE`. Change one and you
must change the other.

```bash
az login
az account set --subscription cb8f3ead-774b-440f-8b7e-8f0bfee1d632
gh auth status

cd /c/Repositories/infrastructure/taskmanager
cp terraform.tfvars.example terraform.tfvars   # ghcr_username, ghcr_pull_token, sql_admin_password
terraform init
```

`sql_admin_password` enters Terraform state, because `@tm/server` authenticates to SQL with
a password rather than a managed identity. The state is in a private RBAC-controlled storage
account. Moving to Entra auth removes the variable and is the right follow-up.

## 1. Create the vault first, on its own

A single `terraform apply` **cannot succeed from scratch**. `migrate-job.tf` declares a Key
Vault *reference* to a secret named `db-migrate-password`, which Azure resolves when the job
is created — but the same apply is what creates the vault, so on a clean subscription that
secret cannot exist yet.

```bash
terraform apply \
  -target=azurerm_key_vault.taskmanager \
  -target=azurerm_role_assignment.kv_secrets_officer
```

This pulls in the resource group and grants *you* Key Vault Secrets Officer, which is what
lets the next phase write. Role assignments take a minute to propagate — if phase 2 returns
`Forbidden`, wait and retry rather than granting something broader.

## 2. Seed the three secrets

The names are fixed by `apps/server/src/config/secrets.ts`. Key Vault names cannot contain
underscores, hence the dashes.

| Secret | Becomes | Read by |
| --- | --- | --- |
| `db-password` | `DB_PASSWORD` | the API, via `AZURE_KEY_VAULT_URI` |
| `db-migrate-password` | `DB_PASSWORD` | the migrate job, via a native Container Apps reference |
| `cloud-iam-client-secret` | `CLOUD_IAM_CLIENT_SECRET` | the API, via `AZURE_KEY_VAULT_URI` |

**Why two database passwords.** `secrets.ts` maps the single secret `db-password` onto
`DB_PASSWORD`. If the migrate job used that path it would read the *app* user's password and
the two identities would collapse into one — so it gets a different vault secret injected
straight into the env var instead. That is what keeps "the serving app cannot change the
schema" true.

Generate two strong passwords:

```powershell
-join ((48..57)+(65..90)+(97..122) | Get-Random -Count 28 | % {[char]$_})
```

```bash
az keyvault secret set --vault-name taskmanager-kv --name db-password             --value '<tmapp password>'
az keyvault secret set --vault-name taskmanager-kv --name db-migrate-password     --value '<tmmigrate password>'
az keyvault secret set --vault-name taskmanager-kv --name cloud-iam-client-secret --value '<placeholder for now>'
```

The IAM client secret does not exist until phase 5. Seed a placeholder so the apply
succeeds, then overwrite it and restart the app — the API only reads it at startup.

## 3. Apply everything else

```bash
terraform plan
terraform apply
terraform output   # sql_server_fqdn, key_vault_uri, api_default_fqdn, web_default_host_name, web_api_key_command
```

The Container App comes up on a placeholder image deliberately: Terraform never manages the
running image, CI sets it, and `ignore_changes` stops a later apply rolling a deploy back.

`null_resource.api_hostname_bind` may fail on the first run if DNS has not propagated. That
*taints* the resource, so simply run `terraform apply` again — this is expected.

## 4. Create the two SQL users

Terraform creates the server and database but deliberately not the users, because that would
put their passwords in state.

**Your machine cannot reach SQL yet.** The only firewall rule is `AllowAzureServices`, which
admits Azure services and not your laptop. Open it briefly, and close it afterwards:

```bash
MYIP=$(curl -s https://api.ipify.org)
az sql server firewall-rule create -g taskmanager -s taskmanager-sql \
  -n operator-temp --start-ip-address $MYIP --end-ip-address $MYIP
```

Connect to the `taskmanager` database — not `master` — as the Entra admin:

```sql
-- the serving app: read and write rows, never change the schema
CREATE USER tmapp WITH PASSWORD = '<db-password>';
ALTER ROLE db_datareader ADD MEMBER tmapp;
ALTER ROLE db_datawriter ADD MEMBER tmapp;

-- the migrate job: schema changes, only during a deploy
CREATE USER tmmigrate WITH PASSWORD = '<db-migrate-password>';
ALTER ROLE db_ddladmin   ADD MEMBER tmmigrate;
ALTER ROLE db_datareader ADD MEMBER tmmigrate;
ALTER ROLE db_datawriter ADD MEMBER tmmigrate;
```

`tmmigrate` needs data rights as well as DDL, because the initial migration inserts a seed
row and not only tables.

```bash
az sql server firewall-rule delete -g taskmanager -s taskmanager-sql -n operator-temp
```

## 5. Register the three vipper.iam clients

None of these exist. Until they do, nothing can sign in — web or desktop.

| Client id | Type | Used by | Redirect |
| --- | --- | --- | --- |
| `taskmanager-api` | confidential | the server's introspection + authorization | — |
| `taskmanager-web` | public, PKCE | the browser client | `https://tasks.vipper.network/callback` |
| `taskmanager-desktop` | public, PKCE | the Electron app | its loopback URI |

Both public clients use `authorization_code` + `refresh_token` with
`token_endpoint_auth_method: none`. PKCE is what secures them, so shipping their ids in a
bundle or a binary is fine. Write the confidential client's secret over the placeholder:

```bash
az keyvault secret set --vault-name taskmanager-kv \
  --name cloud-iam-client-secret --value '<the real secret>'

az containerapp revision restart -n taskmanager-api -g taskmanager \
  --revision $(az containerapp show -n taskmanager-api -g taskmanager \
      --query properties.latestRevisionName -o tsv)
```

## 6. Wire up CI

Azure login uses OIDC, so no Azure credential is stored in GitHub.

```bash
APP_ID=$(az ad app create --display-name taskmanager-deploy --query appId -o tsv)
az ad sp create --id $APP_ID

az ad app federated-credential create --id $APP_ID --parameters '{
  "name": "taskmanager-development",
  "issuer": "https://token.actions.githubusercontent.com",
  "subject": "repo:wdembinski/taskmanager:ref:refs/heads/development",
  "audiences": ["api://AzureADTokenExchange"]
}'

az role assignment create --assignee $APP_ID --role Contributor \
  --scope /subscriptions/cb8f3ead-774b-440f-8b7e-8f0bfee1d632/resourceGroups/taskmanager
```

The subject must name `development` — this repo has no `main`.

```bash
cd /c/Repositories/task-manager
gh secret set AZURE_CLIENT_ID       --body "$APP_ID"
gh secret set AZURE_TENANT_ID       --body "$(az account show --query tenantId -o tsv)"
gh secret set AZURE_SUBSCRIPTION_ID --body "cb8f3ead-774b-440f-8b7e-8f0bfee1d632"
gh secret set VITE_CLOUD_IAM_CLIENT_ID --body "taskmanager-web"
gh secret set AZURE_STATIC_WEB_APPS_API_TOKEN --body "$(az staticwebapp secrets list \
  -n taskmanager-web -g taskmanager --query properties.apiKey -o tsv)"
```

## 7. First deploy

```bash
gh workflow run Deploy --ref development
gh run watch
```

The server job builds the image, pushes it to GHCR, runs the migration job to completion,
and only then repoints the Container App. A failed migration fails the deploy and leaves the
old app serving the old — matching — schema.

A manual dispatch compares against the previous commit, so it may deploy nothing if nothing
changed. Push a real change if a job you wanted is skipped.

## 8. Verify

```bash
curl -fsS https://tasks-api.vipper.network/health                                  # {"status":"ok"}
curl -o /dev/null -w '%{http_code}\n' https://tasks-api.vipper.network/v1/board    # 401
```

Those two together say the right thing. **200 from `/health`** — the container runs and the
probe path is right. **401 from `/v1/board`** — the guard is active; a 200 would mean
`CLOUD_DEV_NO_AUTH` reached production. A **401 from `/health`** means the guard was applied
too broadly, and Container Apps will restart the replica forever.

```bash
az containerapp revision list -n taskmanager-api -g taskmanager -o table
az containerapp job execution list -n taskmanager-migrate -g taskmanager -o table
az containerapp logs show -n taskmanager-api -g taskmanager --tail 50
```

Then open `https://tasks.vipper.network` and sign in. A desktop client must sync at least
once before the web client can send commands — until then there is no Client to relay them
to, and it will say so.

## When it goes wrong

| Symptom | Cause and fix |
| --- | --- |
| Apply fails resolving `db-migrate-password` | Secret missing, or the job identity has no vault access yet. Confirm phase 2, then apply again. |
| `RequireCustomHostnameInEnvironment` / bind failure | DNS not propagated. Re-run `terraform apply`; the tainted resource retries. |
| Container never leaves *starting* | The probe cannot reach `/health`. Check ingress target port 3100 and `PORT`. |
| `Login failed for user 'tmmigrate'` | User missing, or password differs from `db-migrate-password`. Phase 4. |
| Migration job cannot reach the server | `AllowAzureServices` missing — the only reason a job connects where a runner cannot. |
| App logs `Missing IAM config` and exits | Vault read returned nothing: check `AZURE_KEY_VAULT_URI`, the Secrets User role, and the exact names. |
| CORS errors in the browser | `CLOUD_ALLOWED_ORIGINS` does not match exactly. A trailing slash never matches. |
| Board loads but never updates | More than one replica. Presence is in-memory; `max_replicas` must stay 1. |
| Deep links 404 | `staticwebapp.config.json` did not reach the uploaded folder. |

## Rollback and teardown

Every image is tagged with its commit SHA, and Terraform ignores the running image, so
rolling back is just pointing at the previous one:

```bash
az containerapp revision list -n taskmanager-api -g taskmanager -o table
az containerapp update -n taskmanager-api -g taskmanager \
  --image ghcr.io/wdembinski/taskmanager-server:<previous-sha>
```

**Migrations do not roll back with the image.** A deploy applies them before swapping the
app, so rolling back leaves the newer schema in place. Safe for additive migrations, not for
destructive ones — which is a reason to keep them additive.

```bash
terraform destroy
az keyvault purge --name taskmanager-kv   # soft-delete blocks reusing the name
```
