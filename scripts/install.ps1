# Copy finished plugins from this repo into ~/.config/opencode/plugins.
# Development stays in the repo; OpenCode only sees what you install.
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install.ps1 -Plugin everything-search.ts
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install.ps1 -WhatIf

[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [string]$Plugin
)

$ErrorActionPreference = "Stop"

$RepoRoot = Split-Path -Parent $PSScriptRoot
$Src = Join-Path $RepoRoot "plugins"
$ConfigDir = Join-Path $env:USERPROFILE ".config\opencode"
$Dst = Join-Path $ConfigDir "plugins"

if (-not (Test-Path -LiteralPath $Src)) {
    throw "Plugins directory not found: $Src"
}

New-Item -ItemType Directory -Path $ConfigDir -Force | Out-Null

# If a previous junction install is present, remove the link (not the repo).
if (Test-Path -LiteralPath $Dst) {
    $item = Get-Item -LiteralPath $Dst -Force
    $isReparse = ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0
    if ($isReparse) {
        Write-Host "Removing existing junction/link: $Dst"
        if ($PSCmdlet.ShouldProcess($Dst, "Remove junction")) {
            cmd /c rmdir "`"$Dst`""
            if ($LASTEXITCODE -ne 0) { throw "Failed to remove junction: $Dst" }
        }
    }
}

New-Item -ItemType Directory -Path $Dst -Force | Out-Null

$files = if ($Plugin) {
    $path = Join-Path $Src $Plugin
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        throw "Plugin file not found: $path"
    }
    @(Get-Item -LiteralPath $path)
} else {
    @(Get-ChildItem -LiteralPath $Src -File | Where-Object { $_.Extension -in ".ts", ".js", ".mjs", ".cjs" })
}

if ($files.Count -eq 0) {
    Write-Host "No plugin files to install under $Src"
    exit 0
}

foreach ($file in $files) {
    $target = Join-Path $Dst $file.Name
    if ($PSCmdlet.ShouldProcess($target, "Copy $($file.Name)")) {
        Copy-Item -LiteralPath $file.FullName -Destination $target -Force
        Write-Host "Installed: $($file.Name) -> $target"
    }
}

# Sync office scripts to runtime (used by office-docs plugin)
$OfficeSrc = Join-Path $RepoRoot "scripts\office"
$OfficeDst = Join-Path $env:LOCALAPPDATA "opencode-office\scripts"
if (Test-Path -LiteralPath $OfficeSrc) {
    if ($PSCmdlet.ShouldProcess($OfficeDst, "Sync office scripts")) {
        New-Item -ItemType Directory -Path $OfficeDst -Force | Out-Null
        Copy-Item -Path (Join-Path $OfficeSrc "*") -Destination $OfficeDst -Recurse -Force
        Write-Host "Office scripts: $OfficeDst"
    }
}

# Sync office-docs skill (global OpenCode skills)
$SkillSrc = Join-Path $RepoRoot "skills\office-docs"
$SkillDst = Join-Path $ConfigDir "skills\office-docs"
if (Test-Path -LiteralPath $SkillSrc) {
    if ($PSCmdlet.ShouldProcess($SkillDst, "Sync office-docs skill")) {
        New-Item -ItemType Directory -Path $SkillDst -Force | Out-Null
        Copy-Item -Path (Join-Path $SkillSrc "*") -Destination $SkillDst -Recurse -Force
        Write-Host "Skill: $SkillDst"
    }
}

Write-Host ""
Write-Host "Source (dev):  $Src"
Write-Host "Target (live): $Dst"
Write-Host "Restart OpenCode to load plugins."
