# Niu Image Gen (OpenCode) — Attribution

This plugin is derived from the `niu-image-gen` plugin in:

- Project: `borawong/AiMaMi`
- Source: https://github.com/borawong/AiMaMi
- Imported commit: `297c7af56f10fb371b77bc9b6b65aa320afcbe7e`
- Original copyright: Copyright 2025-2026 borawong
- License: Apache License 2.0

Codex marketplace port and API configurability: Big-Molecule / CodexPlugins.

## OpenCode adaptation

- Replaced Codex skill + CLI script flow with OpenCode `Plugin` tools.
- Config path: `~/.config/opencode/niu-image-gen.json` (still reads legacy `~/.codex/niu-image-gen-config.json` if present).
- Plain-text tool results (no emoji-heavy CLI output).
- Same OpenAI-compatible image API contract: `model`, `prompt`, `n`, `size`, optional `image` data URL; response `data[].b64_json`.

Full Apache-2.0 text: see upstream `LICENSE` in CodexPlugins `plugins/niu-image-gen/LICENSE` or https://www.apache.org/licenses/LICENSE-2.0
