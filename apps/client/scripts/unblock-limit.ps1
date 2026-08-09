# scripts/unblock-limit.ps1
# Convenience wrapper: clears a falsely-engaged usage-limit gate via Electron-as-node.
# Close the app first (SQLite lock). From the repo root:
#   powershell -ExecutionPolicy Bypass -File .\scripts\unblock-limit.ps1
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$electron = Join-Path $repo 'node_modules\electron\dist\electron.exe'
if (-not (Test-Path $electron)) {
  Write-Error "electron.exe not found at $electron - run this from the repo with deps installed."
}
$env:ELECTRON_RUN_AS_NODE = '1'
& $electron (Join-Path $PSScriptRoot 'unblock-limit.cjs')
