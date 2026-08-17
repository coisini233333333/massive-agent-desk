param(
    [string]$CodexHome = "$env:USERPROFILE\.codex",
    [string]$RepositoryRoot = (Split-Path -Parent $PSScriptRoot)
)

$ErrorActionPreference = 'Stop'
$bundleRoot = (Resolve-Path -LiteralPath $PSScriptRoot).Path
$repoRoot = (Resolve-Path -LiteralPath $RepositoryRoot).Path
$targetRoot = [System.IO.Path]::GetFullPath($CodexHome)
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$configTarget = Join-Path $targetRoot 'config.toml'
$agentsTarget = Join-Path $targetRoot 'agents'
$skillTarget = Join-Path $targetRoot 'skills\design-personal-agent-team'

New-Item -ItemType Directory -Force -Path $targetRoot, $agentsTarget, (Split-Path -Parent $skillTarget) | Out-Null

foreach ($name in @('AGENTS.md', 'config.toml')) {
    $target = Join-Path $targetRoot $name
    if (Test-Path -LiteralPath $target) {
        Copy-Item -LiteralPath $target -Destination "$target.$stamp.bak"
    }
}

Copy-Item -LiteralPath (Join-Path $bundleRoot 'AGENTS.md') -Destination (Join-Path $targetRoot 'AGENTS.md') -Force
Get-ChildItem -LiteralPath (Join-Path $bundleRoot 'agents') -Filter '*.toml' -File | ForEach-Object {
    $target = Join-Path $agentsTarget $_.Name
    if (Test-Path -LiteralPath $target) { Copy-Item -LiteralPath $target -Destination "$target.$stamp.bak" }
    Copy-Item -LiteralPath $_.FullName -Destination $target -Force
}

$skillSource = Join-Path $repoRoot 'skills\design-personal-agent-team'
if (Test-Path -LiteralPath $skillTarget) {
    Copy-Item -LiteralPath $skillTarget -Destination "$skillTarget.$stamp.bak" -Recurse
}
New-Item -ItemType Directory -Force -Path $skillTarget | Out-Null
Get-ChildItem -LiteralPath $skillSource -Force | Copy-Item -Destination $skillTarget -Recurse -Force

$agentBlock = (Get-Content -LiteralPath (Join-Path $bundleRoot 'config.agents.toml') -Raw).Trim()
$configText = if (Test-Path -LiteralPath $configTarget) { Get-Content -LiteralPath $configTarget -Raw } else { '' }
$pattern = '(?ms)^\[agents\]\s*.*?(?=^\[[^\r\n]+\]|\z)'
if ([regex]::IsMatch($configText, $pattern)) {
    $configText = [regex]::Replace($configText, $pattern, "$agentBlock`r`n`r`n")
} else {
    $configText = $configText.TrimEnd() + "`r`n`r`n$agentBlock`r`n"
}
[System.IO.File]::WriteAllText($configTarget, $configText, [System.Text.UTF8Encoding]::new($false))

Write-Output "Installed global AGENTS.md, eight custom agents, the skill, and [agents] config into $targetRoot"
Write-Output "Backups use suffix .$stamp.bak"
