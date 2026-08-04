# OpenCodePlugins

Personal OpenCode plugins, managed with Git for backup and machine sync.

**Dev and live are separated:** edit in this repo; only **copy** finished plugins into OpenCode's config when you want them loaded.

## Layout

```text
OpenCodePlugins/
├── plugins/                 # development source (git)
│   ├── everything-search.ts
│   └── image-gen.ts
└── scripts/
    └── install.ps1          # copy *.ts/*.js -> ~/.config/opencode/plugins
```

OpenCode auto-loads `*.ts` / `*.js` from:

- Global: `~/.config/opencode/plugins/`
- Project: `.opencode/plugins/`

## Workflow

1. Develop under `plugins/` in this repository.
2. When a plugin is ready, install (copy) it:

```powershell
cd E:\Projects\Current\OpenCodePlugins
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install.ps1
```

Install one file only:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install.ps1 -Plugin image-gen.ts
```

3. Restart OpenCode (plugins are not hot-reloaded).

Incomplete work stays in the repo and is **not** used until you run `install.ps1` again.

## New machine

```powershell
git clone <your-repo-url> E:\Projects\Current\OpenCodePlugins
cd E:\Projects\Current\OpenCodePlugins
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install.ps1
```

Then restart OpenCode.

## Plugins

| File | Tools | Description |
|------|-------|-------------|
| `everything-search.ts` | `everything_search` | Windows global filename search via Everything / `es.exe`. |
| `image-gen.ts` | `image_*` | OpenAI-compatible image generate/edit. |

### everything-search

1. Prefer Everything + `es.exe` for whole-machine / cross-drive filename lookup.
2. If Everything is missing → explain and fall back to slow OS search.
3. If Everything exists but `es.exe` is missing → explain why ES is needed; only install when the user agrees (`install_es=true`).
4. Optional env: `EVERYTHING_ES_PATH` = full path to `es.exe`.

### image-gen

| Tool | Purpose |
|------|---------|
| `image_status` | Show config / key presence / defaults |
| `image_configure` | `set_key` / `set_api` / `set_model` / `set_quick_mode` / `set_batch_mode` |
| `image_list_models` | Query configured `/v1/models` |
| `image_generate` | Generate (single or batch) |
| `image_edit` | Edit local image via data URL + prompt |

**Standard flow** (do not ask the user to invent a model id)

1. `image_status`
2. If incomplete: collect **API key + host only** → `image_configure` `set_api` (**omit model**)
3. `image_list_models` → show numbered list (prefer `[image?]`) → user picks
4. `image_configure` `set_model` with the chosen id
5. Optional: `set_quick_mode` → `image_generate` / `image_edit`

**Config (OpenCode only)**

- File: `~/.config/opencode/image-gen.json` only — does **not** read Codex `~/.codex/*`.
- If the file is missing or key is unset, tools return a setup guide via `image_status` / generate/edit/list.
- Env overrides: `IMAGE_GEN_API_PROTOCOL|HOST|PORT|PATH|MODELS_PATH|KEY|MODEL`
- Default output dir: `~/Pictures/image-gen/`
- API must accept JSON `{ model, prompt, n, size }` and return `data[].b64_json`; edit adds `image` data URL.

## Notes

- Do **not** junction the live plugins folder to this repo if you want a safe dev buffer.
- Do not commit secrets or machine-specific absolute paths.
- Local plugins do not need `plugin: [...]` in `opencode.json` (that is for npm packages).
- `install.ps1` only copies `.ts` / `.js` / `.mjs` / `.cjs`.
