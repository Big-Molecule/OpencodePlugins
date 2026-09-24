# OpenCodePlugins

Git-managed personal plugins for [OpenCode](https://opencode.ai).

## Structure

- Develop under `plugins/*.ts` (or `*.js`).
- Live OpenCode plugins live in `~/.config/opencode/plugins/` as **copies**.
- Use `scripts/install.ps1` to copy finished plugins; do not auto-link the repo into OpenCode.

## Workflow

1. Edit plugins under `plugins/` in this repository.
2. Commit when the change is ready to keep.
3. Run `scripts/install.ps1` only when you want OpenCode to load the current files.
4. Restart OpenCode after install.
5. On a new machine: `git clone` then `scripts/install.ps1`.

## Conventions

- Migrated plugins default-export an OpenCode V2 definition with a stable `id` and `setup`.
- Use `@opencode/plugin`; shared schema/registration helpers live in `plugins/lib/tools.ts`.
- `aijavis-sse-filter`, `latex-normalize`, and `local-markdown-images` remain legacy and are excluded from default installation.
- No secrets in the repo.
- Tool descriptions should tell the model when **not** to use the tool (e.g. prefer built-in project search).
- Keep unfinished plugins in the repo only until they are ready to install.
