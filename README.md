# OpenCodePlugins

Personal OpenCode plugins, managed with Git for backup and machine sync.

**Dev and live are separated:** edit in this repo; only **copy** finished plugins into OpenCode's config when you want them loaded.

## Layout

```text
OpenCodePlugins/
├── plugins/
│   ├── everything-search.ts
│   ├── image-gen.ts
│   └── office-docs.ts
├── skills/
│   └── office-docs/SKILL.md
└── scripts/
    ├── install.ps1
    └── office/                 # DOCX edit helpers + Word COM render
        ├── setup-venv.ps1
        ├── render-docx.ps1
        ├── export-docx-pdf.vbs
        └── py/
```

## Install

```powershell
cd E:\Projects\Current\OpenCodePlugins
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install.ps1
```

Then **restart OpenCode**.

`install.ps1` also syncs:

- office scripts → `%LOCALAPPDATA%\opencode-office\scripts`
- skill → `~\.config\opencode\skills\office-docs`

## Plugins

| File | Tools | Description |
|------|-------|-------------|
| `everything-search.ts` | `everything_search` | Windows global filename search via Everything |
| `image-gen.ts` | `image_*` | OpenAI-compatible image generate/edit |
| `office-docs.ts` | `office_*` | DOCX edit (venv python-docx) + Word COM page render (Codex-style) |

### office-docs (Codex-style local suite)

**Golden path:** edit → `office_render` `all_pages=true` → inspect PNGs → fix → deliver file.

| Tool | Purpose |
|------|---------|
| `office_status` / `office_setup` / `office_verify` | Dedicated venv + Word probe |
| `office_docx_info` / `comments` / `meta` | Inspect structure, comments, properties |
| `office_docx_create` / `edit` / `table` / `format` / `merge` | Create & edit DOCX |
| `office_xlsx` | Excel info/read/write/create |
| `office_pdf_text` | PDF text extract |
| `office_render` | DOCX → page PNGs (Word COM + pdftoppm) |

**Paths:** config `~\.config\opencode\office-docs.json`; venv/scripts `%LOCALAPPDATA%\opencode-office\`; job temp `<workdir>/.opencode-office/cache/<jobId>/`.

**Requires:** Python ≥ 3.10, Microsoft Word, pdftoppm. No project-venv pollution. No Google Drive.

### image-gen

See prior docs in conversation / `image_status` tool. Config: `~\.config\opencode\image-gen.json`.

### everything-search

Global filename search via Everything / `es.exe`.

## Notes

- Restart OpenCode after install.
- Do not commit secrets.
- Local plugins do not need `plugin: [...]` in opencode.json.
