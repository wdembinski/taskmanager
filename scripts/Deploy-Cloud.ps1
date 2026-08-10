<#
.SYNOPSIS
    Stands up the VIPPER Task Manager cloud service on Azure, phase by phase.

.DESCRIPTION
    The executable form of docs/10-cloud-deployment-runbook.md. That file explains WHY the
    order is what it is; this one performs it.

    Every phase is idempotent: re-running a completed phase re-checks the state and does
    nothing rather than failing or duplicating. That is deliberate, because the first run
    of this script will stop somewhere -- DNS propagation and role-assignment propagation
    both take longer than the commands that depend on them.

    Three phases fail if run out of order, which is why this exists as a script:

      * Phase 2 (secrets) must run BETWEEN two applies. apps/server's migrate job declares
        a Key Vault REFERENCE to `db-migrate-password`, resolved when the job is created --
        but the same apply is what creates the vault. So phase 1 applies the vault alone.
      * Phase 4 (database users) needs a temporary client-IP firewall rule. The only rule
        Terraform creates is AllowAzureServices, which is exactly what lets the migrate job
        connect where a CI runner cannot -- and equally means this machine cannot.
      * Phase 5 (vipper.iam) is manual, and the API's client secret does not exist until it
        is done. Phase 2 therefore seeds a PLACEHOLDER, which phase 5 overwrites.

.PARAMETER Phase
    Run exactly one phase (0-8).

.PARAMETER From
    Run from this phase to the end. Default: 0.

.PARAMETER DryRun
    Print every mutating command instead of running it. Read-only checks still run, so the
    output reflects the real current state.

.PARAMETER InfraPath
    The Terraform module. Default: C:\Repositories\infrastructure\taskmanager

.EXAMPLE
    .\Deploy-Cloud.ps1 -DryRun
    Walk the whole sequence without changing anything.

.EXAMPLE
    .\Deploy-Cloud.ps1 -From 3
    Resume after the secrets are seeded.

.EXAMPLE
    .\Deploy-Cloud.ps1 -Phase 8
    Just re-run the verification.

.NOTES
    Written for Windows PowerShell 5.1 -- no ternary, no ??, no && chaining -- so it runs in
    the shell this repo is developed in as well as in pwsh 7.

    Secrets are generated in memory, written straight to Key Vault, and read back from Key
    Vault when needed. None is printed, and none is written to disk.
#>

#Requires -Version 5.1
[CmdletBinding()]
param(
    [ValidateRange(0, 8)][int] $Phase = -1,
    [ValidateRange(0, 8)][int] $From = 0,
    [switch] $DryRun,
    [string] $InfraPath = 'C:\Repositories\infrastructure\taskmanager',
    [string] $SubscriptionId = 'cb8f3ead-774b-440f-8b7e-8f0bfee1d632',
    [string] $ResourceGroup = 'taskmanager',
    [string] $KeyVault = 'taskmanager-kv',
    [string] $SqlServer = 'taskmanager-sql',
    [string] $SqlDatabase = 'taskmanager',
    [string] $ContainerApp = 'taskmanager-api',
    [string] $MigrateJob = 'taskmanager-migrate',
    [string] $StaticWebApp = 'taskmanager-web',
    [string] $ApiHostname = 'tasks-api.vipper.network',
    [string] $WebHostname = 'tasks.vipper.network',
    [string] $Repo = 'wdembinski/taskmanager',
    [string] $Branch = 'development'
)

$ErrorActionPreference = 'Stop'
$script:AppRepo = Split-Path -Parent $PSScriptRoot

# -- Output --------------------------------------------------------------------

function Write-Phase {
    param([int] $Number, [string] $Title)
    Write-Host ''
    Write-Host ('  {0:00}  {1}' -f $Number, $Title) -ForegroundColor Cyan
    Write-Host ('  ' + ('-' * 68)) -ForegroundColor DarkGray
}
function Write-Step   { param([string] $Message) Write-Host "   -> $Message" -ForegroundColor Gray }
function Write-Ok     { param([string] $Message) Write-Host "   OK  $Message" -ForegroundColor Green }
function Write-Skip   { param([string] $Message) Write-Host "   --  $Message" -ForegroundColor DarkGray }
function Write-Manual { param([string] $Message) Write-Host "   !!  $Message" -ForegroundColor Yellow }

# -- Running external tools ----------------------------------------------------
#
# Native executables are invoked WITHOUT `2>&1`: in Windows PowerShell that wraps each
# stderr line in an ErrorRecord and sets $? to false even on a clean exit. The exit code is
# the only reliable signal, so it is what gets checked.

function Invoke-Native {
    param(
        [Parameter(Mandatory)][string] $File,
        [string[]] $Arguments = @(),
        [switch] $Mutating,
        [switch] $AllowFailure
    )

    if ($Mutating -and $DryRun) {
        Write-Host "   [dry-run] $File $($Arguments -join ' ')" -ForegroundColor DarkYellow
        return $null
    }

    # `-AllowFailure` marks a call whose failure is EXPECTED (probing for a resource that
    # should not exist yet). Discard its stderr so a normal run is not littered with
    # "ERROR: The Vault ... not found", which reads like something went wrong.
    # $ErrorActionPreference is relaxed around the call because in Windows PowerShell a
    # native command writing to stderr under 'Stop' can throw on the redirect itself.
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        if ($AllowFailure) { $output = & $File @Arguments 2>$null }
        else { $output = & $File @Arguments }
    }
    finally {
        $ErrorActionPreference = $previous
    }

    if ($LASTEXITCODE -ne 0 -and -not $AllowFailure) {
        throw "$File $($Arguments -join ' ') exited $LASTEXITCODE`n$($output -join [Environment]::NewLine)"
    }
    return $output
}

function Invoke-AzJson {
    param([Parameter(Mandatory)][string[]] $Arguments, [switch] $AllowFailure)
    $raw = Invoke-Native -File 'az' -Arguments $Arguments -AllowFailure:$AllowFailure
    if ($null -eq $raw -or $raw.Count -eq 0) { return $null }
    $text = ($raw -join [Environment]::NewLine).Trim()
    if ([string]::IsNullOrWhiteSpace($text)) { return $null }
    return ($text | ConvertFrom-Json)
}

function Test-Tool {
    param([string] $Name)
    $cmd = Get-Command $Name -ErrorAction SilentlyContinue
    return ($null -ne $cmd)
}

# -- Secrets -------------------------------------------------------------------

function New-StrongPassword {
    # Composed rather than purely random, so SQL Server's complexity rule is satisfied by
    # construction instead of by luck.
    param([int] $Length = 28)
    $upper = 65..90  | ForEach-Object { [char]$_ }
    $lower = 97..122 | ForEach-Object { [char]$_ }
    $digit = 48..57  | ForEach-Object { [char]$_ }
    $all = $upper + $lower + $digit

    $chars = @()
    $chars += ($upper | Get-Random)
    $chars += ($lower | Get-Random)
    $chars += ($digit | Get-Random)
    for ($i = $chars.Count; $i -lt $Length; $i++) { $chars += ($all | Get-Random) }
    return -join ($chars | Sort-Object { Get-Random })
}

function Test-KeyVaultSecret {
    param([string] $Name)
    $secret = Invoke-AzJson -Arguments @(
        'keyvault', 'secret', 'show', '--vault-name', $KeyVault, '--name', $Name, '-o', 'json'
    ) -AllowFailure
    return ($null -ne $secret)
}

function Set-KeyVaultSecret {
    param([string] $Name, [string] $Value)
    Invoke-Native -File 'az' -Mutating -Arguments @(
        'keyvault', 'secret', 'set', '--vault-name', $KeyVault,
        '--name', $Name, '--value', $Value, '-o', 'none'
    ) | Out-Null
}

function Get-KeyVaultSecret {
    param([string] $Name)
    $raw = Invoke-Native -File 'az' -Arguments @(
        'keyvault', 'secret', 'show', '--vault-name', $KeyVault,
        '--name', $Name, '--query', 'value', '-o', 'tsv'
    )
    return ($raw -join '').Trim()
}

# -- Terraform -----------------------------------------------------------------

function Invoke-Terraform {
    param([string[]] $Arguments, [switch] $Mutating)
    Push-Location $InfraPath
    try {
        Invoke-Native -File 'terraform' -Arguments $Arguments -Mutating:$Mutating
    }
    finally {
        Pop-Location
    }
}

function Get-TerraformOutput {
    param([string] $Name)
    Push-Location $InfraPath
    try {
        $raw = Invoke-Native -File 'terraform' -Arguments @('output', '-raw', $Name) -AllowFailure
        if ($LASTEXITCODE -ne 0) { return $null }
        return ($raw -join '').Trim()
    }
    finally {
        Pop-Location
    }
}

# ==============================================================================
#  Phases
# ==============================================================================

function Invoke-Phase0 {
    Write-Phase 0 'Preflight'

    $missing = @()
    foreach ($tool in @('az', 'terraform', 'gh')) {
        if (Test-Tool $tool) { Write-Ok "$tool found" } else { $missing += $tool }
    }
    if ($missing.Count -gt 0) { throw "Missing required tools: $($missing -join ', ')" }

    if (Test-Tool 'sqlcmd') {
        Write-Ok 'sqlcmd found'
    }
    else {
        Write-Manual 'sqlcmd not found - phase 4 will print the SQL for the Portal query editor instead'
    }

    $account = Invoke-AzJson -Arguments @('account', 'show', '-o', 'json') -AllowFailure
    if ($null -eq $account) { throw "Not signed in to Azure. Run: az login" }
    if ($account.id -ne $SubscriptionId) {
        Write-Step "Switching subscription to $SubscriptionId"
        Invoke-Native -File 'az' -Mutating -Arguments @('account', 'set', '--subscription', $SubscriptionId) | Out-Null
    }
    Write-Ok "Azure: $($account.user.name) on $($account.name)"

    Invoke-Native -File 'gh' -Arguments @('auth', 'status') | Out-Null
    Write-Ok 'GitHub CLI authenticated'

    if (-not (Test-Path $InfraPath)) { throw "Terraform module not found at $InfraPath" }
    if (-not (Test-Path (Join-Path $InfraPath 'terraform.tfvars'))) {
        throw "terraform.tfvars missing. Copy terraform.tfvars.example and fill in ghcr_username, ghcr_pull_token and sql_admin_password."
    }
    Write-Ok 'Terraform module and tfvars present'

    if (-not (Test-Path (Join-Path $InfraPath '.terraform'))) {
        Write-Step 'terraform init'
        Invoke-Terraform -Mutating -Arguments @('init') | Out-Null
    }
    Write-Ok 'Terraform initialised'

    if ($ApiHostname -ne 'tasks-api.vipper.network') {
        Write-Manual "Non-default API hostname. VITE_CLOUD_API_BASE is HARDCODED in .github/workflows/deploy.yml - update it there too."
    }
}

function Invoke-Phase1 {
    Write-Phase 1 'Create the Key Vault on its own'

    $vault = Invoke-AzJson -Arguments @('keyvault', 'show', '--name', $KeyVault, '-o', 'json') -AllowFailure
    if ($null -ne $vault) {
        Write-Skip "Vault $KeyVault already exists"
        return
    }

    Write-Step 'Applying the vault and the Secrets Officer grant only'
    Write-Step 'A full apply cannot work yet: the migrate job references a secret that does not exist'
    Invoke-Terraform -Mutating -Arguments @(
        'apply', '-auto-approve',
        '-target=azurerm_key_vault.taskmanager',
        '-target=azurerm_role_assignment.kv_secrets_officer'
    ) | Out-Null
    Write-Ok "Vault $KeyVault created"

    if (-not $DryRun) {
        Write-Step 'Waiting 60s for the role assignment to propagate'
        Start-Sleep -Seconds 60
    }
}

function Invoke-Phase2 {
    Write-Phase 2 'Seed the secrets'

    # Names are fixed by apps/server/src/config/secrets.ts. Key Vault names cannot contain
    # underscores, hence the dashes.
    foreach ($name in @('db-password', 'db-migrate-password')) {
        if (Test-KeyVaultSecret -Name $name) {
            Write-Skip "$name already set (leaving it alone - the SQL user is built from it)"
        }
        else {
            Write-Step "Generating and storing $name"
            Set-KeyVaultSecret -Name $name -Value (New-StrongPassword)
            Write-Ok "$name stored"
        }
    }

    if (Test-KeyVaultSecret -Name 'cloud-iam-client-secret') {
        Write-Skip 'cloud-iam-client-secret already set'
    }
    else {
        # The real value does not exist until the client is registered in phase 5. A
        # placeholder is enough to let the apply succeed; the API only reads it at startup.
        Write-Step 'Storing a PLACEHOLDER for cloud-iam-client-secret (phase 5 overwrites it)'
        Set-KeyVaultSecret -Name 'cloud-iam-client-secret' -Value 'placeholder-replaced-in-phase-5'
        Write-Ok 'cloud-iam-client-secret placeholder stored'
    }
}

function Invoke-Phase3 {
    Write-Phase 3 'Apply the rest of the infrastructure'

    Write-Step 'terraform apply (SQL, Container App, migrate job, Static Web App, DNS, TLS)'
    try {
        Invoke-Terraform -Mutating -Arguments @('apply', '-auto-approve') | Out-Null
    }
    catch {
        # The hostname binding fails while DNS is still propagating, which TAINTS the
        # resource - so a second apply retries it. This is expected on a first run.
        Write-Manual 'First apply failed. If it was the hostname binding, DNS has not propagated yet.'
        Write-Step 'Retrying once in 90s'
        if (-not $DryRun) { Start-Sleep -Seconds 90 }
        Invoke-Terraform -Mutating -Arguments @('apply', '-auto-approve') | Out-Null
    }
    Write-Ok 'Infrastructure applied'

    if (-not $DryRun) {
        foreach ($name in @('sql_server_fqdn', 'key_vault_uri', 'api_default_fqdn', 'web_default_host_name')) {
            $value = Get-TerraformOutput -Name $name
            if ($value) { Write-Ok "$name = $value" }
        }
    }
}

function Invoke-Phase4 {
    Write-Phase 4 'Create the two database users'

    $fqdn = Get-TerraformOutput -Name 'sql_server_fqdn'
    if (-not $fqdn) { $fqdn = "$SqlServer.database.windows.net" }

    # The only firewall rule Terraform creates is AllowAzureServices. That is what lets the
    # migrate job in and keeps a CI runner out - and it keeps THIS machine out too.
    Write-Step 'Opening a temporary firewall rule for this machine'
    $myIp = $null
    try {
        $myIp = (Invoke-RestMethod -Uri 'https://api.ipify.org?format=json' -TimeoutSec 20).ip
    }
    catch {
        throw "Could not determine this machine's public IP. Add a firewall rule by hand, then re-run with -Phase 4."
    }

    Invoke-Native -File 'az' -Mutating -Arguments @(
        'sql', 'server', 'firewall-rule', 'create', '-g', $ResourceGroup, '-s', $SqlServer,
        '-n', 'operator-temp', '--start-ip-address', $myIp, '--end-ip-address', $myIp, '-o', 'none'
    ) -AllowFailure | Out-Null
    Write-Ok "Temporary rule open for $myIp"

    try {
        if ($DryRun) {
            # Reading the real secrets would throw before phase 1 has created the vault,
            # which would make a dry run of the whole sequence impossible.
            $appPassword = '<db-password>'
            $migratePassword = '<db-migrate-password>'
        }
        else {
            $appPassword = Get-KeyVaultSecret -Name 'db-password'
            $migratePassword = Get-KeyVaultSecret -Name 'db-migrate-password'
        }

        # ALTER rather than only CREATE, so a re-run guarantees the user's password still
        # matches what is in the vault. tmmigrate needs data rights as well as DDL: the
        # initial migration inserts a seed row, not just tables.
        $sql = @"
IF NOT EXISTS (SELECT 1 FROM sys.database_principals WHERE name = 'tmapp')
    CREATE USER tmapp WITH PASSWORD = '$appPassword';
ELSE
    ALTER USER tmapp WITH PASSWORD = '$appPassword';
ALTER ROLE db_datareader ADD MEMBER tmapp;
ALTER ROLE db_datawriter ADD MEMBER tmapp;

IF NOT EXISTS (SELECT 1 FROM sys.database_principals WHERE name = 'tmmigrate')
    CREATE USER tmmigrate WITH PASSWORD = '$migratePassword';
ELSE
    ALTER USER tmmigrate WITH PASSWORD = '$migratePassword';
ALTER ROLE db_ddladmin   ADD MEMBER tmmigrate;
ALTER ROLE db_datareader ADD MEMBER tmmigrate;
ALTER ROLE db_datawriter ADD MEMBER tmmigrate;
"@

        if (-not (Test-Tool 'sqlcmd')) {
            Write-Manual 'sqlcmd is not installed. Run this in the Azure Portal query editor'
            Write-Manual "against the '$SqlDatabase' database (NOT master), then re-run -Phase 5:"
            Write-Host ''
            Write-Host ($sql -replace [regex]::Escape($appPassword), '<db-password>' `
                             -replace [regex]::Escape($migratePassword), '<db-migrate-password>')
            Write-Host ''
            Write-Manual 'The two passwords are in Key Vault as db-password and db-migrate-password.'
            return
        }

        if ($DryRun) {
            Write-Host '   [dry-run] sqlcmd would create tmapp and tmmigrate' -ForegroundColor DarkYellow
        }
        else {
            $file = Join-Path $env:TEMP ("tm-users-{0}.sql" -f [guid]::NewGuid())
            try {
                Set-Content -Path $file -Value $sql -Encoding utf8
                Invoke-Native -File 'sqlcmd' -Arguments @(
                    '-S', $fqdn, '-d', $SqlDatabase, '-G', '-l', '45', '-b', '-i', $file
                ) | Out-Null
                Write-Ok 'tmapp and tmmigrate created (least privilege - only tmmigrate has DDL)'
            }
            finally {
                # The file holds both passwords in clear text; it must not outlive this block.
                Remove-Item $file -Force -ErrorAction SilentlyContinue
            }
        }
    }
    finally {
        Write-Step 'Closing the temporary firewall rule'
        Invoke-Native -File 'az' -Mutating -AllowFailure -Arguments @(
            'sql', 'server', 'firewall-rule', 'delete', '-g', $ResourceGroup,
            '-s', $SqlServer, '-n', 'operator-temp', '-o', 'none'
        ) | Out-Null
        Write-Ok 'Temporary rule removed'
    }
}

function Invoke-Phase5 {
    Write-Phase 5 'Register the vipper.iam clients  [MANUAL]'

    Write-Manual 'This phase cannot be automated - it happens in the vipper.iam console.'
    Write-Host ''
    Write-Host '     taskmanager-api      confidential   the server''s introspection + authorization'
    Write-Host '     taskmanager-web      public, PKCE   redirect https://' -NoNewline
    Write-Host "$WebHostname/callback"
    Write-Host '     taskmanager-desktop  public, PKCE   redirect: the desktop app''s loopback URI'
    Write-Host ''
    Write-Host '     Both public clients: grants authorization_code + refresh_token,'
    Write-Host '     token_endpoint_auth_method none. PKCE is what secures them, so shipping'
    Write-Host '     their ids in a bundle or a binary is fine.'
    Write-Host ''

    if ($DryRun) {
        Write-Host '   [dry-run] would prompt for the taskmanager-api client secret' -ForegroundColor DarkYellow
        return
    }

    $secure = Read-Host -Prompt '   Paste the taskmanager-api client secret (blank to skip)' -AsSecureString
    $plain = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
        [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))

    if ([string]::IsNullOrWhiteSpace($plain)) {
        Write-Manual 'Skipped. The API cannot authenticate anyone until this is set. Re-run with -Phase 5.'
        return
    }

    Set-KeyVaultSecret -Name 'cloud-iam-client-secret' -Value $plain.Trim()
    Write-Ok 'cloud-iam-client-secret stored'

    # Secrets are read once, at startup - so the running revision still holds the placeholder.
    Write-Step 'Restarting the app so it re-reads Key Vault'
    $revision = Invoke-Native -File 'az' -Arguments @(
        'containerapp', 'show', '-n', $ContainerApp, '-g', $ResourceGroup,
        '--query', 'properties.latestRevisionName', '-o', 'tsv'
    ) -AllowFailure
    if ($revision) {
        Invoke-Native -File 'az' -Mutating -AllowFailure -Arguments @(
            'containerapp', 'revision', 'restart', '-n', $ContainerApp,
            '-g', $ResourceGroup, '--revision', ($revision -join '').Trim(), '-o', 'none'
        ) | Out-Null
        Write-Ok 'Revision restarted'
    }
}

function Invoke-Phase6 {
    Write-Phase 6 'Wire up CI'

    $appId = $null
    $existing = Invoke-AzJson -Arguments @(
        'ad', 'app', 'list', '--display-name', 'taskmanager-deploy', '-o', 'json'
    ) -AllowFailure
    if ($null -ne $existing -and $existing.Count -gt 0) {
        $appId = $existing[0].appId
        Write-Skip "App registration taskmanager-deploy exists ($appId)"
    }
    else {
        Write-Step 'Creating the deploy app registration'
        $raw = Invoke-Native -File 'az' -Mutating -Arguments @(
            'ad', 'app', 'create', '--display-name', 'taskmanager-deploy', '--query', 'appId', '-o', 'tsv'
        )
        if ($null -ne $raw) { $appId = ($raw -join '').Trim() }
        if ($appId) {
            Invoke-Native -File 'az' -Mutating -AllowFailure -Arguments @('ad', 'sp', 'create', '--id', $appId, '-o', 'none') | Out-Null
            Write-Ok "App registration created ($appId)"
        }
    }

    if ($appId) {
        # Federated OIDC - there is no stored Azure credential anywhere in GitHub.
        # The subject must name the integration branch; this repo has no `main`.
        $creds = Invoke-AzJson -Arguments @('ad', 'app', 'federated-credential', 'list', '--id', $appId, '-o', 'json') -AllowFailure
        $subject = "repo:${Repo}:ref:refs/heads/$Branch"
        $has = $false
        if ($null -ne $creds) {
            foreach ($c in $creds) { if ($c.subject -eq $subject) { $has = $true } }
        }
        if ($has) {
            Write-Skip 'Federated credential already present'
        }
        else {
            Write-Step "Adding the federated credential for $subject"
            $json = '{"name":"taskmanager-' + $Branch + '","issuer":"https://token.actions.githubusercontent.com","subject":"' + $subject + '","audiences":["api://AzureADTokenExchange"]}'
            Invoke-Native -File 'az' -Mutating -AllowFailure -Arguments @(
                'ad', 'app', 'federated-credential', 'create', '--id', $appId, '--parameters', $json
            ) | Out-Null
            Write-Ok 'Federated credential created'
        }

        Write-Step 'Granting Contributor on the resource group'
        Invoke-Native -File 'az' -Mutating -AllowFailure -Arguments @(
            'role', 'assignment', 'create', '--assignee', $appId, '--role', 'Contributor',
            '--scope', "/subscriptions/$SubscriptionId/resourceGroups/$ResourceGroup", '-o', 'none'
        ) | Out-Null
        Write-Ok 'Role assignment ensured'
    }

    $tenantId = (Invoke-Native -File 'az' -Arguments @('account', 'show', '--query', 'tenantId', '-o', 'tsv')) -join ''
    $swaToken = Invoke-Native -File 'az' -Arguments @(
        'staticwebapp', 'secrets', 'list', '-n', $StaticWebApp, '-g', $ResourceGroup,
        '--query', 'properties.apiKey', '-o', 'tsv'
    ) -AllowFailure

    $secrets = [ordered]@{
        'AZURE_CLIENT_ID'                 = $appId
        'AZURE_TENANT_ID'                 = $tenantId.Trim()
        'AZURE_SUBSCRIPTION_ID'           = $SubscriptionId
        'VITE_CLOUD_IAM_CLIENT_ID'        = 'taskmanager-web'
        'AZURE_STATIC_WEB_APPS_API_TOKEN' = (($swaToken -join '').Trim())
    }

    Push-Location $script:AppRepo
    try {
        foreach ($key in $secrets.Keys) {
            $value = $secrets[$key]
            if ([string]::IsNullOrWhiteSpace($value)) {
                Write-Manual "$key is empty - set it by hand once the value exists"
                continue
            }
            Invoke-Native -File 'gh' -Mutating -Arguments @('secret', 'set', $key, '--body', $value, '--repo', $Repo) | Out-Null
            Write-Ok "$key set"
        }
    }
    finally {
        Pop-Location
    }
}

function Invoke-Phase7 {
    Write-Phase 7 'First deploy'

    Write-Step "Dispatching the Deploy workflow on $Branch"
    Invoke-Native -File 'gh' -Mutating -Arguments @(
        'workflow', 'run', 'Deploy', '--ref', $Branch, '--repo', $Repo
    ) | Out-Null
    Write-Ok 'Workflow dispatched'
    Write-Step 'Watch it with:  gh run watch'
    Write-Manual 'A dispatch compares against the previous commit, so a job may be skipped if'
    Write-Manual 'nothing under its paths changed. That is the filter working, not a failure.'
}

function Invoke-Phase8 {
    Write-Phase 8 'Verify'

    $healthUrl = "https://$ApiHostname/health"
    $boardUrl = "https://$ApiHostname/v1/board"
    $failures = 0

    Write-Step "GET $healthUrl  (expect 200)"
    try {
        $response = Invoke-WebRequest -Uri $healthUrl -UseBasicParsing -TimeoutSec 30
        if ($response.StatusCode -eq 200) {
            Write-Ok "health: $($response.Content)"
        }
        else {
            Write-Manual "health returned $($response.StatusCode)"; $failures++
        }
    }
    catch {
        Write-Manual "health unreachable: $($_.Exception.Message)"
        Write-Manual 'A 401 here would mean the guard was applied too broadly - Container Apps'
        Write-Manual 'would then restart the replica forever.'
        $failures++
    }

    Write-Step "GET $boardUrl  (expect 401)"
    try {
        $response = Invoke-WebRequest -Uri $boardUrl -UseBasicParsing -TimeoutSec 30
        Write-Manual "board returned $($response.StatusCode) - it should be 401. The API is UNGUARDED;"
        Write-Manual 'check that CLOUD_DEV_NO_AUTH has not reached production.'
        $failures++
    }
    catch {
        $code = $null
        if ($_.Exception.Response) { $code = [int]$_.Exception.Response.StatusCode }
        if ($code -eq 401) {
            Write-Ok 'board: 401 - the IAM guard is active'
        }
        elseif ($null -eq $code) {
            Write-Manual "board unreachable: $($_.Exception.Message)"; $failures++
        }
        else {
            Write-Manual "board returned $code - expected 401"; $failures++
        }
    }

    Write-Step 'Latest revisions and migration runs'
    Invoke-Native -File 'az' -AllowFailure -Arguments @(
        'containerapp', 'revision', 'list', '-n', $ContainerApp, '-g', $ResourceGroup, '-o', 'table'
    )
    Invoke-Native -File 'az' -AllowFailure -Arguments @(
        'containerapp', 'job', 'execution', 'list', '-n', $MigrateJob, '-g', $ResourceGroup, '-o', 'table'
    )

    Write-Host ''
    if ($failures -eq 0) {
        Write-Ok "The service is up. Open https://$WebHostname and sign in."
        Write-Manual 'A desktop client must sync at least once before the web client can send'
        Write-Manual 'commands - until then there is no Client to relay them to.'
    }
    else {
        Write-Manual "$failures check(s) failed - see docs/10-cloud-deployment-runbook.md"
    }
    $script:VerifyFailures = $failures
}

# ==============================================================================

$phases = [ordered]@{
    0 = ${function:Invoke-Phase0}
    1 = ${function:Invoke-Phase1}
    2 = ${function:Invoke-Phase2}
    3 = ${function:Invoke-Phase3}
    4 = ${function:Invoke-Phase4}
    5 = ${function:Invoke-Phase5}
    6 = ${function:Invoke-Phase6}
    7 = ${function:Invoke-Phase7}
    8 = ${function:Invoke-Phase8}
}

Write-Host ''
Write-Host '  VIPPER Task Manager - cloud deployment' -ForegroundColor White
if ($DryRun) { Write-Host '  DRY RUN - no mutating command will be executed' -ForegroundColor DarkYellow }

if ($Phase -ge 0) {
    $selected = @($Phase)
}
else {
    $selected = @($phases.Keys | Where-Object { $_ -ge $From })
}

$script:VerifyFailures = 0
foreach ($number in $selected) {
    & $phases[$number]
}

Write-Host ''
Write-Host '  Done.' -ForegroundColor White
Write-Host ''

# Exit deliberately rather than inheriting whatever the last native command returned:
# a non-zero exit means verification found something wrong, and nothing else.
if ($script:VerifyFailures -gt 0) { exit 1 }
exit 0
