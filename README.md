# OpenCodePlugins

Personal OpenCode plugins, managed with Git for backup and machine sync.

**Dev and live are separated:** edit in this repo; only **copy** finished plugins into OpenCode's config when you want them loaded.

## Layout

```text
OpenCodePlugins/
├── plugins/                 # development source (git)
│   ├── everything-search.ts
│   ├── niu-image-gen.ts
│   └── niu-image-gen.NOTICE.md
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
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install.ps1 -Plugin niu-image-gen.ts
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
| `niu-image-gen.ts` | `niu_image_*` | OpenAI-compatible image generate/edit (from AiMaMi / Codex niu-image-gen). |

### everything-search

1. Prefer Everything + `es.exe` for whole-machine / cross-drive filename lookup.
2. If Everything is missing → explain and fall back to slow OS search.
3. If Everything exists but `es.exe` is missing → explain why ES is needed; only install when the user agrees (`install_es=true`).
4. Optional env: `EVERYTHING_ES_PATH` = full path to `es.exe`.

### niu-image-gen

Port of the Codex `niu-image-gen` plugin (Apache-2.0 / AiMaMi). OpenCode tools replace the skill + CLI script flow. Output is plain text (no emoji-heavy UI).

| Tool | Purpose |
|------|---------|
| `niu_image_status` | Show config / key presence / defaults |
| `niu_image_configure` | `set_key` / `set_api` / `set_model` / `set_quick_mode` / `set_batch_mode` |
| `niu_image_list_models` | Query configured `/v1/models` |
| `niu_image_generate` | Text (single or batch) |
| `niu_image_edit` | Edit local image via data URL + prompt |

**Standard flow**

1. `niu_image_status` — if no key, configure first.
2. Optional: `niu_image_list_models` → `niu_image_configure` `set_model`.
3. Optional: `set_quick_mode` (quality / ratio / count).
4. `niu_image_generate` with a prompt (uses quick defaults when flags omitted).
5. Edit: `niu_image_edit` with `image_path` + prompt.

**Config**

- File: `~/.config/opencode/niu-image-gen.json`
- Also reads legacy Codex path: `~/.codex/niu-image-gen-config.json`
- Env overrides: `NIU_IMAGE_GEN_API_PROTOCOL|HOST|PORT|PATH|MODELS_PATH|KEY|MODEL`
- Default output dir: `~/Pictures/niu-image-gen/`
- API must accept JSON `{ model, prompt, n, size }` and return `data[].b64_json`; edit adds `image` data URL.

Attribution: `plugins/niu-image-gen.NOTICE.md`.

## Notes

- Do **not** junction the live plugins folder to this repo if you want a safe dev buffer.
- Do not commit secrets or machine-specific absolute paths.
- Local plugins do not need `plugin: [...]` in `opencode.json` (that is for npm packages).
- `install.ps1` only copies `.ts` / `.js` / `.mjs` / `.cjs` (not NOTICE/docs).
