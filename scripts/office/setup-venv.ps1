# Create/reuse dedicated venv for office-docs (does NOT touch project venv).
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\setup-venv.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\setup-venv.ps1 -Python "C:\Python312\python.exe"

[CmdletBinding()]
param(
    [string]$Python = "",
    [string]$VenvDir = "",
    [string[]]$Packages = @("python-docx", "openpyxl", "lxml")
)

$ErrorActionPreference = "Stop"

$Root = if ($env:LOCALAPPDATA) {
    Join-Path $env:LOCALAPPDATA "opencode-office"
} else {
    Join-Path $env:USERPROFILE ".opencode-office"
}
if (-not $VenvDir) { $VenvDir = Join-Path $Root "venv" }
$ConfigPath = Join-Path $env:USERPROFILE ".config\opencode\office-docs.json"
$ScriptsTarget = Join-Path $Root "scripts"

function Find-SystemPython {
    param([string]$Explicit)
    if ($Explicit) {
        if (-not (Test-Path -LiteralPath $Explicit)) { throw "Python not found: $Explicit" }
        return (Resolve-Path -LiteralPath $Explicit).Path
    }
    $candidates = @()
    foreach ($name in @("python", "python3", "py")) {
        $cmd = Get-Command $name -ErrorAction SilentlyContinue
        if ($cmd -and $cmd.Source) { $candidates += $cmd.Source }
    }
    # py -3 launcher
    $py = Get-Command py -ErrorAction SilentlyContinue
    if ($py) {
        try {
            $out = & py -3 -c "import sys; print(sys.executable)" 2>$null
            if ($out -and (Test-Path -LiteralPath $out.Trim())) { return $out.Trim() }
        } catch {}
    }
    foreach ($c in $candidates) {
        try {
            $ver = & $c -c "import sys; assert sys.version_info >= (3, 10); print(sys.executable)" 2>$null
            if ($LASTEXITCODE -eq 0 -and $ver) { return $ver.Trim() }
        } catch {}
    }
    throw "No suitable Python (>=3.10) found on PATH. Install Python and retry, or pass -Python <path>."
}

function Test-WordCom {
    try {
        $w = New-Object -ComObject Word.Application
        $w.Quit() | Out-Null
        [System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($w) | Out-Null
        return $true
    } catch {
        return $false
    }
}

Write-Host "opencode-office setup"
Write-Host "Root: $Root"

$systemPy = Find-SystemPython -Explicit $Python
Write-Host "System Python: $systemPy"

$wordOk = Test-WordCom
Write-Host "Word COM: $(if ($wordOk) { 'ok' } else { 'MISSING' })"

New-Item -ItemType Directory -Path $Root -Force | Out-Null
New-Item -ItemType Directory -Path (Split-Path $ConfigPath -Parent) -Force | Out-Null

if (-not (Test-Path -LiteralPath (Join-Path $VenvDir "Scripts\python.exe"))) {
    Write-Host "Creating venv: $VenvDir"
    & $systemPy -m venv $VenvDir
    if ($LASTEXITCODE -ne 0) { throw "venv creation failed" }
} else {
    Write-Host "Reusing venv: $VenvDir"
}

$venvPy = Join-Path $VenvDir "Scripts\python.exe"
$venvPip = Join-Path $VenvDir "Scripts\pip.exe"
if (-not (Test-Path -LiteralPath $venvPy)) { throw "venv python missing: $venvPy" }

Write-Host "Installing packages: $($Packages -join ', ')"
& $venvPy -m pip install --upgrade pip
& $venvPy -m pip install @Packages
if ($LASTEXITCODE -ne 0) { throw "pip install failed" }

# Copy scripts next to runtime (so plugin can find them after install.ps1)
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
New-Item -ItemType Directory -Path $ScriptsTarget -Force | Out-Null
Copy-Item -Path (Join-Path $here "*") -Destination $ScriptsTarget -Recurse -Force
# avoid nesting venv into scripts copy loops - we only copy from scripts/office source
Write-Host "Scripts synced: $ScriptsTarget"

# verify imports
& $venvPy -c "import docx, openpyxl, lxml; print('imports-ok')"
if ($LASTEXITCODE -ne 0) { throw "import verify failed" }

$cfg = [ordered]@{
    python     = $venvPy
    venv       = $VenvDir
    systemPython = $systemPy
    scriptsDir = $ScriptsTarget
    wordOk     = $wordOk
    packages   = $Packages
    updatedAt  = (Get-Date).ToString("o")
}
$cfg | ConvertTo-Json | Set-Content -LiteralPath $ConfigPath -Encoding UTF8
Write-Host "Config: $ConfigPath"
Write-Host "OK setup complete"
if (-not $wordOk) {
    Write-Host "WARN: Word COM not available — editing may work; page render preview will fail until Office is installed."
}
