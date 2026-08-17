param(
    [Parameter(Mandatory = $true)]
    [string]$BundleRoot,
    [string]$CodexHome = "$env:USERPROFILE\.codex"
)

$ErrorActionPreference = 'Stop'
$sourceRoot = (Resolve-Path -LiteralPath $BundleRoot).Path
$targetRoot = [System.IO.Path]::GetFullPath($CodexHome)
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$agentsSource = Join-Path $sourceRoot 'agents'
$agentsTarget = Join-Path $targetRoot 'agents'
$agentsMdSource = Join-Path $sourceRoot 'AGENTS.md'

if (-not (Test-Path -LiteralPath $agentsMdSource)) { throw "Missing $agentsMdSource" }
if (-not (Test-Path -LiteralPath $agentsSource)) { throw "Missing $agentsSource" }

New-Item -ItemType Directory -Force -Path $targetRoot, $agentsTarget | Out-Null
$agentsMdTarget = Join-Path $targetRoot 'AGENTS.md'
if (Test-Path -LiteralPath $agentsMdTarget) {
    Copy-Item -LiteralPath $agentsMdTarget -Destination "$agentsMdTarget.$stamp.bak"
}
Copy-Item -LiteralPath $agentsMdSource -Destination $agentsMdTarget -Force

Get-ChildItem -LiteralPath $agentsSource -Filter '*.toml' -File | ForEach-Object {
    $target = Join-Path $agentsTarget $_.Name
    if (Test-Path -LiteralPath $target) {
        Copy-Item -LiteralPath $target -Destination "$target.$stamp.bak"
    }
    Copy-Item -LiteralPath $_.FullName -Destination $target -Force
}

Write-Output "Installed AGENTS.md and custom agents into $targetRoot"
Write-Output 'Merge config.agents.toml into config.toml with a TOML-aware editor; the installer intentionally does not rewrite unrelated configuration.'
