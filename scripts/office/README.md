# Office DOCX render workflow (Word COM)

Stable **page preview** for `.docx` without LibreOffice.

## Pipeline

```text
DOCX
  │  cscript export-docx-pdf.vbs   (Word.Application COM)
  ▼
PDF
  │  pdftoppm -png -f N -l N
  ▼
page-N.png
```

| Step | Why |
|------|-----|
| Copy DOCX to short ASCII work dir | Avoid Chinese-path / encoding issues |
| **VBS** COM export (not PowerShell COM) | PS `ExportAsFixedFormat` / `SaveAs` often hangs; VBS is stable |
| Kill leftover `WINWORD` | Prevent zombie Word processes |
| poppler `pdftoppm` | PDF page → PNG |

## Requirements

1. **Microsoft Word** installed (Click-to-Run Office is fine).
2. **pdftoppm.exe** (poppler), auto-detected from:
   - `%LOCALAPPDATA%\opencode-office\poppler\Library\bin\pdftoppm.exe`
   - Codex runtime cache (if present)
   - or PATH / `-PdfToPpm`

Core **edit** of DOCX/XLSX does **not** need this pipeline (use python-docx/openpyxl in a dedicated venv).  
This pipeline is only for **visual page preview**.

## Usage

```powershell
cd E:\Projects\Current\OpenCodePlugins\scripts\office

powershell -NoProfile -ExecutionPolicy Bypass -File .\render-docx.ps1 `
  -InputDocx "D:\path\to\file.docx" `
  -Page 1 `
  -OutputDir "$env:USERPROFILE\Desktop\docx-preview" `
  -Dpi 144
```

Optional:

```powershell
# Keep intermediate PDF
-KeepPdf

# Custom poppler
-PdfToPpm "C:\tools\poppler\Library\bin\pdftoppm.exe"

# Longer Word timeout (default 120s)
-TimeoutSec 180
```

## Direct VBS only (PDF)

```powershell
cscript //nologo .\export-docx-pdf.vbs "C:\work\input.docx" "C:\work\out.pdf"
```

## Stability notes

| Do | Don't |
|----|--------|
| Prefer `cscript` + VBS for Word export | Rely on PowerShell `SaveAs`/`ExportAsFixedFormat` (hang-prone) |
| Always stop leftover WINWORD after run | Leave Word open in background |
| Work on a copied file under `%TEMP%` | Feed long/Unicode paths straight into COM when avoidable |
| Use read-only open for preview | Edit the source during export |

## Exit codes

- `render-docx.ps1` throws on failure (non-zero).
- VBS exits `0` on success, `1` on error; prints `OK ...` / `ERR ...` lines.

## Future OpenCode plugin

A thin plugin can wrap:

```text
office_render(docx_path, page=1, dpi=144, output_dir=?)
  -> spawn render-docx.ps1
  -> return PNG path
```

Configure `pdftoppm` path in `~/.config/opencode/office.json` if needed.  
Editing Word/Excel content remains a separate dedicated Python venv (not this script).
