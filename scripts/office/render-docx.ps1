# Stable DOCX page preview via Microsoft Word COM + poppler pdftoppm.
#
# Pipeline:
#   1) Copy DOCX to a short ASCII work dir (avoids path encoding issues)
#   2) cscript export-docx-pdf.vbs  -> PDF  (VBS COM is more stable than PS COM)
#   3) pdftoppm -png                -> page-N.png
#   4) Kill leftover WINWORD if needed
#
# Usage:
#   .\render-docx.ps1 -InputDocx file.docx -Page 1 -OutputDir .\ .opencode-office\cache\job1
#   .\render-docx.ps1 -InputDocx file.docx -AllPages -OutputDir ...
#
# Requires: Microsoft Word COM + pdftoppm.exe

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$InputDocx,

    [int]$Page = 1,

    [switch]$AllPages,

    [string]$OutputDir = "",

    [int]$Dpi = 144,

    [int]$TimeoutSec = 120,

    [string]$PdfToPpm = "",

    [switch]$KeepPdf
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version 3.0

function Resolve-PdfToPpm {
    param([string]$Explicit)
    if ($Explicit -and (Test-Path -LiteralPath $Explicit)) {
        return (Resolve-Path -LiteralPath $Explicit).Path
    }
    $candidates = @(
        "$env:LOCALAPPDATA\opencode-office\poppler\Library\bin\pdftoppm.exe",
        "$env:USERPROFILE\.cache\codex-runtimes\codex-primary-runtime\dependencies\native\poppler\Library\bin\pdftoppm.exe"
    )
    foreach ($c in $candidates) {
        if (Test-Path -LiteralPath $c) { return $c }
    }
    $cmd = Get-Command pdftoppm.exe -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    return $null
}

function Stop-WordQuiet {
    Get-Process WINWORD -ErrorAction SilentlyContinue | ForEach-Object {
        try { $_.Kill() } catch {}
    }
    Start-Sleep -Milliseconds 400
}

if (-not (Test-Path -LiteralPath $InputDocx)) {
    throw "Input DOCX not found: $InputDocx"
}
$InputDocx = (Resolve-Path -LiteralPath $InputDocx).Path

if (-not $AllPages -and $Page -lt 1) { throw "Page must be >= 1" }
if ($Dpi -lt 36 -or $Dpi -gt 600) { throw "Dpi should be between 36 and 600" }

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$vbs = Join-Path $scriptDir "export-docx-pdf.vbs"
if (-not (Test-Path -LiteralPath $vbs)) {
    throw "Missing VBS exporter: $vbs"
}

$pdftoppm = Resolve-PdfToPpm -Explicit $PdfToPpm
if (-not $pdftoppm) {
    throw "pdftoppm.exe not found. Install poppler or place under %LOCALAPPDATA%\opencode-office\poppler\..."
}

if (-not $OutputDir) {
    $OutputDir = Join-Path (Get-Location) ".opencode-office\cache\default"
}
New-Item -ItemType Directory -Path $OutputDir -Force | Out-Null
$OutputDir = (Resolve-Path -LiteralPath $OutputDir).Path

$work = Join-Path $env:TEMP ("opencode-office\work-" + [guid]::NewGuid().ToString("N").Substring(0, 8))
New-Item -ItemType Directory -Path $work -Force | Out-Null

$workDocx = Join-Path $work "input.docx"
$workPdf = Join-Path $work "output.pdf"
$pngPrefix = Join-Path $OutputDir "page"

try {
    Copy-Item -LiteralPath $InputDocx -Destination $workDocx -Force
    Stop-WordQuiet

    Write-Host "Word COM: DOCX -> PDF ..."
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = "cscript.exe"
    $psi.Arguments = "//nologo `"$vbs`" `"$workDocx`" `"$workPdf`""
    $psi.UseShellExecute = $false
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.CreateNoWindow = $true
    $proc = [System.Diagnostics.Process]::Start($psi)
    if (-not $proc.WaitForExit($TimeoutSec * 1000)) {
        try { $proc.Kill() } catch {}
        Stop-WordQuiet
        throw "Word export timed out after ${TimeoutSec}s"
    }
    $stdout = $proc.StandardOutput.ReadToEnd()
    $stderr = $proc.StandardError.ReadToEnd()
    if ($stdout) { Write-Host $stdout.TrimEnd() }
    if ($stderr) { Write-Host $stderr.TrimEnd() }
    if ($proc.ExitCode -ne 0 -or -not (Test-Path -LiteralPath $workPdf)) {
        Stop-WordQuiet
        throw "Word export failed (exit $($proc.ExitCode))"
    }
    Stop-WordQuiet

    if ($KeepPdf) {
        $outPdf = Join-Path $OutputDir "document.pdf"
        Copy-Item -LiteralPath $workPdf -Destination $outPdf -Force
        Write-Host "PDF: $outPdf"
    }

    # clear old page pngs in this job dir
    Get-ChildItem -LiteralPath $OutputDir -Filter "page-*.png" -ErrorAction SilentlyContinue |
        Remove-Item -Force -ErrorAction SilentlyContinue

    if ($AllPages) {
        Write-Host "pdftoppm: all pages -> PNG @ ${Dpi}dpi ..."
        $pArgs = @("-png", "-r", "$Dpi", $workPdf, $pngPrefix)
    } else {
        Write-Host "pdftoppm: page $Page -> PNG @ ${Dpi}dpi ..."
        $pArgs = @("-png", "-f", "$Page", "-l", "$Page", "-r", "$Dpi", $workPdf, $pngPrefix)
    }
    $p = Start-Process -FilePath $pdftoppm -ArgumentList $pArgs -Wait -PassThru -NoNewWindow
    if ($p.ExitCode -ne 0) {
        throw "pdftoppm failed (exit $($p.ExitCode))"
    }

    $pngs = @(Get-ChildItem -LiteralPath $OutputDir -Filter "page-*.png" | Sort-Object Name)
    if ($pngs.Count -eq 0) {
        throw "PNG not produced in $OutputDir"
    }

    Write-Host "OK"
    Write-Host "DIR=$OutputDir"
    Write-Host "COUNT=$($pngs.Count)"
    foreach ($f in $pngs) {
        Write-Host "PNG=$($f.FullName)"
    }
    return ($pngs | ForEach-Object { $_.FullName })
}
finally {
    Stop-WordQuiet
    try {
        if (Test-Path -LiteralPath $work) {
            Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
        }
    } catch {}
}
