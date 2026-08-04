# OpenCodePlugins

Git-managed personal plugins for [OpenCode](https://opencode.ai).

## Structure

- Put plugin source files in `plugins/*.ts` (or `plugins/*.js`).
- OpenCode auto-loads files from `~/.config/opencode/plugins/` after install/link.
- Prefer one plugin per file unless a group of tools clearly belongs together.

## Workflow

1. Edit plugins under `plugins/`.
2. Commit changes in this repository.
3. On a new machine: `git clone` then run `scripts/install.ps1` (or copy files).
4. Restart OpenCode.

## Conventions

- Export a `Plugin` function (`export const X: Plugin` or `export default`).
- Use `@opencode-ai/plugin` (`tool`, `Plugin` types).
- No secrets in the repo.
- Tool descriptions should tell the model when **not** to use the tool (e.g. prefer built-in project search).
