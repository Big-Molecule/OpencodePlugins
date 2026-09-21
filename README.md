# OpenCodePlugins

Personal OpenCode plugins, managed with Git for backup and machine sync.

**Dev and live are separated:** edit in this repo; only **copy** finished plugins into OpenCode's config when you want them loaded.

## Layout

```text
OpenCodePlugins/
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

Then **restart OpenCode**.

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
| `sciencedirect.ts` | `sciencedirect_*` | Official Elsevier search, institutional IP auth, abstracts, and bounded entitled excerpts |

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

See prior docs in conversation / `image_status` tool. Config: `~\.config\opencode\image-gen.json`.

### everything-search

Global filename search via Everything / `es.exe`.

### sciencedirect

Uses the official Elsevier APIs. It does not scrape ScienceDirect pages, read browser cookies, or handle university passwords.
ScienceDirect is one literature-search channel, not an exhaustive or exclusive source. Use other appropriate scholarly databases and web search tools alongside it whenever the task needs broader coverage.

Tools:

| Tool | Purpose |
|------|---------|
| `sciencedirect_status` | Check credential and in-memory authentication state |
| `sciencedirect_configure` | Validate, save, verify, or clear a personal API key from the conversation |
| `sciencedirect_authenticate` | Exchange a currently recognized institutional IP entitlement for a short-lived in-memory authtoken |
| `sciencedirect_search` | Search with the native ScienceDirect Search API v2 PUT interface |
| `sciencedirect_article` | Retrieve metadata, abstract, or one bounded entitled excerpt by DOI/PII/other supported ID |

For first-time setup, call `sciencedirect_status`. The tool guides the assistant to:

1. Let the user register a personal key at <https://dev.elsevier.com/apikey/manage>.
2. Have the user review Elsevier's current [API Service Agreement](https://dev.elsevier.com/api_service_agreement.html) and their institution license.
3. After the user supplies the personal key and explicitly confirms compliance, call `sciencedirect_configure action=set_key` with `ai_use_confirmed=true`.
4. Validate the key against `api.elsevier.com`, save it to `~\.config\opencode\sciencedirect.json`, and use it immediately without another restart.

A key supplied in chat is visible to the current OpenCode session/model. The plugin never echoes it in tool output, asks for an explicit OpenCode permission before sending/saving it, and writes the local file with restrictive POSIX permissions. The file is plaintext, and Windows ultimately relies on the user-profile ACL. Users who do not want a key in session history can keep using environment variables instead; an explicitly set environment value overrides the local file for rotation or revocation:

```powershell
$env:ELSEVIER_API_KEY = "your-personal-api-key"
$env:ELSEVIER_AI_USE_CONFIRMED = "1"
opencode
```

Never set `ai_use_confirmed=true` on the user's behalf. The agreement currently requires, among other conditions, a closed enterprise-grade AI environment, no external model training, and no third-party access or substantial retention/reproduction.

Optional credentials are `ELSEVIER_INST_TOKEN`, `ELSEVIER_AUTHTOKEN`, and `ELSEVIER_OAUTH_TOKEN`. An authtoken normally expires after two hours. Keep these higher-privilege/short-lived credentials out of this repository, the local ScienceDirect config, and chat history.

An institution token is issued case by case to customers or approved partners and represents the institution's full account entitlement. Elsevier requires it to remain server-side in a password-protected environment. For this local plugin, use a process-scoped environment variable only on a protected machine and only if Elsevier/the library approves the integration; do not persist it with `setx` or put it in an OpenCode config file.

For Nanjing University of Information Science and Technology access:

1. For campus access, connect from an Elsevier-recognized campus IP, then call `sciencedirect_status` and `sciencedirect_authenticate`.
2. For off-campus API access, ask Elsevier Research Product API Support and the university library whether they will issue an institution token for this use case.
3. With `ELSEVIER_INST_TOKEN` configured, skip `sciencedirect_authenticate` and call `sciencedirect_search` directly.
4. Search metadata first, retrieve abstracts only for plausible candidates, and request a bounded excerpt only when necessary.
5. CARSI authorizes the interactive website, not the API. Open the returned ScienceDirect URL in the CARSI-authenticated browser when needed.

A pop-up login is appropriate only if Elsevier provisions an OAuth client, redirect URI, and documented authorization/token endpoints for this application. The plugin must not derive API credentials by intercepting CARSI cookies or ScienceDirect page responses.

Elsevier and university usage limits still apply. Do not use the plugin for continuous, systematic, concentrated, or bulk downloads.

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
