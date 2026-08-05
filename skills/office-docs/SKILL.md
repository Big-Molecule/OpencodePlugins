---
name: office-docs
description: Create, edit, and visually verify Word (.docx) documents in OpenCode using a Codex-style golden path (python-docx edit → Word COM render → inspect page PNGs). Use when the user asks to write/edit/review DOCX or document layout. Not for arbitrary code editing.
---

# Office Docs (OpenCode)

Codex-style document workflow for OpenCode. **No Google Drive / marketplace.**

## Non-negotiable golden path

You do **not** know a DOCX is visually OK until you render and inspect page PNGs.

After every meaningful edit batch:

1. Edit with `office_docx_*` tools (dedicated venv python-docx).
2. `office_render` with `all_pages=true`.
3. Open/inspect each `page-*.png` (clipping, overlap, tables, headers).
4. Fix → re-render until clean.
5. Deliver **DOCX only** unless the user asked for images.

If render fails (no Word / no pdftoppm): you may still edit DOCX, but **must say visual QA was not completed**.

## Setup

1. `office_status`
2. If not ready and user agrees: `office_setup` (creates `%LOCALAPPDATA%\opencode-office\venv`, does **not** touch project venv).
3. User may **cancel setup** anytime.

Checks: system Python ≥ 3.10, Microsoft Word COM, venv packages.

## Tools

| Tool | Role |
|------|------|
| `office_status` | Config / readiness |
| `office_setup` | Create venv + sync scripts |
| `office_verify` | Re-check imports + Word |
| `office_docx_info` | Structure / paragraph indices |
| `office_docx_create` | New simple DOCX |
| `office_docx_edit` | set/add paragraphs |
| `office_render` | DOCX → page PNGs (Word COM) |

## Paths

- Config: `~/.config/opencode/office-docs.json`
- Venv/scripts: `%LOCALAPPDATA%\opencode-office\`
- Job cache: `<workdir>/.opencode-office/cache/<jobId>/` (never under plugin dir)

## Do / Don't

- DO use paragraph indices from `office_docx_info` when editing.
- DO re-render after layout-sensitive changes.
- DON'T claim layout is fine from XML/text alone.
- DON'T pip-install office deps into the project venv.
- DON'T put temp renders in the plugin install directory.
