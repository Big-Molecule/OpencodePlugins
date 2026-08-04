# Install OpenCodePlugins into ~/.config/opencode/plugins via directory junction.
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install.ps1

$ErrorActionPreference = "Stop"

$RepoRoot = Split-Path -Parent $PSScriptRoot
$Src = Join-Path $RepoRoot "plugins"
$ConfigDir = Join-Path $env:USERPROFILE ".config\opencode"
$Dst = Join-Path $ConfigDir "plugins"

if (-not (Test-Path -LiteralPath $Src)) {
    throw "Plugins directory not found: $Src"
}

New-Item -ItemType Directory -Path $ConfigDir -Force | Out-Null

if (Test-Path -LiteralPath $Dst) {
    $item = Get-Item -LiteralPath $Dst -Force
    $isJunction = ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0
    if ($isJunction) {
        Write-Host "Removing existing junction: $Dst"
        cmd /c rmdir "$Dst"
    } else {
        $backup = "$Dst.bak-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
        Write-Host "Backing up existing plugins folder to: $backup"
        Rename-Item -LiteralPath $Dst -NewName (Split-Path $backup -Leaf)
        # Rename-Item keeps parent; move backup next to plugins if needed
        if (Test-Path -LiteralPath (Join-Path $ConfigDir (Split-Path $backup -Leaf))) {
            # already renamed in place
        }
    }
}

cmd /c mklink /J "$Dst" "$Src"
if ($LASTEXITCODE -ne 0) {
    throw "mklink failed. Try running PowerShell as the same user that owns $ConfigDir."
}

Write-Host ""
Write-Host "Linked:"
Write-Host "  $Dst"
Write-Host "  -> $Src"
Write-Host ""
Write-Host "Restart OpenCode to load plugins."
