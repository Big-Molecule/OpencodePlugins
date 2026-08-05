---
name: office-docs
description: Create, edit, merge, and visually verify Word/Excel/PDF in OpenCode using a Codex-style golden path (python-docx/openpyxl edit → Word COM page PNGs → inspect → iterate). Use for DOCX/XLSX/PDF document work. Not for arbitrary app code.
---

# Office Docs (OpenCode) — Codex-style

Full local document stack without Google Drive / OpenAI marketplace coupling.

## Golden path (non-negotiable for DOCX delivery)

1. `office_status` / `office_setup` if needed (user may cancel setup).
2. **Edit** with `office_docx_*` / `office_xlsx` (dedicated venv only).
3. **`office_render` `all_pages=true`** after every meaningful DOCX edit batch.
4. **Inspect every `page-*.png`** (clipping, overlap, tables, headers/footers).
5. Fix → re-render until clean.
6. Deliver **DOCX/XLSX** only unless the user asked for images.

If render fails: you may still edit files, but **must state visual QA was not completed**.

Do not claim layout is correct from XML/text alone.

## Setup

- `office_setup` → system Python ≥3.10 → `%LOCALAPPDATA%\opencode-office\venv`
- Packages: python-docx, openpyxl, lxml, pypdf
- Probes Microsoft Word COM for render
- Does **not** touch project venv

## Tools map

| Area | Tools |
|------|--------|
| Setup | `office_status`, `office_setup`, `office_verify` |
| DOCX read | `office_docx_info`, `office_docx_comments`, `office_docx_meta` |
| DOCX write | `office_docx_create`, `office_docx_edit` (set/add/replace), `office_docx_table`, `office_docx_format`, `office_docx_merge` |
| XLSX | `office_xlsx` (info/read/write_cell/create) |
| PDF | `office_pdf_text` |
| Visual QA | `office_render` (Word COM → PNG) |

## Paths

| What | Where |
|------|--------|
| Config | `~/.config/opencode/office-docs.json` |
| Venv/scripts | `%LOCALAPPDATA%\opencode-office\` |
| Job cache | `<workdir>/.opencode-office/cache/<jobId>/` |

## Task routing (like Codex tasks/)

| User intent | Do |
|-------------|-----|
| Create/edit DOCX | create/edit tools → render all pages → inspect |
| Review layout | `office_render` all_pages → inspect PNGs; use info for structure |
| Tables | `office_docx_table` then re-render |
| Headers/margins | `office_docx_format` then re-render |
| Merge files | `office_docx_merge` then re-render |
| Excel data | `office_xlsx` (no Word render) |
| PDF text | `office_pdf_text` |
| Privacy | `office_docx_meta` scrub |

## Notes

- Comments often **do not** show in page PNGs — use `office_docx_comments` for structural list.
- Excel formula **results** may need Excel to recalculate; openpyxl writes values/formulas only.
- Chapter→page fuzzy search is **not** required for golden path (full render + inspect).
