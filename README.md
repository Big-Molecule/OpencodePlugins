# OpenCodePlugins

Personal OpenCode plugins, managed with Git for easy backup and machine sync.

## Layout

```text
OpenCodePlugins/
└── plugins/
    └── everything-search.ts
```

OpenCode auto-loads `*.ts` / `*.js` from:

- Global: `~/.config/opencode/plugins/`
- Project: `.opencode/plugins/`

## Install on a new machine

```powershell
git clone <your-repo-url> E:\Projects\Current\OpenCodePlugins
```

Then either **copy** or **link** plugins into OpenCode's config directory.

### Option A — copy (simple)

```powershell
$src = "E:\Projects\Current\OpenCodePlugins\plugins"
$dst = "$env:USERPROFILE\.config\opencode\plugins"
New-Item -ItemType Directory -Path $dst -Force | Out-Null
Copy-Item "$src\*" $dst -Force
```

Restart OpenCode after copying.

### Option B — junction (keeps config in sync with this repo)

```powershell
$src = "E:\Projects\Current\OpenCodePlugins\plugins"
$dst = "$env:USERPROFILE\.config\opencode\plugins"
New-Item -ItemType Directory -Path "$env:USERPROFILE\.config\opencode" -Force | Out-Null
if (Test-Path $dst) { Remove-Item $dst -Recurse -Force }
cmd /c mklink /J "$dst" "$src"
```

Restart OpenCode. Edits in the repo are used immediately on next start.

Or run:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install.ps1
```

## Plugins

| File | Tool | Description |
|------|------|-------------|
| `everything-search.ts` | `everything_search` | Windows global filename search via Everything / `es.exe`. Project-local search should still use OpenCode built-ins. |

### everything-search behavior

1. Prefer Everything + `es.exe` for whole-machine / cross-drive filename lookup.
2. If Everything is missing → explain and fall back to slow OS search.
3. If Everything exists but `es.exe` is missing → explain why ES is needed; only install when the user agrees (`install_es=true`).
4. Optional env: `EVERYTHING_ES_PATH` = full path to `es.exe`.

## Notes

- OpenCode does not hot-reload plugins; restart after changes.
- Do not commit secrets or machine-specific absolute paths.
- Local plugins do not need an entry in `opencode.json` (`plugin: [...]` is for npm packages).
