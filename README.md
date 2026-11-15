# OpenCodePlugins

Personal OpenCode plugins, managed with Git for backup and machine sync.

**Dev and live are separated:** edit in this repo; only **copy** finished plugins into OpenCode's config when you want them loaded.

## Layout

```text
OpenCodePlugins/
├── docs/
│   └── campus-install.md        # 在校园网内电脑上安装并验证的步骤
├── plugins/
│   ├── everything-search.ts
│   ├── image-gen.ts
│   ├── local-markdown-images.ts
│   ├── office-docs.ts
│   └── sciencedirect.ts
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

The default install targets **OpenCode V2 (2.0.15+)** and copies these six migrated plugins:
`bandizip`, `everything-search`, `image-gen`, `lolia-frp`, `office-docs`, and `sciencedirect`.
It installs the pinned `@opencode/plugin` and Zod dependencies under the OpenCode config directory,
and copies `plugins/lib/` alongside the entrypoints. Node.js/npm must be available.

The migrated plugin tools are registered as ordinary model tools rather than Code Mode-only tools.
This keeps them visible to OpenChamber and to models that do not expose the Code Mode catalog.

`aijavis-sse-filter`, `latex-normalize`, and `local-markdown-images` are excluded from the default
install; their existing files are left alone. Their V1 implementations are not V2-compatible.

Then **restart OpenCode**, or reload the project's configuration through V2.

Development checks: `npm ci`, `npm run typecheck`, and `npm test`.

`install.ps1` also syncs:

- office scripts → `%LOCALAPPDATA%\opencode-office\scripts`
- skill → `~\.config\opencode\skills\office-docs`

## Plugins

| File | Tools | Description |
|------|-------|-------------|
| `everything-search.ts` | `everything_search` | Windows global filename search via Everything |
| `image-gen.ts` | `image_*` | OpenAI-compatible image generate/edit |
| `lolia-frp.ts` | `lolia_*` | Lolia FRP (lolia.link) tunnel management: list/create/delete tunnels, detached frpc process control, traffic, nodes |
| `latex-normalize.ts` | Hooks only | Normalizes assistant LaTeX for Desktop KaTeX |
| `local-markdown-images.ts` | Hooks only | Inlines workspace-local Markdown images for Desktop rendering |
| `office-docs.ts` | `office_*` | DOCX edit (venv python-docx) + Word COM page render (Codex-style) |
| `sciencedirect.ts` | `sciencedirect_*` | Official Elsevier ScienceDirect search, institutional IP auth, metadata/abstracts, and full-text retrieval |

### lolia-frp

Operates Lolia FRP (lolia.link) tunnels through the same OAuth API the desktop client uses.

| Tool | Purpose |
|------|---------|
| `lolia_setup` | Import/verify/clear credentials (imports refresh_token from the Lolia desktop client) |
| `lolia_status` | Account info, traffic quota, frpc binary + running frpc processes |
| `lolia_tunnels` | List all tunnels merged with local running processes |
| `lolia_tunnel` | Full tunnel detail (token masked unless `reveal_token=true`) |
| `lolia_tunnel_start` | Launch frpc as a DETACHED process (WMI, outside OpenCode's process tree) |
| `lolia_tunnel_stop` | Kill the frpc process of one tunnel (or all with `all=true`) |
| `lolia_tunnel_create` | Create a tunnel server-side (does not start it) |
| `lolia_tunnel_delete` | Delete a tunnel (destructive, requires `confirm=true`) |
| `lolia_tunnel_token_reset` | Show/reset the account tunnel token (reset is destructive) |
| `lolia_nodes` | Node list: protocols, bandwidth, load, available ports |
| `lolia_traffic` | Traffic stats / daily history / per-tunnel usage |
| `lolia_config` | Fetch + decode the generated frpc TOML config |
| `lolia_checkin` | Daily check-in (bonus traffic) |

**Design notes:**

- frpc processes are started detached via WMI (`Win32_Process.Create`), so they survive OpenCode
  exits and are equally manageable by the Lolia desktop client (and vice versa: the plugin can
  stop processes the client started, matched by the `-t <tunnel_id>:<token>` command line).
- Credentials live in `~\.config\opencode\lolia-frp.json` (refresh_token only; access tokens are
  held in memory and auto-refreshed). Never commit or echo them. The first-time `lolia_setup`
  imports the refresh token from the Lolia desktop client's `settings.json`.
- Deleting tunnels, resetting the account token, and stopping ALL processes require explicit
  user confirmation before `confirm=true` / `all=true` is passed.


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

OpenAI-compatible image generation and editing. Config: `~\.config\opencode\image-gen.json`.

| Tool | Purpose |
|------|---------|
| `image_status` | Show connection, model, generation URL and resolved edits URL |
| `image_configure` | Save connection/model/defaults or verify connection |
| `image_list_models` | Discover models before selecting one |
| `image_generate` | Text-to-image, variants, or a batch of prompts |
| `image_edit` | Edit a local PNG/JPEG/WebP; optionally upload a PNG mask |

**Setup:** `image_status` → `image_configure action=set_api host=... key=...` →
`image_list_models` → `image_configure action=set_model model=...`. Setup can be cancelled at any time.

**Endpoints and transport:**

- Generation sends JSON to `path` (default `/v1/images/generations`).
- Editing sends `multipart/form-data` with `model`, `prompt`, `size`, `n`, and an actual
  `image` file to `/v1/images/edits`. A supplied mask is uploaded as the `mask` file.
- The edit path is derived automatically, preserving prefixes: `/proxy/v1/images/generations`
  → `/proxy/v1/images/edits`. For an unrecognized generation path it defaults to `/v1/images/edits`.
  Override with `image_configure action=set_api edits_path=/custom/images/edits`; use
  `edits_path=auto` to reset. Old configurations need no migration.
- The stored override is `api.editsPath`; environment variable `IMAGE_GEN_API_EDITS_PATH`
  takes precedence (also accepts `auto`). Generation still uses `api.path` / `IMAGE_GEN_API_PATH`.
- Compatibility errors (HTTP 400/404/405/415/422/501), or a JSON response with no image,
  can fall back to the existing Responses compatibility route. Edits carry the original image
  as `input_image`; generation sends a text input. This requires provider/model support for
  that Responses request shape. Authentication, rate-limit, other server, network and timeout
  failures do not trigger fallback. Session cancellation aborts the active requests.
- Responses fallback is disabled when a mask is supplied so the masked region is never silently lost.
- Both base64 image results and `data[].url` results are supported. URL downloads do not receive
  the API authorization header; download failures do not trigger a second generation.

**Editing examples** (tool arguments):

```text
image_edit image_path="C:\Pictures\source.png" prompt="Replace the background with a beach" quality=1K
image_edit image_path="source.png" mask_path="mask.png" prompt="Add flowers in the transparent region" output_dir="edited"
```

Source images must be under 50 MB; masks must be PNG, under 4 MB, with the same dimensions
as the source. Fully transparent mask regions indicate where to edit. Input formats are
detected from file bytes. Relative paths use the current session directory. Results default
to `~/Pictures/image-gen` and are saved with the detected PNG/JPEG/WebP/GIF extension.
`count` selects 1–4 edit variants. `quality=1K|2K|4K` is a resolution preset, not the provider's
`quality` enum; the chosen model must support the requested dimensions (use `1K` for standard sizes).

### everything-search

Global filename search via Everything / `es.exe`.

### sciencedirect

Official Elsevier ScienceDirect API integration (`https://api.elsevier.com`). Config: `~\.config\opencode\sciencedirect.json`.

| Tool | Purpose |
|------|---------|
| `sciencedirect_status` | Check credential and in-memory IP authentication state |
| `sciencedirect_configure` | Save, verify, or clear `api_key` and optional `inst_token` (supports `api_key_file` / `inst_token_file` from `openchamber_secret`) |
| `sciencedirect_authenticate` | Exchange a recognized campus/institutional IP for a two-hour in-memory `authtoken` |
| `sciencedirect_search` | Search via ScienceDirect Search API v2 (`PUT /content/search/sciencedirect`) with automatic fallback to Article Metadata API (`GET /content/metadata/article`) |
| `sciencedirect_article` | Retrieve metadata, abstract, or full text by DOI/PII/EID/URL; paginate with `offset` or save the complete text using `output_path` |

**Setup:**

1. Create an API key at <https://dev.elsevier.com/apikey/manage>.
2. Configure via `sciencedirect_configure action=set_key api_key=...` (or via `openchamber_secret` + `api_key_file=...`). Valid keys are saved even if the current IP is off-campus so `sciencedirect_authenticate` or `inst_token` can be used afterward.
3. On campus network/VPN: call `sciencedirect_search` directly (or `sciencedirect_authenticate` if multiple accounts share the campus IP). Ensure `api.elsevier.com` connects directly rather than through a non-campus proxy/TUN.
4. Off-campus: pass `inst_token=...` to `sciencedirect_configure action=set_key` (or set `ELSEVIER_INST_TOKEN`).

Non-empty environment overrides (`ELSEVIER_API_KEY`, `ELSEVIER_INST_TOKEN`, `ELSEVIER_AUTHTOKEN`, `ELSEVIER_OAUTH_TOKEN`) take precedence over local config. `SCIENCEDIRECT_API_KEY` is also accepted as an API key alias; `ELSEVIER_API_KEY` wins when both are set. Blank variables do not hide a saved key. Existing `api_key` / `inst_token` config fields and UTF-8 BOM files are supported.

There is no plugin-imposed per-session article quota, confirmation gate, or global setup-prompt injection. The official API's quota and errors are reported as returned by Elsevier.

To download the entire article text while keeping the model preview short:

```text
sciencedirect_article identifier="10.1016/j.example.2026.01.001" mode=full_text output_path="papers/article.txt" max_chars=30000
```

`output_path` saves the complete UTF-8 **text**, not a PDF, independently of `max_chars` and `offset`. Relative paths resolve from the current session directory. Existing files are preserved unless `overwrite=true`. If Elsevier only returns metadata or an abstract, the plugin labels it accordingly and does not save it as a full-text file. Network failures and entitlement errors during setup do not discard a supplied key; explicit `APIKEY_INVALID` does not replace an existing saved key.

### latex-normalize

Post-processes assistant math for Desktop KaTeX without model rules. It normalizes `$`, `$$`, `\[...\]`, `\(...\)`, and common math environments while preserving code, currency, and escaped dollars.

Config: `~\.config\opencode\latex-normalize.json`.

```json
{
  "enabled": true,
  "mode": "safe",
  "layout": "block",
  "displaystyle": true,
  "transformHistory": true
}
```

`layout` defaults to `"inline"`, which converts every recognized formula to frontend-safe single-line `\(...\)`. `"block"` emits strict centered `$$` blocks for structurally isolated display formulas; `$...$` and formulas inside prose, lists, or quotes remain inline.

## Notes

- Restart OpenCode after install.
- Do not commit secrets.
- Local plugins do not need `plugin: [...]` in opencode.json.
