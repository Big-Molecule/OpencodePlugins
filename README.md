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

### office-docs (Codex-style)

**Golden path:** edit → `office_render` `all_pages=true` → inspect PNGs → fix → deliver DOCX.

| Tool | Purpose |
|------|---------|
| `office_status` | Readiness |
| `office_setup` | System Python → dedicated venv; probe Word; sync scripts |
| `office_verify` | Re-check imports + Word COM |
| `office_docx_info` | Paragraph/table summary |
| `office_docx_create` | Create simple DOCX |
| `office_docx_edit` | set/add paragraphs |
| `office_render` | DOCX → page PNGs via Word COM + pdftoppm |

**Paths**

| What | Where |
|------|--------|
| Config | `~\.config\opencode\office-docs.json` |
| Venv | `%LOCALAPPDATA%\opencode-office\venv` |
| Scripts | `%LOCALAPPDATA%\opencode-office\scripts` |
| Job temp | `<workdir>/.opencode-office/cache/<jobId>/` |

**Requires:** Python ≥ 3.10 on machine, Microsoft Word, pdftoppm (poppler; auto-detects Codex cache if present).

Does **not** pollute project venv. No Google Drive / marketplace.

### image-gen

See prior docs in conversation / `image_status` tool. Config: `~\.config\opencode\image-gen.json`.

### everything-search

Global filename search via Everything / `es.exe`.

## Notes

- Restart OpenCode after install.
- Do not commit secrets.
- Local plugins do not need `plugin: [...]` in opencode.json.
